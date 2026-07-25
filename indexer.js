// Historical indexer: walks Arc testnet blocks, stores stablecoin Transfer
// aggregates in SQLite, and maintains the live snapshot served at /api/state.

import { rpc, net, hex, topicAddr, toUnits, TOKENS, TOKEN_ADDRS, TRANSFER_TOPIC, ZERO } from './rpc.js';
import * as db from './db.js';
import { getLabel } from './labels.js';
import { NOISE_FILTER, FEE_SAMPLE } from './constants.js';

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

// High-frequency addresses excluded from "adjusted" volume. Recomputed from the retained
// window rather than tracked live, so the thresholds always describe a rate, not a total.
let noisyRows = [];
let noisy = new Set();
let noisyAt = 0;
const NOISY_TTL = 60000;

export const live = { snapshot: { ok: false, booting: true } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const range = (a, b) => { const o = []; for (let n = a; n <= b; n++) o.push(n); return o; };
const approxTs = (block) => anchor.ts - (anchor.block - block) * (avgBlockMs / 1000);

// Pure: scales the per-day noise thresholds to however much history is retained. The window
// is floored at a full day so a freshly-started indexer — which may only hold ~25 minutes of
// backfill — can't brand an ordinary address a bot off a handful of transfers.
export function noiseLimits(observedSec) {
  const days = Math.max(1, (Number(observedSec) || 0) / 86400);
  return { days, maxTransfers: NOISE_FILTER.txPerDay * days, maxVolume: NOISE_FILTER.volumePerDay * days };
}

// A transfer counts as noise only when *both* ends are flagged infrastructure — bot talking to
// bot. Visa / Allium drop a transfer if either end is flagged, which works on retail-shaped
// chains where most transfers are user-to-user. Arc is hub-and-spoke: nearly every transfer
// touches a faucet, router or sequencer, so "either end" deletes genuine payments along with
// the churn (it removed 99.9% of testnet volume). A bot paying a user, or a user funding an
// exchange, is real value delivered to a real party and is kept.
export const isNoiseTransfer = (t, flagged = noisy) => flagged.has(t.frm) && flagged.has(t.too);

let noisyLimits = noiseLimits(0);
function refreshNoisy() {
  const cov = db.getCoverage();
  noisyLimits = noiseLimits(cov.a && cov.b ? cov.b - cov.a : 0);
  noisyRows = db.noisyAddresses(noisyLimits.maxTransfers, noisyLimits.maxVolume);
  noisy = new Set(noisyRows.map((r) => r.address));
  noisyAt = Date.now();
}

// Pure: turns exact fees from sampled blocks into rates for the whole window. Every derived
// figure carries the sample size, so an extrapolation is never mistaken for a measured total.
//
// `volumeMoved` is deliberately *real* volume, not adjusted: the fee total in the numerator is
// every transaction's fee, including those paid by high-frequency addresses. Dividing all fees
// by only the non-bot volume would price the whole network's cost against a fraction of its
// throughput and wildly overstate it.
export function feeMetrics(sample, blocksInWindow, blocksPerDay, volumeMoved) {
  if (!sample?.blocks) return null;
  const perBlock = sample.fees / sample.blocks;
  const inWindow = perBlock * blocksInWindow;
  return {
    perBlock,
    perTx: sample.txs ? sample.fees / sample.txs : null,
    perDay: perBlock * blocksPerDay,
    inWindow,
    // The headline stablecoin metric: what it costs the network to move $1M of value.
    perMillionMoved: volumeMoved > 0 ? (inWindow / volumeMoved) * 1e6 : null,
    avgGasPerTx: sample.txs ? sample.gasUsed / sample.txs : null,
    sampledBlocks: sample.blocks,
    sampledTxs: sample.txs,
    sampleCoverage: blocksInWindow > 0 ? Math.min(1, sample.blocks / blocksInWindow) : null,
  };
}

// `from` is recorded only for the receiving side, and the DB keeps the first value it ever sees:
// the cheapest edge of the funding graph, used to tie an operational wallet back to its funder.
function bumpAddr(map, a, amount, block, from) {
  let x = map.get(a);
  if (!x) { x = { transfers: 0, volume: 0, lastBlock: 0, firstFrom: null }; map.set(a, x); }
  x.transfers += 1; x.volume += amount; x.lastBlock = Math.max(x.lastBlock, block);
  if (from && !x.firstFrom) x.firstFrom = from;
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

// The "real volume" filter, shared by the live indexer and the post-backfill adjustment pass:
// (txHash, token) -> largest organic transfer of that token in that transaction. Keyed per
// token, not per transaction — a swap moves two different assets in one tx, and collapsing it
// to a single leg would erase the smaller asset's volume entirely.
function largestPerTxToken(logs) {
  const out = new Map();
  for (const log of logs || []) {
    const meta = TOKENS[log.address.toLowerCase()];
    if (!meta) continue;
    let amount;
    try { amount = toUnits(log.data, meta.decimals); } catch { continue; }
    const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]);
    if (from === ZERO || to === ZERO) continue; // mints and burns aren't economic transfers
    const minute = Math.floor(approxTs(parseInt(log.blockNumber, 16)) / 60) * 60;
    const k = log.transactionHash + '|' + meta.symbol;
    const cur = out.get(k);
    if (!cur || amount > cur.amount) out.set(k, { amount, symbol: meta.symbol, minute, frm: from, too: to });
  }
  return out;
}

function processLogs(logs, opts = {}) {
  const buckets = new Map(), addrs = new Map(), recents = [];
  const txMax = largestPerTxToken(logs);

  const getBk = (minute, symbol) => {
    const key = minute + '|' + symbol;
    let bk = buckets.get(key);
    if (!bk) { bk = { minute, token: symbol, volume: 0, cnt: 0, mint: 0, burn: 0, rvolume: 0, rcnt: 0, avolume: 0, acnt: 0 }; buckets.set(key, bk); }
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
      bumpAddr(addrs, to, amount, block, from);
      recents.push({ block, ts, token: meta.symbol, frm: from, too: to, amount });
      if (opts.live) {
        const ev = { ts, kind: 'transfer', token: meta.symbol, amount, from, to, block };
        if (amount >= NOTABLE_MIN) pushFeed(ev);
        checkRules(ev);
      }
    }
  }

  for (const m of txMax.values()) {
    const bk = getBk(m.minute, m.symbol);
    bk.rvolume += m.amount; bk.rcnt += 1;
    // "adjusted" volume: real volume, minus transfers where *both* ends are infrastructure.
    if (!isNoiseTransfer(m)) { bk.avolume += m.amount; bk.acnt += 1; }
  }

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

// Pull exact fees for a few blocks from their receipts. Gas on Arc is USDC at the usual
// 18-decimal native scale, so gasUsed × effectiveGasPrice ÷ 1e18 is already a dollar figure —
// no price feed, no conversion. The sampled window sits behind the head and starts at a
// random offset so we don't always land on the same phase of block production.
async function sampleFees(latest) {
  const span = Math.max(1, FEE_SAMPLE.lookback - FEE_SAMPLE.blocksPerTick + 1);
  const first = latest - FEE_SAMPLE.lookback + Math.floor(Math.random() * span);
  const blocks = [];
  for (let i = 0; i < FEE_SAMPLE.blocksPerTick; i++) if (first + i <= latest && first + i >= 0) blocks.push(first + i);
  if (!blocks.length) return;

  const { out } = await rpc(blocks.map((n) => ({ method: 'eth_getBlockReceipts', params: [hex(n)] })));
  const rows = [];
  blocks.forEach((n, i) => {
    const receipts = out[i];
    if (!Array.isArray(receipts)) return; // block not available / empty response
    let fees = 0n, gas = 0n;
    for (const r of receipts) {
      try {
        const g = BigInt(r.gasUsed);
        gas += g;
        fees += g * BigInt(r.effectiveGasPrice ?? 0);
      } catch { /* malformed receipt — skip it rather than void the block */ }
    }
    rows.push({ block: n, minute: Math.floor(approxTs(n) / 60) * 60, fees: Number(fees) / 1e18, txs: receipts.length, gasUsed: Number(gas) });
  });
  db.insertFeeSamples(rows);
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

// On a cold start the high-frequency address set is empty while the backfill is indexed, so
// those blocks record adjusted volume identical to real volume — the filter simply had nobody
// to exclude yet. Once the first pass has revealed who the bots are, re-read the same range and
// overwrite (not accumulate) the adjusted columns, so the metric is honest from the first minute.
async function adjustBackfill(from, to) {
  refreshNoisy();
  if (!noisy.size) return;
  const buckets = new Map();
  for (let start = from; start <= to; start += CHUNK) {
    const end = Math.min(to, start + CHUNK - 1);
    let logs;
    try { logs = await getLogsRange(start, end); } catch (e) {
      console.error('[adjust] aborted:', e.message); // leave the first-pass values in place
      return;
    }
    for (const m of largestPerTxToken(logs).values()) {
      if (isNoiseTransfer(m)) continue;
      const key = m.minute + '|' + m.symbol;
      let bk = buckets.get(key);
      if (!bk) { bk = { minute: m.minute, token: m.symbol, avolume: 0, acnt: 0 }; buckets.set(key, bk); }
      bk.avolume += m.amount; bk.acnt += 1;
    }
    if (end < to) await sleep(CHUNK_DELAY);
  }
  // Zero the whole re-scanned span, not just the buckets that survived the filter.
  const changed = db.setAdjusted(buckets, Math.floor(approxTs(from) / 60) * 60, Math.floor(approxTs(to) / 60) * 60);
  console.log(`[adjust] backfill re-scored against ${noisy.size} flagged addresses (${changed} buckets)`);
}

async function backfill(latest) {
  const cp = db.getCheckpoint();
  const start = cp != null ? cp + 1 : Math.max(0, latest - MAX_BACKFILL);
  if (start > latest) return;
  const cold = cp == null;
  console.log(`[backfill] blocks ${start} → ${latest} (${latest - start + 1})`);
  if (!(await indexThrough(start, latest))) {
    console.error('[backfill] stopped — will resume from last successful checkpoint');
    return;
  }
  console.log('[backfill] done');
  if (cold) await adjustBackfill(start, latest);
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
      avolume24h: summary.byToken[sym]?.avolume || 0,
    };
  }

  const lbl = (a) => { const l = getLabel(a); return l ? l.name : null; };
  const top = db.getTop(8).map((r) => ({ ...r, label: lbl(r.address), contract: codeCache.get(r.address) || false }));
  const largest = db.getLargest(8).map((r) => ({ ...r, fromLabel: lbl(r.frm), toLabel: lbl(r.too) }));

  // Fee economics. Both the sampled fees and the volume they're divided by are measured over
  // the same effective window — the shorter of 24h and however much history we hold — so a
  // young index can't pair a full day of fees with an hour of volume.
  const feeWindowSec = Math.min(86400, covSec || 86400);
  const blockSec = Math.max(0.2, avgBlockMs / 1000);
  const fees = feeMetrics(
    db.feeStats(nowSec - feeWindowSec),
    feeWindowSec / blockSec,
    86400 / blockSec,
    summary.rvolume,
  );

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
    fees: fees ? { ...fees, windowSec: feeWindowSec, gasGwei: Number(gasWei) / 1e9 } : null,
    noise: {
      flagged: noisyRows.length,
      txPerDay: NOISE_FILTER.txPerDay,
      volumePerDay: NOISE_FILTER.volumePerDay,
      windowDays: noisyLimits.days,
      maxTransfers: noisyLimits.maxTransfers,
      maxVolume: noisyLimits.maxVolume,
      excludedVolume24h: Math.max(0, summary.rvolume - summary.avolume),
      excludedShare: summary.rvolume ? Math.max(0, 1 - summary.avolume / summary.rvolume) : 0,
      top: noisyRows.slice(0, 8).map((r) => ({
        ...r,
        label: lbl(r.address),
        // An address can breach both limits; name the one it breaches hardest, relatively.
        reason: r.volume / noisyLimits.maxVolume > r.transfers / noisyLimits.maxTransfers ? 'volume' : 'frequency',
      })),
    },
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

    // Refresh the high-frequency address set before indexing, so incoming transfers are
    // classified against current flags rather than a stale set.
    if (Date.now() - noisyAt > NOISY_TTL) refreshNoisy();

    // index everything new since the checkpoint (chunked — never skip blocks)
    let cp = db.getCheckpoint();
    if (cp == null) cp = latest - 1;
    if (latest > cp && !(await indexThrough(cp + 1, latest, { live: true }))) {
      throw new Error(`catch-up stalled at block ${db.getCheckpoint() ?? cp}`);
    }

    if (Date.now() - suppliesAt > SUPPLY_TTL) { try { await refreshSupplies(); } catch (e) { console.error('[supply]', e.message); } }
    await detectContracts(db.getTop(12).map((r) => r.address));
    try { await sampleFees(latest); } catch (e) { console.error('[fees]', e.message); } // best-effort: never fail a tick over a sample

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
    // Load the flag set from whatever history the volume already holds, so a restart against
    // an existing DB filters the backfill instead of re-learning the bots from scratch.
    refreshNoisy();
    await backfill(latest);
  } catch (e) {
    console.error('[start] backfill skipped:', e.message);
  }
  await tick();
  timer = setInterval(tick, POLL_MS);
}

// Stop the live poll loop (used for a clean shutdown).
export function stop() { if (timer) { clearInterval(timer); timer = null; } }
