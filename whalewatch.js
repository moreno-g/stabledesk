// Whale-transfer content drafting — held in reserve until Arc mainnet.
//
// Testnet transfer amounts have no real economic value (faucet-funded), so publishing
// "$500K moved!" style content about them would misrepresent what's actually happening.
// This module still builds and proves the detection + drafting pipeline now, so it's
// ready to flip on the day Arc goes to mainnet — it just never delivers anywhere on its
// own.
//
// Activation is `WHALEWATCH_ENABLED=true` plus a configured Telegram bot, and it stays off by
// default on purpose: turning it on starts posting publicly, which is not something a deploy should
// do as a side effect of shipping. server.js reads the flag, so the switch is a documented one
// rather than an unreferenced export nobody remembers to call.

import { alertFeed } from './indexer.js';
import * as db from './db.js';
import { CHAIN } from './chains.js';
import { sendTelegram, configured as telegramConfigured } from './telegram.js';

export const TWEET_WORTHY_MIN = CHAIN.tweetWorthyMin; // well above the 1K in-app alert threshold
const CHECK_MS = 15000;

const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const dedupeKey = (ev) => `${ev.block}|${ev.token}|${ev.kind}|${ev.from}|${ev.to}|${ev.amount}`;

// The testnet disclaimer is derived, not written in. This module exists to be switched on the day Arc
// goes to mainnet, and it hardcoded "(testnet — for demonstration, not real value)" into every draft —
// so flipping it on would have published that caveat over real transfers, which is the same class of
// wrong number this codebase refuses everywhere else, just in prose.
export function draftText(ev, chain = CHAIN) {
  const amt = Math.round(ev.amount).toLocaleString('en-US');
  const verb = ev.kind === 'mint' ? 'minted' : ev.kind === 'burn' ? 'burned' : 'moved';
  const route = ev.kind === 'transfer' ? `\n${short(ev.from)} → ${short(ev.too || ev.to)}\n` : '\n';
  const caveat = chain.isTestnet ? ' (testnet — for demonstration, not real value)' : '';
  return `👀 ${amt} ${ev.token} ${verb} on Arc${caveat}${route}\nLive on stabledesk.xyz`;
}

// Pure function: given a list of feed events, returns the ones that qualify as a fresh
// draft (over threshold) — no I/O, no db, easy to unit test in isolation.
export function evaluate(events, threshold = TWEET_WORTHY_MIN) {
  return events
    .filter((ev) => ev.amount >= threshold)
    .map((ev) => ({ ...ev, dedupeKey: dedupeKey(ev), text: draftText(ev) }));
}

// Sends every undelivered draft, oldest first. Stops at the first failure (rather than
// hammering Telegram if something's wrong) — whatever's left just retries next tick.
export async function deliverPendingDrafts() {
  if (!telegramConfigured) return { sent: 0, reason: 'telegram_not_configured' };
  let sent = 0;
  for (const d of db.pendingTweetDrafts()) {
    try {
      await sendTelegram(d.text);
      db.markDraftDelivered(d.id);
      sent++;
    } catch (e) {
      console.error('[whalewatch] telegram delivery failed for draft', d.id, e.message);
      break;
    }
  }
  return { sent };
}

async function tick() {
  for (const draft of evaluate(alertFeed)) {
    db.createTweetDraft({
      kind: draft.kind, token: draft.token, amount: draft.amount,
      frm: draft.from, too: draft.to, block: draft.block,
      dedupeKey: draft.dedupeKey, text: draft.text,
    }); // createTweetDraft no-ops on a duplicate dedupeKey (INSERT OR IGNORE)
  }
  await deliverPendingDrafts();
}

let timer = null;
export async function start() { await tick(); timer = setInterval(tick, CHECK_MS); }
export function stop() { if (timer) { clearInterval(timer); timer = null; } }
