# Deploying Stabledesk (Railway)

Railway builds the `Dockerfile`, runs it always-on, gives you HTTPS for free, and provides a
persistent volume for the SQLite database. Budget ~10 min + ~$5/month (Hobby plan).

**You'll need:** a Railway account, the `stabledesk.xyz` domain (already bought), and Terminal.

---

## 1) Account + CLI

1. Sign up at **railway.app** and pick the **Hobby** plan (~$5/mo — no free always-on tier).
2. Install the CLI on your Mac and log in:

```bash
npm install -g @railway/cli
railway login
```

## 2) Deploy

From the project folder (`…/Projects/arc`):

```bash
railway init      # create a new project (give it the name "stabledesk")
railway up        # builds the Dockerfile and deploys
```

That's the whole deploy. Railway injects its own `PORT`, which `server.js` already honors.

## 3) Add the persistent volume (important)

Without this, the indexed history resets on every redeploy.

1. Railway dashboard → your service → **Variables / Settings → Volumes → New Volume**
2. Mount path: **`/data`**
3. Redeploy (`railway up` or the Redeploy button).

`db.js` auto-detects Railway's `RAILWAY_VOLUME_MOUNT_PATH` and stores `arc.db` there — no config
needed on your side.

## 4) Domain

**First, a free Railway URL to check it works:**
Service → **Settings → Networking → Generate Domain** → gives you `something.up.railway.app`.

**Then your own domain:**
1. Settings → Networking → **Custom Domain** → enter `stabledesk.xyz`.
2. Railway shows a **CNAME target** — add it at your registrar's DNS.

⚠️ **Apex-domain caveat:** `stabledesk.xyz` (without `www`) needs a registrar that supports
CNAME flattening / ALIAS records. If yours doesn't, the clean fix is to move the domain's DNS to
**Cloudflare** (free) which flattens apex CNAMEs — then point it at Railway. Alternative: use
`www.stabledesk.xyz` as the main address and redirect the apex to it.

## 5) Verify

- `https://stabledesk.xyz` — the terminal
- `https://stabledesk.xyz/docs` — the API docs
- `https://stabledesk.xyz/v1/status` — should return JSON

First boot backfills ~25 min of history, then indexes live.

---

## Everyday operations

```bash
railway logs             # live logs
railway up               # redeploy after code changes
railway open             # open the dashboard
```

**Data** lives in the Railway volume and survives redeploys. **Scaling:** this is a single
instance with SQLite — if traffic grows, migrate to managed Postgres and run replicas. Not needed
at this stage.

---

## Before every deploy — verify the profile against the chain

```bash
npm run verify
```

`chains.js` is the single switch between networks and everything downstream trusts it completely:
token addresses, decimals, symbols, the Gateway pair, the registry. Nothing else checks that any of it
is still true, because no test talks to the chain.

On 22 August 2026 a manual check found it was not. The tracked USYC contract had gone dormant while a
second deployment carried all the activity — one transfer against 722 over the same window — and USDT
had been trading for weeks, with **18 decimals**, untracked. On testnet that is faucet money. On
mainnet a decimals field off by twelve overstates a figure by a factor of a trillion, and the result
still looks like a number.

The script reads the chain and writes nothing. It exits **1** on any FAIL, so it can gate a deploy:

```bash
npm run verify && railway up
```

**FAIL** means the profile asserts something the chain contradicts — an endpoint on the wrong chain, a
token address with no bytecode, a symbol or decimals mismatch. Publishing under it would serve wrong
numbers. **WARN** means the chain moved in a way worth reading: an asset emitting transfers that is not
tracked, a registry contract that is no longer deployed, a wrapper whose supply is exactly the
collateral it holds (which must be registered as a protocol, never tracked as issuance — counting both
reports the same money twice).

Useful flags: `--json` for a machine-readable result, `--blocks N` to widen the discovery sample.

**On launch day**, run it against mainnet before starting the indexer:

```bash
ARC_NETWORK=mainnet npm run verify
```

It will refuse to run at all if the mainnet variables are missing — the same refusal `chains.js` makes,
for the same reason.

---

## Watching for drift — `npm run watch`

`npm run verify` answers *does the profile match the chain right now*. That is the right question
before a deploy and the wrong one on a schedule: run it hourly and it restates the present hourly, so
the one run where something is different reads exactly like the fifty before it.

```bash
npm run watch            # one pass: report what changed since the last pass, then exit
npm run watch -- --every 3600   # loop, for a host with no scheduler
```

One pass and exit is the default because it composes with cron, a Railway job, or a deploy line.

### Running it continuously on Railway

Set two variables on the existing service — no second service, no second volume:

```
WATCH_ENABLED=true
WATCH_EVERY_SEC=3600     # optional, floored at 300
```

The watcher then runs in-process on a timer, the way `tvl`, `entities` and `payments` already do.
It logs one line per pass rather than the full report, and only what changed:

```
[watch] enabled — checking the chain profile every 60 min
[watch] Arc testnet: 0 failed, 1 to review
```

**Why not a Railway cron service.** Railway cron runs a service's start command on a schedule and
requires the process to exit — which `npm run watch` does, cleanly, in about 25 seconds. But a cron
service needs its own volume, and therefore its own database: the watcher's whole value is comparing
this pass to the last one, and that record would live outside the volume `backup.js` snapshots. It
would also be a second service to configure and pay for. Sharing the process shares the database, and
a pass costs about 25 seconds an hour against an indexer that polls every seven seconds. Measured: the
server answered `/api/health` in 4 ms during a pass.

The first pass is delayed two minutes after boot and the interval is offset from the hour, so a
redeploy never lands a watch pass on top of the initial backfill — they would compete for the same
rate-limited endpoints.

Off unless `WATCH_ENABLED=true`: it writes to the database and it can send Telegram messages. Both
should be deliberate rather than a consequence of a deploy.

**This is the only mode that writes.** A plain `npm run verify` stays strictly read-only, which is
what makes it safe to point at production. `--watch` stores what it saw in `watch_subjects` so the
next run has something to compare against.

The first run records a baseline and announces nothing — everything is new the first time you look.

What it reports:

| | |
|---|---|
| `FIRST SEEN` | A contract emitting transfers that we had not observed before. *First seen*, not *new*: the pass samples a slice of recent blocks, so this means we saw it, not that it was deployed since the last check. |
| `CHANGED` | An identity moved under a stable address — a symbol, a decimals field, bytecode that vanished. For a tracked token this is the expensive kind. |
| `QUIET` | A tracked asset that is still deployed, still answers every call, and has stopped producing transfers. **This is the USYC case**, and it is the one no single check can report, because nothing about it is wrong. |
| `GONE` | Something we knew about has been absent from several consecutive samples. |

Absence has to repeat before it is reported — a contract missing from one sample may simply have been
quiet for those few hundred blocks. Same rule the identity probe uses on unanswered calls.

Findings above the severity bar go to Telegram when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are set;
everything else is logged. A tracked token changing its decimals is worth interrupting someone for; a
memecoin appearing is a line in a log. A watcher that forwards everything teaches its reader to ignore
it — the same reasoning behind `chainalert.js` announcing transitions and never conditions.

**It drafts and stops there.** Nothing here posts anywhere, by design: `COMMS.md` makes a human the
interpolation step for anything published, and this is on the measurement side of that line.

---

## Backups — what cannot be re-indexed

Most of the database can be rebuilt by pointing the indexer at the chain again. Four tables cannot,
and losing the volume loses them permanently:

| Table | Why it is irreplaceable |
|---|---|
| `chain_events` | The availability record. It is a log of *observations* — when we were watching and what we saw. Re-indexing cannot reconstruct having been present. |
| `buckets_daily` | Per-day history, kept indefinitely. Re-indexable in principle, but only for as long as the RPC still serves those blocks' logs, and never for a range the provider has pruned. |
| `tvl_history` | Daily TVL levels. A level is a reading taken at a moment; `balanceOf` today cannot tell you last Tuesday's balance. |
| `api_keys` / `orders` | Issued keys and paid subscriptions. Losing these revokes access people paid for. |

`top_transfers` and `fee_samples` are re-derivable; `buckets`, `addr_stats` and `recent` are rolling
windows and will refill on their own.

`cp` is not a backup of a live SQLite database: with WAL enabled the file on disk is not a complete
database on its own, and a copy taken mid-write is a torn one. `backup.js` drives SQLite's
online-backup API instead — a consistent snapshot with no downtime — then runs `integrity_check` on
the *copy* and prints the row count of each irreplaceable table, because a snapshot nobody verified is
a file rather than a backup:

```bash
railway ssh node backup.js /tmp/snap.db
```

It resolves the database path exactly the way `db.js` does, so it can never snapshot a different file
than the one the service is writing to, and it needs no `sqlite3` binary — the deployed image is
`node:24-slim`, which does not ship one. Then pull the file down:

```bash
railway ssh cat /tmp/snap.db > "stabledesk-$(date +%F).db"
```

Expect output like `ok · 65.6 MB · chain_events=412 buckets_daily=94 tvl_history=88 api_keys=37`. A
count of `0` or `absent` on `chain_events` or `buckets_daily` means the snapshot is not worth keeping —
investigate before overwriting the previous one.

Keep this on a schedule; weekly is enough for a daily rollup, and the whole point of a permanent record
is that it survives the disk it lives on. Restore is the reverse: stop the service, copy the file onto
the volume under the name `chains.js` expects for that network (`arc-mainnet.db` or `arc.db`), redeploy.

⚠️ **Never restore a testnet snapshot onto a mainnet deployment or vice versa.** The aggregates are
additive, so faucet volume mixed into mainnet history could not be subtracted back out afterwards —
which is why the two networks use different filenames in the first place.

---

## Appendix — alternative: any VPS with Docker

The repo also ships a `docker-compose.yml` + `Caddyfile` (app + Caddy with automatic HTTPS) if you
ever want to self-host on a plain Ubuntu server instead:

```bash
scp -r . root@SERVER_IP:/root/stabledesk
ssh root@SERVER_IP
cd /root/stabledesk && bash deploy/bootstrap.sh
```

Point DNS `@` and `www` at the server IP. Compose sets `DB_PATH=/app/data/arc.db` on a persistent
volume. Not needed if you're on Railway.
