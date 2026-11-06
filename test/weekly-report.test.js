// The weekly report generator: scripts/weekly-report.mjs, and weekly.mjs and weekly-chain.mjs behind it.
// No network. The series and the RPC answers are the ones recorded on 6 November 2026 for the first
// report's week (test/fixtures/weekly-2026-11-06), and that report, as published, is what the generator
// is held to.
//
// The committed example draft in that folder is regenerated from the recording and compared byte for
// byte below. After a deliberate change to the draft's wording, regenerate it with:
//
//   node scripts/weekly-report.mjs --date 2026-11-06 --replay test/fixtures/weekly-2026-11-06 --out test/fixtures/weekly-2026-11-06 --force

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPORTS } from '../reports.js';
import {
  addDays, assertSeriesCovers, buildReport, candidates, daysBetween, firstCompleteDay, parseHistory, records, registryEntry, renderBody,
  renderNotes, reportWindow, rollingWeeks, sumWindow, supplyChecks, supplyReadDays, thread, unmatchedFigures, usd, usdSigned, weekFigures,
  xLength, X_LIMIT,
} from '../scripts/weekly.mjs';
import { chainReader, dayCloser, lastBlockBefore, makeRpc, replayFetch, retryingFetch } from '../scripts/weekly-chain.mjs';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = 'test/fixtures/weekly-2026-11-06';
const load = (f) => JSON.parse(readFileSync(join(ROOT, FIXTURE, f), 'utf8'));
const hist = parseHistory(load('series.json'));
const recorded = load('rpc.json').calls;

// Preloaded into the CLI subprocesses: any fetch at all fails the run.
const OFFLINE = 'data:text/javascript,' + encodeURIComponent(
  "globalThis.fetch = async () => { throw new Error('offline: tests make no network calls'); };");
const cli = (args) => spawnSync(process.execPath, ['--import', OFFLINE, 'scripts/weekly-report.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });

// Preloaded instead to run the CLI's live path offline: the site and the RPC, played from the recording.
// The site answers its first request with a 502, as it did during a redeploy on 6 November, and refuses
// a tools/call that does not follow MCP 2026-07-28 to the letter.
const SITE_AND_RPC = 'data:text/javascript,' + encodeURIComponent(`
  import { readFileSync } from 'node:fs';
  const dir = process.env.WEEKLY_FIXTURE;
  const series = readFileSync(dir + '/series.json', 'utf8');
  const calls = JSON.parse(readFileSync(dir + '/rpc.json', 'utf8')).calls;
  const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let mcp = 0;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url === 'https://stabledesk.xyz/mcp') {
      if (mcp++ === 0) return new Response('Bad Gateway', { status: 502 });
      const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const b = JSON.parse(init.body);
      const meta = b.params?._meta || {};
      const ok = init.method === 'POST' && h['mcp-protocol-version'] === '2026-07-28' && h['mcp-method'] === 'tools/call'
        && h['mcp-name'] === 'stablecoin_history' && b.jsonrpc === '2.0' && b.method === 'tools/call' && b.params.name === 'stablecoin_history'
        && b.params.arguments?.token === 'USDC' && b.params.arguments?.range === 'all'
        && meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28' && meta['io.modelcontextprotocol/clientCapabilities'] != null;
      return ok ? json(series) : json({ jsonrpc: '2.0', id: b.id ?? null, error: { code: -32020, message: 'not MCP 2026-07-28' } }, 400);
    }
    if (url === 'https://rpc.mainnet.arc.io') {
      const r = JSON.parse(init.body);
      const k = r.method + ' ' + JSON.stringify(r.params);
      return json(Object.hasOwn(calls, k) ? { jsonrpc: '2.0', id: r.id, result: calls[k] } : { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'not recorded: ' + k } });
    }
    throw new Error('offline: ' + url);
  };`);

// The supply reads the CLI makes, answered from the recording. A call the recording does not hold
// fails, so this also pins the search to the path it took on the real chain.
async function replayedReads(published) {
  const chain = chainReader(makeRpc('https://rpc.invalid', { fetch: replayFetch(recorded), sleep: async () => {} }));
  const closeOf = dayCloser(chain);
  const reads = new Map();
  for (const day of supplyReadDays(reportWindow(published)).reverse()) {
    const b = await closeOf(day);
    reads.set(day, { block: b.number, timestamp: b.timestamp, supply: await chain.totalSupply(b.number) });
  }
  return reads;
}
const reads = await replayedReads('2026-11-06');
const model = buildReport({ hist, published: '2026-11-06', reads });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A series of `days` UTC days from `start`, every column zero unless given.
function synthetic(start, days, { recordBegan = Date.parse(`${start}T00:00:00Z`) / 1000 } = {}) {
  const t0 = Date.parse(`${start}T00:00:00Z`) / 1000;
  const zero = { volume: 0, rvolume: 0, avolume: 0, cnt: 0, mint: 0, burn: 0, cmint: 0, cburn: 0, bmint: 0, bburn: 0 };
  return parseHistory({
    chainId: 5042,
    data: {
      token: 'USDC', group: 86400, windowEnd: (t0 + days.length * 86400) * 1000, recordBegan,
      series: days.map((d, i) => ({ t: t0 + i * 86400, ...zero, ...d })),
    },
  });
}

test('the window is the last seven complete UTC days before publication, the rule the registry enforces', () => {
  assert.deepEqual(reportWindow('2026-11-06'), {
    slug: '2026-11-05', from: '2026-10-30', to: '2026-11-05', published: '2026-11-06', prev: { from: '2026-10-23', to: '2026-10-29' },
  });
  assert.deepEqual(reportWindow('2027-01-01'), {
    slug: '2026-12-31', from: '2026-12-25', to: '2026-12-31', published: '2027-01-01', prev: { from: '2026-12-18', to: '2026-12-24' },
  });
  assert.equal(reportWindow('2026-03-02').from, '2026-02-23', 'February 2026 has 28 days');
  for (const bad of ['2026-02-30', '2026-11-6', 'friday']) assert.throws(() => reportWindow(bad), /not a calendar date/);
  // Every listed report follows it, so the generator cannot draft a week the registry would refuse.
  for (const r of REPORTS) {
    const w = reportWindow(r.published);
    assert.deepEqual([w.slug, w.from, w.to], [r.slug, r.from, r.to], r.slug);
  }
});

test('the recorded series gives back every volume and flow the first report published', () => {
  const win = reportWindow('2026-11-06');
  const cur = weekFigures(sumWindow(hist, win.from, win.to));
  const prev = weekFigures(sumWindow(hist, win.prev.from, win.prev.to));
  const m = (f) => [f.raw, f.mintBurn, f.rawExMintBurn, f.real, f.adjusted].map(usd);
  assert.deepEqual(m(cur), ['5,428.3M', '3,830.0M', '1,598.3M', '1,213.6M', '266.8M']);
  assert.deepEqual(m(prev), ['4,185.4M', '2,662.5M', '1,522.9M', '1,343.3M', '335.8M']);
  assert.deepEqual([cur.cnt, prev.cnt], [823656, 919257]);
  const routes = (f) => [
    [f.cctpIn, f.cctpOut].map(usd), usdSigned(f.cctpNet),
    [f.gatewayIn, f.gatewayOut].map(usd), usdSigned(f.gatewayNet),
    [f.organicIn, f.organicOut].map(usd), usdSigned(f.organicNet), usdSigned(f.net),
  ];
  assert.deepEqual(routes(cur), [['596.5M', '110.3M'], '+486.2M', ['27.5M', '433.6M'], '−406.1M', ['1,348.0M', '1,314.1M'], '+33.9M', '+113.9M']);
  assert.deepEqual([prev.cctpNet, prev.gatewayNet, prev.organicNet, prev.net].map(usdSigned), ['+418.1M', '−352.1M', '+186.7M', '+252.8M']);

  // Changes and shares, each as the report printed it.
  const { F } = model;
  assert.deepEqual(['raw', 'mintBurn', 'rawExMintBurn', 'real', 'adjusted', 'cnt'].map((k) => F[k].change), ['+29.7%', '+43.8%', '+5.0%', '−9.7%', '−20.5%', '−10.4%']);
  assert.deepEqual(F.mbShare, { share: '94%', of: 'rise' });
  assert.deepEqual([F.organicShare, F.prevOrganicShare, F.grossShare, F.routes.sum], ['30%', '74%', '70%', '+80.1M']);
});

test('a missing figure stops the draft; a missing day counts as a day without activity', () => {
  const holed = synthetic('2026-10-01', [{ volume: 5 }, { volume: 7, rvolume: null }]);
  assert.throws(() => sumWindow(holed, '2026-10-01', '2026-10-02'), /rvolume is missing on 2026-10-02/);
  const gap = synthetic('2026-10-01', [{ volume: 5 }, { volume: 7 }]);
  gap.byDay.delete('2026-10-01');
  assert.equal(sumWindow(gap, '2026-10-01', '2026-10-02').volume, 7);
});

test('records rank the week against every seven-day UTC window since the record began, overlapping ones included', () => {
  const weeks = rollingWeeks(hist, '2026-11-05');
  // 15 September to 5 November is 52 days: windows end on 21 September at the earliest.
  assert.equal(weeks.length, 46);
  assert.deepEqual([weeks[0].from, weeks[0].to, weeks.at(-1).to], ['2026-09-15', '2026-09-21', '2026-11-05']);
  const rec = Object.fromEntries(records(weeks, '2026-11-05').map((r) => [r.key, r]));
  assert.ok(rec.raw.highest && rec.raw.rank === 1);
  // The runner-up shares six days with the week: "any seven complete UTC days" has to beat it as well.
  assert.deepEqual([rec.raw.otherHigh.from, rec.raw.otherHigh.to], ['2026-10-29', '2026-11-04']);
  assert.ok(rec.organicIn.highest && rec.organicOut.highest, 'the most on both sides, as published');
  assert.ok(!rec.real.highest && !rec.real.lowest);
  assert.equal(rec.real.rank, 17);

  // A window overlapping the week can beat it, and then the week holds no record.
  const days = Array.from({ length: 10 }, (_, i) => ({ volume: i === 2 ? 100 : 1 }));
  const syn = synthetic('2026-10-01', days);
  const r = records(rollingWeeks(syn, '2026-10-10'), '2026-10-10').find((x) => x.key === 'raw');
  assert.equal(r.value, 7);
  assert.ok(!r.highest && r.lowest);
  assert.equal(r.rank, 4);
  // A tie is not a record.
  const flat = synthetic('2026-10-01', Array.from({ length: 8 }, () => ({ volume: 1 })));
  const tie = records(rollingWeeks(flat, '2026-10-08'), '2026-10-08').find((x) => x.key === 'raw');
  assert.ok(!tie.highest && !tie.lowest && tie.rank === 1);
  // A record that began mid-day starts its first complete window the next day.
  assert.equal(firstCompleteDay(Date.parse('2026-10-01T09:30:00Z') / 1000), '2026-10-02');
  assert.equal(firstCompleteDay(Date.parse('2026-10-01T00:00:00Z') / 1000), '2026-10-01');
});

test('the closing block of each day, found on the recorded RPC answers, is the block the report published', async () => {
  const published = {
    '2026-10-22': 27365027, '2026-10-28': 28387592, '2026-10-29': 28558018, '2026-10-30': 28728445, '2026-10-31': 28898865,
    '2026-11-01': 29069284, '2026-11-02': 29239196, '2026-11-03': 29409603, '2026-11-04': 29579500, '2026-11-05': 29749315,
  };
  for (const [day, block] of Object.entries(published)) assert.equal(reads.get(day).block, block, day);
  // The last block before midnight UTC is stamped 23:59:59, and the one after it already the next day.
  assert.equal(reads.get('2026-11-05').timestamp, Date.parse('2026-11-05T23:59:59Z') / 1000);
  const next = recorded[`eth_getBlockByNumber ${JSON.stringify(['0x' + (29749316).toString(16), false])}`];
  assert.equal(Number(next.timestamp), Date.parse('2026-11-06T00:00:00Z') / 1000);
  assert.equal(reads.get('2026-11-05').supply, 1187154715763180n, '1,187.2M, in micro-dollars');
  assert.equal(usd(Number(reads.get('2026-10-22').supply) / 1e6), '820.5M');
});

test('the search brackets from any known block and returns the last block stamped strictly before the instant', async () => {
  // About two blocks a second in whole-second stamps, unevenly: several blocks share each second.
  const ts = (n) => 1_790_000_000 + Math.floor(n * 0.5077 + 0.3 * Math.sin(n));
  const head = { number: 2_000_000, timestamp: ts(2_000_000) };
  let calls = 0;
  const getBlock = async (n) => { calls++; return { number: n, timestamp: ts(n) }; };
  const at = (n) => ({ number: n, timestamp: ts(n) });
  for (const [anchor, rate] of [[head, 0.5077], [at(0), 0.6], [at(1_500_000), 0.45]]) {
    for (const t of [ts(10) + 1, ts(123_456), ts(1_999_999), ts(777_777) + 1]) {
      const b = await lastBlockBefore(t, { getBlock, anchor, head, secondsPerBlock: rate });
      assert.ok(ts(b.number) < t && ts(b.number + 1) >= t, `${t} from ${anchor.number}: got ${b.number}`);
    }
  }
  // From a near anchor at the right rate, a day back costs a handful of reads, not a full bisection.
  calls = 0;
  await lastBlockBefore(ts(2_000_000 - 170_000), { getBlock, anchor: head, head, secondsPerBlock: 0.5077 });
  assert.ok(calls <= 15, `${calls} reads`);
  await assert.rejects(lastBlockBefore(head.timestamp + 10, { getBlock, anchor: head, head, secondsPerBlock: 0.5 }), /has not reached/);
  await assert.rejects(lastBlockBefore(ts(0), { getBlock, anchor: head, head, secondsPerBlock: 0.5 }), /no block before/);
});

test('a rate-limited RPC is waited out and asked again; an error that is an answer is not retried', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const answers = [
    () => new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    // -32005 is the code for it (EIP-1474), whatever the message says.
    () => json({ jsonrpc: '2.0', id: 2, error: { code: -32005, message: 'request rate exceeded' } }),
    () => json({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Too Many Requests' } }),
    () => { throw new TypeError('fetch failed'); },
    () => json({ jsonrpc: '2.0', id: 5, result: '0x13b2' }),
  ];
  let i = 0;
  const rpc = makeRpc('https://rpc.test', { fetch: async () => answers[i++](), sleep });
  assert.equal(await rpc('eth_chainId'), '0x13b2');
  assert.deepEqual(waits, [2000, 1000, 2000, 4000], 'Retry-After first, then doubling from 500 ms');

  let asked = 0;
  const reverted = makeRpc('https://rpc.test', { fetch: async () => { asked++; return json({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }); }, sleep });
  await assert.rejects(reverted('eth_call', []), /execution reverted/);
  assert.equal(asked, 1);
  const refused = makeRpc('https://rpc.test', { fetch: async () => { asked++; return new Response('', { status: 400 }); }, sleep });
  await assert.rejects(refused('eth_blockNumber'), /HTTP 400/);
  assert.equal(asked, 2);

  const stuck = makeRpc('https://rpc.test', { fetch: async () => new Response('', { status: 429 }), sleep, retries: 3 });
  await assert.rejects(stuck('eth_blockNumber'), /gave up after 4 attempts \(HTTP 429\)/);
});

test('the site is asked again through a redeploy\'s 502s; any other answer comes back as it is', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const answers = [
    () => new Response('Bad Gateway', { status: 502 }),
    () => { throw new TypeError('fetch failed'); },
    () => new Response('', { status: 503, headers: { 'retry-after': '5' } }),
    () => json({ ok: true }),
  ];
  let i = 0;
  const http = retryingFetch(async () => answers[i++](), { sleep });
  assert.equal((await http('https://stabledesk.xyz/mcp', { method: 'POST' })).status, 200);
  assert.deepEqual(waits, [1000, 2000, 5000], 'doubling from a second, Retry-After when the server sends one');

  // An answer is an answer: a 401 comes back at once, for the caller to report.
  let asked = 0;
  const refused = retryingFetch(async () => { asked++; return new Response('', { status: 401 }); }, { sleep });
  assert.equal((await refused('https://stabledesk.xyz/v1/status')).status, 401);
  assert.equal(asked, 1);
  // A redeploy that never ends hands back its last answer; a network that never answers throws.
  const down = retryingFetch(async () => new Response('', { status: 502 }), { sleep, retries: 2 });
  assert.equal((await down('https://stabledesk.xyz/mcp')).status, 502);
  const unplugged = retryingFetch(async () => { throw new TypeError('fetch failed'); }, { sleep, retries: 2 });
  await assert.rejects(unplugged('https://stabledesk.xyz/mcp'), /gave up after 3 attempts \(TypeError: fetch failed\)/);
});

test('live, the CLI asks the connector as MCP 2026-07-28 requires, waits out a 502, and drafts the same report', () => {
  const out = mkdtempSync(join(tmpdir(), 'stabledesk-weekly-'));
  try {
    const r = spawnSync(process.execPath, ['--import', SITE_AND_RPC, 'scripts/weekly-report.mjs', '--date', '2026-11-06', '--out', out], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, WEEKLY_FIXTURE: join(ROOT, FIXTURE), STABLEDESK_API_KEY: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /https:\/\/stabledesk\.xyz\/mcp: HTTP 502, retrying in 1000 ms/);
    assert.equal(readFileSync(join(out, '2026-11-05.html'), 'utf8'), readFileSync(join(ROOT, FIXTURE, '2026-11-05.html'), 'utf8'));
    assert.match(readFileSync(join(out, '2026-11-05.draft.md'), 'utf8'), /Series read from the MCP connector at https:\/\/stabledesk\.xyz\/mcp \(stablecoin_history, token USDC, range all\), without a key\.$/m);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('each daily change in supply is checked against the index, and a gap is put in front of the reader', () => {
  const checks = supplyChecks(hist, reads);
  assert.equal(checks.length, 14, 'every day of both weeks');
  assert.ok(checks.every((c) => c.ok));
  assert.ok(Math.max(...checks.map((c) => Math.abs(c.gap))) < 1e-6, 'to the micro-dollar, in fact');

  // One dollar more on chain at the close of 2 November: both changes around it fail, and every
  // output says so instead of printing the sentence that says they match.
  const bad = new Map(reads);
  bad.set('2026-11-02', { ...reads.get('2026-11-02'), supply: reads.get('2026-11-02').supply + 1_000_000n });
  const m = buildReport({ hist, published: '2026-11-06', reads: bad });
  assert.deepEqual(m.checks.filter((c) => !c.ok).map((c) => [c.from, c.to]), [['2026-11-01', '2026-11-02'], ['2026-11-02', '2026-11-03']]);
  const body = renderBody(m);
  assert.match(body, /\{\{SUPPLY CHECK FAILED on 2026-11-01 → 2026-11-02, 2026-11-02 → 2026-11-03:/);
  assert.doesNotMatch(body, /equals the index's mints minus burns|daily net issuance matches it/);
  const notes = renderNotes(m);
  assert.match(notes, /- \[ \] Supply: 14 changes/);
  assert.match(notes, /\*\*2026-11-01 → 2026-11-02\*\*: .* gap \$1\.000000/);
  assert.match(thread(m).posts[2].text, /SUPPLY CHECK FAILED/);
});

test('X lengths are weighted the way X weighs them', () => {
  assert.equal(xLength('USDC on Arc mainnet'), 19);
  assert.equal(xLength('https://stabledesk.xyz/reports/2026-11-05'), 23, 'any URL is 23');
  assert.equal(xLength('https://a.co'), 23, 'a short one too');
  assert.equal(xLength('see stabledesk.xyz/methodology.'), 4 + 23 + 1, 'a bare domain is a link; the full stop after it is not');
  assert.equal(xLength('−9.7%'), 2 + 4, 'U+2212 MINUS SIGN weighs 2');
  assert.equal(xLength('-9.7%'), 5);
  assert.equal(xLength('30 Oct – 5 Nov'), 14, 'U+2013 EN DASH weighs 1');
  assert.equal(xLength('“a” · b′'), 8, 'U+201C, U+201D, U+00B7 and U+2032 weigh 1');
  assert.equal(xLength('→ …'), 2 + 1 + 2, 'U+2192 and U+2026 weigh 2');
  assert.equal(xLength('日本'), 4);
  assert.equal(xLength('👍🏽'), 2, 'an emoji with its modifier is one heavy character');
  assert.equal(xLength('👨‍👩‍👧'), 2, 'so is a ZWJ sequence');
  assert.equal(xLength('é'), 1, 'normalised to NFC first');
  assert.equal(xLength('x'.repeat(X_LIMIT)), 280);
});

test('every post names the network, fits, and quotes each figure exactly as the body prints it', () => {
  const th = thread(model);
  assert.equal(th.openers.length, candidates(model).length, 'one opening post per candidate: what leads is not chosen here');
  for (const p of [...th.openers, ...th.posts]) {
    assert.ok(p.text.includes('Arc mainnet'), `names the network: ${p.text.slice(0, 50)}`);
    assert.ok(p.length <= X_LIMIT, `${p.length}/${X_LIMIT}: ${p.text.slice(0, 50)}`);
  }
  // The first report's title said 10% for the 9.7% in its body. Every figure a candidate or a post
  // quotes is printed in the body as is.
  const body = renderBody(model);
  for (const t of [...candidates(model).map((c) => c.text), ...th.openers.map((p) => p.text), ...th.posts.map((p) => p.text)]) {
    assert.deepEqual(unmatchedFigures(t, body), [], t);
  }
  assert.equal(candidates(model).find((c) => c.id === 'real').text, 'Real volume fell 9.7%, to 1,213.6M');
  assert.ok(th.posts[0].text.includes('Real 1,213.6M (−9.7%)'));
  assert.deepEqual(unmatchedFigures('real volume fell 10%', body), ['10%'], 'and the check catches the slip');
});

test('the example draft prints the published report figure for figure, and leaves the lead to a person', () => {
  const draft = readFileSync(join(ROOT, FIXTURE, '2026-11-05.html'), 'utf8');
  const published = readFileSync(join(ROOT, 'reports', '2026-11-05.html'), 'utf8');
  const tables = (html) => html.match(/<table>[\s\S]*?<\/table>/g);
  assert.deepEqual(tables(draft), tables(published));
  for (const s of ['5,428.3M', '1,213.6M', '266.8M', '<td>5 Nov</td><td class="num">1,187.2M</td><td class="num">29,749,315</td>', '+486.2M', '−406.1M', '+33.9M']) {
    assert.ok(draft.includes(s), s);
  }
  // The prose the generator writes says what the published report said, where that was not a choice.
  const paragraph = (html, start) => html.split('\n').find((l) => l.trim().startsWith(`<p>${start}`));
  for (const start of ['<strong>Raw</strong> counts', 'A CCTP or Gateway mint', 'Organic issuance —', 'Over the week, supply', 'Each bucket carries']) {
    assert.equal(paragraph(draft, start), paragraph(published, start), start);
  }
  // Its one placeholder is the lead; it carries the network label the reports test looks for.
  assert.deepEqual(draft.match(/\{\{[^}]*\}\}/g), ['{{LEAD}}']);
  assert.ok(draft.includes('Arc mainnet') && !draft.includes('testnet'));
});

test('replaying the recording regenerates the committed example, byte for byte and offline', () => {
  const out = mkdtempSync(join(tmpdir(), 'stabledesk-weekly-'));
  try {
    const r = cli(['--date', '2026-11-06', '--replay', FIXTURE, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['2026-11-05.html', '2026-11-05.draft.md']) {
      assert.equal(readFileSync(join(out, f), 'utf8'), readFileSync(join(ROOT, FIXTURE, f), 'utf8'), `${f} no longer matches the example: regenerate it (see the top of this file)`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the generator never redrafts a published report in place, and asks before overwriting a draft', () => {
  const r = cli(['--date', '2026-11-06', '--replay', FIXTURE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /2026-11-05 is published \(reports\.js\) and stays as published/);
  const out = mkdtempSync(join(tmpdir(), 'stabledesk-weekly-'));
  try {
    writeFileSync(join(out, '2026-11-05.html'), 'a draft someone is editing');
    const again = cli(['--date', '2026-11-06', '--replay', FIXTURE, '--out', out]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /exists; --force overwrites it/);
    assert.equal(readFileSync(join(out, '2026-11-05.html'), 'utf8'), 'a draft someone is editing');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the series is read from either source, and refused when it cannot carry the report', () => {
  const envelope = load('series.json');
  const sc = envelope.result.structuredContent;
  // The MCP response, its structuredContent, and a /v1 body (rows as objects) with its chain id.
  const v1 = { chainId: 5042, data: { ...sc.data, series: sc.data.series.rows.map((r) => Object.fromEntries(sc.data.series.columns.map((c, i) => [c, r[i]]))) } };
  for (const doc of [envelope, sc, v1]) {
    const h = parseHistory(doc);
    assert.equal(h.chainId, 5042);
    assert.equal(h.byDay.size, 53);
    assert.deepEqual(h.byDay.get('2026-11-05'), hist.byDay.get('2026-11-05'));
  }
  assert.throws(() => parseHistory({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'stablecoin_history could not answer: Data warming up' }] } }), /warming up/);
  assert.throws(() => parseHistory({ chainId: 5042, data: { ...sc.data, group: 3600 } }), /UTC days/);

  // The network label is derived from the chain id; a series that does not carry one is refused.
  assert.throws(() => assertSeriesCovers({ ...hist, chainId: null }, '2026-11-06'), /no network label/);
  assert.throws(() => assertSeriesCovers({ ...hist, network: 'Arc testnet' }, '2026-11-06'), /says Arc testnet/);
  // The week's last day must have been measured to its end.
  assert.throws(() => assertSeriesCovers({ ...hist, windowEnd: Date.parse('2026-11-05T23:00:00Z') }, '2026-11-06'), /not the whole of 2026-11-05/);
  assert.throws(() => assertSeriesCovers(hist, '2026-09-25'), /record begins on 2026-09-15/);
});

test('with a key, the infrastructure set adds what the cap did, in either direction', () => {
  const since = Date.parse('2026-09-27T00:00:00Z');
  const free = renderBody(buildReport({ hist, published: '2026-11-06', reads, filtered: { flagged: 243, qualifying: 243, cap: 20000, atCap: false, sentHistorySince: since } }));
  assert.match(free, /Its cap played no part: when these figures were read, the set held 243 addresses, every qualifying address flagged, against a cap of 20,000\./);
  const capped = renderBody(buildReport({ hist, published: '2026-11-06', reads, filtered: { flagged: 20000, qualifying: 23456, cap: 20000, atCap: true, sentHistorySince: since } }));
  assert.match(capped, /The cap was binding when these figures were read: 23,456 addresses qualified and 20,000 were flagged/);
  // Without a key, the claim is left out of the body and the notes say it was not checked.
  assert.doesNotMatch(renderBody(model), /Its cap|The cap was binding/);
  assert.match(renderNotes(model), /- \[ \] Infrastructure cap: not checked/);
});

// Supply closes for any day of the recorded series, consistent with it: rebuilt from the close read on
// 5 November with the series' own mint − burn. Enough to draft every week the recording covers.
function consistentReads(days) {
  const anchor = reads.get('2026-11-05');
  const out = new Map();
  for (const d of days) {
    let s = Number(anchor.supply) / 1e6;
    for (const x of daysBetween(addDays(d, 1), '2026-11-05')) s -= hist.byDay.get(x).mint - hist.byDay.get(x).burn;
    const back = (Date.parse('2026-11-05') - Date.parse(d)) / 86400e3;
    out.set(d, { block: anchor.block - back * 172800, timestamp: anchor.timestamp - back * 86400, supply: BigInt(Math.round(s * 1e6)) });
  }
  return out;
}

test('drafted for each of the 39 weeks the recording covers, every draft holds together', () => {
  const all = consistentReads(daysBetween('2026-09-14', '2026-11-05'));
  const seen = { headings: new Set(), newHigh: new Set(), caveat: new Set(), mbShare: new Set(), opposite: new Set() };
  let weeks = 0;
  for (let p = '2026-09-29'; p <= '2026-11-06'; p = addDays(p, 1), weeks++) {
    const m = buildReport({ hist, published: p, reads: all });
    const body = renderBody(m);
    assert.deepEqual(body.match(/\{\{[^}]*\}\}/g), ['{{LEAD}}'], p);
    const th = thread(m);
    for (const post of [...th.openers, ...th.posts]) {
      assert.ok(post.text.includes('Arc mainnet') && post.length <= X_LIMIT, `${p}: ${post.length}/${X_LIMIT} ${post.text.slice(0, 60)}`);
    }
    for (const t of [...candidates(m).map((c) => c.text), ...th.posts.map((x) => x.text)]) assert.deepEqual(unmatchedFigures(t, body), [], `${p}: ${t}`);
    assert.ok(renderNotes(m).includes(registryEntry(m)));
    seen.headings.add(body.match(/<h2>Volume: (.*)<\/h2>/)[1]);
    seen.newHigh.add(m.newHigh);
    seen.caveat.add(m.caveat != null);
    seen.mbShare.add(m.F.mbShare?.of ?? null);
    seen.opposite.add(/pulled in opposite directions/.test(body));
  }
  assert.equal(weeks, 39);
  // The weeks differ enough that every branch of the prose is written at least once.
  assert.deepEqual([...seen.headings].sort(), ['all three measures down', 'all three measures up', 'one measure up, two down', 'two measures up, one down']);
  for (const k of ['newHigh', 'caveat', 'opposite']) assert.equal(seen[k].size, 2, k);
  assert.ok(seen.mbShare.has('rise') && seen.mbShare.has(null), [...seen.mbShare].join());
});

test('the Friday workflow drafts and stops there: a draft PR from a branch of its own, never main, never a post', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'weekly-report.yml'), 'utf8');
  assert.match(wf, /- cron: '\d{1,2} \d{1,2} \* \* 5'/, 'on Fridays, once the week has closed at midnight UTC');
  assert.match(wf, /node scripts\/weekly-report\.mjs --date "\$published" \|\| code=\$\?/);
  assert.match(wf, /branch="weekly-report\/\$slug"/);
  assert.match(wf, /gh pr create --draft --base main --head "\$branch"/, 'opened as a draft, from its own branch');
  assert.equal((wf.match(/git push/g) || []).length, 1);
  assert.match(wf, /git push -q origin "\$branch"$/m, 'the one push is the draft branch');
  assert.doesNotMatch(wf, /gh pr (merge|ready|review)|--admin|auto-?merge/i, 'nothing merges it or marks it ready');
  assert.doesNotMatch(wf, /api\.(twitter|x)\.com|X_POSTING|TELEGRAM/i, 'nothing is posted');
  // Pull requests that change the generator get a live dry run, which can write nothing.
  const dry = wf.slice(wf.indexOf('\n  dry-run:'));
  assert.match(dry, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(dry, /git push|gh pr|secrets\./);
  assert.match(dry, /--out "\$RUNNER_TEMP\/draft"/);
});

test('a listed report carries no placeholder, and its title and summary quote only figures its body prints', () => {
  for (const r of REPORTS) {
    for (const k of ['title', 'summary']) assert.ok(!r[k].includes('{{'), `${r.slug}: the ${k} is still a placeholder`);
    const body = readFileSync(join(ROOT, 'reports', `${r.slug}.html`), 'utf8');
    // The first report stays as published, with the slip this check exists for: 10% in its title and
    // summary for the 9.7% in its body.
    const known = r.slug === '2026-11-05' ? ['10%'] : [];
    assert.deepEqual(unmatchedFigures(`${r.title} ${r.summary}`, body), known, `${r.slug}: quote the figure as the body prints it`);
  }
});
