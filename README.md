# Stabledesk

**Stabledesk** — a **live** analytics terminal for stablecoin flows on the **Arc testnet** (Circle's L1),
plus a **data API**. Prototype v0, read-only, zero dependencies. [@getStabledesk](https://x.com/getStabledesk)

This is the project's wedge: not a generic explorer (Arcscan already exists), but the
**stablecoin-finance analytics layer + API** that can be monetized (paid API, Pro/B2B).

## What it shows (real data, live)

- **Network** — current block, block time (~0.5s), throughput (tx/s), cost per transfer in USDC (~$0.0005), active addresses.
- **Stablecoin flows** — volume + transfer count for **USDC / EURC / USYC**, measured from `Transfer` events over a rolling window; mint/burn for native USDC.
- **Per-block activity** + **largest transfers**, in real time.

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
5. ✅ **Alerts** — live in-app feed + browser watchlist + Pro webhook alerts (`/v1/alerts`). Next: token/address detail pages, exports.
6. Utility token (phase 3, optional) — access/stake + buyback, no revenue-share.
