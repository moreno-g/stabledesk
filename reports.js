// Weekly reports — dated, frozen publications at /reports.
//
// A report is the opposite of a page. A page shows the chain now; a report records what the chain did
// in a stated week and is not edited after it ships. So its figures are written into its file rather
// than read at request time, and the network it was measured on is recorded with it: a mainnet report
// stays a mainnet report on a server running the testnet profile. The label is still derived — from
// the chain id the report was measured on, never typed into the registry by hand.
//
// The body of each report is an HTML fragment in reports/<slug>.html, read once and kept in memory.
// The fragments ship in the image (see the Dockerfile): a report listed here whose file is missing
// 404s and says so in the log, rather than taking the measurement service down with it.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const NETWORK_LABELS = { 5042: 'Arc mainnet', 5042002: 'Arc testnet' };

// Newest first. The window is seven complete UTC days, both ends inclusive, and the slug is its last
// day. The rule for picking it is fixed — the last seven complete days before publication — so a week
// is never chosen for how it reads.
export const REPORTS = [
  {
    slug: '2026-10-29',
    from: '2026-10-23',
    to: '2026-10-29',
    published: '2026-10-30',
    chainId: 5042,
    title: 'USDC on Arc closed above $1B for the first time',
    summary: 'USDC supply on Arc mainnet closed above $1B on 27 October and more than doubled since 30 September. '
      + 'Cross-chain routes pulled both ways; organic issuance was 74% of the week\'s growth. '
      + 'Raw volume rose 40%, real volume 7%, adjusted volume fell 39%.',
  },
];

export const reportBySlug = (slug) => REPORTS.find((r) => r.slug === slug) || null;
export const networkLabel = (r) => NETWORK_LABELS[r.chainId] || null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
const fmtDay = (iso) => { const { y, m, d } = parts(iso); return `${d} ${MONTHS[m - 1]} ${y}`; };

// "23–29 Oct 2026", or "28 Sept – 4 Oct 2026" when the week crosses a month.
export function windowLabel(r) {
  const a = parts(r.from), b = parts(r.to);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}
export const publishedLabel = (r) => fmtDay(r.published);

const bodies = new Map();
export async function reportBody(r) {
  if (!bodies.has(r.slug)) {
    try {
      bodies.set(r.slug, await readFile(join(__dirname, 'reports', `${r.slug}.html`), 'utf8'));
    } catch (err) {
      console.error(`[reports] ${r.slug} is listed but its body cannot be read: ${err.message}`);
      return null;
    }
  }
  return bodies.get(r.slug);
}

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function indexBody() {
  return REPORTS.map((r) => `<div class="card">
    <p class="kicker">${esc(windowLabel(r))} · ${esc(networkLabel(r))}</p>
    <h3><a href="/reports/${r.slug}">${esc(r.title)}</a></h3>
    <p>${esc(r.summary)}</p>
  </div>`).join('\n  ');
}

// Structured data goes inside a <script> element, where HTML escaping does not apply and would
// corrupt the JSON. "<" is escaped as < instead, so no value can close the element early.
export function jsonLd(origin, r = null) {
  const crumbs = [
    { name: 'Terminal', item: `${origin}/` },
    { name: 'Reports', item: `${origin}/reports` },
    ...(r ? [{ name: windowLabel(r), item: `${origin}/reports/${r.slug}` }] : []),
  ].map((c, i) => ({ '@type': 'ListItem', position: i + 1, ...c }));
  const graph = [{ '@type': 'BreadcrumbList', itemListElement: crumbs }];
  if (r) {
    graph.push({
      '@type': 'Article',
      headline: r.title,
      description: r.summary,
      datePublished: r.published,
      author: { '@type': 'Organization', name: 'Stabledesk', url: origin },
      mainEntityOfPage: `${origin}/reports/${r.slug}`,
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replaceAll('<', '\\u003c');
}
