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

  db.close();
});
