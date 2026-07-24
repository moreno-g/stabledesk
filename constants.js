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
