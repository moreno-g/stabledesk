#!/usr/bin/env node
// Drafts the weekly report. Run it on the day of publication, after midnight UTC:
//
//   node scripts/weekly-report.mjs                     the week that ended yesterday
//   node scripts/weekly-report.mjs --date 2026-11-13   the report published on that date
//
// It reads the USDC daily series (the public MCP connector, no key; or /v1 when STABLEDESK_API_KEY is
// set, which also reads the infrastructure set), reads totalSupply() at the close of each day on an
// Arc RPC, and writes a draft:
//
//   reports/<slug>.html       the body, with {{LEAD}} where the finding that leads goes
//   reports/<slug>.draft.md   checks, candidates, records, the registry entry, the X thread (gitignored)
//
// Nothing is published, committed or posted, and no API key is ever created.
// On Fridays, .github/workflows/weekly-report.yml runs it and opens the draft as a draft pull request.
//
//   --date YYYY-MM-DD   publication date (default: today, UTC); the window is the seven days before it
//   --out DIR           where to write the draft (default: reports/)
//   --force             overwrite a draft already there (never a report listed in reports.js)
//   --rpc URL           Arc RPC (default: the public RPC of the network the series was measured on)
//   --record DIR        also save the series and every RPC answer there, to replay later
//   --replay DIR        read the series and the RPC answers from a recording: no network at all
//
// Exit 0: drafted, every check passed. Exit 2: drafted, but a check failed; the body then carries a
// {{…}} saying which, so it cannot be listed as is. Exit 1: nothing drafted.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS } from '../reports.js';
import { chainReader, dayCloser, makeRpc, recordingFetch, replayFetch } from './weekly-chain.mjs';
import {
  assertSeriesCovers, buildReport, candidates, closesFrom, gapText, isoDay, parseHistory, priorHigh, renderBody, renderNotes,
  reportWindow, supplyReadDays, thread, X_LIMIT,
} from './weekly.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://stabledesk.xyz';
const PROTOCOL = '2026-07-28';
// Public RPCs keeping historical state, by the chain id the series reports. Chosen from the data, never
// assumed: an unknown chain needs --rpc, and the RPC's own chain id is checked against the series.
const RPC_BY_CHAIN = { 5042: 'https://rpc.mainnet.arc.io', 5042002: 'https://rpc.testnet.arc.io' };
const UA = 'stabledesk-weekly-report';

function parseArgs(argv) {
  const out = {};
  const flags = new Set(['force']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !['date', 'out', 'force', 'rpc', 'record', 'replay'].includes(name)) throw new Error(`unknown argument ${argv[i]}`);
    if (flags.has(name)) out[name] = true;
    else if (argv[i + 1] == null) throw new Error(`${argv[i]} needs a value`);
    else out[name] = argv[++i];
  }
  if (out.record && out.replay) throw new Error('--record and --replay do not go together');
  return out;
}

const exists = (p) => access(p).then(() => true, () => false);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// The series, from the connector anyone can call (MCP 2026-07-28: no handshake, the version and the
// routing in headers and in params._meta), or from /v1 with a key.
async function readSeries(key) {
  if (key) {
    const [data, status] = await Promise.all([
      getJson(`${SITE}/v1/stablecoins/history?token=USDC&range=all`, { 'x-api-key': key }),
      getJson(`${SITE}/v1/status`),
    ]);
    // Only adds a sentence to the draft, so its absence is reported rather than fatal.
    const filtered = await getJson(`${SITE}/v1/addresses/filtered`, { 'x-api-key': key }).catch((e) => {
      console.error(`  infrastructure set not read: ${e.message}`);
      return null;
    });
    // /v1 bodies carry no chain id; /v1/status, from the same server, says which chain it indexes.
    return { series: { chainId: status.chainId, data }, filtered, source: `${SITE}/v1/stablecoins/history?token=USDC&range=all, with an API key` };
  }
  const res = await fetch(`${SITE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      'mcp-method': 'tools/call',
      'mcp-name': 'stablecoin_history',
      'user-agent': UA,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'stablecoin_history',
        arguments: { token: 'USDC', range: 'all' },
        _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} },
      },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${SITE}/mcp: HTTP ${res.status}`);
  const text = await res.text();
  // Streamable HTTP may answer as an event stream; the response is then the data of its last event.
  const series = (res.headers.get('content-type') || '').includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1))
    : JSON.parse(text);
  return { series, filtered: null, source: `the MCP connector at ${SITE}/mcp (stablecoin_history, token USDC, range all), without a key` };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const published = args.date ?? isoDay(Date.now());
  const win = reportWindow(published);
  const reportsDir = join(ROOT, 'reports');
  const outDir = resolve(args.out ?? reportsDir);
  const bodyPath = join(outDir, `${win.slug}.html`);
  const notesPath = join(outDir, `${win.slug}.draft.md`);
  // A listed report is a publication. It is not redrafted in place, --force or not.
  if (outDir === reportsDir && REPORTS.some((r) => r.slug === win.slug)) {
    throw new Error(`${win.slug} is published (reports.js) and stays as published; draft it elsewhere with --out`);
  }
  if (!args.force && await exists(bodyPath)) throw new Error(`${relative(process.cwd(), bodyPath)} exists; --force overwrites it`);

  let series, filtered, source, recorded = null;
  if (args.replay) {
    const load = async (f) => JSON.parse(await readFile(join(args.replay, f), 'utf8'));
    recorded = await load('meta.json');
    series = await load('series.json');
    filtered = await exists(join(args.replay, 'filtered.json')) ? await load('filtered.json') : null;
    source = `${recorded.source}, as recorded on ${recorded.recorded}`;
  } else {
    ({ series, filtered, source } = await readSeries(process.env.STABLEDESK_API_KEY));
  }
  const hist = parseHistory(series);
  const { network } = assertSeriesCovers(hist, published);

  const rpcUrl = args.rpc ?? recorded?.rpc ?? RPC_BY_CHAIN[hist.chainId];
  if (!rpcUrl) throw new Error(`no public RPC known for chain ${hist.chainId}: pass --rpc`);
  const calls = {};
  const rpcFetch = args.replay ? replayFetch(JSON.parse(await readFile(join(args.replay, 'rpc.json'), 'utf8')).calls)
    : args.record ? recordingFetch(fetch, calls) : fetch;
  const chain = chainReader(makeRpc(rpcUrl, { fetch: rpcFetch, log: (msg) => console.error(`  ${msg}`) }));
  const chainId = await chain.chainId();
  if (chainId !== hist.chainId) throw new Error(`${rpcUrl} serves chain ${chainId}; the series was measured on chain ${hist.chainId}`);
  const decimals = await chain.decimals();
  if (decimals !== 6) throw new Error(`USDC reports ${decimals} decimals; the comparison with the index assumes 6`);

  console.error(`Reading USDC supply on ${network} at the close of ${supplyReadDays(win).length} days…`);
  const closeOf = dayCloser(chain);
  const reads = new Map();
  const read = async (day) => {
    const b = await closeOf(day);
    reads.set(day, { block: b.number, timestamp: b.timestamp, supply: await chain.totalSupply(b.number) });
  };
  for (const day of supplyReadDays(win).reverse()) await read(day);
  // The highest close before the week comes out of the series; it is then read on chain as well. The
  // loop ends once the high found is a day already read (a new read can move it, so up to three times).
  for (let i = 0; i < 3; i++) {
    const high = priorHigh(closesFrom(hist, reads, win.to), win);
    if (!high || reads.has(high.day)) break;
    await read(high.day);
  }

  const m = buildReport({ hist, published, reads, filtered, source });
  const cands = candidates(m);
  const th = thread(m, cands);
  await mkdir(outDir, { recursive: true });
  await writeFile(bodyPath, renderBody(m));
  await writeFile(notesPath, renderNotes(m, cands, th) + '\n');

  if (args.record) {
    await mkdir(args.record, { recursive: true });
    await writeFile(join(args.record, 'meta.json'), JSON.stringify({ recorded: new Date().toISOString().slice(0, 16) + 'Z', source, rpc: rpcUrl }, null, 1) + '\n');
    await writeFile(join(args.record, 'series.json'), JSON.stringify(series) + '\n');
    if (filtered) await writeFile(join(args.record, 'filtered.json'), JSON.stringify(filtered) + '\n');
    await writeFile(join(args.record, 'rpc.json'), JSON.stringify({ note: 'eth_getBlockByNumber answers are trimmed to number and timestamp', calls }, null, 1) + '\n');
  }

  const rel = (p) => { const r = relative(process.cwd(), p); return r.startsWith('..') ? p : r; };
  const failed = m.checks.filter((c) => !c.ok);
  const lengths = (ps) => ps.map((p) => `${p.length}${p.length > X_LIMIT ? '!' : ''}`).join(', ');
  console.log(`Draft for ${m.labels.cur} (${network}), to publish on ${published}`);
  console.log(`  body   ${rel(bodyPath)}   ({{LEAD}} still to write)`);
  console.log(`  notes  ${rel(notesPath)}`);
  console.log(failed.length
    ? `  SUPPLY CHECK FAILED on ${failed.map((c) => `${c.from} → ${c.to} (gap $${gapText(c.gap)})`).join(', ')}: the body says so in a {{…}}`
    : `  supply: ${m.checks.length} changes of totalSupply() equal the index's mint − burn, to the cent`);
  if (!filtered) console.log('  infrastructure cap: not checked (needs STABLEDESK_API_KEY)');
  console.log(`  ${cands.length} candidates for the title and the lead; the choice is yours`);
  console.log(`  X thread (weighted, /${X_LIMIT}): openers ${lengths(th.openers)}; then ${lengths(th.posts)}`);
  return failed.length ? 2 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(`weekly-report: ${err.message}`);
  process.exitCode = 1;
});
