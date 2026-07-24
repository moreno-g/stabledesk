// Shared constants for the dashboard API and public /v1 API.

export const RANGES = {
  '1h': { span: 3600, group: 60 },
  '24h': { span: 86400, group: 900 },
  '7d': { span: 604800, group: 3600 },
};

export const TIERS = {
  free: { rpm: 60, maxAlerts: 1 },
  pro: { rpm: 600, maxAlerts: 20 },
};

export const TOKEN_SYMBOLS = new Set(['USDC', 'EURC', 'USYC']);
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
