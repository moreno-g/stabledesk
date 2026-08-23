// TVL — total value locked, measured as stablecoin balances held by contracts.
//
// Why this works here and would not work on Ethereum: value on Arc is denominated in stablecoins.
// There is no volatile base asset to price, and the assets that matter are the three we already
// index. So TVL reduces to `balanceOf(contract)` summed per protocol — no price oracle, no LP
// share maths, no per-protocol adapter. That is the whole reason a small team can measure this
// chain properly: DefiLlama needs hundreds of hand-written adapters because Ethereum's value is
// in exotic positions; Arc's is in three ERC-20s.
//
// What this deliberately does NOT claim:
//   · Balances held by plain wallets are not TVL. Only addresses with bytecode are counted, and
//     `is_contract` is established by eth_getCode, never guessed.
//   · A contract we cannot attribute to a registered protocol is reported as *unattributed*, with
//     its own line in the totals. It is never quietly folded into a protocol's number, and never
//     dropped — an ecosystem page that hides what it can't name is lying by omission.
//   · Assets other than the indexed stablecoins are invisible to this method. On a stablecoin
//     chain that is a small gap; on any other chain it would be a fatal one. Stated on /methodology.

import { rpcSoft, TOKENS, toUnits } from './rpc.js';
import * as db from './db.js';
import { PROTOCOLS, protocolForAddress, publicShape, registryStats } from './protocols.js';
import { getLabel } from './labels.js';
import { TVL_REFRESH_MS, TVL_WARMUP_MS, TVL_CHUNK, TVL_DELAY, TVL_MAX_TARGETS, TVL_ALWAYS_TOP, TVL_ROTATE_SLICE, TVL_CANDIDATE_MIN, IDENTITY_PER_PASS } from './constants.js';

// Where the rotation left off, in the same meta table the indexer keeps its checkpoint in.
const CURSOR_KEY = 'tvl_scan_cursor';

const BALANCE_OF = '0x70a08231';
const NAME = '0x06fdde03';
const SYMBOL = '0x95d89b41';
const DAY = 86400;

// Decodes a Solidity `string` return. Returns null on anything that isn't one — a contract that
// doesn't implement name() reverts, and rpcSoft hands back undefined for that slot by design.
export function decodeString(hex) {
  try {
    if (typeof hex !== 'string' || hex === '0x' || hex.length < 130) return null;
    const b = hex.slice(2);
    const off = parseInt(b.slice(0, 64), 16) * 2;
    const len = parseInt(b.slice(off, off + 64), 16) * 2;
    if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0 || len > 256) return null;
    const s = Buffer.from(b.slice(off + 64, off + 64 + len), 'hex').toString('utf8');
    // Control characters mean we decoded something that wasn't a string after all.
    const clean = s.replace(/[^\x20-\x7e]/g, '').trim();
    return clean.length ? clean.slice(0, 64) : null;
  } catch { return null; }
}

// balanceOf(address) calldata: selector + the address left-padded to 32 bytes.
const balanceCall = (token, holder) => ({
  method: 'eth_call',
  params: [{ to: token, data: BALANCE_OF + '0'.repeat(24) + holder.slice(2) }, 'latest'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, size) => { const o = []; for (let i = 0; i < arr.length; i += size) o.push(arr.slice(i, i + size)); return o; };
const today = () => Math.floor(Date.now() / 1000 / DAY) * DAY;

let timer = null;
let lastRun = { at: null, scanned: 0, contractsFound: 0, error: null };

// Contract discovery. The entity deriver already fills address_meta for the top addresses, but it
// can be switched off — so the scanner establishes bytecode presence itself for any ranked address
// it has never seen. markContract never overwrites an existing row, so the two cannot fight.
async function discoverContracts(limit) {
  const unknown = db.uncheckedAddresses(limit);
  if (!unknown.length) return 0;
  let found = 0;
  for (const part of chunk(unknown, TVL_CHUNK)) {
    const { out } = await rpcSoft(part.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    part.forEach((a, i) => {
      const code = out[i];
      if (typeof code !== 'string') return;      // endpoint gave us nothing — retry next cycle
      const isContract = code.length > 2;
      db.markContract(a, isContract, isContract ? (code.length - 2) / 2 : 0);
      if (isContract) found += 1;
    });
    await sleep(TVL_DELAY);
  }
  return found;
}

// One pass of balanceOf over every target × every indexed stablecoin.
async function scanBalances(targets) {
  const tokenAddrs = Object.keys(TOKENS);
  const rows = [];
  for (const part of chunk(targets, TVL_CHUNK)) {
    const calls = part.flatMap((holder) => tokenAddrs.map((t) => balanceCall(t, holder)));
    const { out } = await rpcSoft(calls);
    part.forEach((holder, i) => {
      tokenAddrs.forEach((t, j) => {
        const raw = out[i * tokenAddrs.length + j];
        if (typeof raw !== 'string' || raw === '0x') return;   // reverted or unanswered: not a zero
        let balance;
        try { balance = toUnits(raw, TOKENS[t].decimals); } catch { return; }
        if (!Number.isFinite(balance)) return;
        rows.push({ address: holder, token: TOKENS[t].symbol, balance });
      });
    });
    await sleep(TVL_DELAY);
  }
  return rows;
}

// Reads name()/symbol() for holders that carry a balance worth naming and have not been asked yet.
// Bounded per pass so it never competes with the balance scan for the rate limit, and asked once per
// address: a contract that answered nothing is a contract without a name, which is an answer.
async function probeIdentities() {
  // Read from the stored balances rather than from the scan that just ran. A pass whose balanceOf
  // calls were partly refused by the rate limit returns a short list, and keying the queue off that
  // list starved it: measured, the three largest holders on the chain went unasked while the budget
  // was spent on whatever happened to answer that minute. What is worth naming is a property of the
  // balances we hold, not of one scan's luck.
  const holding = new Map();
  for (const r of db.balanceRows()) holding.set(r.address, (holding.get(r.address) || 0) + r.balance);
  const known = db.addressIdentities([...holding.keys()]);
  const targets = [...holding.entries()]
    // Skip whatever the question is already settled for — named, or asked enough times to conclude
    // it has no name. Re-asking a settled address would spend the budget re-answering itself.
    .filter(([a, bal]) => bal >= TVL_CANDIDATE_MIN && !protocolForAddress(a) && !known.get(a)?.identity_checked)
    .sort((x, y) => y[1] - x[1])
    .slice(0, IDENTITY_PER_PASS)
    .map(([a]) => a);
  if (!targets.length) return 0;

  let found = 0;
  for (const part of chunk(targets, TVL_CHUNK)) {
    const { out } = await rpcSoft(part.flatMap((a) => [
      { method: 'eth_call', params: [{ to: a, data: NAME }, 'latest'] },
      { method: 'eth_call', params: [{ to: a, data: SYMBOL }, 'latest'] },
    ]));
    part.forEach((a, i) => {
      const rawName = out[i * 2];
      const rawSymbol = out[i * 2 + 1];
      // Did the endpoint answer at all? rpcSoft leaves a slot undefined both when the call reverted
      // (no such method) and when it was refused (rate limit), and those are opposite facts. A string
      // back — even '0x' — means the contract answered and simply has no name; nothing back means we
      // did not get to ask, and recording that as "nameless" is how 53 addresses were written off
      // while the chain answered for them on the next call.
      const answered = typeof rawName === 'string' || typeof rawSymbol === 'string';
      const name = decodeString(rawName);
      const symbol = decodeString(rawSymbol);
      if (answered) db.setAddressIdentity(a, name, symbol);
      else db.noteIdentityAttempt(a);
      if (name || symbol) found += 1;
    });
    await sleep(TVL_DELAY);
  }
  if (found) console.log(`[tvl] named ${found} previously anonymous holder(s)`);
  return found;
}

// Which contracts this pass reads, and which it defers.
//
// Registry contracts always, because a listed protocol with no measured balance is indistinguishable
// from one we simply did not look at. Then the highest-value contracts, because they decide the total
// and a stale reading there moves the headline figure. Whatever budget is left rotates through the
// rest in stable address order, so a contract outside the top is visited on a cycle rather than never.
//
// Before this, the same top 600 by balance were scanned every pass and 1,505 known contracts were
// never scanned at all — a systematic blind spot rather than a sampling one, which no amount of
// waiting would have fixed.
export function selectTargets(registry, known, opts = {}) {
  const always = opts.always ?? TVL_ALWAYS_TOP;
  const slice = opts.slice ?? TVL_ROTATE_SLICE;
  const cap = opts.cap ?? TVL_MAX_TARGETS;

  const hot = db.knownContracts(always);
  const cursor = opts.cursor ?? (db.getMetaValue(CURSOR_KEY) || '');
  const rotation = slice > 0 ? db.contractsAfter(cursor, slice) : { addresses: [], next: cursor };

  // Registry first so it can never be squeezed out by the cap, then value, then the rotation.
  const targets = [...new Set([...registry, ...hot, ...rotation.addresses])].slice(0, cap);
  return {
    targets,
    cursor: rotation.next,
    // The cursor moving backwards means the rotation wrapped: every known contract has now been
    // visited at least once since the last wrap. That is the honest definition of a completed cycle —
    // not a counter we increment and hope matches reality.
    wrapped: !!cursor && rotation.next !== '' && rotation.next < cursor,
    known,
  };
}

export async function refresh() {
  try {
    const contractsFound = await discoverContracts(40);

    // Registry addresses are always scanned, even with no recorded activity: a protocol that has
    // just deployed holds a balance before it shows up in any transfer ranking.
    const registry = PROTOCOLS.flatMap((p) => p.contracts);
    const known = db.knownContractCount();
    const { targets, cursor, wrapped } = selectTargets(registry, known);

    const rows = await scanBalances(targets);
    db.upsertBalances(rows);
    // Advanced only after the scan succeeded. Moving it first would skip a slice whenever a pass was
    // cut short by the rate limit, and those contracts would wait a full cycle for nothing.
    db.setMetaValue(CURSOR_KEY, cursor);
    invalidateAggregate();

    // Ask the contracts holding real value what they call themselves. The ecosystem page's job is to
    // turn unattributed value into named value, and its work queue was a column of bare hex — while
    // the contracts themselves answer name() and symbol() perfectly well. Measured on Arc testnet:
    // the second- and fifth-largest unnamed holders identify as "Synthra Perpetual Liquidity Token"
    // and "PerpDEX LP". This is derived from the chain, not asserted: a contract's own name is a
    // fact about the contract, and it is never treated as a claim about who operates it.
    const named = await probeIdentities();
    if (named) invalidateAggregate();

    // Persist today's level so tomorrow has something to diff against.
    const agg = aggregate();
    db.recordTvlSnapshot(today(), [
      { protocol: '*', tvl: agg.totals.tvl },
      ...agg.protocols.filter((p) => p.tvl > 0).map((p) => ({ protocol: p.id, tvl: p.tvl })),
    ]);

    lastRun = {
      at: Date.now(), scanned: targets.length, contractsFound, error: null,
      // How many contracts there are to scan against how many the ceiling allows. Past the ceiling,
      // chain TVL is the TVL of the contracts that fit — so which ones fit is a published fact, not
      // an implementation detail. They are now ordered by balance and then volume; they used to be
      // ordered by the hexadecimal value of their address, which decided coverage by accident.
      knownContracts: known, cap: TVL_MAX_TARGETS, atCap: known > TVL_MAX_TARGETS,
      cursor, wrapped,
    };
    if (wrapped) console.log(`[tvl] rotation completed a full cycle over ${known} known contracts`);
  } catch (e) {
    lastRun = { ...lastRun, at: Date.now(), error: String(e.message || e) };
    console.error('[tvl]', e.message || e);
  }
}

// Memoised aggregate. The underlying balances only change when refresh() runs, which is every five
// minutes — but aggregate() was called on every /api/ecosystem and /api/protocol request, and it reads
// the whole balance table plus one volume query per registered protocol. detail() called it, and
// addressDetail() called it twice. A short TTL, invalidated on write, makes a burst of requests cost
// one pass instead of one pass each.
let aggCache = { at: 0, value: null };
const AGG_TTL_MS = 15000;
const invalidateAggregate = () => { aggCache = { at: 0, value: null }; };

export function aggregate() {
  if (aggCache.value && Date.now() - aggCache.at < AGG_TTL_MS) return aggCache.value;
  const value = computeAggregate();
  aggCache = { at: Date.now(), value };
  return value;
}

// Pure aggregation over whatever is stored — no network. Exported so tests can drive it and so the
// API can serve a snapshot without waiting on a scan.
export function computeAggregate() {
  const rows = db.balanceRows();

  const byAddress = new Map();      // address -> { total, byToken }
  const byToken = {};
  let total = 0;
  for (const r of rows) {
    let e = byAddress.get(r.address);
    if (!e) { e = { total: 0, byToken: {} }; byAddress.set(r.address, e); }
    e.total += r.balance;
    e.byToken[r.token] = (e.byToken[r.token] || 0) + r.balance;
    byToken[r.token] = (byToken[r.token] || 0) + r.balance;
    total += r.balance;
  }

  const protocols = PROTOCOLS.map((p) => {
    let tvl = 0;
    const tokens = {};
    let withBalance = 0;
    for (const c of p.contracts) {
      const e = byAddress.get(c);
      if (!e) continue;
      withBalance += 1;
      tvl += e.total;
      for (const [t, v] of Object.entries(e.byToken)) tokens[t] = (tokens[t] || 0) + v;
    }
    const flow = db.volumeForAddresses(p.contracts);
    return {
      ...publicShape(p),
      tvl,
      tvlByToken: tokens,
      contractsWithBalance: withBalance,
      // `observed` separates "listed but we have never seen it do anything" from "listed and live".
      // Without it, a brand-new registry entry is indistinguishable from a dead one.
      observed: withBalance > 0 || flow.addressesSeen > 0,
      windowVolume: flow.volume,
      windowTransfers: flow.transfers,
    };
  }).sort((a, b) => b.tvl - a.tvl || a.name.localeCompare(b.name));

  let attributed = 0;
  for (const p of protocols) attributed += p.tvl;

  // Contracts holding real balances that no registry entry claims. This is the work queue: the
  // page shows them so they can be identified and listed, which is how the registry grows from
  // evidence instead of assumption.
  const shortlist = [...byAddress.entries()]
    .filter(([addr, e]) => e.total >= TVL_CANDIDATE_MIN && !protocolForAddress(addr))
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 50);
  // What each one says it is, read from the contract itself. A column of bare hex is a work queue
  // nobody can act on; "Synthra Perpetual Liquidity Token" is one somebody can. Derived, never
  // asserted — a contract's own name() is a fact about the contract and says nothing about who runs
  // it, which is exactly why these stay *unattributed* until a registry entry claims them.
  const ids = db.addressIdentities(shortlist.map(([a]) => a));
  const candidates = shortlist.map(([address, e]) => {
    const id = ids.get(address);
    return {
      address,
      tvl: e.total,
      byToken: e.byToken,
      label: getLabel(address)?.name || null,
      selfName: id?.token_name || null,
      selfSymbol: id?.token_symbol || null,
      kind: id?.kind || null,
      codeSize: id?.code_size ?? null,
      ...db.volumeForAddresses([address]),
    };
  });

  return {
    totals: {
      tvl: total,
      byToken,
      attributed,
      unattributed: total - attributed,
      // The honest headline for a young registry: how much of the chain's locked value we can
      // actually name. Reported next to the total, never instead of it.
      attributedShare: total ? attributed / total : 0,
      holders: byAddress.size,
    },
    protocols,
    candidates,
  };
}

// Chain-wide total only. The dashboard polls every few seconds and needs one number, so this skips
// the per-protocol attribution and flow lookups that aggregate() does — and now asks SQLite for the
// sum rather than reading every row, sorted by balance, in order to add them up in JS.
export const total = () => db.totalBalance();

// TVL movers — today's level against `daysBack` ago, per protocol. Drives the daily rankings.
export function movers(daysBack = 1) {
  const now = today();
  const then = now - daysBack * DAY;
  const out = [];
  for (const p of PROTOCOLS) {
    const a = db.tvlOn(p.id, then);
    const b = db.tvlOn(p.id, now);
    if (a == null || b == null) continue;         // no baseline yet — not a 0% change
    out.push({ id: p.id, name: p.name, from: a, to: b, delta: b - a, pct: a > 0 ? (b - a) / a : null });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

export const history = (protocol = '*', days = 30) => db.tvlSeries(protocol, today() - days * DAY);

// One protocol, with its per-contract breakdown. Contracts are listed individually and each one
// says whether it currently holds a balance — a protocol's headline TVL should always be traceable
// to the addresses it came from, otherwise the number is unauditable.
export function detail(id, opts = {}) {
  const agg = aggregate();
  const p = agg.protocols.find((x) => x.id === id);
  if (!p) return null;
  const contracts = p.contracts.map((address) => {
    const balances = db.balancesForAddress(address);
    const stats = db.addressStats(address);
    return {
      address,
      label: getLabel(address)?.name || null,
      tvl: balances.reduce((a, b) => a + b.balance, 0),
      byToken: Object.fromEntries(balances.map((b) => [b.token, b.balance])),
      windowVolume: stats?.volume || 0,
      windowTransfers: stats?.transfers || 0,
      lastBlock: stats?.last_block || null,
    };
  }).sort((a, b) => b.tvl - a.tvl);

  const recent = p.contracts
    .flatMap((c) => db.addressRecent(c, opts.recent || 8))
    .sort((a, b) => b.block - a.block)
    .slice(0, opts.recent || 8);

  return {
    ...p,
    share: agg.totals.tvl ? p.tvl / agg.totals.tvl : 0,
    contractDetail: contracts,
    recent,
    series: history(p.id, opts.days || 30),
    chainTvl: agg.totals.tvl,
    lastRun,
  };
}

// A single contract that no protocol claims. The unnamed-contracts list links here, so the page
// can show what is actually known about it rather than leading to a dead end — and it makes the
// "can you identify this?" ask concrete instead of abstract.
export function addressDetail(address) {
  const a = String(address || '').toLowerCase();
  const proto = protocolForAddress(a);
  if (proto) return detail(proto.id);
  const balances = db.balancesForAddress(a);
  const stats = db.addressStats(a);
  const meta = db.addressMeta(a);
  if (!balances.length && !stats && !meta) return null;
  const agg = aggregate();
  return {
    unnamed: true,
    address: a,
    label: getLabel(a)?.name || null,
    tvl: balances.reduce((x, b) => x + b.balance, 0),
    byToken: Object.fromEntries(balances.map((b) => [b.token, b.balance])),
    isContract: !!meta?.is_contract,
    kind: meta?.kind || null,
    codeSize: meta?.code_size || null,
    windowVolume: stats?.volume || 0,
    windowTransfers: stats?.transfers || 0,
    lastBlock: stats?.last_block || null,
    recent: db.addressRecent(a, 12),
    largest: db.addressLargest(a, 8),
    chainTvl: agg.totals.tvl,
    lastRun,
  };
}

// The full view served to /api/ecosystem.
export function snapshot() {
  const agg = aggregate();
  return {
    ...agg,
    registry: registryStats(),
    series: history('*', 30),
    lastRun,
    // Coverage, next to the total it constrains. Same reasoning as the noise-set cap: when there are
    // more contracts than the ceiling, the total is the total of the ones that fit, and a reader who
    // is not told cannot audit it.
    coverage: {
      scanned: lastRun.scanned || 0,
      knownContracts: lastRun.knownContracts ?? null,
      cap: TVL_MAX_TARGETS,
      // The cap still bounds a single pass, but it no longer bounds what is ever measured: the top
      // holders are rescanned every pass and the rest rotate, so every known contract is visited on a
      // cycle. atCap therefore now means "one pass does not cover everything", not "the tail is never
      // read" — which are very different claims about the same number.
      atCap: !!lastRun.atCap,
      alwaysTop: TVL_ALWAYS_TOP,
      rotatingSlice: TVL_ROTATE_SLICE,
      // How many passes it takes to visit every known contract once, at this slice size.
      cycleLength: TVL_ROTATE_SLICE > 0 && lastRun.knownContracts
        ? Math.max(1, Math.ceil(Math.max(0, lastRun.knownContracts - TVL_ALWAYS_TOP) / TVL_ROTATE_SLICE))
        : 1,
      // The honest cost of rotating: the oldest balance still counted in the total. A figure mixing
      // fresh and several-cycles-old readings has to say so, or it looks current and partly is not.
      oldestReadingMs: db.oldestBalanceReading(),
      order: 'registry, then balance, then rotating by address',
    },
    method: 'Stablecoin balances held by addresses with bytecode, read with balanceOf. See /methodology.',
  };
}

// Same warm-up reasoning as entities.js: on a cold start there are no ranked addresses yet, so
// poll quickly until there is something to scan, then settle into the slow cycle.
export function start() {
  const tick = async () => {
    await refresh();
    const warm = db.getTop(1).length > 0;
    timer = setTimeout(tick, warm ? TVL_REFRESH_MS : TVL_WARMUP_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, TVL_WARMUP_MS);
  timer.unref?.();
}
export function stop() { if (timer) { clearTimeout(timer); timer = null; } }
