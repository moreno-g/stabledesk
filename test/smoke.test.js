// Smoke tests — pure logic + a DB round-trip. No network, no RPC.
// Run: npm test   (uses the built-in node:test runner — still zero dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.deepEqual([...TOKEN_SYMBOLS].sort(), ['EURC', 'USDC', 'USYC']);
  assert.ok(TIERS.free.rpm < TIERS.pro.rpm);
  for (const r of Object.values(RANGES)) { assert.ok(r.span > 0 && r.group > 0); }
});

// ---- DB round-trip (isolated temp database) ----
test('db round-trips keys, buckets, addresses', async () => {
  process.env.DB_PATH = join(tmpdir(), `stabledesk-test-${process.pid}-${Date.now()}.db`);
  const db = await import('../db.js');

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
  const { noiseLimits, feeMetrics, isNoiseTransfer } = await import('../indexer.js');
  const { NOISE_FILTER } = await import('../constants.js');

  // Thresholds scale with retained history, but never drop below a full day — otherwise a
  // freshly-booted indexer holding 25 minutes of backfill would flag ordinary addresses.
  assert.equal(noiseLimits(0).days, 1, 'window is floored at one day');
  assert.equal(noiseLimits(3600).days, 1, 'an hour of history still uses the one-day floor');
  assert.equal(noiseLimits(7 * 86400).days, 7);
  assert.equal(noiseLimits(7 * 86400).maxTransfers, NOISE_FILTER.txPerDay * 7);

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
  const capLim = noiseLimits(7 * 86400);
  const capped = db.noisyAddresses(capLim.maxTransfers, capLim.maxVolume);
  const qualifying = db.noisyAddressCount(capLim.maxTransfers, capLim.maxVolume);
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
    [bot, { transfers: 5000, volume: 10, lastBlock: 900 }],      // flagged on frequency alone
    [human, { transfers: 3, volume: 10, lastBlock: 900 }],
  ]), []);
  const lim = noiseLimits(86400);
  const flagged = db.noisyAddresses(lim.maxTransfers, lim.maxVolume).map((r) => r.address);
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
