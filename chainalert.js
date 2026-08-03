// Announcing a chain-state change, once, to whoever is on call.
//
// The liveness tracking in indexer.js already works out what is wrong and whose fault it is.
// Nothing ever acted on that: a refused RPC credential sat in production for four days — correctly
// diagnosed, correctly attributed, correctly displayed — because the diagnosis only ever reached a
// page nobody was watching. A verdict nobody reads is not monitoring. This turns the transition
// into a message.
//
// Transitions, not states. The poll runs every few seconds, so alerting on the *condition* would
// send hundreds of identical messages an hour and teach the reader to ignore all of them, which
// costs more than sending nothing.

import { sendTelegram, configured } from './telegram.js';

export const HEALTHY = 'live';

// An endpoint that flaps (up, down, up, down) would otherwise alert on every flip. One message per
// destination state per window is enough to act on; the rest restate a fact already sent. Kept per
// state rather than global so a recovery is never swallowed by the cooldown of the outage itself.
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// A duration a human reads at a glance. Deliberately coarse: "4h 12m" is what you act on, and
// "4h 12m 09s" only looks precise.
export function humanDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// What each unhealthy state means and who has to do something about it. The wording carries the
// attribution on purpose: "Arc is down" sent for a rejected credential is what sends everyone to
// look at the wrong system, which is the failure this whole path exists to prevent.
const CAUSE = {
  unauthorized: {
    title: 'RPC credential refused',
    who: 'Every Arc endpoint answered and rejected our key. This is our configuration to fix, not an Arc outage.',
  },
  unreachable: {
    title: 'no Arc endpoint answering',
    who: 'Nothing answered at all — the network, or every provider at once. Not something a redeploy fixes.',
  },
  halted: {
    title: 'Arc is not producing blocks',
    who: 'The RPC answers but the head has stopped moving. The chain has halted; the indexer is fine.',
  },
};

// Pure: what to announce for a transition, or null when it isn't news. Separated from delivery so
// the decision can be tested without a network, which is the half that actually has rules in it.
export function transition(prev, next, ctx = {}) {
  if (prev === next) return null;                    // not a transition
  if (next === 'unknown') return null;               // we learned less than we knew; not news
  // Booting into a healthy chain is the expected case, and announcing every deploy as an event
  // is how a channel becomes unreadable.
  if (prev === 'unknown' && next === HEALTHY) return null;

  if (next === HEALTHY) {
    const head = ctx.head != null ? ` Head ${ctx.head}.` : '';
    const out = ctx.downMs != null ? ` Down for ${humanDuration(ctx.downMs)}.` : '';
    return {
      state: next,
      text: `✅ Stabledesk — Arc reading restored.${out}${head} Live figures are back.`,
    };
  }

  const cause = CAUSE[next];
  if (!cause) return null;                           // an unmodelled state: say nothing rather than guess

  const lines = [`⛔ Stabledesk — ${cause.title}.`, cause.who];
  if (next === 'halted' && ctx.stalledMs != null) {
    lines.push(`No new block for ${humanDuration(ctx.stalledMs)}${ctx.head != null ? ` (head ${ctx.head})` : ''}.`);
  }
  if (ctx.lastError) lines.push(`Last error: ${ctx.lastError}`);
  // Said explicitly because it changes how urgent this is: the site is not blank, it is serving
  // measured history with live-only figures absent rather than stale.
  lines.push('The terminal is serving indexed history; live figures are absent, not stale.');
  return { state: next, text: lines.join('\n') };
}

// Pure: whether this destination state is outside its cooldown.
export const dueForSend = (now, lastAt) => lastAt == null || now - lastAt >= ALERT_COOLDOWN_MS;

const lastSentAt = new Map();
export const resetCooldowns = () => lastSentAt.clear();

// Impure half: decide, then deliver. Returns what it did so the caller (and the tests) can tell
// "nothing to say" apart from "said it" apart from "no channel configured".
export async function note(prev, next, ctx = {}, now = Date.now()) {
  const ev = transition(prev, next, ctx);
  if (!ev) return { sent: false, reason: 'not_newsworthy' };
  if (!dueForSend(now, lastSentAt.get(ev.state))) return { sent: false, reason: 'cooldown' };
  // Recorded before the await, so two transitions landing together can't both pass the check.
  lastSentAt.set(ev.state, now);
  // Logged unconditionally, and before delivery is attempted: stdout is captured by the host, so
  // the transition survives on the record even with no channel configured and even if Telegram
  // then fails. Being unable to page someone is not a reason to also lose the event.
  console.log('[chainalert]', ev.text.replace(/\n/g, ' · '));
  if (!configured) return { sent: false, reason: 'telegram_not_configured', text: ev.text };
  await sendTelegram(ev.text);
  return { sent: true, state: ev.state, text: ev.text };
}
