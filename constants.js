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
