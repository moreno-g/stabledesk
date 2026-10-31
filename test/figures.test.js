// Published figures against the method they claim — the corrections of 30 October 2026, made after
// the audit of 29 October. Each test fails on the code before that date. No network: the subprocesses
// started here refuse every fetch (see OFFLINE), and the one server listens on loopback only.
// Run: npm test   (node --test picks this file up beside smoke.test.js)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

// Same rule as smoke.test.js: db.js binds its file at first import, so the path is set before any
// dynamic import, and nothing imported statically here may reach db.js.
process.env.DB_PATH = join(tmpdir(), `stabledesk-figures-${process.pid}-${Date.now()}.db`);

const ROOT = join(import.meta.dirname, '..');
const removeDb = (p) => { for (const ext of ['', '-wal', '-shm']) rmSync(p + ext, { force: true }); };
after(() => removeDb(process.env.DB_PATH));

// Preloaded into subprocesses: every fetch is refused, and a server that names no host listens on
// loopback rather than on every interface.
const OFFLINE = 'data:text/javascript,' + encodeURIComponent(`
  import net from 'node:net';
  globalThis.fetch = async () => { throw new Error('offline: tests make no network calls'); };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (port, ...rest) {
    if (typeof port === 'number' && typeof rest[0] !== 'string') rest.unshift('127.0.0.1');
    return listen.call(this, port, ...rest);
  };`);

// The variables the mainnet profile cannot start without. Wallet entries and GBPA exist only there.
const MAINNET = { ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '5042', ARC_RPC_URLS: 'https://rpc.example',
  ARC_TOKENS: 'USDC:0x3600000000000000000000000000000000000000:6,EURC:0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1:6' };
const QUIET = { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', ADMIN_TOKEN: '' };

// Runs an ES module script in the repository with its own database, and returns the JSON it printed last.
async function inSubprocess(script, env = {}) {
  const { execFileSync } = await import('node:child_process');
  const dbPath = join(tmpdir(), `stabledesk-figures-sub-${process.pid}-${Date.now()}.db`);
  try {
    const out = execFileSync(process.execPath, ['--import', OFFLINE, '--input-type=module', '-e', script], {
      cwd: ROOT, env: { ...process.env, ARC_NETWORK: '', ...QUIET, ...env, DB_PATH: dbPath }, stdio: 'pipe', timeout: 30000,
    });
    return JSON.parse(String(out).trim().split('\n').at(-1));
  } finally {
    removeDb(dbPath);
  }
}

// A GET on the public API, in this process, with a key of its own.
const KEY = 'sbd_figures_test';
async function v1(path) {
  const db = await import('../db.js');
  const { handleV1 } = await import('../api.js');
  const { live } = await import('../indexer.js');
  if (!db.getKey(KEY)) db.createKey(KEY, 'figures', 'free');
  const saved = live.snapshot;
  live.snapshot = { ...saved, ok: true };     // past the warming-up check; the routes read the database
  try {
    return await new Promise((resolve, reject) => {
      const req = { method: 'GET', headers: { 'x-api-key': KEY }, socket: { remoteAddress: '127.0.0.1' } };
      const res = { writeHead(code) { this.code = code; }, end(s) { resolve({ code: this.code, body: JSON.parse(s) }); } };
      handleV1(req, res, new URL('http://localhost' + path)).catch(reject);
    });
  } finally {
    live.snapshot = saved;
  }
}

// One minute of one token, every measure defaulting to zero.
const bucket = (minute, token, x) => ({ minute, token, volume: 0, cnt: 0, mint: 0, burn: 0, rvolume: 0, rcnt: 0, avolume: 0, acnt: 0, ...x });

// Runs a served page's inline script against a minimal DOM — one stub element per selector, recording
// what the script writes — so a test reads what a visitor would see. `fetchJson(url)` answers the page's
// requests. Returns the stub lookup once the first round of answers has been rendered.
async function runPage(html, path, fetchJson) {
  const vm = await import('node:vm');
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n;\n');
  const els = new Map();
  const el = (key) => {
    if (!els.has(key)) {
      els.set(key, {
        className: '', textContent: '', innerHTML: '', title: '', href: '', dataset: {}, children: [], handlers: {},
        style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener(type, fn) { this.handlers[type] = fn; },
        insertAdjacentHTML(_, h) { this.innerHTML += h; },
        appendChild() {}, setAttribute() {}, removeAttribute() {}, remove() {},
        querySelector: (s) => el(`${String(key)} ${s}`), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 260 }),
      });
    }
    return els.get(key);
  };
  const ctx = {
    document: {
      querySelector: (s) => el(s), querySelectorAll: () => [], getElementById: (id) => el('#' + id),
      createElement: () => el(Symbol('created')), head: el('head'), body: el('body'), documentElement: el('html'), addEventListener() {},
    },
    location: { pathname: path, search: '', hostname: '127.0.0.1' }, navigator: {},
    URLSearchParams, Intl, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    requestAnimationFrame: (f) => setTimeout(f, 0), getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    fetch: async (u) => ({ ok: true, status: 200, json: async () => fetchJson(String(u)) }),
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  await settle();
  return el;
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10)); };

// ---- 1 · the daily digest (/v1/rankings, /ecosystem) ----
test('the digest prints real and adjusted volume in one currency, names its window, and takes no percentage of dust', async () => {
  const db = await import('../db.js');
  const tvl = await import('../tvl.js');
  const { PROTOCOLS } = await import('../protocols.js');
  const { TVL_CANDIDATE_MIN } = await import('../constants.js');
  const { daily, digest } = await import('../rankings.js');

  // This minute (the 7-day windows end on the day of the newest indexed minute). Raw counts every event,
  // a mint included; real keeps the largest transfer per transaction and leaves the mint out; adjusted
  // drops bot-to-bot. EURC beside it.
  const minute = Math.floor(Date.now() / 60000) * 60;
  db.applyBatch(new Map([
    ['u', bucket(minute, 'USDC', { volume: 900, cnt: 9, mint: 500, rvolume: 300, rcnt: 3, avolume: 120, acnt: 2 })],
    ['e', bucket(minute, 'EURC', { volume: 50, cnt: 2, rvolume: 40, rcnt: 1, avolume: 30, acnt: 1 })],
  ]), new Map(), []);

  // Yesterday against today: one protocol arriving from dust, one whose dust moved, one moving 20%, and
  // one emptied to zero, which leaves no row today (zero levels are not stored). Each scan also stores
  // the chain's own level, which is what says a day was read.
  const [arriving, dusty, moving, emptied] = PROTOCOLS.filter((p) => !p.wallets && p.contracts.length);
  const day = Math.floor(Date.now() / 86400000) * 86400;
  const key = (p) => tvl.historyKey(p.id);
  const chain = tvl.historyKey('*');
  db.recordTvlSnapshot(day - 86400, [{ protocol: chain, tvl: 9e6 }, { protocol: key(arriving), tvl: 2.29 }, { protocol: key(dusty), tvl: 0.004 },
    { protocol: key(moving), tvl: 100 * TVL_CANDIDATE_MIN }, { protocol: key(emptied), tvl: 5e6 }]);
  db.recordTvlSnapshot(day, [{ protocol: chain, tvl: 5e6 }, { protocol: key(arriving), tvl: 1e6 }, { protocol: key(dusty), tvl: 0.003 },
    { protocol: key(moving), tvl: 120 * TVL_CANDIDATE_MIN }]);

  // Something moved through one of them today, so "Most active" has a row.
  const today = Math.floor(Date.now() / 86400000);
  db.applyBatch(new Map(), new Map([[moving.contracts[0], { transfers: 2, volume: 12000, lastBlock: 10, firstBlock: 10,
    byTokenDay: { u: { token: 'USDC', day: today, transfers: 1, volume: 5000 }, e: { token: 'EURC', day: today, transfers: 1, volume: 7000 } } }]]), []);

  const r = daily();
  assert.equal(r.chain.denomination, 'USD');
  assert.equal(r.chain.volume24h, 300, 'real volume, the measure the terminal shows as "24h volume" — not the raw 900');
  assert.equal(r.chain.adjustedVolume24h, 120, 'dollars only: the 30 EURC are not added in');
  assert.equal(r.chain.rawVolume24h, 900, 'raw is still published, under its own name');

  const text = digest(r);
  assert.match(text, /· 24h volume 300 USD real, 120 USD adjusted$/m);

  const mv = Object.fromEntries(r.movers.map((m) => [m.id, m]));
  assert.equal(mv[arriving.id]?.pctLabel, 'new', 'a base under the floor is a protocol arriving, not +43665838.9%');
  assert.equal(mv[arriving.id].pct, null);
  assert.ok(!mv[dusty.id], 'a change smaller than the floor is not a move');
  assert.equal(mv[moving.id]?.pctLabel, '+20.0%');
  assert.ok(text.includes(`${arriving.name} new (2.29 → 1.00M USD)`), text);
  assert.doesNotMatch(text, /[+-]\d{4,}\.\d%/, 'no percentage of dust');

  // "Most active" covers a week, or less while daily counting is young — never an unnamed span.
  assert.equal(r.moved.complete, false, 'daily counting began when this database was created');
  assert.equal(r.byVolume[0]?.id, moving.id);
  assert.equal(r.byVolume[0].windowVolume, 5000, 'ranked in dollars');
  assert.match(text, /^Most active · since \d{4}-\d{2}-\d{2}$/m);
  assert.match(digest({ ...r, moved: { ...r.moved, complete: true } }), /^Most active · last 7 days$/m);

  // Levels on both days and nothing moving enough is not "no baseline yet". The digest says how many
  // protocols it compared, and only those: the one emptied to zero has no level today and is not among
  // them, so the line cannot be read as "nothing moved".
  assert.deepEqual([r.moversCompared, r.moversRead], [3, { yesterday: true, today: true }]);
  db.recordTvlSnapshot(day, [{ protocol: key(arriving), tvl: 2.29 }, { protocol: key(moving), tvl: 100 * TVL_CANDIDATE_MIN + 1 }]);
  const quiet = daily();
  assert.deepEqual([quiet.movers.length, quiet.moversCompared], [0, 3]);
  assert.match(digest(quiet), /^24h movers: none of the 3 protocols with a level on both days moved 100 USD and 2% or more\.$/m);
  assert.doesNotMatch(digest(quiet), /no baseline|no move of/);
  // Today not read yet, and no baseline at all, are said as what they are.
  assert.match(digest({ ...quiet, moversCompared: 0, moversRead: { yesterday: true, today: false } }), /^24h movers: today's TVL not read yet\.$/m);
  assert.match(digest({ ...quiet, moversCompared: 0, moversRead: { yesterday: false, today: true } }), /^24h movers: no baseline yet\.$/m);
});

// The digest's levels as the TVL scan writes them (tvl.persistLevels), on a fresh database each time.
test('each day keeps its last scan\'s levels, and the digest says which empty list it prints', async () => {
  const run = (script) => inSubprocess(`
    const db = await import('./db.js'); const tvl = await import('./tvl.js');
    const { PROTOCOLS } = await import('./protocols.js'); const { daily, digest } = await import('./rankings.js');
    const day = Math.floor(Date.now() / 86400000) * 86400;
    const listed = PROTOCOLS.filter((p) => !p.wallets && p.contracts.length), [P, Q] = listed;
    const agg = (chain, levels) => ({ totals: { byDenomination: { USD: { tvl: chain } } },
      protocols: Object.entries(levels).map(([id, v]) => ({ id, tvlByDenomination: v ? { USD: v } : {} })) });
    const line = () => digest(daily()).split('\\n').find((l) => l.startsWith('24h movers'));
    ${script}`);

  // Yesterday scanned, today not yet: that is not "no baseline". Only today scanned: it is.
  const unread = await run(`
    tvl.persistLevels(agg(7e6, { [P.id]: 5e6, [Q.id]: 2e6 }), day - 86400);
    console.log(JSON.stringify({ read: daily().moversRead, line: line() }));`);
  assert.deepEqual(unread, { read: { yesterday: true, today: false }, line: '24h movers: today\'s TVL not read yet.' });
  const fresh = await run(`
    tvl.persistLevels(agg(7e6, { [P.id]: 5e6, [Q.id]: 2e6 }), day);
    console.log(JSON.stringify({ read: daily().moversRead, line: line() }));`);
  assert.deepEqual(fresh, { read: { yesterday: false, today: true }, line: '24h movers: no baseline yet.' });

  // P emptied between two scans of today. The day keeps the last scan, so P has no level today and is
  // not compared — rather than compared at this morning's 5M, as if it had not moved.
  const drained = await run(`
    tvl.persistLevels(agg(7e6, { [P.id]: 5e6, [Q.id]: 2e6 }), day - 86400);
    tvl.persistLevels(agg(7e6, { [P.id]: 5e6, [Q.id]: 2e6 }), day);
    tvl.persistLevels(agg(2e6, { [P.id]: 0, [Q.id]: 2e6 }), day);
    console.log(JSON.stringify({ p: db.tvlOn(tvl.historyKey(P.id), day), compared: daily().moversCompared, line: line() }));`);
  assert.equal(drained.p, null, 'the morning level is not kept');
  assert.equal(drained.compared, 1);
  assert.equal(drained.line, '24h movers: the one protocol with a level on both days did not move 100 USD and 2% or more.');

  // The TVL line counts every protocol holding dollars, not the five the digest ranks.
  const seven = await run(`
    db.upsertBalances(listed.slice(0, 7).map((p) => ({ address: p.contracts[0], token: 'USDC', balance: 1e6 })));
    const r = daily();
    console.log(JSON.stringify({ ranked: r.byTvl.length, holding: r.protocolsHolding, head: digest(r).split('\\n')[2] }));`);
  assert.deepEqual([seven.ranked, seven.holding], [5, 7]);
  assert.match(seven.head, /^TVL 7\.00M USD across 7 protocols /);
});

// ---- 2 · one currency per figure ----
test('the default series is one currency: ALL adds up the base denomination\'s tokens, never euros', async () => {
  const db = await import('../db.js');
  const constants = await import('../constants.js');

  // Three minutes inside one 15-minute bucket, two hours ago: 100 USDC, 10 USYC and 1,000 EURC each.
  const M = Math.floor((Date.now() / 1000 - 7200) / 900) * 900;
  const b = new Map();
  for (let m = M; m < M + 180; m += 60) {
    b.set(m + 'u', bucket(m, 'USDC', { volume: 100, rvolume: 100, avolume: 100 }));
    b.set(m + 'y', bucket(m, 'USYC', { volume: 10, rvolume: 10, avolume: 10 }));
    b.set(m + 'e', bucket(m, 'EURC', { volume: 1000, rvolume: 1000, avolume: 1000 }));
  }
  db.applyBatch(b, new Map(), []);

  // As served: /v1/stablecoins/history, token=ALL by default, drew 3,330 here — dollars and euros.
  const res = await v1('/v1/stablecoins/history?range=24h');
  assert.equal(res.code, 200);
  assert.equal(res.body.series.find((p) => p.t === M)?.rvolume, 330);
  assert.equal(res.body.token, 'ALL');
  assert.equal(res.body.denomination, 'USD', 'and the line says what it is a quantity of');
  assert.deepEqual([...res.body.tokens].sort(), ['USDC', 'USDT', 'USYC']);

  const { seriesScope } = constants;
  const all = seriesScope('ALL');
  assert.equal(all.denomination, 'USD');
  assert.deepEqual(seriesScope('EURC'), { token: 'EURC', denomination: 'EUR', tokens: ['EURC'] });
  assert.deepEqual(seriesScope(''), all, 'no token asked for is ALL');

  const minutes = db.getSeries(all.tokens, M, 60, false).filter((p) => p.t >= M && p.t < M + 180);
  assert.deepEqual(minutes.map((p) => p.rvolume), [110, 110, 110], 'dollars only — the old line drew 1,110');
  assert.equal(db.getSeries('ALL', M, 60, false).length, 0, 'a literal ALL matches nothing rather than every token');

  // The daily series too: the base denomination's tokens, summed, and nothing else.
  const day = Math.floor(M / 86400) * 86400;
  const of = (tokens) => db.getSeries(tokens, day, 86400, true).find((p) => p.t === day)?.rvolume || 0;
  assert.equal(of(all.tokens), of('USDC') + of('USYC') + of('USDT'));
  assert.ok(of('EURC') >= 3000, 'the euros are there, in their own series');

  // An assistant asking the MCP tool is told the same, and gets the same line.
  const { TOOLS, INSTRUCTIONS, callTool } = await import('../mcp.js');
  const h = TOOLS.find((t) => t.def.name === 'stablecoin_history').def;
  for (const text of [h.description, h.inputSchema.properties.token.description]) {
    assert.match(text, /ALL[^.;]* every token denominated in USD, the base denomination/);
    assert.doesNotMatch(text, /across currencies/, 'the tool said ALL added every currency');
  }
  assert.match(INSTRUCTIONS, /in the base denomination \([^)]*token ALL/);
  const { live } = await import('../indexer.js');
  const saved = live.snapshot;
  live.snapshot = { ...saved, ok: true };
  try {
    const { denomination, series } = (await callTool('stablecoin_history', { range: '24h' })).structuredContent.data;
    assert.equal(denomination, 'USD');
    const row = series.rows.find((r) => r[series.columns.indexOf('t')] === M);
    assert.equal(row[series.columns.indexOf('rvolume')], 330);
  } finally {
    live.snapshot = saved;
  }
});

test('the filter\'s share and Gateway\'s share are taken in one currency', async () => {
  // The snapshot the site serves, built by the indexer from a seeded database, in a subprocess: an hour
  // in which USDC moved 1,000 a minute in real volume (700 adjusted, 100 through Gateway) and EURC 1,000
  // a minute, all of it between flagged addresses.
  const s = await inSubprocess(`
    const db = await import('./db.js');
    const idx = await import('./indexer.js');
    const end = Math.floor(Date.now() / 60000) * 60, buckets = new Map();
    const z = { mint: 0, burn: 0, rcnt: 1 };
    for (let m = end - 3540; m <= end; m += 60) {
      buckets.set(m + 'u', { minute: m, token: 'USDC', volume: 1500, cnt: 3, ...z, rvolume: 1000, avolume: 700, acnt: 1, bvolume: 100, bcnt: 1 });
      buckets.set(m + 'e', { minute: m, token: 'EURC', volume: 1000, cnt: 1, ...z, rvolume: 1000, avolume: 0, acnt: 0 });
    }
    db.applyBatch(buckets, new Map(), []);
    await idx.start();
    idx.stop();
    const { noise, bridge } = idx.live.snapshot;
    process.stdout.write('\\n' + JSON.stringify({ noise, bridge }) + '\\n', () => process.exit(0));`);

  assert.ok(Math.abs(s.noise.excludedShare - 0.3) < 1e-9, `${s.noise.excludedShare}: a share of dollar volume, where the mixed total gave 0.65`);
  assert.equal(s.noise.excludedVolume24h, 60 * 300, 'the dollars removed: 300 a minute');
  assert.equal(s.noise.excludedDenomination, 'USD');
  assert.deepEqual(s.noise.excludedByDenomination.EUR, { volume: 60000, share: 1 }, 'the euros on their own line');
  assert.equal(s.bridge.measured, true);
  assert.ok(Math.abs(s.bridge.volumeShare - 0.1) < 1e-9, `${s.bridge.volumeShare}: Gateway's dollars over dollar volume, not over every currency (0.05)`);
});

// ---- 3 · top addresses ----
test('top addresses are ranked over 7 days, in one currency, from per-day counts — and not re-ranked per request', async () => {
  const db = await import('../db.js');
  const tvl = await import('../tvl.js');
  // A minute indexed now: the window ends on the day of the newest indexed minute.
  db.applyBatch(new Map([['now', bucket(Math.floor(Date.now() / 60000) * 60, 'USDC', {})]]), new Map(), []);
  const today = Math.floor(Date.now() / 86400000);
  const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
  db.setMetaValue('addr_token_daily_since', String((today - 30) * 86400000));   // a full week is counted

  // A has moved 1M USDC and 1M EURC a day for ten days: addr_stats holds 20M, every token added. B moved
  // 5M USDC today. Over the week A moved 7M dollars, and leads.
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
  const a = { transfers: 20, volume: 20e6, lastBlock: 100, firstBlock: 1, byTokenDay: {} };
  for (let d = today - 9; d <= today; d++) {
    a.byTokenDay['u' + d] = { token: 'USDC', day: d, transfers: 1, volume: 1e6 };
    a.byTokenDay['e' + d] = { token: 'EURC', day: d, transfers: 1, volume: 1e6 };
  }
  const once = (token, volume, day = today) => ({ transfers: 1, volume, lastBlock: 100, firstBlock: 100, byTokenDay: { x: { token, day, transfers: 1, volume } } });
  db.applyBatch(new Map(), new Map([[A, a], [B, once('USDC', 5e6)]]), []);

  const res = await v1('/v1/addresses/top?limit=100');
  assert.equal(res.code, 200);
  const rowA = res.body.top.find((x) => x.address === A);
  assert.equal(rowA.volume, 7e6, 'seven days of dollars, not a running total of every currency (20M)');
  assert.equal(res.body.windowDays, 7);
  assert.equal(res.body.denomination, 'USD');
  assert.equal(res.body.moved.complete, true);
  assert.deepEqual(rowA.volumeByDenomination, { USD: 7e6, EUR: 7e6 });
  assert.equal(rowA.transfers, 14, 'every token\'s transfers over the same seven days');
  assert.ok(res.body.top.findIndex((x) => x.address === A) < res.body.top.findIndex((x) => x.address === B));
  assert.doesNotMatch(res.body.note, /rolling ~7-day window \(the address-activity retention\)/);

  // While daily counting is younger than a week — the state of mainnet until November 2026 — the window
  // starts there and every label says so: `windowDays` is the days covered, not the 7 aimed at.
  db.setMetaValue('addr_token_daily_since', String((today - 2) * 86400000));
  const young = await v1('/v1/addresses/top?limit=100');
  assert.equal(young.body.windowDays, 3);
  assert.equal(young.body.moved.complete, false);
  assert.equal(young.body.moved.since, (today - 2) * 86400000);
  assert.ok(young.body.note.includes(`daily counting began during ${iso(today - 2)}`), young.body.note);
  assert.equal(young.body.top.find((x) => x.address === A).volume, 3e6);
  // Counting that began during the window's first day leaves that day partial: seven days, not complete.
  db.setMetaValue('addr_token_daily_since', String((today - 6) * 86400000 + 15.75 * 3600000));
  const partial = await v1('/v1/addresses/top?limit=100');
  assert.deepEqual([partial.body.windowDays, partial.body.moved.complete], [7, false]);
  assert.match(partial.body.note, /less than 7 full days/);
  // A database created after the newest minute it indexed (a cold start replaying yesterday) never
  // publishes a window that ends before it starts.
  db.setMetaValue('addr_token_daily_since', String((today + 1) * 86400000 + 3600000));
  const ahead = await v1('/v1/addresses/top?limit=100');
  assert.deepEqual([ahead.body.windowDays, ahead.body.moved.since, ahead.body.moved.complete], [1, today * 86400000, false]);
  assert.ok(ahead.body.moved.since <= ahead.body.moved.to);
  assert.equal(ahead.body.moved.began, (today + 1) * 86400000 + 3600000);
  assert.ok(ahead.body.note.includes(`daily counting began on ${iso(today + 1)}, after the newest indexed day`), ahead.body.note);
  db.setMetaValue('addr_token_daily_since', String((today - 30) * 86400000));

  // Ranking reads every row of the window, so it is not redone on every call: a new address shows up
  // when the ranking is recomputed. Tomorrow 01:00 UTC is later than every call above, on a fixed day.
  const t1 = (today + 1) * 86400000 + 3600000;
  assert.equal(tvl.topMoved(100, t1).computedAt, t1);
  db.applyBatch(new Map(), new Map([[C, once('USDC', 9e6)]]), []);
  const cached = tvl.topMoved(100, t1 + 60000);
  assert.equal(cached.computedAt, t1);
  assert.ok(!cached.top.some((x) => x.address === C), 'served from the ranking already made');
  const fresh = tvl.topMoved(100, t1 + 5 * 60000);
  assert.equal(fresh.computedAt, t1 + 5 * 60000);
  assert.equal(fresh.top[0].address, C);
});

// ---- 4 · a wallets entry's page ----
test('a wallets entry publishes its own accounts, not every wallets entry together', async () => {
  const out = await inSubprocess(`
    const db = await import('./db.js'); const tvl = await import('./tvl.js'); const p = await import('./protocols.js');
    const msca = '0x' + 'a'.repeat(40), safe = '0x' + 'b'.repeat(40);
    p.setDerivedAttributions([
      { address: msca, protocol: 'circle-msca-accounts', basis: 'implementation:x' },
      { address: safe, protocol: 'safe', basis: 'singleton:x' },
    ]);
    db.upsertBalances([{ address: msca, token: 'USDC', balance: 100e6 },
      { address: safe, token: 'USDC', balance: 250000 }, { address: safe, token: 'EURC', balance: 71000 }]);
    const view = (d) => ({ tvl: d.tvl, byDen: d.tvlByDenomination, accounts: d.contractsWithBalance, rows: d.contractDetail.reduce((a, c) => a + c.tvl, 0) });
    console.log(JSON.stringify({ safe: view(tvl.detail('safe')), msca: view(tvl.detail('circle-msca-accounts')), viaAccount: view(tvl.addressDetail(safe)) }));`,
    MAINNET);

  assert.deepEqual(out.safe.byDen, { USD: 250000, EUR: 71000 }, 'the Safes, without the Circle accounts\' 100M');
  assert.equal(out.safe.accounts, 1);
  assert.equal(out.safe.tvl, out.safe.rows, 'the headline is the sum of the page\'s own table');
  assert.deepEqual(out.msca.byDen, { USD: 100e6 }, 'and the Circle accounts without the Safes');
  assert.equal(out.msca.accounts, 1);
  assert.deepEqual(out.viaAccount.byDen, out.safe.byDen, 'an account\'s page is its entry\'s');
});

// ---- 5 · token pages on frozen data ----
test('a token page says frozen figures are frozen, as the terminal does', async () => {
  const vm = await import('node:vm');
  const html = readFileSync(join(ROOT, 'public/token.html'), 'utf8');
  const fn = (name) => {
    const m = html.match(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `token.html defines ${name}()`);
    return m[0];
  };
  const freshness = vm.runInNewContext(fn('dur') + fn('freshness') + '; freshness');
  const now = Date.UTC(2026, 9, 29, 20);
  const say = (d) => ({ ...freshness(d, now) });

  assert.deepEqual(say({ ok: true, stale: false, degraded: false, chain: { state: 'live' }, updatedAt: now - 3000 }),
    { dot: 'dot', text: 'live', meta: 'upd. 3s ago', win: '24h' });
  // The case the page got wrong: valid, three days old, chain unreachable. It said "live" in green.
  const old = now - 3 * 86400000;
  assert.deepEqual(say({ ok: true, stale: true, degraded: true, chain: { state: 'unreachable' }, updatedAt: old, dataAt: old, windowEnd: old }),
    { dot: 'dot stale', text: 'chain unreachable', meta: 'figures as of 3 d ago', win: '24h to 3 d ago' });
  assert.equal(say({ ok: true, stale: true, degraded: true, chain: { state: 'live' }, dataAt: old, windowEnd: old }).text, 'catching up');
  assert.equal(say({ ok: true, stale: true, degraded: true, chain: { state: 'halted' }, dataAt: old, windowEnd: old }).text, 'chain halted');
  assert.equal(say({ ok: false }).dot, 'dot down');
});

// The real server.js on a database whose newest minute is three days old, with the chain unreachable
// (every fetch refused): the degraded mode the pages have to describe.
describe('served from a frozen database', () => {
  let port, child, out = '', end;
  // A moved 1M USDC and 1M EURC on each of the ten days up to the freeze; B moved 3M USDC on its last day.
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), FROZEN_KEY = 'sbd_figures_frozen';
  const serverDb = join(tmpdir(), `stabledesk-figures-server-${process.pid}-${Date.now()}.db`);
  const get = async (path, headers = {}) => {
    const http = await import('node:http');
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      }).on('error', reject);
    });
  };

  before(async () => {
    const { execFileSync, spawn } = await import('node:child_process');
    const net = await import('node:net');
    // Seeded first, by db.js itself: an hour of USDC (1,000 a minute) and EURC (5,000) ending three days
    // ago, and the per-day counts of A and B up to that day, with daily counting long begun.
    const seeded = execFileSync(process.execPath, ['--import', OFFLINE, '--input-type=module', '-e', `
      const db = await import('./db.js');
      const end = Math.floor(Date.now() / 60000) * 60 - 3 * 86400, b = new Map();
      for (let m = end - 3540; m <= end; m += 60) {
        b.set(m + 'u', { minute: m, token: 'USDC', volume: 1000, cnt: 1, mint: 0, burn: 0, rvolume: 1000, rcnt: 1, avolume: 1000, acnt: 1 });
        b.set(m + 'e', { minute: m, token: 'EURC', volume: 5000, cnt: 1, mint: 0, burn: 0, rvolume: 5000, rcnt: 1, avolume: 5000, acnt: 1 });
      }
      const day = Math.floor(end / 86400), a = { transfers: 20, volume: 20e6, lastBlock: 900, firstBlock: 1, byTokenDay: {} };
      for (let d = day - 9; d <= day; d++) {
        a.byTokenDay['u' + d] = { token: 'USDC', day: d, transfers: 1, volume: 1e6 };
        a.byTokenDay['e' + d] = { token: 'EURC', day: d, transfers: 1, volume: 1e6 };
      }
      const bb = { transfers: 1, volume: 3e6, lastBlock: 900, firstBlock: 900, byTokenDay: { x: { token: 'USDC', day, transfers: 1, volume: 3e6 } } };
      db.applyBatch(b, new Map([['${A}', a], ['${B}', bb]]), []);
      db.setMetaValue('addr_token_daily_since', String((day - 30) * 86400000));
      db.createKey('${FROZEN_KEY}', 'figures', 'free');
      db.setCheckpoint(1000);
      process.stdout.write('\\n' + end + '\\n', () => process.exit(0));`],
    { cwd: ROOT, env: { ...process.env, ARC_NETWORK: '', ...QUIET, DB_PATH: serverDb }, stdio: 'pipe', timeout: 30000 });
    end = Number(String(seeded).trim().split('\n').at(-1));

    port = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    child = spawn(process.execPath, ['--import', OFFLINE, 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...QUIET, PORT: String(port), DB_PATH: serverDb, ARC_NETWORK: '',
        TVL_ENABLED: 'false', ENTITIES_ENABLED: 'false', WATCH_ENABLED: 'false', WHALEWATCH_ENABLED: 'false', BILLING_ENABLED: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    for (let i = 0; i < 200 && !out.includes('Stabledesk →'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(out.includes('Stabledesk →'), `the server did not start:\n${out}`);
    for (let i = 0; i < 100; i++) {
      if (JSON.parse((await get('/api/token?token=USDC')).body).ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(async () => {
    if (child && child.exitCode == null) {
      const { once } = await import('node:events');
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const stuck = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed;
      clearTimeout(stuck);
    }
    removeDb(serverDb);
  });

  test('/api/token carries what the terminal reads to tell frozen from live', async () => {
    const d = JSON.parse((await get('/api/token?token=USDC')).body);
    assert.equal(d.ok, true, 'the figures are valid');
    assert.equal(d.degraded, true, 'and not moving');
    assert.equal(d.stale, true);
    assert.equal(typeof d.chain?.state, 'string');
    assert.equal(d.dataAt, end * 1000, 'as of the newest indexed minute');
    assert.equal(d.windowEnd, end * 1000, 'the 24h window ends there, not now');
  });

  test('a token page\'s description is not "Live … over the last 24 hours" on frozen data', async () => {
    const page = (await get('/token/usdc')).body;
    const to = new Date(end * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    assert.doesNotMatch(page, /Live USDC analytics/);
    assert.doesNotMatch(page, /over the last 24 hours/);
    // Each text on its own: the search-result description and the sentence crawlers and no-JS readers get.
    const desc = page.match(/<meta name="description" content="([^"]*)"/)?.[1] || '';
    const ssr = page.match(/<p class="ssr" id="ssrSummary">([^<]*)<\/p>/)?.[1] || '';
    for (const [what, text] of [['description', desc], ['SSR sentence', ssr]]) {
      assert.ok(text.includes(`over the 24 hours to ${to}`), `${what}: ${text}`);
      assert.doesNotMatch(text, /over 24h\b/, what);
    }
    // The share card too: og:description and twitter:description carry the same window.
    const og = page.match(/<meta property="og:description" content="([^"]*)"/)?.[1] || '';
    assert.ok(og.includes(`real volume, 24h to ${to}`), og);
    assert.doesNotMatch(og, /24h real volume/);
  });

  test('a token page shows its frozen state, not a green "live"', async () => {
    // The page's own script, run against what the server answers: what a visitor sees, not a helper.
    const el = await runPage((await get('/token/usdc')).body, '/token/usdc', async (u) => JSON.parse((await get(u)).body));
    assert.notEqual(el('#statusText').textContent, 'live', 'figures three days old are not "live"');
    assert.equal(el('#statusDot').className, 'dot stale', 'nor shown with a green dot');
    const d = JSON.parse((await get('/api/token?token=USDC')).body);
    const label = { halted: 'chain halted', unauthorized: 'rpc rejected', unreachable: 'chain unreachable' }[d.chain?.state] || 'catching up';
    assert.equal(el('#statusText').textContent, label);
    assert.equal(el('#metaLine').textContent, 'figures as of 3 d ago');
    assert.match(el('#kpis').innerHTML, /<div class="lab">Real vol<\/div><div class="val ?">[^<]*<span class="unit">24h to 3 d ago<\/span>/);
    assert.doesNotMatch(el('#kpis').innerHTML, / · 24h</, 'no plain "24h" label on frozen figures');
  });

  test('the terminal\'s chart and top-addresses feeds name their currency and window', async () => {
    const h = JSON.parse((await get('/api/history?range=24h')).body);
    assert.equal(h.token, 'ALL');
    assert.equal(h.denomination, 'USD');
    assert.ok(!h.tokens.includes('EURC'));
    assert.equal(h.series.reduce((a, p) => a + p.rvolume, 0), 60 * 1000, 'dollars only — the old line added 300,000 euros');

    // The ranking ends on the frozen day, not on the wall clock's: A's seven days, 7M dollars, ahead of B.
    const day = Math.floor(end / 86400);
    const s = JSON.parse((await get('/api/state')).body);
    assert.equal(s.top[0]?.address, A, JSON.stringify(s.top));
    assert.equal(s.top[0].volume, 7e6, 'the seven days up to the last indexed minute — a wall-clock week holds four of them');
    assert.deepEqual(s.top[0].volumeByDenomination, { USD: 7e6, EUR: 7e6 });
    assert.equal(s.top[1]?.address, B);
    assert.deepEqual([s.topWindow.denomination, s.topWindow.since, s.topWindow.to, s.topWindow.complete, s.topWindow.windowDays],
      ['USD', (day - 6) * 86400000, end * 1000, true, 7]);
    const t = JSON.parse((await get('/api/top?limit=50')).body);
    assert.deepEqual(t.top.map((x) => [x.address, x.volume]), s.top.map((x) => [x.address, x.volume]), '/api/top reads the same ranking');
    // And the public route, whose labels api.js writes: the days it covers, by their dates.
    const v = JSON.parse((await get('/v1/addresses/top?limit=20', { 'x-api-key': FROZEN_KEY })).body);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.deepEqual([v.windowDays, v.moved.since, v.moved.to, v.moved.complete], [7, (day - 6) * 86400000, end * 1000, true]);
    assert.ok(v.note.includes(`${iso((day - 6) * 86400000)} to ${iso(end * 1000)}`), v.note);
    assert.deepEqual([v.top[0].address, v.top[0].volume], [A, 7e6]);
  });

  test('the terminal says which week its top addresses cover, lists their other currencies, and draws only its latest chart', async () => {
    const pending = [];
    const el = await runPage((await get('/')).body, '/', (u) => (u.startsWith('/api/history')
      ? new Promise((resolve) => pending.push({ u, resolve }))
      : get(u).then((r) => JSON.parse(r.body))));
    const iso = new Date(end * 1000).toISOString().slice(0, 10);
    assert.equal(el('#topCap').textContent, `By USD volume moved (in + out) over the 7 UTC days to ${iso}. Other currencies are listed under, not added in; transfers count every token.`);
    assert.match(el('#top').innerHTML, /7\.00M<div [^>]*>\+ 7\.00M EUR<\/div>/);

    // Page load asked for ALL. The reader picks EURC before it answers; EURC answers, then ALL, late.
    const all = pending.shift();
    assert.match(all.u, /token=ALL/);
    el('#tokenSeg').handlers.click({ target: { closest: () => ({ dataset: { tok: 'EURC' } }) }, currentTarget: { children: [] } });
    await settle();
    const eur = pending.shift();
    assert.match(eur.u, /token=EURC/);
    eur.resolve(JSON.parse((await get(eur.u)).body));
    await settle();
    all.resolve(JSON.parse((await get(all.u)).body));
    await settle();
    assert.equal(el('#chartTitle').textContent, 'EURC transfer volume', 'a late ALL answer does not re-title the euro chart in dollars');
    // Nor redraw it: the peak is EURC's 15-minute bucket (75,000), not the dollar line's (15,000).
    assert.match(el('#chartPeak').innerHTML, /^peak <b>75\.0K<\/b>/);
  });
});

// ---- 6 · the method says what the code does ----
test('the method says real volume leaves out mints and burns, and dates every correction', () => {
  const page = readFileSync(join(ROOT, 'public/methodology.html'), 'utf8');
  const section = (h) => page.slice(page.indexOf(`<h2>${h}</h2>`), page.indexOf('<h2>', page.indexOf(`<h2>${h}</h2>`) + 4));
  const flat = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  assert.match(flat(section('Three volume measures')), /mints and burns[^.]*not counted in real or adjusted volume/i);
  assert.match(page.match(/<tr><td>Real volume<\/td><td>(.*?)<\/td><\/tr>/)[1], /[Mm]ints and burns are left out/);
  assert.match(page.match(/<tr><td>Raw volume<\/td><td>(.*?)<\/td><\/tr>/)[1], /mints and burns included/);

  // Every figure that changed on 30 October carries a dated line saying what it was (CLAUDE.md).
  const dated = flat(page.split(/<\/p>|<\/tr>/).filter((b) => b.includes('Corrected on 30&nbsp;October&nbsp;2026')).join(' '));
  for (const [what, re] of [
    ['the default series', /token=ALL/], ['the filter\'s share', /address filter/], ['Gateway\'s share', /Gateway's share/],
    ['top addresses', /\/v1\/addresses\/top/], ['the digest', /printed raw volume as "24h volume"/],
    ['wallet entry pages', /\/protocol\/safe/], ['token pages', /per-token pages/],
  ]) assert.match(dated, re, `${what} carries a "Corrected on" line`);
});

test('the spec describes every field these corrections added or redefined', async () => {
  const { specJson } = await import('../openapi.js');
  const s = JSON.parse(specJson()).components.schemas;
  assert.ok(s.History.properties.denomination && s.History.properties.tokens, 'a series names its currency and tokens');
  assert.ok(s.FilteredAddresses.properties.excludedDenomination && s.FilteredAddresses.properties.excludedByDenomination);
  assert.ok(s.TopAddresses.properties.moved && s.TopAddresses.properties.denomination);
  assert.match(s.TopAddresses.properties.top.items.properties.volume.description, /over the window/);
  assert.match(s.Rankings.properties.chain.properties.volume24h.description, /Real volume/);
  assert.ok(s.Rankings.properties.chain.properties.rawVolume24h);
  assert.match(s.TokenSummary.description, /mints and burns left out/);
});
