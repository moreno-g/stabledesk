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
