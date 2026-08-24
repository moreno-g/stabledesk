// Arc Stablecoin Terminal — HTTP server.
// Serves the dashboard, the internal /api used by it, the public /v1 API, and /docs.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import * as db from './db.js';
import { live, alertFeed, chainStatus, indexProgress, start, stop } from './indexer.js';
import * as payments from './payments.js';
import * as entities from './entities.js';
import * as tvl from './tvl.js';
import * as rankings from './rankings.js';
import * as chainuptime from './chainuptime.js';
import * as whalewatch from './whalewatch.js';
import { search } from './search.js';
import { CATEGORIES, PROTOCOLS, protocolById } from './protocols.js';
import { csvResponse, PROTOCOL_COLUMNS, CANDIDATE_COLUMNS } from './csv.js';
import { getLabel } from './labels.js';
import { handleV1, clientIp } from './api.js';
import { normalizePath, dayOf, countable, keyPrefix, buildDigest, QUIET_DAYS_BEFORE_HEARTBEAT } from './usage.js';
import { sendTelegram, configured as tgConfigured } from './telegram.js';
import { specJson, llmsTxt } from './openapi.js';
import { runOnce } from './verify-network.js';
import { RANGES, ADDR_RE, clampLimit, alignToBucket, TOKEN_SYMBOLS, ENTITIES_ENABLED, TVL_ENABLED, WHALEWATCH_ENABLED, WATCH_ENABLED, WATCH_EVERY_SEC, SITE_ORIGIN } from './constants.js';
import { CHAIN, NETWORK } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
// CSP tuned to the app: inline styles/scripts + a data: favicon, everything else same-origin only.
//
// Umami is served from cloud.umami.is but posts its beacons to gateway.umami.is, so both hosts have
// to be named — script-src for the first, connect-src for the second. Only cloud.umami.is was listed,
// which loaded the script and then blocked every event it tried to send: the console showed
// "violates the following Content Security Policy directive" on each pageview and the analytics had
// been recording nothing. Found while verifying an unrelated change.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://cloud.umami.is; connect-src 'self' https://cloud.umami.is https://gateway.umami.is; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  // The tracked assets differ per network (USYC exists on testnet but not on mainnet), so the
  // token list is substituted rather than written out — a hardcoded symbol would render an
  // empty tab and an empty row on whichever network doesn't have it.
  const symbols = [...new Set(Object.values(CHAIN.tokens).map((t) => t.symbol))];
  // Whether Circle Gateway is deployed here is a fact about the active network, not a sentence to
  // write down once. /methodology asserted "Arc mainnet is not on Circle's Gateway list yet", which
  // is true until the day it isn't — and that day is a launch day, when nobody will be editing prose.
  const gatewayStatus = CHAIN.gateway
    ? `${CHAIN.label} is a Gateway chain and is measured as described: Gateway's contracts are `
      + `<code>${CHAIN.gateway.wallet}</code> and <code>${CHAIN.gateway.minter}</code>.`
    : `Circle Gateway is not deployed on ${CHAIN.label}, so there is no bridge flow to attribute here.`;
  // One line per tracked asset, with what it is and how many contracts carry it. Generated because
  // a hand-written list is a list that goes stale: it said "USDC, EURC and USYC" for a month after
  // USDT started trading on the chain, and said nothing about USYC having two deployments.
  const bySymbol = new Map();
  for (const [addr, m] of Object.entries(CHAIN.tokens)) {
    if (!bySymbol.has(m.symbol)) bySymbol.set(m.symbol, { kind: m.kind, addrs: [] });
    bySymbol.get(m.symbol).addrs.push(addr);
  }
  const tokensDetail = [...bySymbol.entries()]
    .map(([sym, t]) => `<strong>${sym}</strong> (${t.kind}${t.addrs.length > 1 ? `, ${t.addrs.length} contracts` : ''})`)
    .join(', ');

  const out = html
    .replaceAll('{{TOKENS_DETAIL}}', tokensDetail)
    .replaceAll('{{GATEWAY_STATUS}}', gatewayStatus)
    .replaceAll('{{NET}}', CHAIN.label)
    .replaceAll('{{CHAIN_ID}}', String(CHAIN.chainId))
    // Lets the page reason about the network in JS, not only in markup: some caveats belong on a
    // rendered value ("faucet-inflated" next to a supply figure) rather than in a block of copy
    // that a testnet-only comment could wrap.
    .replaceAll('{{IS_TESTNET}}', String(CHAIN.isTestnet))
    .replaceAll('{{TOKENS_JSON}}', JSON.stringify(symbols))
    .replaceAll('{{TOKENS_PLUS}}', symbols.join('+'))
    .replaceAll('{{TOKENS_SLASH}}', symbols.join(' / '))
    .replaceAll('{{TOKENS}}', symbols.join(', '));
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

// Generated text documents (openapi.json, llms.txt). Built once at boot like the static assets,
// so they get the same treatment — cached buffer, gzip, ETag revalidation — without going through
// the filesystem. Kept public-cacheable: these are meant to be fetched by crawlers and agents.
const textCache = new Map();
function sendText(req, res, name, body, type) {
  let a = textCache.get(name);
  if (!a) {
    const buf = Buffer.from(body, 'utf8');
    a = { buf, gz: gzipSync(buf), etag: '"' + createHash('sha1').update(buf).digest('base64').slice(0, 22) + '"' };
    textCache.set(name, a);
  }
  const h = { 'content-type': type, 'cache-control': 'public, max-age=3600', etag: a.etag, ...SEC };
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...h, 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
    return res.end(a.gz);
  }
  res.writeHead(200, h); res.end(a.buf);
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

// Private usage route. Unset by default: a deployment with no token behaves as though the route
// does not exist, which is the right default for something that reports on the operator's own
// traffic. Set ADMIN_TOKEN in the environment to enable it.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Compared in constant time. String equality on a secret leaks its length and how far a guess got
// through timing — a small leak, but the fix costs one function call.
function adminOk(req, u) {
  const given = String(req.headers['x-admin-token'] || u.searchParams.get('token') || '');
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

// ---- the daily usage digest ----
//
// Reports yesterday, not today: a digest of a day still in progress is a partial count presented as
// a total, and this project publishes windows that have actually closed.
//
// The once-a-day guard lives in the database rather than in a variable, because Railway restarts on
// every deploy — an in-memory guard would re-send after each one, or skip a day, depending on the
// hour. The day already sent is the state; the process holds none.
const DIGEST_HOUR = Math.min(23, Math.max(0, Number(process.env.DIGEST_HOUR ?? 9)));
const DIGEST_KEY = 'usage_digest_last_day';
const QUIET_KEY = 'usage_digest_quiet_days';

async function maybeSendDigest(now = new Date()) {
  if (!tgConfigured) return false;
  if (now.getUTCHours() < DIGEST_HOUR) return false;

  const yesterday = dayOf(now.getTime()) - 86400;
  if (Number(db.getMetaValue(DIGEST_KEY) || 0) >= yesterday) return false;   // already reported

  const routes = db.routesOnDay(yesterday);
  const keys = db.keysOnDay(yesterday);
  const created = db.keysCreatedOn(yesterday * 1000, (yesterday + 86400) * 1000);
  const quietDays = Number(db.getMetaValue(QUIET_KEY) || 0) + 1;

  const text = buildDigest({
    day: yesterday, routes, keys, created,
    totalKeys: db.keyTotal(), quietDays,
  });

  // Marked reported only once the report actually reached someone. Marking before the send meant a
  // single transient Telegram failure at the first check of the day lost that day's digest with no
  // retry — the next hourly check read "already reported" and moved on. For the project whose own
  // alerting notes that a verdict nobody reads is not monitoring, that was the same defect one
  // storey up. A quiet day that produced no message involves no delivery, so it is marked at once;
  // a failed send marks nothing, and the next hourly check recomputes the same values and tries
  // again — idempotent, because nothing was written.
  const busy = routes.length > 0 || created.length > 0;
  const markReported = () => {
    db.setMetaValue(DIGEST_KEY, String(yesterday));
    db.setMetaValue(QUIET_KEY, busy ? '0' : String(quietDays >= QUIET_DAYS_BEFORE_HEARTBEAT ? 0 : quietDays));
  };

  if (!text) { markReported(); return false; }
  try { await sendTelegram(text); markReported(); return true; }
  catch (e) { console.error('[digest] send failed — will retry on the next hourly check:', e.message); return false; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // Count the machine-readable surfaces (see usage.js). Hooked on 'finish' rather than inline so
  // one listener covers every route below regardless of how it returns, and so the status is known
  // — a 404 is someone knocking, not usage, and counting it would let anyone inflate the numbers by
  // requesting routes that do not exist.
  const label = normalizePath(path);
  if (label) res.on('finish', () => { if (countable(res.statusCode)) db.recordHit(label, dayOf()); });

  // public data API (keys + tiers + rate limiting)
  if (path.startsWith('/v1')) return handleV1(req, res, u);

  // internal API for the dashboard (same-origin, no key) — coarse per-IP throttle to blunt abuse
  if (path.startsWith('/api/')) {
    if (!apiThrottle(req)) return json(res, { error: 'rate_limited' }, 429);
  }

  // ---- private: what the JavaScript tracker cannot see ----
  // Answers 404 rather than 401 when no token is configured, and on a wrong token. A 401 would
  // confirm the route exists and turn it into something worth guessing at; an unconfigured
  // deployment should look exactly like one that never had the feature.
  if (path === '/api/admin/usage') {
    if (!ADMIN_TOKEN || !adminOk(req, u)) { res.writeHead(404, SEC); return res.end('not found'); }
    const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 30));
    const sinceDay = dayOf() - (days - 1) * 86400;
    const dayMs = 86400000;
    return json(res, {
      windowDays: days,
      since: sinceDay * 1000,
      // Route labels, never raw paths — see usage.js. No IP, no user agent, no key is recorded.
      routes: db.hitsByPath(sinceDay),
      daily: db.hitsByDay(sinceDay),
      keys: {
        total: db.keyTotal(),
        createdLast7d: db.keysCreatedSince(Date.now() - 7 * dayMs),
        createdLast30d: db.keysCreatedSince(Date.now() - 30 * dayMs),
        usedLast7d: db.keysActiveSince(Date.now() - 7 * dayMs),
        // Prefixes only. A key is a credential; the whole point of this route is to tell keys
        // apart, which a prefix does, not to hand them back in readable form.
        recent: db.keysRecent(20).map((k) => ({
          key: keyPrefix(k.key), label: k.label, tier: k.tier,
          created: k.created, requests: k.requests, lastUsed: k.last_used,
        })),
      },
      note: 'Counts calls to /v1, /openapi.json and /llms.txt. Human page views are in Umami; these are the surfaces it cannot see.',
    });
  }
  // TVL is merged in here rather than computed by the indexer: it comes from a separate scan loop on
  // its own cadence, and tvl.total() is a single summed query so the dashboard's polling stays cheap.
  // Chain state is read live rather than taken from the snapshot: the snapshot is only rebuilt on
  // a poll, so a copy taken at boot would still read "unknown" minutes into a long backfill.
  // `index` rides along for the same reason `chain` does: both are read live, and the snapshot they
  // accompany is only rebuilt when a tick completes. Without it the page cannot tell a halted chain
  // from a catch-up, and was captioning the latter 'no blocks being produced' — a false statement
  // about Arc, made by us, on a chain that was running fine.
  if (path === '/api/state') return json(res, { ...live.snapshot, chain: chainStatus(), index: indexProgress(), tvl: TVL_ENABLED ? tvl.total() : null });
  if (path === '/api/alerts') return json(res, { feed: alertFeed });
  if (path === '/api/history') {
    const token = (u.searchParams.get('token') || 'ALL').toUpperCase();
    const r = RANGES[u.searchParams.get('range')] || RANGES['24h'];
    // Anchored to the same instant the snapshot's windows end at — now while live, the last
    // indexed minute once frozen. Charting a span that runs up to now on a halted chain draws an
    // empty plot next to KPIs that show figures, which reads as a broken chart rather than a
    // stopped chain.
    const endSec = Math.floor((live.snapshot.windowEnd || Date.now()) / 1000);
    // Aligned to the bucket grid — see alignToBucket. Every point is a whole interval.
    const since = r.span == null ? 0 : alignToBucket(endSec - r.span, r.group);
    return json(res, {
      token, group: r.group, windowEnd: endSec * 1000,
      // Which table answered, which instant the range asked for, and how far back that table
      // actually reaches. A 90-day range served from a rollup that started last week is a one-week
      // series wearing a 90-day label; `since` vs `recordBegan` is what lets a caller — or our own
      // chart footer — notice that without knowing our retention.
      source: r.daily ? 'daily' : 'minute',
      since,
      recordBegan: r.daily ? db.dailyRecordBegan() : (db.getCoverage().a ?? null),
      series: db.getSeries(token, since, r.group, r.daily),
    });
  }
  if (path === '/api/top') {
    const limit = clampLimit(u.searchParams.get('limit'), 50, 10);
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
      // Over the last seven days, from the retained per-day set — stated in `largestWindowDays` so the
      // page can label it. Read from the rolling transfer table this was "the largest of the last few
      // minutes", which at real throughput is not the claim the heading makes.
      largestWindowDays: 7,
      largest: db.largestByToken(token, 8, Math.floor(Date.now() / 1000) - 7 * 86400).map(dress),
      recent: db.recentByToken(token, 12).map(dress),
      transferWindow: db.recentWindow(),
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
  // The availability record — what the chain did over time, as opposed to what it is doing now.
  // Bounded server-side: the record is permanent, so an unclamped ?days would let a caller ask for
  // a fold over the whole history on every request.
  if (path === '/api/uptime') {
    const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 30));
    return json(res, chainuptime.record({ days }));
  }
  if (path === '/api/health') {
    return json(res, {
      ok: live.snapshot.ok,
      stale: !!live.snapshot.stale,
      // Serving valid history that is no longer advancing, as opposed to serving nothing.
      degraded: !!live.snapshot.degraded,
      booting: !!live.snapshot.booting,
      // The chain's own state, reported separately so an upstream halt is never read as a
      // fault on our side — the two have identical symptoms and opposite remedies. Read live,
      // not from the snapshot, which is only rebuilt when a poll completes.
      chain: chainStatus(),
      // Read live for the same reason `chain` is: everything below comes from the snapshot, which
      // is only rebuilt when a tick completes. During a long catch-up that is precisely never, so
      // `block` and `indexLag` freeze while the indexer works — and a health endpoint that cannot
      // tell "replaying history" from "hung" is not reporting health.
      index: indexProgress(),
      block: live.snapshot.network?.block ?? null,
      indexLag: live.snapshot.indexLag ?? null,
      dataAt: live.snapshot.dataAt ?? null,
      lastError: live.snapshot.lastError ?? null,
    });
  }

  // ---- machine-readable surfaces ----
  // The spec is what an agent reads instead of parsing /docs, and it is what an agent marketplace
  // requires before it will list an API at all. Generated from the live config for the same reason
  // the sitemap below is: a hand-written copy of the token list is a copy that goes stale.
  // Both are text/plain-ish and generated once at boot, so a plain cached response is enough.
  if (path === '/openapi.json') {
    return sendText(req, res, 'openapi', specJson(), 'application/json; charset=utf-8');
  }
  if (path === '/llms.txt') {
    return sendText(req, res, 'llms', llmsTxt(), 'text/plain; charset=utf-8');
  }

  // SEO
  if (path === '/robots.txt') return serveFile(req, res, 'robots.txt', 'text/plain; charset=utf-8');
  // Generated rather than a static file, so adding a protocol to the registry lists it for
  // crawlers with no second step — a hand-maintained sitemap is a hand-maintained omission.
  if (path === '/sitemap.xml') {
    const url = (loc, freq, pri) => `  <url><loc>${SITE_ORIGIN}${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
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
  // Off by default. Enabling it starts posting publicly, so it is an explicit switch — but it is a
  // switch that exists, rather than an export nobody calls.
  if (WATCH_ENABLED) {
    // Staggered off the hour and delayed at boot, so a redeploy never lands a watch pass on top of
    // the initial backfill — the pass would compete with it for the same rate-limited endpoints.
    console.log(`[watch] enabled — checking the chain profile every ${Math.round(WATCH_EVERY_SEC / 60)} min`);
    const pass = async () => {
      try { await runOnce({ quiet: true, watch: true }); }
      catch (e) { console.error('[watch]', e.message || e); }
    };
    setTimeout(() => { pass(); watchTimer = setInterval(pass, WATCH_EVERY_SEC * 1000); }, 120000).unref();
  }
  if (WHALEWATCH_ENABLED) {
    console.log('[whalewatch] enabled — notable transfers will be delivered to Telegram');
    whalewatch.start();
  }
  // Checked hourly rather than scheduled for one instant: a process that happened to be restarting
  // at the scheduled minute would otherwise skip the day entirely, and a deploy is exactly the kind
  // of thing that happens in the morning. The database holds which day was last reported, so the
  // extra checks cost one indexed read and send nothing.
  if (tgConfigured) {
    console.log(`[digest] enabled — daily usage summary after ${String(DIGEST_HOUR).padStart(2, '0')}:00 UTC`);
    const tick = () => { maybeSendDigest().catch((e) => console.error('[digest]', e.message || e)); };
    setTimeout(() => { tick(); digestTimer = setInterval(tick, 3600 * 1000); }, 90000).unref();
  }
});

let watchTimer = null;
let digestTimer = null;
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  stop();                          // stop the live poll loop
  payments.stop();                 // stop the payment poller
  whalewatch.stop();               // stop the notable-transfer poster (no-op when disabled)
  if (watchTimer) clearInterval(watchTimer);  // stop the chain watcher
  if (digestTimer) clearInterval(digestTimer);  // stop the daily digest
  entities.stop();                 // stop the entity derivation loop
  tvl.stop();                      // stop the TVL balance scanner
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(1); }, 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
