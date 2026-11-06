// The flag set's block time: what turns each address's sent span, counted in blocks, into days.
// Run: npm test. No network — the real indexer runs in a subprocess against a chain answered from memory.
//
// Nothing here imports db.js into this process: every database is a temp file owned by one subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 86_400_000;

// Block n is stamped T0 + n × 507.5 ms, rounded down to the second as Arc's headers are. 507.5 ms is Arc
// mainnet's average over the 6.8M blocks of sent history held on 6 Nov 2026; kept as a fraction so every
// stamp is exact integer arithmetic. T0 puts the head near the wall clock.
const RATE = [5075, 10000];
const T0 = Math.floor(Date.now() / 1000) - Math.floor((30_000_000 * RATE[0]) / RATE[1]);
const stamp = (n) => T0 + Math.floor((n * RATE[0]) / RATE[1]);

// What the indexer's fifteen newest headers read at a given head — fourteen intervals of whole seconds,
// so 7 s (500 ms) most of the time on this chain and 8 s (571.4 ms) when the rounding falls the other way.
const liveSample = (head) => ((stamp(head) - stamp(head - 14)) / 14) * 1000;
const headReading = (ms) => { let h = 30_000_000; while (Math.abs(liveSample(h) - ms) > 0.1) h++; return h; };

// Three senders with about 41 days of sent history, judged on volume: past 30 days the monthly $10M
// limit scales with the span in days. EDGE sent $14.5M — over its limit at the chain's 507.5 ms
// ($13.70M), under it at 571.4 ms ($15.43M).
const addr = (c) => '0x' + c.repeat(40);
const STEADY = addr('a'), EDGE = addr('b'), QUIET = addr('c');
const SENT_HISTORY = 7_000_000;   // blocks back from the boot head to the first block of sent history

const seed = (bootHead) => {
  const first = bootHead - SENT_HISTORY + 100, last = bootHead - 1000;
  const row = (sentVolume) => ({ transfers: 100, volume: sentVolume, lastBlock: last, firstBlock: first, sentTransfers: 100, sentVolume, sentFirst: first, sentLast: last });
  const rows = [[STEADY, row(50e6)], [EDGE, row(14.5e6)], [QUIET, row(1e6)]];
  // A deployment that has been running for weeks: indexed up to the head, sent history re-read down to its
  // first block, every one-off pass finished — so the only RPC traffic is the live poll's.
  const meta = {
    index_from: bootHead - 8_000_000,
    sent_live_from: bootHead - 200_000, sent_seed_hi: bootHead - SENT_HISTORY - 1,
    sent_history_since: stamp(bootHead - SENT_HISTORY), sent_seed_done: 1,
    cctp_live_from: 0, cctp_backfill_done: 1, reroute_live_from: 0, reroute_done: 1, refile_live_from: 0, refile_done: 1,
  };
  return `
    db.setCheckpoint(${bootHead - 1});
    for (const [k, v] of Object.entries(${JSON.stringify(meta)})) db.setMetaValue(k, v);
    db.applyBatch(new Map(), new Map(${JSON.stringify(rows)}), []);`;
};

// Preloaded into the indexer's process: a JSON-RPC endpoint answered from memory. The poll's head read
// lands a minute after boot with the head a minute of blocks further on, as on a deployment that has been
// up for a while: past the flag set's one-minute refresh, which is the step under test. Blocks below
// `servedFrom` answer as a pruned node does.
const fakeChain = ({ bootHead, tickHead, servedFrom = 0 }) => 'data:text/javascript,' + encodeURIComponent(`
  const stamp = (n) => ${T0} + Math.floor((n * ${RATE[0]}) / ${RATE[1]});
  const hex = (n) => '0x' + n.toString(16);
  const realNow = Date.now;
  let head = ${bootHead}, skew = 0;
  Date.now = () => realNow() + skew;
  const answer = ({ method, params }) => {
    switch (method) {
      case 'eth_blockNumber': return { result: hex(head) };
      case 'eth_gasPrice': return { result: hex(1e9) };
      case 'eth_getBlockByNumber': {
        const n = parseInt(params[0], 16);
        if (n < ${servedFrom}) return { error: { code: -32000, message: 'pruned history unavailable' } };
        return { result: n > head ? null : { number: hex(n), timestamp: hex(stamp(n)), transactions: [] } };
      }
      case 'eth_getLogs': case 'eth_getBlockReceipts': return { result: [] };
      case 'eth_call': return { result: '0x' + '0'.repeat(64) };
      case 'eth_getCode': return { result: '0x' };
      default: return { error: { code: -32601, message: 'not answered by the fake chain: ' + method } };
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    if (!new URL(String(url)).hostname.endsWith('.arc.io')) throw new Error('offline: tests make no network calls');
    const calls = [].concat(JSON.parse(init.body));
    if (head !== ${tickHead} && calls.some((c) => c.method === 'eth_gasPrice')) { head = ${tickHead}; skew += 61000; }
    const out = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, ...answer(c) }));
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };`);

const OFFLINE = 'data:text/javascript,' + encodeURIComponent(
  "globalThis.fetch = async () => { throw new Error('offline: tests make no network calls'); };");

// Boots the real indexer on its own database — boot, one poll — and returns what the site then serves.
function serve(dbPath, preload, setup = '') {
  const script = `
    const db = await import('./db.js');
    const idx = await import('./indexer.js');
    ${setup}
    await idx.start();
    idx.stop();
    const s = idx.live.snapshot;
    process.stdout.write('\\n' + JSON.stringify({ sample: s.network?.blockTimeMs ?? null, noise: s.noise }) + '\\n', () => process.exit(0));`;
  // A timeout, because a synchronous wait blocks the event loop and no test timeout could fire.
  const out = execFileSync(process.execPath, ['--import', preload, '--input-type=module', '-e', script], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, DB_PATH: dbPath, ARC_NETWORK: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
    stdio: 'pipe',
    timeout: 30000,
  });
  return JSON.parse(String(out).trim().split('\n').at(-1));
}

const dropDb = (dbPath) => { for (const ext of ['', '-wal', '-shm']) rmSync(dbPath + ext, { force: true }); };
const flagged = (r) => r.noise.top.map((a) => a.address);

test('the flag set does not move when the live block-time sample does', () => {
  // Two deployments of the same chain whose poll lands on a head where the fifteen newest headers read
  // 500 ms, and on one where they read 571.4 ms. On 6 Nov 2026 the set computed at that sample went
  // 229, 242, 256 within the hour on Arc mainnet.
  const runs = [500, 8000 / 14].map((ms) => {
    const tickHead = headReading(ms), bootHead = tickHead - 120;
    const dbPath = join(tmpdir(), `stabledesk-test-clock-${process.pid}-${Math.round(ms)}.db`);
    try {
      return { tickHead, bootHead, ...serve(dbPath, fakeChain({ bootHead, tickHead }), seed(bootHead)) };
    } finally {
      dropDb(dbPath);
    }
  });
  const [at500, at571] = runs;
  assert.equal(at500.sample, 500, 'the live strip reads 500 ms on the first head');
  assert.equal(Math.round(at571.sample * 10) / 10, 571.4, 'and 571.4 ms on the second');

  assert.deepEqual(flagged(at571), flagged(at500), 'the same addresses are flagged whichever way the live sample fell');
  assert.equal(at571.noise.qualifying, at500.noise.qualifying);
  assert.deepEqual(flagged(at500), [STEADY, EDGE], "EDGE is over its limit at the chain's own block time; QUIET is under it");

  for (const r of runs) {
    // Published: the block time the set was computed at — measured from the first block of sent history
    // to the head, not the live sample — and the two blocks, so it can be redone from their headers.
    assert.ok(Math.abs(r.noise.blockMs - 507.5) < 0.001, `blockMs ${r.noise.blockMs}, expected 507.5`);
    assert.deepEqual(r.noise.blockMsMeasured, { fromBlock: r.bootHead - SENT_HISTORY, toBlock: r.tickHead });
    // Each address's window is its sent span at that rate, floored at 30 days: the published blockMs is
    // the one that produced the published limits.
    for (const a of r.noise.top) {
      const days = Math.max(30, ((a.sentLastBlock - a.sentFirstBlock) * r.noise.blockMs) / DAY_MS);
      assert.ok(Math.abs(a.windowDays - days) < 1e-9, `${a.address}: window ${a.windowDays} days, ${days} at the published blockMs`);
    }
  }
});

test('when the long-range clock cannot be read, the set is converted at a measured one, never at the live sample', () => {
  const tickHead = headReading(8000 / 14), bootHead = tickHead - 120;
  const dbPath = join(tmpdir(), `stabledesk-test-clock-${process.pid}-fallback.db`);
  try {
    // A pruned node: the first block of sent history is no longer served, the header the boot measure
    // reads 2,000 blocks back is. The clock runs from that one.
    const pruned = serve(dbPath, fakeChain({ bootHead, tickHead, servedFrom: bootHead - 100_000 }), seed(bootHead));
    assert.equal(Math.round(pruned.sample * 10) / 10, 571.4);
    assert.ok(Math.abs(pruned.noise.blockMs - 507.5) < 0.5, `blockMs ${pruned.noise.blockMs}: whole seconds over 2,120 blocks`);
    assert.deepEqual(flagged(pruned), [STEADY, EDGE]);
    assert.deepEqual(pruned.noise.blockMsMeasured, { fromBlock: bootHead - 2000, toBlock: tickHead });

    // A restart while the chain is unreachable computes the set at the last measure, kept in the database,
    // rather than at the boot default — and publishes that one.
    const offline = serve(dbPath, OFFLINE);
    assert.equal(offline.sample, null, 'nothing live was measured');
    assert.equal(offline.noise.blockMs, pruned.noise.blockMs);
    assert.deepEqual(offline.noise.blockMsMeasured, pruned.noise.blockMsMeasured);
    assert.deepEqual(flagged(offline), flagged(pruned));
  } finally {
    dropDb(dbPath);
  }
});
