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
import { CATEGORIES, PROTOCOLS, protocolById } from './protocols.js';
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

// ---- templated pages ----
// The same HTML file served with per-entity metadata *and* real numbers baked in. Two reasons this
// has to happen server-side: a crawler fetching /token/usdc otherwise receives a skeleton whose
// title is the generic "Stabledesk · Token" — identical for every token, so three pages collapse
// into one in the index — and none of the figures exist in the markup at all.
//
// Cached per entity with a short TTL, so the baked-in numbers stay honest while ETag and gzip keep
// working. The key set is bounded because every id is validated against the registry (or the token
// list) before it gets here; an unknown id 404s rather than minting a cache entry.
const TEMPLATE_TTL_MS = 60000;
const pageCache = new Map();

const escAttr = (s) => String(s == null ? '' : s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

async function serveTemplated(req, res, name, key, vars) {
  const ck = name + '|' + key;
  let p = pageCache.get(ck);
  if (!p || p.expires < Date.now()) {
    try {
      // loadAsset has already applied the network profile, so {{NET}} etc. are resolved.
      const base = await loadAsset(name, 'text/html; charset=utf-8');
      let html = base.buf.toString('utf8');
      for (const [k, v] of Object.entries(vars)) html = html.replaceAll('{{' + k + '}}', escAttr(v));
      const buf = Buffer.from(html, 'utf8');
      p = {
        buf,
        gz: gzipSync(buf),
        etag: '"' + createHash('sha1').update(buf).digest('base64').slice(0, 22) + '"',
        expires: Date.now() + TEMPLATE_TTL_MS,
      };
      pageCache.set(ck, p);
    } catch { res.writeHead(404, SEC); return res.end('not found'); }
  }
  const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: p.etag, 'content-security-policy': CSP, ...SEC };
  if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...h, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
    return res.end(p.gz);
  }
  res.writeHead(200, h); res.end(p.buf);
}

const redirect = (res, to) => { res.writeHead(301, { location: to, 'cache-control': 'no-cache', ...SEC }); res.end(); };

const compactNum = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  // Testnet supply is faucet-inflated well past a billion, so T has to exist — otherwise a real
  // figure renders as "2000.96B", which reads as a formatting bug rather than a large number.
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n * 100) / 100);
};

// Category labels come from the registry, so the indefinite article has to be derived rather than
// written into the sentence — "a issuer" otherwise ends up in a meta description.
const article = (word) => (/^[aeiou]/i.test(String(word || '')) ? 'an' : 'a');

// Velocity below a thousandth rounds to "0.000×", which looks broken rather than small. Report the
// bound instead — it is the same claim, honestly stated.
const velocityTxt = (v) => {
  if (v == null || !Number.isFinite(v) || v === 0) return '—';
  if (v < 0.001) return '<0.001×';
  return (v < 1 ? v.toFixed(3) : v.toFixed(1)) + '×';
};

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
  // TVL is merged in here rather than computed by the indexer: it comes from a separate scan loop on
  // its own cadence, and tvl.total() is a single summed query so the dashboard's polling stays cheap.
  if (path === '/api/state') return json(res, { ...live.snapshot, tvl: TVL_ENABLED ? tvl.total() : null });
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
  // Generated rather than a static file, so adding a protocol to the registry lists it for
  // crawlers with no second step — a hand-maintained sitemap is a hand-maintained omission.
  if (path === '/sitemap.xml') {
    const url = (loc, freq, pri) => `  <url><loc>https://stabledesk.xyz${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
    const body = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      url('/', 'hourly', '1.0'),
      url('/ecosystem', 'daily', '0.9'),
      url('/docs', 'weekly', '0.8'),
      url('/methodology', 'monthly', '0.6'),
      ...[...TOKEN_SYMBOLS].map((s) => url(`/token/${s.toLowerCase()}`, 'daily', '0.8')),
      ...PROTOCOLS.map((p) => url(`/protocol/${p.id}`, 'daily', '0.7')),
      '</urlset>', ''].join('\n');
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600', ...SEC });
    return res.end(body);
  }

  // static assets + pages
  if (path === '/theme.js') return serveFile(req, res, 'theme.js', 'text/javascript; charset=utf-8');
  if (path === '/og.png') return serveFile(req, res, 'og.png', 'image/png');
  if (path === '/banner.png') return serveFile(req, res, 'banner.png', 'image/png');
  if (path === '/docs' || path === '/docs.html') return serveFile(req, res, 'docs.html');

  // ---- one indexable page per token, on a path URL ----
  // Previously every token shared /token with a single generic title, so three distinct pages
  // collapsed into one in a search index. Old query URLs 301 here rather than 404 — existing links
  // and bookmarks keep working, and the redirect consolidates their ranking signal.
  const tokMatch = /^\/token\/([A-Za-z0-9]{2,10})$/.exec(path);
  if (tokMatch) {
    const sym = tokMatch[1].toUpperCase();
    if (!TOKEN_SYMBOLS.has(sym)) return serveFile(req, res, '404.html', 'text/html; charset=utf-8', 404);
    const s = live.snapshot;
    const sup = s.supply?.[sym] || null;
    const sm = s.summary24h?.byToken?.[sym] || null;
    const net = CHAIN.label;
    const supplyTxt = sup ? compactNum(sup.supply) : '—';
    const volTxt = sup ? compactNum(sup.rvolume24h) : '—';
    const velTxt = velocityTxt(sup?.velocity);
    const issuance = sm ? sm.mint - sm.burn : null;
    return serveTemplated(req, res, 'token.html', sym, {
      TITLE: `${sym} on ${net} — supply, volume & velocity · Stabledesk`,
      DESCRIPTION: `Live ${sym} analytics on ${net} (Circle's L1): ${supplyTxt} supply, ${volTxt} real volume over 24h, `
        + `${velTxt} velocity${issuance != null ? `, ${compactNum(issuance)} net issuance` : ''}. `
        + 'Transfer-size distribution, largest transfers and mint/burn, measured from chain data.',
      CANONICAL: `https://stabledesk.xyz/token/${sym.toLowerCase()}`,
      OG_TITLE: `${sym} on ${net} · Stabledesk`,
      OG_DESC: `${supplyTxt} supply · ${volTxt} 24h real volume · ${velTxt} velocity`,
      ROBOTS: 'index, follow',
      TOKEN: sym,
      SSR: `${sym} on ${net}: ${supplyTxt} supply, ${volTxt} real transfer volume over the last 24 hours, `
        + `velocity ${velTxt}${issuance != null ? `, net issuance ${compactNum(issuance)}` : ''}.`,
    });
  }
  if (path === '/token' || path === '/token.html') {
    const q = String(u.searchParams.get('token') || '').toUpperCase();
    if (TOKEN_SYMBOLS.has(q)) return redirect(res, `/token/${q.toLowerCase()}`);
    return redirect(res, `/token/${[...TOKEN_SYMBOLS][0].toLowerCase()}`);
  }
  if (path === '/methodology' || path === '/methodology.html') return serveFile(req, res, 'methodology.html');
  if (path === '/status' || path === '/status.html') return serveFile(req, res, 'status.html');
  // Served even when derivation is off: the footer links to it from every page, and the page
  // itself reports "disabled" when /api/entities 404s. A dead link is worse than an honest one.
  if (path === '/entities' || path === '/entities.html') return serveFile(req, res, 'entities.html');
  if (path === '/ecosystem' || path === '/ecosystem.html') return serveFile(req, res, 'ecosystem.html');

  // ---- one indexable page per protocol ----
  const protoMatch = /^\/protocol\/([a-z0-9-]{1,40})$/.exec(path);
  if (protoMatch) {
    const p = protocolById(protoMatch[1]);
    if (!p) return serveFile(req, res, '404.html', 'text/html; charset=utf-8', 404);
    const d = tvl.detail(p.id);
    const tvlTxt = compactNum(d?.tvl ?? 0);
    const net = CHAIN.label;
    const cat = CATEGORIES[p.category]?.label || p.category;
    return serveTemplated(req, res, 'protocol.html', p.id, {
      TITLE: `${p.name} on ${net} — TVL & activity · Stabledesk`,
      DESCRIPTION: `${p.name}${p.vendor ? ` (${p.vendor})` : ''} on ${net}: ${tvlTxt} held in stablecoins across `
        + `${p.contracts.length} contract${p.contracts.length === 1 ? '' : 's'}. ${p.desc || ''}`.trim(),
      CANONICAL: `https://stabledesk.xyz/protocol/${p.id}`,
      OG_TITLE: `${p.name} on ${net} · Stabledesk`,
      OG_DESC: `${cat} · ${tvlTxt} held in stablecoins`,
      ROBOTS: 'index, follow',
      PROTOCOL: p.name,
      SSR: `${p.name} is ${article(cat)} ${cat.toLowerCase()} protocol on ${net}, holding ${tvlTxt} in stablecoins across `
        + `${p.contracts.length} tracked contract${p.contracts.length === 1 ? '' : 's'}.`,
    });
  }
  if (path === '/protocol' || path === '/protocol.html') {
    const id = String(u.searchParams.get('id') || '').toLowerCase();
    if (id && protocolById(id)) return redirect(res, `/protocol/${id}`);
    // The address variant stays on a query URL and is deliberately noindex: nobody searches a hex
    // address, and mass-indexing profiles of institutional counterparties on a compliance-first
    // chain is a liability rather than an SEO asset. The lookup works; it just isn't crawled.
    const addr = String(u.searchParams.get('address') || '').toLowerCase();
    if (ADDR_RE.test(addr)) {
      return serveTemplated(req, res, 'protocol.html', 'addr', {
        TITLE: 'Unnamed contract · Stabledesk',
        DESCRIPTION: 'A contract holding stablecoin balances that no listed protocol claims.',
        CANONICAL: 'https://stabledesk.xyz/ecosystem',
        OG_TITLE: 'Unnamed contract · Stabledesk',
        OG_DESC: 'A contract holding stablecoin balances that no listed protocol claims.',
        ROBOTS: 'noindex',
        PROTOCOL: 'Unnamed contract',
        SSR: '',
      });
    }
    return redirect(res, '/ecosystem');
  }
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
