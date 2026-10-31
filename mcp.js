// MCP endpoint (/mcp) — the same figures as /v1, for AI assistants.
//
// An assistant asked "how much USDC really moved on Arc this week?" today has block explorers and
// price feeds to work with, so it sums Transfer events: exactly the overcount the method exists to
// correct. This endpoint hands it the measured figures instead, each with its network, its window
// and the /v1 URL that reproduces it.
//
// Read-only and keyless. Every tool answers by reading /v1 in-process (handleV1 with `internal`), so
// a figure here is always the figure the public API serves — there is no second implementation of
// any number to drift. Address-level tools are deliberately absent: the site keeps address profiles
// out of search indexes for the reason given in server.js, and a tool would be one prompt away.
//
// Two eras of the protocol, both served from this one path:
//   - 2026-07-28 ("modern"): no handshake. Every request carries its protocol version in an
//     MCP-Protocol-Version header and in params._meta, plus Mcp-Method (and Mcp-Name for a tool call)
//     headers; the server answers server/discover. Results carry resultType.
//   - 2025-11-25, 2025-06-18, 2025-03-26 ("legacy"): initialize / notifications/initialized, then
//     tools/list and tools/call, with no per-request metadata.
// Claude's connector directory still documents the legacy schema while the specification has moved
// on, and dropping either would turn away clients that work today.

import { readFileSync } from 'node:fs';
import { handleV1, clientIp, rateLimit, BODY_MAX } from './api.js';
import * as db from './db.js';
import { dayOf } from './usage.js';
import { RANGES, TOKEN_SYMBOLS, SITE_ORIGIN } from './constants.js';
import { CHAIN } from './chains.js';

export const MODERN = '2026-07-28';
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED = [MODERN, ...LEGACY];

// How long a client may cache tools/list and server/discover. The tool set changes with a deploy,
// not between requests, and it is the same for every caller.
const TTL_MS = 3600000;

// Per client address. Claude's connector traffic leaves from Anthropic's own range, so every Claude
// user of this endpoint shares one or a few addresses: the limit is set for that, not for one person.
export const MCP_RPM = Math.max(1, Number(process.env.MCP_RPM) || 300);

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export const NETWORK = CHAIN.isTestnet ? 'Arc testnet' : 'Arc mainnet';

export const SERVER_INFO = {
  name: 'stabledesk',
  title: 'Stabledesk',
  version: VERSION,
  description: `Stablecoin measurement for ${NETWORK}: supply, real volume, cross-chain flows, TVL and fees, read from the chain with a published method.`,
  websiteUrl: SITE_ORIGIN,
};

export const INSTRUCTIONS = [
  `Stabledesk measures stablecoins on ${NETWORK} (chain ${CHAIN.chainId}) from chain data, with every rule published at ${SITE_ORIGIN}/methodology.`,
  'Volume comes in three measures — raw (every Transfer event, mints and burns included), real (the largest transfer per transaction per token, so routing hops are not counted twice; mints and burns are left out, published as mint and burn) and adjusted (real, minus transfers where both ends are infrastructure). Say which one you quote; raw overstates activity.',
  'A CCTP or Circle Gateway mint is USDC changing chains, not new issuance; organic issuance is what remains once both are removed.',
  'Quote figures with the network and the window they cover, and link the methodology. Amounts are face value in the currency stated (USD, EUR, GBP) and never summed across currencies.',
  'Read-only, informational figures — not investment advice.',
].join(' ');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tokens = () => [...TOKEN_SYMBOLS];
const ranges = Object.keys(RANGES);

// Argument checks return a sentence for the model to act on, or null. A vague error makes an
// assistant guess; naming the accepted values lets it correct itself in one step.
const oneOf = (name, values, v) => (v == null || values.includes(v) ? null : `${name} must be one of: ${values.join(', ')} (got ${JSON.stringify(v)}).`);
const intIn = (name, lo, hi, v) => (v == null || (Number.isInteger(v) && v >= lo && v <= hi) ? null : `${name} must be an integer from ${lo} to ${hi} (got ${JSON.stringify(v)}).`);

const tool = (name, title, description, properties, required, toPath, check = () => null) => ({
  def: {
    name,
    title,
    description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: { title, ...READ_ONLY },
  },
  toPath,
  check,
});

export const TOOLS = [
  tool('arc_status', 'Index and chain status',
    `Whether Stabledesk is live on ${NETWORK}: the network and chain id, chain liveness, how far the index is behind the head, and the instant every rolling window currently ends at. Call it first when a figure looks stale.`,
    {}, [], () => ['/v1/status']),

  tool('stablecoin_supply', 'Stablecoin supply and 24h activity',
    `Supply of every tracked stablecoin on ${NETWORK}, grouped by the currency it is denominated in, plus the last 24 hours: raw, real and adjusted volume, transfers, mint and burn, and the parts that came through CCTP and Circle Gateway. coverage states how much history backs the 24h figures.`,
    {}, [], () => ['/v1/stablecoins']),

  tool('stablecoin_detail', 'One stablecoin in detail',
    'One token: supply and velocity, its 24h summary, net issuance and organic net issuance (cross-chain routes removed), CCTP and Gateway mint/burn, and the transfer-size distribution.',
    { token: { type: 'string', description: 'Token symbol.', enum: tokens() } }, ['token'],
    (a) => [`/v1/stablecoins/${a.token}`],
    (a) => (a.token == null ? `token is required: one of ${tokens().join(', ')}.` : oneOf('token', tokens(), a.token))),

  tool('stablecoin_history', 'Volume, mint and burn over time',
    'A time series of volume (raw: volume, real: rvolume, adjusted: avolume), transfers, mint and burn, with the CCTP part (cmint/cburn) and the Gateway part (bmint/bburn). Bucket size follows the range: 1h → 1 minute, 24h → 15 minutes, 7d → 1 hour, 30d and longer → 1 UTC day. Daily buckets are closed days that can be fetched again and give the same answer. windowEnd states the instant the series ends at. series comes as { columns, rows }: the /v1 values, with the field names listed once; t is the bucket start in Unix seconds. The 30d default is the smallest answer; 7d is the largest.',
    {
      token: { type: 'string', description: 'Token symbol, or ALL for every tracked token in the base currency (USD on Arc) — never other currencies added in. The response names the denomination and the tokens.', enum: ['ALL', ...tokens()], default: 'ALL' },
      range: { type: 'string', description: 'How far back the series reaches.', enum: ranges, default: '30d' },
    }, [],
    (a) => ['/v1/stablecoins/history', { token: a.token ?? 'ALL', range: a.range ?? '30d' }],
    (a) => oneOf('token', ['ALL', ...tokens()], a.token) || oneOf('range', ranges, a.range)),

  tool('cctp_flows', 'Cross-chain flows through CCTP',
    `USDC and EURC arriving on ${NETWORK} from, and leaving it for, other chains through Circle CCTP V2 — per token, with the chain on the other side. A CCTP mint is not issuance and a CCTP burn is not a redemption.`,
    { range: { type: 'string', description: 'Rolling window.', enum: ['24h', '7d'], default: '24h' } }, [],
    (a) => ['/v1/cctp', { range: a.range ?? '24h' }],
    (a) => oneOf('range', ['24h', '7d'], a.range)),

  tool('ecosystem_tvl', 'Total value locked, chain-wide',
    `Stablecoin TVL on ${NETWORK}, measured as balances held by contracts, in the base denomination with other currencies beside it, plus every protocol holding a balance (with the ids protocol_detail and tvl_history accept). coverage says whether the scan reached every known contract.`,
    {}, [], () => ['/v1/tvl']),

  tool('protocol_detail', 'One protocol',
    'One protocol from the registry: its contracts, measured TVL per token and per currency, recent volume, category and where its address list comes from. Ids come from ecosystem_tvl.',
    { id: { type: 'string', description: 'Protocol id, e.g. aave-v4.', pattern: '^[a-z0-9-]{1,40}$' } }, ['id'],
    (a) => [`/v1/protocols/${a.id}`],
    (a) => (typeof a.id === 'string' && /^[a-z0-9-]{1,40}$/.test(a.id) ? null : 'id must be a protocol id such as "aave-v4" — lowercase letters, digits and hyphens; ecosystem_tvl lists them.')),

  tool('tvl_history', 'TVL over time',
    'Daily TVL, chain-wide or for one protocol, in one currency (the base denomination, stated in the response), as { columns, rows }. The series starts on 28 September 2026, when TVL stopped adding euros to dollars and stopped counting smart-contract wallets.',
    {
      protocol: { type: 'string', description: 'Protocol id, or * for the chain total.', default: '*' },
      days: { type: 'integer', description: 'Days of history, 1 to 180.', minimum: 1, maximum: 180, default: 30 },
    }, [],
    (a) => ['/v1/tvl/history', { protocol: a.protocol ?? '*', days: a.days ?? 30 }],
    (a) => intIn('days', 1, 180, a.days) || (a.protocol == null || a.protocol === '*' || /^[a-z0-9-]{1,40}$/.test(a.protocol) ? null : 'protocol must be * or a protocol id from ecosystem_tvl.')),

  tool('network_fees', 'Fee economics, in dollars',
    `What it costs to use ${NETWORK}. Gas is paid in USDC, so fees are dollar amounts read from transaction receipts with no price feed: per transaction (mean and median), per block, per day, and the cost to move $1M of value.`,
    {}, [], () => ['/v1/network/fees']),

  tool('largest_transfers', 'Largest transfers',
    'The largest stablecoin transfers over the last N days, from the retained per-day set, with the window stated.',
    {
      days: { type: 'integer', description: 'Window in days, 1 to 180.', minimum: 1, maximum: 180, default: 7 },
      limit: { type: 'integer', description: 'How many transfers, 1 to 50.', minimum: 1, maximum: 50, default: 20 },
    }, [],
    (a) => ['/v1/transfers/largest', { days: a.days ?? 7, limit: a.limit ?? 20 }],
    (a) => intIn('days', 1, 180, a.days) || intIn('limit', 1, 50, a.limit)),

  tool('chain_uptime', 'Chain availability record',
    `How available ${NETWORK} has been, from Stabledesk's log of observed state changes. Read coveragePct before uptimePct: uptime is a share of the time Stabledesk was actually watching, and hours it was not are reported as unobserved rather than as up or down.`,
    { days: { type: 'integer', description: 'Window in days, 1 to 365.', minimum: 1, maximum: 365, default: 30 } }, [],
    (a) => ['/v1/chain/uptime', { days: a.days ?? 30 }],
    (a) => intIn('days', 1, 365, a.days)),
];
const byName = new Map(TOOLS.map((t) => [t.def.name, t]));

// A series of objects repeats every field name in every bucket: 168 hourly buckets of fifteen fields
// is 50 KB from /v1, read into an assistant's context twice (text and structured). Sent as columns and
// rows instead — the same values, in the same order, with the names once. Absent stays null, never 0.
export function compactSeries(data) {
  const s = data?.series;
  if (!Array.isArray(s) || !s.length || typeof s[0] !== 'object' || s[0] === null) return data;
  const columns = [...new Set(s.flatMap((row) => Object.keys(row)))];
  return { ...data, series: { columns, rows: s.map((row) => columns.map((c) => row[c] ?? null)) } };
}

// The same handler the public API runs, called in-process. The response object only has to catch
// one writeHead and one end, which is all json() in api.js does.
export async function readV1(path, params = {}) {
  const u = new URL(path, 'http://internal');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  let code = 0, text = '';
  const res = { writeHead(c) { code = c; return res; }, end(s = '') { text = String(s); } };
  await handleV1({ method: 'GET', headers: {}, socket: {} }, res, u, { internal: true });
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { code, data, url: `${u.pathname}${u.search}` };
}

export async function callTool(name, args = {}) {
  const t = byName.get(name);
  const problem = t.check(args);
  if (problem) return { content: [{ type: 'text', text: problem }], isError: true };

  const [path, params] = t.toPath(args);
  const { code, data, url } = await readV1(path, params);
  if (code !== 200) {
    // The /v1 error already carries a hint ("Data warming up, retry shortly.", "See /v1/protocols
    // for the list of ids."); passed through rather than flattened into "request failed".
    const hint = data?.hint || data?.error || `HTTP ${code}`;
    return { content: [{ type: 'text', text: `${name} could not answer: ${hint}` }], isError: true };
  }
  const structured = {
    network: NETWORK,
    chainId: CHAIN.chainId,
    method: `${SITE_ORIGIN}/methodology`,
    // The public request that returns these same figures, for anyone who wants to check them.
    reproduce: `${SITE_ORIGIN}${url}${url.startsWith('/v1/status') ? '' : ' (with a free key, see /docs)'}`,
    data: compactSeries(data),
  };
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

// ---- JSON-RPC over Streamable HTTP ----

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

const metaVersion = (msg) => msg?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];

// One parsed message in, { status, body } out — body null for 202. Headers are passed as Node gives
// them (lowercase keys). Pure apart from the tool calls, so the protocol rules are testable directly.
export async function handleMessage(msg, headers = {}) {
  if (Array.isArray(msg)) return { status: 400, body: rpcError(null, -32600, 'Batching is not supported: send one JSON-RPC message per request.') };
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return { status: 400, body: rpcError(msg?.id, -32600, 'Not a JSON-RPC 2.0 message.') };

  // A response or a notification gets no body. This server never sends requests, so a response is
  // only ever stray, and the one notification a client sends (notifications/initialized) needs none.
  if (typeof msg.method !== 'string') return { status: 202, body: null };
  if (msg.id === undefined) return { status: 202, body: null };

  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  if (method === 'initialize') {
    const asked = params.protocolVersion;
    return {
      status: 200,
      body: rpcResult(id, {
        // The requested version if it is one this server speaks, otherwise the newest legacy one —
        // the client then decides whether it can continue.
        protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }),
    };
  }

  const headerVersion = headers['mcp-protocol-version'], bodyVersion = metaVersion(msg);
  if (headerVersion != null && bodyVersion != null && headerVersion !== bodyVersion) {
    return { status: 400, body: rpcError(id, -32020, `The MCP-Protocol-Version header (${headerVersion}) and params._meta protocolVersion (${bodyVersion}) must be equal.`) };
  }
  // No version at all is a 2025-03-26 client, which predates the header.
  const version = headerVersion ?? bodyVersion;
  const modern = version === MODERN;
  if (version != null && !SUPPORTED.includes(version)) {
    return { status: 400, body: rpcError(id, -32022, `Unsupported protocol version ${version}.`, { supported: SUPPORTED, requested: version }) };
  }

  if (modern) {
    // Every rule here is a MUST in 2026-07-28: the header is present, the body carries the client's
    // metadata (the two versions were compared above), and the routing headers match the body.
    if (headerVersion == null) {
      return { status: 400, body: rpcError(id, -32020, 'The MCP-Protocol-Version header is required on every request.') };
    }
    if (bodyVersion == null || params._meta?.['io.modelcontextprotocol/clientCapabilities'] == null) {
      return { status: 400, body: rpcError(id, -32602, 'params._meta must carry io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities.') };
    }
    if (headers['mcp-method'] !== method) return { status: 400, body: rpcError(id, -32020, `Mcp-Method header must equal the method (${method}).`) };
    if (method === 'tools/call' && headers['mcp-name'] !== params.name) {
      return { status: 400, body: rpcError(id, -32020, 'Mcp-Name header must equal params.name for tools/call.') };
    }
  }
  const done = (r) => (modern ? { resultType: 'complete', ...r } : r);

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        ttlMs: TTL_MS,
        cacheScope: 'public',
        instructions: INSTRUCTIONS,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'ping' && !modern) return { status: 200, body: rpcResult(id, {}) };
  if (method === 'tools/list') {
    const tools = TOOLS.map((t) => t.def);
    return { status: 200, body: rpcResult(id, modern ? done({ tools, ttlMs: TTL_MS, cacheScope: 'public' }) : { tools }) };
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (!byName.has(name)) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${String(name)}. tools/list names the ${TOOLS.length} available.`) };
    }
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    return { status: 200, body: rpcResult(id, done(await callTool(name, args))), tool: name };
  }
  return { status: modern ? 404 : 200, body: rpcError(id, -32601, `Method not found: ${method}.`) };
}

// What a present Origin may be. The data is public and nothing here trusts ambient credentials, so
// DNS rebinding — the attack the rule exists for — has nothing to reach; the check still turns away
// the origins no legitimate client sends: "null" (sandboxed or file pages) and anything not http(s).
export function originAllowed(origin) {
  if (origin == null) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'access-control-max-age': '86400',
};
const SEC = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

function send(res, status, body) {
  const s = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SEC, ...CORS, ...(body == null ? {} : { 'content-type': 'application/json' }) });
  res.end(s);
}

// The raw body, so a parse failure can be told apart from an empty object (readBody in api.js
// folds both into {}). Settles on every terminal event, for the reason readBody's comment gives.
function readRaw(req) {
  return new Promise((resolve) => {
    // Decoded as a stream, so a multi-byte character split across two chunks arrives whole.
    req.setEncoding('utf8');
    let d = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      if (done) return;
      d += c;
      if (d.length > BODY_MAX) { req.pause(); finish(null); }
    });
    req.on('end', () => finish(d));
    req.on('aborted', () => finish(''));
    req.on('error', () => finish(''));
  });
}

// A successful exchange, counted like the /v1 routes are (usage.js): a route label, never a payload.
// A tool name is only counted after it has been found in the registry, so the vocabulary is fixed.
const count = (label) => { try { db.recordHit(label, dayOf()); } catch (e) { console.error('[mcp] usage count failed:', e.message); } };

export async function handleMcp(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (!originAllowed(req.headers.origin)) return send(res, 403, rpcError(null, -32600, 'Origin not allowed.'));
  if (req.method !== 'POST') {
    // No server-to-client stream is offered, in either era.
    res.writeHead(405, { ...SEC, ...CORS, allow: 'POST, OPTIONS', 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32600, 'This endpoint takes JSON-RPC over POST only.')));
  }
  const lim = rateLimit(`mcp:${clientIp(req)}`, MCP_RPM);
  if (!lim.ok) {
    res.writeHead(429, { ...SEC, ...CORS, 'retry-after': '60', 'content-type': 'application/json' });
    return res.end(JSON.stringify(rpcError(null, -32000, `Rate limited: ${MCP_RPM} requests per minute per client address. Retry in a minute.`)));
  }

  const raw = await readRaw(req);
  if (raw == null) return send(res, 413, rpcError(null, -32600, `Request body must be under ${BODY_MAX} bytes.`));
  let msg;
  try { msg = JSON.parse(raw); } catch { return send(res, 400, rpcError(null, -32700, 'Parse error: the body is not valid JSON.')); }

  const out = await handleMessage(msg, req.headers);
  // Handshakes and listings count as /mcp, a tool call as /mcp/<tool>. A call that ended in an error
  // is not usage, for the same reason a 404 on /v1 is not.
  if (out.status === 200 && out.body?.result) {
    if (!out.tool) count('/mcp');
    else if (!out.body.result.isError) count(`/mcp/${out.tool}`);
  }
  return send(res, out.status, out.body);
}
