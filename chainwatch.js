// What changed on the chain since the last look.
//
// verify-network.js answers "does the profile match the chain right now". That is the right question
// before a deploy and the wrong one for a chain that keeps moving: run it every hour and it restates
// the present every hour, so the one run where something is different reads exactly like the fifty
// that came before it.
//
// The drift it was written for is only visible as a difference over time. USYC did not fail a check —
// the tracked contract answered symbol(), decimals() and totalSupply() correctly the whole time. What
// happened is that it stopped moving while a second deployment carried 722 transfers, and no single
// snapshot can say that. It took a manual audit and the site published a supply of 1.38M for an asset
// doing 12.2M in the meantime.
//
// So this keeps the previous observation and reports the delta. Same shape as chainalert.js: a pure
// decision function that can be tested against a hand-written pair of observations, and a thin
// delivery layer around it. Transitions, never conditions — announcing a condition every hour is how
// a channel becomes unreadable, and the four-day outage this codebase remembers was invisible for
// exactly the opposite reason.

import { sendTelegram, configured as telegramConfigured } from './telegram.js';

// db.js is loaded inside record(), not imported here. Importing it opens — and migrates — a database
// as a side effect of loading this module, which would mean the pure diff below could not be tested
// without one, and a test that imported it before setting DB_PATH would quietly operate on the real
// arc.db. The decision logic is the half with rules in it; it should need nothing to exercise.

// How many consecutive checks a subject must be missing before its absence is reported.
//
// The discovery pass samples a slice of recent blocks, not all of them, so a contract absent from one
// sample has not necessarily gone anywhere — it may simply have been quiet for those few hundred
// blocks. Reporting the first absence would produce a stream of assets "disappearing" and reappearing
// an hour later. Three is the same rule the identity probe uses on unanswered calls, for the same
// reason: silence has to repeat before it counts as an answer.
export const MISSES_BEFORE_GONE = 3;

// A tracked asset going quiet is the serious one, so it is held to a higher bar before being called.
// This is the USYC case: the contract is still deployed and still answers, it has simply stopped being
// used. That is a fact about the asset, not a fault, and it takes a few checks to establish.
export const MISSES_BEFORE_QUIET = 4;

// Which facts count as identity. Deliberately excludes anything that moves on its own — supply, event
// counts, balances — because a diff on those fires on every run and says nothing. What is being
// watched is whether the thing is still the thing we think it is.
const IDENTITY_FIELDS = ['symbol', 'decimals', 'name', 'hasCode'];

function identity(facts = {}) {
  const out = {};
  for (const k of IDENTITY_FIELDS) if (facts[k] !== undefined) out[k] = facts[k];
  return out;
}

const sameIdentity = (a, b) => JSON.stringify(identity(a)) === JSON.stringify(identity(b));

// Pure: the difference between two observations.
//
// `previous` is a Map of stored subjects (as db.watchSubjects returns). `current` is a Map of what
// this check saw. Returns the events worth reporting *and* the rows to store, so the caller never has
// to reconstruct the bookkeeping the diff already did.
export function diffObservations(previous, current, now = Date.now()) {
  const events = [];
  const rows = [];
  const seen = new Set();

  for (const [id, subject] of current) {
    seen.add(id);
    const before = previous.get(id);
    const active = subject.active !== false;

    if (!before) {
      // Config subjects (tokens, registry, gateway) are ours: one appearing means we added it, which
      // is not news about the chain. A contract we did not know about emitting transfers is.
      if (subject.kind === 'seen') {
        events.push({ type: 'new', id, kind: subject.kind, facts: subject.facts, detail: subject.detail });
      }
      rows.push({ id, kind: subject.kind, facts: subject.facts, firstSeen: now, lastSeen: active ? now : 0, lastCheck: now, misses: active ? 0 : 1 });
      continue;
    }

    // Identity changed under a stable address. For a tracked token this is the expensive kind: a
    // decimals field that moved makes every figure derived from it wrong by a power of ten.
    if (!sameIdentity(before.facts, subject.facts)) {
      events.push({
        type: 'changed', id, kind: subject.kind,
        from: identity(before.facts), to: identity(subject.facts),
        facts: subject.facts, firstSeen: before.firstSeen,
      });
    }

    // Present but not moving. Only meaningful for things we expect to move.
    if (!active && subject.kind === 'token') {
      const misses = before.misses + 1;
      if (misses === MISSES_BEFORE_QUIET) {
        events.push({ type: 'quiet', id, kind: subject.kind, facts: subject.facts, misses, since: before.lastSeen, firstSeen: before.firstSeen });
      }
      rows.push({ ...before, facts: subject.facts, lastCheck: now, misses });
      continue;
    }

    rows.push({ ...before, facts: subject.facts, lastSeen: active ? now : before.lastSeen, lastCheck: now, misses: active ? 0 : before.misses });
  }

  // Subjects we knew about and did not see at all this time.
  for (const [id, before] of previous) {
    if (seen.has(id)) continue;
    const misses = before.misses + 1;
    // Reported once, at the threshold, and not again — the row stays so it is not re-announced as
    // "new" the next time it shows up in a sample.
    if (misses === MISSES_BEFORE_GONE) {
      events.push({ type: 'gone', id, kind: before.kind, facts: before.facts, misses, since: before.lastSeen, firstSeen: before.firstSeen });
    }
    rows.push({ ...before, lastCheck: now, misses });
  }

  return { events, rows };
}

const short = (id) => {
  const addr = id.slice(id.indexOf(':') + 1);
  return addr.length > 14 ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : addr;
};

const label = (facts = {}) => {
  const n = facts.name && facts.symbol && facts.name !== facts.symbol
    ? `${facts.name} (${facts.symbol})` : (facts.name || facts.symbol);
  return n || 'unnamed';
};

const ago = (ts, now = Date.now()) => {
  if (!ts) return 'never';
  const h = Math.round((now - ts) / 3600000);
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// Pure: one line a human can act on. Kept next to the diff so the wording and the rule that produced
// it cannot drift apart.
export function describe(event, now = Date.now()) {
  const who = `${short(event.id)} · ${label(event.facts)}`;
  switch (event.type) {
    case 'new':
      // "First seen", not "new". The discovery pass samples a slice of recent blocks, so a contract
      // appearing here means we saw it for the first time — not that it was deployed since the last
      // check. Dating a deployment would take an archive node and a binary search; claiming a date we
      // did not measure would be worse than the extra word. Same distinction chainuptime.js draws
      // between the chain being up and us having been there to see it.
      return `FIRST SEEN · ${who}${event.facts?.decimals != null ? ` · ${event.facts.decimals} dec` : ''}`
        + `${event.detail ? ` · ${event.detail}` : ''}`;
    case 'changed': {
      const diffs = Object.keys({ ...event.from, ...event.to })
        .filter((k) => JSON.stringify(event.from[k]) !== JSON.stringify(event.to[k]))
        .map((k) => `${k}: ${JSON.stringify(event.from[k])} → ${JSON.stringify(event.to[k])}`);
      return `CHANGED · ${who} · ${diffs.join(', ')}`;
    }
    case 'quiet':
      // "Never" is a different statement from "not lately", and on a tracked asset it is the louder
      // one: it means we have never once observed this contract move since we started watching.
      return `QUIET · ${who} is tracked but has produced no transfers in ${event.misses} checks · `
        + (event.since ? `last seen moving ${ago(event.since, now)}` : 'never once seen moving');
    case 'gone':
      return `GONE · ${who} has not appeared in ${event.misses} checks · `
        + (event.since ? `last seen ${ago(event.since, now)}` : 'never seen active');
    default:
      return `${event.type} · ${who}`;
  }
}

// How much a given event is worth interrupting someone for. A tracked asset changing its decimals is
// a page-someone event; a memecoin appearing is a line in a log. Sent to Telegram only above the bar,
// because a watcher that forwards everything trains its reader to forward it to the bin.
export function severity(event) {
  if (event.kind === 'token' || event.kind === 'gateway' || event.kind === 'registry') {
    if (event.type === 'changed' || event.type === 'gone') return 'high';
    if (event.type === 'quiet') return 'high';
  }
  // A new contract that names itself like a fiat asset is the one worth reading on a stablecoin
  // index; the rest is inventory.
  if (event.type === 'new' && event.facts?.fiat) return 'high';
  return 'low';
}

// Impure: take the diff, store the new observation, announce what is worth announcing.
//
// The store happens whether or not delivery works — an unreachable Telegram must never be able to
// make the watcher forget what it saw, or the same change is rediscovered and re-announced forever.
export async function record(current, { now = Date.now(), announce = true } = {}) {
  const db = await import('./db.js');
  const previous = db.watchSubjects();
  const { events, rows } = diffObservations(previous, current, now);

  db.putWatchSubjects(rows);

  const notable = events.filter((e) => severity(e) === 'high');
  if (announce && notable.length && telegramConfigured) {
    const lines = notable.map((e) => describe(e, now));
    try {
      await sendTelegram(`Arc — ${notable.length} change(s) worth a look\n\n${lines.join('\n')}`);
    } catch (e) {
      // Reported, not thrown: failing to deliver a notification is not a reason to fail the check
      // that produced it, and the observation is already stored.
      console.error('[chainwatch] could not deliver:', e.message || e);
    }
  }
  return { events, notable, stored: rows.length, firstRun: previous.size === 0 };
}
