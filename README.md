# Stabledesk

**Stabledesk** — a **live** analytics terminal for stablecoin flows on the **Arc testnet** (Circle's L1),
plus a **data API**. Prototype v0, read-only, zero dependencies. [@getStabledesk](https://x.com/getStabledesk)

This is the project's wedge: not a generic explorer (Arcscan already exists), but the
**stablecoin-finance analytics layer + API** that can be monetized (paid API, Pro/B2B).

## What it shows (real data, live)

- **Network** — current block, block time (~0.5s), throughput (tx/s), cost per transfer in USDC (~$0.0005), active addresses.
- **Stablecoin flows** — volume + transfer count for **USDC / EURC / USYC**, measured from `Transfer` events over a rolling window; mint/burn for native USDC.
- **Per-block activity** + **largest transfers**, in real time.
- **Ecosystem** (`/ecosystem`) — every protocol on Arc with its **TVL**, flow, status and official links, plus
  the contracts holding balances nobody has named yet. TVL is measured as stablecoin balances held by
  contracts, which needs no per-protocol adapter on a chain where value is denominated in USDC.

## Run

```bash
node server.js
# → http://localhost:4317
```

No install (Node ≥ 20, native `fetch` + native `node:sqlite`). On first run the indexer
**backfills ~3,000 blocks** (~25 min of history), then keeps indexing forward and serves:

- `GET /` — the dashboard
- `GET /api/state` — live snapshot: network stats, 24h summary, top addresses, largest transfers ← **seed of the monetizable API**
- `GET /api/history?token=ALL|USDC|EURC|USYC&range=1h|24h|7d` — time series (volume, count, mint, burn)
- `GET /api/top?limit=N` — top addresses by volume
- `GET /api/health` — status

State (SQLite) is written to `arc.db` (gitignored). Delete it to re-index from scratch.

```bash
npm test   # smoke tests (node:test — no network, still zero deps)
```

### How it works

- **Modules**: `rpc.js` (RPC + chain constants) · `db.js` (SQLite schema + queries) · `indexer.js` (backfill + live loop + snapshot) · `server.js` (HTTP + API).
- **Trick**: blocks are ~0.5s with no reorgs, so a transfer's timestamp is derived from its block number against a rolling anchor — the indexer only needs `eth_getLogs`, sparing the rate-limited public RPC.

## Technical notes

- **RPC**: `https://rpc.testnet.arc.io` (Circle), with fallback to alternate endpoints.
- **Chain ID**: `5042002`. EVM. Gas paid in USDC. No reorgs → simple indexing.
- **Contracts** (testnet): USDC `0x3600…0000` (native, ERC-20 interface, 6 dec.), EURC `0x89B5…D72a`, USYC `0xe918…b86C`.
- The poller is deliberately **light** (few calls, batched, tolerant of the public RPC rate limit).

## Roadmap

1. ✅ **Historical indexer** (SQLite) → time series: volumes, mint/burn, top addresses.
2. ✅ **Public API** — `/v1` with API keys, free/pro tiers, rate limiting, `/docs` developer page.
3. **Deploy** to a public URL + managed DB (Neon/Supabase); split the indexer into a worker.
4. **Billing** via Stripe (card) + USDC on-chain (pay on Arc).
5. ✅ **Alerts** — live in-app feed + browser watchlist + Pro webhook alerts (`/v1/alerts`).
6. ✅ **Ecosystem registry + TVL** — `protocols.js` (curated, contribution-based — see `PROTOCOLS.md`),
   `tvl.js` (balance scanner + unnamed-contract discovery), `/ecosystem`, `/protocol`, global search,
   CSV export, and `rankings.js` for the daily digest.
7. Utility token (phase 3, optional) — access/stake + buyback, no revenue-share.

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
