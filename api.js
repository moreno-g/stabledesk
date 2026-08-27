// Public data API (/v1) — API keys, tiers, rate limiting. The monetization layer.

import { randomBytes } from 'node:crypto';
import { sendTelegram, configured as tgConfigured } from './telegram.js';
import { keyPrefix } from './usage.js';
import * as db from './db.js';
import { live, chainStatus, organicIssuance, indexProgress } from './indexer.js';
import * as tvl from './tvl.js';
import * as rankings from './rankings.js';
import * as chainuptime from './chainuptime.js';
import { search } from './search.js';
import { CATEGORIES } from './protocols.js';
import { csvResponse, PROTOCOL_COLUMNS, CANDIDATE_COLUMNS, TVL_HISTORY_COLUMNS } from './csv.js';
import { getLabel } from './labels.js';
import { RANGES, TIERS, clampLimit, alignToBucket, TOKEN_SYMBOLS, TOKEN_LIST, ADDR_RE, BILLING_ENABLED, BASE_CHAIN_ID, BASE_USDC, PAYMENT_RECEIVE_ADDRESS, PRO_PRICE_USD, ORDER_EXPIRY_MS } from './constants.js';
import { validateWebhookHost } from './validate.js';
import { CHAIN } from './chains.js';

// A key being minted is the one event on this API worth interrupting someone for: it means a
// stranger decided to build against it. Everything else is a number to look at later.
//
// Three deliberate constraints. The key itself is never sent — Telegram is a third party, and a
// credential that leaves this process is a credential that has left. Delivery is fire-and-forget,
// because a message that fails to send must not fail the key creation that prompted it. And the
// hourly ceiling exists because key minting is rate-limited per IP but not globally: without it,
// someone with a handful of addresses could turn this into a way to flood a phone.
const NOTIFY_MAX_PER_HOUR = 12;
let notifyWindow = 0;
let notifySent = 0;

export function notifyKeyCreated(rec, total) {
  if (!tgConfigured) return;
  const hour = Math.floor(Date.now() / 3600000);
  if (hour !== notifyWindow) { notifyWindow = hour; notifySent = 0; }
  if (notifySent >= NOTIFY_MAX_PER_HOUR) return;
  notifySent += 1;

  const label = rec.label ? `"${String(rec.label).slice(0, 60)}"` : '(no label)';
  const text = [
    'New API key',
    `  label: ${label}`,
    `  tier: ${rec.tier}`,
    `  prefix: ${keyPrefix(rec.key)}`,
    `  keys in total: ${total}`,
  ].join('\n');

  // Detached on purpose: the HTTP response must not wait on Telegram, and a Telegram outage must
  // not surface as an API error to someone who just successfully got a key.
  sendTelegram(text).catch((e) => console.error('[api] key notification failed:', e.message));
}

// fixed-window in-memory rate limiter, per key per minute
const rl = new Map();
function rateLimit(key, rpm) {
  const win = Math.floor(Date.now() / 60000);
  let e = rl.get(key);
  if (!e || e.win !== win) { e = { win, count: 0 }; rl.set(key, e); }
  e.count += 1;
  return { ok: e.count <= rpm, remaining: Math.max(0, rpm - e.count) };
}

// key minting — per IP, max 5/hour
const keyRl = new Map();
const KEY_LIMIT = 5;
function rateLimitKeys(ip) {
  const win = Math.floor(Date.now() / 3600000);
  let e = keyRl.get(ip);
  if (!e || e.win !== win) { e = { win, count: 0 }; keyRl.set(ip, e); }
  e.count += 1;
  return e.count <= KEY_LIMIT;
}

// Sweep expired windows so the limiter Maps don't grow unbounded over time.
setInterval(() => {
  const mWin = Math.floor(Date.now() / 60000);
  for (const [k, e] of rl) if (e.win < mWin) rl.delete(k);
  const hWin = Math.floor(Date.now() / 3600000);
  for (const [k, e] of keyRl) if (e.win < hWin) keyRl.delete(k);
}, 60000).unref();

// How many reverse proxies sit in front of this process, and therefore how many entries at the *end*
// of X-Forwarded-For we wrote ourselves. Railway and the Caddy setup in deploy/ both add exactly one.
export const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1));

// The client address, read from the end of the forwarding chain rather than the start.
//
// A proxy *appends* the address it received the connection from, so X-Forwarded-For reads
// `<whatever the client claimed>, <what our proxy actually saw>`. The leftmost entry is therefore an
// input, not a measurement. Taking it meant every per-IP limit here could be lifted by setting a
// header: the /api throttle, and more to the point `rateLimitKeys`, which is the only thing bounding
// free API key creation at 5/hour — with a fresh forged prefix per request that bound was zero.
//
// So we count entries from the right: our own hops are the tail, and the first entry *we* wrote is
// the last address anyone verified. With no trusted proxy in front (TRUSTED_PROXY_HOPS=0) the header
// is entirely client-controlled and is ignored outright in favour of the socket.
export function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  if (!TRUSTED_PROXY_HOPS) return socketIp;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd !== 'string' || !fwd) return socketIp;
  const chain = fwd.split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  // N hops means the last N entries are ours; the earliest of those is the observed client.
  return chain[Math.max(0, chain.length - TRUSTED_PROXY_HOPS)] ?? socketIp;
}

// CORS so third-party browser apps can call the API (custom X-API-Key header needs a preflight).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'x-api-key, content-type',
  'access-control-max-age': '86400',
};

function json(res, body, code = 200, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', ...CORS, ...headers });
  res.end(JSON.stringify(body));
}
export const BODY_MAX = 1e5;

// Resolves to the parsed body, or to a marker the caller turns into a 413.
//
// The oversize path used to call req.destroy() and wait for 'end', which destroy() guarantees will
// never fire — so the promise never settled, the handler never returned, and the request hung with no
// response until the client or Node's requestTimeout gave up. Now the stream is drained-and-stopped
// and the promise always settles: 'aborted' and 'error' are terminal states too, not just 'end'.
export function readBody(req) {
  return new Promise((resolve) => {
    let d = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      d += c;
      if (d.length > BODY_MAX) { req.pause(); finish({ __tooLarge: true }); }
    });
    req.on('end', () => { try { finish(JSON.parse(d || '{}')); } catch { finish({}); } });
    req.on('aborted', () => finish({}));
    req.on('error', () => finish({}));
  });
}

export async function handleV1(req, res, u) {
  const path = u.pathname;
  const method = req.method;

  // CORS preflight — answer before the auth check so browser clients work.
  if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // --- public (no key) ---
  if (path === '/v1/status') {
    return json(res, {
      ok: live.snapshot.ok,
      // A consumer polling this needs to know whether the figures are advancing, and if not,
      // whose fault that is — otherwise a halted chain looks like a broken API.
      degraded: !!live.snapshot.degraded,
      chain: chainStatus(),
      // How far the indexer is from the head, read live. `block` and `indexLag` below come from
      // the snapshot and freeze during a long catch-up, so this is the only field here that keeps
      // moving while history is being replayed — poll it twice to get a rate.
      index: indexProgress(),
      chainId: CHAIN.chainId,
      network: CHAIN.id,
      block: live.snapshot.network?.block ?? null,
      indexLag: live.snapshot.indexLag ?? null,
      updatedAt: live.snapshot.updatedAt ?? null,
      dataAt: live.snapshot.dataAt ?? null,
      // Every rolling window ends at the newest measured minute, which is chain time. This is how
      // far that sits behind the wall clock — near zero in normal operation, and the thing to look
      // at first if a 24h figure looks impossibly quiet.
      clockSkewSec: live.snapshot.clockSkewSec ?? null,
      windowEnd: live.snapshot.windowEnd ?? null,
      billingEnabled: BILLING_ENABLED,
    });
  }
  if (path === '/v1/keys' && method === 'POST') {
    const ip = clientIp(req);
    if (!rateLimitKeys(ip)) {
      return json(res, { error: 'key_limit_reached', hint: 'Max 5 free keys per hour per IP. Reuse an existing key.' }, 429, { 'retry-after': '3600' });
    }
    const body = await readBody(req);
    if (body.__tooLarge) return json(res, { error: 'body_too_large', hint: `Request body must be under ${BODY_MAX} bytes.` }, 413);
    const key = 'sbd_' + randomBytes(16).toString('hex');
    const rec = db.createKey(key, String(body.label || '').slice(0, 60), 'free');
    notifyKeyCreated({ ...rec, key }, db.keyTotal());
    return json(res, { key, tier: rec.tier, rpm: TIERS.free.rpm, docs: '/docs', note: 'Send this as the X-API-Key header on /v1 requests.' }, 201);
  }

  // --- authenticated ---
  const key = req.headers['x-api-key'] || u.searchParams.get('key');
  if (!key) return json(res, { error: 'missing_api_key', hint: 'Send an X-API-Key header. Get a free key with POST /v1/keys.' }, 401);
  const rec = db.getKey(key);
  if (!rec) return json(res, { error: 'invalid_api_key' }, 401);

  // A lapsed Pro subscription reverts to free right here, on next use — no cron needed.
  if (rec.tier === 'pro' && rec.expires_at && rec.expires_at < Date.now()) {
    db.downgradeKey(key);
    rec.tier = 'free'; rec.expires_at = null;
  }

  const tier = TIERS[rec.tier] || TIERS.free;
  const lim = rateLimit(key, tier.rpm);
  const H = { 'x-ratelimit-limit': String(tier.rpm), 'x-ratelimit-remaining': String(lim.remaining) };
  if (!lim.ok) return json(res, { error: 'rate_limited', tier: rec.tier, limit_per_min: tier.rpm }, 429, { ...H, 'retry-after': '60' });
  db.bumpKey(key);

  // Deliberately answered before the snapshot check below. The availability record is a fold over
  // SQLite that needs no live snapshot, and the moment a consumer most wants it is precisely the
  // moment the rest of this API is returning 503 — an endpoint that explains the outage must not
  // be taken down by the outage.
  if (path === '/v1/chain/uptime') {
    const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 30));
    return json(res, chainuptime.record({ days }), 200, H);
  }

  const s = live.snapshot;
  if (!s.ok) return json(res, { error: 'indexing', hint: 'Data warming up, retry shortly.' }, 503, H);

  if (path === '/v1/network') return json(res, { ...s.network, indexLag: s.indexLag ?? null, updatedAt: s.updatedAt }, 200, H);

  // Network fee economics. Gas on Arc is paid in USDC, so these are dollar figures straight
  // from the chain — no price feed involved.
  if (path === '/v1/network/fees') {
    if (!s.fees) return json(res, { error: 'no_fee_samples', hint: 'Fee sampling is still warming up, retry shortly.' }, 503, H);
    return json(res, {
      currency: 'USDC',
      perTransaction: s.fees.perTx,
      perBlock: s.fees.perBlock,
      perDay: s.fees.perDay,
      perMillionMoved: s.fees.perMillionMoved,
      inWindow: s.fees.inWindow,
      windowSec: s.fees.windowSec,
      avgGasPerTx: s.fees.avgGasPerTx,
      gasGwei: s.fees.gasGwei,
      sample: { blocks: s.fees.sampledBlocks, transactions: s.fees.sampledTxs, coverage: s.fees.sampleCoverage },
      note: 'Fees are exact for sampled blocks and extrapolated to the window; see /methodology.',
      updatedAt: s.updatedAt,
    }, 200, H);
  }

  // Addresses excluded from adjusted volume (the address-level noise filter).
  if (path === '/v1/addresses/filtered') {
    const n = s.noise || {};
    return json(res, {
      flagged: n.flagged ?? 0,
      // The set size limit, and what the thresholds would have selected without it. When
      // `atCap` is true the flag set is truncated by `cap` — so which addresses are flagged is
      // decided by the cap and a volume ordering, not by the thresholds below.
      qualifying: n.qualifying ?? null,
      cap: n.cap ?? null,
      atCap: !!n.atCap,
      thresholds: { transfersPerDay: n.txPerDay, volumePerDay: n.volumePerDay },
      // Each address is measured over its own observed span — first block seen to last — so there is
      // no single window to report here. `windowDays`, `maxTransfers` and `maxVolume` ride on each
      // address below: those are the limits it was actually judged against. `blockMs` is the only
      // input that turns a block span into days, so it is published rather than assumed.
      window: { perAddress: true, minDays: n.minWindowDays ?? 1, blockMs: n.blockMs ?? null },
      excludedVolume24h: n.excludedVolume24h ?? null,
      excludedShare: n.excludedShare ?? null,
      addresses: n.top || [],
      note: 'Addresses whose activity rate over their own observed span exceeds the thresholds are treated as infrastructure. A transfer is excluded from adjusted volume only when both of its ends are flagged; see /methodology.',
      ...(n.atCap ? {
        warning: `The flag set is truncated: ${n.qualifying} addresses meet the thresholds but only the top ${n.cap} by volume are flagged. Adjusted volume is therefore a lower bound on what the published rule would exclude, and the cap — not the thresholds — is the binding constraint. Raw and real volume are unaffected.`,
      } : {}),
      updatedAt: s.updatedAt,
    }, 200, H);
  }

  // `summary24h` is named for the window it asks for, not the one it got: it sums everything since
  // 24h ago, and on a young or freshly-restarted index that is however much history exists. A
  // consumer reading this endpoint had no way to tell 24 hours from 34 minutes, so the first thing
  // built against it labelled half an hour of testnet as a day. Coverage is published beside the
  // figures for the same reason the size distribution publishes its span: a window nobody states
  // is a window every reader assumes.
  if (path === '/v1/stablecoins') {
    return json(res, {
      supply: s.supply,
      totalSupply: s.totalSupply,
      // Supply grouped by the currency it is denominated in, and never summed across groups.
      // totalSupply above is the arithmetic sum of face values with no conversion; it is kept for
      // consumers already reading it, but byDenomination is the figure that means something.
      byDenomination: s.byDenomination || {},
      undeclaredSupply: s.undeclaredSupply ?? null,
      summary24h: s.summary24h,
      coverage: s.coverage,
      windowEnd: s.windowEnd,
      updatedAt: s.updatedAt,
    }, 200, H);
  }

  if (path === '/v1/stablecoins/history') {
    const token = (u.searchParams.get('token') || 'ALL').toUpperCase();
    const r = RANGES[u.searchParams.get('range')] || RANGES['24h'];
    // Same anchoring as the internal endpoint: while the chain is frozen the range ends at the
    // last indexed minute, and `windowEnd` states which instant that is so a consumer is never
    // left to assume the series runs up to the moment they called.
    const endSec = Math.floor((s.windowEnd || Date.now()) / 1000);
    // Aligned to the bucket grid, so every point returned is a complete interval inside the window.
    const since = r.span == null ? 0 : alignToBucket(endSec - r.span, r.group);
    return json(res, {
      token, group: r.group, windowEnd: endSec * 1000,
      // Ranges past 7d are answered from the per-day rollup rather than the minute table. Stated,
      // with the instant the range asked for and where the record actually starts, so a long range is
      // never mistaken for more history than exists: `recordBegan > since` means it is truncated.
      source: r.daily ? 'daily' : 'minute',
      since,
      recordBegan: r.daily ? db.dailyRecordBegan() : (db.getCoverage().a ?? null),
      series: db.getSeries(token, since, r.group, r.daily),
    }, 200, H);
  }

  // per-token detail: supply/velocity + 24h summary + net issuance + size distribution
  if (path.startsWith('/v1/stablecoins/')) {
    const token = path.slice('/v1/stablecoins/'.length).toUpperCase();
    if (!TOKEN_SYMBOLS.has(token)) return json(res, { error: 'bad_token', hint: `token must be one of: ${TOKEN_LIST}.` }, 400, H);
    const sm = s.summary24h?.byToken?.[token] || null;
    // Two issuance figures, deliberately both. `netIssuance24h` is every mint minus every burn —
    // unchanged, and what a consumer comparing us against a raw chain scan expects. `organic`
    // removes Circle Gateway's cross-chain rebalancing, which is the same unified balance moving
    // onto Arc rather than anyone deciding to hold more USDC here. Null, not zero, on a network
    // with no Gateway: there is nothing to subtract and no measurement to report.
    const bridged = s.bridge?.measured && sm;
    return json(res, {
      token, supply: s.supply?.[token] || null, summary24h: sm,
      netIssuance24h: sm ? sm.mint - sm.burn : null,
      bridgeMint24h: bridged ? sm.bmint : null,
      bridgeBurn24h: bridged ? sm.bburn : null,
      organicNetIssuance24h: organicIssuance(sm, !!s.bridge?.measured),
      distribution: db.sizeDistribution(token), updatedAt: s.updatedAt,
    }, 200, H);
  }

  // ---- ecosystem: registry + measured TVL ----
  // `?format=csv` is supported on the list endpoints so a spreadsheet can pull them directly.
  if (path === '/v1/protocols') {
    const snap = tvl.snapshot();
    if (u.searchParams.get('format') === 'csv') {
      return csvResponse(res, `arc-protocols-${CHAIN.id}.csv`, snap.protocols, PROTOCOL_COLUMNS, H);
    }
    return json(res, {
      protocols: snap.protocols, registry: snap.registry, categories: CATEGORIES,
      totals: snap.totals, method: snap.method, updatedAt: snap.lastRun?.at ?? null,
    }, 200, H);
  }

  if (path === '/v1/protocols/unnamed') {
    const snap = tvl.snapshot();
    if (u.searchParams.get('format') === 'csv') {
      return csvResponse(res, `arc-unnamed-contracts-${CHAIN.id}.csv`, snap.candidates, CANDIDATE_COLUMNS, H);
    }
    return json(res, {
      candidates: snap.candidates, unattributed: snap.totals.unattributed,
      note: 'Contracts holding stablecoin balances that no registry entry claims. Submit an identification: see /ecosystem.',
      updatedAt: snap.lastRun?.at ?? null,
    }, 200, H);
  }

  if (path.startsWith('/v1/protocols/')) {
    const id = path.slice('/v1/protocols/'.length).toLowerCase();
    const d = tvl.detail(id);
    if (!d) return json(res, { error: 'not_found', hint: 'See /v1/protocols for the list of ids.' }, 404, H);
    return json(res, d, 200, H);
  }

  if (path === '/v1/tvl/history') {
    const days = Math.min(180, Math.max(1, Number(u.searchParams.get('days')) || 30));
    const protocol = u.searchParams.get('protocol') || '*';
    const series = tvl.history(protocol, days);
    if (u.searchParams.get('format') === 'csv') {
      return csvResponse(res, `arc-tvl-${protocol === '*' ? 'total' : protocol}.csv`, series, TVL_HISTORY_COLUMNS, H);
    }
    return json(res, { protocol, days, series }, 200, H);
  }

  if (path === '/v1/tvl') {
    const snap = tvl.snapshot();
    return json(res, {
      ...snap.totals, method: snap.method, series: snap.series,
      // How many contracts were measured, out of how many are known. Past the cap this total covers
      // the highest-balance contracts and not the whole chain — which is a caveat on the headline
      // number, so it travels with it.
      coverage: snap.coverage,
      ...(snap.coverage?.atCap ? {
        warning: `Coverage is truncated: ${snap.coverage.knownContracts} contracts are known and the top ${snap.coverage.cap} by ${snap.coverage.order} were scanned. Chain TVL is therefore a lower bound.`,
      } : {}),
      protocols: snap.protocols.filter((p) => p.tvl > 0).map((p) => ({ id: p.id, name: p.name, tvl: p.tvl })),
      updatedAt: snap.lastRun?.at ?? null,
    }, 200, H);
  }

  if (path === '/v1/rankings') {
    const r = rankings.daily();
    return json(res, { ...r, digest: rankings.digest(r) }, 200, H);
  }

  if (path === '/v1/search') {
    const limit = clampLimit(u.searchParams.get('limit'), 25, 10);
    return json(res, search(u.searchParams.get('q'), limit), 200, H);
  }

  if (path === '/v1/addresses/top') {
    const limit = clampLimit(u.searchParams.get('limit'), 100, 20);
    return json(res, { top: db.getTop(limit).map((x) => ({ ...x, label: getLabel(x.address)?.name || null })) }, 200, H);
  }

  // Largest transfers over an explicit number of days, from the retained per-day set. This used to
  // read the rolling raw-transfer table, which at real throughput holds a couple of minutes — so
  // "largest transfers" meant "largest of the last two minutes" with nothing saying so.
  if (path === '/v1/transfers/largest') {
    const limit = clampLimit(u.searchParams.get('limit'), 100, 20);
    const days = Math.min(180, Math.max(1, Number(u.searchParams.get('days')) || 7));
    const endSec = Math.floor((s.windowEnd || Date.now()) / 1000);
    return json(res, {
      days,
      window: { from: (endSec - days * 86400) * 1000, to: endSec * 1000 },
      note: `The largest transfers of the last ${days} day(s), from the retained per-day set (top ${db.TOP_PER_DAY} per day per token).`,
      transfers: db.getLargest(limit, endSec - days * 86400),
    }, 200, H);
  }

  if (path.startsWith('/v1/address/')) {
    const addr = path.slice('/v1/address/'.length).toLowerCase();
    if (!ADDR_RE.test(addr)) return json(res, { error: 'bad_address' }, 400, H);
    const stats = db.addressStats(addr) || { address: addr, transfers: 0, volume: 0, last_block: 0 };
    return json(res, {
      ...stats,
      label: getLabel(addr)?.name || null,
      // `recent` only reaches as far back as the raw transfer window, which is bounded by row count
      // and therefore by throughput — so it is published with its span rather than left to be read as
      // "this address's history". `largest` comes from the retained per-day set and does not expire
      // with it, which is what makes an address lookup useful on a busy chain at all.
      transferWindow: s.transferWindow ?? null,
      recent: db.addressRecent(addr, 25),
      largest: db.addressLargest(addr, 10),
    }, 200, H);
  }

  // --- billing: pay in USDC on Base, no card, no account ---
  if (path === '/v1/billing/order' && method === 'POST') {
    if (!BILLING_ENABLED) return json(res, { error: 'billing_disabled', hint: 'Pro billing is not open yet — check back soon.' }, 403, H);
    if (rec.tier === 'pro') return json(res, { error: 'already_pro', expiresAt: rec.expires_at }, 409, H);
    const { id, amount } = db.createProOrder(key, PRO_PRICE_USD);
    return json(res, {
      id, amount: amount.toFixed(6), currency: 'USDC', chain: 'base', chainId: BASE_CHAIN_ID,
      tokenAddress: BASE_USDC.address, payTo: PAYMENT_RECEIVE_ADDRESS,
      expiresInMinutes: Math.round(ORDER_EXPIRY_MS / 60000),
      note: 'Send exactly this amount of USDC on Base to payTo. Your key upgrades to Pro automatically once the payment is detected (usually under a minute) — no confirmation step needed.',
    }, 201, H);
  }
  if (path === '/v1/billing/order' && method === 'GET') {
    const order = db.latestOrderByKey(key);
    return json(res, { order: order ? { id: order.id, amount: order.amount, status: order.status, created: order.created, paidAt: order.paid_at } : null, tier: rec.tier, expiresAt: rec.expires_at }, 200, H);
  }

  if (path === '/v1/alerts' && method === 'GET') return json(res, { tier: rec.tier, max: tier.maxAlerts, alerts: db.alertsByKey(key) }, 200, H);

  if (path.startsWith('/v1/alerts/') && method === 'DELETE') {
    const id = Number(path.slice('/v1/alerts/'.length));
    if (!Number.isInteger(id) || id < 1) return json(res, { error: 'bad_id' }, 400, H);
    if (!db.deleteAlert(id, key)) return json(res, { error: 'not_found' }, 404, H);
    return json(res, { deleted: id }, 200, H);
  }

  if (path === '/v1/alerts' && method === 'POST') {
    const body = await readBody(req);
    if (body.__tooLarge) return json(res, { error: 'body_too_large', hint: `Request body must be under ${BODY_MAX} bytes.` }, 413, H);
    if (db.alertCount(key) >= tier.maxAlerts) {
      return json(res, { error: 'alert_limit_reached', tier: rec.tier, max: tier.maxAlerts, upgrade: `Pro tier allows ${TIERS.pro.maxAlerts} alerts.` }, 402, H);
    }
    // Resolved, not just parsed: a hostname pointing at a private address is the whole SSRF case, and
    // the syntactic check alone never saw it.
    const whErr = await validateWebhookHost(body.webhook);
    if (whErr === 'invalid_url') return json(res, { error: 'webhook_required', hint: 'Provide a valid https webhook URL (Discord/Slack/Telegram).' }, 400, H);
    if (whErr === 'unresolvable_host') return json(res, { error: 'webhook_unresolvable', hint: 'The webhook hostname does not resolve. A rule pointing at it could never fire.' }, 400, H);
    if (whErr) return json(res, { error: 'webhook_blocked', hint: 'Webhook must be a public https URL — no localhost, private, or link-local address, including via DNS.' }, 400, H);

    const token = body.token ? String(body.token).toUpperCase() : null;
    if (token && !TOKEN_SYMBOLS.has(token)) return json(res, { error: 'bad_token', hint: `token must be one of: ${TOKEN_LIST}.` }, 400, H);

    const address = body.address ? String(body.address).toLowerCase() : null;
    if (address && !ADDR_RE.test(address)) return json(res, { error: 'bad_address' }, 400, H);

    const minAmount = body.minAmount != null ? Number(body.minAmount) : 0;
    if (Number.isNaN(minAmount) || minAmount < 0) return json(res, { error: 'bad_min_amount' }, 400, H);

    const id = db.createAlert({ key, address, token, minAmount, webhook: body.webhook });
    return json(res, { id, message: 'Alert created. Fires (max 1×/min) when a matching transfer is indexed.' }, 201, H);
  }

  return json(res, { error: 'not_found', see: '/docs' }, 404, H);
}
