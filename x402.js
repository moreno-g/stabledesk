// Pay per call (/x402) — the /v1 figures for an agent that has no key and no account, paid with
// x402 v2, scheme `exact`, in USDC on the network this deployment measures.
//
// An agent that finds Stabledesk cannot sign up for a key: minting one is a step a person takes.
// x402 lets it pay for one answer instead. The first request is answered 402 with a price in the
// PAYMENT-REQUIRED header; the agent signs a USDC authorization (EIP-3009) and repeats the request
// with PAYMENT-SIGNATURE; a facilitator puts that authorization on-chain and the answer comes back
// with PAYMENT-RESPONSE. Nothing here holds funds or signs anything: the buyer's signature moves USDC
// straight from the buyer to X402_PAY_TO, and the facilitator pays the gas.
//
// /x402/<route> mirrors /v1/<route> for every read-only GET route. /v1 itself is unchanged — free
// keys keep working, and no existing client meets a 402 it was not built for. The figures come from
// handleV1 in-process, as the MCP tools do, so a paid answer is exactly what /v1 serves.
//
// Charged only for a 200. The route is read before any payment is asked for, and an error (an unknown
// route, an index still warming up) is answered as it is, for free: nobody pays for a 404 or a 503.
//
// Order of operations, per the x402 v2 spec: check the payment against our own terms locally, POST
// /verify, POST /settle, then answer. Settling before answering means content leaves only once the
// money has moved; a settlement that fails is a 402, not a free answer.
//
// Each settlement serves one answer. The record of settled transactions (db.recordX402Payment) is
// what enforces it: a facilitator may answer a repeated settlement of the same authorization with the
// same transaction — Circle's does, on purpose, so that a buyer whose payment was still pending can
// retry without signing twice — and a transaction already recorded is refused rather than served again.

import { handleV1, clientIp, rateLimit } from './api.js';
import * as db from './db.js';
import { normalizePath } from './usage.js';
import { SITE_ORIGIN } from './constants.js';
import { CHAIN } from './chains.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

// How long the payment may take, end to end. Circle's facilitator also reads it as how long /settle
// may hold the request before answering "pending"; Arc is final in under a second, so 30 s is margin.
const MAX_TIMEOUT_SECONDS = 30;
// The settle request outlives the facilitator's own wait, so a slow settlement comes back as
// "pending" — which can be retried — rather than as a timeout here, which cannot be told apart from a
// failure.
const SETTLE_TIMEOUT_MS = (MAX_TIMEOUT_SECONDS + 10) * 1000;
// A pending settlement is asked again with the same authorization, which the facilitator answers
// idempotently. Never by asking the buyer to sign a new one: that could pay twice.
const SETTLE_ATTEMPTS = 3;

// Per client address, like /mcp. An unpaid request still reads the route (that is how a 404 stays
// free), so this is what bounds the work a caller can cause without paying.
export const X402_RPM = Math.max(1, Number(process.env.X402_RPM) || 120);

// "0.01" -> 10000n for an asset with 6 decimals. More precision than the asset has is refused rather
// than rounded: a price is money, and a silently rounded price is a different price.
export function toBaseUnits(price, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(price ?? '').trim());
  if (!m) return null;
  const frac = m[2] || '';
  if (frac.length > decimals) return null;
  const v = BigInt(m[1] + frac.padEnd(decimals, '0'));
  return v > 0n ? v : null;
}

export function fromBaseUnits(amount, decimals) {
  const s = BigInt(amount).toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return s.slice(0, -decimals) + (frac ? '.' + frac : '');
}

// The same rule as chains.js: all or nothing, and a half-configured payment rail refuses to start.
// Unset means off — the /x402 routes answer 404, as if the feature did not exist. Set but incomplete
// means a deploy that believes it is selling answers and is not, which is worth a failed boot.
//
// Network and asset are never configured here: they come from the network profile, so a testnet
// deployment can only ask for testnet USDC and a mainnet one only for mainnet USDC.
export const X402_VARS = ['X402_PAY_TO', 'X402_PRICE_USDC', 'X402_FACILITATOR_URL', 'X402_ASSET_NAME', 'X402_ASSET_VERSION'];

export function x402Config(env = process.env, chain = CHAIN) {
  const val = (k) => String(env[k] ?? '').trim();
  const set = X402_VARS.filter((k) => val(k));
  if (!set.length) return null;
  const missing = X402_VARS.filter((k) => !val(k));
  if (missing.length) {
    throw new Error(`x402 is partly configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. `
      + `Set all of ${X402_VARS.join(', ')} to sell answers, or none of them to leave /x402 off.`);
  }

  const payTo = val('X402_PAY_TO');
  if (!ADDR.test(payTo)) throw new Error(`X402_PAY_TO: "${payTo}" is not a 0x-prefixed address.`);

  const facilitator = val('X402_FACILITATOR_URL').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]/.test(facilitator)) throw new Error(`X402_FACILITATOR_URL: "${facilitator}" is not an https URL.`);

  const usdc = Object.entries(chain.tokens).filter(([, t]) => t.symbol === 'USDC');
  if (usdc.length !== 1) throw new Error(`x402: the ${chain.label} profile must track exactly one USDC contract to be paid in (found ${usdc.length}).`);
  const [asset, { decimals }] = usdc[0];

  const amount = toBaseUnits(val('X402_PRICE_USDC'), decimals);
  if (amount == null) throw new Error(`X402_PRICE_USDC: "${val('X402_PRICE_USDC')}" is not a positive amount with at most ${decimals} decimals.`);

  return {
    network: `eip155:${chain.chainId}`,
    asset,
    decimals,
    amount: amount.toString(),
    payTo,
    facilitator,
    // Sent whole as a bearer token. Circle's is the full "LIVE_API_KEY:<id>:<secret>" string.
    apiKey: val('X402_FACILITATOR_KEY') || null,
    // The token's EIP-712 domain. The buyer signs against it and the facilitator verifies against it,
    // so a wrong value fails every payment — loudly, at /verify, never by moving money wrongly. On Arc
    // it is "USDC" / "2", read from the contract; "USD Coin" is Base's and Polygon's.
    name: val('X402_ASSET_NAME'),
    version: val('X402_ASSET_VERSION'),
  };
}

export const CONFIG = x402Config();

// What one call costs, in the shape the x402 v2 spec calls PaymentRequirements.
export const requirements = (cfg) => ({
  scheme: 'exact',
  network: cfg.network,
  amount: cfg.amount,
  asset: cfg.asset,
  payTo: cfg.payTo,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  extra: { name: cfg.name, version: cfg.version, assetTransferMethod: 'eip3009' },
});

export const paymentRequired = (cfg, url, error) => ({
  x402Version: 2,
  error,
  resource: {
    url,
    description: `Stabledesk, ${CHAIN.label}: measured stablecoin figures, one answer per payment. Method: ${SITE_ORIGIN}/methodology`,
    mimeType: 'application/json',
    serviceName: 'Stabledesk',
    tags: ['stablecoins', 'analytics', 'arc'],
  },
  accepts: [requirements(cfg)],
});

// Standard base64 with padding, as the spec and its reference client expect. Node's decoder also reads
// the URL-safe alphabet, so a client that picks the other one is still understood.
export const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

export function decode(header) {
  if (typeof header !== 'string' || !header || header.length > 16384) return null;
  try {
    const v = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Our own terms, checked before anything is sent to the facilitator. The facilitator verifies the
// signature and the balance; it cannot know what we charge, so a payload signed for a smaller amount
// or a different recipient is ours to refuse. Returns a reason, or null.
export function checkPayment(p, req, nowSec = Math.floor(Date.now() / 1000)) {
  if (!p) return 'invalid_payload';
  if (p.x402Version !== 2) return 'invalid_x402_version';
  const a = p.accepted;
  if (!a || a.scheme !== req.scheme || a.network !== req.network) return 'unsupported_scheme';
  if (!same(a.asset, req.asset) || !same(a.payTo, req.payTo) || String(a.amount) !== req.amount) return 'payment_terms_mismatch';
  const au = p.payload?.authorization;
  if (!au || typeof p.payload.signature !== 'string') return 'invalid_payload';
  if (!same(au.to, req.payTo)) return 'invalid_exact_evm_payload_recipient_mismatch';
  let value;
  try { value = BigInt(au.value); } catch { return 'invalid_payload'; }
  if (value !== BigInt(req.amount)) return 'invalid_exact_evm_payload_authorization_value_mismatch';
  const before = Number(au.validBefore), after = Number(au.validAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'invalid_payload';
  // A few seconds of headroom: an authorization that expires while it is being settled is a failed
  // settlement after the work is done, and better refused now.
  if (before <= nowSec + 6) return 'invalid_exact_evm_payload_authorization_valid_before';
  if (after > nowSec) return 'invalid_exact_evm_payload_authorization_valid_after';
  return null;
}

// The reason a facilitator gives, whichever shape it answered in: a VerifyResponse, a SettleResponse,
// or Circle's error body for a request it rejected before settling ({ code, message, errors }).
const reasonOf = (b) => b?.invalidReason || b?.errorReason || b?.errors?.[0]?.reason || b?.code || null;

// Failures that are the operator's to fix — a missing or refused key, an exhausted trial, a facilitator
// that is down or throttling — and therefore never the buyer's: answered 502 and logged, not 402.
const operatorSide = (status, reason) => status === 401 || status === 415 || status === 429 || status >= 500
  || reason === 'registration_required' || reason === 'credential_bound_elsewhere';

async function callFacilitator(cfg, op, body, fetchImpl) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const r = await fetchImpl(`${cfg.facilitator}/${op}`, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(op === 'settle' ? SETTLE_TIMEOUT_MS : 10000),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  if (!j || typeof j !== 'object') throw new Error(`facilitator /${op} answered HTTP ${r.status} without a JSON body`);
  return { status: r.status, body: j };
}

const pending = (s) => s.status === 200 && s.body.success !== true && s.body.errorReason === 'settlement_pending';

async function settle(cfg, body, fetchImpl, retryMs) {
  let s = await callFacilitator(cfg, 'settle', body, fetchImpl);
  for (let i = 1; i < SETTLE_ATTEMPTS && pending(s); i++) {
    await new Promise((r) => setTimeout(r, retryMs));
    s = await callFacilitator(cfg, 'settle', body, fetchImpl);
  }
  return s;
}

// The /v1 route, read in-process. Unlike mcp.js's readV1 this keeps the body as text and its
// content type, so a CSV export is sold as a CSV.
async function readRoute(path, params) {
  const u = new URL(path, 'http://internal');
  for (const [k, v] of params) u.searchParams.append(k, v);
  let code = 0, headers = {}, text = '';
  const res = { writeHead(c, h = {}) { code = c; headers = h; return res; }, end(s = '') { text = String(s); } };
  await handleV1({ method: 'GET', headers: {}, socket: {} }, res, u, { internal: true });
  return { code, headers, text };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'payment-signature, content-type',
  'access-control-expose-headers': 'payment-required, payment-response',
  'access-control-max-age': '86400',
};
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

function send(res, status, body, headers = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { ...SEC, ...CORS, 'content-type': 'application/json', ...headers });
  res.end(s);
}

// The header is what an x402 v2 client reads; the same object in the body is for a person, or an
// agent, reading the response without knowing the protocol. After a failed settlement the spec adds
// that SettleResponse as PAYMENT-RESPONSE, so the buyer can see what happened to its authorization.
function send402(res, cfg, url, error, { hint = null, settlement = null } = {}) {
  const pr = paymentRequired(cfg, url, error);
  return send(res, 402, hint ? { ...pr, hint } : pr, {
    'payment-required': encode(pr),
    ...(settlement ? { 'payment-response': encode(settlement) } : {}),
  });
}

const unavailable = (res, op, why) => {
  console.error(`[x402] ${op}: ${why}`);
  return send(res, 502, { error: 'facilitator_unavailable', hint: 'The payment could not be processed on our side. Nothing was served; retry shortly with the same PAYMENT-SIGNATURE.' });
};

// Every route sold, read from the OpenAPI spec so the list cannot drift from what /v1 serves.
async function catalogue(cfg) {
  const { spec } = await import('./openapi.js');
  const routes = Object.entries(spec().paths)
    .filter(([p, ops]) => ops.get && !/^\/v1\/(keys|billing|alerts)(\/|$)/.test(p))
    .map(([p, ops]) => ({ path: p.replace(/^\/v1/, '/x402'), summary: ops.get.summary ?? null }));
  return {
    x402Version: 2,
    network: cfg.network,
    asset: cfg.asset,
    price: fromBaseUnits(cfg.amount, cfg.decimals),
    currency: 'USDC',
    payTo: cfg.payTo,
    routes,
    note: 'Each route answers exactly what the same path under /v1 answers. A request without payment is answered 402 with the terms in the PAYMENT-REQUIRED header. Only a 200 is charged. Free alternative: a key from POST /v1/keys.',
    docs: `${SITE_ORIGIN}/docs`,
    method: `${SITE_ORIGIN}/methodology`,
  };
}

export async function handleX402(req, res, u, { config = CONFIG, fetchImpl = fetch, retryMs = 1000 } = {}) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!config) return send(res, 404, { error: 'not_found', see: '/docs' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed', hint: 'Paid routes are read-only: GET.' }, { allow: 'GET, OPTIONS' });

  const lim = rateLimit(`x402:${clientIp(req)}`, X402_RPM);
  if (!lim.ok) return send(res, 429, { error: 'rate_limited', limit_per_min: X402_RPM }, { 'retry-after': '60' });

  if (u.pathname === '/x402' || u.pathname === '/x402/') return send(res, 200, await catalogue(config));

  const v1Path = '/v1' + u.pathname.slice('/x402'.length);
  const out = await readRoute(v1Path, u.searchParams);
  // Free, as it is: the caller learns the route is wrong or the index is warming up without paying.
  if (out.code !== 200) {
    let err;
    try { err = JSON.parse(out.text || '{}'); } catch { err = { error: 'unavailable' }; }
    return send(res, out.code || 500, err);
  }

  const url = `${SITE_ORIGIN}${u.pathname}${u.search}`;
  const header = req.headers['payment-signature'];
  if (!header) return send402(res, config, url, 'PAYMENT-SIGNATURE header is required');

  const payload = decode(header);
  const terms = requirements(config);
  const problem = checkPayment(payload, terms);
  if (problem) return send402(res, config, url, problem);

  const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: terms };

  let v;
  try { v = await callFacilitator(config, 'verify', body, fetchImpl); } catch (e) { return unavailable(res, 'verify', e.message); }
  const vReason = reasonOf(v.body);
  if (operatorSide(v.status, vReason)) return unavailable(res, 'verify', `HTTP ${v.status} ${vReason ?? ''}`);
  // An authorization whose nonce is already spent is either a replay or a buyer retrying after a
  // settlement that was still pending. Settling it again tells them apart: the facilitator returns the
  // original transaction, and the record below serves that transaction once, never twice.
  const spent = vReason === 'invalid_transaction_state';
  if (!(v.status === 200 && v.body.isValid === true) && !spent) return send402(res, config, url, vReason || 'invalid_payment');

  let s;
  try { s = await settle(config, body, fetchImpl, retryMs); } catch (e) {
    // A settlement can land on-chain after the request to settle it timed out. The answer is still
    // withheld, and the same authorization can be retried: it settles once, and is served once.
    return unavailable(res, 'settle', e.message);
  }
  const sReason = reasonOf(s.body);
  if (operatorSide(s.status, sReason)) return unavailable(res, 'settle', `HTTP ${s.status} ${sReason ?? ''}`);
  const settlement = 'success' in s.body ? s.body : null;
  if (pending(s)) {
    return send402(res, config, url, 'settlement_pending', {
      settlement,
      hint: 'The payment is still settling. Retry with the same PAYMENT-SIGNATURE; do not sign a new authorization.',
    });
  }
  if (!(s.status === 200 && s.body.success === true && s.body.transaction)) {
    return send402(res, config, url, sReason || 'settlement_failed', { settlement });
  }

  // Bookkeeping must not deny an answer that was paid for, so a failed write is logged and the answer
  // served. A transaction already on record is the other case: that answer has been served.
  let fresh = true;
  try {
    fresh = db.recordX402Payment({
      tx: s.body.transaction, network: s.body.network || config.network,
      payer: s.body.payer || v.body.payer || payload.payload.authorization.from,
      amount: config.amount, route: normalizePath(v1Path) || '/v1',
    });
  } catch (e) { console.error('[x402] recording a settlement failed:', e.message); }
  if (!fresh) return send402(res, config, url, 'payment_already_used', { hint: 'This payment has already been answered. Sign a new authorization for a new answer.' });

  const passed = {};
  for (const h of ['content-type', 'content-disposition']) if (out.headers[h]) passed[h] = out.headers[h];
  res.writeHead(200, { ...SEC, ...CORS, ...passed, 'payment-response': encode(s.body) });
  return res.end(out.text);
}
