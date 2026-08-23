// Smoke tests — pure logic + a DB round-trip. No network, no RPC.
// Run: npm test   (uses the built-in node:test runner — still zero dependencies)

import { test } from 'node:test';
import { normalizePath, dayOf, countable, keyPrefix } from '../usage.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// db.js opens its database at module load and keeps one connection for the whole process, so
// whichever import reaches it first decides which file the entire suite writes to. It has happened: a
// test that imported chainwatch.js — which used to import db.js at its top — bound the singleton to the
// real arc.db before this ran, and the suite wrote synthetic keys, buckets and a nine-million-unit
// transfer into the live testnet database. Aggregates there are additive, so that is not something a
// later cleanup fully undoes.
//
// ES module imports are hoisted, so this assignment does *not* run before the static imports below —
// it cannot. What makes it work is that none of them reaches db.js, and every test loads db.js through
// a dynamic import, which runs after this line. The invariant is therefore: **nothing statically
// imported by this file may reach db.js.** `usingTempDb` below checks the outcome rather than trusting
// the invariant, because a comment cannot fail a build.
process.env.DB_PATH = join(tmpdir(), `stabledesk-test-${process.pid}-${Date.now()}.db`);

import { validateWebhook } from '../validate.js';
import { ADDR_RE, RANGES, TIERS, TOKEN_SYMBOLS } from '../constants.js';

// ---- webhook SSRF allow-list ----
test('validateWebhook rejects non-https', () => {
  assert.equal(validateWebhook('http://example.com/hook'), 'https_required');
});
test('validateWebhook rejects garbage', () => {
  assert.equal(validateWebhook('not a url'), 'invalid_url');
});
test('validateWebhook blocks localhost + .local', () => {
  assert.equal(validateWebhook('https://localhost/x'), 'blocked_host');
  assert.equal(validateWebhook('https://foo.local/x'), 'blocked_host');
});
test('validateWebhook blocks private / link-local / metadata IPs', () => {
  for (const ip of ['10.0.0.1', '192.168.1.5', '172.16.0.9', '127.0.0.1', '169.254.169.254', '100.64.0.1']) {
    assert.equal(validateWebhook(`https://${ip}/x`), 'blocked_host', ip);
  }
});
test('validateWebhook blocks embedded credentials', () => {
  assert.equal(validateWebhook('https://user:pass@example.com/x'), 'credentials_not_allowed');
});
test('validateWebhook allows a public https URL', () => {
  assert.equal(validateWebhook('https://discord.com/api/webhooks/1/abc'), null);
});

// ---- constants / regex ----
test('ADDR_RE matches lowercase 40-hex only', () => {
  assert.ok(ADDR_RE.test('0x' + 'a'.repeat(40)));
  assert.ok(!ADDR_RE.test('0x' + 'A'.repeat(40))); // upper-case is lowercased upstream first
  assert.ok(!ADDR_RE.test('0x1234'));
});
test('config surface is sane', () => {
  assert.deepEqual([...TOKEN_SYMBOLS].sort(), ['EURC', 'USDC', 'USDT', 'USYC']);
  assert.ok(TIERS.free.rpm < TIERS.pro.rpm);
  for (const [name, r] of Object.entries(RANGES)) {
    assert.ok(r.group > 0, `${name} groups into buckets`);
    // `all` is deliberately open-ended (span null → from the start of the record); every other
    // range is a finite trailing window.
    if (name === 'all') assert.equal(r.span, null);
    else assert.ok(r.span > 0, `${name} has a span`);
    // Anything past the minute table's 7-day retention has to be answered from the daily rollup,
    // or the range would silently return a truncated series.
    if (r.span != null && r.span > 7 * 86400) assert.ok(r.daily, `${name} must read the daily rollup`);
  }
});

// ---- the honesty signals are part of the machine contract ----
test('a truncated flag set is declared in the spec, not just present in the JSON', async () => {
  const { specJson } = await import('../openapi.js');
  const doc = JSON.parse(specJson());

  // atCap, qualifying and cap are how a consumer learns that adjusted volume is a lower bound —
  // that the flag set was decided by a ceiling and an ORDER BY rather than by the published
  // thresholds. They were served for weeks without being declared, so a generated typed client
  // dropped them and its user could never find out. A caveat that exists only in raw JSON is a
  // caveat for people reading curl output, which is not who the spec is for.
  const p = doc.components.schemas.FilteredAddresses.properties;
  for (const field of ['flagged', 'qualifying', 'cap', 'atCap', 'warning']) {
    assert.ok(p[field], `FilteredAddresses must declare ${field}`);
    assert.ok(p[field].description, `${field} needs to say what it means, not just its type`);
  }
  assert.ok(/lower bound/i.test(p.atCap.description), 'atCap must state the consequence, not just the condition');

  // The same signal on the TVL side: past the scan ceiling the total covers the contracts that fit.
  const tvl = doc.components.schemas.TvlTotals.properties;
  assert.ok(tvl.coverage, 'TvlTotals must declare coverage');
  assert.ok(tvl.warning, 'TvlTotals must declare the truncation warning');

  // And the series must say which table answered and how far back it reaches, or a 90-day range
  // drawn from a week-old record passes for ninety days.
  const hist = doc.components.schemas.History.properties;
  for (const field of ['source', 'since', 'recordBegan', 'windowEnd']) {
    assert.ok(hist[field], `History must declare ${field}`);
  }
});

// ---- a caller-supplied limit cannot become no limit ----
test('a negative limit falls back to the default instead of dumping the table', async () => {
  const { clampLimit, alignToBucket } = await import('../constants.js');

  // SQLite reads a negative LIMIT as *no limit*, and Math.min(max, Number(raw) || dflt) has no floor.
  // Measured against production: /v1/addresses/top?limit=-5 returned 335,520 rows and 35 MB in 3.2
  // seconds, against 2.3 KB for the same call with a sane limit. On a free tier allowing 60 requests
  // a minute, in a single-threaded process, that is an availability problem rather than a tidy-up.
  assert.equal(clampLimit('-5', 100, 20), 20, 'the exact production payload');
  assert.equal(clampLimit('-1', 100, 20), 20);
  assert.equal(clampLimit(-1e9, 100, 20), 20);

  // Everything that is not a usable count is treated as no preference expressed.
  for (const junk of ['0', 'abc', '', ' ', null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(clampLimit(junk, 100, 20), 20, `${String(junk)} should fall back`);
  }
  // Real values are honoured and capped.
  assert.equal(clampLimit('20', 100, 20), 20);
  assert.equal(clampLimit('99999', 100, 20), 100, 'clamped to the ceiling');
  assert.equal(clampLimit('7.9', 100, 20), 7, 'fractions floor rather than reaching the database');
  assert.equal(clampLimit(1, 100, 20), 1, 'one row is a legitimate request');

  // Bucket alignment. A series labels each bucket with the floor of its group, so an unaligned
  // `since` puts the first label *before* the requested window and that bucket holds only part of
  // its interval — an artificially low first point, which is the same defect the terminal already
  // avoids at the other end by dropping the final, still-filling bucket.
  assert.equal(alignToBucket(1000, 900), 1800, 'aligned up to the next whole bucket');
  assert.equal(alignToBucket(1800, 900), 1800, 'an already-aligned instant is left alone');
  assert.equal(alignToBucket(0, 86400), 0);
  assert.equal(alignToBucket(1234, 1), 1234, 'a group of one has no grid to align to');
});

// ---- the scan ceiling bounds a pass, not what is ever measured ----
test('rotation visits every known contract instead of the same top slice forever', async () => {
  const db = await import('../db.js');
  const { selectTargets } = await import('../tvl.js');

  // Scanning the same top N by balance every pass left the rest never scanned at all — measured on
  // production, 600 of 2,105 known contracts, so the published total covered 29% of them. That is a
  // systematic blind spot, not a sampling one: the same contracts were missing every time, and no
  // amount of waiting fixed it. Raising the ceiling is not the answer either — a pass is already 90s
  // of pure inter-batch delay inside a 300s interval.
  const addrs = [];
  for (let i = 0; i < 40; i++) {
    const a = '0x' + String(i).padStart(4, '0') + 'c'.repeat(36);
    addrs.push(a);
    db.markContract(a, true, 100);
  }
  const known = db.knownContractCount();
  const opts = { always: 2, slice: 5, cap: 7 };

  // A pass stays bounded by the cap, whatever the universe size.
  const first = selectTargets([], known, { ...opts, cursor: '' });
  assert.ok(first.targets.length <= opts.cap, 'one pass never exceeds the ceiling');

  // And the rotation reaches everything, with the wrap reported rather than counted.
  const seen = new Set();
  let cursor = '';
  let passes = 0;
  let wrapped = false;
  for (let i = 0; i < 200 && !wrapped; i++) {
    const r = selectTargets([], known, { ...opts, cursor });
    r.targets.forEach((a) => seen.add(a));
    cursor = r.cursor;
    wrapped = r.wrapped;
    passes += 1;
  }
  assert.ok(wrapped, 'the cursor wraps, which is how a completed cycle is known');
  for (const a of addrs) assert.ok(seen.has(a), `${a} must be visited within one cycle`);
  assert.ok(passes > 1, 'a cycle takes more than one pass, which is the point of bounding a pass');

  // Registry contracts are never squeezed out by the ceiling: a listed protocol with no measured
  // balance is indistinguishable from one nobody looked at.
  const listed = '0x' + 'ab'.repeat(20);
  const withReg = selectTargets([listed], known, { ...opts, cursor: '' });
  assert.ok(withReg.targets.includes(listed), 'a registry address is always scanned');
});

// ---- one check at a time ----
test('two overlapping checks cannot merge into one corrupted observation', async () => {
  const src = readFileSync('verify-network.js', 'utf8');

  // observed and findings are module-level and cleared at the top of every pass, so two concurrent
  // runs do not merely race the database — the second wipes the first's observation mid-flight, and
  // what gets diffed and stored is a merge of two partial passes. That invents GONE and FIRST SEEN
  // events for subjects that never moved.
  //
  // The guard belongs in runOnce rather than at the call site, because what needs protecting is this
  // module's state, not the caller's bookkeeping. This pins that: the exported entry point must check
  // a running flag before doing any work.
  const entry = src.slice(src.indexOf('export async function runOnce'));
  const body = entry.slice(0, entry.indexOf('async function pass'));
  assert.match(body, /if \(running\)/, 'runOnce must refuse to start while a pass is in flight');
  assert.match(body, /running = true/, 'and claim the flag before running');
  assert.match(body, /finally/, 'and release it even when the pass throws');

  // The same guard exists twice already, for the same reason both times. If it ever disappears from
  // those, this codebase has lost a lesson it paid for.
  assert.match(readFileSync('indexer.js', 'utf8'), /export function nonReentrant/);
  assert.match(readFileSync('payments.js', 'utf8'), /function nonReentrant/);

  // The watcher's whole rule is that silence must repeat before it counts. An overlapping pass
  // corrupts exactly that counter, which is why this one matters more than the usual double-work.
  const cw = readFileSync('chainwatch.js', 'utf8');
  assert.match(cw, /MISSES_BEFORE_GONE/);
  assert.match(cw, /MISSES_BEFORE_QUIET/);
});

// ---- a refused credential is not an outage, in the verifier either ----
test('the verifier tells a rejected key apart from an endpoint that is not there', async () => {
  const { RPC_AUTH_STATUSES } = await import('../constants.js');

  // The indexer already draws this line: chainStateFromError returns 'unauthorized' rather than
  // 'unreachable', and chainalert spells out that it is ours to fix. The verifier reported a 401 as
  // "did not answer", which sends the reader to look at the wrong system — and it is not academic.
  // The production mainnet profile points at rpc.blockdaemon.mainnet.arc.io, which answers 401: the
  // endpoint exists and runs, the credentials were revoked. "Unreachable" would suggest waiting for
  // a chain; "refused" says go and ask for access back. Opposite actions.
  for (const status of [401, 403, 407]) {
    assert.ok(RPC_AUTH_STATUSES.has(status), `${status} means the endpoint answered and said no`);
  }
  for (const status of [500, 502, 503, 404, undefined]) {
    assert.ok(!RPC_AUTH_STATUSES.has(status), `${status} is not a credentials verdict`);
  }

  // The verifier restates this set rather than importing it, so that it can be loaded without a
  // network profile — constants.js pulls in chains.js, which throws by design on an incomplete
  // mainnet config. Two copies of three numbers is the price; this pins them together.
  const src = readFileSync('verify-network.js', 'utf8');
  const declared = 'new Set([' + [...RPC_AUTH_STATUSES].join(', ') + '])';
  assert.ok(src.includes('const RPC_AUTH_STATUSES = ' + declared),
    'the verifier and constants.js must agree on which statuses mean "refused" — expected ' + declared);
});

// ---- what changed since the last look ----
test('the watcher reports differences, and makes absence prove itself first', async () => {
  const { diffObservations, describe, severity, MISSES_BEFORE_GONE, MISSES_BEFORE_QUIET } =
    await import('../chainwatch.js');

  const prev = (id, facts, over = {}) => ({ id, kind: 'token', facts, firstSeen: 1, lastSeen: 1000, lastCheck: 1000, misses: 0, ...over });
  const now = 100000;

  // Nothing to compare against: everything is recorded, nothing is announced. Saying "12 new
  // contracts" on a first run is true and useless.
  const first = diffObservations(new Map(), new Map([['seen:0xa', { kind: 'seen', facts: { symbol: 'FOO' } }]]), now);
  assert.equal(first.events.length, 1, 'a contract we had never seen is reported');
  assert.equal(first.rows.length, 1);

  // Config subjects are ours. A token appearing in the profile means we added it — not news about
  // the chain, and announcing our own edits back to us is noise.
  const added = diffObservations(new Map(), new Map([['token:0xb', { kind: 'token', facts: { symbol: 'USDT' } }]]), now);
  assert.equal(added.events.length, 0, 'a token we just configured is not a discovery');

  // Volatile values must not register as changes, or every run reports one. Supply moves every block.
  const same = diffObservations(
    new Map([['token:0xb', prev('token:0xb', { symbol: 'USDC', decimals: 6, hasCode: true, supply: 1 })]]),
    new Map([['token:0xb', { kind: 'token', facts: { symbol: 'USDC', decimals: 6, hasCode: true, supply: 999999 } }]]), now);
  assert.equal(same.events.length, 0, 'a moving supply is not a change of identity');

  // Identity moving under a stable address is the expensive kind: a decimals field that shifts makes
  // every figure derived from it wrong by a power of ten.
  const moved = diffObservations(
    new Map([['token:0xb', prev('token:0xb', { symbol: 'USDC', decimals: 6, hasCode: true })]]),
    new Map([['token:0xb', { kind: 'token', facts: { symbol: 'USDC', decimals: 18, hasCode: true } }]]), now);
  assert.equal(moved.events[0].type, 'changed');
  assert.equal(severity(moved.events[0]), 'high', 'a tracked token changing identity is worth interrupting someone');
  assert.match(describe(moved.events[0]), /decimals: 6 → 18/);

  // The USYC case, which is the whole reason this exists: deployed, answering every call, and no
  // longer moving. No snapshot can report it, because nothing about it is wrong.
  let state = new Map([['token:0xb', prev('token:0xb', { symbol: 'USYC', decimals: 6, hasCode: true })]]);
  const quietNow = new Map([['token:0xb', { kind: 'token', facts: { symbol: 'USYC', decimals: 6, hasCode: true }, active: false }]]);
  for (let i = 1; i < MISSES_BEFORE_QUIET; i++) {
    const r = diffObservations(state, quietNow, now);
    assert.equal(r.events.length, 0, `silence is not yet evidence at check ${i}`);
    state = new Map(r.rows.map((x) => [x.id, x]));
  }
  const called = diffObservations(state, quietNow, now);
  assert.equal(called.events[0].type, 'quiet');
  assert.equal(severity(called.events[0]), 'high');
  assert.match(describe(called.events[0]), /no transfers/);

  // And announced once, not on every check thereafter — a condition repeated hourly trains the
  // reader to ignore the channel, which is how the four-day outage stayed invisible.
  const after = diffObservations(new Map(called.rows.map((x) => [x.id, x])), quietNow, now);
  assert.equal(after.events.length, 0, 'a standing condition is not re-announced');

  // A sampled absence is not a disappearance: the discovery pass looks at a slice of blocks, so a
  // contract missing from one sample may simply have been quiet for those few hundred.
  let s2 = new Map([['seen:0xc', { id: 'seen:0xc', kind: 'seen', facts: { symbol: 'FOO' }, firstSeen: 1, lastSeen: 1000, lastCheck: 1000, misses: 0 }]]);
  for (let i = 1; i < MISSES_BEFORE_GONE; i++) {
    const r = diffObservations(s2, new Map(), now);
    assert.equal(r.events.length, 0, `one missed sample is not a disappearance (check ${i})`);
    s2 = new Map(r.rows.map((x) => [x.id, x]));
  }
  const gone = diffObservations(s2, new Map(), now);
  assert.equal(gone.events[0].type, 'gone');
  // The row survives, so the contract is not announced as a fresh discovery the next time a sample
  // happens to catch it.
  assert.equal(gone.rows.length, 1);

  // Reappearing clears the count rather than counting as a new contract.
  const back = diffObservations(new Map(gone.rows.map((x) => [x.id, x])),
    new Map([['seen:0xc', { kind: 'seen', facts: { symbol: 'FOO' } }]]), now);
  assert.equal(back.events.length, 0, 'a contract we already knew is not rediscovered');
  assert.equal(back.rows[0].misses, 0);

  // Severity keeps the channel readable: a memecoin appearing is a log line, a fiat-named one is not.
  assert.equal(severity({ type: 'new', kind: 'seen', facts: { fiat: false } }), 'low');
  assert.equal(severity({ type: 'new', kind: 'seen', facts: { fiat: true } }), 'high');
});

// ---- a refused call is not an answer ----
test('the network verifier tells a refusal apart from a contract declining', async () => {
  const { refused, decodeString } = await import('../verify-network.js');

  // The failure this encodes, twice over. Arc's public RPC refuses with "request limit reached",
  // which matched none of the first pattern's alternatives — so the verifier reported that EURC does
  // not answer decimals(), about a contract that answers it on every endpoint, every time. A tool
  // built to catch confident wrong statements had become one.
  for (const msg of ['request limit reached', 'rate limit exceeded', 'too many requests',
                     'daily limit', 'capacity exceeded', 'service unavailable', 'request timed out']) {
    assert.equal(refused({ __err: msg }), true, msg);
  }
  // A short batch is a question that was never put, not a null answer.
  assert.equal(refused({ __err: 'no slot in response', __transient: true }), true);

  // A real contract-level refusal is an answer and must NOT be retried away: this is how "has no
  // name()" is established at all.
  assert.equal(refused({ __err: 'execution reverted' }), false);
  assert.equal(refused('0x1234'), false, 'a result is not a refusal');
  assert.equal(refused(undefined), false);
  assert.equal(refused(null), false);

  // The fiat-name hint that decides how the untracked report is ordered. It is a triage aid, not a
  // classifier — but its first version knew eight currencies and sorted QCAD, a Canadian-dollar
  // stablecoin trading on this chain, into the pile labelled 'nothing to see'.
  const { looksFiat } = await import('../verify-network.js');
  for (const [name, sym] of [['QCAD', 'QCAD'], ['USD Coin', 'USDC.b'], ['', 'XSGD'], ['', 'ZUSD'],
                             ['', 'GYEN'], ['EURC', 'EURC'], ['US Yield Coin', 'USYC']]) {
    assert.equal(looksFiat(name, sym), true, `${name} / ${sym} should read as fiat-denominated`);
  }
  // Some ISO codes are also ordinary words. Matched loosely they drag memecoins into the list that
  // matters, which defeats the ordering the hint exists for, so they only count as a whole symbol.
  for (const [name, sym] of [['Penguin Token', 'PENGU'], ['Poultry', 'TRY2'], ['CAT Token', 'CAT'],
                             ['ARC WIF CAT', 'AWIF'], ['Circle Wrapped Bitcoin', 'cirBTC']]) {
    assert.equal(looksFiat(name, sym), false, `${name} / ${sym} should not`);
  }
  assert.equal(looksFiat('', 'PEN'), true, 'but the bare currency symbol still counts');

  // The verifier decodes the same self-reported strings the balance scanner does.
  const enc = (str) => '0x' + (32).toString(16).padStart(64, '0')
    + str.length.toString(16).padStart(64, '0')
    + Buffer.from(str, 'utf8').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(enc('EURC')), 'EURC');
  assert.equal(decodeString('0x'), null);
});

// ---- the RPC batch budget is in calls, not holders ----
test('adding a tracked asset shortens the balance batch instead of enlarging the request', async () => {
  const { TVL_CHUNK, RPC_CALLS_PER_BATCH } = await import('../constants.js');
  const { CHAIN } = await import('../chains.js');
  const contracts = Object.keys(CHAIN.tokens).length;

  // One balanceOf per holder per tracked contract, so the request size is the product. Holding the
  // holder count fixed meant the batch grew every time an asset was added: 24 calls at three
  // contracts, 40 at five — past what the public endpoint was proven to accept. And an overrun is
  // not merely slow: a refused slot arrives looking exactly like a contract that has no such
  // method, so it turns into a wrong answer rather than a retry.
  assert.ok(TVL_CHUNK * contracts <= RPC_CALLS_PER_BATCH,
    `${TVL_CHUNK} holders x ${contracts} contracts = ${TVL_CHUNK * contracts} calls, over the ${RPC_CALLS_PER_BATCH} budget`);
  assert.ok(TVL_CHUNK >= 2, 'never degenerates to one holder per request');
});

// ---- DB round-trip (isolated temp database) ----
test('db round-trips keys, buckets, addresses', async () => {
  const db = await import('../db.js');
  // The guard, not the hope: if any static import had reached db.js first, the singleton would be
  // bound to arc.db and this file would never have been created.
  db.createKey('sbd_probe', 'temp-db check', 'free');
  assert.ok(existsSync(process.env.DB_PATH),
    `tests are not using the temp database — db.js was bound elsewhere before DB_PATH took effect`);

  // api keys
  db.createKey('sbd_test', 'unit', 'free');
  assert.equal(db.getKey('sbd_test').tier, 'free');
  assert.equal(db.getKey('sbd_nope'), undefined);

  // a batch: one USDC bucket, one address, one recent transfer
  const minute = Math.floor(Date.now() / 1000 / 60) * 60;
  const buckets = new Map([[`${minute}|USDC`, { minute, token: 'USDC', volume: 100, cnt: 2, mint: 0, burn: 0, rvolume: 60, rcnt: 1 }]]);
  const addrs = new Map([['0x' + '1'.repeat(40), { transfers: 2, volume: 100, lastBlock: 500 }]]);
  const recents = [{ block: 500, ts: minute, token: 'USDC', frm: '0x' + '1'.repeat(40), too: '0x' + '2'.repeat(40), amount: 60 }];
  db.applyBatch(buckets, addrs, recents);

  const series = db.getHistory('USDC', minute - 60, 60);
  assert.ok(series.length >= 1);
  assert.equal(series.at(-1).volume, 100);
  assert.equal(series.at(-1).rvolume, 60);

  const summary = db.getSummary(minute - 60);
  assert.equal(summary.byToken.USDC.transfers, 2);

  const top = db.getTop(5);
  assert.equal(top[0].address, '0x' + '1'.repeat(40));
  assert.equal(db.getLargest(5)[0].amount, 60);
  assert.equal(db.addressStats('0x' + '1'.repeat(40)).transfers, 2);

  // per-token size distribution + drill-down queries
  const amts = [50, 500, 5000, 50000, 500000, 5000000];
  const more = amts.map((amt, i) => ({ block: 501 + i, ts: minute, token: 'USDC', frm: '0x' + '3'.repeat(40), too: '0x' + '4'.repeat(40), amount: amt }));
  db.applyBatch(new Map(), new Map(), more);
  const dist = db.sizeDistribution('USDC');
  assert.equal(dist.brackets.length, 6);
  assert.equal(dist.total, 7);                  // 6 new + the earlier 60
  assert.equal(dist.brackets[0].count, 2);      // <100: 50 and 60
  assert.equal(dist.brackets.at(-1).count, 1);  // 1M+: 5,000,000
  assert.equal(db.largestByToken('USDC', 3)[0].amount, 5000000);
  assert.ok(db.recentByToken('USDC', 5).length >= 5);
  assert.equal(db.sizeDistribution('EURC').total, 0);
});

// ---- crypto billing (Pro tier, paid in USDC on Base) ----
test('crypto billing: order matching, idempotency, renewal, expiry', async () => {
  // Reuses the DB module + temp file from the previous test (db.js is an ESM singleton — one
  // connection per process, closed once at the end of this, the final test in the file).
  // Distinct key prefixes keep the two tests' data from colliding.
  const db = await import('../db.js');
  const { processLogs } = await import('../payments.js');

  db.createKey('sbd_pay1', 'unit', 'free');
  const { id, amount } = db.createProOrder('sbd_pay1', 29);
  assert.ok(amount >= 29 && amount < 30, 'order amount is base price plus a sub-dollar offset');
  assert.ok(db.pendingOrders().some((o) => o.id === id));

  // Amounts are matched as integer micro-USDC — build the same kind of hex log a real
  // Transfer event carries (log.data = the raw uint256 value, no 0x-padding assumptions).
  const microHex = (usdc) => '0x' + BigInt(Math.round(usdc * 1e6)).toString(16);
  const paidLog = { data: microHex(amount), transactionHash: '0xTEST1' };

  processLogs([paidLog]);
  let rec = db.getKey('sbd_pay1');
  assert.equal(rec.tier, 'pro');
  assert.ok(rec.expires_at > Date.now() + 29 * 86400000, 'expiry is ~30 days out');

  // Replaying the same tx (e.g. a re-scanned block range) must not extend expiry again.
  const expiresAfterFirstPay = rec.expires_at;
  processLogs([paidLog]);
  assert.equal(db.getKey('sbd_pay1').expires_at, expiresAfterFirstPay, 'paying twice for one order is idempotent');

  // Renewing while still active stacks on top of the current expiry, not from "now".
  const { amount: amount2 } = db.createProOrder('sbd_pay1', 29);
  processLogs([{ data: microHex(amount2), transactionHash: '0xTEST2' }]);
  assert.equal(db.getKey('sbd_pay1').expires_at, expiresAfterFirstPay + 30 * 86400000);

  // A transfer that doesn't match any pending order's exact amount upgrades nothing.
  db.createKey('sbd_pay2', 'unit', 'free');
  db.createProOrder('sbd_pay2', 29);
  processLogs([{ data: microHex(1.23), transactionHash: '0xTEST3' }]);
  assert.equal(db.getKey('sbd_pay2').tier, 'free');

  // Expired Pro reverts to free (the check api.js runs inline on every authenticated request).
  db.createKey('sbd_pay3', 'unit', 'free');
  db.upgradeToPro('sbd_pay3', -1); // negative days == already expired, test-only
  assert.ok(db.getKey('sbd_pay3').expires_at < Date.now());
  db.downgradeKey('sbd_pay3');
  assert.equal(db.getKey('sbd_pay3').tier, 'free');
});

// ---- network fee economics + address-level noise filter ----
test('fee sampling and the address noise filter', async () => {
  const db = await import('../db.js');
  const { noiseLimitsFor, noiseWindowDays, feeMetrics, isNoiseTransfer } = await import('../indexer.js');
  const { NOISE_FILTER } = await import('../constants.js');

  // Thresholds are rates applied to an address's own observation window, and that window never
  // drops below a full day — otherwise an address first seen inside a single block has a near-zero
  // span, any activity at all is an infinite rate, and every new address is a bot.
  assert.equal(noiseWindowDays(900, 900, 500), 1, 'a single-block span uses the one-day floor');
  assert.equal(noiseWindowDays(null, 900, 500), 1, 'an unknown first block uses the floor too');
  assert.equal(noiseWindowDays(0, 172800, 500), 1, '172,800 blocks at 500ms is exactly one day');
  assert.equal(noiseWindowDays(0, 7 * 172800, 500), 7);
  assert.equal(noiseLimitsFor(7).maxTransfers, NOISE_FILTER.txPerDay * 7);
  assert.equal(noiseLimitsFor(0).days, 1, 'the limit builder floors the window as well');

  // Fee metrics are exact per sampled block and extrapolated to the window; the sample size
  // rides along so a derived rate can't be mistaken for a measured total.
  assert.equal(feeMetrics({ blocks: 0, fees: 0, txs: 0, gasUsed: 0 }, 100, 1000, 5), null, 'no samples → no numbers');
  const m = feeMetrics({ blocks: 10, fees: 2, txs: 40, gasUsed: 400000 }, 100, 1000, 1e6);
  assert.equal(m.perBlock, 0.2);
  assert.equal(m.perTx, 0.05);
  assert.equal(m.perDay, 200);            // 0.2/block × 1000 blocks/day
  assert.equal(m.inWindow, 20);           // 0.2/block × 100 blocks in window
  assert.equal(m.perMillionMoved, 20);    // $20 of fees per $1M of real volume moved
  assert.equal(m.sampledBlocks, 10);
  assert.equal(m.sampleCoverage, 0.1);
  assert.equal(feeMetrics({ blocks: 1, fees: 1, txs: 0, gasUsed: 0 }, 1, 1, 0).perMillionMoved, null, 'no volume → no ratio');

  // The flag set is capped for memory safety, and the cap is a published threshold like any
  // other. It was found binding in production — exactly 5,000 flagged, which meant the adjusted
  // figure was governed by the cap rather than by the documented rate limits, with nothing on the
  // page or in the API saying so. Both counts are now reported so the difference is visible.
  assert.ok(db.NOISE_SET_MAX > 0, 'the cap is a named, exported number rather than a literal in a query');
  const capped = db.noisyAddresses(NOISE_FILTER.txPerDay, NOISE_FILTER.volumePerDay, 500);
  const qualifying = db.noisyAddressCount(NOISE_FILTER.txPerDay, NOISE_FILTER.volumePerDay, 500);
  assert.ok(capped.length <= db.NOISE_SET_MAX, 'the flag set never exceeds the cap');
  assert.ok(qualifying >= capped.length, 'the uncapped count is never smaller than the capped set');
  // Below the cap the two must agree exactly, or `atCap` would fire on a healthy chain and cry
  // wolf about a truncation that never happened.
  if (qualifying < db.NOISE_SET_MAX) assert.equal(qualifying, capped.length);

  // Only infrastructure-to-infrastructure movement is noise. On a hub-and-spoke chain like Arc
  // almost every transfer touches a router or faucet, so dropping on "either end" (the Visa rule)
  // would delete genuine payments too — measured at 99.9% of testnet volume.
  const bots = new Set(['0xaaa', '0xbbb']);
  assert.equal(isNoiseTransfer({ frm: '0xaaa', too: '0xbbb' }, bots), true, 'bot → bot is noise');
  assert.equal(isNoiseTransfer({ frm: '0xaaa', too: '0xuser' }, bots), false, 'bot → user is a real delivery');
  assert.equal(isNoiseTransfer({ frm: '0xuser', too: '0xbbb' }, bots), false, 'user → bot is a real payment');
  assert.equal(isNoiseTransfer({ frm: '0xuser', too: '0xother' }, bots), false, 'user → user is never noise');

  // Adjusted volume is stored and summed alongside real volume.
  const minute = Math.floor(Date.now() / 1000 / 60) * 60 - 300;
  db.applyBatch(new Map([[`${minute}|EURC`, { minute, token: 'EURC', volume: 900, cnt: 9, mint: 0, burn: 0, rvolume: 500, rcnt: 5, avolume: 200, acnt: 2 }]]), new Map(), []);
  const sum = db.getSummary(minute - 60);
  assert.equal(sum.byToken.EURC.rvolume, 500);
  assert.equal(sum.byToken.EURC.avolume, 200, 'adjusted volume is strictly below real volume here');
  assert.equal(db.getHistory('EURC', minute - 60, 60).at(-1).avolume, 200);

  // A busy address trips the filter; a quiet one does not.
  const bot = '0x' + 'b'.repeat(40), human = '0x' + 'c'.repeat(40);
  db.applyBatch(new Map(), new Map([
    [bot, { transfers: 5000, volume: 10, lastBlock: 900, firstBlock: 900 }],  // flagged on frequency alone
    [human, { transfers: 3, volume: 10, lastBlock: 900, firstBlock: 900 }],
  ]), []);
  const flagged = db.noisyAddresses(NOISE_FILTER.txPerDay, NOISE_FILTER.volumePerDay, 500).map((r) => r.address);
  assert.ok(flagged.includes(bot), 'high-frequency address is flagged');
  assert.ok(!flagged.includes(human), 'a low-activity address is left alone');

  // Fee samples are keyed by block, so re-sampling one can't inflate the totals.
  db.insertFeeSamples([{ block: 7001, minute, fees: 0.5, txs: 4, gasUsed: 100000 }]);
  db.insertFeeSamples([{ block: 7001, minute, fees: 0.5, txs: 4, gasUsed: 100000 }]);
  db.insertFeeSamples([{ block: 7002, minute, fees: 1.5, txs: 6, gasUsed: 200000 }]);
  const fs = db.feeStats(minute - 60);
  assert.equal(fs.blocks, 2, 'the replayed block is ignored, not counted twice');
  assert.equal(fs.fees, 2);
  assert.equal(fs.txs, 10);
});

// ---- Circle Gateway: rebalancing separated from issuance ----
test('gateway rebalancing is not counted as issuance', async () => {
  const db = await import('../db.js');
  const { organicIssuance } = await import('../indexer.js');
  const { CHAIN } = await import('../chains.js');
  const { protocolForAddress } = await import('../protocols.js');

  // Arc testnet is a Gateway chain (domain 26), so the profile carries the contract pair and the
  // registry claims both addresses — which is what makes them show up labelled everywhere.
  assert.ok(CHAIN.gateway, 'testnet profile knows about Gateway');
  assert.equal(protocolForAddress(CHAIN.gateway.wallet)?.id, 'circle-gateway');
  assert.equal(protocolForAddress(CHAIN.gateway.minter)?.id, 'circle-gateway');

  // The headline case: a day where every mint came from Gateway. Raw net issuance says USDC on
  // Arc grew; organic says nobody actually chose to hold more of it, the balance just moved here.
  assert.equal(organicIssuance({ mint: 1000, burn: 0, bmint: 1000, bburn: 0 }, true), 0,
    'a day of pure rebalancing is zero organic issuance');

  // Gateway flowing out while real demand comes in — the two must not cancel by accident.
  assert.equal(organicIssuance({ mint: 500, burn: 800, bmint: 0, bburn: 800 }, true), 500,
    'a Gateway withdrawal does not read as USDC leaving Arc');

  // Mixed: 900 minted, 600 of it Gateway.
  assert.equal(organicIssuance({ mint: 900, burn: 100, bmint: 600, bburn: 0 }, true), 200);

  // Without Gateway on the network there is nothing to subtract, and the honest answer is the
  // absence of a measurement — never a zero, which would read as "we checked and it was none".
  assert.equal(organicIssuance({ mint: 900, burn: 100, bmint: 0, bburn: 0 }, false), null);
  assert.equal(organicIssuance(null, true), null);

  // Bridge columns round-trip through the aggregates, and sit *alongside* the raw ones rather
  // than replacing them: a consumer reconciling against their own chain scan needs both.
  const minute = Math.floor(Date.now() / 1000 / 60) * 60 - 600;
  db.applyBatch(new Map([[`${minute}|USYC`, {
    minute, token: 'USYC', volume: 700, cnt: 7, mint: 400, burn: 100,
    rvolume: 700, rcnt: 7, avolume: 700, acnt: 7,
    bmint: 300, bburn: 0, bvolume: 250, bcnt: 2,
  }]]), new Map(), []);
  const sum = db.getSummary(minute - 60);
  assert.equal(sum.byToken.USYC.mint, 400, 'the raw mint total still counts the Gateway mint');
  assert.equal(sum.byToken.USYC.bmint, 300);
  assert.equal(sum.byToken.USYC.bvolume, 250);
  assert.equal(organicIssuance(sum.byToken.USYC, true), 0, '400 − 100 minted, 300 of it bridged');
  assert.equal(db.getHistory('USYC', minute - 60, 60).at(-1).bmint, 300, 'and it survives into the series');
});

// ---- chain liveness ----
test('a stopped chain is told apart from a stopped indexer', async () => {
  const { chainStateFrom } = await import('../indexer.js');
  const { CHAIN_HALT_MS } = await import('../constants.js');

  // First contact: nothing to compare against, so no halt can be claimed.
  assert.equal(chainStateFrom(null, 100, 0), 'live', 'a first reading is never a halt');

  // The head moving is the whole signal.
  assert.equal(chainStateFrom(100, 101, 0), 'live');
  assert.equal(chainStateFrom(100, 100_000, 10 * CHAIN_HALT_MS), 'live', 'a jump forward clears any stall');

  // A head that has not moved is only a halt once it has stood still longer than a block could
  // plausibly take. Polling between blocks must not be reported as the chain stopping.
  assert.equal(chainStateFrom(100, 100, 1000), 'live', 'a moment between blocks is not a halt');
  assert.equal(chainStateFrom(100, 100, CHAIN_HALT_MS), 'live', 'the threshold itself is not yet a halt');
  assert.equal(chainStateFrom(100, 100, CHAIN_HALT_MS + 1), 'halted');

  // A reorg-free chain shouldn't go backwards, but if an endpoint serves a stale head we treat it
  // as "not advancing" rather than trusting it — the same rule, no special case.
  assert.equal(chainStateFrom(100, 99, CHAIN_HALT_MS + 1), 'halted', 'a backwards head is not progress');
  assert.equal(chainStateFrom(100, 99, 1000), 'live', 'but still needs the dwell time before it counts');
});

test('a refused credential is our fault, not an outage', async () => {
  const { chainStateFromError } = await import('../indexer.js');

  // Every endpoint answered and refused us: the chain is fine, our key is not. Reporting this as
  // an outage is what let four days of frozen production data pass as "Arc is down".
  assert.equal(chainStateFromError({ allAuth: true, status: 401 }), 'unauthorized');
  assert.equal(chainStateFromError({ allAuth: true, status: 403 }), 'unauthorized');

  // Nobody answered, or only some refused us — the network is involved, so we can't pin it on the
  // credentials alone.
  assert.equal(chainStateFromError({ allAuth: false, status: 401 }), 'unreachable', 'a mixed failure is not a clean auth verdict');
  assert.equal(chainStateFromError({ allAuth: false }), 'unreachable');
  assert.equal(chainStateFromError(new Error('fetch failed')), 'unreachable');

  // Errors that never went through the endpoint loop fall back to their own status.
  assert.equal(chainStateFromError({ status: 403 }), 'unauthorized');
  assert.equal(chainStateFromError({ status: 502 }), 'unreachable', 'a bad gateway is not a rejection of us');
  assert.equal(chainStateFromError(undefined), 'unreachable', 'no error object at all is still not an auth claim');
});

// ---- network switch (testnet / mainnet) ----
test('network profile: token parsing and mainnet fail-fast', async () => {
  const { parseTokens, CHAIN, NETWORK } = await import('../chains.js');

  // Tests run without ARC_NETWORK, so the default must be the safe one.
  assert.equal(NETWORK, 'testnet');
  assert.equal(CHAIN.isTestnet, true);
  assert.equal(CHAIN.chainId, 5042002);
  assert.equal(CHAIN.dbFile, 'arc.db', 'testnet keeps the original filename so deployed history survives');

  const t = parseTokens('USDC:0x' + '1'.repeat(40) + ':6, EURC:0x' + '2'.repeat(40) + ':6');
  assert.equal(Object.keys(t).length, 2);
  assert.equal(t['0x' + '1'.repeat(40)].symbol, 'USDC');
  assert.equal(t['0x' + '1'.repeat(40)].decimals, 6);
  assert.equal(parseTokens(''), null);
  assert.throws(() => parseTokens('USDC:notanaddress:6'), /ARC_TOKENS/);
  assert.throws(() => parseTokens('USDC:0x' + '1'.repeat(40) + ':abc'), /ARC_TOKENS/);

  // The safety property: asking for mainnet without its config must abort the process, not
  // quietly serve testnet data under a mainnet banner. Checked in a subprocess because the
  // profile is resolved once at module load.
  const { execFileSync } = await import('node:child_process');
  const run = (env) => {
    try {
      execFileSync(process.execPath, ['-e', "import('./chains.js').then(m=>console.log(m.CHAIN.chainId))"],
        { env: { ...process.env, ...env }, cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
      return null;
    } catch (e) { return String(e.stderr || e.message); }
  };
  const err = run({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '', ARC_RPC_URLS: '', ARC_TOKENS: '' });
  assert.ok(err, 'misconfigured mainnet must fail, not fall back');
  assert.match(err, /ARC_CHAIN_ID/);
  assert.match(err, /ARC_RPC_URLS/);
  assert.match(err, /ARC_TOKENS/);

  // A plain http endpoint is rejected too — testnet RPCs are https and mainnet must not be laxer.
  const insecure = run({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '9999', ARC_RPC_URLS: 'http://rpc.example', ARC_TOKENS: 'USDC:0x' + '1'.repeat(40) + ':6' });
  assert.match(insecure || '', /not an https URL/);

  // Fully configured, it boots and reports the configured chain — on its own database file.
  const ok = run({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '9999', ARC_RPC_URLS: 'https://rpc.example', ARC_TOKENS: 'USDC:0x' + '1'.repeat(40) + ':6' });
  assert.equal(ok, null, 'a complete mainnet config must start cleanly');
});

// ---- entity derivation (experimental — see entities.js) ----
test('entity derivation classifies from chain facts alone', async () => {
  const { classify, detectInterfaces, decodeString, explain } = await import('../entities.js');

  // Selector detection reads deployed bytecode — no ABI, no source, no verification service.
  const code = '0x60806040' + 'a9059cbb' + 'deadbeef' + '70a08231' + 'cafe';
  assert.deepEqual(detectInterfaces(code).sort(), ['balanceOf', 'transfer']);
  assert.deepEqual(detectInterfaces('0x'), [], 'an EOA has no interfaces');

  // A validator is infrastructure by definition — it authored blocks.
  assert.equal(classify({ blocksMade: 12, isContract: false, interfaces: [] }), 'validator');
  assert.equal(classify({ blocksMade: 0, isContract: false, interfaces: [] }), 'wallet');
  assert.equal(classify({ blocksMade: 0, isContract: true, tokenSymbol: 'USDC', interfaces: ['transfer'] }), 'token');
  assert.equal(classify({ blocksMade: 0, isContract: true, interfaces: ['getOwners', 'execTransaction'] }), 'multisig');
  assert.equal(classify({ blocksMade: 0, isContract: true, impl: '0x' + '1'.repeat(40), interfaces: [] }), 'proxy');
  assert.equal(classify({ blocksMade: 0, isContract: true, interfaces: ['transfer', 'balanceOf'] }), 'token-handler');
  assert.equal(classify({ blocksMade: 0, isContract: true, interfaces: [] }), 'contract');

  // Block authorship outranks bytecode: a validator that is also a contract is still a validator.
  assert.equal(classify({ blocksMade: 3, isContract: true, tokenSymbol: 'X', interfaces: [] }), 'validator');

  // Every classification carries its evidence — the page shows *why*, never a bare assertion.
  assert.match(explain({ kind: 'validator', blocksMade: 7 }), /7 recent blocks/);
  assert.match(explain({ kind: 'token', tokenSymbol: 'EURC' }), /symbol\(\) = "EURC"/);
  assert.match(explain({ kind: 'proxy', impl: '0x' + 'a'.repeat(40) }), /implementation\(\) points at/);

  // ABI string decoding, including the bytes32-style tokens that predate the string convention.
  const abiStr = '0x' + '0'.repeat(62) + '20' + '0'.repeat(62) + '04' + Buffer.from('USDC').toString('hex').padEnd(64, '0');
  assert.equal(decodeString(abiStr), 'USDC');
  assert.equal(decodeString('0x'), null);
  assert.equal(decodeString(null), null);
});

// ---- protocol registry (protocols.js) ----
test('registry validates itself and never double-claims a contract', async () => {
  const { PROTOCOLS, registryStats, protocolForAddress, protocolById, CATEGORIES } = await import('../protocols.js');

  const ids = PROTOCOLS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'protocol ids are unique');

  // The invariant that matters for TVL: one contract, one owner. Two entries claiming the same
  // address would double-count its balance in the chain total.
  const claimed = new Set();
  for (const p of PROTOCOLS) {
    assert.ok(CATEGORIES[p.category], `${p.id} has a known category`);
    assert.ok(['canonical', 'team', 'observed'].includes(p.source), `${p.id} declares provenance`);
    // Verified means somebody accountable confirmed it — never our own classification.
    if (p.verified) assert.notEqual(p.source, 'observed', `${p.id} cannot be both observed and verified`);
    for (const c of p.contracts) {
      assert.match(c, /^0x[0-9a-f]{40}$/, `${p.id} address ${c} is lowercase hex`);
      assert.ok(!claimed.has(c), `${c} is claimed only once`);
      claimed.add(c);
    }
  }

  const st = registryStats();
  assert.equal(st.total, PROTOCOLS.length);
  assert.equal(st.verified + st.unverified, st.total);
  assert.equal(st.contracts, claimed.size);

  // Address → protocol resolution, and the case-insensitivity callers rely on.
  const sample = PROTOCOLS[0].contracts[0];
  assert.equal(protocolForAddress(sample.toUpperCase())?.id, PROTOCOLS[0].id);
  assert.equal(protocolForAddress('0x' + 'f'.repeat(40)), null);
  assert.equal(protocolById('nope'), null);
});

// ---- TVL aggregation (tvl.js) ----
test('tvl attributes balances to protocols and reports the rest as unattributed', async () => {
  const db = await import('../db.js');
  const tvl = await import('../tvl.js');
  const { PROTOCOLS } = await import('../protocols.js');

  const owner = PROTOCOLS.find((p) => p.contracts.length === 1);
  const registered = owner.contracts[0];
  const stranger = '0x' + 'ab'.repeat(20);

  db.upsertBalances([
    { address: registered, token: 'USDC', balance: 300 },
    { address: registered, token: 'EURC', balance: 200 },
    { address: stranger, token: 'USDC', balance: 500 },
  ]);

  const agg = tvl.aggregate();
  assert.equal(agg.totals.tvl, 1000, 'total is every recorded balance');
  assert.equal(agg.totals.byToken.USDC, 800);
  assert.equal(agg.totals.byToken.EURC, 200);
  assert.equal(agg.totals.attributed, 500, 'only the registered contract is attributed');
  assert.equal(agg.totals.unattributed, 500, 'the rest is reported, not dropped');
  assert.equal(agg.totals.attributed + agg.totals.unattributed, agg.totals.tvl);
  assert.equal(agg.totals.attributedShare, 0.5);

  const row = agg.protocols.find((p) => p.id === owner.id);
  assert.equal(row.tvl, 500);
  assert.equal(row.contractsWithBalance, 1);
  assert.equal(row.observed, true, 'holding a balance counts as observed');

  // The unnamed contract becomes a registry candidate — the work queue, not a silent write-off.
  const cand = agg.candidates.find((c) => c.address === stranger);
  assert.ok(cand, 'unregistered holder is surfaced as a candidate');
  assert.equal(cand.tvl, 500);
  assert.equal(agg.candidates.some((c) => c.address === registered), false, 'registered contracts are not candidates');

  // Detail view stays traceable: the headline equals the sum of the contract table.
  const d = tvl.detail(owner.id);
  assert.equal(d.contractDetail.reduce((a, c) => a + c.tvl, 0), d.tvl);
  assert.equal(tvl.detail('does-not-exist'), null);

  // An unattributed address resolves to its own view rather than a dead link.
  const ad = tvl.addressDetail(stranger);
  assert.equal(ad.unnamed, true);
  assert.equal(ad.tvl, 500);
  // …and a registered one redirects to the owning protocol instead of claiming to be unnamed.
  assert.equal(tvl.addressDetail(registered).id, owner.id);
});

// ---- CSV export ----
test('csv quotes correctly and neutralises spreadsheet formulas', async () => {
  const { toCsv } = await import('../csv.js');

  const out = toCsv(
    [{ a: 'plain', b: 1 }, { a: 'has,comma', b: 'has "quote"' }, { a: 'line\nbreak', b: null }],
    [['A', 'a'], ['B', 'b']],
  );
  const lines = out.trimEnd().split('\r\n');
  assert.equal(lines[0], 'A,B');
  assert.equal(lines[1], 'plain,1');
  assert.equal(lines[2], '"has,comma","has ""quote"""');
  assert.ok(out.includes('"line\nbreak",'), 'embedded newline is quoted, not stripped');

  // A label starting with = would be executed as a formula on open; prefixing a tab defuses it.
  for (const bad of ['=cmd()', '+1', '-1', '@SUM(A1)']) {
    assert.ok(toCsv([{ a: bad }], [['A', 'a']]).includes('\t' + bad), `${bad} is neutralised`);
  }

  // Accessor functions, so an API response gaining a field can't reshape a saved import.
  assert.ok(toCsv([{ links: { site: 'x' } }], [['site', (r) => r.links.site]]).includes('site\r\nx'));
});

// ---- global search ----
test('search resolves protocols, tokens and address prefixes', async () => {
  const { search } = await import('../search.js');
  const { PROTOCOLS } = await import('../protocols.js');

  assert.equal(search('a').total, undefined, 'queries under two characters return nothing');

  const first = PROTOCOLS[0];
  const byName = search(first.name.toLowerCase());
  assert.equal(byName.protocols[0].id, first.id, 'an exact name ranks first');

  assert.ok(search('usdc').tokens.some((t) => t.symbol === 'USDC'));

  // A registry contract is findable by address prefix even with no indexed activity — a protocol
  // that just deployed has an address and no transfers yet.
  const addr = first.contracts[0];
  const byPrefix = search(addr.slice(0, 6));
  assert.ok(byPrefix.addresses.some((a) => a.address === addr), 'registry contracts match by prefix');
  assert.equal(byPrefix.addresses.find((a) => a.address === addr).protocol.id, first.id);

  // Exact address resolves even when unknown, so a lookup never comes back empty-handed.
  const unknown = '0x' + '9'.repeat(40);
  assert.equal(search(unknown).addresses[0].address, unknown);
});

// ---- daily rankings ----
test('rankings digest reports missing baselines instead of inventing 0%', async () => {
  const { daily, digest } = await import('../rankings.js');

  const r = daily();
  assert.ok(typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day));
  assert.ok(r.chain.tvl > 0, 'picks up the balances seeded above');

  const text = digest(r);
  assert.match(text, /Arc ecosystem/);
  assert.match(text, /Top by TVL/);
  // No stored history in this run, so movers must say so rather than showing a fabricated 0%.
  assert.match(text, /no baseline yet/);
  assert.match(text, /haven't named yet/, 'the digest asks for help identifying unnamed contracts');
});

// ---- alerting on a chain-state change (chainalert.js) ----
// The four-day outage is the specification here: the state was tracked correctly the whole time
// and nobody was told. These assert the two ways this path can fail — staying silent when it
// matters, and talking so much it stops being read.
test('a chain-state change is announced once, with the blame pointed the right way', async () => {
  const ca = await import('../chainalert.js');

  // Silence where silence is right.
  assert.equal(ca.transition('live', 'live'), null, 'no change is not an event');
  assert.equal(ca.transition('unknown', 'live'), null, 'booting into a healthy chain is not news');
  assert.equal(ca.transition('live', 'unknown'), null, 'learning less than we knew is not news');

  // The case that actually happened: a refused key, on a redeploy, from a cold start.
  const refused = ca.transition('unknown', 'unauthorized', { lastError: 'HTTP 401' });
  assert.ok(refused, 'a rejected credential must alert even as the first state we ever see');
  assert.match(refused.text, /our configuration to fix/i);
  assert.match(refused.text, /not an Arc outage/i, 'a refused key must explicitly disclaim being an Arc outage');
  assert.match(refused.text, /HTTP 401/, 'the alert quotes the error that caused it');
  assert.match(refused.text, /absent, not stale/, 'says what the site is doing meanwhile');

  // ...and the opposite direction: nobody answering is not our credential's fault.
  const dark = ca.transition('live', 'unreachable', { lastError: 'fetch failed' });
  assert.doesNotMatch(dark.text, /credential|configuration to fix/i);

  // A halt is the chain's problem, and says so.
  const halted = ca.transition('live', 'halted', { stalledMs: 252000, head: 12961063 });
  assert.match(halted.text, /chain has halted/i);
  assert.match(halted.text, /indexer is fine/i);
  assert.match(halted.text, /4m/, 'reports how long the head has been frozen');

  // Recovery closes the loop and reports the outage length.
  const back = ca.transition('unauthorized', 'live', { head: 12961063, downMs: 4 * 3600e3 + 12 * 60e3 });
  assert.match(back.text, /restored/i);
  assert.match(back.text, /4h 12m/);

  assert.equal(ca.humanDuration(45e3), '45s');
  assert.equal(ca.humanDuration(90 * 60e3), '1h 30m');
  assert.equal(ca.humanDuration(50 * 3600e3), '2d 2h');
  assert.equal(ca.humanDuration(null), 'an unknown time', 'an unknown duration is never rendered as 0');

  // Cooldown: a flapping endpoint must not turn into a hundred messages an hour. Telegram is
  // unconfigured in tests, so note() reports the decision without sending anything.
  ca.resetCooldowns();
  const t0 = 1_000_000;
  const ctx = { lastError: 'HTTP 401' };
  assert.equal((await ca.note('live', 'unauthorized', ctx, t0)).reason, 'telegram_not_configured',
    'first transition passes the cooldown and reaches delivery');
  assert.equal((await ca.note('live', 'unauthorized', ctx, t0 + 60e3)).reason, 'cooldown',
    'the same state again a minute later is suppressed');
  assert.equal((await ca.note('live', 'unauthorized', ctx, t0 + ca.ALERT_COOLDOWN_MS)).reason, 'telegram_not_configured',
    'and allowed again once the window has passed');

  // A recovery must never be swallowed by the outage's own cooldown — that would leave the last
  // message sent saying the site is broken after it came back.
  ca.resetCooldowns();
  await ca.note('live', 'unauthorized', ctx, t0);
  assert.equal((await ca.note('unauthorized', 'live', { head: 1 }, t0 + 1000)).reason, 'telegram_not_configured',
    'recovery has its own budget');
});

// ---- overlapping ticks (indexer.js) ----
// setInterval fires on schedule regardless of whether the previous async callback has returned, so
// a tick with a multi-day gap to close gets re-entered every POLL_MS while it works. The damage is
// not wasted requests: applyBatch adds to the existing bucket, so two passes over the same range
// count the same transfers twice and silently inflate the headline volume.
test('a slow tick is never re-entered while it is still running', async () => {
  const { nonReentrant } = await import('../indexer.js');

  let started = 0, finished = 0;
  const slow = nonReentrant(async () => {
    started++;
    await new Promise((r) => setTimeout(r, 40));
    finished++;
  });

  // One long call, with several timer firings landing on top of it.
  const first = slow();
  const during = await Promise.all([slow(), slow(), slow()]);
  assert.deepEqual(during, [false, false, false], 'calls arriving mid-run are refused, not queued');
  assert.equal(started, 1, 'the body runs once, however many times the timer fires');

  assert.equal(await first, true, 'the call that did run reports that it ran');
  assert.equal(finished, 1);

  // And the guard clears afterwards — a lock that leaked would freeze the indexer permanently,
  // which is a worse failure than the one being fixed.
  assert.equal(await slow(), true, 'the next tick after completion runs normally');
  assert.equal(started, 2);

  // A throwing tick must release the guard too. tickOnce catches its own errors today, but a lock
  // that depends on the body never throwing is a lock waiting to deadlock.
  const boom = nonReentrant(async () => { throw new Error('rpc exploded'); });
  await assert.rejects(boom(), /rpc exploded/);
  await assert.rejects(boom(), /rpc exploded/, 'still callable after a failure — the guard was released');
});

// ---- catch-up progress (indexer.js) ----
// The snapshot is only rebuilt when a tick completes, so during a long replay every figure derived
// from it is frozen at the last completed pass. Before this existed, "replaying 830k blocks" and
// "hung" were the same reading from outside — the one distinction a health endpoint is for.
test('catch-up progress is reported from the live checkpoint, not the snapshot', async () => {
  const { progressFrom } = await import('../indexer.js');

  const mid = progressFrom(54_301_397, 55_131_311, 500);
  assert.equal(mid.behind, 829_914);
  assert.ok(mid.catchingUp, 'a multi-day gap is replaying history, not trailing the head');

  // Ordinary lag: a few blocks behind is what steady state looks like, and calling it a catch-up
  // would put the status page in a permanent state of alarm.
  const steady = progressFrom(55_131_300, 55_131_311, 500);
  assert.equal(steady.behind, 11);
  assert.equal(steady.catchingUp, false);

  assert.equal(progressFrom(55_131_311, 55_131_311, 500).behind, 0, 'caught up is 0, not null');

  // A checkpoint past the head (the head reading is older than the last write) is clamped rather
  // than reported as negative blocks remaining.
  assert.equal(progressFrom(55_131_400, 55_131_311, 500).behind, 0);

  // Nothing known yields null, never 0 — "caught up" and "no idea" must not render alike.
  for (const [cp, head] of [[null, 55_131_311], [54_301_397, null], [null, null]]) {
    const p = progressFrom(cp, head, 500);
    assert.equal(p.behind, null);
    assert.equal(p.catchingUp, false, 'an unknown gap is not a catch-up claim');
  }
});

// ---- the availability record (chainuptime.js) ----
// Every assertion here is really the same one: time we did not observe must never be published as
// chain uptime. That is the only way this feature can lie, and it would lie in our favour, which
// is the direction nobody checks.
test('uptime is a share of observed time, never of the window', async () => {
  const { uptimeFrom, incidents, VERDICT } = await import('../chainuptime.js');
  const H = 3600e3;
  const T = 1_700_000_000_000;
  const win = (events, seen, hours = 10) => uptimeFrom(events, T, T + hours * H, seen);

  // A plain halt: the one case where downtime is unambiguously the chain's.
  const halt = win([
    { at: T, state: 'live' },
    { at: T + 4 * H, state: 'halted', head: 100 },
    { at: T + 5 * H, state: 'live' },
  ], T + 10 * H);
  assert.equal(halt.upMs, 9 * H);
  assert.equal(halt.downMs, H);
  assert.equal(halt.uptimePct, 90);
  assert.equal(halt.coveragePct, 100);

  // The indexer was off for four hours. Uptime stays 100% — of what was seen — and coverage is what
  // carries the gap. Reporting 60% here would blame the chain for our downtime; reporting 100% with
  // no coverage figure would hide it. Both numbers, always.
  const gap = win([
    { at: T, state: 'live' },
    { at: T + 2 * H, state: 'unobserved' },
    { at: T + 6 * H, state: 'live' },
  ], T + 10 * H);
  assert.equal(gap.uptimePct, 100, 'a gap is not downtime');
  assert.equal(gap.coveragePct, 60, 'and is not silently absorbed either');
  assert.equal(gap.downMs, 0);
  assert.equal(gap.unobservedMs, 4 * H);

  // The outage that actually happened: our key refused for eight hours. Arc may have been perfectly
  // healthy throughout, so this cannot appear as chain downtime — it is time we were not looking.
  const refused = win([
    { at: T, state: 'live' },
    { at: T + H, state: 'unauthorized', error: 'HTTP 401' },
    { at: T + 9 * H, state: 'live' },
  ], T + 10 * H);
  assert.equal(refused.downMs, 0, 'a rejected credential is never charged to the chain');
  assert.equal(refused.byState.unauthorized, 8 * H, 'but it is still recorded, under our own name');
  assert.equal(refused.uptimePct, 100);
  assert.equal(refused.coveragePct, 20);

  // Past the watermark nothing is claimed, including about the present. Without this the last known
  // state extrapolates forward forever and a dead indexer publishes a perfect record.
  const stale = win([{ at: T, state: 'live' }], T + 3 * H);
  assert.equal(stale.upMs, 3 * H, 'the open segment ends where our knowledge does');
  assert.equal(stale.coveragePct, 30);

  // No watermark at all: decline to assume, rather than assume the best.
  assert.equal(win([{ at: T, state: 'live' }], null).observedMs, 0);

  // An empty record is not a perfect record.
  const empty = win([], T + 10 * H);
  assert.equal(empty.uptimePct, null, 'no observations yields null, never 100');
  assert.equal(empty.coveragePct, 0);

  // The state at the window's opening edge comes from the transition *before* it, or a healthy
  // chain that last changed state months ago would read as entirely unobserved.
  const leading = uptimeFrom([{ at: T - 500 * H, state: 'live' }], T, T + 2 * H, T + 2 * H);
  assert.equal(leading.uptimePct, 100);
  assert.equal(leading.coveragePct, 100);

  // Episodes, for the half of a status page people actually read.
  const eps = incidents([
    { at: T, state: 'live' },
    { at: T + 4 * H, state: 'halted', head: 100 },
    { at: T + 5 * H, state: 'live' },
    { at: T + 8 * H, state: 'unauthorized', error: 'HTTP 401' },
  ], T, T + 10 * H, T + 10 * H);
  assert.equal(eps.length, 2);
  assert.equal(eps[0].state, 'unauthorized', 'most recent first');
  assert.equal(eps[0].blame, 'stabledesk', 'our own outages are published, not filtered out');
  assert.equal(eps[0].verdict, 'unobserved');
  assert.ok(eps[0].ongoing, 'an episode with nothing after it has not been seen to end');
  assert.equal(eps[1].blame, 'chain');
  assert.equal(eps[1].ms, H);
  assert.equal(eps[1].ongoing, false);

  // A restart gap is dropped from the list but never from the arithmetic. Hiding it from both
  // would be how an availability page quietly becomes a marketing page.
  const restart = [
    { at: T, state: 'live' },
    { at: T + 5 * H, state: 'unobserved' },
    { at: T + 5 * H + 20e3, state: 'live' },
  ];
  assert.equal(incidents(restart, T, T + 10 * H, T + 10 * H).length, 0, 'a 20-second redeploy is not an incident');
  assert.equal(win(restart, T + 10 * H).byState.unobserved, 20e3, 'but it is still counted');
  assert.ok(win(restart, T + 10 * H).coveragePct < 100, 'and still shows up as missing coverage');

  // A brief halt, by contrast, is news at any length — the floor applies only to our own gaps.
  const blip = incidents([
    { at: T, state: 'live' },
    { at: T + 5 * H, state: 'halted' },
    { at: T + 5 * H + 20e3, state: 'live' },
  ], T, T + 10 * H, T + 10 * H);
  assert.equal(blip.length, 1, 'a 20-second halt is still reported');

  // Drift guard: every state the indexer can reach has to be classified, or it silently falls into
  // the unobserved bucket and quietly inflates uptime.
  const { chainStateFrom, chainStateFromError } = await import('../indexer.js');
  const reachable = new Set([
    'unknown', 'unobserved',
    chainStateFrom(null, 1, 0), chainStateFrom(5, 5, 99e3),
    chainStateFromError({ allAuth: true }), chainStateFromError({ allAuth: false }),
  ]);
  for (const s of reachable) assert.ok(VERDICT[s], `state "${s}" has no verdict`);
});

// ---- the machine-readable surfaces (openapi.js) ----
// The spec is generated so it can't be forgotten, but "generated" only guarantees it is *built* —
// not that it still describes the API. The drift that matters is a route added to api.js and never
// described, so that is what this asserts, by reading the routes out of the source rather than
// from a list someone has to remember to update.
test('the OpenAPI spec describes every route the API actually serves', async () => {
  const { readFile } = await import('node:fs/promises');
  const { spec, llmsTxt } = await import('../openapi.js');
  const doc = spec();

  const src = await readFile(new URL('../api.js', import.meta.url), 'utf8');
  const literal = [...src.matchAll(/path === '(\/v1[^']*)'/g)].map((m) => m[1]);
  const prefixes = [...src.matchAll(/path\.startsWith\('(\/v1[^']*)'\)/g)].map((m) => m[1]);
  const described = Object.keys(doc.paths);

  for (const route of literal) {
    assert.ok(described.includes(route), `${route} is served but not described in the spec`);
  }
  // Prefix routes appear templated ("/v1/address/{address}"), so they match by their stem.
  for (const stem of prefixes) {
    assert.ok(
      described.some((p) => p.startsWith(stem) && p.includes('{')),
      `${stem}… is served but has no templated path in the spec`,
    );
  }
  // And the reverse: nothing described that isn't served, or the spec invents an endpoint.
  for (const p of described) {
    const served = literal.includes(p) || (p.includes('{') && prefixes.some((s) => p.startsWith(s)));
    assert.ok(served, `${p} is described in the spec but no route serves it`);
  }

  // A dangling $ref makes the document unusable to every consumer that resolves them.
  const refs = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') refs.push(node.$ref);
    for (const v of Object.values(node)) walk(v);
  })(doc);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const target = ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], doc);
    assert.notEqual(target, undefined, `dangling $ref: ${ref}`);
  }

  assert.doesNotThrow(() => JSON.parse(JSON.stringify(doc)), 'the spec must serialise');

  // Both documents are network-derived on purpose: a hardcoded token list would render USYC on a
  // network that doesn't carry it, which is the failure the generation exists to prevent.
  const tokens = [...TOKEN_SYMBOLS];
  const tokenEnum = doc.paths['/v1/stablecoins/{token}'].get.parameters[0].schema.enum;
  assert.deepEqual(tokenEnum, tokens, 'the token enum must come from the active network profile');
  assert.match(llmsTxt(), new RegExp(tokens.join(', ')), 'llms.txt states the tracked assets');
  assert.match(llmsTxt(), /openapi\.json/, 'llms.txt points an agent at the spec');
});

// ---- a transfer's timestamp comes from measured headers, not from an assumed block time ----
test('a range is timestamped between its own two block headers', async () => {
  const { chunkClock } = await import('../indexer.js');

  // 500 blocks spanning 250 seconds is half a second a block. Any block in between is placed by
  // interpolating the two *measured* endpoints.
  const clock = chunkClock(100, 600, 1000, 1250);
  assert.equal(clock(100), 1000, 'the first block sits on its own header');
  assert.equal(clock(600), 1250, 'and so does the last');
  assert.equal(clock(300), 1100, 'the middle is interpolated, not extrapolated');

  // The bug this replaces: `avgBlockMs` is initialised to 500 and was only measured by the first
  // live tick, which runs *after* the cold backfill — so a whole seeded history was timestamped at
  // an assumed half-second block time. On a chain that actually runs at 1s, the far end of a
  // 20,000-block backfill lands 10,000 seconds from where it happened, and buckets are additive and
  // keyed by minute, so it cannot be corrected afterwards.
  const real = chunkClock(0, 20000, 0, 20000); // 1s blocks, measured
  const assumed = (block) => block * 0.5;      // what the old default would have said
  assert.equal(real(20000) - assumed(20000), 10000, 'the error the measured clock removes');

  // Degenerate inputs return null so the caller can fall back to the anchor rather than divide by
  // zero and write NaN minutes into every bucket in the range.
  assert.equal(chunkClock(100, 100, 1000, 1000), null, 'a single-block range has no slope');
  assert.equal(chunkClock(100, 600, NaN, 1250), null, 'a missing header is not a timestamp');
  assert.equal(chunkClock(600, 100, 1000, 1250), null, 'a reversed range is refused');
});

// ---- the noise filter measures a rate, over the window it says it measures ----
test('an address is judged over its own observed span, not over the retained window', async () => {
  const db = await import('../db.js');
  const { NOISE_FILTER } = await import('../constants.js');

  // Two addresses with *identical* totals, seen over different spans. At 500ms blocks, 172,800
  // blocks is one day.
  const day = 172800;
  const brief = '0x' + 'd'.repeat(40);   // 200 transfers inside one day  → 200/day
  const patient = '0x' + 'e'.repeat(40); // 200 transfers across 30 days  → ~7/day
  db.applyBatch(new Map(), new Map([
    [brief, { transfers: 200, volume: 1000, lastBlock: 1_000_000 + day, firstBlock: 1_000_000 }],
    [patient, { transfers: 200, volume: 1000, lastBlock: 2_000_000 + 30 * day, firstBlock: 2_000_000 }],
  ]), []);

  const flagged = db.noisyAddresses(NOISE_FILTER.txPerDay, NOISE_FILTER.volumePerDay, 500);
  const byAddr = new Map(flagged.map((r) => [r.address, r]));
  assert.ok(byAddr.has(brief), '200 transfers in a day is ~6x the rate limit');
  assert.ok(!byAddr.has(patient), 'the same 200 transfers spread over a month is an ordinary address');

  // This is the regression that matters. Before, both totals were compared against a limit
  // pro-rated to the *bucket* coverage — which prune() caps at seven days — so the denominator was
  // the same for both and the patient address was flagged too. Worse, the denominator stopped
  // growing at seven days while the numerators kept accumulating, so an ordinary address became a
  // bot purely by the deployment staying up, and adjusted volume drifted downwards with nothing
  // saying so. /methodology claimed the rate was measured over the window we hold; now it is.
  const row = byAddr.get(brief);
  assert.equal(row.windowDays, 1, 'the flagged address carries the window it was judged over');
  assert.equal(row.maxTransfers, NOISE_FILTER.txPerDay * 1, 'and the limit derived from it');
  assert.ok(row.transfers > row.maxTransfers, 'which is the comparison that flagged it');

  // The published rule is auditable per address: every flagged row states its own limits, so a
  // reader can redo the arithmetic without knowing anything about our retention.
  for (const r of flagged) {
    assert.ok(r.windowDays >= 1, 'no window is ever below the one-day floor');
    assert.ok(r.transfers > r.maxTransfers || r.volume > r.maxVolume, `${r.address} breaches a stated limit`);
  }
});

// ---- history outlives the minute table ----
test('minutes roll up into days before they are pruned, and long ranges read the rollup', async () => {
  const db = await import('../db.js');
  const T = 'ROLL';                                  // its own token, so other tests' rows can't blur this
  const day = Math.floor(Date.now() / 1000 / 86400) * 86400 - 40 * 86400;  // 40 days ago
  const bk = (minute, volume, cnt) => new Map([[`${minute}|${T}`,
    { minute, token: T, volume, cnt, mint: 0, burn: 0, rvolume: volume, rcnt: cnt }]]);

  db.applyBatch(bk(day + 600, 100, 1), new Map(), []);       // early in the day
  db.applyBatch(bk(day + 80000, 250, 3), new Map(), []);     // late in the same day

  // Prune with a cutoff *inside* that day: only the first half is old enough to roll up.
  db.prune(day + 40000 + 7 * 86400, 10_000_000, 500);
  let series = db.getDailyHistory(T, day - 86400);
  assert.equal(series.length, 1, 'one day, whichever table the halves are sitting in');
  assert.equal(series[0].volume, 350, 'the rolled-up half and the live half sum to the whole day');

  // Prune again, past the whole day. The second half now rolls into the same daily row, which is
  // why the rollup is additive: a day straddling the cutoff is written across two prunes, and a
  // replace-on-conflict would have thrown the first half away.
  db.prune(day + 86400 + 7 * 86400, 10_000_000, 500);
  assert.equal(db.getHistory(T, day - 86400, 60).length, 0, 'the minute rows are gone');
  series = db.getDailyHistory(T, day - 86400);
  assert.equal(series.length, 1);
  assert.equal(series[0].volume, 350, 'and the day survives them in full');
  assert.equal(series[0].cnt, 4);

  // Idempotence is what stops volume from inflating: prune runs every couple of hundred ticks
  // forever, and aggregates are additive, so a re-run must be a no-op once the minutes are gone.
  db.prune(day + 86400 + 7 * 86400, 10_000_000, 500);
  assert.equal(db.getDailyHistory(T, day - 86400)[0].volume, 350, 'pruning twice does not double-count');

  // The dispatcher both /history endpoints go through: past 7 days it must reach the rollup, or a
  // 30-day chart would end where the minute table does and look like an outage.
  const { RANGES: R } = await import('../constants.js');
  assert.ok(db.getSeries(T, day - 86400, R['30d'].group, R['30d'].daily).length === 1);
  assert.equal(db.getSeries(T, day - 86400, R['7d'].group, R['7d'].daily).length, 0, '7d reads minutes, which are pruned');
  assert.ok(db.dailyCoverage().a <= day, 'the rollup states how far back it reaches');
});

// ---- "largest transfer" means over a stated window, not over the last two minutes ----
test('the largest transfers are retained per day, and the raw window publishes its span', async () => {
  const db = await import('../db.js');
  const A = '0x' + '7'.repeat(40), B = '0x' + '8'.repeat(40);
  const nowSec = Math.floor(Date.now() / 1000);
  const oldTs = nowSec - 3 * 86400;   // older than the raw transfer window, inside the per-day set

  db.applyBatch(new Map(), new Map(), [
    { block: 900_001, ts: oldTs, token: 'USDC', frm: A, too: B, amount: 9_000_000 },
    { block: 900_002, ts: nowSec, token: 'USDC', frm: A, too: B, amount: 7 },
  ]);

  // Replaying a range must not list one transfer twice — indexRange retries, and adjustBackfill
  // deliberately re-reads the cold-start range. The natural key is what makes that safe.
  db.applyBatch(new Map(), new Map(), [
    { block: 900_001, ts: oldTs, token: 'USDC', frm: A, too: B, amount: 9_000_000 },
  ]);
  const nineMil = db.getLargest(50, 0).filter((r) => r.amount === 9_000_000);
  assert.equal(nineMil.length, 1, 'a re-indexed transfer appears once');

  // The window is an argument, so the claim is explicit. A 1-day window must not contain a
  // transfer from three days ago.
  assert.ok(db.getLargest(10, nowSec - 86400).every((r) => r.amount !== 9_000_000), 'outside a 1-day window');
  assert.ok(db.getLargest(10, nowSec - 7 * 86400).some((r) => r.amount === 9_000_000), 'inside a 7-day one');

  // Prune the raw transfer table down to its 24h window. The old row leaves `recent`; it stays in
  // the per-day set — which is the whole point, because at real throughput (~954k transfers/day on
  // the testnet) a 1,200-row table held 114 seconds, and "the largest transfer" read from it meant
  // "the largest of the last two minutes" on the terminal, in /v1/transfers/largest, and on every
  // token page.
  db.prune(nowSec, 10_000_000, 500);
  assert.ok(db.addressRecent(A, 25).every((r) => r.ts >= nowSec - 24 * 3600), 'recent is a 24h window');
  assert.ok(db.addressLargest(A, 10).some((r) => r.amount === 9_000_000), 'the biggest thing it did is kept');

  // The size distribution describes that same raw window, so it reports it: a histogram over two
  // minutes and one over a day are different claims and the shape alone does not say which.
  const dist = db.sizeDistribution('USDC');
  assert.ok(dist.window, 'the distribution states the window it covers');
  assert.equal(dist.window.cap, db.RECENT_MAX);
  assert.equal(dist.window.atCap, false, 'and whether the row cap, not the clock, is the binding limit');
  assert.equal(dist.total, dist.brackets.reduce((a, b) => a + b.count, 0), 'brackets account for every row');
});

// ---- rolling windows are anchored to the clock the data is keyed by ----
test('window end follows chain time, never a wall clock the data has not reached', async () => {
  const { windowEndSec } = await import('../indexer.js');
  const now = 1_800_000_000;

  // Healthy chain: the newest measured minute is seconds behind now, and that is what the window
  // ends at. Unchanged behaviour, arrived at honestly.
  assert.equal(windowEndSec(now, now - 30), now - 30);

  // Diverged clocks. Bucket minutes are keyed by *block* timestamps; the window used to end at
  // Date.now(), so `minute >= now - 86400` selected nothing and the terminal published "24h volume:
  // 0" over a database holding days of transfers. The local testnet database is exactly this shape —
  // buckets ending six days behind its own event log.
  const sixDays = now - 6 * 86400;
  assert.equal(windowEndSec(now, sixDays), sixDays, 'the window ends at the last measured minute');

  // Frozen chain: same anchor, which is why the two paths can no longer disagree.
  assert.equal(windowEndSec(now, sixDays, true), sixDays);
  // Chain timestamps ahead of the wall clock: do not report a window ending in the future.
  assert.equal(windowEndSec(now, now + 500), now, 'never past now while live');
  // Nothing indexed at all: there is no measured minute to anchor to.
  assert.equal(windowEndSec(now, null), now);
});

// ---- per-IP limits cannot be lifted with a header ----
test('the client address is read from the trusted end of the forwarding chain', async () => {
  const { clientIp, TRUSTED_PROXY_HOPS } = await import('../api.js');
  const req = (fwd, socket = '10.0.0.1') => ({ headers: fwd == null ? {} : { 'x-forwarded-for': fwd }, socket: { remoteAddress: socket } });

  assert.equal(TRUSTED_PROXY_HOPS, 1, 'Railway and the Caddy setup in deploy/ each add exactly one hop');

  // A proxy appends the address it saw, so XFF reads `<claimed>, <observed>`. Reading the leftmost
  // entry meant a client could mint unlimited free API keys — rateLimitKeys allows 5/hour per IP, and
  // a fresh forged prefix per request makes that no limit at all.
  assert.equal(clientIp(req('9.9.9.9, 203.0.113.7')), '203.0.113.7', 'the observed address, not the claimed one');
  assert.equal(clientIp(req('203.0.113.7')), '203.0.113.7', 'no client header: the single entry is ours');
  assert.equal(clientIp(req(null)), '10.0.0.1', 'no header at all falls back to the socket');
  assert.equal(clientIp(req('')), '10.0.0.1');

  // The spoofing case, stated directly: two different forged prefixes behind the same real client
  // must resolve to the same identity, or the limiter counts them separately and bounds nothing.
  assert.equal(clientIp(req('1.1.1.1, 198.51.100.5')), clientIp(req('2.2.2.2, 198.51.100.5')));
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 198.51.100.5')), '198.51.100.5', 'a longer forged prefix changes nothing');
});

// ---- webhook targets are checked against what they resolve to ----
test('a webhook hostname that resolves privately is refused', async () => {
  const { validateWebhookHost } = await import('../validate.js');
  const resolver = (host) => {
    const table = {
      'evil.example.com': [{ address: '169.254.169.254', family: 4 }],
      'split.example.com': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
      'ok.example.com': [{ address: '93.184.216.34', family: 4 }],
      'v6.example.com': [{ address: 'fd00::1', family: 6 }],
    };
    return table[host] ? Promise.resolve(table[host]) : Promise.reject(new Error('ENOTFOUND'));
  };

  // The hole this closes: every syntactic check passes, and the fetch still lands on the cloud
  // metadata endpoint from inside the deployment, with the response discarded. Refusing redirects
  // never helped, because no redirect was needed.
  assert.equal(await validateWebhookHost('https://evil.example.com/hook', resolver), 'blocked_host');
  assert.equal(await validateWebhookHost('https://v6.example.com/hook', resolver), 'blocked_host', 'IPv6 unique-local too');
  // One public and one private answer is refused outright rather than raced against whichever
  // address fetch happens to pick.
  assert.equal(await validateWebhookHost('https://split.example.com/hook', resolver), 'blocked_host');
  assert.equal(await validateWebhookHost('https://ok.example.com/hook', resolver), null);
  // A name that does not resolve would store a rule that can never fire.
  assert.equal(await validateWebhookHost('https://nope.example.com/hook', resolver), 'unresolvable_host');
  // The synchronous checks still run first, and a literal IP needs no resolution.
  assert.equal(await validateWebhookHost('http://ok.example.com/x', resolver), 'https_required');
  assert.equal(await validateWebhookHost('https://127.0.0.1/x', resolver), 'blocked_host');
});

// ---- an oversize body gets an answer ----
test('an oversize request body is refused instead of hanging the request', async () => {
  const { EventEmitter } = await import('node:events');
  const { readBody, BODY_MAX } = await import('../api.js');

  // req.destroy() guarantees 'end' will never fire, so the old version's promise never settled: the
  // handler never returned and the request hung with no response until something else timed out.
  const big = new EventEmitter();
  big.pause = () => {};
  const pending = readBody(big);
  big.emit('data', 'x'.repeat(BODY_MAX + 1));
  assert.deepEqual(await pending, { __tooLarge: true }, 'settles, with a marker the caller turns into a 413');

  const ok = new EventEmitter();
  ok.pause = () => {};
  const parsed = readBody(ok);
  ok.emit('data', '{"webhook":"https://example.com/x"}');
  ok.emit('end');
  assert.equal((await parsed).webhook, 'https://example.com/x');

  // A client that disconnects mid-body is a terminal state too, not a promise nobody resolves.
  const gone = new EventEmitter();
  gone.pause = () => {};
  const aborted = readBody(gone);
  gone.emit('aborted');
  assert.deepEqual(await aborted, {});

  const bad = new EventEmitter();
  bad.pause = () => {};
  const junk = readBody(bad);
  bad.emit('data', 'not json');
  bad.emit('end');
  assert.deepEqual(await junk, {}, 'unparseable JSON is an empty body, not a crash');
});

// ---- TVL coverage is decided by relevance, and says when it is truncated ----
test('the balance scanner picks its targets by value and publishes the ceiling', async () => {
  const db = await import('../db.js');
  const rich = '0x' + 'a1'.repeat(20), busy = '0x' + 'a2'.repeat(20), idle = '0x' + 'a3'.repeat(20);

  for (const a of [rich, busy, idle]) db.markContract(a, true, 100);
  db.upsertBalances([{ address: rich, token: 'USDC', balance: 5_000_000 }]);
  db.applyBatch(new Map(), new Map([[busy, { transfers: 10, volume: 900_000, lastBlock: 950, firstBlock: 900 }]]), []);

  const order = db.knownContracts(50);
  assert.ok(order.indexOf(rich) < order.indexOf(busy), 'the biggest balance is scanned first');
  assert.ok(order.indexOf(busy) < order.indexOf(idle), 'then the biggest flow');

  // Before, this was `ORDER BY address` — so past the 600-target ceiling, which contracts counted
  // towards chain TVL was decided by how their addresses happened to sort in hex. That is the same
  // silent truncation the noise-set cap is published to avoid, and it now reports the same way.
  assert.ok(db.knownContractCount() >= 3, 'how many there are to scan is a measured number');
  assert.equal(db.knownContracts(2).length, 2, 'and the ceiling is respected');

  // The sum the dashboard polls comes from SQLite rather than from reading and sorting every row.
  // Asserted against the rows themselves rather than a literal: earlier tests share this database.
  assert.equal(db.totalBalance(), db.balanceRows().reduce((a, r) => a + r.balance, 0));
  assert.ok(db.totalBalance() >= 5_000_000);
});

// ---- unattributed value gets a name, from the chain ----
test('a holding contract is asked what it calls itself, and a non-answer stays a non-answer', async () => {
  const db = await import('../db.js');
  const { decodeString } = await import('../tvl.js');

  // A real ABI-encoded string: offset 0x20, length 6, "Synthra" trimmed to fit the example.
  const enc = (s) => {
    const hexs = Buffer.from(s, 'utf8').toString('hex').padEnd(64, '0');
    return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hexs;
  };
  assert.equal(decodeString(enc('PerpDEX LP')), 'PerpDEX LP');
  assert.equal(decodeString(enc('SYNPLP')), 'SYNPLP');

  // Everything that is not a string has to come back null rather than as mojibake. rpcSoft hands
  // back undefined for a reverted call by design, and a contract without name() reverts — so the
  // common case here is "not a string", and a garbled label on the ecosystem page would be worse
  // than no label at all.
  assert.equal(decodeString('0x'), null, 'empty return');
  assert.equal(decodeString(undefined), null, 'reverted slot');
  assert.equal(decodeString(null), null);
  assert.equal(decodeString('0x' + '0'.repeat(64)), null, 'a bare uint is not a string');
  assert.equal(decodeString('0xdeadbeef'), null, 'truncated data');

  // Stored narrowly: the balance scanner learns a smaller fact than the entity deriver, and must not
  // write NULLs over the columns the deriver filled.
  const addr = '0x' + 'f1'.repeat(20);
  db.upsertAddressMeta({ address: addr, isContract: true, kind: 'token', codeHash: '0xabc', codeSize: 1234 });
  db.setAddressIdentity(addr, 'Synthra Perpetual Liquidity Token', 'SYNPLP');
  const m = db.addressMeta(addr);
  assert.equal(m.token_name, 'Synthra Perpetual Liquidity Token');
  assert.equal(m.token_symbol, 'SYNPLP');
  assert.equal(m.kind, 'token', 'the deriver\'s classification survives');
  assert.equal(m.code_hash, '0xabc', 'and so does its bytecode fingerprint');

  // A contract that answers nothing is still recorded as asked, so the next pass spends its budget
  // on an address that has not been.
  const mute = '0x' + 'f2'.repeat(20);
  db.setAddressIdentity(mute, null, null);
  assert.equal(db.addressMeta(mute).token_name, null);
  assert.ok(db.addressMeta(mute).identity_checked > 0, 'asked and answered nothing is a recorded answer');

  // The marker has to be distinct from `checked`, which contract discovery also writes. Sharing one
  // column would make every silent contract look un-probed forever, so each pass would re-ask the
  // same addresses and never reach the ones that would actually answer.
  const discovered = '0x' + 'f4'.repeat(20);
  db.markContract(discovered, true, 900);
  const dm = db.addressMeta(discovered);
  assert.ok(dm.checked > 0, 'discovery records that it looked at the address');
  assert.equal(dm.identity_checked, null, 'but that is not the same as having asked its name');

  // Silence is not an answer until it repeats. rpcSoft leaves a slot undefined both when a call
  // reverted (no such method) and when it was refused (rate limit) — opposite facts arriving
  // identically. Settling on the first silence wrote off 53 addresses as nameless while the chain
  // answered 'Synthra Perpetual Liquidity Token' for one of them on the very next call.
  const quiet = '0x' + 'f6'.repeat(20);
  for (let i = 1; i < db.IDENTITY_MAX_ATTEMPTS; i++) {
    db.noteIdentityAttempt(quiet);
    assert.equal(db.addressMeta(quiet).identity_checked, null, `attempt ${i} does not settle it`);
  }
  db.noteIdentityAttempt(quiet);
  assert.ok(db.addressMeta(quiet).identity_checked > 0, 'repeated silence does settle it');
  assert.equal(db.addressMeta(quiet).identity_attempts, db.IDENTITY_MAX_ATTEMPTS);

  // An answer settles it immediately, however many attempts came before.
  const late = '0x' + 'f7'.repeat(20);
  db.noteIdentityAttempt(late);
  assert.equal(db.addressMeta(late).identity_checked, null);
  db.setAddressIdentity(late, 'Answered At Last', 'ALA');
  assert.ok(db.addressMeta(late).identity_checked > 0);
  assert.equal(db.addressMeta(late).token_name, 'Answered At Last');

  // Two writers touch this table. The entity deriver does not always read a name, and assignment
  // let a pass that learned nothing erase one the balance scanner had already found — the named
  // count was observed dropping between passes. A name does not become unknown again.
  db.upsertAddressMeta({ address: addr, isContract: true, kind: 'proxy', codeSize: 4321 });
  assert.equal(db.addressMeta(addr).token_name, 'Synthra Perpetual Liquidity Token', 'a nameless pass does not erase a name');
  assert.equal(db.addressMeta(addr).kind, 'proxy', 'while everything the deriver did learn is applied');
  // A genuinely new name still wins, so an upgraded contract updates normally. Done on its own
  // address so the assertions below still describe the one named above.
  const renamed = '0x' + 'f5'.repeat(20);
  db.setAddressIdentity(renamed, 'Old Name', 'OLD');
  db.upsertAddressMeta({ address: renamed, isContract: true, tokenName: 'New Name', tokenSymbol: 'NEW' });
  assert.equal(db.addressMeta(renamed).token_name, 'New Name');
  assert.equal(db.addressMeta(renamed).token_symbol, 'NEW');

  // Bulk read, which is what decorates the candidate list.
  const ids = db.addressIdentities([addr, mute, '0x' + 'f3'.repeat(20)]);
  assert.equal(ids.get(addr).token_symbol, 'SYNPLP');
  assert.ok(!ids.has('0x' + 'f3'.repeat(20)), 'an address never seen is absent, not null-filled');
});

// ---- one asset can be deployed more than once ----
test('a symbol with two contracts is measured across both, not by whichever came last', async () => {
  const { CHAIN } = await import('../chains.js');
  const { TOKEN_SYMBOLS } = await import('../constants.js');
  const { getLabel } = await import('../labels.js');

  const bySymbol = {};
  for (const [addr, m] of Object.entries(CHAIN.tokens)) (bySymbol[m.symbol] ||= []).push(addr);

  // Arc testnet carries two independent USYC deployments. Only the dormant one was tracked, so the
  // site published a supply of 1.38M and a volume of zero for an asset that was moving 722 transfers
  // over the same window the tracked contract moved one.
  assert.equal(bySymbol.USYC.length, 2, 'both USYC contracts are tracked');
  assert.ok(bySymbol.USYC.includes('0x825ae482558415310c71b7e03d2bbbe409345903'), 'including the live one');

  // The symbol set stays deduplicated — two contracts describe one asset, and every stored figure is
  // keyed by symbol.
  assert.equal([...TOKEN_SYMBOLS].filter((s) => s === 'USYC').length, 1);

  // Both addresses label as the asset, so neither shows up as an anonymous contract in a feed.
  for (const a of bySymbol.USYC) assert.equal(getLabel(a).name, 'USYC');

  // USDT is 18 decimals here, not the 6 it uses on Ethereum. Hardcoding 6 anywhere would overstate
  // every USDT figure by a factor of a trillion.
  assert.equal(CHAIN.tokens['0x175cdb1d338945f0d851a741ccf787d343e57952'].decimals, 18);

  // The wrapper is deliberately absent: its supply is exactly the USDC it custodies, so tracking it
  // would count the same dollars twice — once as USDC, once as WUSDC.
  assert.ok(!CHAIN.tokens['0x911b4000d3422f482f4062a913885f7b035382df'], 'Wrapped USDC is not tracked as issuance');
});

// ---- whale-content drafting (reserved for mainnet — see whalewatch.js) ----
test('whalewatch: threshold filtering, drafting, and dedupe', async () => {
  const db = await import('../db.js');
  const { evaluate, draftText, TWEET_WORTHY_MIN } = await import('../whalewatch.js');

  const small = { kind: 'transfer', token: 'USDC', amount: 500, from: '0x' + '5'.repeat(40), to: '0x' + '6'.repeat(40), block: 1 };
  const big = { kind: 'transfer', token: 'USDC', amount: 300000, from: '0x' + '5'.repeat(40), to: '0x' + '6'.repeat(40), block: 2 };
  const mint = { kind: 'mint', token: 'EURC', amount: 400000, from: '0x'.padEnd(42, '0'), to: '0x' + '7'.repeat(40), block: 3 };

  const drafts = evaluate([small, big, mint]);
  assert.equal(drafts.length, 2, 'only events at/above the threshold become drafts');
  assert.ok(drafts.every((d) => d.amount >= TWEET_WORTHY_MIN));

  assert.match(draftText(big), /testnet/i, 'drafted text always flags testnet — never implies real value');
  assert.match(draftText(mint), /minted/);
  assert.doesNotMatch(draftText(big), /\$/, 'no dollar sign — these are token units, not USD');

  // Persist + dedupe: the same on-chain event must never produce two stored drafts.
  const d = drafts[0];
  const first = db.createTweetDraft({ kind: d.kind, token: d.token, amount: d.amount, frm: d.from, too: d.to, block: d.block, dedupeKey: d.dedupeKey, text: d.text });
  const second = db.createTweetDraft({ kind: d.kind, token: d.token, amount: d.amount, frm: d.from, too: d.to, block: d.block, dedupeKey: d.dedupeKey, text: d.text });
  assert.equal(first, true, 'first insert is new');
  assert.equal(second, false, 'replaying the same event is a no-op, not a duplicate draft');
  assert.equal(db.pendingTweetDrafts().filter((r) => r.dedupe_key === d.dedupeKey).length, 1);

  db.close(); // last test in the file — safe to close the shared connection here
});

// ---- usage counting (usage.js) ----
// The point of these is that the table cannot be made to grow without bound by a stranger, and
// that nothing identifying can end up in it. Both are properties of normalizePath alone, so they
// are testable without a database.

test('usage: only the machine-readable surfaces are counted', () => {
  assert.equal(normalizePath('/openapi.json'), '/openapi.json');
  assert.equal(normalizePath('/llms.txt'), '/llms.txt');
  assert.equal(normalizePath('/v1/tokens'), '/v1/tokens');
  // the dashboard's own calls are the site talking to itself — already covered by Umami
  assert.equal(normalizePath('/api/state'), null);
  assert.equal(normalizePath('/'), null);
  assert.equal(normalizePath('/methodology'), null);
});

test('usage: the route shape is kept, only parameters are replaced', () => {
  // The endpoints must stay distinguishable — knowing /v1 was called is not the question,
  // knowing which endpoint was called is.
  assert.equal(normalizePath('/v1/tvl'), '/v1/tvl');
  assert.equal(normalizePath('/v1/tvl/history'), '/v1/tvl/history');
  assert.notEqual(normalizePath('/v1/tvl'), normalizePath('/v1/tvl/history'));
  assert.notEqual(normalizePath('/v1/addresses/top'), normalizePath('/v1/addresses/filtered'));
  assert.equal(normalizePath('/v1/network/fees'), '/v1/network/fees');
});

test('usage: an address cannot create a row of its own', () => {
  const a = '/v1/address/0x' + 'ab'.repeat(20);
  const b = '/v1/address/0x' + 'cd'.repeat(20);
  assert.equal(normalizePath(a), '/v1/address/:id');
  assert.equal(normalizePath(a), normalizePath(b), 'two addresses must share one row');
  // and the address itself must not survive into the label
  assert.ok(!/0x[0-9a-f]{6,}/i.test(normalizePath(a)));
});

test('usage: a probe cannot write arbitrary bytes into the table', () => {
  for (const junk of [
    "/v1/'; DROP TABLE hits;--",
    '/v1/<script>alert(1)</script>',
    '/v1/' + 'x'.repeat(500),
    '/v1/a b',
    'not-a-path',
    null,
    undefined,
    42,
  ]) {
    const out = normalizePath(junk);
    assert.ok(out === null || /^\/v1(\/(:id|[a-z0-9._-]+))*$/.test(out), `leaked: ${JSON.stringify(out)}`);
    if (out) assert.ok(out.length <= 60);
  }
});

test('usage: only successful responses count, so failures cannot inflate the numbers', () => {
  assert.equal(countable(200), true);
  assert.equal(countable(304), true);
  assert.equal(countable(401), false);
  assert.equal(countable(404), false);
  assert.equal(countable(429), false);
  assert.equal(countable(500), false);
});

test('usage: days are UTC midnights, so a bucket means the same thing everywhere', () => {
  const d = dayOf(Date.UTC(2026, 7, 23, 13, 45, 0));
  assert.equal(d, Math.floor(Date.UTC(2026, 7, 23) / 1000));
  assert.equal(d % 86400, 0);
  // every instant of a UTC day lands in the same bucket
  assert.equal(dayOf(Date.UTC(2026, 7, 23, 0, 0, 0)), dayOf(Date.UTC(2026, 7, 23, 23, 59, 59)));
});

test('usage: a key is never rendered in full', () => {
  const key = 'sbd_' + 'a'.repeat(32);
  const shown = keyPrefix(key);
  assert.ok(!shown.includes(key), 'the whole key must never be returned');
  assert.ok(shown.length < key.length);
  assert.ok(shown.startsWith('sbd_'));
  assert.equal(keyPrefix(null), '—');
  assert.equal(keyPrefix('not-a-key'), '—');
});
