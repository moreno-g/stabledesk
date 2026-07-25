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
  const { noiseLimits, feeMetrics } = await import('../indexer.js');
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
