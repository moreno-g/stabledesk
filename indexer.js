// Historical indexer: walks Arc testnet blocks, stores stablecoin Transfer
// aggregates in SQLite, and maintains the live snapshot served at /api/state.

import { rpc, net, hex, topicAddr, toUnits, TOKENS, TOKEN_ADDRS, TRANSFER_TOPIC, ZERO } from './rpc.js';
import * as db from './db.js';
import { getLabel } from './labels.js';

const TOTAL_SUPPLY = '0x18160ddd'; // ERC-20 totalSupply() selector
const SUPPLY_TTL = 30000;          // refresh supplies at most this often

let supplies = {};                 // symbol -> supply (number)
let suppliesAt = 0;
const codeCache = new Map();        // address -> isContract (bool)

// live alert feed (in-app "whale alerts") + webhook alert rules
export const alertFeed = [];
const FEED_MAX = 40;
const NOTABLE_MIN = 1000;           // min amount to surface in the feed
let alertRules = [];
let rulesAt = 0;

const POLL_MS = 7000;       // steady-state poll interval
const HEADER_WINDOW = 15;   // blocks for live TPS / block-time / activity strip
const MAX_BACKFILL = 3000;  // blocks of history to seed on first run (~25 min)
const CHUNK = 500;          // blocks per backfill request
const CHUNK_DELAY = 450;    // ms between backfill chunks (respect rate limit)
const PRUNE_EVERY = 120;    // prune roughly every N ticks

let avgBlockMs = 500;
let anchor = { block: 0, ts: 0 };          // (block -> timestamp) reference
let tickCount = 0;

export const live = { snapshot: { ok: false, booting: true } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const range = (a, b) => { const o = []; for (let n = a; n <= b; n++) o.push(n); return o; };
const approxTs = (block) => anchor.ts - (anchor.block - block) * (avgBlockMs / 1000);

function bumpAddr(map, a, amount, block) {
  let x = map.get(a);
  if (!x) { x = { transfers: 0, volume: 0, lastBlock: 0 }; map.set(a, x); }
  x.transfers += 1; x.volume += amount; x.lastBlock = Math.max(x.lastBlock, block);
}

function pushFeed(ev) {
  alertFeed.unshift(ev);
  if (alertFeed.length > FEED_MAX) alertFeed.length = FEED_MAX;
}

async function fireWebhook(rule, ev) {
  try {
    await fetch(rule.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'stabledesk', event: ev, rule: rule.id, at: Date.now() }),
      signal: AbortSignal.timeout(5000),
      redirect: 'error', // don't let a 3xx redirect bypass the SSRF allow-list (e.g. → 169.254.169.254)
    });
  } catch { /* user webhook down — ignore */ }
}

function checkRules(ev) {
  if (Date.now() - rulesAt > 15000) { alertRules = db.activeAlerts(); rulesAt = Date.now(); }
  for (const r of alertRules) {
    if (r.min_amount && ev.amount < r.min_amount) continue;
    if (r.token && r.token !== ev.token) continue;
    if (r.address && r.address !== ev.from && r.address !== ev.to) continue;
    if (Date.now() - r.last_fired < 60000) continue; // per-rule cooldown
    r.last_fired = Date.now();
    db.markFired(r.id);
    fireWebhook(r, ev);
  }
}

function processLogs(logs, opts = {}) {
  const buckets = new Map(), addrs = new Map(), recents = [];
  const txMax = new Map(); // txHash -> largest organic transfer { amount, symbol, minute }

  const getBk = (minute, symbol) => {
    const key = minute + '|' + symbol;
    let bk = buckets.get(key);
    if (!bk) { bk = { minute, token: symbol, volume: 0, cnt: 0, mint: 0, burn: 0, rvolume: 0, rcnt: 0 }; buckets.set(key, bk); }
    return bk;
  };

  for (const log of logs || []) {
    const meta = TOKENS[log.address.toLowerCase()];
    if (!meta) continue;
    let amount;
    try { amount = toUnits(log.data, meta.decimals); } catch { continue; }
    const block = parseInt(log.blockNumber, 16);
    const ts = Math.floor(approxTs(block));
    const minute = Math.floor(ts / 60) * 60;
    const from = topicAddr(log.topics[1]);
    const to = topicAddr(log.topics[2]);

    const bk = getBk(minute, meta.symbol);
    bk.cnt += 1; bk.volume += amount;

    if (from === ZERO) {
      bk.mint += amount;
      if (opts.live && amount >= NOTABLE_MIN) pushFeed({ ts, kind: 'mint', token: meta.symbol, amount, from, to, block });
    } else if (to === ZERO) {
      bk.burn += amount;
      if (opts.live && amount >= NOTABLE_MIN) pushFeed({ ts, kind: 'burn', token: meta.symbol, amount, from, to, block });
    } else {
      bumpAddr(addrs, from, amount, block);
      bumpAddr(addrs, to, amount, block);
      recents.push({ block, ts, token: meta.symbol, frm: from, too: to, amount });
      // "real" (noise-filtered) volume: keep only the largest transfer per tx
      const cur = txMax.get(log.transactionHash);
      if (!cur || amount > cur.amount) txMax.set(log.transactionHash, { amount, symbol: meta.symbol, minute });
      if (opts.live) {
        const ev = { ts, kind: 'transfer', token: meta.symbol, amount, from, to, block };
        if (amount >= NOTABLE_MIN) pushFeed(ev);
        checkRules(ev);
      }
    }
  }

  for (const m of txMax.values()) { const bk = getBk(m.minute, m.symbol); bk.rvolume += m.amount; bk.rcnt += 1; }

  db.applyBatch(buckets, addrs, recents);
  return (logs || []).length;
}

async function refreshSupplies() {
  const entries = Object.entries(TOKENS); // [addr, meta]
  const { out } = await rpc(entries.map(([addr]) => ({ method: 'eth_call', params: [{ to: addr, data: TOTAL_SUPPLY }, 'latest'] })));
  const s = {};
  entries.forEach(([, meta], i) => { try { s[meta.symbol] = Number(BigInt(out[i])) / 10 ** meta.decimals; } catch {} });
  if (Object.keys(s).length) { supplies = s; suppliesAt = Date.now(); }
}

async function detectContracts(addresses) {
  const unknown = addresses.filter((a) => !codeCache.has(a));
  if (!unknown.length) return;
  try {
    const { out } = await rpc(unknown.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    unknown.forEach((a, i) => codeCache.set(a, typeof out[i] === 'string' && out[i].length > 2));
  } catch { /* retry next tick */ }
  if (codeCache.size > 5000) for (const k of [...codeCache.keys()].slice(0, codeCache.size - 5000)) codeCache.delete(k);
}

async function getLogsRange(from, to) {
  const { out } = await rpc([{
    method: 'eth_getLogs',
    params: [{ fromBlock: hex(from), toBlock: hex(to), address: TOKEN_ADDRS, topics: [TRANSFER_TOPIC] }],
  }]);
  return out[0];
}

// Index a block range; advances checkpoint only on success.
async function indexRange(from, to, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      processLogs(await getLogsRange(from, to), opts);
      db.setCheckpoint(to);
      return true;
    } catch (e) {
      console.error(`[index] ${from}-${to} attempt ${attempt + 1}: ${e.message}`);
      await sleep(1500);
    }
  }
  return false;
}

async function indexThrough(from, to, opts = {}) {
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(to, start + CHUNK - 1);
    if (!(await indexRange(start, end, opts))) return false;
    if (end < to) await sleep(CHUNK_DELAY);
  }
  return true;
}

async function backfill(latest) {
  const cp = db.getCheckpoint();
  const start = cp != null ? cp + 1 : Math.max(0, latest - MAX_BACKFILL);
  if (start > latest) return;
  console.log(`[backfill] blocks ${start} → ${latest} (${latest - start + 1})`);
  if (!(await indexThrough(start, latest))) {
    console.error('[backfill] stopped — will resume from last successful checkpoint');
    return;
  }
  console.log('[backfill] done');
}

function buildSnapshot(latest, gasWei, headers) {
  const nowSec = Math.floor(Date.now() / 1000);
  const firstTs = parseInt(headers[0].timestamp, 16);
  const lastTs = parseInt(headers.at(-1).timestamp, 16);
  const windowSec = Math.max(1, lastTs - firstTs);
  const totalTx = headers.reduce((a, b) => a + b.transactions.length, 0);
  const tps = totalTx / windowSec;

  const summary = db.getSummary(nowSec - 86400);
  const cov = db.getCoverage();
  const covSec = cov.a ? Math.max(60, nowSec - cov.a) : 0;

  const totalSupply = Object.values(supplies).reduce((a, b) => a + b, 0);
  const supply = {};
  for (const meta of Object.values(TOKENS)) {
    const sym = meta.symbol;
    const sup = supplies[sym] || 0;
    const rvol = summary.byToken[sym]?.rvolume || 0;
    const perDay = covSec ? (rvol / covSec) * 86400 : 0;
    supply[sym] = {
      supply: sup,
      dominance: totalSupply ? sup / totalSupply : 0,
      volShare: summary.rvolume ? rvol / summary.rvolume : 0,
      velocity: sup ? perDay / sup : 0, // real transfers/day ÷ supply
      rvolume24h: rvol,
    };
  }

  const lbl = (a) => { const l = getLabel(a); return l ? l.name : null; };
  const top = db.getTop(8).map((r) => ({ ...r, label: lbl(r.address), contract: codeCache.get(r.address) || false }));
  const largest = db.getLargest(8).map((r) => ({ ...r, fromLabel: lbl(r.frm), toLabel: lbl(r.too) }));

  const indexedThrough = db.getCheckpoint();
  live.snapshot = {
    ok: true, booting: false, stale: false, updatedAt: Date.now(),
    endpoint: net.endpoint, chainId: 5042002,
    indexLag: indexedThrough != null ? Math.max(0, latest - indexedThrough) : null,
    network: {
      block: latest,
      blockTimeMs: (windowSec / (headers.length - 1)) * 1000,
      tps,
      gasGwei: Number(gasWei) / 1e9,
      costPerTransferUsdc: Number(gasWei * 21000n) / 1e18,
      txPerDay: tps * 86400,
    },
    liveBlocks: headers.map((b) => ({ n: parseInt(b.number, 16), tx: b.transactions.length })),
    activeAddresses1h: db.activeSince(latest - Math.round(3600000 / Math.max(200, avgBlockMs))),
    summary24h: summary,
    supply,
    totalSupply,
    suppliesAgeMs: suppliesAt ? Date.now() - suppliesAt : null,
    top,
    largest,
    coverage: {
      fromMinute: cov.a || null,
      toMinute: cov.b || null,
      minutes: cov.a ? Math.round((cov.b - cov.a) / 60) : 0,
    },
  };
}

async function tick() {
  try {
    const head = await rpc([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_gasPrice', params: [] },
    ]);
    const latest = parseInt(head.out[0], 16);
    const gasWei = BigInt(head.out[1]);

    const hFrom = latest - HEADER_WINDOW + 1;
    const headers = (await rpc(range(hFrom, latest).map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), false] }))))
      .out.filter(Boolean).sort((a, b) => parseInt(a.number, 16) - parseInt(b.number, 16));
    if (headers.length < 2) throw new Error('not enough block headers');

    // update the (block -> timestamp) anchor + average block time
    const f = parseInt(headers[0].timestamp, 16);
    const l = parseInt(headers.at(-1).timestamp, 16);
    avgBlockMs = Math.max(200, ((l - f) / (headers.length - 1)) * 1000);
    anchor = { block: parseInt(headers.at(-1).number, 16), ts: l };

    // index everything new since the checkpoint (chunked — never skip blocks)
    let cp = db.getCheckpoint();
    if (cp == null) cp = latest - 1;
    if (latest > cp && !(await indexThrough(cp + 1, latest, { live: true }))) {
      throw new Error(`catch-up stalled at block ${db.getCheckpoint() ?? cp}`);
    }

    if (Date.now() - suppliesAt > SUPPLY_TTL) { try { await refreshSupplies(); } catch (e) { console.error('[supply]', e.message); } }
    await detectContracts(db.getTop(12).map((r) => r.address));

    buildSnapshot(latest, gasWei, headers);

    if (++tickCount % PRUNE_EVERY === 0) db.prune(Math.floor(Date.now() / 1000), latest, avgBlockMs);
  } catch (e) {
    if (live.snapshot.ok) live.snapshot = { ...live.snapshot, stale: true, lastError: String(e.message || e) };
    console.error('[tick]', e.message || e);
  }
}

let timer = null;

export async function start() {
  // Anchor first so backfilled timestamps are sane, then seed history.
  try {
    const { out } = await rpc([{ method: 'eth_blockNumber', params: [] }]);
    const latest = parseInt(out[0], 16);
    const hb = (await rpc([{ method: 'eth_getBlockByNumber', params: [hex(latest), false] }])).out[0];
    anchor = { block: latest, ts: parseInt(hb.timestamp, 16) };
    await backfill(latest);
  } catch (e) {
    console.error('[start] backfill skipped:', e.message);
  }
  await tick();
  timer = setInterval(tick, POLL_MS);
}

// Stop the live poll loop (used for a clean shutdown).
export function stop() { if (timer) { clearInterval(timer); timer = null; } }
