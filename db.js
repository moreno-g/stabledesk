// SQLite persistence for the historical indexer (zero-dependency: node:sqlite).

import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIZE_BRACKETS } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (vol) return join(vol, 'arc.db');
  return join(__dirname, 'arc.db');
}

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
console.log(`[db] ${dbPath}`);
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS buckets (
    minute INTEGER NOT NULL,          -- unix seconds floored to the minute
    token  TEXT    NOT NULL,          -- USDC | EURC | USYC
    volume REAL    NOT NULL DEFAULT 0,
    cnt    INTEGER NOT NULL DEFAULT 0,
    mint   REAL    NOT NULL DEFAULT 0,
    burn   REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, token)
  );
  CREATE INDEX IF NOT EXISTS idx_buckets_minute ON buckets(minute);

  CREATE TABLE IF NOT EXISTS addr_stats (
    address    TEXT    PRIMARY KEY,
    transfers  INTEGER NOT NULL DEFAULT 0,
    volume     REAL    NOT NULL DEFAULT 0,
    last_block INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_addr_vol ON addr_stats(volume DESC);
  CREATE INDEX IF NOT EXISTS idx_addr_block ON addr_stats(last_block);

  CREATE TABLE IF NOT EXISTS recent (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    block  INTEGER, ts INTEGER, token TEXT, frm TEXT, too TEXT, amount REAL
  );
  CREATE INDEX IF NOT EXISTS idx_recent_amount ON recent(amount DESC);

  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY, label TEXT, tier TEXT NOT NULL DEFAULT 'free',
    created INTEGER, requests INTEGER NOT NULL DEFAULT 0, last_used INTEGER
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, address TEXT, token TEXT,
    min_amount REAL NOT NULL DEFAULT 0, webhook TEXT, created INTEGER,
    last_fired INTEGER NOT NULL DEFAULT 0, fires INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL,
    amount REAL NOT NULL,               -- exact USDC amount expected, e.g. 29.417231 (uniquified)
    status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired
    created INTEGER NOT NULL, paid_at INTEGER, tx_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_amount ON orders(amount) WHERE status = 'pending';
`);

// Migrations: "real" (noise-filtered) volume columns — safe on existing DBs.
for (const col of ['rvolume REAL NOT NULL DEFAULT 0', 'rcnt INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE buckets ADD COLUMN ${col}`); } catch { /* already present */ }
}
// Migration: Pro-tier expiry, so a lapsed subscription reverts to free automatically.
try { db.exec('ALTER TABLE api_keys ADD COLUMN expires_at INTEGER'); } catch { /* already present */ }

const RECENT_KEEP = 1200;

const stmt = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
  setMeta: db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  upBucket: db.prepare(`INSERT INTO buckets(minute, token, volume, cnt, mint, burn, rvolume, rcnt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(minute, token) DO UPDATE SET
      volume = volume + excluded.volume, cnt = cnt + excluded.cnt,
      mint = mint + excluded.mint, burn = burn + excluded.burn,
      rvolume = rvolume + excluded.rvolume, rcnt = rcnt + excluded.rcnt`),
  upAddr: db.prepare(`INSERT INTO addr_stats(address, transfers, volume, last_block) VALUES(?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      transfers = transfers + excluded.transfers, volume = volume + excluded.volume,
      last_block = MAX(last_block, excluded.last_block)`),
  insRecent: db.prepare('INSERT INTO recent(block, ts, token, frm, too, amount) VALUES(?, ?, ?, ?, ?, ?)'),
  trimRecent: db.prepare('DELETE FROM recent WHERE id <= (SELECT MAX(id) FROM recent) - ?'),
  top: db.prepare('SELECT address, transfers, volume FROM addr_stats ORDER BY volume DESC LIMIT ?'),
  largest: db.prepare('SELECT token, frm, too, amount FROM recent ORDER BY amount DESC LIMIT ?'),
  activeSince: db.prepare('SELECT COUNT(*) AS c FROM addr_stats WHERE last_block >= ?'),
  coverage: db.prepare('SELECT MIN(minute) AS a, MAX(minute) AS b FROM buckets'),
  pruneBuckets: db.prepare('DELETE FROM buckets WHERE minute < ?'),
  pruneAddrs: db.prepare('DELETE FROM addr_stats WHERE last_block < ?'),
};

export const getCheckpoint = () => {
  const r = stmt.getMeta.get('checkpoint');
  return r ? Number(r.v) : null;
};
export const setCheckpoint = (n) => stmt.setMeta.run('checkpoint', String(n));

// Flush one processed batch (aggregated in JS) inside a single transaction.
export function applyBatch(buckets, addrs, recents) {
  db.exec('BEGIN');
  try {
    for (const b of buckets.values()) stmt.upBucket.run(b.minute, b.token, b.volume, b.cnt, b.mint, b.burn, b.rvolume, b.rcnt);
    for (const [addr, x] of addrs) stmt.upAddr.run(addr, x.transfers, x.volume, x.lastBlock);
    for (const r of recents) stmt.insRecent.run(r.block, r.ts, r.token, r.frm, r.too, r.amount);
    if (recents.length) stmt.trimRecent.run(RECENT_KEEP);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Time series, grouped into buckets of `groupSec`, since unix second `since`.
// Statements are cached per (filter, groupSec); groupSec is coerced to a positive
// integer before interpolation so it can never carry untrusted SQL.
const histStmts = new Map();
export function getHistory(token, since, groupSec) {
  const filter = token && token !== 'ALL';
  const g = Math.max(1, Math.floor(Number(groupSec) || 60));
  const ck = (filter ? 'f' : 'a') + g;
  let ps = histStmts.get(ck);
  if (!ps) {
    ps = db.prepare(`SELECT (minute / ${g}) * ${g} AS t,
        SUM(volume) AS volume, SUM(cnt) AS cnt, SUM(mint) AS mint, SUM(burn) AS burn,
        SUM(rvolume) AS rvolume, SUM(rcnt) AS rcnt
      FROM buckets WHERE minute >= ? ${filter ? 'AND token = ?' : ''}
      GROUP BY t ORDER BY t`);
    histStmts.set(ck, ps);
  }
  const rows = filter ? ps.all(since, token) : ps.all(since);
  return rows.map((r) => ({ t: r.t, volume: r.volume, cnt: r.cnt, mint: r.mint, burn: r.burn, rvolume: r.rvolume, rcnt: r.rcnt }));
}

// Per-token totals since `since` (defaults to a 24h window).
export function getSummary(since) {
  const rows = db.prepare(`SELECT token, SUM(volume) AS volume, SUM(cnt) AS cnt, SUM(mint) AS mint, SUM(burn) AS burn,
      SUM(rvolume) AS rvolume, SUM(rcnt) AS rcnt
    FROM buckets WHERE minute >= ? GROUP BY token`).all(since);
  const byToken = {};
  let volume = 0, transfers = 0, rvolume = 0, rtransfers = 0;
  for (const r of rows) {
    byToken[r.token] = { volume: r.volume, transfers: r.cnt, mint: r.mint, burn: r.burn, rvolume: r.rvolume, rtransfers: r.rcnt };
    volume += r.volume; transfers += r.cnt; rvolume += r.rvolume; rtransfers += r.rcnt;
  }
  return { byToken, volume, transfers, rvolume, rtransfers };
}

export const getTop = (limit = 8) => stmt.top.all(limit);
export const getLargest = (limit = 8) => stmt.largest.all(limit);
export const activeSince = (block) => stmt.activeSince.get(block).c;
export const getCoverage = () => stmt.coverage.get();

// ---- API keys ----
const kstmt = {
  ins: db.prepare('INSERT INTO api_keys(key, label, tier, created) VALUES(?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM api_keys WHERE key = ?'),
  bump: db.prepare('UPDATE api_keys SET requests = requests + 1, last_used = ? WHERE key = ?'),
};
export function createKey(key, label, tier) { kstmt.ins.run(key, label || null, tier || 'free', Date.now()); return kstmt.get.get(key); }
export const getKey = (key) => kstmt.get.get(key);
export const bumpKey = (key) => kstmt.bump.run(Date.now(), key);

const tierstmt = {
  toPro: db.prepare("UPDATE api_keys SET tier = 'pro', expires_at = ? WHERE key = ?"),
  toFree: db.prepare("UPDATE api_keys SET tier = 'free', expires_at = NULL WHERE key = ?"),
};
// Extends from the current expiry if still active (renewal), otherwise from now (lapsed or first purchase).
export function upgradeToPro(key, days) {
  const rec = getKey(key);
  const base = rec?.expires_at && rec.expires_at > Date.now() ? rec.expires_at : Date.now();
  const expiresAt = base + days * 86400000;
  tierstmt.toPro.run(expiresAt, key);
  return expiresAt;
}
export const downgradeKey = (key) => tierstmt.toFree.run(key);

// ---- crypto orders (Pro tier billing) ----
const ostmt = {
  ins: db.prepare("INSERT INTO orders(key, amount, status, created) VALUES(?, ?, 'pending', ?)"),
  pending: db.prepare("SELECT * FROM orders WHERE status = 'pending'"),
  latestByKey: db.prepare('SELECT * FROM orders WHERE key = ? ORDER BY id DESC LIMIT 1'),
  markPaid: db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, tx_hash = ? WHERE id = ? AND status = 'pending'"),
  expireStale: db.prepare("UPDATE orders SET status = 'expired' WHERE status = 'pending' AND created < ?"),
  amountTaken: db.prepare("SELECT 1 FROM orders WHERE amount = ? AND status = 'pending'"),
};
// Generates a base-price order with a random 6-decimal offset so simultaneous orders never
// collide on the exact USDC amount — that amount is how an incoming payment gets matched.
export function createProOrder(key, basePrice) {
  let amount;
  for (let i = 0; i < 25; i++) {
    const micro = Math.round(basePrice * 1e6) + 1 + Math.floor(Math.random() * 999999);
    amount = micro / 1e6;
    if (!ostmt.amountTaken.get(amount)) break;
  }
  const id = ostmt.ins.run(key, amount, Date.now()).lastInsertRowid;
  return { id, amount };
}
export const pendingOrders = () => ostmt.pending.all();
export const latestOrderByKey = (key) => ostmt.latestByKey.get(key);
export const markOrderPaid = (id, txHash) => ostmt.markPaid.run(Date.now(), txHash, id).changes > 0;
export const expireStaleOrders = (beforeTs) => ostmt.expireStale.run(beforeTs);

// generic meta get/set, used by payments.js for its own block checkpoint
export const getMetaValue = (k) => stmt.getMeta.get(k)?.v ?? null;
export const setMetaValue = (k, v) => stmt.setMeta.run(k, String(v));

// ---- alerts ----
const astmt = {
  ins: db.prepare('INSERT INTO alerts(key, address, token, min_amount, webhook, created) VALUES(?, ?, ?, ?, ?, ?)'),
  byKey: db.prepare('SELECT id, address, token, min_amount, webhook, created, fires, last_fired FROM alerts WHERE key = ? ORDER BY id DESC'),
  countByKey: db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE key = ?'),
  all: db.prepare('SELECT * FROM alerts'),
  fired: db.prepare('UPDATE alerts SET last_fired = ?, fires = fires + 1 WHERE id = ?'),
  del: db.prepare('DELETE FROM alerts WHERE id = ? AND key = ?'),
};
export function createAlert(a) { return astmt.ins.run(a.key, a.address || null, a.token || null, a.minAmount || 0, a.webhook || null, Date.now()).lastInsertRowid; }
export const alertsByKey = (key) => astmt.byKey.all(key);
export const alertCount = (key) => astmt.countByKey.get(key).c;
export const activeAlerts = () => astmt.all.all();
export const markFired = (id) => astmt.fired.run(Date.now(), id);
export const deleteAlert = (id, key) => astmt.del.run(id, key).changes;

// ---- address lookup ----
const adstmt = {
  stats: db.prepare('SELECT address, transfers, volume, last_block FROM addr_stats WHERE address = ?'),
  recent: db.prepare('SELECT block, ts, token, frm, too, amount FROM recent WHERE frm = ? OR too = ? ORDER BY id DESC LIMIT ?'),
};
export function addressStats(a) { return adstmt.stats.get(a.toLowerCase()); }
export function addressRecent(a, limit = 20) { const x = a.toLowerCase(); return adstmt.recent.all(x, x, limit); }

// ---- per-token detail (drill-down) ----
const tkstmt = {
  amountsAll: db.prepare('SELECT amount FROM recent'),
  amountsTok: db.prepare('SELECT amount FROM recent WHERE token = ?'),
  largest: db.prepare('SELECT token, frm, too, amount, block, ts FROM recent WHERE token = ? ORDER BY amount DESC LIMIT ?'),
  recent: db.prepare('SELECT token, frm, too, amount, block, ts FROM recent WHERE token = ? ORDER BY id DESC LIMIT ?'),
};

// Transfer-size histogram over the indexed `recent` window (rolling). token='ALL' → all tokens.
export function sizeDistribution(token) {
  const rows = (token && token !== 'ALL') ? tkstmt.amountsTok.all(token) : tkstmt.amountsAll.all();
  const brackets = SIZE_BRACKETS.map((b) => ({ label: b.label, min: b.min, max: b.max === Infinity ? null : b.max, count: 0 }));
  for (const r of rows) {
    for (let i = 0; i < SIZE_BRACKETS.length; i++) {
      if (r.amount >= SIZE_BRACKETS[i].min && r.amount < SIZE_BRACKETS[i].max) { brackets[i].count += 1; break; }
    }
  }
  return { total: rows.length, brackets };
}
export const largestByToken = (token, limit = 8) => tkstmt.largest.all(token, limit);
export const recentByToken = (token, limit = 12) => tkstmt.recent.all(token, limit);

export function prune(nowSec, latestBlock, blockMs) {
  const weekBlocks = Math.round((7 * 86400 * 1000) / Math.max(200, blockMs));
  stmt.pruneBuckets.run(nowSec - 7 * 86400);
  stmt.pruneAddrs.run(latestBlock - weekBlocks);
}

// Close the database (WAL checkpoint) for a clean shutdown.
export const close = () => { try { db.close(); } catch { /* already closed */ } };
