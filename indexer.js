// Historical indexer: walks Arc testnet blocks, stores stablecoin Transfer
// aggregates in SQLite, and maintains the live snapshot served at /api/state.

import { rpc, net, hex, topicAddr, toUnits, TOKENS, TOKEN_ADDRS, TRANSFER_TOPIC, ZERO, GATEWAY_ADDRS, HAS_GATEWAY } from './rpc.js';
import * as db from './db.js';
import { getLabel } from './labels.js';
import { NOISE_FILTER, FEE_SAMPLE, CHAIN_HALT_MS, RPC_AUTH_STATUSES } from './constants.js';
import { CHAIN } from './chains.js';
import * as chainalert from './chainalert.js';
import { SEEN_KEY, UNOBSERVED } from './chainuptime.js';

const TOTAL_SUPPLY = '0x18160ddd'; // ERC-20 totalSupply() selector
const SUPPLY_TTL = 30000;          // refresh supplies at most this often

let supplies = {};                 // symbol -> supply (number)
let suppliesAt = 0;
const codeCache = new Map();        // address -> isContract (bool)

// live alert feed (in-app "whale alerts") + webhook alert rules
export const alertFeed = [];
const FEED_MAX = 40;
const NOTABLE_MIN = CHAIN.notableMin;  // min amount to surface in the feed (scales with the network)
let alertRules = [];
let rulesAt = 0;

const POLL_MS = 7000;       // steady-state poll interval
const HEADER_WINDOW = 15;   // blocks for live TPS / block-time / activity strip
const MAX_BACKFILL = CHAIN.maxBackfill; // blocks of history to seed on first run
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

// Chain liveness, tracked separately from indexer health. From a single failed poll the two are
// indistinguishable, and collapsing them makes an upstream outage read as our bug — the terminal
// says "offline" when the code is fine and the chain simply stopped producing blocks.
//   live         — the head is advancing
//   halted       — the RPC answers, but the head hasn't moved for CHAIN_HALT_MS
//   unauthorized — every endpoint answered and refused our credentials (ours to fix)
//   unreachable  — nobody answered at all
export const chain = { state: 'unknown', head: null, headAt: 0, lastOkAt: 0, lastError: null, downSince: 0 };

// Pure: the head-advancement rule on its own. A head that has not moved is only evidence of a
// halt once it has stood still longer than a block could plausibly take — below that threshold
// the honest reading is that the chain is fine and we polled between blocks.
export function chainStateFrom(prevHead, latest, sinceHeadMs, haltMs = CHAIN_HALT_MS) {
  if (prevHead == null || latest > prevHead) return 'live';
  return sinceHeadMs > haltMs ? 'halted' : 'live';
}

// The single place chain.state is allowed to change, so that every transition is announced exactly
// once. Assigning the field directly from two call sites is how the four-day outage stayed quiet:
// the state was right, nothing was listening to it changing.
function setChainState(next) {
  const prev = chain.state;
  if (prev === next) return next;
  chain.state = next;
  // When the outage began, so a recovery can report how long it lasted.
  if (next !== 'live') { if (!chain.downSince) chain.downSince = Date.now(); }

  const ctx = { ...chainStatus(), downMs: chain.downSince ? Date.now() - chain.downSince : null };
  if (next === 'live') chain.downSince = 0;

  // Written before anything is announced, and unconditionally — the record keeps transitions the
  // alert deliberately stays quiet about (a boot straight into a healthy chain is not worth paging
  // anyone, but it is exactly the row that opens an observed interval). Newsworthiness is a
  // property of the message, not of the history.
  try {
    db.recordChainEvent(Date.now(), next, chain.head, next === 'live' ? null : chain.lastError);
    markSeen(Date.now(), true);
  } catch (e) {
    console.error('[uptime] could not record transition:', e.message || e);
  }

  // Fire and forget, and swallow its failures: an unreachable Telegram must never be able to stop
  // the indexer. The alert is a report about the outage, not part of handling it.
  chainalert.note(prev, next, ctx).catch((e) => console.error('[chainalert]', e.message || e));
  return next;
}

// How often the "we were watching" watermark is written. One row update, so not free, and the
// resolution only has to be fine enough that an unclean shutdown forfeits a negligible slice of
// the record rather than an hour of it.
const SEEN_TTL = 30000;
let seenAt = 0;

// The watermark is what stops the last known state from being extrapolated forward forever. It
// records that we were *looking*, not that the chain was well — so it is written on the failure
// path too: an outage we sat and watched is measured downtime, and the most valuable rows in the
// record are precisely the ones written while things were broken.
function markSeen(now = Date.now(), force = false) {
  if (!force && now - seenAt < SEEN_TTL) return;
  seenAt = now;
  try { db.setMetaValue(SEEN_KEY, now); } catch (e) { console.error('[uptime]', e.message || e); }
}

// Close the previous session's segment before opening this one. Without this marker the gap
// between the last thing we saw and this boot reads as "the chain stayed in that state
// throughout" — leave the indexer off for a week and it publishes a week of Arc uptime it never
// witnessed. A gap has to be a fact in the record, not an absence that looks like continuity.
function openObservationWindow() {
  const last = db.lastChainEvent();
  if (!last) return;                      // nothing was ever observed: the record simply starts here
  if (last.state === UNOBSERVED) return;  // already closed — a crash between this marker and the first poll
  const through = Number(db.getMetaValue(SEEN_KEY)) || 0;
  // Never before the transition it closes: a stale watermark must not reorder the log.
  db.recordChainEvent(Math.max(through, last.at), UNOBSERVED, null, 'indexer not running');
}

function noteHead(latest) {
  const now = Date.now();
  chain.lastOkAt = now;
  chain.lastError = null;
  const advanced = chain.head == null || latest > chain.head;
  setChainState(chainStateFrom(chain.head, latest, now - chain.headAt));
  if (advanced) { chain.head = latest; chain.headAt = now; }
  return chain.state;
}

// Pure: which chain state a failed poll implies. An endpoint answering 401/403 is not an outage,
// it is us being refused — and calling that "the chain is unreachable" blames the chain for our
// own configuration, which is the same mistake as blaming ourselves for its outage, inverted.
// `allAuth` is set by the RPC layer once every endpoint has been tried; a bare status is only
// consulted when the error never went through it.
export function chainStateFromError(err) {
  if (err?.allAuth != null) return err.allAuth ? 'unauthorized' : 'unreachable';
  return RPC_AUTH_STATUSES.has(err?.status) ? 'unauthorized' : 'unreachable';
}

function noteRpcFailure(err) {
  // Recorded before the state change, so the alert built by setChainState can quote the error that
  // caused it rather than the previous one.
  chain.lastError = String(err?.message || err);
  setChainState(chainStateFromError(err));
}

// Where the indexer actually is, read from the checkpoint and the live head rather than from the
// snapshot. The snapshot is only rebuilt when a tick *completes*, so during a long catch-up — the
// one time anybody is asking — every figure derived from it is frozen at the last completed pass,
// and the reported lag is not merely stale but grows more wrong the more progress is made.
//
// The consequence, before this existed: replaying 830k blocks and hanging looked identical from
// outside. That is the single distinction a health endpoint exists to make, and it was the one
// thing /api/health could not tell you. `behind` shrinking between two polls is the progress
// signal; two samples also give a rate, which is why no ETA is invented here.
export function progressFrom(checkpoint, head, chunk = CHUNK) {
  const behind = checkpoint != null && head != null ? Math.max(0, head - checkpoint) : null;
  return {
    checkpoint: checkpoint ?? null,
    head: head ?? null,
    behind,
    // One live tick closes CHUNK blocks per request, so anything inside a single chunk is ordinary
    // lag. Past it the indexer is replaying history, which is a different thing to report.
    catchingUp: behind != null && behind > chunk,
  };
}

export const indexProgress = () => progressFrom(db.getCheckpoint(), chain.head);

// What the API and the pages report about the chain, with the "how long" the UI needs to say
// something specific ("no new block for 4 min") instead of a bare status word.
export function chainStatus() {
  return {
    state: chain.state,
    head: chain.head,
    // How long the head has been frozen. Null while live, so a caller can't render "stalled for
    // 0s" on a healthy chain.
    stalledMs: chain.state === 'live' || !chain.headAt ? null : Date.now() - chain.headAt,
    lastContactMs: chain.lastOkAt ? Date.now() - chain.lastOkAt : null,
    lastError: chain.lastError,
  };
}

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

// Pure: net issuance with Circle Gateway's cross-chain rebalancing taken out.
//
// Gateway mints are counted in `mint` *as well as* `bmint` — they are real mints, and a consumer
// scanning the chain themselves must be able to reconcile against us. Subtracting the Gateway net
// here is what separates "USDC was issued because someone wants to hold it on Arc" from "the same
// unified balance moved onto Arc". `measured` is false on a network with no Gateway, where the
// honest answer is null: nothing was measured, so nothing can be adjusted.
export function organicIssuance(sm, measured) {
  if (!measured || !sm) return null;
  return (sm.mint - sm.burn) - ((sm.bmint || 0) - (sm.bburn || 0));
}

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
    if (!cur || amount > cur.amount) out.set(k, { amount, symbol: meta.symbol, minute, frm: from, too: to, tx: log.transactionHash });
  }
  return out;
}

// Gateway attribution is by transaction, not by counterparty. The Transfer log of a Gateway mint
// names the end recipient, not the minter, so an address test would miss it entirely; what is
// always true is that the transaction also carries a log emitted by a Gateway contract. That set
// of transaction hashes is fetched alongside the transfers and passed through here.
function processLogs(logs, opts = {}, gatewayTxs = null) {
  const buckets = new Map(), addrs = new Map(), recents = [];
  const txMax = largestPerTxToken(logs);
  const viaGateway = (tx) => !!gatewayTxs && gatewayTxs.has(tx);

  const getBk = (minute, symbol) => {
    const key = minute + '|' + symbol;
    let bk = buckets.get(key);
    if (!bk) { bk = { minute, token: symbol, volume: 0, cnt: 0, mint: 0, burn: 0, rvolume: 0, rcnt: 0, avolume: 0, acnt: 0, bmint: 0, bburn: 0, bvolume: 0, bcnt: 0 }; buckets.set(key, bk); }
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

    const bridged = viaGateway(log.transactionHash);

    if (from === ZERO) {
      bk.mint += amount;
      if (bridged) bk.bmint += amount;
      if (opts.live && amount >= NOTABLE_MIN) pushFeed({ ts, kind: 'mint', token: meta.symbol, amount, from, to, block, bridged });
    } else if (to === ZERO) {
      bk.burn += amount;
      if (bridged) bk.bburn += amount;
      if (opts.live && amount >= NOTABLE_MIN) pushFeed({ ts, kind: 'burn', token: meta.symbol, amount, from, to, block, bridged });
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
    // The Gateway slice of real volume, tracked alongside rather than subtracted from it: a
    // deposit into Gateway is a genuine transfer, it just isn't someone paying someone.
    if (viaGateway(m.tx)) { bk.bvolume += m.amount; bk.bcnt += 1; }
  }

  db.applyBatch(buckets, addrs, recents);
  return (logs || []).length;
}

async function refreshSupplies() {
  const entries = Object.entries(TOKENS); // [addr, meta]
  const { out } = await rpc(entries.map(([addr]) => ({ method: 'eth_call', params: [{ to: addr, data: TOTAL_SUPPLY }, 'latest'] })));
  const s = {};
  entries.forEach(([, meta], i) => { try { s[meta.symbol] = Number(BigInt(out[i])) / 10 ** meta.decimals; } catch {} });
  if (Object.keys(s).length) {
    supplies = s;
    suppliesAt = Date.now();
    // Persisted so a restart while the chain is unreachable can still report supply — it is the
    // headline figure, and totalSupply moves slowly enough that yesterday's number is honest as
    // long as the page says how old it is.
    try { db.setMetaValue('supplies', JSON.stringify({ at: suppliesAt, s })); } catch { /* meta write is best-effort */ }
  }
}

// Restore the last measured supplies, keeping their original timestamp so `suppliesAgeMs`
// reports the true age rather than pretending they were just read.
function loadPersistedSupplies() {
  if (Object.keys(supplies).length) return;
  try {
    const raw = db.getMetaValue('supplies');
    if (!raw) return;
    const { at, s } = JSON.parse(raw);
    if (s && Object.keys(s).length) { supplies = s; suppliesAt = at || 0; }
  } catch { /* unreadable meta is not worth failing a boot over */ }
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

// Transfers, plus the Gateway logs for the same range. Both go out in one `rpc()` call, which the
// RPC layer sends as a single JSON-RPC batch — so identifying bridge flow costs one more entry in
// an array, not one more HTTP round trip against a rate-limited public endpoint. No topic filter
// on the Gateway side: any event it emits marks the transaction, and Gateway emits few enough
// that fetching them all is cheaper than knowing their signatures.
async function getLogsRange(from, to) {
  const calls = [{
    method: 'eth_getLogs',
    params: [{ fromBlock: hex(from), toBlock: hex(to), address: TOKEN_ADDRS, topics: [TRANSFER_TOPIC] }],
  }];
  if (HAS_GATEWAY) {
    calls.push({
      method: 'eth_getLogs',
      params: [{ fromBlock: hex(from), toBlock: hex(to), address: GATEWAY_ADDRS }],
    });
  }
  const { out } = await rpc(calls);
  // null, not an empty Set, when there is no Gateway on this network: downstream has to be able
  // to tell "no bridge flow in this range" from "we never looked".
  const gatewayTxs = HAS_GATEWAY ? new Set((out[1] || []).map((l) => l.transactionHash)) : null;
  return { logs: out[0], gatewayTxs };
}

// Index a block range; advances checkpoint only on success.
async function indexRange(from, to, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { logs, gatewayTxs } = await getLogsRange(from, to);
      processLogs(logs, opts, gatewayTxs);
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
    try { ({ logs } = await getLogsRange(start, end)); } catch (e) {
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

// Every part of the snapshot that comes from SQLite alone — no RPC, no live headers. Shared by
// the live path and the degraded path, so a frozen terminal reports exactly what a live one
// would rather than running a second, subtly different implementation that drifts from it.
function dbDerived({ frozen = false } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cov = db.getCoverage();
  // Which instant the rolling windows end at. Live, that is now. Frozen, it has to be the newest
  // indexed minute: the trailing 24h from *now* contains nothing once the chain has been down a
  // day, and publishing "24h volume: 0" would state the chain sat idle when what happened is that
  // it stopped. Anchoring to the last data point reports the last 24h that were actually measured,
  // and `windowEnd` tells the pages what to label it.
  const asOf = frozen && cov.b ? cov.b : nowSec;
  const summary = db.getSummary(asOf - 86400);
  const covSec = cov.a ? Math.max(60, asOf - cov.a) : 0;

  // Supply is read with `totalSupply()` calls, so it is unknown — not zero — whenever the chain
  // has never been reachable in this process and nothing was persisted from a previous one. Zero
  // is a measurement; null is the absence of one, and rendering "$0 total supply" would be the
  // most alarming wrong number on the page.
  const known = Object.keys(supplies).length > 0;
  const totalSupply = known ? Object.values(supplies).reduce((a, b) => a + b, 0) : null;
  const supply = {};
  for (const meta of Object.values(TOKENS)) {
    const sym = meta.symbol;
    const sup = known ? supplies[sym] ?? null : null;
    const rvol = summary.byToken[sym]?.rvolume || 0;
    const perDay = covSec ? (rvol / covSec) * 86400 : 0;
    supply[sym] = {
      supply: sup,
      dominance: totalSupply && sup != null ? sup / totalSupply : null,
      volShare: summary.rvolume ? rvol / summary.rvolume : 0,
      velocity: sup ? perDay / sup : null, // real transfers/day ÷ supply
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
    db.feeStats(asOf - feeWindowSec),
    feeWindowSec / blockSec,
    86400 / blockSec,
    summary.rvolume,
  );

  return {
    summary24h: summary,
    fees: fees ? { ...fees, windowSec: feeWindowSec } : null,
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
    // Circle Gateway keeps one USDC balance spendable across every chain it supports, so the USDC
    // it moves onto Arc is liquidity being repositioned rather than demand to hold it here.
    // `measured` is what separates "no bridge flow" from "this network has no Gateway" — without
    // it a reader would take an absent figure for a measured zero.
    bridge: {
      measured: HAS_GATEWAY,
      contracts: GATEWAY_ADDRS,
      mint24h: HAS_GATEWAY ? summary.bmint : null,
      burn24h: HAS_GATEWAY ? summary.bburn : null,
      netIssuance24h: HAS_GATEWAY ? summary.bmint - summary.bburn : null,
      volume24h: HAS_GATEWAY ? summary.bvolume : null,
      transfers24h: HAS_GATEWAY ? summary.btransfers : null,
      // What share of measured real volume is Gateway moving its own liquidity around.
      volumeShare: HAS_GATEWAY && summary.rvolume ? summary.bvolume / summary.rvolume : null,
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
    // When the newest indexed data was actually recorded, as opposed to when this object was
    // assembled. On a frozen chain the two are hours apart, and the pages need the former to
    // say how stale the figures are.
    dataAt: cov.b ? cov.b * 1000 : null,
    // The instant the 24h windows above end at — equal to now while live, and to `dataAt` once
    // frozen. Published so a caller can label the window instead of assuming it is trailing-now.
    windowEnd: asOf * 1000,
  };
}

function buildSnapshot(latest, gasWei, headers) {
  const firstTs = parseInt(headers[0].timestamp, 16);
  const lastTs = parseInt(headers.at(-1).timestamp, 16);
  const windowSec = Math.max(1, lastTs - firstTs);
  const totalTx = headers.reduce((a, b) => a + b.transactions.length, 0);
  const tps = totalTx / windowSec;

  const base = dbDerived({ frozen: chain.state !== 'live' });
  const indexedThrough = db.getCheckpoint();
  live.snapshot = {
    ...base,
    ok: true, booting: false, updatedAt: Date.now(),
    // A halted chain still answers every RPC call, so the poll "succeeds" and the headers are
    // real — but nothing is advancing. Reporting that as live would be the same lie as an empty
    // page, just quieter.
    stale: chain.state !== 'live', degraded: chain.state !== 'live',
    chain: chainStatus(),
    endpoint: net.endpoint, chainId: CHAIN.chainId, network: CHAIN.id,
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
    fees: base.fees ? { ...base.fees, gasGwei: Number(gasWei) / 1e9 } : null,
  };
}

// The degraded snapshot: everything SQLite can answer on its own, served when the chain is
// halted or unreachable. Publishing indexed history with an explicit "frozen at" beats an empty
// terminal — the numbers were true when they were measured, and the page says exactly when that
// was. `ok` stays true because the data *is* valid; `degraded` is what tells a caller it is not
// moving. Only a genuinely empty database is `booting`.
function snapshotFromDb() {
  loadPersistedSupplies();
  const base = dbDerived({ frozen: true });
  const indexedThrough = db.getCheckpoint();

  if (!base.coverage.minutes && !base.summary24h.transfers && indexedThrough == null) {
    live.snapshot = { ok: false, booting: true, chain: chainStatus() };
    return false;
  }

  live.snapshot = {
    ...base,
    ok: true, booting: false, stale: true, degraded: true,
    updatedAt: base.dataAt || Date.now(),
    chain: chainStatus(),
    endpoint: net.endpoint, chainId: CHAIN.chainId, network: CHAIN.id,
    indexLag: null,
    // No live headers to measure against, so the chain-plumbing figures are null rather than
    // carried over — a stale block time presented as current is a wrong number, not an old one.
    network: {
      block: indexedThrough ?? chain.head ?? null,
      blockTimeMs: null, tps: null, gasGwei: null, costPerTransferUsdc: null, txPerDay: null,
    },
    liveBlocks: [],
    activeAddresses1h: indexedThrough != null
      ? db.activeSince(indexedThrough - Math.round(3600000 / Math.max(200, avgBlockMs)))
      : null,
  };
  return true;
}

// Fall back to indexed history. Rebuilt from SQLite rather than freezing the last live
// snapshot in place: the live-only figures (block time, throughput, gas) have to become null
// instead of lingering as if they were just measured — an old number shown as current is a
// wrong number, not a stale one.
function degrade(err) {
  snapshotFromDb();
  if (live.snapshot.ok) live.snapshot.lastError = err;
}

// setInterval does not wait for an async callback — it fires again on schedule whether or not the
// previous call has returned. In steady state a tick closes a gap of a few blocks in well under
// POLL_MS, so this never showed. It shows when a tick has a *long* gap to close: the chain coming
// back after a multi-day outage with no restart in between, which is precisely the four-day 401
// this codebase now knows how to survive. That tick runs for twenty minutes while the timer keeps
// launching fresh ones on top of it, each reading the checkpoint anew and re-indexing ranges the
// others are still working through.
//
// Overlapping ranges are not harmless, because applyBatch is additive (`volume = volume +
// excluded.volume`): the same transfers are counted twice. Silent, and it inflates the headline
// number — the worst shape a bug can take in a product whose claim is that its figures are read
// off the chain.
export function nonReentrant(fn) {
  let running = false;
  return async (...args) => {
    // A skipped call is the normal state while catching up, so it is deliberately not logged:
    // hundreds of "skipped" lines would bury the backfill progress they are printed next to.
    if (running) return false;
    running = true;
    try { await fn(...args); return true; } finally { running = false; }
  };
}

async function tickOnce() {
  let latest, gasWei;
  // The head fetch is its own step so a failure here can be attributed to the chain, while a
  // failure below is ours. Reporting an upstream outage as an indexer fault is what made the
  // terminal claim it was broken when the code was fine.
  try {
    const head = await rpc([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_gasPrice', params: [] },
    ]);
    latest = parseInt(head.out[0], 16);
    gasWei = BigInt(head.out[1]);
    noteHead(latest);
    markSeen();
  } catch (e) {
    noteRpcFailure(e);
    // Watched, and therefore measured. Skipping this on the failure path would quietly convert
    // every outage into a hole in the record — the record would then only ever contain good news.
    markSeen();
    degrade(String(e.message || e));
    // Logged as whatever it was actually classified as — an operator grepping for the cause of a
    // frozen terminal should not be told "unreachable" when the endpoint is refusing our key.
    console.error(`[tick] chain ${chain.state}:`, e.message || e);
    return;
  }

  try {
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
    // The chain answered, so this one is on us — keep serving indexed history and say so.
    degrade(String(e.message || e));
    console.error('[tick]', e.message || e);
  }
}

// What the timer and start() actually call. Never invoke tickOnce directly — the guard is the
// only thing standing between a long catch-up and double-counted volume.
const tick = nonReentrant(tickOnce);

let timer = null;

export async function start() {
  // Serve whatever is already on disk before touching the network. A restart during a chain
  // outage used to leave `booting` set forever — every panel empty despite a database holding
  // days of indexed history — because the snapshot was only ever built by a successful poll.
  //
  // Loading the flag set here also means a restart against an existing DB filters the backfill
  // from known bots instead of re-learning them from scratch.
  // Before any poll can record a state, so the gap since the last session is closed in the right
  // order and this session's first transition lands after it rather than on top of it.
  openObservationWindow();

  loadPersistedSupplies();
  refreshNoisy();
  snapshotFromDb();

  // Anchor first so backfilled timestamps are sane, then seed history.
  try {
    const { out } = await rpc([{ method: 'eth_blockNumber', params: [] }]);
    const latest = parseInt(out[0], 16);
    const hb = (await rpc([{ method: 'eth_getBlockByNumber', params: [hex(latest), false] }])).out[0];
    anchor = { block: latest, ts: parseInt(hb.timestamp, 16) };
    noteHead(latest);
    await backfill(latest);
  } catch (e) {
    noteRpcFailure(e);
    console.error('[start] backfill skipped:', e.message);
  }
  await tick();
  timer = setInterval(tick, POLL_MS);
}

// Stop the live poll loop (used for a clean shutdown). The watermark is flushed on the way out so
// an orderly restart costs the record nothing, rather than the up-to-SEEN_TTL the crash path does.
export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  markSeen(Date.now(), true);
}
