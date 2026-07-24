// Input validation helpers for the public API.

import { isIP } from 'node:net';

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const h = ip.toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:') || h.startsWith('fec0:')) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // unique local (fc00::/7)
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => n > 255 || n < 0 || Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

/** Returns an error code string, or null if the webhook URL is acceptable. */
export function validateWebhook(urlStr) {
  let u;
  try { u = new URL(String(urlStr)); } catch { return 'invalid_url'; }
  if (u.protocol !== 'https:') return 'https_required';
  if (u.username || u.password) return 'credentials_not_allowed';
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) return 'blocked_host';
  const ver = isIP(host);
  if (ver && isPrivateIp(host)) return 'blocked_host';
  return null;
}
