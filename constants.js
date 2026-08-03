// Shared constants for the dashboard API and public /v1 API.

import { CHAIN } from './chains.js';

export const RANGES = {
  '1h': { span: 3600, group: 60 },
  '24h': { span: 86400, group: 900 },
  '7d': { span: 604800, group: 3600 },
};

export const TIERS = {
  free: { rpm: 60, maxAlerts: 1 },
  pro: { rpm: 600, maxAlerts: 20 },
};

export const TOKEN_SYMBOLS = new Set(Object.values(CHAIN.tokens).map((t) => t.symbol));
export const TOKEN_LIST = [...TOKEN_SYMBOLS].join(', ');
export const ADDR_RE = /^0x[0-9a-f]{40}$/;

// Transfer-size brackets for the "transaction size distribution" (Visa / Allium style).
export const SIZE_BRACKETS = [
  { label: '<100', min: 0, max: 100 },
  { label: '100–1K', min: 100, max: 1e3 },
  { label: '1K–10K', min: 1e3, max: 1e4 },
  { label: '10K–100K', min: 1e4, max: 1e5 },
  { label: '100K–1M', min: 1e5, max: 1e6 },
  { label: '1M+', min: 1e6, max: Infinity },
];

// Address-level noise filter — the second of the two filters described on /methodology.
// Visa / Allium exclude any address exceeding 1,000 transactions or $10M of volume in a
// month; these are the same thresholds expressed as a *daily rate*, because our retention
// window is a rolling ~7 days rather than a calendar month. The indexer multiplies them by
// however many days of history it actually holds before comparing.
export const NOISE_FILTER = {
  txPerDay: 1000 / 30,       // ≈ 33 transfers/day
  volumePerDay: 10e6 / 30,   // ≈ $333k/day
};

// Chain liveness. A halted chain and a broken indexer produce the same symptom — no fresh
// data — and reporting both as "the indexer is down" blames us for an upstream outage. The
// head block advancing is the discriminator: Arc targets ~0.5s blocks, so a head that hasn't
// moved for a full minute is the chain stopping, not the poll being slow.
export const CHAIN_HALT_MS = 60 * 1000;

// Fee accounting. Exact fees only exist in transaction receipts, and fetching receipts for
// every block (~172k/day at 0.5s blocks) would bury the rate-limited public RPC. Instead we
// sample a few blocks each tick — exact for the blocks sampled — and report the sample size
// alongside every derived rate so the extrapolation is never presented as a measured total.
export const FEE_SAMPLE = {
  blocksPerTick: 3,
  lookback: 12,       // sample window sits this many blocks behind the head
};

// Entity derivation (experimental — see entities.js and /entities). Self-contained: turning
// this off stops the loop and hides the page, leaving the rest of the terminal untouched.
// Volume on Arc is extremely concentrated (measured: the top 20 addresses carry ~92% of it),
// so deriving attributes for a few dozen addresses covers almost all flow.
export const ENTITIES_ENABLED = process.env.ENTITIES_ENABLED !== 'false';
export const ENTITY_TOP_N = 40;          // addresses to derive, by volume rank
export const ENTITY_REFRESH_MS = 10 * 60 * 1000;
export const ENTITY_WARMUP_MS = 20 * 1000;   // retry cadence until the indexer has rankings
export const DERIVE_CHUNK = 8;               // addresses per RPC batch (the public endpoint rate-limits large ones)
export const DERIVE_DELAY = 600;             // ms between batches

// TVL scanning (see tvl.js and /ecosystem). Batch shape mirrors entity derivation, which is the
// one already proven against the rate-limited public RPC: TVL_CHUNK holders × one call per indexed
// stablecoin per batch, spaced by TVL_DELAY. With three tokens that is 24 calls a batch.
export const TVL_ENABLED = process.env.TVL_ENABLED !== 'false';
export const TVL_REFRESH_MS = 5 * 60 * 1000;
export const TVL_WARMUP_MS = 25 * 1000;      // retry cadence until the indexer has rankings
export const TVL_CHUNK = 8;
export const TVL_DELAY = 600;
export const TVL_MAX_TARGETS = 600;          // ceiling on contracts scanned per pass
// Minimum balance for an unregistered contract to be worth naming. Scaled off the network's own
// notability threshold, because "a balance worth investigating" means something very different
// with faucet money than with real deposits.
export const TVL_CANDIDATE_MIN = Math.max(1, Math.round(CHAIN.notableMin / 10));

// Daily rankings (see rankings.js). The move threshold exists so the digest reports movement
// rather than rounding noise — a protocol drifting 0.2% is not news.
export const RANKING_TOP_N = 5;
export const RANKING_MIN_MOVE_PCT = 0.02;

// Crypto billing (Pro tier) — paid in native USDC on Base, since Arc is still testnet
// (its USDC has no real value). Verified live against Base mainnet: chainId 8453,
// USDC contract responds symbol()="USDC", decimals()=6.
//
// Off by default (opt-in via env var) — the flow is fully built and proven, but not
// announced yet. The payment poller itself keeps running regardless (so anything already
// sent still gets credited); this flag only gates *creating new* orders and the public UI.
export const BILLING_ENABLED = process.env.BILLING_ENABLED === 'true';
export const BASE_CHAIN_ID = 8453;
export const BASE_RPC_ENDPOINTS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
];
export const BASE_USDC = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 };
// Receiving address — self-custodied by the operator; this server only ever reads its balance/logs.
export const PAYMENT_RECEIVE_ADDRESS = '0x06ed94D5Fd3392989C8A3dEE30196e1D1beabb05';
export const PRO_PRICE_USD = 29;
export const PRO_DURATION_DAYS = 30;
export const ORDER_EXPIRY_MS = 2 * 60 * 60 * 1000; // unpaid orders (and their unique amount) expire after 2h
