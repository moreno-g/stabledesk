// Daily rankings — the content engine.
//
// The point of this file is distribution, not analysis. An ecosystem page that changes silently
// gives nobody a reason to come back; the same numbers rendered as a daily standing produce
// something worth posting every day, for free, forever. The newsletter is not a separate feature —
// it is this digest, rendered.
//
// Drafts land in tweet_drafts (same table whalewatch.js uses) rather than being delivered anywhere.
// Nothing here posts to a network: the digest is generated, deduped by day, and held for review.

import * as db from './db.js';
import * as tvl from './tvl.js';
import { CHAIN } from './chains.js';
import { RANKING_TOP_N, RANKING_MIN_MOVE_PCT, BASE_DENOMINATION, sumByDenomination } from './constants.js';

const DAY = 86400;
const today = () => Math.floor(Date.now() / 1000 / DAY) * DAY;
const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function compact(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(a < 10 ? 2 : 0);
}
const pct = (x) => (x == null ? null : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');

// One day's standings, computed from stored aggregates only — no network, so this is cheap enough
// to serve on request rather than on a schedule.
export function daily() {
  const agg = tvl.aggregate();
  const since = Math.floor(Date.now() / 1000) - DAY;
  const summary = db.getSummary(since);

  const live = agg.protocols.filter((p) => p.tvl > 0 || p.windowVolume > 0);

  // Ranked and shared in the base denomination only. A share of a total that adds euros to dollars
  // is a share of nothing; each protocol's other currencies ride along, unranked.
  const base = BASE_DENOMINATION;
  const chainBase = agg.totals.byDenomination?.[base]?.tvl || 0;
  const byTvl = live
    .filter((p) => (p.tvlByDenomination?.[base] || 0) > 0)
    .slice(0, RANKING_TOP_N)
    .map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, category: p.category, denomination: base,
      tvl: p.tvlByDenomination[base], share: chainBase ? p.tvlByDenomination[base] / chainBase : 0,
      tvlByDenomination: p.tvlByDenomination,
    }));

  const byVolume = [...live]
    .filter((p) => p.windowVolume > 0)
    .sort((a, b) => b.windowVolume - a.windowVolume)
    .slice(0, RANKING_TOP_N)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, category: p.category, windowVolume: p.windowVolume, windowTransfers: p.windowTransfers }));

  // Movers need a stored baseline, so they are empty on day one rather than showing 0%.
  const moves = tvl.movers(1).filter((m) => m.pct != null && Math.abs(m.pct) >= RANKING_MIN_MOVE_PCT);

  return {
    day: isoDay(today()),
    network: CHAIN.id,
    chain: {
      denomination: base,
      tvl: chainBase,
      attributedShare: agg.totals.byDenomination?.[base]?.attributedShare ?? 0,
      tvlByDenomination: agg.totals.byDenomination,
      volume24h: sumByDenomination(Object.fromEntries(Object.entries(summary.byToken || {}).map(([t, x]) => [t, x.volume])))[base] || 0,
      transfers24h: summary.transfers,
      // Adjusted volume is the figure /methodology defends; both are reported so the digest can
      // never be accused of quoting whichever number looks bigger.
      adjustedVolume24h: summary.avolume,
    },
    protocolsRanked: byTvl.length,
    byTvl,
    byVolume,
    movers: moves.slice(0, RANKING_TOP_N).map((m) => ({ ...m, pctLabel: pct(m.pct) })),
    unnamed: { count: agg.candidates.length, tvl: agg.totals.byDenomination?.[base]?.unattributed ?? 0, denomination: base },
  };
}

// The digest, as plain text. Short enough to post, complete enough to be worth reading — and it
// says outright when a section has no data instead of padding it.
export function digest(r = daily()) {
  const L = [];
  const net = CHAIN.isTestnet ? ' (testnet)' : '';
  L.push(`Arc ecosystem${net} — ${r.day}`);
  L.push('');
  // Every figure names its currency: the digest is copied into posts, where an unlabelled number
  // gets read as dollars whatever it adds up.
  const cur = r.chain.denomination ? ` ${r.chain.denomination}` : '';
  L.push(`TVL ${compact(r.chain.tvl)}${cur} across ${r.protocolsRanked} protocol${r.protocolsRanked === 1 ? '' : 's'} · 24h volume ${compact(r.chain.volume24h)}${cur}`);

  if (r.byTvl.length) {
    L.push('');
    L.push('Top by TVL');
    for (const p of r.byTvl) L.push(`${p.rank}. ${p.name} — ${compact(p.tvl)}${cur} (${(p.share * 100).toFixed(1)}%)`);
  }

  if (r.movers.length) {
    L.push('');
    L.push('24h movers');
    for (const m of r.movers) L.push(`${m.name} ${m.pctLabel} (${compact(m.from)} → ${compact(m.to)})`);
  } else {
    L.push('');
    L.push('24h movers: no baseline yet.');
  }

  if (r.byVolume.length) {
    L.push('');
    L.push('Most active');
    for (const p of r.byVolume) L.push(`${p.rank}. ${p.name} — ${compact(p.windowVolume)} moved`);
  }

  if (r.unnamed.count) {
    L.push('');
    L.push(`${compact(r.unnamed.tvl)}${cur} sits in ${r.unnamed.count} contract${r.unnamed.count === 1 ? '' : 's'} we haven't named yet. Know one? stabledesk.xyz/ecosystem`);
  }
  return L.join('\n');
}

// Store today's digest as a draft, once. Returns true only the first time in a given day — the
// dedupe key is the day, so calling this on every tick is safe.
export function record() {
  const r = daily();
  return db.createTweetDraft({
    kind: 'ranking',
    token: 'ALL',
    amount: r.chain.tvl,
    dedupeKey: `ranking:${CHAIN.id}:${r.day}`,
    text: digest(r),
  });
}
