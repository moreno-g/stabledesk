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
