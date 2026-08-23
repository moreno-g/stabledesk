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

  -- Per-day rollup of the table above, kept indefinitely. "buckets" is a rolling 7-day window
  -- because a row per minute per token grows without bound; a row per *day* per token does not
  -- (three tokens ≈ 1 KB/year), so there is no reason to throw the history away. Written by
  -- prune() out of the minutes it is about to delete, in the same transaction, so every minute is
  -- rolled up exactly once and the two tables never double-count. Launch day is the one day
  -- nobody can re-index later: at 7-day retention it would have been unreadable a week after it
  -- happened.
  CREATE TABLE IF NOT EXISTS buckets_daily (
    day    INTEGER NOT NULL,           -- unix seconds floored to the day (UTC)
    token  TEXT    NOT NULL,
    volume REAL    NOT NULL DEFAULT 0,
    cnt    INTEGER NOT NULL DEFAULT 0,
    mint   REAL    NOT NULL DEFAULT 0,
    burn   REAL    NOT NULL DEFAULT 0,
    rvolume REAL   NOT NULL DEFAULT 0,
    rcnt   INTEGER NOT NULL DEFAULT 0,
    avolume REAL   NOT NULL DEFAULT 0,
    acnt   INTEGER NOT NULL DEFAULT 0,
    bmint  REAL    NOT NULL DEFAULT 0,
    bburn  REAL    NOT NULL DEFAULT 0,
    bvolume REAL   NOT NULL DEFAULT 0,
    bcnt   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, token)
  );

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
  -- An address lookup used to scan this table end to end ("WHERE frm = ? OR too = ?"), which was
  -- free while it held ~1,200 rows and would not be at the retention below. Two indexes plus a
  -- UNION, because the OR could never use either one.
  CREATE INDEX IF NOT EXISTS idx_recent_frm ON recent(frm);
  CREATE INDEX IF NOT EXISTS idx_recent_too ON recent(too);
  CREATE INDEX IF NOT EXISTS idx_recent_ts ON recent(ts);
  CREATE INDEX IF NOT EXISTS idx_recent_token ON recent(token, amount DESC);

  -- The largest transfers per day and token, kept long after "recent" has rolled past them.
  -- "Largest transfer" read out of a rolling row-capped table is only ever the largest of the last
  -- few minutes, which is not the claim the terminal and /v1/transfers/largest make. The natural
  -- key dedupes a re-indexed range: replaying a block range must not list one transfer twice.
  CREATE TABLE IF NOT EXISTS top_transfers (
    day    INTEGER NOT NULL,
    token  TEXT    NOT NULL,
    amount REAL    NOT NULL,
    frm    TEXT, too TEXT, block INTEGER, ts INTEGER,
    PRIMARY KEY (day, token, block, frm, too, amount)
  );
  CREATE INDEX IF NOT EXISTS idx_top_amount ON top_transfers(amount DESC);
  CREATE INDEX IF NOT EXISTS idx_top_token ON top_transfers(token, amount DESC);
  CREATE INDEX IF NOT EXISTS idx_top_ts ON top_transfers(ts);

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

  -- Usage of the machine-readable surfaces (see usage.js). One row per route label per day.
  -- Deliberately holds no IP, no user agent and no key: it answers "how many calls hit this
  -- route today", which is a measure of usage rather than of people. Kept indefinitely — the
  -- path set is bounded by normalisation, so this is a few rows a day forever.
  -- Per-key, per-day call counts. api_keys.requests is a lifetime cumulative total, which cannot
  -- answer "what happened yesterday" — the question a daily digest exists to answer. One row per
  -- key per day, bounded by the number of keys, which minting limits already bound.
  CREATE TABLE IF NOT EXISTS key_daily (
    key TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
  );
  CREATE INDEX IF NOT EXISTS idx_key_daily_day ON key_daily(day);

  CREATE TABLE IF NOT EXISTS hits (
    path TEXT NOT NULL, day INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (path, day)
  );

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

  -- What the chain looked like last time we checked, so a check can report what *changed* rather
  -- than restating the present. verify-network.js on its own is stateless: it can say USDC.b exists,
  -- and never that USDC.b appeared this morning. The drift it was written for — a tracked token going
  -- dormant while a lookalike carried the volume — is only visible as a difference over time.
  --
  -- One row per observed subject. The miss counter is what keeps a sampled absence from being read
  -- as a disappearance: the discovery pass looks at a slice of recent blocks, so a contract missing
  -- from one sample has not necessarily gone anywhere. Same rule as everywhere else — silence has to
  -- repeat before it counts as an answer.
  CREATE TABLE IF NOT EXISTS watch_subjects (
    id          TEXT PRIMARY KEY,      -- kind:address, e.g. 'token:0x36…' or 'seen:0x9a8e…'
    kind        TEXT NOT NULL,
    facts       TEXT NOT NULL,         -- JSON: the identity we last observed, never the volatile values
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,      -- last check that found it present/active
    last_check  INTEGER NOT NULL,
    misses      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_watch_kind ON watch_subjects(kind);
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
// Migration: the first block this address was seen in. Without it, `transfers` and `volume` are
// totals over an unknown span, and the noise filter was comparing them against a limit pro-rated
// to the *bucket* window — which prune() caps at 7 days. An address active for two months was
// therefore measured over two months and judged against seven days, so the same behaviour got
// flagged or not depending on how long this process had been running.
//
// NULL on rows written before this migration, and those fall back to the one-day floor — which
// *over*-flags them, since a long-lived address then looks like a one-day address with a long-lived
// address's totals. That direction is deliberate: it makes adjusted volume a lower bound rather than
// an overstatement, which is the same choice the flag-set cap makes. It also self-corrects, because
// the next transfer touching such an address records a first_block and the span grows from there —
// so an existing deployment understates adjusted volume for about a week after this lands, and a
// fresh database (mainnet) is never affected. Stated on /methodology rather than left to be noticed.
try { db.exec('ALTER TABLE addr_stats ADD COLUMN first_block INTEGER'); } catch { /* already present */ }
// Migration: when this address was last asked what it calls itself. Distinct from `checked`, which the
// contract-discovery path also writes — so `checked` cannot mean "identity has been probed", and using
// it as though it did would re-ask every silent contract on every pass, burning the whole per-pass
// budget on addresses already known to answer nothing and never reaching the ones that would.
try { db.exec('ALTER TABLE address_meta ADD COLUMN identity_checked INTEGER'); } catch { /* already present */ }
// Migration: how many times we have asked and got no answer at all. rpcSoft cannot tell a revert
// ("this contract has no name()") from a refused call ("the endpoint was busy") — both arrive as an
// empty slot. Treating the second as the first settled the question wrongly and permanently: 53
// addresses were marked as nameless while the chain answered "Synthra Perpetual Liquidity Token" for
// one of them on the very next call. Silence is only evidence after it repeats.
try { db.exec('ALTER TABLE address_meta ADD COLUMN identity_attempts INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }

// How much of the raw transfer stream is retained. This was 1,200 rows, which sounded like a
// window and was not one: at the ~954k transfers/day the testnet actually does, 1,200 rows is
// **114 seconds**. Eight surfaces read from this table — the size distribution, the largest
// transfers, an address's recent activity, a protocol's recent flow — and every one of them was
// describing the last two minutes while being labelled as something broader.
//
// A row cap still exists, because the point of the cap is to bound disk on a chain whose volume we
// don't get to choose. What changed is that it is large enough to be a window, the span it actually
// covers is measured and published (`recentWindow()`) instead of assumed, and the "largest"
// queries no longer come from here at all — they come from top_transfers, which is per-day and
// kept, so the biggest transfer of the week does not fall off the end in a few minutes.
export const RECENT_MAX = Number(process.env.RECENT_MAX) || 200000;
export const RECENT_WINDOW_SEC = 24 * 3600;

// Largest transfers written per (day, token) on each batch, and how many survive a prune. The
// per-batch figure only has to be big enough that a single chunk cannot push the day's real top N
// out; the retained figure is what the API can serve.
const TOP_PER_BATCH = 20;
export const TOP_PER_DAY = 100;

// Ceiling on the high-frequency address set, so a pathological window can't load an unbounded
// set into memory. Exported and published rather than buried, because of what happens when it
// binds: past this many qualifying addresses, which ones get flagged stops being decided by the
// published thresholds and starts being decided by this number plus an ORDER BY. Adjusted volume
// drops most of real volume on this chain, so a reader who is not told the cap is active cannot
// audit the figure they are being shown — and "every threshold is published" would be false.
//
// Raised from 5,000, which was measured at 4,443 qualifying addresses on four days of testnet
// history — 89% of the ceiling, on the quieter of the two networks. A set of this size is a few
// megabytes of strings; the cap exists to stop an unbounded load, not to be the binding constraint
// in ordinary operation, and at 5,000 it was about to become the latter.
export const NOISE_SET_MAX = Number(process.env.NOISE_SET_MAX) || 20000;

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
  // first_from and first_block are written once and never overwritten — the first is who funded
  // the address, the second is when we started being able to measure a rate for it at all.
  upAddr: db.prepare(`INSERT INTO addr_stats(address, transfers, volume, last_block, first_from, first_block) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      transfers = transfers + excluded.transfers, volume = volume + excluded.volume,
      last_block = MAX(last_block, excluded.last_block),
      first_from = COALESCE(addr_stats.first_from, excluded.first_from),
      first_block = MIN(COALESCE(addr_stats.first_block, excluded.first_block), excluded.first_block)`),
  insRecent: db.prepare('INSERT INTO recent(block, ts, token, frm, too, amount) VALUES(?, ?, ?, ?, ?, ?)'),
  trimRecent: db.prepare('DELETE FROM recent WHERE id <= (SELECT MAX(id) FROM recent) - ?'),
  trimRecentTs: db.prepare('DELETE FROM recent WHERE ts < ?'),
  recentWindow: db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS a, MAX(ts) AS b FROM recent'),
  insTop: db.prepare('INSERT OR IGNORE INTO top_transfers(day, token, amount, frm, too, block, ts) VALUES(?, ?, ?, ?, ?, ?, ?)'),
  largest: db.prepare('SELECT token, frm, too, amount, block, ts FROM top_transfers WHERE ts >= ? ORDER BY amount DESC LIMIT ?'),
  largestTok: db.prepare('SELECT token, frm, too, amount, block, ts FROM top_transfers WHERE token = ? AND ts >= ? ORDER BY amount DESC LIMIT ?'),
  topWindow: db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS a, MAX(ts) AS b FROM top_transfers'),
  // Keeps the top TOP_PER_DAY per (day, token) and drops the rest. A window function rather than a
  // correlated subquery, which would re-rank the table once per row.
  trimTop: db.prepare(`DELETE FROM top_transfers WHERE rowid IN (
    SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY day, token ORDER BY amount DESC) AS rn FROM top_transfers)
    WHERE rn > ?)`),
  pruneTop: db.prepare('DELETE FROM top_transfers WHERE day < ?'),
  top: db.prepare('SELECT address, transfers, volume FROM addr_stats ORDER BY volume DESC LIMIT ?'),
  activeSince: db.prepare('SELECT COUNT(*) AS c FROM addr_stats WHERE last_block >= ?'),
  coverage: db.prepare('SELECT MIN(minute) AS a, MAX(minute) AS b FROM buckets'),
  dailyCoverage: db.prepare('SELECT MIN(day) AS a, MAX(day) AS b, COUNT(DISTINCT day) AS days FROM buckets_daily'),
  pruneAddrs: db.prepare('DELETE FROM addr_stats WHERE last_block < ?'),
  // Roll the minutes about to be deleted into their day, then delete them. Additive on conflict,
  // because a day straddling the cutoff is rolled up across two prunes and both halves must land.
  rollupDaily: db.prepare(`INSERT INTO buckets_daily(day, token, volume, cnt, mint, burn, rvolume, rcnt, avolume, acnt, bmint, bburn, bvolume, bcnt)
    SELECT (minute / 86400) * 86400 AS day, token, SUM(volume), SUM(cnt), SUM(mint), SUM(burn),
           SUM(rvolume), SUM(rcnt), SUM(avolume), SUM(acnt), SUM(bmint), SUM(bburn), SUM(bvolume), SUM(bcnt)
      FROM buckets WHERE minute < ? GROUP BY day, token
    ON CONFLICT(day, token) DO UPDATE SET
      volume = volume + excluded.volume, cnt = cnt + excluded.cnt,
      mint = mint + excluded.mint, burn = burn + excluded.burn,
      rvolume = rvolume + excluded.rvolume, rcnt = rcnt + excluded.rcnt,
      avolume = avolume + excluded.avolume, acnt = acnt + excluded.acnt,
      bmint = bmint + excluded.bmint, bburn = bburn + excluded.bburn,
      bvolume = bvolume + excluded.bvolume, bcnt = bcnt + excluded.bcnt`),
  pruneBuckets: db.prepare('DELETE FROM buckets WHERE minute < ?'),
  // Addresses busy enough to be treated as infrastructure rather than economic actors.
  //
  // The rate is measured over each address's *own* observed span — first block to last, converted
  // to days at the measured block time and floored at one day — not over the retained bucket
  // window. Those two were silently different: an address seen for two months carried two months
  // of volume into a comparison against a seven-day limit.
  noisy: db.prepare(`SELECT address, transfers, volume, first_block, last_block, days FROM (
      SELECT address, transfers, volume, first_block, last_block,
             MAX(1.0, (last_block - COALESCE(first_block, last_block)) * ? / 86400000.0) AS days
        FROM addr_stats)
    WHERE transfers > ? * days OR volume > ? * days
    ORDER BY volume DESC LIMIT ${NOISE_SET_MAX}`),
  // How many the thresholds actually select, uncapped. Kept as its own query so the difference
  // between "selected by the published rule" and "flagged after the cap" is a measured number
  // rather than an inference from the set landing suspiciously round.
  noisyCount: db.prepare(`SELECT COUNT(*) AS c FROM (
      SELECT transfers, volume, MAX(1.0, (last_block - COALESCE(first_block, last_block)) * ? / 86400000.0) AS days
        FROM addr_stats)
    WHERE transfers > ? * days OR volume > ? * days`),
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

// The batch's largest transfers per (day, token). Computed here rather than in the indexer so
// every writer feeds top_transfers by construction: a caller that forgot would silently reintroduce
// "largest of the last few minutes". Only the top few per key are kept, so a chunk holding tens of
// thousands of transfers still writes a couple of dozen rows.
function topOf(recents, perKey = TOP_PER_BATCH) {
  const by = new Map();
  for (const r of recents) {
    const day = Math.floor(r.ts / 86400) * 86400;
    const k = day + '|' + r.token;
    let list = by.get(k);
    if (!list) { list = []; by.set(k, list); }
    list.push(r);
  }
  const out = [];
  for (const [k, list] of by) {
    const day = Number(k.slice(0, k.indexOf('|')));
    list.sort((a, b) => b.amount - a.amount);
    for (const r of list.slice(0, perKey)) out.push({ day, ...r });
  }
  return out;
}

// Flush one processed batch (aggregated in JS) inside a single transaction.
export function applyBatch(buckets, addrs, recents) {
  db.exec('BEGIN');
  try {
    // Columns added by migration default to 0 for callers that predate them.
    for (const b of buckets.values()) {
      stmt.upBucket.run(b.minute, b.token, b.volume, b.cnt, b.mint, b.burn, b.rvolume || 0, b.rcnt || 0, b.avolume || 0, b.acnt || 0,
        b.bmint || 0, b.bburn || 0, b.bvolume || 0, b.bcnt || 0);
    }
    for (const [addr, x] of addrs) stmt.upAddr.run(addr, x.transfers, x.volume, x.lastBlock, x.firstFrom || null, x.firstBlock ?? x.lastBlock ?? null);
    for (const r of recents) stmt.insRecent.run(r.block, r.ts, r.token, r.frm, r.too, r.amount);
    for (const t of topOf(recents)) stmt.insTop.run(t.day, t.token, t.amount, t.frm, t.too, t.block, t.ts);
    // The row cap bounds disk between prunes; prune() applies the time window. Both exist: the cap
    // alone would make the window a function of throughput, and the window alone would make disk a
    // function of throughput.
    if (recents.length) stmt.trimRecent.run(RECENT_MAX);
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

// Daily series, for ranges longer than the minute table retains. Reads the rollup *and* the minutes
// not yet rolled up, then groups both by day — otherwise every long range would end seven days ago,
// which is the shape of bug that makes a chart look like an outage. The boundary day exists in both
// tables (half rolled up, half still live), so the union has to be summed rather than concatenated.
const dailyStmts = new Map();
export function getDailyHistory(token, sinceDay) {
  const filter = token && token !== 'ALL';
  const ck = filter ? 'f' : 'a';
  let ps = dailyStmts.get(ck);
  if (!ps) {
    const cols = 'volume, cnt, mint, burn, rvolume, rcnt, avolume, acnt, bmint, bburn, bvolume, bcnt';
    ps = db.prepare(`SELECT day AS t, ${cols.split(', ').map((c) => `SUM(${c}) AS ${c}`).join(', ')} FROM (
        SELECT day, token, ${cols} FROM buckets_daily WHERE day >= ? ${filter ? 'AND token = ?' : ''}
        UNION ALL
        SELECT (minute / 86400) * 86400 AS day, token, ${cols} FROM buckets WHERE minute >= ? ${filter ? 'AND token = ?' : ''})
      GROUP BY t ORDER BY t`);
    dailyStmts.set(ck, ps);
  }
  return filter ? ps.all(sinceDay, token, sinceDay, token) : ps.all(sinceDay, sinceDay);
}

// How far back the daily rollup reaches. Published next to a long series so a 90-day range drawn
// from a rollup that began last Tuesday is not read as ninety days of history.
export const dailyCoverage = () => stmt.dailyCoverage.get();

// Where a daily series' history actually starts. Not simply the rollup's own earliest day: until the
// first prune runs, the rollup is empty while the minute table already holds days of data, and
// reporting `null` there would say "no record" next to a populated series. The answer is the earliest
// point either table can speak to, since getDailyHistory reads both.
export function dailyRecordBegan() {
  const rollup = stmt.dailyCoverage.get()?.a ?? null;
  const minutes = stmt.coverage.get()?.a ?? null;
  const days = [rollup, minutes].filter((v) => v != null);
  return days.length ? Math.floor(Math.min(...days) / 86400) * 86400 : null;
}

// One entry point for both series tables, so the two callers that serve /history cannot end up
// routing a range differently from one another.
export const getSeries = (token, since, groupSec, daily) =>
  (daily ? getDailyHistory(token, since) : getHistory(token, since, groupSec));

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

// Addresses whose activity *rate* exceeds the published per-day thresholds. `blockMs` converts each
// address's observed block span into days; the limits it was actually judged against come back on
// the row, so a flagged address can be audited without re-deriving the arithmetic.
export function noisyAddresses(txPerDay, volumePerDay, blockMs) {
  return stmt.noisy.all(Math.max(1, blockMs), txPerDay, volumePerDay).map((r) => ({
    address: r.address,
    transfers: r.transfers,
    volume: r.volume,
    firstBlock: r.first_block ?? null,
    lastBlock: r.last_block,
    // The address's own observation window, and the two limits derived from it.
    windowDays: r.days,
    maxTransfers: txPerDay * r.days,
    maxVolume: volumePerDay * r.days,
  }));
}
export const noisyAddressCount = (txPerDay, volumePerDay, blockMs) =>
  stmt.noisyCount.get(Math.max(1, blockMs), txPerDay, volumePerDay).c;

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
// Largest transfers over a time window, from the retained per-day set rather than from whatever
// happens to still be in `recent`. `sinceTs` defaults to the last 7 days so the figure means "the
// largest transfers of the week" — a claim the caller can state.
export const getLargest = (limit = 8, sinceTs = 0) => stmt.largest.all(sinceTs, limit);
export const activeSince = (block) => stmt.activeSince.get(block).c;
export const getCoverage = () => stmt.coverage.get();

// The span the raw transfer table actually covers, measured rather than assumed. Every surface that
// reads `recent` — the size distribution above all — is describing this window, so it has to be
// possible to say how long it is.
export function recentWindow() {
  const r = stmt.recentWindow.get();
  return {
    rows: r?.rows || 0,
    fromTs: r?.a ?? null,
    toTs: r?.b ?? null,
    spanSec: r?.a && r?.b ? r.b - r.a : 0,
    cap: RECENT_MAX,
    // True when the row cap, not the time window, is deciding how far back the table reaches —
    // i.e. throughput is high enough that 24h does not fit. Same reasoning as the noise-set cap:
    // whichever constraint is binding is the one a reader needs told.
    atCap: (r?.rows || 0) >= RECENT_MAX,
  };
}

// ---- API keys ----
const kstmt = {
  ins: db.prepare('INSERT INTO api_keys(key, label, tier, created) VALUES(?, ?, ?, ?)'),
  get: db.prepare('SELECT * FROM api_keys WHERE key = ?'),
  bump: db.prepare('UPDATE api_keys SET requests = requests + 1, last_used = ? WHERE key = ?'),
  day: db.prepare(`INSERT INTO key_daily (key, day, count) VALUES (?, ?, 1)
    ON CONFLICT(key, day) DO UPDATE SET count = count + 1`),
};
export function createKey(key, label, tier) { kstmt.ins.run(key, label || null, tier || 'free', Date.now()); return kstmt.get.get(key); }
export const getKey = (key) => kstmt.get.get(key);
export const bumpKey = (key) => {
  kstmt.bump.run(Date.now(), key);
  // Recorded here rather than at the call site so the lifetime total and the daily row can never
  // disagree about whether a request happened.
  try { kstmt.day.run(key, Math.floor(Date.now() / 86400000) * 86400); } catch { /* counting is not worth an error */ }
};

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
  stats: db.prepare('SELECT address, transfers, volume, last_block, first_block FROM addr_stats WHERE address = ?'),
  // A UNION of two indexed lookups, not `WHERE frm = ? OR too = ?`. The OR could not use either
  // index, so this was a full scan of the transfer table on every address lookup — invisible while
  // that table held 1,200 rows, and a scan of hundreds of thousands now that it holds a real window.
  // UNION rather than UNION ALL so a self-transfer (frm = too) is listed once.
  recent: db.prepare(`SELECT block, ts, token, frm, too, amount FROM (
      SELECT id, block, ts, token, frm, too, amount FROM recent WHERE frm = ?
      UNION
      SELECT id, block, ts, token, frm, too, amount FROM recent WHERE too = ?)
    ORDER BY id DESC LIMIT ?`),
  largest: db.prepare(`SELECT block, ts, token, frm, too, amount FROM (
      SELECT amount, block, ts, token, frm, too FROM top_transfers WHERE frm = ?
      UNION
      SELECT amount, block, ts, token, frm, too FROM top_transfers WHERE too = ?)
    ORDER BY amount DESC LIMIT ?`),
};
export function addressStats(a) { return adstmt.stats.get(a.toLowerCase()); }
export function addressRecent(a, limit = 20) { const x = a.toLowerCase(); return adstmt.recent.all(x, x, limit); }
// Largest transfers touching an address, over the retained per-day set. `recent` only reaches back
// as far as its window; the biggest thing an address ever did is the part worth keeping.
export const addressLargest = (a, limit = 8) => adstmt.largest.all(String(a).toLowerCase(), String(a).toLowerCase(), limit);

// Prefix search for the global search box. Bound as a parameter (not interpolated), and the caller
// validates the prefix is hex first, so the LIKE pattern can't carry a wildcard.
const searchStmt = db.prepare('SELECT address, transfers, volume FROM addr_stats WHERE address LIKE ? ORDER BY volume DESC LIMIT ?');
export const searchAddresses = (prefix, limit = 10) => searchStmt.all(prefix.toLowerCase() + '%', limit);

// ---- per-token detail (drill-down) ----
// One counting expression per published bracket, built once from SIZE_BRACKETS so the SQL and the
// documented brackets cannot drift apart. Counted in SQLite rather than by pulling every amount into
// JS: the old version read the whole transfer table into an array on every request, which was fine
// at 1,200 rows and is not at a real retention window.
const BRACKET_SQL = SIZE_BRACKETS
  .map((b, i) => `SUM(CASE WHEN amount >= ${b.min}${Number.isFinite(b.max) ? ` AND amount < ${b.max}` : ''} THEN 1 ELSE 0 END) AS b${i}`)
  .join(', ');

const tkstmt = {
  distAll: db.prepare(`SELECT COUNT(*) AS total, ${BRACKET_SQL} FROM recent`),
  distTok: db.prepare(`SELECT COUNT(*) AS total, ${BRACKET_SQL} FROM recent WHERE token = ?`),
  recent: db.prepare('SELECT token, frm, too, amount, block, ts FROM recent WHERE token = ? ORDER BY id DESC LIMIT ?'),
};

// Memoised per token. Six SUM(CASE) expressions over the whole transfer window is a full scan —
// measured at 50ms with the table at its 200k-row cap — and it runs on every token page load and every
// /v1/stablecoins/{token} call. A 24h histogram does not change meaningfully between two requests a
// few seconds apart, so a short TTL costs nothing in accuracy and turns a burst into one scan.
const distCache = new Map();
const DIST_TTL_MS = 20000;

// Transfer-size histogram over the retained transfer window. token='ALL' → all tokens. The window is
// returned alongside the counts, because a histogram over two minutes and a histogram over a day are
// different claims and the shape alone does not say which one this is.
export function sizeDistribution(token) {
  const ck = token || 'ALL';
  const hit = distCache.get(ck);
  if (hit && Date.now() - hit.at < DIST_TTL_MS) return hit.value;
  const value = computeSizeDistribution(token);
  distCache.set(ck, { at: Date.now(), value });
  return value;
}

function computeSizeDistribution(token) {
  const r = (token && token !== 'ALL') ? tkstmt.distTok.get(token) : tkstmt.distAll.get();
  return {
    total: r?.total || 0,
    brackets: SIZE_BRACKETS.map((b, i) => ({
      label: b.label, min: b.min, max: Number.isFinite(b.max) ? b.max : null, count: r?.[`b${i}`] || 0,
    })),
    window: recentWindow(),
  };
}
export const largestByToken = (token, limit = 8, sinceTs = 0) => stmt.largestTok.all(token, sinceTs, limit);
export const recentByToken = (token, limit = 12) => tkstmt.recent.all(token, limit);

// ---- derived address attributes (experimental — entities.js; drop this block to remove) ----
const emstmt = {
  up: db.prepare(`INSERT INTO address_meta(address, is_contract, code_hash, code_size, token_name,
      token_symbol, impl, admin, interfaces, kind, blocks_made, checked)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      is_contract = excluded.is_contract, code_hash = excluded.code_hash, code_size = excluded.code_size,
      -- COALESCE, not assignment: the entity deriver and the balance scanner both write here, and
      -- the deriver does not always read a name. Assigning would let a pass that learned nothing
      -- erase a name the other writer had already established — observed: the named-holder count
      -- dropped from 6 to 5 between two passes. A name is a fact; it does not become unknown again.
      -- A *new* non-null name still wins, so a renamed or upgraded contract updates normally.
      token_name = COALESCE(excluded.token_name, address_meta.token_name),
      token_symbol = COALESCE(excluded.token_symbol, address_meta.token_symbol), impl = excluded.impl,
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
  // Sum only. The dashboard polls /api/state every few seconds and wants one number; the row-by-row
  // version below was reading the whole table and sorting it by balance to do that.
  totalBalance: db.prepare('SELECT SUM(balance) AS t FROM tvl WHERE balance > 0'),
  // Contracts the entity deriver has already confirmed have bytecode. Balances are only ever
  // scanned for these plus the registry's own addresses — scanning every address seen would
  // multiply RPC cost by ~1000 for no gain, since a plain wallet's balance is not TVL.
  //
  // Ordered by what a contract is worth measuring — the balance we last read, then the volume it
  // moves — and not, as it was, by the hexadecimal value of its address. Past the cap that ordering
  // decided which contracts counted towards chain TVL by how their address happened to sort, which
  // is the same silent truncation the noise-set cap is published to avoid.
  contracts: db.prepare(`SELECT m.address FROM address_meta m
      LEFT JOIN addr_stats a ON a.address = m.address
      LEFT JOIN (SELECT address, SUM(balance) AS b FROM tvl GROUP BY address) t ON t.address = m.address
    WHERE m.is_contract = 1
    ORDER BY COALESCE(t.b, 0) DESC, COALESCE(a.volume, 0) DESC, m.address LIMIT ?`),
  contractCount: db.prepare('SELECT COUNT(*) AS c FROM address_meta WHERE is_contract = 1'),
  // The rotating half of the scan, ordered by address rather than by value.
  //
  // Ordering the rotation by balance would be self-defeating: the balances shift as we read them, so
  // the cursor would skip contracts and revisit others, and "everything gets covered eventually" would
  // stop being true. Address order is stable, which is the only property a cursor needs.
  contractsAfter: db.prepare(`SELECT m.address FROM address_meta m
    WHERE m.is_contract = 1 AND m.address > ?
    ORDER BY m.address LIMIT ?`),
  // How stale the oldest balance behind the published total is. With rotation some readings are a few
  // cycles old, and a figure mixing fresh and stale readings has to say so — the alternative is a
  // total that looks current and is partly hours behind.
  oldestReading: db.prepare('SELECT MIN(checked) AS t FROM tvl WHERE balance > 0'),
  // Records only whether an address has bytecode, and never overwrites an existing row — so the
  // TVL scanner can discover contracts on its own without clobbering anything entities.js derived.
  markCode: db.prepare(`INSERT INTO address_meta(address, is_contract, code_size, checked) VALUES(?, ?, ?, ?)
    ON CONFLICT(address) DO NOTHING`),
  unchecked: db.prepare(`SELECT a.address FROM addr_stats a LEFT JOIN address_meta m ON m.address = a.address
    WHERE m.address IS NULL ORDER BY a.volume DESC LIMIT ?`),
  // Writes only what a contract says its own name and symbol are, leaving every column entities.js
  // derives untouched. A narrow statement rather than upsertAddressMeta, which overwrites the lot:
  // the balance scanner learns a different, smaller fact than the entity deriver and must not clobber
  // the deriver's work by writing NULLs over it.
  // One unanswered attempt is not evidence of anything; a few in a row are. Marks the question
  // settled only once the attempt count reaches the ceiling, so a busy endpoint costs a retry rather
  // than a permanent wrong answer.
  noteIdentityAttempt: db.prepare(`INSERT INTO address_meta(address, is_contract, identity_attempts, checked)
      VALUES(?, 1, 1, ?)
    ON CONFLICT(address) DO UPDATE SET
      identity_attempts = address_meta.identity_attempts + 1,
      checked = excluded.checked,
      identity_checked = CASE WHEN address_meta.identity_attempts + 1 >= ? THEN ? ELSE address_meta.identity_checked END`),
  setIdentity: db.prepare(`INSERT INTO address_meta(address, is_contract, token_name, token_symbol, checked, identity_checked)
      VALUES(?, 1, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      token_name = COALESCE(excluded.token_name, address_meta.token_name),
      token_symbol = COALESCE(excluded.token_symbol, address_meta.token_symbol),
      checked = excluded.checked,
      identity_checked = excluded.identity_checked`),
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
export const totalBalance = () => tvstmt.totalBalance.get()?.t || 0;
export const balancesForAddress = (a) => tvstmt.forAddr.all(String(a).toLowerCase());
export const knownContracts = (limit = 2000) => tvstmt.contracts.all(limit).map((r) => r.address);
// How many contracts exist to scan, against how many the cap allows. Published for the same reason
// the noise-set cap is: past the ceiling, coverage is decided by the ceiling and not by the method.
export const knownContractCount = () => tvstmt.contractCount.get().c;

// The next slice of the rotation, in stable address order, wrapping at the end. Returns the slice and
// the cursor to store for next time, so the caller never has to reason about the wrap itself.
export function contractsAfter(cursor, limit) {
  const first = tvstmt.contractsAfter.all(cursor || '', limit).map((r) => r.address);
  if (first.length >= limit) return { addresses: first, next: first[first.length - 1] };
  // Ran off the end: wrap to the beginning and take the rest. A cycle is therefore complete when the
  // cursor comes back around, not when some counter says so.
  const rest = tvstmt.contractsAfter.all('', limit - first.length).map((r) => r.address);
  const all = [...new Set([...first, ...rest])];
  return { addresses: all, next: rest.length ? rest[rest.length - 1] : '' };
}

// When the oldest balance behind the published total was read, in ms. Null when nothing is held.
export const oldestBalanceReading = () => tvstmt.oldestReading.get()?.t ?? null;
// What a contract calls itself, read from the contract. Null when it answers neither name() nor
// symbol() — which is a fact about the contract, not a gap in the record.
export function setAddressIdentity(address, name, symbol) {
  // `identity_checked` is written whether or not anything came back, so "asked and answered nothing"
  // is recorded as an answer rather than retried forever.
  const now = Date.now();
  tvstmt.setIdentity.run(String(address).toLowerCase(), name || null, symbol || null, now, now);
}
// How many unanswered attempts settle the question. Three passes is a few minutes apart each, so a
// transient refusal costs a retry and a genuinely nameless contract stops being asked quickly.
export const IDENTITY_MAX_ATTEMPTS = 3;

// Records that we asked and heard nothing back. Only settles the question once the attempts reach
// the ceiling — see the migration note above for why one silence proves nothing.
export function noteIdentityAttempt(address) {
  const now = Date.now();
  tvstmt.noteIdentityAttempt.run(String(address).toLowerCase(), now, IDENTITY_MAX_ATTEMPTS, now);
}

// Identities for a set of addresses, in one query, for decorating a list.
export function addressIdentities(addrs) {
  const list = [...new Set((addrs || []).map((a) => String(a).toLowerCase()))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    const ps = db.prepare(`SELECT address, token_name, token_symbol, kind, code_size, identity_checked, identity_attempts FROM address_meta
      WHERE address IN (${part.map(() => '?').join(',')})`);
    for (const r of ps.all(...part)) out.set(r.address, r);
  }
  return out;
}
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

// How long the per-day rollup of the largest transfers is kept. Matches tvl_history: long enough to
// be a record, bounded so it cannot become the biggest table in the file.
const TOP_KEEP_DAYS = 180;

// ---- what the chain looked like last time (see chainwatch.js) ----
const wstmt = {
  all: db.prepare('SELECT id, kind, facts, first_seen, last_seen, last_check, misses FROM watch_subjects'),
  up: db.prepare(`INSERT INTO watch_subjects(id, kind, facts, first_seen, last_seen, last_check, misses)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      facts = excluded.facts, last_seen = excluded.last_seen,
      last_check = excluded.last_check, misses = excluded.misses`),
  del: db.prepare('DELETE FROM watch_subjects WHERE id = ?'),
};

// Returns the previous observation keyed by subject id, with facts already parsed.
export function watchSubjects() {
  const out = new Map();
  for (const r of wstmt.all.all()) {
    let facts = {};
    try { facts = JSON.parse(r.facts); } catch { /* a corrupt row is treated as unknown, not as a change */ }
    out.set(r.id, { id: r.id, kind: r.kind, facts, firstSeen: r.first_seen, lastSeen: r.last_seen, lastCheck: r.last_check, misses: r.misses });
  }
  return out;
}

// Writes the new observation. Called once per check, after the diff has been taken against it.
export function putWatchSubjects(rows) {
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      wstmt.up.run(r.id, r.kind, JSON.stringify(r.facts || {}), r.firstSeen, r.lastSeen, r.lastCheck, r.misses || 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export const dropWatchSubject = (id) => wstmt.del.run(id);

export function prune(nowSec, latestBlock, blockMs) {
  tvstmt.histPrune.run(nowSec - 180 * 86400);
  const weekBlocks = Math.round((7 * 86400 * 1000) / Math.max(200, blockMs));
  const cutoff = nowSec - 7 * 86400;

  // Roll up, then delete, in one transaction. Separately they are two statements that can be
  // interrupted between: a crash after the delete would lose the minutes for good, and a crash after
  // the rollup would double-count them on the next pass. Aggregates being additive is exactly what
  // makes the ordering load-bearing here.
  db.exec('BEGIN');
  try {
    stmt.rollupDaily.run(cutoff);
    stmt.pruneBuckets.run(cutoff);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  stmt.pruneAddrs.run(latestBlock - weekBlocks);
  stmt.pruneFees.run(cutoff);
  // The raw transfer window, by time. The row cap in applyBatch bounds it between prunes.
  stmt.trimRecentTs.run(nowSec - RECENT_WINDOW_SEC);
  stmt.trimTop.run(TOP_PER_DAY);
  stmt.pruneTop.run(nowSec - TOP_KEEP_DAYS * 86400);
}

// ---- usage counters (see usage.js) ----

const ustmt = {
  hit: db.prepare(`INSERT INTO hits (path, day, count) VALUES (?, ?, 1)
    ON CONFLICT(path, day) DO UPDATE SET count = count + 1`),
  byPath: db.prepare(`SELECT path, SUM(count) AS count FROM hits
    WHERE day >= ? GROUP BY path ORDER BY count DESC`),
  byDay: db.prepare(`SELECT day, SUM(count) AS count FROM hits
    WHERE day >= ? GROUP BY day ORDER BY day`),
  keyCount: db.prepare('SELECT COUNT(*) AS n FROM api_keys'),
  keysRecent: db.prepare(`SELECT key, label, tier, created, requests, last_used
    FROM api_keys ORDER BY created DESC LIMIT ?`),
  keysActive: db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE last_used >= ?'),
  keysSince: db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE created >= ?'),
};

// Counting must never be able to break a response that already succeeded, so this swallows its own
// errors. A lost count is a lost count; a 500 caused by bookkeeping would be a real outage.
export function recordHit(path, day) {
  try { ustmt.hit.run(path, day); } catch { /* counting is not worth an error */ }
}

// What a given day looked like, for the digest. Joined to api_keys so a key that called can be
// named by its label rather than by a prefix nobody chose.
const dstmt = {
  keysOnDay: db.prepare(`SELECT d.key, d.count, k.label, k.tier, k.created
    FROM key_daily d LEFT JOIN api_keys k ON k.key = d.key
    WHERE d.day = ? ORDER BY d.count DESC`),
  routesOnDay: db.prepare('SELECT path, count FROM hits WHERE day = ? ORDER BY count DESC'),
  keysCreatedOn: db.prepare('SELECT key, label, tier FROM api_keys WHERE created >= ? AND created < ?'),
};

export const keysOnDay = (day) => dstmt.keysOnDay.all(day);
export const routesOnDay = (day) => dstmt.routesOnDay.all(day);
export const keysCreatedOn = (fromMs, toMs) => dstmt.keysCreatedOn.all(fromMs, toMs);

export const hitsByPath = (sinceDay) => ustmt.byPath.all(sinceDay);
export const hitsByDay = (sinceDay) => ustmt.byDay.all(sinceDay);
export const keyTotal = () => ustmt.keyCount.get().n;
export const keysRecent = (n) => ustmt.keysRecent.all(n);
export const keysActiveSince = (ms) => ustmt.keysActive.get(ms).n;
export const keysCreatedSince = (ms) => ustmt.keysSince.get(ms).n;

// Close the database (WAL checkpoint) for a clean shutdown.
export const close = () => { try { db.close(); } catch { /* already closed */ } };
