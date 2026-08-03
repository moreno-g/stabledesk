// Shared RPC layer for Arc. Which network it talks to comes from chains.js (ARC_NETWORK).

import { CHAIN } from './chains.js';
import { RPC_AUTH_STATUSES } from './constants.js';

export const ENDPOINTS = CHAIN.endpoints;

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO = '0x0000000000000000000000000000000000000000';

// Official Arc stablecoin contracts (ERC-20 interface), keyed by lowercase address.
export const TOKENS = CHAIN.tokens;
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
  if (!res.ok) {
    // The status rides along on the error: "refused us" and "did not answer" are the same
    // symptom upstream and completely different faults, and only the code tells them apart.
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
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
  // Only when *every* endpoint answered and refused us is this a credentials problem. If even one
  // failed at the network level, the network is involved too and we can't blame the key alone.
  let allAuth = true;
  for (const ep of ordered) {
    try {
      const out = await rpcBatchOne(ep, calls, soft);
      net.endpoint = ep;
      return { out, ep };
    } catch (e) {
      lastErr = e;
      if (!RPC_AUTH_STATUSES.has(e?.status)) allAuth = false;
    }
  }
  if (lastErr) lastErr.allAuth = allAuth;
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
