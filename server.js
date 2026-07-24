// Arc Stablecoin Terminal — HTTP server.
// Serves the dashboard, the internal /api used by it, the public /v1 API, and /docs.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as db from './db.js';
import { live, alertFeed, start } from './indexer.js';
import { getLabel } from './labels.js';
import { handleV1 } from './api.js';
import { RANGES, ADDR_RE } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4317;

function json(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function serveFile(res, name, type = 'text/html; charset=utf-8') {
  try {
    const buf = await readFile(join(__dirname, 'public', name));
    res.writeHead(200, { 'content-type': type });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  // public data API (keys + tiers + rate limiting)
  if (path.startsWith('/v1')) return handleV1(req, res, u);

  // internal API for the dashboard (same-origin, no key)
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

  // static assets + pages
  if (path === '/theme.js') return serveFile(res, 'theme.js', 'text/javascript');
  if (path === '/docs' || path === '/docs.html') return serveFile(res, 'docs.html');
  return serveFile(res, 'index.html');
});

server.listen(PORT, () => {
  console.log(`Stabledesk → http://localhost:${PORT}`);
  if (!db.getKey('sbd_demo')) db.createKey('sbd_demo', 'Public demo key', 'free');
  start();
});

function shutdown() {
  console.log('\nShutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
