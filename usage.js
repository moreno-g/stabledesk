// Server-side usage counting for the surfaces a JavaScript tracker cannot see.
//
// Umami measures a human loading an HTML page. This project's product is an API, so the traffic
// that matters most is invisible to it: a script calling /v1, an agent fetching /openapi.json or
// /llms.txt to discover the API, a CSV export. None of those run JavaScript, none of them fire a
// beacon, and today none of them leave a trace. The first real signal this project can expect
// before mainnet is not a visitor — it is a machine reading the spec.
//
// Two deliberate limits.
//
// Paths are normalised to a route label, never stored raw. `/v1/addresses/0xabc…/transfers` is
// recorded as `/v1/addresses`, so the table cannot grow one row per address queried — and an
// address someone looked up is not something worth keeping either way.
//
// Nothing identifying is recorded. No IP, no user agent, no key. The table answers "how many calls
// hit this route today", which is a measure of usage, not of people. Never having the identifier is
// a stronger guarantee than holding it and promising restraint.

// A label keeps the route's real shape and replaces only the parts that are parameters.
//
// Collapsing to two segments was the first attempt and it was wrong: it merged /v1/tvl with
// /v1/tvl/history, and /v1/addresses/top with /v1/addresses/filtered — which is precisely the
// distinction the counter exists to show. Knowing that /v1 was called 400 times is not useful;
// knowing which endpoint was called is the whole question.
//
// What keeps the table bounded is therefore not truncation but two other things: addresses and
// ids are replaced by a placeholder, so a row cannot be created per address looked up, and only
// successful responses are counted, so a route that does not exist 404s and writes nothing. A
// stranger cannot invent a row without first inventing an endpoint that answers.
const MAX_LABEL = 60;
const MAX_SEGMENTS = 4;

// The parameter shapes that actually appear in a path here: an EVM address, and a bare number.
// Everything else is a route name, which is a fixed vocabulary.
const isParam = (seg) => /^0x[0-9a-fA-F]{6,}$/.test(seg) || /^\d+$/.test(seg);

export function normalizePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  if (pathname === '/openapi.json' || pathname === '/llms.txt') return pathname;
  if (pathname !== '/v1' && !pathname.startsWith('/v1/')) return null;

  const parts = pathname.split('/').filter(Boolean).slice(0, MAX_SEGMENTS);
  const label = '/' + parts.map((seg, i) => {
    if (i === 0) return seg.toLowerCase();
    if (isParam(seg)) return ':id';
    return seg.toLowerCase();
  }).join('/');

  // A route name is a fixed vocabulary, so it can only contain what a route name contains.
  // Anything else is someone probing, and it must not reach the table at all.
  if (!/^\/v1(\/(:id|[a-z0-9._-]+))*$/.test(label)) return null;
  return label.slice(0, MAX_LABEL);
}

// UTC midnight for a timestamp, in seconds — the bucket a hit is counted into. UTC rather than
// local time so the series does not shift by an hour twice a year, and so a day means the same
// thing to a reader in another timezone.
export const dayOf = (ms = Date.now()) => Math.floor(ms / 86400000) * 86400;

// Whether a response is worth counting. A 404 or a 401 is not usage, it is someone knocking — and
// counting failures would let anyone inflate the numbers by requesting routes that do not exist.
// This is also what bounds the table: an invented route answers 404 and writes nothing.
export const countable = (status) => Number.isInteger(status) && status >= 200 && status < 400;

// A key is a credential. It is never sent anywhere, never logged, and never returned by the admin
// route — only this prefix is, which is enough to tell two keys apart and useless to a thief.
export const keyPrefix = (key) => (typeof key === 'string' && key.startsWith('sbd_') ? key.slice(0, 12) + '…' : '—');
