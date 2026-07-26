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
import * as payments from './payments.js';
import * as entities from './entities.js';
import * as tvl from './tvl.js';
import * as rankings from './rankings.js';
import { search } from './search.js';
import { CATEGORIES } from './protocols.js';
import { csvResponse, PROTOCOL_COLUMNS, CANDIDATE_COLUMNS } from './csv.js';
import { getLabel } from './labels.js';
import { handleV1, clientIp } from './api.js';
import { RANGES, ADDR_RE, TOKEN_SYMBOLS, ENTITIES_ENABLED, TVL_ENABLED } from './constants.js';
import { CHAIN, NETWORK } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
// CSP tuned to the app: inline styles/scripts + a data: favicon, everything else same-origin only.
// Umami analytics is loaded from and reports to cloud.umami.is, so it's allowlisted explicitly.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cloud.umami.is; connect-src 'self' https://cloud.umami.is; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function json(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...SEC });
  res.end(JSON.stringify(body));
}

// Static assets are shipped with the app and never change at runtime: cache them in memory
// (buffer + gzip + content hash) and serve with ETag revalidation + gzip when accepted.
const assetCache = new Map();

// Network-dependent copy in the static pages. Two directives, deliberately minimal:
//   {{NET}} / {{CHAIN_ID}}                          — substituted with the active profile
//   <!--testnet-only--> … <!--/testnet-only-->      — removed entirely on mainnet
// Applied once at load time, so the cached buffer, its gzip and its ETag all already reflect
// the active network. Nothing is templated per request.
function applyNetwork(html) {
  const out = html
    .replaceAll('{{NET}}', CHAIN.label)
    .replaceAll('{{CHAIN_ID}}', String(CHAIN.chainId));
  return CHAIN.isTestnet ? out : out.replace(/<!--testnet-only-->[\s\S]*?<!--\/testnet-only-->/g, '');
}

async function loadAsset(name, type) {
  let a = assetCache.get(name);
  if (!a) {
    let buf = await readFile(join(__dirname, 'public', name));
    if (type.startsWith('text/html')) buf = Buffer.from(applyNetwork(buf.toString('utf8')), 'utf8');
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
  // experimental entity derivation — 404s cleanly when the flag is off
  if (path === '/api/entities') {
    if (!ENTITIES_ENABLED) return json(res, { error: 'disabled' }, 404);
    return json(res, entities.snapshot());
  }

  // ---- ecosystem: the protocol registry joined to measured TVL and flow ----
  if (path === '/api/ecosystem') {
    const snap = tvl.snapshot();
    if (u.searchParams.get('format') === 'csv') {
      return csvResponse(res, `arc-protocols-${NETWORK}.csv`, snap.protocols, PROTOCOL_COLUMNS);
    }
    return json(res, { ...snap, categories: CATEGORIES, tvlEnabled: TVL_ENABLED });
  }
  if (path === '/api/ecosystem/candidates') {
    const snap = tvl.snapshot();
    if (u.searchParams.get('format') === 'csv') {
      return csvResponse(res, `arc-unnamed-contracts-${NETWORK}.csv`, snap.candidates, CANDIDATE_COLUMNS);
    }
    return json(res, { candidates: snap.candidates, unattributed: snap.totals.unattributed });
  }
  // Accepts either ?id= (a registry entry) or ?address= (any contract, named or not) so the
  // unnamed-contracts list on /ecosystem never links somewhere that 404s.
  if (path === '/api/protocol') {
    const id = String(u.searchParams.get('id') || '').toLowerCase();
    const addr = String(u.searchParams.get('address') || '').toLowerCase();
    let d = null;
    if (id) d = tvl.detail(id);
    else if (ADDR_RE.test(addr)) d = tvl.addressDetail(addr);
    else if (addr) return json(res, { error: 'bad_address' }, 400);
    if (!d) return json(res, { error: 'not_found' }, 404);
    return json(res, d);
  }
  if (path === '/api/search') {
    return json(res, search(u.searchParams.get('q'), 10));
  }
  if (path === '/api/rankings') {
    const r = rankings.daily();
    return json(res, { ...r, digest: rankings.digest(r) });
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
  if (path === '/status' || path === '/status.html') return serveFile(req, res, 'status.html');
  // Served even when derivation is off: the footer links to it from every page, and the page
  // itself reports "disabled" when /api/entities 404s. A dead link is worse than an honest one.
  if (path === '/entities' || path === '/entities.html') return serveFile(req, res, 'entities.html');
  if (path === '/ecosystem' || path === '/ecosystem.html') return serveFile(req, res, 'ecosystem.html');
  if (path === '/protocol' || path === '/protocol.html') return serveFile(req, res, 'protocol.html');
  if (path === '/' || path === '/index.html') return serveFile(req, res, 'index.html');
  return serveFile(req, res, '404.html', 'text/html; charset=utf-8', 404); // unknown → real 404
});

server.listen(PORT, () => {
  console.log(`Stabledesk → http://localhost:${PORT}  ·  ${CHAIN.label} (${NETWORK}, chain ${CHAIN.chainId})`);
  if (!db.getKey('sbd_demo')) db.createKey('sbd_demo', 'Public demo key', 'free');
  start();
  payments.start();
  if (ENTITIES_ENABLED) entities.start();
  if (TVL_ENABLED) tvl.start();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  stop();                          // stop the live poll loop
  payments.stop();                 // stop the payment poller
  entities.stop();                 // stop the entity derivation loop
  tvl.stop();                      // stop the TVL balance scanner
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
