# Communication

Stabledesk publishes numbers. This file is the rule for publishing them *outside* the product —
on [@getStabledesk](https://x.com/getStabledesk), in the README, in grant applications, anywhere
a figure leaves this repo and lands in front of someone.

It is in the public repo on purpose. The project's claim is that its method is auditable rather
than asserted; an editorial policy that only exists in the operator's head is asserted.

## The promise

> Stabledesk measures stablecoins on Arc and shows its work. Every number carries the method that
> produced it, the window it covers, and the network it came from.

Everything below is that sentence, enforced.

## The one rule

**No number is published without the network it came from, and the label is derived, not
remembered.**

This is the same rule as [`chains.js`](chains.js), which throws rather than fall back to testnet
under a mainnet banner, and the same rule as `draftText()` in [`whalewatch.js`](whalewatch.js),
which reads the caveat off `chain.isTestnet` instead of hardcoding it. Both exist because a
plausible-looking wrong number is worse than no number.

The product enforces this in three places already:

| Surface | Enforcement |
|---|---|
| Every page showing a figure | `{{NET}}` interpolated into the testnet warning |
| Whale posts | `chain.isTestnet` decides the caveat in `draftText()` |
| Bridge-adjusted figures | `null`, never `0`, where Gateway is not deployed |

Social posts are the fourth surface and the only one where a human is the interpolation step. So
the rule has to be written down, because a person is doing what the code does elsewhere.

**In practice.** Any post containing a figure from the chain names the network in the post itself —
not in a reply, not in the linked page, not implied by a screenshot. `Arc testnet` is four
characters more than `Arc`. Until Arc mainnet launches publicly, a post that says "Arc" and shows a
number is wrong, even when every number in it is correct.

This holds for screenshots too: a screenshot of the terminal carries the on-page warning, so crop
it in, not out.

### The second rule, which the first one missed

On 29 and 30 July 2026 this account published figures from Arc **mainnet** — chain 5042 — while
holding gated pre-launch access. The site was running against mainnet at the time; the token list
had been made network-derived on the 29th and the remaining testnet copy dropped with it. Access
was withdrawn a few days later and the deployment returned to testnet, which is where it has been
since and which the 3 August post says out loud.

So the numbers were real mainnet measurements and the label on them was correct.

What was missing is that **nobody else could reach that network.** Chain 5042 was producing blocks
behind an access grant. A reader who wanted to check those figures had nowhere to check them, and
the 30 July post read as though a public mainnet existed.

That is not a wrong number. It is a category the first rule does not cover, and it needs its own:

> **A figure from a network the reader cannot reach is published with that fact attached.**

Not because it is less true — it was true — but because *check my work* is the whole promise, and
here the work could not be checked. "Arc mainnet (pre-launch, access-gated — you cannot verify this
yourself yet)" is one clause, and it turns an unverifiable claim into a disclosed one.

Neither post is deleted and neither is retracted. Both are accurate, and they are the record of
this project measuring Arc mainnet before it opened, which is worth more than a tidy timeline. What
they get is the missing clause, added as a reply.

## September 16, 2026

Circle has [announced](https://www.circle.com/pressroom/circle-announces-founding-validator-cohort-and-major-integrations-for-arc-ahead-of-september-16-mainnet-launch)
the public Arc mainnet launch for that date. It is the day this file's output changes, so the
change is written down before it happens rather than improvised on the morning.

**Nothing here needs editing by hand.** Every caveat in the product is derived, so flipping
`ARC_NETWORK=mainnet` removes the testnet wording from the pages, from `draftText()`, and from the
brief, all at once. That is the whole point of having derived them. The work that day is
verification, not authoring.

What does need a human:

- **The July posts get their missing clause before the switch.** They are accurate mainnet figures
  from the gated pre-launch network, but from September 16 "Arc mainnet" means something a reader
  can go and check — and these two describe a period when it was not. Saying so now, while the
  distinction still needs explaining, is cheaper than being asked about it during launch week.
- **The first post that says "Arc mainnet" ships after the switch is live and verified**, not at
  00:01 on the 16th because the calendar says so. The rule has never been "post when it launches";
  it is "post what we measured, once we measured it."
- **A testnet figure published after the switch says it is historical.** The caveat stops being
  automatic the moment the profile changes, so any older number reused in a post carries its date
  and its network in the post itself.
- **Whale posting stays off** until `WHALEWATCH_ENABLED=true` is set deliberately. Mainnet day is a
  reason to consider it, not a reason for it to happen by itself.

## Replies, and which account sends them

A reply is a post. Everything above applies to it — including the network label, which is easier to
drop in a fast reply than anywhere else.

**@MrLazeem replies. @getStabledesk measures.**

A product account with a small following replying under an ecosystem post reads as placement. A
named person saying "I index this chain, here is what I see" reads as a contributor. The account
bio already says *Built by @MrLazeem*: the human is the credential, not the other way round. And a
reply that goes wrong from a personal account is someone being wrong; from the measurement brand it
is the thing that sells precision being imprecise.

**@getStabledesk replies only when the reply is data** — a measured figure, its network, and a link
to the method. That is the best product demo available and it costs one sentence to write.

- No pleasantries from the brand account. On 2026-08-08 a post about the cost of moving money on
  Arc — the one topic where this project is the only source — got "gARC, enjoy your week-end" as a
  reply. The figure that would have answered it was in the database. That is what this rule exists
  to prevent, and it is why `stabledesk-brief` exists.
- Never both accounts under the same thread. Two linked handles in one reply chain reads as
  sockpuppeting, and that is the single failure a trust-based account cannot absorb.

## Order of operations

**Ship → publish the method → post.** Never post first.

A post that describes behaviour the deployed site does not have is a claim, and this project does
not make claims. The existing timeline follows this already — each post maps to a commit, and the
`/methodology` change lands in the same commit as the definition change it describes (see
[CLAUDE.md](CLAUDE.md)).

Concretely, before a post about a change goes out:

1. the change is deployed to stabledesk.xyz;
2. `/methodology` describes the new behaviour, and says what it replaced;
3. the post links to the page, so the reader can check rather than trust.

## What to do when a published number was wrong

Correct it in public, in the same channel, with the same reach. Do not delete, do not edit
silently, do not bury it in a reply.

The correction states, in this order: what was published, what was actually true, what caused the
gap, and what now prevents it. That is the shape of the two strongest posts on the account already
— the `LIMIT 5000` that was being read as a count, and the outage the site blamed on Arc. Both
work because the mechanism is named. "We made an error" is not content; "the number was the cap,
not the count" is.

A correction is not damage control. On this account it is the product demo.

## Formats that work

**The post-mortem.** A number was wrong, here is the mechanism, here is the fix, here is the page
that now documents it. The highest-value format the account has and the only one that is
structurally hard for a competitor to copy — it requires actually finding your own errors.

**The safety warning.** "There is no official bridge; don't send funds anywhere claiming to be
one." Costs nothing, protects people, and is the reason a measurement account earns trust before
it has traction.

**The snapshot.** Figures with the network label, the window, and a link. Lowest effort, lowest
value; use it to keep cadence between the other two, never as the main output.

## What this account does not do

- Publish a figure the API cannot reproduce on request.
- Round a number up, or pick a window because it flatters.
- Claim mainnet activity before Arc mainnet launches publicly.
- Post engagement bait, prediction threads, or price commentary. Stabledesk measures; it does not
  forecast, and it gives no financial advice.
- Post about a competitor's numbers being wrong. Publish the method and let people compare.

## Channels

| Channel | Gate |
|---|---|
| [@getStabledesk](https://x.com/getStabledesk) | Manual. This file is the gate. Data replies only — see *Replies* above. |
| [@MrLazeem](https://x.com/MrLazeem) | Manual. Conversation and replies. Same network rule, no exception for being a person. |
| `stabledesk-brief` | Drafts the figures to Telegram and stops there. It has no X client and is not to be given one. |
| Whale posts (Telegram) | `WHALEWATCH_ENABLED=true` — off by default, so a deploy can never start publishing as a side effect. |
| README + `/methodology` | Ship-gated. Changed in the same commit as the behaviour they describe. |
| Grant applications | Same rule as posts. The traction figure is the measured one or it is absent. |
