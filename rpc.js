// Shared RPC layer for the Arc testnet + chain constants.

export const ENDPOINTS = [
  'https://rpc.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
];

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO = '0x0000000000000000000000000000000000000000';

// Official Arc testnet stablecoin contracts (ERC-20 interface), keyed by lowercase address.
export const TOKENS = {
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6, kind: 'native gas' },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { symbol: 'EURC', decimals: 6, kind: 'euro' },
  '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c': { symbol: 'USYC', decimals: 6, kind: 'yield / MMF' },
};
export const TOKEN_ADDRS = Object.keys(TOKENS);

// Shared, mutable network status (endpoint currently answering).
export const net = { endpoint: ENDPOINTS[0] };

async function rpcBatchOne(endpoint, calls, soft = false) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  const out = new Array(calls.length);
  for (const item of arr) {
    if (item.error) {
      if (!soft) throw new Error(`${calls[item.id]?.method}: ${item.error.message}`);
      out[item.id] = undefined; // soft mode: this slot failed, the rest of the batch stands
      continue;
    }
    out[item.id] = item.result;
  }
  return out;
}

// Try endpoints in order (last good first, Circle primary) until one answers.
async function tryEndpoints(calls, soft) {
  const ordered = [net.endpoint, ...ENDPOINTS.filter((e) => e !== net.endpoint)];
  let lastErr;
  for (const ep of ordered) {
    try {
      const out = await rpcBatchOne(ep, calls, soft);
      net.endpoint = ep;
      return { out, ep };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Strict: any failing sub-request fails the whole batch. What the indexer wants — a missing log
// range is a real problem and must not be silently treated as "no activity".
export const rpc = (calls) => tryEndpoints(calls, false);

// Tolerant: a failing sub-request leaves that slot undefined and the rest of the batch stands.
// Required for probing contracts, where asking an address for a method it doesn't implement
// reverts by design — one expected revert must not discard forty good answers.
export const rpcSoft = (calls) => tryEndpoints(calls, true);

export const hex = (n) => '0x' + n.toString(16);
export const topicAddr = (t) => '0x' + t.slice(-40).toLowerCase();
export const toUnits = (hexStr, decimals) => Number(BigInt(hexStr)) / 10 ** decimals;
