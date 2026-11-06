// Weekly report drafts: every computation, with no network and no clock.
//
// The first weekly report (reports/2026-11-05.html) was computed by scripts kept in a temporary folder,
// and the folder went. This module is those computations, versioned and tested, so a Friday report is
// generated rather than rebuilt; scripts/weekly-report.mjs does the reading and writing around it.
//
// It drafts and stops there. Figures, tables and the fixed sections are generated. Which finding
// leads, and the title, are a person's call: the draft lists the candidates with their figures and
// leaves {{LEAD}} where the choice goes. A body still holding a placeholder fails the reports test as
// soon as it is listed in reports.js, so a draft cannot be published by accident.
//
// Each figure is formatted once, and the table, the prose, the candidates and the posts all print that
// one string: a title cannot say 10% where a post says 9.7%, as the first report's did.

import { NETWORK_LABELS } from '../reports.js';
import { USDC } from './weekly-chain.mjs';

// ---- days ----

const DAY_MS = 86400e3;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const addDays = (iso, n) => isoDay(dayMs(iso) + n * DAY_MS);
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// The rule reports.js states and test/smoke.test.js enforces: the last seven complete UTC days before
// publication, so the week is fixed by the date and never chosen for how it reads.
export function reportWindow(published) {
  if (!ISO.test(published) || isoDay(dayMs(published)) !== published) throw new Error(`not a calendar date: ${published}`);
  const to = addDays(published, -1);
  const from = addDays(to, -6);
  const prevTo = addDays(from, -1);
  return { slug: to, from, to, published, prev: { from: addDays(prevTo, -6), to: prevTo } };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymd = (iso) => iso.split('-').map(Number);
export const dayShort = (iso) => { const [, m, d] = ymd(iso); return `${d} ${MONTHS[m - 1]}`; };      // 4 Nov
export const dayLong = (iso) => { const [, m, d] = ymd(iso); return `${d} ${MONTHS_LONG[m - 1]}`; };  // 4 November
export const dayFull = (iso) => `${dayLong(iso)} ${ymd(iso)[0]}`;                                     // 4 November 2026
// "23–29 Oct", or "30 Oct – 5 Nov" across a month: the table headers of the first report.
export function weekShort(from, to) {
  const [, ma, da] = ymd(from), [, mb, db] = ymd(to);
  return ma === mb ? `${da}–${db} ${MONTHS[mb - 1]}` : `${da} ${MONTHS[ma - 1]} – ${db} ${MONTHS[mb - 1]}`;
}
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const inWords = (n) => WORDS[n] ?? String(n);

// ---- numbers: one formatted string per figure ----

const MINUS = '\u2212'; // MINUS SIGN, as the published report prints it; X counts it double
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const noDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const isZero = (shown) => /^[0.,]+$/.test(shown);
const signed = (x, shown) => `${isZero(shown) ? '' : x < 0 ? MINUS : '+'}${shown}`;
export const usd = (x) => { const s = oneDecimal.format(Math.abs(x) / 1e6); return `${x < 0 && !isZero(s) ? MINUS : ''}${s}M`; };
export const usdSigned = (x) => `${signed(x, oneDecimal.format(Math.abs(x) / 1e6))}M`;
export const pct = (x) => `${signed(x, oneDecimal.format(Math.abs(x)))}%`;
export const pctAbs = (x) => `${oneDecimal.format(Math.abs(x))}%`;
export const share = (x) => { const s = noDecimal.format(Math.abs(x)); return `${x < 0 && !isZero(s) ? MINUS : ''}${s}%`; };
export const count = (n) => noDecimal.format(n);

// ---- the series ----

export const COLUMNS = ['volume', 'rvolume', 'avolume', 'cnt', 'mint', 'burn', 'cmint', 'cburn', 'bmint', 'bburn'];

// Accepts what either source returns: the MCP tools/call response (JSON-RPC envelope), its
// structuredContent ({ network, chainId, data }), or a /v1/stablecoins/history body wrapped the same
// way. The chain id travels with the series, because the report's network label is derived from it.
export function parseHistory(json) {
  let doc = json;
  if (doc?.jsonrpc === '2.0') {
    if (doc.error) throw new Error(`MCP error ${doc.error.code}: ${doc.error.message}`);
    const r = doc.result;
    if (r?.isError) throw new Error(`stablecoin_history: ${(r.content || []).map((c) => c.text).join(' ')}`);
    doc = r?.structuredContent ?? JSON.parse(r?.content?.[0]?.text ?? 'null');
  }
  const meta = doc?.data && doc.chainId != null ? doc : null;
  const data = meta ? meta.data : doc;
  const s = data?.series;
  const rows = Array.isArray(s) ? s
    : s && Array.isArray(s.columns) && Array.isArray(s.rows) ? s.rows.map((r) => Object.fromEntries(s.columns.map((c, i) => [c, r[i]])))
      : null;
  if (!rows) throw new Error('the response carries no series');
  if (data.group !== 86400) throw new Error(`the series must be in UTC days, not ${data.group}-second buckets: ask for range all`);
  const byDay = new Map();
  for (const r of rows) {
    if (!Number.isInteger(r.t) || r.t % 86400 !== 0) throw new Error(`bucket ${r.t} does not start at midnight UTC`);
    byDay.set(isoDay(r.t * 1000), r);
  }
  return {
    token: data.token, chainId: meta?.chainId ?? null, network: meta?.network ?? null,
    windowEnd: data.windowEnd, recordBegan: data.recordBegan, byDay,
  };
}

export function sumWindow(hist, from, to) {
  const s = Object.fromEntries(COLUMNS.map((c) => [c, 0]));
  for (const d of daysBetween(from, to)) {
    const r = hist.byDay.get(d);
    if (!r) continue; // no row is a day with no activity: stablecoin_history says so
    for (const c of COLUMNS) {
      if (!Number.isFinite(r[c])) throw new Error(`${c} is missing on ${d}: a figure that was not read is not a zero`);
      s[c] += r[c];
    }
  }
  return s;
}

// The week's measures. Raw counts every Transfer, mints and burns included; real and adjusted leave
// them out. CCTP (cmint/cburn) and Circle Gateway (bmint/bburn) move dollars that already existed, so
// organic issuance is what is left of mint and burn once both routes are taken out.
export function weekFigures(s) {
  const organicIn = s.mint - s.cmint - s.bmint, organicOut = s.burn - s.cburn - s.bburn;
  return {
    raw: s.volume, real: s.rvolume, adjusted: s.avolume, cnt: s.cnt,
    mintBurn: s.mint + s.burn, rawExMintBurn: s.volume - s.mint - s.burn,
    mint: s.mint, burn: s.burn, net: s.mint - s.burn,
    cctpIn: s.cmint, cctpOut: s.cburn, cctpNet: s.cmint - s.cburn,
    gatewayIn: s.bmint, gatewayOut: s.bburn, gatewayNet: s.bmint - s.bburn,
    organicIn, organicOut, organicNet: organicIn - organicOut, organicGross: organicIn + organicOut,
  };
}

export const change = (cur, prev) => (prev > 0 ? (cur / prev - 1) * 100 : null);

// ---- records: every window of seven complete UTC days since the record began ----

export const MEASURES = [
  { key: 'raw', label: 'Raw volume' },
  { key: 'real', label: 'Real volume' },
  { key: 'adjusted', label: 'Adjusted volume' },
  { key: 'cnt', label: 'Transfer events', unit: 'count' },
  { key: 'mintBurn', label: 'Mints and burns' },
  { key: 'rawExMintBurn', label: 'Raw volume without mints and burns' },
  { key: 'cctpIn', label: 'CCTP in' },
  { key: 'cctpOut', label: 'CCTP out' },
  { key: 'gatewayIn', label: 'Circle Gateway in' },
  { key: 'gatewayOut', label: 'Circle Gateway out' },
  { key: 'organicIn', label: 'Organic issuance, created' },
  { key: 'organicOut', label: 'Organic issuance, destroyed' },
  { key: 'net', label: 'Net issuance', unit: 'signed' },
];

// A day that began before the record did is not complete, and no window may start on it.
export function firstCompleteDay(recordBeganSec) {
  const d = isoDay(recordBeganSec * 1000);
  return recordBeganSec * 1000 === dayMs(d) ? d : addDays(d, 1);
}

// Every window that starts at midnight UTC and ends on or before `lastDay`, overlapping ones included:
// "the most in any seven complete UTC days" has to beat the windows that share days with the week too.
export function rollingWeeks(hist, lastDay) {
  const out = [];
  for (let to = addDays(firstCompleteDay(hist.recordBegan), 6); to <= lastDay; to = addDays(to, 1)) {
    const from = addDays(to, -6);
    out.push({ from, to, f: weekFigures(sumWindow(hist, from, to)) });
  }
  return out;
}

// Where the week ending `to` ranks on each measure. Rank 1 is the highest; "highest" and "lowest" are
// strict, so a tie is never called a record.
export function records(weeks, to) {
  const cur = weeks.find((w) => w.to === to);
  if (!cur) throw new Error(`no window of seven complete UTC days ends on ${to}`);
  const others = weeks.filter((w) => w !== cur);
  return MEASURES.map((m) => {
    const v = cur.f[m.key];
    const above = others.filter((w) => w.f[m.key] > v).length;
    const below = others.filter((w) => w.f[m.key] < v).length;
    const pick = (better) => others.reduce((a, w) => (a == null || better(w.f[m.key], a.f[m.key]) ? w : a), null);
    const hi = pick((x, y) => x > y), lo = pick((x, y) => x < y);
    const at = (w) => (w ? { from: w.from, to: w.to, value: w.f[m.key] } : null);
    return {
      ...m, value: v, rank: above + 1, of: weeks.length,
      highest: others.length > 0 && below === others.length,
      lowest: others.length > 0 && above === others.length,
      otherHigh: at(hi), otherLow: at(lo),
    };
  });
}

// ---- supply ----

// Closes read on chain: the day before the previous week (its starting supply) through the last day of
// the week, so every daily change of both weeks is checked against the index.
export const supplyReadDays = (win) => daysBetween(addDays(win.prev.from, -1), win.to);

// The comparison is made to half a cent. totalSupply() is exact; the index adds floats, which leaves
// it within about a micro-dollar, far inside that.
export const SUPPLY_TOLERANCE_USD = 0.005;

const closeUsd = (read) => Number(read.supply) / 1e6;

// Each read against the one before it: the change in totalSupply() must equal the index's mint − burn
// over the days in between. A gap is reported, never smoothed over.
export function supplyChecks(hist, reads) {
  const days = [...reads.keys()].sort();
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const a = days[i - 1], b = days[i];
    const onChain = Number(reads.get(b).supply - reads.get(a).supply) / 1e6;
    let index = 0;
    for (const d of daysBetween(addDays(a, 1), b)) {
      const r = hist.byDay.get(d);
      if (r) index += r.mint - r.burn;
    }
    out.push({ from: a, to: b, onChain, index, gap: onChain - index, ok: Math.abs(onChain - index) < SUPPLY_TOLERANCE_USD });
  }
  return out;
}

// End-of-day supply on every day of the record, from the reads and the series: before the earliest
// read, each close is the next one minus the next day's mint − burn, which is the rule the report's
// Reproduce section gives readers; after it, a read where there is one.
export function closesFrom(hist, reads, lastDay) {
  const readDays = [...reads.keys()].sort();
  const net = (d) => { const r = hist.byDay.get(d); return r ? r.mint - r.burn : 0; };
  const out = new Map();
  let s = closeUsd(reads.get(readDays[0]));
  out.set(readDays[0], { usd: s, read: true });
  const first = firstCompleteDay(hist.recordBegan);
  for (let d = readDays[0]; d > first; d = addDays(d, -1)) {
    s -= net(d);
    out.set(addDays(d, -1), { usd: s, read: false });
  }
  s = closeUsd(reads.get(readDays[0]));
  for (const d of daysBetween(addDays(readDays[0], 1), lastDay)) {
    s = reads.has(d) ? closeUsd(reads.get(d)) : s + net(d);
    out.set(d, { usd: s, read: reads.has(d) });
  }
  // A close read before the record began is a starting point, not a day "since launch".
  for (const d of out.keys()) if (d < first) out.delete(d);
  return out;
}

// The highest close before the week: what a new high is measured against. Its day gets read on chain
// too, so the comparison stands on two reads rather than on one read and a reconstruction.
export function priorHigh(closes, win) {
  let best = null;
  for (const [day, c] of closes) if (day < win.from && (best == null || c.usd > best.usd)) best = { day, ...c };
  return best;
}

// ---- X's weighted length (twitter-text v3) ----

// Weight 1 for these code-point ranges, 2 for everything else; every URL counts 23 whatever its length;
// the text is NFC-normalised first and an emoji sequence counts as one heavy character. So "−" (U+2212)
// and "→" weigh 2, where "–" (U+2013) and "·" weigh 1.
const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
export const X_LIMIT = 280;
export const X_URL = 23;
// Links with a scheme, and bare domains on the generic TLDs X links without one. Trailing punctuation
// stays text, as X leaves it out of the link.
const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|app|dev|ai|info)\b(?:\/[^\s]*)?/giu;
export function xLength(text) {
  let n = 0;
  const rest = text.normalize('NFC')
    .replace(URL_RE, (m) => { n += X_URL; return m.match(/[.,:;!?)\]'"]+$/)?.[0] ?? ''; })
    .replace(/\p{RGI_Emoji}/gv, () => { n += 2; return ''; });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    n += LIGHT.some(([a, b]) => c >= a && c <= b) ? 1 : 2;
  }
  return n;
}

// Figures as a reader sees them: "9.7%", "1,213.6M", "823,656", "29,749,315". A title or summary may
// only quote a figure the body prints, at the same precision; the first report's title said 10% for
// the 9.7% in its body, and this is the check that would have caught it.
export const figureTokens = (text) => [...new Set(String(text).match(/\d[\d,]*(?:\.\d+)?(?:M|%)|\d{1,3}(?:,\d{3})+/g) || [])];
export function unmatchedFigures(text, body) {
  const plain = body.replaceAll('&amp;', '&');
  return figureTokens(text).filter((t) => !new RegExp(`(?<![\\d.,])${t.replace(/[.]/g, '\\.')}(?![\\d])`).test(plain));
}

// ---- the report, computed ----

// When sent history began. /v1/addresses/filtered states it (sentHistorySince), behind a key; without
// one, the date the first report gives. Until a full month after it, an address active earlier was
// judged on less than a month of sending, which flags fewer addresses and puts adjusted volume above
// where it settles.
export const SENT_HISTORY_SINCE = '2026-09-27';

const moved = (pctValue) => (pctValue == null ? 'cannot be compared'
  : isZero(oneDecimal.format(Math.abs(pctValue))) ? 'was flat' : `${pctValue > 0 ? 'rose' : 'fell'} ${pctAbs(pctValue)}`);
const direction = (pctValue) => (pctValue == null ? 'cannot be compared' : isZero(oneDecimal.format(Math.abs(pctValue))) ? 'was flat' : pctValue > 0 ? 'rose' : 'fell');

// Whether a series can carry the report published on `published`: a known network, USDC, both weeks
// inside the record, and the last day of the window measured to its end. Throws with the reason.
export function assertSeriesCovers(hist, published) {
  const win = reportWindow(published);
  const network = NETWORK_LABELS[hist.chainId];
  if (!network) throw new Error(`chain id ${hist.chainId} has no network label in reports.js: the series does not say which network it measured`);
  if (hist.network && hist.network !== network) throw new Error(`the series says ${hist.network}, its chain id ${hist.chainId} says ${network}`);
  if (hist.token !== 'USDC') throw new Error(`the series is ${hist.token}, the report covers USDC`);
  if (!(hist.windowEnd >= dayMs(published))) {
    throw new Error(`the index has measured up to ${new Date(hist.windowEnd).toISOString()}, not the whole of ${win.to}: run it again once it has`);
  }
  const first = firstCompleteDay(hist.recordBegan);
  if (first > win.prev.from) throw new Error(`the record begins on ${first}, after the previous week starts (${win.prev.from})`);
  return { win, network, first };
}

export function buildReport({ hist, published, reads, filtered = null, source = null }) {
  const { win, network, first } = assertSeriesCovers(hist, published);
  for (const d of supplyReadDays(win)) if (!reads.has(d)) throw new Error(`no supply read for the close of ${d}`);

  const cur = weekFigures(sumWindow(hist, win.from, win.to));
  const prev = weekFigures(sumWindow(hist, win.prev.from, win.prev.to));
  const weeks = rollingWeeks(hist, win.to);
  const recs = records(weeks, win.to);
  const rec = Object.fromEntries(recs.map((r) => [r.key, r]));

  const closes = closesFrom(hist, reads, win.to);
  const high = priorHigh(closes, win);
  if (high && !reads.has(high.day)) throw new Error(`read the close of ${high.day} as well: it is the highest before the week`);
  const checks = supplyChecks(hist, reads);
  const supplyOk = checks.every((c) => c.ok);
  const at = (d) => closeUsd(reads.get(d));
  const weekDays = daysBetween(win.from, win.to);
  const weekHighDay = weekDays.reduce((a, d) => (at(d) > at(a) ? d : a));
  const before = addDays(win.from, -1), prevBefore = addDays(win.prev.from, -1);
  const supply = {
    start: at(before), end: at(win.to), growth: at(win.to) - at(before),
    prevGrowth: at(win.prev.to) - at(prevBefore),
    weekHigh: { day: weekHighDay, usd: at(weekHighDay) },
    priorHigh: high ? { day: high.day, usd: high.usd } : null,
    rows: [...new Set([prevBefore, ...(high && high.day < win.from ? [high.day] : []), win.prev.to, ...weekDays])].sort()
      .map((d) => ({ day: d, usd: at(d), block: reads.get(d).block })),
    // The chain's own average over the week, from the two blocks that bound it.
    blockMs: (reads.get(win.to).timestamp - reads.get(before).timestamp) * 1000 / (reads.get(win.to).block - reads.get(before).block),
  };

  // Adjusted volume is not comparable across the date sent history reached a full month.
  // sentHistorySince is in Unix milliseconds (openapi.js).
  const since = Number.isFinite(filtered?.sentHistorySince) ? isoDay(filtered.sentHistorySince) : SENT_HISTORY_SINCE;
  const full = addDays(since, 30);
  const avgAdjusted = (days) => days.reduce((a, d) => a + (hist.byDay.get(d)?.avolume ?? 0), 0) / days.length;
  const prevDays = daysBetween(win.prev.from, win.prev.to);
  const short = prevDays.filter((d) => d < full);
  const caveat = short.length && weekDays.every((d) => d >= full) ? {
    since, full, days: short.length,
    shortAvg: avgAdjusted(short), restAvg: short.length < 7 ? avgAdjusted(prevDays.filter((d) => d >= full)) : null,
    weekAvg: avgAdjusted(weekDays),
  } : null;

  const fig = (key, fmt = usd) => {
    const c = change(cur[key], prev[key]);
    return { cur: fmt(cur[key]), prev: fmt(prev[key]), change: c == null ? 'n/a' : pct(c), moved: moved(c), dir: direction(c), pct: c };
  };
  const F = {
    raw: fig('raw'), mintBurn: fig('mintBurn'), rawExMintBurn: fig('rawExMintBurn'),
    real: fig('real'), adjusted: fig('adjusted'), cnt: fig('cnt', count),
  };
  const dRaw = cur.raw - prev.raw, dMB = cur.mintBurn - prev.mintBurn;
  F.mbShare = dRaw > 0 && dMB > 0 && dMB <= dRaw ? { share: share(dMB / dRaw * 100), of: 'rise' }
    : dRaw < 0 && dMB < 0 && dMB >= dRaw ? { share: share(dMB / dRaw * 100), of: 'fall' } : null;
  const routesNet = cur.cctpNet + cur.gatewayNet;
  F.routes = {
    cctp: usdSigned(cur.cctpNet), gateway: usdSigned(cur.gatewayNet), organic: usdSigned(cur.organicNet), total: usdSigned(cur.net),
    sum: usdSigned(routesNet), prevCctp: usdSigned(prev.cctpNet), prevGateway: usdSigned(prev.gatewayNet), prevOrganic: usdSigned(prev.organicNet),
  };
  const growthShare = (part, whole) => (whole > 0 && part >= 0 && part <= whole ? share(part / whole * 100) : null);
  F.organicShare = growthShare(cur.organicNet, cur.net);
  F.prevOrganicShare = growthShare(prev.organicNet, prev.net);
  F.grossShare = cur.mintBurn > 0 ? share(cur.organicGross / cur.mintBurn * 100) : null;
  F.supply = {
    start: usd(supply.start), end: usd(supply.end), growth: usdSigned(supply.growth),
    prevGrowth: usdSigned(supply.prevGrowth), weekHigh: usd(supply.weekHigh.usd), priorHigh: supply.priorHigh && usd(supply.priorHigh.usd),
  };
  const newHigh = supply.priorHigh == null || supply.weekHigh.usd > supply.priorHigh.usd;

  return {
    win, network, chainId: hist.chainId, source, windowEnd: hist.windowEnd, first, cur, prev, F, recs, rec, weeks: weeks.length,
    supply, newHigh, checks, supplyOk, caveat, filtered, hist, reads,
    labels: { cur: weekShort(win.from, win.to), prev: weekShort(win.prev.from, win.prev.to) },
  };
}

// ---- candidates for the title and the lead ----

// Every finding the figures support, each with the figures it rests on, in the order of the report's
// sections. Not ranked and not chosen: picking what leads is the one editorial act, and it stays human.
export function candidates(m) {
  const { F, rec, cur, supply } = m;
  const out = [];
  const add = (id, text, figures) => out.push({ id, text, figures });
  const rank = (r) => `rank ${r.rank} of ${r.of} windows`;
  const most = 'the most in any seven complete UTC days since launch';
  const least = 'the least in any seven complete UTC days since launch';

  add('raw', rec.raw.highest ? `Raw USDC volume reached ${F.raw.cur}, ${most}` : `Raw USDC volume ${F.raw.moved}, to ${F.raw.cur}`,
    `raw ${F.raw.cur} against ${F.raw.prev} (${F.raw.change}); ${rank(rec.raw)}`);
  add('real', `Real volume ${F.real.moved}, to ${F.real.cur}`, `real ${F.real.cur} against ${F.real.prev} (${F.real.change}); ${rank(rec.real)}`);
  add('adjusted', `Adjusted volume ${F.adjusted.moved}, to ${F.adjusted.cur}`,
    `adjusted ${F.adjusted.cur} against ${F.adjusted.prev} (${F.adjusted.change}); ${rank(rec.adjusted)}`);
  if (F.mbShare) {
    add('mint-burn-share', `Mints and burns, which raw volume counts and real volume leaves out, account for ${F.mbShare.share} of raw volume's ${F.mbShare.of}`,
      `mints and burns ${F.mintBurn.cur} against ${F.mintBurn.prev}; raw ${F.raw.cur} against ${F.raw.prev}; without them raw ${F.rawExMintBurn.moved}`);
  }
  add('supply', `Supply ended the week at ${F.supply.end}: ${F.supply.growth}, against ${F.supply.prevGrowth} the previous week`,
    `close ${F.supply.start} → ${F.supply.end}; previous week ${F.supply.prevGrowth}`);
  if (m.newHigh) {
    add('supply-high', `Supply closed at ${F.supply.weekHigh} on ${dayLong(supply.weekHigh.day)}, the highest end-of-day supply since launch`,
      supply.priorHigh ? `previous highest close ${F.supply.priorHigh} on ${dayLong(supply.priorHigh.day)}` : 'no earlier close');
  }
  add('organic', `Organic issuance netted ${F.routes.organic}${F.organicShare ? `, ${F.organicShare} of the week's growth` : ''}`,
    `created ${usd(cur.organicIn)}, destroyed ${usd(cur.organicOut)}; previous week ${F.routes.prevOrganic}${F.prevOrganicShare ? ` (${F.prevOrganicShare} of its growth)` : ''}`);
  if (rec.organicIn.highest || rec.organicOut.highest) {
    const side = rec.organicIn.highest && rec.organicOut.highest ? 'the most on both sides' : rec.organicIn.highest ? 'the most created' : 'the most destroyed';
    add('organic-gross', `Gross organic issuance: ${usd(cur.organicIn)} created and ${usd(cur.organicOut)} destroyed, ${side} in any seven complete UTC days since launch`,
      `created ${rank(rec.organicIn)}, destroyed ${rank(rec.organicOut)}`);
  }
  add('routes', `The cross-chain routes netted ${F.routes.sum}: CCTP ${F.routes.cctp}, Circle Gateway ${F.routes.gateway}`,
    `CCTP in ${usd(cur.cctpIn)}, out ${usd(cur.cctpOut)}; Gateway in ${usd(cur.gatewayIn)}, out ${usd(cur.gatewayOut)}; previous week CCTP ${F.routes.prevCctp}, Gateway ${F.routes.prevGateway}`);
  // Any other measure at its highest or lowest, so a record is never missed for want of a template.
  // The highs of raw volume and of gross organic issuance already have a candidate of their own above.
  const covered = new Set(['raw', 'organicIn', 'organicOut']);
  for (const r of m.recs) {
    if (!(r.highest || r.lowest) || (r.highest && covered.has(r.key))) continue;
    const v = r.unit === 'count' ? count(r.value) : r.unit === 'signed' ? usdSigned(r.value) : usd(r.value);
    add(`record-${r.key}`, `${r.label}: ${v}, ${r.highest ? most : least}`, rank(r));
  }
  return out;
}

// ---- the body: reports/<slug>.html ----

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const row = (cells) => `<tr>${cells.map((c, i) => (i === 0 ? `<td>${c}</td>` : `<td class="num">${c}</td>`)).join('')}</tr>`;
const table = (head, rows) => `    <div class="tbl"><table>
      <thead><tr>${head.map((h, i) => (i === 0 ? `<th>${h}</th>` : `<th class="num">${h}</th>`)).join('')}</tr></thead>
      <tbody>
${rows.map((r) => `        ${r}`).join('\n')}
      </tbody>
    </table></div>`;

function volumeHeading(F) {
  const ups = ['raw', 'real', 'adjusted'].filter((k) => F[k].pct > 0).length;
  const downs = ['raw', 'real', 'adjusted'].filter((k) => F[k].pct < 0).length;
  if (ups === 3) return 'all three measures up';
  if (downs === 3) return 'all three measures down';
  if (ups + downs < 3) return `${inWords(ups)} up, ${inWords(downs)} down, ${inWords(3 - ups - downs)} flat`;
  return ups === 1 ? 'one measure up, two down' : 'two measures up, one down';
}

function volumeProse(m) {
  const { F } = m;
  const out = [`<strong>Raw</strong> counts every Transfer event the token contract emits, mints and burns included. <strong>Real</strong> keeps the largest transfer per transaction, per token, so routing hops and contract internals are not counted twice, and leaves mints and burns out. <strong>Adjusted</strong> is real volume minus transfers where both ends are infrastructure.`];
  const tail = `raw volume ${F.rawExMintBurn.moved}, and real volume ${F.real.dir}.`;
  out.push(F.mbShare ? `Mints and burns account for ${F.mbShare.share} of raw volume's ${F.mbShare.of}; without them, ${tail}` : `Without mints and burns, ${tail}`);
  return out.join(' ');
}

function capSentence(f) {
  if (!f || f.cap == null || f.flagged == null) return '';
  if (f.atCap) return ` The cap was binding when these figures were read: ${count(f.qualifying)} addresses qualified and ${count(f.cap)} were flagged, so adjusted volume is a lower bound on what the rule would exclude.`;
  if (f.qualifying === f.flagged) return ` Its cap played no part: when these figures were read, the set held ${count(f.flagged)} addresses, every qualifying address flagged, against a cap of ${count(f.cap)}.`;
  return ` When these figures were read, the set held ${count(f.flagged)} addresses against a cap of ${count(f.cap)}.`;
}

function caveatProse(m) {
  const c = m.caveat;
  if (!c) return null;
  const fell = m.cur.adjusted < m.prev.adjusted;
  const which = c.days === 1 ? 'first day' : `first ${inWords(c.days)} days`;
  return `One caveat on the comparison. Sent history starts on ${dayLong(c.since)}, so until ${dayLong(c.full)} an address active before then was judged on less than a month of sending, which flags fewer addresses and puts adjusted volume above where it settles. That covers the previous week's ${which}: judged on a full month, ${c.days === 1 ? 'it' : 'they'} would have counted somewhat less, and the ${fell ? 'fall would be that much smaller' : 'rise would be that much larger'}. ${c.days === 1 ? 'That day' : 'Those days'} averaged ${usd(c.shortAvg)} of adjusted volume a day${c.restAvg != null ? `, the rest of the previous week ${usd(c.restAvg)}` : ''}, and this week ${usd(m.caveat.weekAvg)}. Definitions and thresholds: <a href="/methodology">methodology</a>.`;
}

function routesProse(m) {
  const { cur, prev, F } = m;
  const opposite = (a, b) => (a > 0 && b < 0) || (a < 0 && b > 0);
  const same = (a, b) => (a > 0 && b > 0) || (a < 0 && b < 0);
  const kind = (a, b) => (opposite(a, b) ? 'opposite' : same(a, b) ? 'same' : null);
  const now = kind(cur.cctpNet, cur.gatewayNet), then = kind(prev.cctpNet, prev.gatewayNet);
  const before = `the week before (CCTP ${F.routes.prevCctp}, Gateway ${F.routes.prevGateway})`;
  const p1 = now
    ? `A CCTP or Gateway mint is not issuance: the same dollars changed chains. The two cross-chain routes pulled in ${now === 'opposite' ? 'opposite directions' : 'the same direction'}, ${now === then ? 'as' : 'unlike'} ${before}, and netted <strong>${F.routes.sum}</strong>.`
    : `A CCTP or Gateway mint is not issuance: the same dollars changed chains. The two cross-chain routes netted <strong>${F.routes.sum}</strong>, against ${before}.`;
  // A share of the week's growth only where there was growth and organic issuance is a part of it.
  const prevPart = F.prevOrganicShare ? `${F.prevOrganicShare} (${F.routes.prevOrganic})` : F.routes.prevOrganic;
  let p2 = `Organic issuance — USDC created or destroyed on Arc itself, once both routes are taken out — netted <strong>${F.routes.organic}</strong>`
    + (F.organicShare ? `: ${F.organicShare} of the week's growth, against ${prevPart} the week before.` : `, against ${F.routes.prevOrganic} the week before.`);
  const { rec } = m;
  const side = rec.organicIn.highest && rec.organicOut.highest ? 'the most on both sides in any seven complete UTC days since launch'
    : rec.organicIn.highest ? 'the most created in any seven complete UTC days since launch'
      : rec.organicOut.highest ? 'the most destroyed in any seven complete UTC days since launch' : null;
  const gross = [side, F.grossShare ? `${F.grossShare} of the week's mints and burns` : null].filter(Boolean).join(' and ');
  p2 += ` Gross, ${usd(cur.organicIn)} was created and ${usd(cur.organicOut)} destroyed${gross ? `, ${gross}` : ''}. How each mint and burn is attributed to a route: <a href="/methodology">methodology</a>, under Bridged liquidity vs. issuance and Cross-chain transfers (CCTP).`;
  return [p1, p2];
}

function supplyProse(m) {
  const { supply: s, F } = m;
  const g = s.growth, p = s.prevGrowth;
  const versus = g > 0 && p > 0
    ? (g < p / 2 ? "less than half the previous week's" : g < p ? "below the previous week's" : g > 2 * p ? "more than twice the previous week's" : "above the previous week's")
    : "against the previous week's";
  const high = s.priorHigh == null ? ''
    : m.newHigh
      ? ` Its highest close was <strong>${F.supply.weekHigh}</strong>, on ${dayLong(s.weekHigh.day)}: the highest end-of-day supply since launch, above the ${F.supply.priorHigh} of ${dayLong(s.priorHigh.day)}.`
      : ` Its highest close was <strong>${F.supply.weekHigh}</strong>, on ${dayLong(s.weekHigh.day)}, below the highest end-of-day supply since launch: ${F.supply.priorHigh}, on ${dayLong(s.priorHigh.day)}.`;
  return `Over the week, supply went from ${F.supply.start} to ${F.supply.end}: <strong>${F.supply.growth}</strong>, ${versus} ${F.supply.prevGrowth}.${high}`;
}

function supplyCheckProse(m) {
  if (m.supplyOk) return ` On each day of the two weeks, the change in <code>totalSupply()</code> equals the index's mints minus burns, to the cent.`;
  const bad = m.checks.filter((c) => !c.ok).map((c) => `${c.from} → ${c.to}`).join(', ');
  return ` {{SUPPLY CHECK FAILED on ${bad}: the change in totalSupply() does not equal the index's mint − burn. Find out why before publishing; see the draft notes.}}`;
}

export function renderBody(m) {
  const { F, win, cur, supply } = m;
  const caveat = caveatProse(m);
  const definitions = caveat ? '' : ' Definitions and thresholds: <a href="/methodology">methodology</a>.';
  const [routes1, routes2] = routesProse(m);
  const weeks = Math.floor(daysBetween(m.first, win.to).length / 7);
  const read = new Date(m.windowEnd).toISOString();
  return `  <p class="lead">{{LEAD}}</p>

  <h2>Volume: ${volumeHeading(F)}</h2>
  <div class="card">
${table(['USDC', esc(m.labels.prev), esc(m.labels.cur), 'Change'], [
    row(['Raw', F.raw.prev, F.raw.cur, F.raw.change]),
    row(['Mints and burns, in raw', F.mintBurn.prev, F.mintBurn.cur, F.mintBurn.change]),
    row(['Raw, without mints and burns', F.rawExMintBurn.prev, F.rawExMintBurn.cur, F.rawExMintBurn.change]),
    row(['Real', F.real.prev, F.real.cur, F.real.change]),
    row(['Adjusted', F.adjusted.prev, F.adjusted.cur, F.adjusted.change]),
    row(['Transfer events', F.cnt.prev, F.cnt.cur, F.cnt.change]),
  ])}
    <p>${volumeProse(m)}</p>
    <p>An address that sent more than 1,000 transfers or $10M in 30 days, or more than that monthly rate over a longer sent history, is infrastructure. The flag set is recomputed every minute, and each minute's adjusted volume uses the set of that minute.${capSentence(m.filtered)}${definitions}</p>
${caveat ? `    <p>${caveat}</p>\n` : ''}  </div>

  <h2>Where the mints and burns came from</h2>
  <div class="card">
${table(['Route', 'In', 'Out', 'Net'], [
    row(['CCTP', usd(cur.cctpIn), usd(cur.cctpOut), F.routes.cctp]),
    row(['Circle Gateway', usd(cur.gatewayIn), usd(cur.gatewayOut), F.routes.gateway]),
    row(['Organic issuance', usd(cur.organicIn), usd(cur.organicOut), F.routes.organic]),
    row(['Total', '', '', `<strong>${F.routes.total}</strong>`]),
  ])}
    <p>${routes1}</p>
    <p>${routes2}</p>
  </div>

  <h2>Supply</h2>
  <div class="card">
    <p>${supplyProse(m)}</p>
${table(['End of day (UTC)', 'USDC supply', 'Block'], supply.rows.map((r) => row([dayShort(r.day), usd(r.usd), count(r.block)])))}
    <p>Each figure is <code>totalSupply()</code> on the USDC contract <code>${USDC}</code>, read at the stated block on ${esc(m.network)}: the last block before midnight UTC.${supplyCheckProse(m)}</p>
  </div>

  <h2>Reproduce</h2>
  <div class="card">
    <p>Flows and volumes, in daily UTC buckets (free key on <a href="/docs">/docs</a>):</p>
    <p><code>GET /v1/stablecoins/history?token=USDC&amp;range=all</code></p>
    <p>Each bucket carries <code>volume</code>, <code>rvolume</code>, <code>avolume</code>, <code>cnt</code>, <code>mint</code> and <code>burn</code>; the CCTP and Gateway parts are <code>cmint</code>/<code>cburn</code> and <code>bmint</code>/<code>bburn</code>. Organic issuance is <code>mint − cmint − bmint</code> against <code>burn − cburn − bburn</code>; raw volume without mints and burns is <code>volume − mint − burn</code>. The same series is served without a key by the <code>stablecoin_history</code> tool of the MCP connector at <code>https://stabledesk.xyz/mcp</code>, with <code>token</code> USDC and <code>range</code> all.</p>
    <p>Supply needs no key: call <code>totalSupply()</code> on the USDC contract at the blocks above, on an ${esc(m.network)} RPC that keeps historical state. End-of-day supply on any other day since launch follows from one of those reads and the same series: subtract each later day's <code>mint − burn</code>.</p>
  </div>

  <h2>Limits</h2>
  <div class="note">
    Volumes and flows come from Stabledesk's index. ${m.supplyOk ? "Supply is read from the chain and the index's daily net issuance matches it" : 'Supply is read from the chain'}; transfers are not re-read independently for this report, and who minted and burned is not attributed.
    “Since launch” means since the index's record began, on ${dayFull(m.first)}: ${inWords(weeks)} weeks of history. A record over “seven complete UTC days” compares windows that start at midnight UTC; a seven-day window starting at another hour can hold more.
    The flag set moves from minute to minute because the rule converts sent history into days at a block time sampled over the last 15 blocks, from whole-second timestamps: 428.6, 500 or 571.4 ms, against ${oneDecimal.format(supply.blockMs)} ms on average over the week. Adjusted volume carries that noise.
    CCTP by counterparty chain is not shown: <code>/v1/cctp</code> serves rolling 24h and 7d windows only, so a fixed week could not be reproduced later.
    EURC, GBPA and USYC are not covered. Each figure is rounded to 0.1M on its own, so a sum or a difference of rounded figures can be off by 0.1M.
    Figures were read on ${dayFull(read.slice(0, 10))}, from the index as it stood at ${read.slice(11, 16)} UTC. If the index is corrected later, the correction is dated on the methodology page; this report stays as published.
    Not investment advice.
  </div>
`;
}

// ---- the registry entry for reports.js ----

export function registryEntry(m) {
  const { win } = m;
  return `  {
    slug: '${win.slug}',
    from: '${win.from}',
    to: '${win.to}',
    published: '${win.published}',
    chainId: ${m.chainId},
    title: '{{TITLE}}',
    summary: '{{SUMMARY}}',
  },`;
}

// ---- the X thread ----

// One opening post per candidate, since which finding leads is the person's choice, then the same four
// posts whatever leads. Each names the network in its own text: COMMS.md's one rule, and a reader can
// meet any post of a thread on its own.
export function thread(m, cands = candidates(m)) {
  const { F, network, win } = m;
  const when = m.labels.cur;
  const url = `https://stabledesk.xyz/reports/${win.slug}`;
  const openers = cands.map((c) => ({ id: c.id, text: `Weekly report · USDC on ${network} · ${when} (seven complete UTC days)\n\n${c.text}.` }));
  const volume = [
    `Volume, USDC on ${network}, ${when} against ${m.labels.prev}:`,
    '',
    `Raw ${F.raw.cur} (${F.raw.change})`,
    `Real ${F.real.cur} (${F.real.change})`,
    `Adjusted ${F.adjusted.cur} (${F.adjusted.change})`,
    `Transfer events ${F.cnt.cur} (${F.cnt.change})`,
    '',
    F.mbShare
      ? `Raw counts mints and burns; real leaves them out. They account for ${F.mbShare.share} of raw volume's ${F.mbShare.of}.`
      : `Raw counts mints and burns; real leaves them out. Without them, raw volume ${F.rawExMintBurn.moved}.`,
  ].join('\n');
  const routes = [
    `Where the week's mints and burns came from, USDC on ${network}, net:`,
    '',
    `CCTP ${F.routes.cctp}`,
    `Circle Gateway ${F.routes.gateway}`,
    `Organic issuance ${F.routes.organic}`,
    `Total ${F.routes.total}`,
    '',
    'A CCTP or Gateway mint is not issuance: the same dollars changed chains.',
  ].join('\n');
  const s = m.supply;
  const supply = [
    `USDC supply on ${network}: ${F.supply.start} → ${F.supply.end} over the week, ${F.supply.growth} (previous week ${F.supply.prevGrowth}).`,
    s.priorHigh == null ? null : '',
    s.priorHigh == null ? null : m.newHigh
      ? `Highest close: ${F.supply.weekHigh} on ${dayShort(s.weekHigh.day)}, the highest since launch.`
      : `Highest close: ${F.supply.weekHigh} on ${dayShort(s.weekHigh.day)}, below the ${F.supply.priorHigh} of ${dayShort(s.priorHigh.day)}.`,
    '',
    m.supplyOk
      ? "Each day's change in totalSupply() equals the index's mints minus burns."
      : '[SUPPLY CHECK FAILED: do not post this until the gap is explained]',
  ].filter((l) => l != null).join('\n');
  const link = [
    'Every table, the blocks read, how to reproduce each figure, and the limits:',
    url,
    '',
    `Measured on ${network} (chain ${m.chainId}). Not investment advice.`,
  ].join('\n');
  const measure = (p) => ({ ...p, length: xLength(p.text) });
  return {
    openers: openers.map(measure),
    posts: [volume, routes, supply, link].map((text) => measure({ text })),
  };
}

// ---- the notes that go with the draft ----

// Six decimals, the token's own precision; float noise below half a micro-dollar prints as zero.
export const gapText = (g) => (Math.abs(g) < 5e-7 ? 0 : g).toFixed(6);

export function renderNotes(m, cands = candidates(m), th = thread(m, cands)) {
  const { win } = m;
  const tick = (ok) => (ok ? '[x]' : '[ ]');
  const largest = Math.max(...m.checks.map((c) => Math.abs(c.gap)));
  const lines = [];
  const push = (...l) => lines.push(...l);
  push(`# Weekly report draft: ${m.labels.cur} ${win.to.slice(0, 4)}, ${m.network}`, '');
  push(`Window ${win.from} → ${win.to}, published ${win.published}: the last seven complete UTC days before publication. Compared with ${win.prev.from} → ${win.prev.to}.`, '');
  push(`Nothing has been published or posted. Still to write: the title, the lead (\`{{LEAD}}\` in \`${win.slug}.html\`) and the summary. Take them from the candidates below, and quote each figure as it is printed here: same string, same decimal. Then paste the registry entry into \`REPORTS\` in \`reports.js\`. The reports test refuses a listed report whose body still holds a \`{{…}}\`.`, '');

  push('## Checks', '');
  push(`- ${tick(true)} Network: the series is from chain ${m.chainId} (${m.network}), and the RPC answers chain ${m.chainId}.`);
  push(`- ${tick(true)} Index: measured up to ${new Date(m.windowEnd).toISOString().replace('.000Z', 'Z')}, past the end of the window.`);
  push(`- ${tick(m.supplyOk)} Supply: ${m.checks.length} changes of \`totalSupply()\` compared with the index's mint − burn; largest gap $${gapText(largest)} (tolerance $${SUPPLY_TOLERANCE_USD}).`);
  for (const c of m.checks.filter((x) => !x.ok)) {
    push(`  - **${c.from} → ${c.to}**: on chain ${c.onChain.toFixed(6)}, index ${c.index.toFixed(6)}, gap $${gapText(c.gap)}`);
  }
  push(m.filtered
    ? `- ${tick(!m.filtered.atCap)} Infrastructure set: ${count(m.filtered.flagged)} flagged, ${m.filtered.qualifying == null ? 'qualifying unknown' : `${count(m.filtered.qualifying)} qualifying`}, cap ${count(m.filtered.cap)}${m.filtered.atCap ? ' — the cap is binding' : ''}.`
    : '- [ ] Infrastructure cap: not checked. The first report said the cap played no part; that takes `/v1/addresses/filtered`, which needs a key. Run with `STABLEDESK_API_KEY` set, or leave the claim out (the draft does).');
  if (m.caveat) push(`- [ ] Comparability: sent history reached a full month on ${m.caveat.full}, inside the previous week. The draft says so; check the wording.`);
  push('- [ ] Limits: copied from the 2026-11-05 report, with the dates and the block time recomputed. The block-time line describes the flag set before the correction dated 6 November on /methodology (the block time a span is converted at): once it is deployed, say until when the line applied, or drop it for a week indexed entirely after.', '');

  push('## Candidates for the title and the lead', '');
  push('In the order of the report, not ranked. Each is followed by the figures it rests on.', '');
  cands.forEach((c, i) => push(`${i + 1}. **${c.text}.** ${c.figures}.`));
  push('');

  push('## Records', '');
  push(`Every window of seven complete UTC days from ${dayFull(m.first)} to ${dayFull(win.to)}: ${m.weeks} windows, overlapping ones included. Rank 1 is the highest.`, '');
  push('| Measure | This week | Rank | Highest of the others | Lowest of the others |', '|---|---:|---:|---|---|');
  const v = (r, x) => (r.unit === 'count' ? count(x) : r.unit === 'signed' ? usdSigned(x) : usd(x));
  const w = (r, o) => (o ? `${v(r, o.value)} (${weekShort(o.from, o.to)})` : '—');
  for (const r of m.recs) {
    push(`| ${r.label} | ${v(r, r.value)} | ${r.rank} of ${r.of}${r.highest ? ', highest' : r.lowest ? ', lowest' : ''} | ${w(r, r.otherHigh)} | ${w(r, r.otherLow)} |`);
  }
  push('');

  push('## Day by day', '');
  push('Every close read on chain. The gap is the change in `totalSupply()` since the previous read, minus the index\'s mint − burn over the same days.', '');
  push('| Day (UTC) | Raw | Real | Adjusted | Mint − burn | Supply at close | Block | Gap |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  const gapTo = new Map(m.checks.map((c) => [c.to, c]));
  const days = [...new Set([...m.reads.keys(), ...daysBetween(win.prev.from, win.to)])].sort();
  for (const d of days) {
    const r = m.hist.byDay.get(d) || {};
    const s = m.reads.get(d);
    const c = gapTo.get(d);
    push(`| ${d} | ${usd(r.volume ?? 0)} | ${usd(r.rvolume ?? 0)} | ${usd(r.avolume ?? 0)} | ${usdSigned((r.mint ?? 0) - (r.burn ?? 0))} | ${s ? usd(Number(s.supply) / 1e6) : ''} | ${s ? count(s.block) : ''} | ${c ? `${c.ok ? '' : '**'}$${gapText(c.gap)}${c.ok ? '' : '**'}` : ''} |`);
  }
  push('');

  push('## Registry entry', '');
  push('Goes first in `REPORTS` (newest first), once the title and summary are written:', '');
  push('```js', registryEntry(m), '```', '');

  push('## X thread', '');
  push(`Lengths are X's weighted count (twitter-text v3: a URL is 23, U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F and U+2032–U+2037 weigh 1, everything else 2), against ${X_LIMIT}. Every post names ${m.network}.`, '');
  push('### First post: one version per candidate', '');
  th.openers.forEach((p, i) => push(`${i + 1}. ${p.id} — ${p.length}/${X_LIMIT}${p.length > X_LIMIT ? ' **too long**' : ''}`, '', '```text', p.text, '```', ''));
  push('### Then, whatever leads', '');
  th.posts.forEach((p, i) => push(`${i + 2}. ${p.length}/${X_LIMIT}${p.length > X_LIMIT ? ' **too long**' : ''}`, '', '```text', p.text, '```', ''));
  if (m.source) push(`Series read from ${m.source}.`, '');
  return lines.join('\n');
}
