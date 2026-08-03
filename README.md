# Stabledesk

**Stabledesk** measures every stablecoin on **Arc**, Circle's L1 — supply, real volume, TVL and
flows — read straight from the chain, with a [published method](https://stabledesk.xyz/methodology)
and a free data API.

**[stabledesk.xyz](https://stabledesk.xyz)** · [@getStabledesk](https://x.com/getStabledesk)

Not another explorer — Arcscan already does blocks and transactions. Stabledesk is the
**stablecoin-finance analytics layer**: what actually moved, how much of it was real economic
activity rather than routing noise, what it cost the network to move it, and which protocols hold
the value. Runs against Arc mainnet or testnet from the same code (`ARC_NETWORK`).

Read-only. Zero dependencies — Node's native `fetch` and `node:sqlite`, nothing else.

## What it measures

- **Three volume measures, all published** — raw (every `Transfer` event), **real** (one largest
  transfer per transaction per token, so routing hops and contract internals don't count twice),
  and **adjusted** (real, minus infrastructure talking to infrastructure). Showing all three means
  every filtering step is auditable rather than asserted.
- **Network economics** — gas on Arc is paid in USDC, so fees are dollars read straight from
  transaction receipts: no price feed, no oracle. Headline metric is *cost to move $1M*.
- **Stablecoin supply, share and velocity** per token, plus mint/burn.
- **Per-block activity** + **largest transfers**, in real time.
- **Ecosystem** (`/ecosystem`) — every protocol on Arc with its **TVL**, flow, status and official links, plus
  the contracts holding balances nobody has named yet. TVL is measured as stablecoin balances held by
  contracts, which needs no per-protocol adapter on a chain where value is denominated in USDC.

## Run

```bash
node server.js
# → http://localhost:4317
```

No install step (Node ≥ 20). On first run the indexer backfills recent history, then keeps
indexing forward and serves:

- `GET /` — the terminal
- `GET /api/state` — live snapshot: network stats, 24h summary, top addresses, largest transfers
- `GET /api/history?token=ALL|USDC|EURC|USYC&range=1h|24h|7d` — time series (volume, count, mint, burn)
- `GET /api/top?limit=N` — top addresses by volume
- `GET /api/health` — status: indexer health *and* chain liveness, reported separately
- `GET /api/uptime?days=30` — the availability record: uptime over observed time, plus coverage
- `GET /openapi.json` — OpenAPI 3.1 description of the whole `/v1` surface
- `GET /llms.txt` — short index of the site and its data, for language models and agents

State (SQLite) is written to `arc.db` (gitignored). Delete it to re-index from scratch.

```bash
npm test   # smoke tests (node:test — no network, still zero deps)
```

### When the chain stops

Arc halting and Stabledesk breaking have the same symptom — nothing updates — and opposite
remedies, so they are tracked and reported as two separate things.

- **Chain state**: `live`, `halted` (the RPC answers but the head has not moved for
  `CHAIN_HALT_MS`), `unauthorized` (every endpoint answered and refused our credentials — ours to
  fix, not an outage), or `unreachable` (nobody answered). Published on `/api/health`,
  `/api/state` and `/v1/status` as `chain`.
- **A rejected key is not an outage.** A 401/403 means something *is* listening and is turning us
  away, so it is reported as our configuration failing, with a red status — announcing it as
  "Arc is unreachable" sends everyone to look at the wrong system. Only when every endpoint
  refuses us is the verdict `unauthorized`; a single network-level failure among them keeps it
  `unreachable`, because the network is then involved too.
- **Degraded mode**: whenever the chain can't be read, the snapshot is rebuilt from SQLite alone
  and served with `degraded: true`. The terminal keeps showing indexed history — volumes, top
  addresses, largest transfers, fee economics — labelled with when it was measured, instead of
  going blank. Only a genuinely empty database reports `booting`.
- **Live-only figures go null, never stale**: block time, throughput and gas price are absent
  rather than carried over, because an old number displayed as current is a wrong number.
- **Rolling windows re-anchor**: frozen, the 24h windows end at the last indexed minute
  (`windowEnd`) rather than at now — a trailing-24h-from-now window on a halted chain would
  report "24h volume: 0" and state the chain sat idle when in fact it stopped.
- **The verdict is pushed, not just published** (`chainalert.js`). A refused credential once sat in
  production for four days — correctly diagnosed and correctly displayed, on a page nobody was
  watching. State *changes* are announced to Telegram (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`,
  optional) and always logged; the condition is not, because alerting every poll would send hundreds
  of identical messages an hour and train the reader to ignore them. Recovery has its own cooldown
  budget so it can never be swallowed by the outage's.

### Machine-readable surfaces

`/openapi.json` and `/llms.txt` are **generated from the live configuration**, for the same reason
`sitemap.xml` is: a hand-maintained document is a hand-maintained omission, and the parts most
likely to rot — the tracked token symbols, the chain id, the per-tier rate limits — are exactly the
parts that differ per network. A smoke test reads the routes back out of `api.js` and fails if the
API serves something the spec doesn't describe, or describes something it doesn't serve.

### The availability record

Every transition is kept (`chain_events`, never pruned), so "was Arc up last Tuesday" stops
depending on someone's memory of an alert. Published on `/status` and `/v1/chain/uptime`.

The arithmetic is the whole feature, because the obvious version of it lies. Computing
`live_ms / wall_clock_ms` books every second the indexer wasn't running as whatever state it last
saw — leave it off for a week and it publishes a week of Arc uptime it never witnessed.

- **Uptime is a share of observed time, and coverage is published beside it, always.** 99.9% over
  4% coverage is a statement about four percent of the month. A watermark is written while the
  indexer runs and a gap marker at boot, so time nobody was watching is a fact in the record rather
  than an absence that reads as continuity.
- **A refused credential is not chain downtime.** Our own four-day 401 counts as time we weren't
  looking, not as Arc being down — the chain may have been perfectly healthy throughout. Booking it
  against Arc would be the same misattribution the `unauthorized` state was introduced to prevent,
  in the one place where the error flatters us.
- **`unreachable` is counted as down, and the caveat is published with it**: our host losing
  connectivity is indistinguishable from the chain going dark. The full per-state breakdown is
  returned so a reader who draws that line differently can recompute without us.
- **Incidents name who was at fault**, including when it was us. Our outages appear in the list
  under our own name rather than being filtered out.
- Nothing observed yields `null`, not 100%.

### How it works

- **Modules**: `rpc.js` (RPC + chain constants) · `db.js` (SQLite schema + queries) · `indexer.js` (backfill + live loop + snapshot) · `server.js` (HTTP + API) · `openapi.js` (generated spec + `llms.txt`).
- **Trick**: blocks are ~0.5s with no reorgs, so a transfer's timestamp is derived from its block number against a rolling anchor — the indexer only needs `eth_getLogs`, sparing the rate-limited public RPC.

## Networks

The same code runs against either network; `ARC_NETWORK` picks which, and each keeps its own
database file so faucet volume can never be mixed into mainnet aggregates.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `5042` | `5042002` |
| Config | `ARC_CHAIN_ID`, `ARC_RPC_URLS`, `ARC_TOKENS` (required) | built in |
| DB file | `arc-mainnet.db` | `arc.db` |

Mainnet **refuses to start** with any of its three variables missing, rather than falling back to
testnet — serving faucet play-money as real value is the one failure worth crashing over.

Both are EVM, gas is paid in USDC, and there are no reorgs. That last property is what keeps the
indexer simple: a transfer's timestamp is derived from its block number against a rolling anchor,
so the hot path only needs `eth_getLogs` and the rate-limited public RPC is spared.

## Roadmap

1. ✅ **Historical indexer** (SQLite) → time series: volumes, mint/burn, top addresses.
2. ✅ **Public API** — `/v1` with API keys, free/pro tiers, rate limiting, `/docs` developer page.
3. ✅ **Deployed** on mainnet at [stabledesk.xyz](https://stabledesk.xyz).
4. ✅ **Alerts** — live in-app feed + browser watchlist + Pro webhook alerts (`/v1/alerts`).
5. ✅ **Ecosystem registry + TVL** — `protocols.js` (curated, contribution-based — see `PROTOCOLS.md`),
   `tvl.js` (balance scanner + unnamed-contract discovery), `/ecosystem`, `/protocol`, global search,
   CSV export, and `rankings.js` for the daily digest.
6. ✅ **Honest degradation** — chain liveness separated from indexer health, indexed history served
   through an outage (see *When the chain stops* above).
7. ✅ **Chain uptime history** — the transitions are persisted, so Arc's availability since launch
   is a public record (`/status`, `/v1/chain/uptime` — see *The availability record* below).
8. **Billing** — USDC on Base is implemented (`payments.js`); card payment is not.

### Ecosystem endpoints

- `GET /api/ecosystem` — registry joined to measured TVL and flow (`?format=csv`)
- `GET /api/ecosystem/candidates` — contracts holding balances no protocol claims (`?format=csv`)
- `GET /api/protocol?id=…` or `?address=…` — detail, named or unattributed
- `GET /api/search?q=…` — protocols, tokens, addresses
- `GET /api/rankings` — daily standings + the ready-to-post digest
- Public equivalents: `/v1/protocols`, `/v1/protocols/{id}`, `/v1/protocols/unnamed`, `/v1/tvl`,
  `/v1/tvl/history`, `/v1/rankings`, `/v1/search`

Set `TVL_ENABLED=false` to stop the balance scanner; the pages then report it as disabled rather than
showing stale figures.

## Design principles

The same rule keeps reappearing in this codebase, so it may as well be stated once: **a number
must never claim to be something it isn't.**

- **Publish the method, not just the result.** Every filter is documented and every threshold is
  a published number, so a reader can disagree with a choice instead of having to trust it. Where
  Stabledesk departs from an existing standard — dropping a transfer only when *both* ends are
  flagged infrastructure, against Visa/Allium's "either end" — the reason is measured and stated.
- **Extrapolations carry their sample size.** Fee figures rest on sampled blocks, so every derived
  rate reports how many blocks it came from. An estimate is never presented as a measured total.
- **Report what you can't name.** Contract balances no registry entry claims are counted in the
  chain total and listed separately as *unattributed*. Hiding them would understate the chain;
  assigning them to a plausible protocol would invent data.
- **Absent beats stale.** When a figure can't be measured it goes null, not last-known. An old
  number displayed as current is a wrong number, not an old one.
- **Attribute failure honestly, in both directions.** A halted chain is not our bug, and a rejected
  API key is not the chain's fault. Conflating either one sends people to fix the wrong system.

## Author

Built by **Gaëtan Moreno** — [@moreno-g](https://github.com/moreno-g) ·
[@getStabledesk](https://x.com/getStabledesk) · [studiomoreno@icloud.com](mailto:studiomoreno@icloud.com)
