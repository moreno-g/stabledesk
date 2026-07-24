// Arc Stablecoin Terminal — HTTP server.
// Serves the dashboard, the internal /api used by it, the public /v1 API, and /docs.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import * as db from './db.js';
import { live, alertFeed, start, stop } from './indexer.js';
import { getLabel } from './labels.js';
import { handleV1, clientIp } from './api.js';
import { RANGES, ADDR_RE, TOKEN_SYMBOLS } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
// CSP tuned to the app: inline styles/scripts + a data: favicon, everything else same-origin only.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...SEC });
  res.end(JSON.stringify(body));
}

// Static assets are shipped with the app and never change at runtime: cache them in memory
// (buffer + gzip + content hash) and serve with ETag revalidation + gzip when accepted.
const assetCache = new Map();
async function loadAsset(name, type) {
  let a = assetCache.get(name);
  if (!a) {
    const buf = await readFile(join(__dirname, 'public', name));
    const etag = '"' + createHash('sha1').update(buf).digest('base64').slice(0, 22) + '"';
    a = { buf, gz: gzipSync(buf), etag, type };
    assetCache.set(name, a);
  }
  return a;
}
async function serveFile(req, res, name, type = 'text/html; charset=utf-8', code = 200) {
  try {
    const a = await loadAsset(name, type);
    const h = { 'content-type': type, 'cache-control': 'no-cache', etag: a.etag, ...SEC };
    if (type.startsWith('text/html')) h['content-security-policy'] = CSP;
    if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, h); return res.end(); }
    const compressible = /text\/|javascript|json|svg/.test(type); // don't gzip already-compressed images
    if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(code, { ...h, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
      return res.end(a.gz);
    }
    res.writeHead(code, h); res.end(a.buf);
  } catch { res.writeHead(404, SEC); res.end('not found'); }
}

// Coarse per-IP throttle for the keyless internal /api (dashboard needs ~60 req/min; 300 is generous).
const apiRl = new Map();
function apiThrottle(req) {
  const win = Math.floor(Date.now() / 60000);
  const ip = clientIp(req);
  let e = apiRl.get(ip);
  if (!e || e.win !== win) { e = { win, count: 0 }; apiRl.set(ip, e); }
  e.count += 1;
  return e.count <= 300;
}
setInterval(() => { const win = Math.floor(Date.now() / 60000); for (const [k, e] of apiRl) if (e.win < win) apiRl.delete(k); }, 60000).unref();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // public data API (keys + tiers + rate limiting)
  if (path.startsWith('/v1')) return handleV1(req, res, u);

  // internal API for the dashboard (same-origin, no key) — coarse per-IP throttle to blunt abuse
  if (path.startsWith('/api/')) {
    if (!apiThrottle(req)) return json(res, { error: 'rate_limited' }, 429);
  }
  if (path === '/api/state') return json(res, live.snapshot);
  if (path === '/api/alerts') return json(res, { feed: alertFeed });
  if (path === '/api/history') {
    const token = (u.searchParams.get('token') || 'ALL').toUpperCase();
    const r = RANGES[u.searchParams.get('range')] || RANGES['24h'];
    const since = Math.floor(Date.now() / 1000) - r.span;
    return json(res, { token, group: r.group, series: db.getHistory(token, since, r.group) });
  }
  if (path === '/api/top') {
    const limit = Math.min(50, Number(u.searchParams.get('limit')) || 10);
    return json(res, { top: db.getTop(limit) });
  }
  if (path === '/api/token') {
    const token = String(u.searchParams.get('token') || '').toUpperCase();
    if (!TOKEN_SYMBOLS.has(token)) return json(res, { error: 'bad_token' }, 400);
    const s = live.snapshot;
    const sm = s.summary24h?.byToken?.[token] || null;
    const lbl = (a) => getLabel(a)?.name || null;
    const dress = (x) => ({ ...x, fromLabel: lbl(x.frm), toLabel: lbl(x.too) });
    return json(res, {
      token, ok: !!s.ok, updatedAt: s.updatedAt ?? null,
      supply: s.supply?.[token] || null,
      summary24h: sm,
      netIssuance24h: sm ? sm.mint - sm.burn : null,
      distribution: db.sizeDistribution(token),
      largest: db.largestByToken(token, 8).map(dress),
      recent: db.recentByToken(token, 12).map(dress),
    });
  }
  if (path === '/api/address') {
    const addr = String(u.searchParams.get('addr') || '').toLowerCase();
    if (!ADDR_RE.test(addr)) return json(res, { error: 'bad_address' }, 400);
    const stats = db.addressStats(addr) || { address: addr, transfers: 0, volume: 0, last_block: 0 };
    return json(res, { ...stats, label: getLabel(addr)?.name || null, recent: db.addressRecent(addr, 12) });
  }
  if (path === '/api/health') {
    return json(res, {
      ok: live.snapshot.ok,
      stale: !!live.snapshot.stale,
      block: live.snapshot.network?.block ?? null,
      indexLag: live.snapshot.indexLag ?? null,
      lastError: live.snapshot.lastError ?? null,
    });
  }

  // SEO
  if (path === '/robots.txt') return serveFile(req, res, 'robots.txt', 'text/plain; charset=utf-8');
  if (path === '/sitemap.xml') return serveFile(req, res, 'sitemap.xml', 'application/xml; charset=utf-8');

  // static assets + pages
  if (path === '/theme.js') return serveFile(req, res, 'theme.js', 'text/javascript; charset=utf-8');
  if (path === '/og.png') return serveFile(req, res, 'og.png', 'image/png');
  if (path === '/banner.png') return serveFile(req, res, 'banner.png', 'image/png');
  if (path === '/docs' || path === '/docs.html') return serveFile(req, res, 'docs.html');
  if (path === '/token' || path === '/token.html') return serveFile(req, res, 'token.html');
  if (path === '/methodology' || path === '/methodology.html') return serveFile(req, res, 'methodology.html');
  if (path === '/' || path === '/index.html') return serveFile(req, res, 'index.html');
  return serveFile(req, res, '404.html', 'text/html; charset=utf-8', 404); // unknown → real 404
});

server.listen(PORT, () => {
  console.log(`Stabledesk → http://localhost:${PORT}`);
  if (!db.getKey('sbd_demo')) db.createKey('sbd_demo', 'Public demo key', 'free');
  start();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  stop();                          // stop the live poll loop
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
