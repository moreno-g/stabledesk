// Reading the chain for the weekly report: USDC's totalSupply() at the close of each UTC day.
//
// "The close of a day" is the last block stamped before the next midnight UTC. Arc stamps blocks in
// whole seconds, about two per second, so several blocks share each second and "before" is strict: a
// block stamped 00:00:00 already belongs to the next day, on the chain as in the index's day buckets.
// That is what lets the change in supply over a day be compared with that day's mints minus burns.
//
// Nothing here knows a URL or keeps a clock. fetch and sleep are passed in, so the tests replay
// recorded RPC answers and a rate limit costs them no time.

export const USDC = '0x3600000000000000000000000000000000000000';
const TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const DECIMALS = '0x313ce567';     // decimals()

const hex = (n) => '0x' + n.toString(16);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Public RPCs answer a burst with 429, or with a JSON-RPC error saying the same thing. Either one is
// worth waiting out; anything else is an answer, and retrying it would only hide it.
const RETRY_STATUS = new Set([429, 502, 503, 504]);
export const isRateLimit = (e) => e?.code === -32005 || e?.code === 429
  || /rate.?limit|too many requests|limit exceeded|throttl/i.test(String(e?.message ?? ''));

// Retry-After is either seconds or an HTTP date. Only the first is used: a date needs a clock, and the
// backoff below is a fine answer to the rare server that sends one.
const retryAfterMs = (h) => (h != null && /^\d+$/.test(h.trim()) ? Math.min(60000, Number(h) * 1000) : null);

export function makeRpc(url, { fetch = globalThis.fetch, sleep = sleepFor, retries = 6, baseMs = 500, log = () => {} } = {}) {
  let id = 0;
  return async function call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      let why, waitMs = null, res = null;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        why = `${e.name}: ${e.message}`; // a dropped connection or a timeout: transient as well
      }
      if (res) {
        if (RETRY_STATUS.has(res.status)) {
          why = `HTTP ${res.status}`;
          waitMs = retryAfterMs(res.headers?.get?.('retry-after'));
        } else if (!res.ok) {
          throw new Error(`${method}: HTTP ${res.status}`);
        } else {
          const body = await res.json();
          if (!body.error) return body.result;
          if (!isRateLimit(body.error)) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
          why = body.error.message;
        }
      }
      if (attempt >= retries) throw new Error(`${method}: gave up after ${attempt + 1} attempts (${why})`);
      const ms = waitMs ?? baseMs * 2 ** attempt;
      log(`${method}: ${why}, retrying in ${ms} ms`);
      await sleep(ms);
    }
  };
}

export function chainReader(rpc) {
  const blocks = new Map();
  const getBlock = (n) => {
    if (!blocks.has(n)) {
      blocks.set(n, rpc('eth_getBlockByNumber', [hex(n), false]).then((b) => {
        if (!b) throw new Error(`block ${n} not found`);
        return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
      }));
    }
    return blocks.get(n);
  };
  return {
    getBlock,
    chainId: async () => Number(BigInt(await rpc('eth_chainId', []))),
    head: async () => getBlock(Number(BigInt(await rpc('eth_blockNumber', [])))),
    // Micro-dollars, as a BigInt: the comparison with the index is made to the cent, never on a float.
    totalSupply: async (n) => BigInt(await rpc('eth_call', [{ to: USDC, data: TOTAL_SUPPLY }, hex(n)])),
    decimals: async () => Number(BigInt(await rpc('eth_call', [{ to: USDC, data: DECIMALS }, 'latest']))),
  };
}

// The last block stamped before `t` (Unix seconds), by bisection. The search starts from a guess made
// off a block already known — its number and timestamp, and the average time per block — gallops out
// from the guess until the answer is bracketed, then halves the bracket. About ten reads a day, where
// bisecting from block zero would take twenty-five.
export async function lastBlockBefore(t, { getBlock, anchor, head, secondsPerBlock }) {
  if (head.timestamp < t) {
    throw new Error(`the chain has not reached ${new Date(t * 1000).toISOString()} yet (head ${head.number})`);
  }
  const guess = Math.min(head.number, Math.max(0, Math.round(anchor.number + (t - anchor.timestamp) / secondsPerBlock)));
  let lo, hi;
  const first = await getBlock(guess);
  if (first.timestamp < t) {
    lo = first;
    for (let step = 64; ; step *= 2) {
      const next = await getBlock(Math.min(head.number, lo.number + step));
      if (next.timestamp >= t) { hi = next; break; }
      lo = next;
    }
  } else {
    hi = first;
    for (let step = 64; ; step *= 2) {
      if (hi.number === 0) throw new Error(`no block before ${new Date(t * 1000).toISOString()}`);
      const next = await getBlock(Math.max(0, hi.number - step));
      if (next.timestamp < t) { lo = next; break; }
      hi = next;
    }
  }
  // Invariant: lo is stamped before t, hi at or after it.
  while (hi.number - lo.number > 1) {
    const mid = await getBlock(lo.number + Math.floor((hi.number - lo.number) / 2));
    if (mid.timestamp < t) lo = mid; else hi = mid;
  }
  return lo;
}

// ---- recording and replay ----

// A recording maps each call ("method params-as-JSON") to its answer. Blocks keep their number and
// timestamp only, the two fields read here: a full block is mostly a 512-byte bloom filter.
const callKey = (method, params) => `${method} ${JSON.stringify(params)}`;
const trimmed = (method, result) => (method === 'eth_getBlockByNumber' && result ? { number: result.number, timestamp: result.timestamp } : result);

export function recordingFetch(inner, calls) {
  return async (url, init) => {
    const res = await inner(url, init);
    if (!res.ok) return res;
    const req = JSON.parse(init.body);
    const json = await res.json();
    if (!json.error) calls[callKey(req.method, req.params)] = trimmed(req.method, json.result);
    return new Response(JSON.stringify(json), { status: res.status, headers: res.headers });
  };
}

// Answers from a recording, and only from it: a call the recording does not hold is an error, so a
// search that wanders off the recorded path fails instead of passing on invented answers.
export function replayFetch(calls) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    const k = callKey(req.method, req.params);
    const body = Object.hasOwn(calls, k)
      ? { jsonrpc: '2.0', id: req.id, result: calls[k] }
      : { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: `not in the recording: ${k}` } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

// The closing block of a UTC day ("2026-11-05" → the last block before 2026-11-06T00:00:00Z). The first
// anchor is the chain head; every block found becomes one, and each search aims from the known block
// nearest its target, at the block rate between the two nearest known blocks.
export function dayCloser(chain) {
  let head = null, headRate = null;
  const known = [];
  return async function closeOf(day) {
    if (!head) {
      head = await chain.head();
      const back = await chain.getBlock(Math.max(0, head.number - 172800));
      headRate = (head.timestamp - back.timestamp) / (head.number - back.number);
      known.push(head);
    }
    const t = Date.parse(`${day}T00:00:00Z`) / 1000 + 86400;
    const near = [...known].sort((a, b) => Math.abs(a.timestamp - t) - Math.abs(b.timestamp - t));
    const [a, b] = near;
    const local = b && a.number !== b.number ? (a.timestamp - b.timestamp) / (a.number - b.number) : null;
    const secondsPerBlock = local > 0 && Number.isFinite(local) ? local : headRate;
    const block = await lastBlockBefore(t, { getBlock: chain.getBlock, anchor: a, head, secondsPerBlock });
    if (!known.some((k) => k.number === block.number)) known.push(block);
    return block;
  };
}
