// Crypto billing poller — watches Base mainnet for USDC payments to the Stabledesk
// receiving address, matches each transfer to a pending order by its exact (uniquified)
// amount, and upgrades the paying key to Pro. No custody: we only ever read the chain.

import * as db from './db.js';
import { BASE_RPC_ENDPOINTS, BASE_USDC, PAYMENT_RECEIVE_ADDRESS, PRO_DURATION_DAYS, ORDER_EXPIRY_MS } from './constants.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TO_TOPIC = '0x' + '0'.repeat(24) + PAYMENT_RECEIVE_ADDRESS.slice(2).toLowerCase();

const POLL_MS = 20000;   // Base blocks are ~2s; no need to poll faster than this
const MAX_RANGE = 2000;  // blocks per eth_getLogs call, conservative for public RPCs
const RANGE_DELAY = 250; // ms between ranges when closing a gap
const CP_KEY = 'base_payment_checkpoint';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let endpoint = BASE_RPC_ENDPOINTS[0];

async function rpc(method, params) {
  const ordered = [endpoint, ...BASE_RPC_ENDPOINTS.filter((e) => e !== endpoint)];
  let lastErr;
  for (const ep of ordered) {
    try {
      const res = await fetch(ep, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error.message);
      endpoint = ep;
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const hex = (n) => '0x' + n.toString(16);

async function getLogsRange(from, to) {
  return rpc('eth_getLogs', [{
    fromBlock: hex(from), toBlock: hex(to),
    address: BASE_USDC.address,
    topics: [TRANSFER_TOPIC, null, TO_TOPIC], // only Transfer events TO our address
  }]);
}

// Amounts are compared as integer micro-USDC (BigInt) — never as floats — so a payment
// can never silently mismatch an order due to binary floating-point rounding.
export function processLogs(logs) {
  if (!logs?.length) return;
  const pending = db.pendingOrders();
  if (!pending.length) return;
  const byMicro = new Map(pending.map((o) => [BigInt(Math.round(o.amount * 1e6)), o]));
  for (const log of logs) {
    let micro;
    try { micro = BigInt(log.data); } catch { continue; }
    const order = byMicro.get(micro);
    if (!order) continue; // a transfer landed that doesn't match any pending order's exact amount
    if (!db.markOrderPaid(order.id, log.transactionHash)) continue; // already settled (race-safe)
    const expiresAt = db.upgradeToPro(order.key, PRO_DURATION_DAYS);
    console.log(`[payments] order ${order.id} paid (tx ${log.transactionHash}) → key upgraded to pro until ${new Date(expiresAt).toISOString()}`);
  }
}

async function tickOnce() {
  try {
    const latest = parseInt(await rpc('eth_blockNumber', []), 16);
    const cp = db.getMetaValue(CP_KEY);
    // No backfill on first boot — payments before Stabledesk existed are irrelevant.
    let from = cp != null ? Number(cp) + 1 : latest;
    if (from > latest) { db.setMetaValue(CP_KEY, latest); }
    else {
      for (let start = from; start <= latest; start += MAX_RANGE) {
        const end = Math.min(latest, start + MAX_RANGE - 1);
        processLogs(await getLogsRange(start, end));
        db.setMetaValue(CP_KEY, end);
        // Base is a rate-limited public RPC too, and closing a long gap (a day of downtime is ~43k
        // blocks, i.e. 22 requests) should not arrive as a burst.
        if (end < latest) await sleep(RANGE_DELAY);
      }
    }
    db.expireStaleOrders(Date.now() - ORDER_EXPIRY_MS);
  } catch (e) {
    console.error('[payments]', e.message || e);
  }
}

// setInterval fires on schedule whether or not the previous call has returned, and this one can run
// long: after any stretch of downtime the first tick walks every block since the checkpoint. Two
// overlapping walks both read the checkpoint, both re-scan ranges the other is working through, and
// each writes back an `end` the other has already passed — so the checkpoint can move *backwards*.
// Credit itself is safe (markOrderPaid only settles a still-pending order, and only once), which is
// exactly why this stayed invisible. Guarded anyway: this is the path that grants paid access, and
// the same guard already exists a file away for the same reason.
const tick = nonReentrant(tickOnce);

// Local rather than imported from indexer.js: the payment poller has no other reason to pull in the
// indexer's module graph, and a shared 8-line guard is not worth that coupling on the money path.
function nonReentrant(fn) {
  let running = false;
  return async (...args) => {
    if (running) return false;
    running = true;
    try { await fn(...args); return true; } finally { running = false; }
  };
}

let timer = null;
export async function start() {
  await tick();
  timer = setInterval(tick, POLL_MS);
}
export function stop() { if (timer) { clearInterval(timer); timer = null; } }
