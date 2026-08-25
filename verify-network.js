// Checks the active network profile against the chain it claims to describe.
//
//   node verify-network.js                 # human-readable report; exit 1 if anything FAILs
//   ARC_NETWORK=mainnet node verify-network.js
//   node verify-network.js --json          # machine-readable, for a deploy gate
//   node verify-network.js --blocks 4000   # widen the discovery sample
//
// Why this exists. chains.js is the single switch between networks, and everything downstream trusts
// it completely: token addresses, decimals, symbols, the Gateway pair, the registry. Nothing verifies
// that any of it is still true. On 22 August 2026 a manual check found that it was not — the tracked
// USYC contract had gone dormant while a second deployment carried all the activity, and USDT had
// been trading on the chain for weeks with 18 decimals while we did not track it at all. Both were
// found by hand. Neither would have been noticed by any test, because no test talks to the chain.
//
// That is a tolerable failure on a testnet full of faucet money. On mainnet it is the failure this
// codebase is otherwise built to refuse: numbers that look plausible and are wrong. A decimals field
// off by twelve overstates a figure by a factor of a trillion, and nothing anywhere would complain.
//
// So: run it before a deploy, run it on launch day, run it on a schedule. It writes nothing, reads
// nothing but the chain, and fails loudly.

// Loaded on demand, not statically. chains.js throws by design when a mainnet variable is missing —
// refusing to boot rather than quietly serving testnet figures under a mainnet banner — and that
// message is the most useful thing this script can print on launch day. A static import throws before
// any of our code runs, so it arrives as a raw stack trace with the explanation buried in it.
// Deferring also lets the tests import the classification helpers below without touching a profile.
let CHAIN; let NETWORK; let PROTOCOLS;
async function loadProfile() {
  try {
    ({ CHAIN, NETWORK } = await import('./chains.js'));
    ({ PROTOCOLS } = await import('./protocols.js'));
  } catch (e) {
    console.error('\nThe network profile refused to load:\n');
    console.error('  ' + String(e.message || e).split('. ').join('.\n  '));
    console.error('\nNothing was verified. This is the same refusal the server makes at boot.');
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const SAMPLE_BLOCKS = flag('--blocks', 1500);
// --watch compares this run against the last one and reports the difference. It is the only mode that
// writes anything: a plain run stays strictly read-only, which is what makes it safe to point at a
// production deployment. --every turns it into a loop for a host that has no scheduler.
const WATCH = args.includes('--watch');
const EVERY = flag('--every', 0);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd' };
const BALANCE_OF = '0x70a08231';

// The same set constants.js publishes, restated here rather than imported: constants.js pulls in
// chains.js at load, and the whole point of loadProfile() is that this file can be imported without
// a network profile. Three literals are a cheaper price than that coupling.
const RPC_AUTH_STATUSES = new Set([401, 403, 407]);

// How many Transfer events an unknown contract needs in the sample before it is worth reporting.
// Below this it is noise: a test deployment nobody uses is not a gap in our coverage.
const DISCOVERY_MIN_EVENTS = 20;

// Arc implements EIP-7708: a native value movement emits a Transfer log of its own, from this
// system address, alongside any ERC-20 Transfer the token contract emits. Since gas on Arc is paid
// in USDC, every transaction on the chain produces one — measured on testnet, this address emitted
// 49,709 Transfer logs across 3,000 blocks, more than the USDC contract itself (39,234).
//
// The indexer is unaffected: it passes address: TOKEN_ADDRS to eth_getLogs, so it never sees these
// and cannot double-count a movement. Discovery is the surface that hurts, because it samples logs
// with no address filter in order to find assets we are not tracking.
//
// Left alone, this address is the single largest untracked emitter on the chain, so it takes the
// first of the 25 discovery slots on every pass, spends four eth_calls and a sleep asking a
// codeless address what it is called, and then vanishes from the report — decimals() reverts, so
// the "not a fungible token" branch drops it. A silent, permanent 4% tax on the one probe that
// found USDT and the live USYC contract by hand.
//
// Excluded by name and reported as excluded, rather than filtered quietly: a discovery tool that
// hides part of what it saw is exactly the kind of thing this file exists to catch.
const NATIVE_TRANSFER_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';

// A textual marker that an asset is denominated in a fiat unit. Deliberately a note on the name, not
// a judgement about the asset: a token called USDC.b is worth a human look on a stablecoin index and
// a token called ARC WIF CAT is not, and saying which is which is the reader's job, not this script's.
// Used only to order the report so the candidates that matter are not buried under memecoins.
// Currency codes and the words a stable asset tends to carry, split by how much they collide with
// ordinary English. The first version knew eight currencies and pushed QCAD — a Canadian-dollar
// stablecoin trading on this chain — into the 'nothing to see' pile; on an index claiming to measure
// every stablecoin, a short currency list is a short list of assets it will quietly miss.
//
// But some ISO codes are also everyday words: PEN (Peruvian sol) is the start of Penguin, TRY (Turkish
// lira) is a verb. Matched loosely they drag memecoins into the list that matters, which defeats the
// sorting this exists to do. So they are only recognised as a whole symbol, never inside a name.
//
// This is a triage hint, not a classifier. It decides the order of a report a human reads; it never
// decides what is tracked.
const SAFE_CODES = ['usd','eur','gbp','jpy','chf','cad','aud','nzd','sgd','hkd','cny','cnh','krw',
  'inr','idr','brl','mxn','rub','pln','czk','nok','dkk','zar','ngn','kes','ghs','egp','aed','sar',
  'ils','uah','vnd','myr','twd','dai','stable','yield','peg','fiat','dollar','euro','franc','pound','yen'];
const AMBIGUOUS_CODES = ['pen','try','sek','cop','clp','ars','php','thb','huf','won','real'];

const SAFE_MARKER = new RegExp('\\b(' + SAFE_CODES.join('|') + ')', 'i');
const isAmbiguous = (t) => AMBIGUOUS_CODES.includes(String(t || '').toLowerCase());

// Names match on a word boundary; symbols are also tried with one leading letter removed, because
// stable tickers routinely glue an issuer prefix to the currency — QCAD, XSGD, ZUSD, GYEN.
export function looksFiat(name, symbol) {
  const sym = String(symbol || '');
  const stripped = sym.length >= 3 ? sym.slice(1) : '';
  return SAFE_MARKER.test(String(name || ''))
    || SAFE_MARKER.test(sym)
    || (stripped && SAFE_MARKER.test(stripped))
    || isAmbiguous(sym) || isAmbiguous(stripped);
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + n.toString(16);

// ---- findings ----------------------------------------------------------------------------------
// Three levels, and the distinction is the whole point. FAIL means the configuration asserts
// something the chain contradicts — serving figures under it would publish a wrong number. WARN
// means something changed that a human should look at but that does not make any published figure
// false. Only FAIL sets the exit code, so this can gate a deploy without crying wolf.
// What this check saw, as identities rather than as prose. The findings above are for a human
// reading one run; this is what a *later* run compares against, so it deliberately holds only what
// should be stable — symbol, decimals, whether there is code — and never supply or event counts,
// which move on their own and would make every run look like a change. `active` records whether the
// subject was seen moving, which is the difference a snapshot cannot express and the whole reason
// USYC going dormant took a manual audit to notice.
const observed = new Map();
// Contracts seen emitting a Transfer in the last discovery sample. Collected on every run, written
// only in watch mode — see reportChanges().
let emitters = [];
const observe = (kind, address, facts, opts = {}) =>
  observed.set(`${kind}:${String(address).toLowerCase()}`, { kind, facts, active: opts.active !== false, detail: opts.detail });

const findings = [];
const add = (level, check, message, detail) => findings.push({ level, check, message, detail });
const fail = (check, message, detail) => add('FAIL', check, message, detail);
const warn = (check, message, detail) => add('WARN', check, message, detail);
const ok = (check, message, detail) => add('OK', check, message, detail);

// ---- RPC ---------------------------------------------------------------------------------------
// Deliberately not rpc.js: that layer picks one endpoint and sticks to it, which is right for the
// indexer and wrong here — the first thing to verify is that *every* configured endpoint works.
// It also rotates on rate limits, which the public endpoints apply aggressively enough that a naive
// run reports phantom failures. A refused call must never be reported as a chain fact.
let rr = 0;
async function callOn(endpoint, batch) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch.map((c, i) => ({ jsonrpc: '2.0', id: i, ...c }))),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  const out = new Array(batch.length);
  for (const item of arr) out[item.id] = item.error ? { __err: item.error.message } : item.result;
  // Endpoints do not always return a slot for every call in a batch — some cap the batch, some cap
  // the response size, and the reply simply comes back short. A hole left as undefined reads exactly
  // like a definitive null downstream, which is how a run reported "EURC does not answer
  // totalSupply()" about a contract that answers it on every endpoint, every time. A missing slot is
  // a question that was never put, so it is marked as such and retried.
  for (let i = 0; i < out.length; i++) {
    if (out[i] === undefined) out[i] = { __err: 'no slot in response', __transient: true };
  }
  return out;
}

// Which per-call errors mean "we were not answered" as opposed to "the contract said no". The
// distinction decides whether a null is a fact about the chain or a fact about the endpoint's mood,
// and getting it wrong is how a verification tool invents failures: a rate-limited totalSupply() slot
// reported as "EURC does not answer totalSupply()" is precisely the kind of confident wrong statement
// this script exists to catch elsewhere.
// Deliberately broad, and erring toward "retry" rather than "conclude". Endpoints word this a
// dozen ways — Arc's public RPC says "request limit reached", which matched none of the first
// version's patterns, so a refusal was read as EURC declining to state its own decimals. For a tool
// whose whole job is to catch confident wrong statements, a false retry costs a few hundred
// milliseconds and a false conclusion costs the entire point.
export const TRANSIENT = /limit|too many|timeout|timed out|busy|try again|429|503|capacity|throttl|exceed|overload|unavailable/i;

// Rotates endpoints and retries. Slots that came back as a genuine contract-level failure (a revert)
// are handed back carrying { __err }, because that *is* the answer. Slots that were merely refused are
// retried on another endpoint, individually if need be, until one of them answers or we run out.
async function rpc(batch, attempts = 6) {
  let out = new Array(batch.length).fill(undefined);
  let pending = batch.map((_, i) => i);
  let lastErr;

  for (let a = 0; a < attempts && pending.length; a++) {
    const ep = CHAIN.endpoints[rr++ % CHAIN.endpoints.length];
    try {
      const sub = await callOn(ep, pending.map((i) => batch[i]));
      const stillPending = [];
      sub.forEach((slot, j) => {
        const idx = pending[j];
        if (slot?.__err && TRANSIENT.test(slot.__err)) stillPending.push(idx);
        else out[idx] = slot;
      });
      pending = stillPending;
      if (pending.length) await sleep(500 * (a + 1));
    } catch (e) { lastErr = e; await sleep(600 * (a + 1)); }
  }
  // Anything still unanswered is marked as such rather than as an empty result, so callers can tell
  // "refused" from "reverted" and decline to draw a conclusion.
  for (const i of pending) out[i] = { __err: 'unanswered', __transient: true };
  if (pending.length === batch.length && lastErr) throw lastErr;
  return out;
}

// True when a slot is the endpoint declining rather than the contract answering.
export const refused = (slot) => !!(slot && slot.__err && (slot.__transient || TRANSIENT.test(slot.__err)));

const call = (to, data) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

// Decodes a Solidity string return. Null for anything else — a revert, an empty return, or a value
// that is not a string at all.
export function decodeString(h) {
  try {
    if (typeof h !== 'string' || h === '0x' || h.length < 130) return null;
    const b = h.slice(2);
    const off = parseInt(b.slice(0, 64), 16) * 2;
    const len = parseInt(b.slice(off, off + 64), 16) * 2;
    if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0 || len > 256) return null;
    const s = Buffer.from(b.slice(off + 64, off + 64 + len), 'hex').toString('utf8');
    const clean = s.replace(/[^\x20-\x7e]/g, '').trim();
    return clean.length ? clean.slice(0, 64) : null;
  } catch { return null; }
}
const decodeNum = (h) => {
  try { return (typeof h === 'string' && h !== '0x') ? BigInt(h) : null; } catch { return null; }
};
const units = (raw, decimals) => Number(raw) / 10 ** decimals;
const fmt = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

// ---- 1. endpoints ------------------------------------------------------------------------------
async function checkEndpoints() {
  let live = 0;
  let refused = 0;
  let head = null;
  for (const ep of CHAIN.endpoints) {
    const t = Date.now();
    try {
      const out = await callOn(ep, [{ method: 'eth_blockNumber', params: [] }, { method: 'eth_chainId', params: [] }]);
      const ms = Date.now() - t;
      const bn = decodeNum(out[0]);
      const cid = decodeNum(out[1]);
      if (bn == null || cid == null) { fail('endpoint', `${ep} answered but returned no block/chain id`); continue; }
      // The one check that must never be skipped: an endpoint on the wrong chain would serve entirely
      // real, entirely irrelevant numbers under this network's banner.
      if (Number(cid) !== CHAIN.chainId) {
        fail('endpoint', `${ep} is chain ${cid}, profile says ${CHAIN.chainId}`);
        continue;
      }
      live += 1;
      head = head == null ? Number(bn) : Math.max(head, Number(bn));
      ok('endpoint', `${ep} · head ${Number(bn)} · ${ms}ms`);
    } catch (e) {
      // A refused credential is not an outage, and saying "did not answer" about a 401 sends the
      // reader to look at the wrong system. The indexer already draws this line — chainStateFromError
      // returns 'unauthorized' rather than 'unreachable', and chainalert spells out that it is ours to
      // fix — and a tool whose job is to be precise about causes should not be vaguer than the thing
      // it checks. Measured on the production mainnet profile: rpc.blockdaemon.mainnet.arc.io answers
      // 401, which means the endpoint exists and is running. That is a very different situation from
      // a hostname that resolves to nothing, and it has a completely different remedy.
      if (RPC_AUTH_STATUSES.has(e.status)) {
        refused += 1;
        warn('endpoint', `${ep} answered and refused our credentials (HTTP ${e.status})`,
          'the endpoint is up — this is our access to fix, not an outage');
      } else {
        warn('endpoint', `${ep} did not answer: ${e.message}`);
      }
    }
  }
  if (!live) {
    // Only when *every* endpoint refused us is the verdict about credentials. One network-level
    // failure among them and the network is involved too — the same rule rpc.js applies to allAuth.
    if (refused === CHAIN.endpoints.length) {
      fail('endpoint', `every endpoint refused our credentials — the indexer cannot start`,
        'the chain is reachable; the access is not. Restore or obtain credentials for these endpoints.');
    } else {
      fail('endpoint', 'no configured endpoint answered — the indexer cannot start');
    }
  } else if (live < CHAIN.endpoints.length) {
    warn('endpoint', `${live}/${CHAIN.endpoints.length} endpoints answering`);
  }
  return head;
}

// ---- 2. block time -----------------------------------------------------------------------------
// Not a correctness check but a calibration one: the noise filter converts each address's block span
// into days at this rate, so a chain running at a different speed than assumed shifts every flag.
async function checkBlockTime(head) {
  if (head == null) return null;
  const span = Math.min(2000, head);
  const out = await rpc([
    { method: 'eth_getBlockByNumber', params: [hex(head), false] },
    { method: 'eth_getBlockByNumber', params: [hex(head - span), false] },
  ]);
  const a = out[0]?.timestamp ? parseInt(out[0].timestamp, 16) : null;
  const b = out[1]?.timestamp ? parseInt(out[1].timestamp, 16) : null;
  if (a == null || b == null || a <= b) { warn('blocktime', 'could not measure block time from headers'); return null; }
  const ms = ((a - b) / span) * 1000;
  ok('blocktime', `${Math.round(ms)}ms over ${span} blocks`);
  // The chain's own clock against ours. Buckets are keyed by block timestamps and every rolling
  // window is anchored to them, so a large gap is worth knowing about before it shows up as a
  // suspiciously quiet 24h figure.
  const skew = Math.floor(Date.now() / 1000) - a;
  if (Math.abs(skew) > 600) warn('clock', `head timestamp is ${fmt(skew)}s from wall clock — windows anchor to chain time`);
  else ok('clock', `head timestamp within ${skew}s of wall clock`);
  return ms;
}

// ---- 3. configured tokens ----------------------------------------------------------------------
// Every field chains.js asserts about a token, asked of the token. This is the check that would have
// caught both August failures.
async function checkTokens() {
  const entries = Object.entries(CHAIN.tokens);
  const bySymbol = new Map();
  for (const [addr, meta] of entries) {
    const out = await rpc([
      { method: 'eth_getCode', params: [addr, 'latest'] },
      call(addr, SEL.symbol), call(addr, SEL.decimals), call(addr, SEL.totalSupply), call(addr, SEL.name),
    ]);
    const code = out[0];
    const size = (typeof code === 'string' && code !== '0x') ? (code.length - 2) / 2 : 0;
    if (!size) {
      observe('token', addr, { symbol: meta.symbol, decimals: meta.decimals, hasCode: false });
      fail('token', `${meta.symbol} ${addr} has no bytecode — nothing is deployed there`);
      continue;
    }

    const symbol = decodeString(out[1]);
    const decimals = decodeNum(out[2]);
    const supply = decodeNum(out[3]);
    const name = decodeString(out[4]);

    if (refused(out[1])) warn('token', `${meta.symbol} ${addr}: symbol() could not be read (endpoint refused) — not verified`);
    else if (symbol && symbol.toUpperCase() !== meta.symbol.toUpperCase()) {
      fail('token', `${addr} is configured as ${meta.symbol} but calls itself ${symbol}`);
    }
    // The expensive one to get wrong. Every amount is divided by 10**decimals, so a mismatch of 12
    // overstates or understates by a factor of a trillion — and the result still looks like a number.
    if (refused(out[2])) {
      // Not "it does not answer" — we did not get to ask. Saying otherwise would make this tool the
      // thing it exists to catch.
      warn('token', `${meta.symbol} ${addr}: decimals() could not be read (endpoint refused) — not verified`);
    } else if (decimals == null) {
      warn('token', `${meta.symbol} ${addr} does not answer decimals() — configured as ${meta.decimals}`);
    } else if (Number(decimals) !== meta.decimals) {
      fail('token', `${meta.symbol} ${addr} reports ${decimals} decimals, profile says ${meta.decimals}`,
        `every ${meta.symbol} figure would be wrong by 10^${Math.abs(Number(decimals) - meta.decimals)}`);
    }
    if (refused(out[3])) warn('token', `${meta.symbol} ${addr}: totalSupply() could not be read (endpoint refused) — not verified`);
    else if (supply == null) warn('token', `${meta.symbol} ${addr} does not answer totalSupply()`);

    observe('token', addr, { symbol: symbol || meta.symbol, decimals: decimals == null ? meta.decimals : Number(decimals), name, hasCode: true });

    const human = (supply != null && decimals != null) ? units(supply, Number(decimals)) : null;
    bySymbol.set(meta.symbol, (bySymbol.get(meta.symbol) || 0) + (human || 0));
    if (symbol && Number(decimals) === meta.decimals && human != null) {
      ok('token', `${meta.symbol} ${addr} · ${name || symbol} · ${meta.decimals} dec · supply ${fmt(human)}`);
    }
    await sleep(120);
  }
  // A symbol carried by several contracts is legitimate (Arc testnet has two USYC deployments) but it
  // is never accidental, so it is stated rather than left to be discovered in a supply figure.
  const counts = new Map();
  for (const m of Object.values(CHAIN.tokens)) counts.set(m.symbol, (counts.get(m.symbol) || 0) + 1);
  for (const [sym, n] of counts) {
    if (n > 1) ok('token', `${sym} is tracked across ${n} contracts — supply is reported as their sum (${fmt(bySymbol.get(sym))})`);
  }
  return bySymbol;
}

// ---- 4. what we are not tracking ---------------------------------------------------------------
// Samples recent blocks for Transfer events, groups them by emitting contract, and asks anything we
// do not track what it is. This is exactly how USDT and the live USYC contract were found by hand.
async function checkUntracked(head) {
  if (head == null) return;
  const tracked = new Set(Object.keys(CHAIN.tokens).map((a) => a.toLowerCase()));
  const registry = new Set(PROTOCOLS.flatMap((p) => p.contracts).map((a) => a.toLowerCase()));
  const counts = new Map();

  // Three windows spread over recent history rather than one contiguous block, so a single quiet or
  // unusually busy stretch does not decide the answer.
  const per = Math.max(100, Math.floor(SAMPLE_BLOCKS / 3));
  for (let w = 0; w < 3; w++) {
    const end = head - w * per * 12;
    const start = end - per + 1;
    if (start < 0) break;
    const logs = await getLogsSplit(start, end);
    if (logs == null) { warn('discovery', `log sample ${start}-${end} could not be read`); continue; }
    for (const l of logs) {
      const a = l.address.toLowerCase();
      counts.set(a, (counts.get(a) || 0) + 1);
    }
    await sleep(400);
  }
  if (!counts.size) { warn('discovery', 'no Transfer events sampled — cannot check for untracked assets'); return; }

  const unknown = [...counts.entries()]
    .filter(([a, n]) => a !== NATIVE_TRANSFER_EMITTER && !tracked.has(a) && n >= DISCOVERY_MIN_EVENTS)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 25);

  // Whether each tracked contract was seen moving in this sample. A tracked asset that is deployed,
  // answers every call, and produces no transfers is exactly the shape USYC had — and the shape no
  // single check can report, because nothing about it is wrong.
  for (const addr of tracked) {
    const n = counts.get(addr) || 0;
    const prior = observed.get(`token:${addr}`);
    if (prior) observed.set(`token:${addr}`, { ...prior, active: n > 0 });
  }

  const trackedEvents = [...counts.entries()].filter(([a]) => tracked.has(a)).reduce((s, [, n]) => s + n, 0);
  ok('discovery', `${counts.size} contracts emitted Transfer in the sample · ${trackedEvents} events from tracked assets`);

  // Every emitter is a contract — only a contract can emit a log — so this sample is a free census of
  // contract addresses that the balance scanner would otherwise never learn about. Handed to the
  // writer below rather than written here, so a read-only `npm run verify` stays read-only.
  const nativeLogs = counts.get(NATIVE_TRANSFER_EMITTER) || 0;
  if (nativeLogs) {
    ok('discovery', `${nativeLogs} native EIP-7708 transfer log(s) from ${NATIVE_TRANSFER_EMITTER.slice(0, 10)}… excluded — gas is paid in USDC, so every transaction emits one; the indexer filters by token address and never counts them`);
  }
  // Queued for a balance check, minus the system emitter: it has no bytecode, so asking the chain
  // for its code every cycle would answer the same nothing forever.
  emitters = [...counts.keys()].filter((a) => a !== NATIVE_TRANSFER_EMITTER);

  const others = [];
  for (const [addr, n] of unknown) {
    const out = await rpc([call(addr, SEL.symbol), call(addr, SEL.decimals), call(addr, SEL.totalSupply), call(addr, SEL.name)]);
    const symbol = decodeString(out[0]);
    const decimals = decodeNum(out[1]);
    const supply = decodeNum(out[2]);
    const name = decodeString(out[3]);
    await sleep(150);

    // No decimals means it is not a fungible token — an NFT collection, or something else entirely.
    // Reporting those as missing stablecoins would bury the ones that matter.
    if (decimals == null) continue;
    const human = supply != null ? units(supply, Number(decimals)) : null;

    // Is it a wrapper? A contract whose supply equals a tracked asset it custodies is repositioning
    // value, not issuing it, and counting it would report the same money twice — the same reasoning
    // that keeps Circle Gateway out of issuance. Reported so the answer is "register it as a
    // protocol", not "add it as a token".
    const wrapped = await detectWrapper(addr, human);
    const label = `${name || symbol || 'unnamed'}${symbol ? ` (${symbol})` : ''}`;
    // Recorded whether or not it is interesting today: the point of the record is that a later run
    // can tell this contract from one that was not here before.
    observe('seen', addr, {
      name, symbol, decimals: Number(decimals), hasCode: true,
      fiat: looksFiat(name, symbol), wrapper: wrapped ? wrapped.symbol : null,
    }, { detail: wrapped ? `wrapper of ${wrapped.symbol}` : (registry.has(addr) ? 'in the registry' : 'not tracked') });
    if (wrapped) {
      const known = registry.has(addr);
      // Reported as OK once it is registered: a wrapper we have already accounted for is not an open
      // question, and leaving it as a warning would train the reader to skip the section.
      const msg = `${addr} · ${label} · ${n} events · WRAPPER of ${wrapped.symbol} (holds ${fmt(wrapped.held)} against a supply of ${fmt(human)})`;
      if (known) ok('untracked', msg, 'in the protocol registry — its balance counts once, as TVL, and never as issuance');
      else warn('untracked', msg, 'do not track as issuance — register it as a protocol so its balance counts once, as TVL');
    } else if (looksFiat(name, symbol)) {
      // Named like a fiat-denominated asset, which on a stablecoin index is the set worth a decision.
      warn('untracked', `${addr} · ${label} · ${Number(decimals)} dec · supply ${fmt(human)} · ${n} events`,
        registry.has(addr) ? 'already in the protocol registry' : 'named like a fiat-denominated asset and not tracked — decide whether it belongs in ARC_TOKENS');
    } else {
      // Everything else is reported once, at the end, as a count rather than a wall of lines: a
      // memecoin emitting Transfer is not a gap in stablecoin coverage, and listing forty of them
      // would bury the one that is.
      others.push(`${symbol || 'unnamed'} (${n})`);
    }
  }
  if (others.length) {
    ok('untracked', `${others.length} other token(s) above the threshold, none named like a fiat asset: ${others.slice(0, 12).join(', ')}`);
  }
  if (!unknown.length) ok('untracked', 'every contract emitting Transfer above the reporting threshold is already tracked');
}

// Providers cap eth_getLogs by the number of *results*, not by the number of blocks, so a fixed
// window is not a fixed-size request: fine on a quiet stretch, refused on a busy one. Halving on
// failure is what the indexer already does for the same reason — without it, a wide sample simply
// reports "refused" and the discovery check silently stops looking.
async function getLogsSplit(start, end, depth = 0) {
  try {
    const out = await rpc([{ method: 'eth_getLogs', params: [{ fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER_TOPIC] }] }], 3);
    if (Array.isArray(out[0])) return out[0];
  } catch { /* fall through to the split */ }
  if (end <= start || depth >= 7) return null;
  const mid = start + Math.floor((end - start) / 2);
  const left = await getLogsSplit(start, mid, depth + 1);
  await sleep(250);
  const right = await getLogsSplit(mid + 1, end, depth + 1);
  if (left == null && right == null) return null;
  return [...(left || []), ...(right || [])];
}

// Compares a candidate's supply against the tracked assets it holds. Equality within a small margin
// is the wrapper signature.
async function detectWrapper(addr, supply) {
  if (!supply || supply <= 0) return null;
  const tokens = Object.entries(CHAIN.tokens);
  const out = await rpc(tokens.map(([t]) => call(t, BALANCE_OF + '0'.repeat(24) + addr.slice(2))));
  for (let i = 0; i < tokens.length; i++) {
    const [, meta] = tokens[i];
    const raw = decodeNum(out[i]);
    if (raw == null) continue;
    const held = units(raw, meta.decimals);
    // A real wrapper matches to the cent, because its supply *is* the deposit: Wrapped USDC measured
    // 68,920,980.30 on both sides. A one-percent tolerance let an LP token through whose backing merely
    // happened to be close to its share supply — a false "wrapper" here would tell the operator not to
    // track a genuine asset, so the test has to be tight enough to mean something.
    if (held > 0 && Math.abs(held - supply) / supply < 0.0005) return { symbol: meta.symbol, held };
  }
  return null;
}

// ---- 5. Gateway --------------------------------------------------------------------------------
async function checkGateway(head) {
  if (!CHAIN.gateway) {
    // Absence is a fact about the network, not a misconfiguration — every bridge-adjusted figure is
    // then reported as null rather than as a measured zero. Worth restating on a launch day, because
    // the day Circle adds Arc to the Gateway list this line becomes wrong.
    ok('gateway', `no Gateway configured for ${CHAIN.label} — bridge figures are reported as null`);
    return;
  }
  const addrs = [CHAIN.gateway.wallet, CHAIN.gateway.minter];
  const out = await rpc(addrs.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
  addrs.forEach((a, i) => {
    const size = (typeof out[i] === 'string' && out[i] !== '0x') ? (out[i].length - 2) / 2 : 0;
    observe('gateway', a, { hasCode: size > 0 });
    if (!size) fail('gateway', `${a} has no bytecode — bridge attribution would silently measure nothing`);
    else ok('gateway', `${a} · ${size} bytes`);
  });
}

// ---- 6. registry -------------------------------------------------------------------------------
// A registry entry pointing at an empty address attributes TVL to something that is not there.
async function checkRegistry() {
  const here = PROTOCOLS.filter((p) => (p.networks || ['testnet', 'mainnet']).includes(NETWORK));
  const addrs = [...new Set(here.flatMap((p) => p.contracts))];
  let missing = 0;
  for (let i = 0; i < addrs.length; i += 6) {
    const part = addrs.slice(i, i + 6);
    const out = await rpc(part.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    part.forEach((a, j) => {
      const size = (typeof out[j] === 'string' && out[j] !== '0x') ? (out[j].length - 2) / 2 : 0;
      const owner0 = here.find((p) => p.contracts.includes(a));
      observe('registry', a, { name: owner0?.name || null, hasCode: size > 0 });
      if (!size) {
        missing += 1;
        const owner = owner0;
        warn('registry', `${owner?.name || '?'} lists ${a}, which has no bytecode on ${CHAIN.label}`);
      }
    });
    await sleep(200);
  }
  if (!missing) ok('registry', `all ${addrs.length} registry contracts for ${NETWORK} are deployed`);
}

// ---- report ------------------------------------------------------------------------------------
function report() {
  const fails = findings.filter((f) => f.level === 'FAIL');
  const warns = findings.filter((f) => f.level === 'WARN');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      network: NETWORK, label: CHAIN.label, chainId: CHAIN.chainId,
      checkedAt: new Date().toISOString(),
      pass: fails.length === 0, fails: fails.length, warns: warns.length,
      findings,
    }, null, 2));
    return fails.length ? 1 : 0;
  }

  const icon = { OK: '  ok  ', WARN: ' warn ', FAIL: ' FAIL ' };
  let group = null;
  for (const f of findings) {
    if (f.check !== group) { group = f.check; console.log(`\n── ${group}`); }
    console.log(`${icon[f.level]} ${f.message}`);
    if (f.detail) console.log(`        ↳ ${f.detail}`);
  }
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${CHAIN.label} (${NETWORK}, chain ${CHAIN.chainId}) · ${fails.length} failed · ${warns.length} to review`);
  if (fails.length) {
    console.log('\nThe profile asserts something the chain contradicts. Serving figures under it would');
    console.log('publish wrong numbers — fix chains.js (or ARC_TOKENS) before deploying.');
  } else if (warns.length) {
    console.log('\nNothing published would be wrong, but the chain has moved in ways worth a look.');
  } else {
    console.log('\nThe profile matches the chain.');
  }
  return fails.length ? 1 : 0;
}

// ---- watch -------------------------------------------------------------------------------------
// Diffing needs storage, so db.js is loaded only here — importing it unconditionally would open (and
// migrate) a database on a plain read-only run, and would drag chains.js in through the static import
// that loadProfile() exists to avoid.
async function reportChanges() {
  const [{ record, describe, severity }, dbmod] = await Promise.all([import('./chainwatch.js'), import('./db.js')]);
  const { events, notable, firstRun } = await record(observed);

  // Hand the discovery sample to the balance scanner's queue.
  //
  // Discovery used to be fed only by addr_stats, which prune() trims to a rolling week — so an
  // address entered the measurement universe only if it MOVED a tracked token while being watched.
  // A contract that received USDC and then sat still was pruned before discovery reached it, and
  // could never be scanned again. Measured on testnet: a second Wrapped USDC deployment holding
  // 1,190,036 USDC, absent from the published TVL entirely. The bias had a direction — it missed
  // exactly the contracts that hold value without moving it, which is what TVL is.
  //
  // This pass already reads those logs to find untracked assets, so the census is free: no extra
  // RPC call, one INSERT OR IGNORE per emitter.
  // Two sources, because neither alone is enough. The sample catches contracts that are active now;
  // the watcher's own subject memory catches the ones it identified in an earlier pass and that emit
  // too rarely to appear in every sample — which is precisely what the 1,190,036 USDC wrapper did.
  const queue = [...new Set([...emitters, ...dbmod.watchedAddresses()])];
  if (queue.length) {
    const before = dbmod.seenContractsPending();
    dbmod.noteSeenContracts(queue);
    const added = dbmod.seenContractsPending() - before;
    if (added > 0) console.log(`\n── discovery queue\n  ··   ${added} contract(s) queued for a balance check that addr_stats would not have surfaced`);
  }

  if (firstRun) {
    // Nothing to compare against yet. Saying "12 new contracts" on the first run would be true and
    // useless — everything is new the first time you look.
    console.log(`\n── changes\n  ok   baseline recorded: ${observed.size} subject(s). Differences are reported from the next run.`);
    return;
  }
  console.log('\n── changes');
  if (!events.length) { console.log('  ok   nothing changed since the last check'); return; }
  for (const e of events) console.log(`${severity(e) === 'high' ? '  !!  ' : '  ··  '} ${describe(e)}`);
  if (notable.length) console.log(`\n  ${notable.length} of ${events.length} worth acting on${JSON_OUT ? '' : ' · delivered to Telegram when configured'}`);
}

// ---- run ---------------------------------------------------------------------------------------
// Only when invoked directly. The classification helpers above are the part that has been wrong twice
// and they need a test, which means the module has to be importable without firing a live run.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('verify-network.js');
// One full pass. Exported so the server can run it on a timer in-process, the way every other
// periodic job here works (tvl, entities, payments) — rather than as a second Railway service with a
// second volume and a database that backup.js would not cover.
//
// `quiet` suppresses the per-check report and prints only what changed. A scheduled run that logs
// forty lines an hour buries the one line that matters, which is the same reason chainalert announces
// transitions and not conditions.
// One pass at a time, guarded here rather than at the call site — because what needs protecting is
// module state, not the caller's bookkeeping. `observed` and `findings` are module-level and cleared
// at the top of every pass, so two overlapping runs do not merely race the database: the second wipes
// the first's observation mid-flight, and what gets diffed and stored is a merge of two partial
// passes. That produces GONE and FIRST SEEN events for subjects that never moved.
//
// A pass takes ~19s in the ordinary case, but WATCH_EVERY_SEC floors at 300 and a pass under
// rate-limit pressure bisects its log queries and can run for minutes. The same guard already exists
// twice in this codebase, in indexer.js and payments.js, for the same reason both times.
//
// The irony is worth stating: this watcher's whole rule is that silence must repeat before it counts.
// An overlapping pass corrupts exactly that counter.
let running = false;

export async function runOnce({ quiet = false, watch = WATCH } = {}) {
  if (running) {
    if (!quiet) console.error('a check is already running — skipping this one');
    return 0;
  }
  running = true;
  try {
    return await pass({ quiet, watch });
  } finally {
    running = false;
  }
}

async function pass({ quiet, watch }) {
  await loadProfile();
  findings.length = 0;
  observed.clear();
  if (!JSON_OUT && !quiet) console.log(`Verifying ${CHAIN.label} (${NETWORK}, chain ${CHAIN.chainId}) against ${CHAIN.endpoints.length} endpoint(s)…`);
  const head = await checkEndpoints();
  if (head != null) {
    await checkBlockTime(head);
    await checkTokens();
    await checkGateway(head);
    await checkRegistry();
    await checkUntracked(head);
  }
  const code = quiet ? summarise() : report();
  // Only after the checks have run: a run that could not read the chain has nothing to compare, and
  // storing its empty observation would make every subject look like it had disappeared.
  // Only in watch mode. A plain run stays strictly read-only, which is the property that makes it
  // safe to point at a production deployment, and it would be quietly lost if this ran unconditionally.
  if (watch && head != null) await reportChanges();
  return code;
}

// The one-line version, for a scheduled run. States the verdict without reprinting every check.
function summarise() {
  const fails = findings.filter((f) => f.level === 'FAIL');
  const warns = findings.filter((f) => f.level === 'WARN');
  console.log(`[watch] ${CHAIN.label}: ${fails.length} failed, ${warns.length} to review`);
  for (const f of fails) console.error(`[watch] FAIL ${f.message}`);
  return fails.length ? 1 : 0;
}

if (!invokedDirectly) { /* imported for its helpers */ } else
try {
  if (EVERY > 0) {
    // A loop for a host with no scheduler. Deliberately not the default: one pass and exit composes
    // with cron, with a Railway job, and with && in a deploy line, and none of those want a process
    // that never returns.
    const every = Math.max(60, EVERY);
    console.log(`Watching every ${every}s. Ctrl-C to stop.`);
    for (;;) {
      try { await runOnce(); } catch (e) { console.error(`check failed: ${e.message || e}`); }
      await sleep(every * 1000);
    }
  }
  process.exit(await runOnce({ quiet: false }));
} catch (e) {
  // A crash here is itself a finding: the script could not establish what the chain says, which is
  // not the same as the chain agreeing with us.
  console.error(`\nverify-network could not complete: ${e.message || e}`);
  console.error('This is not a pass. Nothing was verified.');
  process.exit(2);
}
