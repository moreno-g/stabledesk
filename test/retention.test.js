// Retention against the clock its rows are keyed by — the correction of 30 October 2026. Every rolling
// table but TVL history holds chain time, and the windows that read them end at the newest indexed
// minute; prune() cut them back from the wall clock, so a halted chain — the RPC answering, the head
// standing still, the ticks and their prunes still running — lost a little more of what the windows read
// with every prune. Each test fails on the code before that date, except three that pin what must not
// change with it: TVL history on the wall clock, a moving chain's cuts, and a chain clock running ahead
// of ours. No network: the one subprocess refuses every fetch.
// Run: npm test   (node --test picks this file up beside smoke.test.js)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

// Same rule as smoke.test.js: db.js binds its file at first import, so the path is set before any
// dynamic import, and nothing imported statically here may reach db.js.
process.env.DB_PATH = join(tmpdir(), `stabledesk-retention-${process.pid}-${Date.now()}.db`);

const removeDb = (p) => { for (const ext of ['', '-wal', '-shm']) rmSync(p + ext, { force: true }); };
after(() => removeDb(process.env.DB_PATH));

// Preloaded into the subprocess: every fetch is refused, so the indexer finds the chain unreachable.
const OFFLINE = 'data:text/javascript,' + encodeURIComponent(`
  globalThis.fetch = async () => { throw new Error('offline: tests make no network calls'); };`);

const H = 3600, D = 86400;
const NOW = Math.floor(Date.now() / 1000);
const T = Math.floor(NOW / 60) * 60 - 8 * D;      // the newest indexed minute: the chain stopped 8 days ago
const HEAD = 5_000_000;                           // the head block, standing still since then
const A = '0x' + 'a7'.repeat(20), B = '0x' + 'b8'.repeat(20);
const SEEDED = 9 * 24 + 1;                        // minutes seeded: nine days of them, an hour apart, up to T
// How many of the seeded minutes fall on UTC day `day` (a day number) or after it.
const seededSince = (day) => [...Array(SEEDED).keys()].filter((i) => Math.floor((T - i * H) / D) >= day).length;

// Nine days of USDC up to T, one minute an hour, and everything the indexer writes beside it: CCTP flows,
// fee samples, raw transfers, the per-day counts of the address that sent them.
function seed(db) {
  const buckets = new Map(), flows = new Map(), fees = [], recents = [];
  const a = { transfers: 0, volume: 0, lastBlock: HEAD, firstBlock: HEAD - SEEDED, byTokenDay: {} };
  for (let i = 0; i < SEEDED; i++) {
    const minute = T - i * H, block = HEAD - i, day = Math.floor(minute / D);
    buckets.set(minute, { minute, token: 'USDC', volume: 3000, cnt: 3, mint: 0, burn: 0, rvolume: 1000, rcnt: 1, avolume: 800, acnt: 1 });
    flows.set(minute, { minute, token: 'USDC', dir: 'in', domain: 0, amount: 10, cnt: 1 });
    fees.push({ block, minute, fees: 0.01, txs: 2, gasUsed: 42000, buckets: [[3, 2]] });
    recents.push({ block, ts: minute, token: 'USDC', frm: A, too: B, amount: 1000 + i });
    const t = a.byTokenDay[day] || (a.byTokenDay[day] = { token: 'USDC', day, transfers: 0, volume: 0 });
    t.transfers += 1; t.volume += 1000;
    a.transfers += 1; a.volume += 1000;
  }
  db.applyBatch(buckets, new Map([[A, a]]), recents, flows);
  db.insertFeeSamples(fees);
  db.setCheckpoint(HEAD);
}

// What the snapshot's windows read, from where it anchors them (dbDerived in indexer.js), and a 7-day
// window of per-day counts: the anchor's UTC day and the six before it.
async function windows(db) {
  const { windowEndSec } = await import('../indexer.js');
  const asOf = windowEndSec(Math.floor(Date.now() / 1000), db.getCoverage().b, true);
  return {
    asOf,
    summary24h: db.getSummary(asOf - D),
    fees24h: db.feeStats(asOf - D),
    feeBuckets24h: db.feeBucketCounts(asOf - D),
    cctp24h: db.cctpFlows(asOf - D),
    chart7d: db.getHistory('USDC', asOf - 7 * D, H),
    largest7d: db.getLargest(8, asOf - 7 * D),
    moved7d: db.movedForAddresses([A], Math.floor(asOf / D) - 6),
    transfers: db.recentWindow(),
  };
}

describe('a database frozen for eight days', () => {
  let db, live;
  const tvlOld = Math.floor((NOW - 184 * D) / D) * D;   // older than 180 days by the wall clock, not by T
  const tvlKept = Math.floor((NOW - 100 * D) / D) * D;

  before(async () => {
    db = await import('../db.js');
    seed(db);
    db.recordTvlSnapshot(tvlOld, [{ protocol: 'retention-test', tvl: 1 }]);
    db.recordTvlSnapshot(tvlKept, [{ protocol: 'retention-test', tvl: 1 }]);
    // The last prune while the chain moved, then the halt: one every PRUNE_EVERY ticks, each given the
    // wall clock, as indexer.js gives it — a day apart here, the last one now.
    db.prune(T, HEAD, 500);
    live = await windows(db);
    for (let k = 1; k < 8; k++) db.prune(T + k * D, HEAD, 500);
    db.prune(Math.floor(Date.now() / 1000), HEAD, 500);
  });

  test('its windows read what they read when the chain stopped', async () => {
    // Eight days of prunes later. Cut from the wall clock, the per-day counts lost their first days from
    // the third, the raw transfers were gone after one, and after a week the minute table was empty: no
    // newest minute, every window back on the wall clock, every 24-hour figure 0.
    assert.equal(db.getCoverage().b, T, 'the newest indexed minute is still the one the chain stopped at');
    assert.deepEqual(await windows(db), live, 'pruning through the halt took nothing a window reads');

    // And what they read is the seed: 25 hourly minutes in a day with both ends counted, and seven full
    // days of per-day counts.
    assert.equal(live.asOf, T);
    assert.equal(live.summary24h.rvolume, 25 * 1000);
    assert.equal(live.fees24h.blocks, 25);
    assert.equal(live.moved7d.byToken.USDC, seededSince(Math.floor(T / D) - 6) * 1000);
    assert.equal(live.transfers.rows, 25, 'a day of raw transfers back from T');
  });

  test('its snapshot still serves the 24-hour figures and the week behind them', async () => {
    // The real indexer on this database, the chain unreachable: the degraded snapshot the site serves.
    const { execFileSync } = await import('node:child_process');
    const script = `
      const idx = await import('./indexer.js');
      await idx.start();
      idx.stop();
      const s = idx.live.snapshot;
      process.stdout.write('\\n' + JSON.stringify({ ok: s.ok, degraded: s.degraded, windowEnd: s.windowEnd, dataAt: s.dataAt,
        rvolume24h: s.summary24h.rvolume, feeBlocks: s.fees && s.fees.sampledBlocks, largest: s.largest.length,
        transfers: s.transferWindow.rows, toMinute: s.coverage.toMinute }) + '\\n', () => process.exit(0));`;
    const out = execFileSync(process.execPath, ['--import', OFFLINE, '--input-type=module', '-e', script], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ARC_NETWORK: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
      stdio: 'pipe', timeout: 30000,
    });
    const s = JSON.parse(String(out).trim().split('\n').at(-1));
    assert.deepEqual(s, { ok: true, degraded: true, windowEnd: T * 1000, dataAt: T * 1000, rvolume24h: 25 * 1000,
      feeBlocks: 25, largest: 8, transfers: 25, toMinute: T });
  });

  test('the minutes older than its week are in the daily rollup, each once', async () => {
    // Roll up, then delete: what left the minute table before T's week is in buckets_daily, and the two
    // together still hold every seeded minute — through nine prunes, none counted twice.
    const firstDay = Math.floor((T - (SEEDED - 1) * H) / D) * D;
    assert.equal(db.getCoverage().a, T - 7 * D);
    assert.equal(db.getDailyHistory('USDC', firstDay).reduce((n, r) => n + r.rvolume, 0), SEEDED * 1000);
  });

  test('TVL history is still cut by the wall clock', async () => {
    // A balance is recorded on the day it is read, so its 180 days are counted back from today.
    assert.equal(db.tvlOn('retention-test', tvlOld), null, 'past 180 days of the wall clock: gone');
    assert.equal(db.tvlOn('retention-test', tvlKept), 1);
  });
});

test('the method says which clock the retentions follow, and dates the correction', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'public/methodology.html'), 'utf8');
  const start = page.indexOf('<h2>How much history, and of what</h2>');
  const flat = page.slice(start, page.indexOf('<h2>', start + 4)).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  assert.match(flat, /counted back from the newest indexed minute, never from later than now/);
  assert.match(flat, /TVL history[^.]*follows the wall clock/);
  assert.match(flat, /Corrected on 30 October 2026: the retentions followed the wall clock/);
});

test('once the chain moves again, the cuts are back to a week before now', async () => {
  const db = await import('../db.js');
  const now = Math.floor(Date.now() / 1000), m = Math.floor(now / 60) * 60, day = Math.floor(m / D);
  db.applyBatch(new Map([[m, { minute: m, token: 'USDC', volume: 5, cnt: 1, mint: 0, burn: 0, rvolume: 5, rcnt: 1 }]]),
    new Map([[A, { transfers: 1, volume: 5, lastBlock: HEAD + 1, firstBlock: HEAD + 1,
      byTokenDay: { x: { token: 'USDC', day, transfers: 1, volume: 5 } } }]]),
    [{ block: HEAD + 1, ts: m, token: 'USDC', frm: A, too: B, amount: 5 }]);
  db.prune(now, HEAD + 1, 500);

  // Everything from before the halt is older than a week now: rolled into its days, or out of the windows.
  assert.equal(db.getCoverage().a, m);
  assert.equal(db.feeStats(0).blocks, 0);
  assert.equal(db.recentWindow().rows, 1);
  assert.equal(db.cctpFlows(0).length, 0);
  // A week plus the day in progress of per-day counts: T's day, eight days back, stays.
  assert.equal(db.movedForAddresses([A], 0).byToken.USDC, seededSince(day - 8) * 1000 + 5);
  assert.equal(db.getDailyHistory('USDC', 0).reduce((n, r) => n + r.rvolume, 0), SEEDED * 1000 + 5);
});

test('chain time ahead of the wall clock never moves a cut past now', async () => {
  const db = await import('../db.js');
  const now = Math.floor(Date.now() / 1000), m = Math.floor(now / 60) * 60, inWeek = m - 7 * D + 600;
  const one = (minute) => [minute, { minute, token: 'AHEAD', volume: 1, cnt: 1, mint: 0, burn: 0 }];
  db.applyBatch(new Map([one(m + H), one(inWeek)]), new Map(), []);
  db.prune(now, HEAD + 1, 500);
  assert.ok(db.getHistory('AHEAD', 0, 60).some((p) => p.t === inWeek), 'a minute within the week before now is kept');
});
