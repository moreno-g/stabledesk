// The availability record: what Arc did, and how much of it we were in a position to see.
//
// The indexer already detects every state change and announces it (chainalert.js), but announcing
// is ephemeral — it answers "is Arc up?" and never "was Arc up last Tuesday". This keeps the
// transitions, so the second question stops depending on someone's memory of a Telegram message.
//
// The whole difficulty is the second half of the first sentence. An uptime figure computed as
// live_ms / wall_clock_ms silently books every second we were not watching as whatever state we
// last saw: leave the indexer switched off for a week and it publishes a week of Arc uptime.
// That is inventing data, and at the scale of a week it is the largest number on the page. So
// observed time is tracked as its own quantity and reported next to every percentage — an uptime
// without its coverage is not a measurement, it is a claim.

import * as db from './db.js';

// Where the current session's knowledge ends. Written periodically by the indexer while it runs;
// read here to bound the open segment, because "the last thing we saw was live" is not evidence
// that it is still live now.
export const SEEN_KEY = 'chain_seen_through';

// The synthetic state meaning "we were not looking". Written at boot to close the previous
// session's segment, so a gap in the record is a fact in the record rather than an absence that
// reads as continuity.
export const UNOBSERVED = 'unobserved';

// Which states are evidence about Arc, and which are only evidence about us. This mapping is the
// substance of the whole module, so it is stated once, here, rather than implied by branches.
//
//   live         — Arc up, observed.
//   halted       — Arc down, observed: an endpoint answered, and the head was not moving. This is
//                  the only state that is unambiguously the chain's downtime.
//   unreachable  — nothing answered. Counted as down, but the honest caveat is that our own host
//                  losing DNS looks identical from here. We cannot tell the two apart, so we take
//                  the conservative reading (it was, at minimum, not readable) and publish the
//                  per-state breakdown so a reader who disagrees can recompute without us.
//   unauthorized — our key was refused. This says *nothing* about Arc, which may have been
//                  producing blocks perfectly throughout. Booking it as Arc downtime would be the
//                  exact misattribution the state was introduced to prevent, so it is not
//                  observation of Arc at all: it counts as time we were not looking.
//   unobserved   — we were not running.
export const VERDICT = {
  live: 'up',
  halted: 'down',
  unreachable: 'down',
  unauthorized: 'unobserved',
  unobserved: 'unobserved',
  unknown: 'unobserved',
};

// Who has to do something about a non-live stretch. Carried on every incident so the record reads
// the same way the alerts do — a four-day outage of ours is not four days of Arc being broken, and
// publishing it as such would be lying in our own favour.
export const BLAME = {
  halted: 'chain',
  unreachable: 'unknown',
  unauthorized: 'stabledesk',
  unobserved: 'stabledesk',
  unknown: 'unknown',
};

const STATES = Object.keys(VERDICT);

// Pure: fold a transition log into time spent per state over [from, to].
//
// `events` must be ordered by time and should include the last transition *before* `from`, so the
// state at the window's opening edge is known; without it the first hours of any window would look
// unobserved. `seenThrough` bounds the final open segment — past it we know nothing, including
// about the present.
export function uptimeFrom(events, from, to, seenThrough = null) {
  const by = Object.fromEntries(STATES.map((s) => [s, 0]));
  const add = (state, ms) => { if (ms > 0) by[state in by ? state : UNOBSERVED] += ms; };

  const windowMs = Math.max(0, to - from);
  const rows = [...(events || [])].sort((a, b) => a.at - b.at);

  // How far the record extends at all. A null watermark means the indexer never wrote one, so we
  // decline to assume the tail is still current and treat everything after the last event as
  // unobserved rather than as an open segment of unknown length.
  const known = seenThrough == null ? null : Math.min(to, seenThrough);

  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(rows[i].at, from);
    // Gaps between sessions are explicit `unobserved` rows, so a segment always runs to the next
    // event. Only the last one — still open — is cut short by what we actually saw.
    const next = rows[i + 1] ? rows[i + 1].at : (known ?? rows[i].at);
    add(rows[i].state, Math.min(next, to) - start);
  }

  // Before the record began, and after our knowledge of it ends. Both are ours, not the chain's.
  if (rows.length) {
    add(UNOBSERVED, Math.min(rows[0].at, to) - from);
    add(UNOBSERVED, to - Math.max(from, Math.min(to, known ?? rows.at(-1).at)));
  } else {
    add(UNOBSERVED, windowMs);
  }

  const upMs = by.live;
  const downMs = by.halted + by.unreachable;
  const observedMs = upMs + downMs;
  const unobservedMs = windowMs - observedMs;

  return {
    windowMs,
    byState: by,
    upMs,
    downMs,
    observedMs,
    unobservedMs,
    // Uptime is a share of *observed* time, never of the window. Null rather than 100 when nothing
    // was observed: a percentage computed from no measurements is not a cautious estimate, it is
    // a fabrication with a decimal point.
    uptimePct: observedMs > 0 ? (upMs / observedMs) * 100 : null,
    // Published next to it, always, so the figure above can be weighed. 99.9% uptime over 4% of a
    // month is a statement about four percent of a month.
    coveragePct: windowMs > 0 ? (observedMs / windowMs) * 100 : null,
  };
}

// A restart takes seconds and every deploy leaves one behind. Listing them would bury the episodes
// somebody has to act on under a wall of twenty-second gaps, so short unobserved stretches are
// dropped from the *list*. They stay in the totals, and therefore in coverage — the distance
// between "not shown" and "not counted" is the whole ethic of this module, and only the first one
// is a display decision.
export const INCIDENT_MIN_MS = 2 * 60 * 1000;

// Pure: the same log read as a list of episodes rather than as totals. Totals answer "how good was
// it"; this answers "what happened", which is what anyone actually reads a status page for.
export function incidents(events, from, to, seenThrough = null) {
  const rows = [...(events || [])].sort((a, b) => a.at - b.at);
  const known = seenThrough == null ? null : Math.min(to, seenThrough);
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].state === 'live') continue;
    const ongoing = !rows[i + 1];
    const start = Math.max(rows[i].at, from);
    const end = Math.min(rows[i + 1] ? rows[i + 1].at : (known ?? rows[i].at), to);
    if (end <= start) continue;
    // Chain-side episodes are always listed, however brief — a 30-second halt is news. Only our
    // own restart gaps are held to a floor.
    if (rows[i].state === UNOBSERVED && end - start < INCIDENT_MIN_MS) continue;
    out.push({
      state: rows[i].state,
      verdict: VERDICT[rows[i].state] ?? 'unobserved',
      blame: BLAME[rows[i].state] ?? 'unknown',
      from: start,
      to: end,
      ms: end - start,
      // An open episode's end is where our knowledge stops, which is not the same as it being over.
      ongoing,
      head: rows[i].head ?? null,
      error: rows[i].error ?? null,
    });
  }
  return out.reverse();   // most recent first — the only order a status page is read in
}

// Impure: read the window out of SQLite and fold it. Separated from the two functions above so the
// arithmetic can be tested against a hand-written log instead of against a database.
export function record({ days = 30, now = Date.now(), limit = 25 } = {}) {
  const to = now;
  const from = to - days * 86400e3;
  const events = db.chainEventsSince(from);
  const seen = Number(db.getMetaValue(SEEN_KEY)) || null;
  const began = db.firstChainEventAt();

  return {
    window: { from, to, days },
    // When the record itself starts. A 30-day uptime figure drawn from a log that began yesterday
    // is a one-day figure wearing a 30-day label, and the only way a reader can catch that is if
    // we say so.
    recordBegan: began,
    ...uptimeFrom(events, from, to, seen),
    seenThrough: seen,
    incidents: incidents(events, from, to, seen).slice(0, limit),
  };
}
