// Input validation helpers for the public API.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

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

/**
 * Returns an error code string, or null if the webhook URL is acceptable.
 *
 * Synchronous, and therefore limited to what the URL says about itself: scheme, credentials, blocked
 * names, and literal IPs. A *hostname* is not checked here because checking it means resolving it —
 * see validateWebhookHost below, which is what the API actually calls.
 */
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

/**
 * The same checks, plus what the hostname actually resolves to.
 *
 * The literal-IP test above is trivially sidestepped by a name: `https://internal.example.com/hook`
 * passes every syntactic check and can resolve to 127.0.0.1 or 169.254.169.254. The webhook is then a
 * POST from inside the deployment to an address the submitter chose, with the response discarded —
 * blind SSRF, and on a platform with a metadata endpoint that is the one that matters. Redirects were
 * already refused (`redirect: 'error'` at the fetch), but a redirect was never needed for this.
 *
 * Every resolved address must be public: a name with one public and one private answer is refused
 * outright rather than raced against which one fetch happens to pick.
 *
 * This narrows the hole rather than closing it — a name can still be re-pointed after it is validated
 * (DNS rebinding), which only pinning the checked address at connect time would prevent. Refusing a
 * name that resolves privately *now* is the part worth having; the note says what remains.
 */
export async function validateWebhookHost(urlStr, resolver = lookup) {
  const syntactic = validateWebhook(urlStr);
  if (syntactic) return syntactic;
  const host = new URL(String(urlStr)).hostname.toLowerCase();
  if (isIP(host)) return null;               // already checked as a literal above
  let addrs;
  try {
    addrs = await resolver(host, { all: true });
  } catch {
    // A name that does not resolve is not a webhook we can deliver to, and accepting it would store a
    // rule that silently never fires.
    return 'unresolvable_host';
  }
  if (!addrs?.length) return 'unresolvable_host';
  for (const a of addrs) if (isPrivateIp(a.address)) return 'blocked_host';
  return null;
}
