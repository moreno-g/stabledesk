// SQLite persistence for the historical indexer (zero-dependency: node:sqlite).

import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIZE_BRACKETS } from './constants.js';
import { CHAIN } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// One database file per network. Aggregates are additive, so a single faucet-funded row mixed
// into mainnet history could never be subtracted back out — the separation has to happen before
// the first write, not after. Testnet keeps the original filename so existing deployments carry
// their history across this change untouched.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (vol) return join(vol, CHAIN.dbFile);
  return join(__dirname, CHAIN.dbFile);
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

  -- Exact per-block fee accounting, from transaction receipts. Receipts are far too
  -- many to fetch for every block on a rate-limited public RPC, so the indexer samples
  -- a few blocks per tick; each row here is exact for its block, and the sample count
  -- is always reported alongside the derived rates.
  CREATE TABLE IF NOT EXISTS fee_samples (
    block    INTEGER PRIMARY KEY,       -- dedupes re-sampled blocks (INSERT OR IGNORE)
    minute   INTEGER NOT NULL,
    fees     REAL    NOT NULL,          -- total fees paid in that block, in USDC (gas token on Arc)
    txs      INTEGER NOT NULL,
    gas_used INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fee_minute ON fee_samples(minute);

  -- Derived on-chain attributes for high-volume addresses (experimental — see entities.js).
  -- Everything here is computed from public chain data, never scraped from another provider.
  -- Dropping this table and entities.js removes the feature entirely.
  CREATE TABLE IF NOT EXISTS address_meta (
    address     TEXT PRIMARY KEY,
    is_contract INTEGER NOT NULL DEFAULT 0,
    code_hash   TEXT,                  -- bytecode fingerprint: clusters identical deployments
    code_size   INTEGER,
    token_name  TEXT,
    token_symbol TEXT,
    impl        TEXT,                  -- EIP-1967 implementation slot (proxy target)
    admin       TEXT,                  -- EIP-1967 admin slot
    interfaces  TEXT,                  -- comma-separated selector names found in the bytecode
    kind        TEXT,                  -- derived classification (wallet | token | proxy | ...)
    blocks_made INTEGER NOT NULL DEFAULT 0,  -- blocks produced, if a validator
    checked     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ameta_hash ON address_meta(code_hash);

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

  -- Draft social posts for notable ("whale") transfers — held in reserve until Arc
  -- mainnet (see whalewatch.js). Nothing delivers these anywhere yet; they just
  -- accumulate here so the detection logic can be built and proven ahead of time.
  CREATE TABLE IF NOT EXISTS tweet_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, token TEXT NOT NULL, amount REAL NOT NULL,
    frm TEXT, too TEXT, block INTEGER, dedupe_key TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL, created INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_delivered ON tweet_drafts(delivered);

  -- Stablecoin balances held by contract addresses. On a chain where value is denominated in
  -- stablecoins, this *is* TVL: no price oracle, no LP maths, no per-protocol adapter for the
  -- bulk of it — just balanceOf on the assets we already index. See tvl.js and /methodology.
  CREATE TABLE IF NOT EXISTS tvl (
    address TEXT    NOT NULL,
    token   TEXT    NOT NULL,
    balance REAL    NOT NULL DEFAULT 0,
    checked INTEGER,
    PRIMARY KEY (address, token)
  );
  CREATE INDEX IF NOT EXISTS idx_tvl_balance ON tvl(balance DESC);

  -- Daily TVL per protocol, for charts and the movers ranking. protocol = '*' is the chain-wide
  -- total; one row per (day, protocol) so a re-run during the same day overwrites rather than
  -- accumulates — unlike the buckets table, TVL is a level, not a flow.
  CREATE TABLE IF NOT EXISTS tvl_history (
    day      INTEGER NOT NULL,
    protocol TEXT    NOT NULL,
    tvl      REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (day, protocol)
  );
  CREATE INDEX IF NOT EXISTS idx_tvlh_proto ON tvl_history(protocol, day);

  -- The chain-availability record: one row per state change, forever. See chainuptime.js.
  -- Deliberately absent from prune(): every other table here is a rolling window because its rows
  -- are per-minute or per-address and grow without bound, whereas a row lands here only when the
  -- chain's state actually changes. Pruning the one table whose entire purpose is to be a
  -- permanent record would delete the feature. Rows include the synthetic 'unobserved' state,
  -- written at boot to mark where the previous session stopped watching.
  CREATE TABLE IF NOT EXISTS chain_events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at    INTEGER NOT NULL,               -- unix ms
    state TEXT    NOT NULL,
    head  INTEGER,                        -- head block at the transition, when known
    error TEXT                            -- the error that caused it, for non-live states
  );
  CREATE INDEX IF NOT EXISTS idx_chain_events_at ON chain_events(at);
`);

// Migrations, safe on existing DBs:
//   rvolume/rcnt — "real" volume (one transfer per tx per token)
//   avolume/acnt — "adjusted" volume (real, minus transfers touching a high-frequency address)
//   bmint/bburn   — the Circle Gateway share of mint/burn (cross-chain rebalancing, not issuance)
//   bvolume/bcnt  — the Gateway share of real volume
// Buckets written before this migration count Gateway flow inside mint/burn/rvolume with no way
// to separate it, so they read as zero here. That is why this lands before Arc mainnet: the
// aggregates are additive and a mixed history can't be unmixed afterwards.
for (const col of ['rvolume REAL NOT NULL DEFAULT 0', 'rcnt INTEGER NOT NULL DEFAULT 0',
                   'avolume REAL NOT NULL DEFAULT 0', 'acnt INTEGER NOT NULL DEFAULT 0',
                   'bmint REAL NOT NULL DEFAULT 0', 'bburn REAL NOT NULL DEFAULT 0',
                   'bvolume REAL NOT NULL DEFAULT 0', 'bcnt INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE buckets ADD COLUMN ${col}`); } catch { /* already present */ }
}
// Migration: Pro-tier expiry, so a lapsed subscription reverts to free automatically.
try { db.exec('ALTER TABLE api_keys ADD COLUMN expires_at INTEGER'); } catch { /* already present */ }
// Migration: the address that first funded each address — the cheapest edge of the funding
// graph, and the one heuristic that reliably ties an operational wallet back to its treasury.
// Captured at index time (free) rather than reconstructed later (a full-history log scan).
try { db.exec('ALTER TABLE addr_stats ADD COLUMN first_from TEXT'); } catch { /* already present */ }

const RECENT_KEEP = 1200;

// Ceiling on the high-frequency address set, so a pathological window can't load an unbounded
// set into memory. Exported and published rather than buried, because of what happens when it
// binds: past this many qualifying addresses, which ones get flagged stops being decided by the
// published thresholds and starts being decided by this number plus an ORDER BY. Adjusted volume
// currently drops ~76% of real volume, so a reader who is not told the cap is active cannot audit
// the figure they are being shown — and "every threshold is published" would be false.
export const NOISE_SET_MAX = 5000;

const stmt = {
  getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
  setMeta: db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  upBucket: db.prepare(`INSERT INTO buckets(minute, token, volume, cnt, mint, burn, rvolume, rcnt, avolume, acnt, bmint, bburn, bvolume, bcnt)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(minute, token) DO UPDATE SET
      volume = volume + excluded.volume, cnt = cnt + excluded.cnt,
      mint = mint + excluded.mint, burn = burn + excluded.burn,
      rvolume = rvolume + excluded.rvolume, rcnt = rcnt + excluded.rcnt,
      avolume = avolume + excluded.avolume, acnt = acnt + excluded.acnt,
      bmint = bmint + excluded.bmint, bburn = bburn + excluded.bburn,
      bvolume = bvolume + excluded.bvolume, bcnt = bcnt + excluded.bcnt`),
  // first_from is written once and never overwritten — it records who funded the address first.
  upAddr: db.prepare(`INSERT INTO addr_stats(address, transfers, volume, last_block, first_from) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      transfers = transfers + excluded.transfers, volume = volume + excluded.volume,
      last_block = MAX(last_block, excluded.last_block),
      first_from = COALESCE(addr_stats.first_from, excluded.first_from)`),
  insRecent: db.prepare('INSERT INTO recent(block, ts, token, frm, too, amount) VALUES(?, ?, ?, ?, ?, ?)'),
  trimRecent: db.prepare('DELETE FROM recent WHERE id <= (SELECT MAX(id) FROM recent) - ?'),
  top: db.prepare('SELECT address, transfers, volume FROM addr_stats ORDER BY volume DESC LIMIT ?'),
  largest: db.prepare('SELECT token, frm, too, amount FROM recent ORDER BY amount DESC LIMIT ?'),
  activeSince: db.prepare('SELECT COUNT(*) AS c FROM addr_stats WHERE last_block >= ?'),
  coverage: db.prepare('SELECT MIN(minute) AS a, MAX(minute) AS b FROM buckets'),
  pruneBuckets: db.prepare('DELETE FROM buckets WHERE minute < ?'),
  pruneAddrs: db.prepare('DELETE FROM addr_stats WHERE last_block < ?'),
  // Addresses busy enough to be treated as infrastructure rather than economic actors.
  noisy: db.prepare(`SELECT address, transfers, volume FROM addr_stats WHERE transfers > ? OR volume > ? ORDER BY volume DESC LIMIT ${NOISE_SET_MAX}`),
  // How many the thresholds actually select, uncapped. Kept as its own query so the difference
  // between "selected by the published rule" and "flagged after the cap" is a measured number
  // rather than an inference from the set landing suspiciously round.
  noisyCount: db.prepare('SELECT COUNT(*) AS c FROM addr_stats WHERE transfers > ? OR volume > ?'),
  zeroAdj: db.prepare('UPDATE buckets SET avolume = 0, acnt = 0 WHERE minute BETWEEN ? AND ?'),
  setAdj: db.prepare('UPDATE buckets SET avolume = ?, acnt = ? WHERE minute = ? AND token = ?'),
  insFee: db.prepare('INSERT OR IGNORE INTO fee_samples(block, minute, fees, txs, gas_used) VALUES(?, ?, ?, ?, ?)'),
  feeStats: db.prepare('SELECT COUNT(*) AS blocks, SUM(fees) AS fees, SUM(txs) AS txs, SUM(gas_used) AS gas FROM fee_samples WHERE minute >= ?'),
  pruneFees: db.prepare('DELETE FROM fee_samples WHERE minute < ?'),
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
    // Columns added by migration default to 0 for callers that predate them.
    for (const b of buckets.values()) {
      stmt.upBucket.run(b.minute, b.token, b.volume, b.cnt, b.mint, b.burn, b.rvolume || 0, b.rcnt || 0, b.avolume || 0, b.acnt || 0,
        b.bmint || 0, b.bburn || 0, b.bvolume || 0, b.bcnt || 0);
    }
    for (const [addr, x] of addrs) stmt.upAddr.run(addr, x.transfers, x.volume, x.lastBlock, x.firstFrom || null);
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
        SUM(rvolume) AS rvolume, SUM(rcnt) AS rcnt, SUM(avolume) AS avolume, SUM(acnt) AS acnt,
        SUM(bmint) AS bmint, SUM(bburn) AS bburn, SUM(bvolume) AS bvolume, SUM(bcnt) AS bcnt
      FROM buckets WHERE minute >= ? ${filter ? 'AND token = ?' : ''}
      GROUP BY t ORDER BY t`);
    histStmts.set(ck, ps);
  }
  const rows = filter ? ps.all(since, token) : ps.all(since);
  return rows.map((r) => ({ t: r.t, volume: r.volume, cnt: r.cnt, mint: r.mint, burn: r.burn, rvolume: r.rvolume, rcnt: r.rcnt, avolume: r.avolume, acnt: r.acnt, bmint: r.bmint, bburn: r.bburn, bvolume: r.bvolume, bcnt: r.bcnt }));
}

// Per-token totals since `since` (defaults to a 24h window).
export function getSummary(since) {
  const rows = db.prepare(`SELECT token, SUM(volume) AS volume, SUM(cnt) AS cnt, SUM(mint) AS mint, SUM(burn) AS burn,
      SUM(rvolume) AS rvolume, SUM(rcnt) AS rcnt, SUM(avolume) AS avolume, SUM(acnt) AS acnt,
      SUM(bmint) AS bmint, SUM(bburn) AS bburn, SUM(bvolume) AS bvolume, SUM(bcnt) AS bcnt
    FROM buckets WHERE minute >= ? GROUP BY token`).all(since);
  const byToken = {};
  let volume = 0, transfers = 0, rvolume = 0, rtransfers = 0, avolume = 0, atransfers = 0;
  let bmint = 0, bburn = 0, bvolume = 0, btransfers = 0;
  for (const r of rows) {
    byToken[r.token] = {
      volume: r.volume, transfers: r.cnt, mint: r.mint, burn: r.burn,
      rvolume: r.rvolume, rtransfers: r.rcnt, avolume: r.avolume, atransfers: r.acnt,
      bmint: r.bmint, bburn: r.bburn, bvolume: r.bvolume, btransfers: r.bcnt,
    };
    volume += r.volume; transfers += r.cnt;
    rvolume += r.rvolume; rtransfers += r.rcnt;
    avolume += r.avolume; atransfers += r.acnt;
    bmint += r.bmint; bburn += r.bburn; bvolume += r.bvolume; btransfers += r.bcnt;
  }
  return { byToken, volume, transfers, rvolume, rtransfers, avolume, atransfers, bmint, bburn, bvolume, btransfers };
}

// Addresses whose activity over the retained window exceeds the given absolute limits.
// The indexer scales the per-day thresholds by how many days of history it actually holds.
export const noisyAddresses = (maxTransfers, maxVolume) => stmt.noisy.all(maxTransfers, maxVolume);
export const noisyAddressCount = (maxTransfers, maxVolume) => stmt.noisyCount.get(maxTransfers, maxVolume).c;

// ---- fee samples (exact per-block fees, sampled) ----
export function insertFeeSamples(rows) {
  if (!rows.length) return;
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.insFee.run(r.block, r.minute, r.fees, r.txs, r.gasUsed);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
// Overwrite (not accumulate) the adjusted columns across a minute range. Used once after a cold
// backfill, when those rows were scored before any address had been flagged. The range is zeroed
// first so a bucket whose entire activity turned out to be noise correctly drops to 0 rather than
// keeping its inflated first-pass value — such buckets never appear in `buckets` at all.
export function setAdjusted(buckets, fromMinute, toMinute) {
  let changed = 0;
  db.exec('BEGIN');
  try {
    stmt.zeroAdj.run(fromMinute, toMinute);
    for (const b of buckets.values()) changed += stmt.setAdj.run(b.avolume, b.acnt, b.minute, b.token).changes;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return changed;
}

export function feeStats(sinceMinute) {
  const r = stmt.feeStats.get(sinceMinute);
  return { blocks: r?.blocks || 0, fees: r?.fees || 0, txs: r?.txs || 0, gasUsed: r?.gas || 0 };
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

// ---- tweet drafts (whale-transfer content, held in reserve — see whalewatch.js) ----
const tdstmt = {
  ins: db.prepare(`INSERT OR IGNORE INTO tweet_drafts(kind, token, amount, frm, too, block, dedupe_key, text, created)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  pending: db.prepare('SELECT * FROM tweet_drafts WHERE delivered = 0 ORDER BY id'),
  markDelivered: db.prepare('UPDATE tweet_drafts SET delivered = 1 WHERE id = ?'),
};
// Returns true if this is a new draft, false if dedupe_key already existed (INSERT OR IGNORE).
export function createTweetDraft(d) {
  const info = tdstmt.ins.run(d.kind, d.token, d.amount, d.frm || null, d.too || null, d.block || null, d.dedupeKey, d.text, Date.now());
  return info.changes > 0;
}
export const pendingTweetDrafts = () => tdstmt.pending.all();
export const markDraftDelivered = (id) => tdstmt.markDelivered.run(id);

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

// Prefix search for the global search box. Bound as a parameter (not interpolated), and the caller
// validates the prefix is hex first, so the LIKE pattern can't carry a wildcard.
const searchStmt = db.prepare('SELECT address, transfers, volume FROM addr_stats WHERE address LIKE ? ORDER BY volume DESC LIMIT ?');
export const searchAddresses = (prefix, limit = 10) => searchStmt.all(prefix.toLowerCase() + '%', limit);

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

// ---- derived address attributes (experimental — entities.js; drop this block to remove) ----
const emstmt = {
  up: db.prepare(`INSERT INTO address_meta(address, is_contract, code_hash, code_size, token_name,
      token_symbol, impl, admin, interfaces, kind, blocks_made, checked)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      is_contract = excluded.is_contract, code_hash = excluded.code_hash, code_size = excluded.code_size,
      token_name = excluded.token_name, token_symbol = excluded.token_symbol, impl = excluded.impl,
      admin = excluded.admin, interfaces = excluded.interfaces, kind = excluded.kind,
      blocks_made = MAX(address_meta.blocks_made, excluded.blocks_made), checked = excluded.checked`),
  get: db.prepare('SELECT * FROM address_meta WHERE address = ?'),
  // The derived view: top addresses by volume, joined to whatever we've worked out about them.
  joined: db.prepare(`SELECT a.address, a.transfers, a.volume, a.first_from, m.is_contract, m.code_hash,
      m.code_size, m.token_name, m.token_symbol, m.impl, m.admin, m.interfaces, m.kind, m.blocks_made, m.checked
    FROM addr_stats a LEFT JOIN address_meta m ON m.address = a.address
    ORDER BY a.volume DESC LIMIT ?`),
  // Addresses sharing a bytecode fingerprint are the same contract deployed more than once,
  // so identifying one identifies the whole family.
  clusters: db.prepare(`SELECT code_hash, COUNT(*) AS n FROM address_meta
    WHERE code_hash IS NOT NULL GROUP BY code_hash HAVING n > 1 ORDER BY n DESC LIMIT 20`),
  byHash: db.prepare('SELECT address FROM address_meta WHERE code_hash = ? LIMIT 50'),
  countKnown: db.prepare('SELECT COUNT(*) AS c FROM address_meta WHERE kind IS NOT NULL'),
};
export function upsertAddressMeta(m) {
  emstmt.up.run(m.address, m.isContract ? 1 : 0, m.codeHash || null, m.codeSize || null,
    m.tokenName || null, m.tokenSymbol || null, m.impl || null, m.admin || null,
    m.interfaces || null, m.kind || null, m.blocksMade || 0, Date.now());
}
export const addressMeta = (a) => emstmt.get.get(a.toLowerCase());
export const topWithMeta = (limit = 40) => emstmt.joined.all(limit);
export const bytecodeClusters = () => emstmt.clusters.all().map((r) => ({ ...r, addresses: emstmt.byHash.all(r.code_hash).map((x) => x.address) }));
export const knownAddressCount = () => emstmt.countKnown.get().c;

// ---- TVL (stablecoin balances held by contracts — see tvl.js) ----
const tvstmt = {
  up: db.prepare(`INSERT INTO tvl(address, token, balance, checked) VALUES(?, ?, ?, ?)
    ON CONFLICT(address, token) DO UPDATE SET balance = excluded.balance, checked = excluded.checked`),
  // Non-zero only: a contract that has never held anything is not a data point worth serving.
  nonZero: db.prepare('SELECT address, token, balance, checked FROM tvl WHERE balance > 0 ORDER BY balance DESC'),
  forAddr: db.prepare('SELECT token, balance, checked FROM tvl WHERE address = ? AND balance > 0'),
  // Contracts the entity deriver has already confirmed have bytecode. Balances are only ever
  // scanned for these plus the registry's own addresses — scanning every address seen would
  // multiply RPC cost by ~1000 for no gain, since a plain wallet's balance is not TVL.
  contracts: db.prepare('SELECT address FROM address_meta WHERE is_contract = 1 ORDER BY address LIMIT ?'),
  // Records only whether an address has bytecode, and never overwrites an existing row — so the
  // TVL scanner can discover contracts on its own without clobbering anything entities.js derived.
  markCode: db.prepare(`INSERT INTO address_meta(address, is_contract, code_size, checked) VALUES(?, ?, ?, ?)
    ON CONFLICT(address) DO NOTHING`),
  unchecked: db.prepare(`SELECT a.address FROM addr_stats a LEFT JOIN address_meta m ON m.address = a.address
    WHERE m.address IS NULL ORDER BY a.volume DESC LIMIT ?`),
  histUp: db.prepare(`INSERT INTO tvl_history(day, protocol, tvl) VALUES(?, ?, ?)
    ON CONFLICT(day, protocol) DO UPDATE SET tvl = excluded.tvl`),
  histSeries: db.prepare('SELECT day, tvl FROM tvl_history WHERE protocol = ? AND day >= ? ORDER BY day'),
  histOn: db.prepare('SELECT tvl FROM tvl_history WHERE protocol = ? AND day = ?'),
  histPrune: db.prepare('DELETE FROM tvl_history WHERE day < ?'),
};

export function upsertBalances(rows) {
  if (!rows.length) return 0;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const r of rows) tvstmt.up.run(r.address, r.token, r.balance, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

export const balanceRows = () => tvstmt.nonZero.all();
export const balancesForAddress = (a) => tvstmt.forAddr.all(String(a).toLowerCase());
export const knownContracts = (limit = 2000) => tvstmt.contracts.all(limit).map((r) => r.address);
export const markContract = (a, isContract, codeSize) => tvstmt.markCode.run(a, isContract ? 1 : 0, codeSize || 0, Date.now());
export const uncheckedAddresses = (limit = 40) => tvstmt.unchecked.all(limit).map((r) => r.address);

// Written once per scan; the same day is overwritten rather than added to, because TVL is a level.
export function recordTvlSnapshot(day, entries) {
  db.exec('BEGIN');
  try {
    for (const e of entries) tvstmt.histUp.run(day, e.protocol, e.tvl);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export const tvlSeries = (protocol, sinceDay) => tvstmt.histSeries.all(protocol, sinceDay);
export const tvlOn = (protocol, day) => tvstmt.histOn.get(protocol, day)?.tvl ?? null;

// Window volume for a set of addresses, from the same aggregates the rankings use. The window is
// however much history is retained (~7d), not 24h — callers label it as such rather than implying
// a day. Statements are cached per placeholder count; the set is chunked so the SQL stays bounded.
const inStmts = new Map();
export function volumeForAddresses(addrs) {
  const list = [...new Set((addrs || []).map((a) => String(a).toLowerCase()))];
  let volume = 0, transfers = 0, found = 0;
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    let ps = inStmts.get(part.length);
    if (!ps) {
      ps = db.prepare(`SELECT COUNT(*) AS found, SUM(volume) AS volume, SUM(transfers) AS transfers
        FROM addr_stats WHERE address IN (${part.map(() => '?').join(',')})`);
      inStmts.set(part.length, ps);
    }
    const r = ps.get(...part);
    volume += r?.volume || 0;
    transfers += r?.transfers || 0;
    found += r?.found || 0;
  }
  return { volume, transfers, addressesSeen: found };
}

// ---- chain availability record (see chainuptime.js) ----

const cestmt = {
  ins: db.prepare('INSERT INTO chain_events(at, state, head, error) VALUES(?, ?, ?, ?)'),
  last: db.prepare('SELECT at, state, head, error FROM chain_events ORDER BY at DESC, id DESC LIMIT 1'),
  first: db.prepare('SELECT at FROM chain_events ORDER BY at ASC, id ASC LIMIT 1'),
  since: db.prepare('SELECT at, state, head, error FROM chain_events WHERE at >= ? ORDER BY at ASC, id ASC'),
  before: db.prepare('SELECT at, state, head, error FROM chain_events WHERE at < ? ORDER BY at DESC, id DESC LIMIT 1'),
};

export const recordChainEvent = (at, state, head = null, error = null) =>
  cestmt.ins.run(at, state, head ?? null, error ? String(error).slice(0, 300) : null);

export const lastChainEvent = () => cestmt.last.get() ?? null;
export const firstChainEventAt = () => cestmt.first.get()?.at ?? null;

// The window, plus the one transition that precedes it. Without that leading row the state at the
// window's opening edge is unknown, and every window would open with a stretch of false "unobserved"
// running until the next time the chain happened to change state — which on a healthy chain could
// be the entire window.
export function chainEventsSince(from) {
  const prior = cestmt.before.get(from);
  const rows = cestmt.since.all(from);
  return prior ? [prior, ...rows] : rows;
}

export function prune(nowSec, latestBlock, blockMs) {
  tvstmt.histPrune.run(nowSec - 180 * 86400);
  const weekBlocks = Math.round((7 * 86400 * 1000) / Math.max(200, blockMs));
  stmt.pruneBuckets.run(nowSec - 7 * 86400);
  stmt.pruneAddrs.run(latestBlock - weekBlocks);
  stmt.pruneFees.run(nowSec - 7 * 86400);
}

// Close the database (WAL checkpoint) for a clean shutdown.
export const close = () => { try { db.close(); } catch { /* already closed */ } };
