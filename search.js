// Global search — one box over protocols, tokens and addresses.
//
// Shared by /api/search and /v1/search so the internal and public results can never drift apart.
// Everything here reads already-indexed state; there is no network call on the search path.

import * as db from './db.js';
import { PROTOCOLS, publicShape, protocolForAddress } from './protocols.js';
import { getLabel } from './labels.js';
import { CHAIN } from './chains.js';
import { ADDR_RE } from './constants.js';

const HEX_PREFIX = /^0x[0-9a-f]{2,39}$/;

export function search(raw, limit = 10) {
  const q = String(raw || '').trim().toLowerCase();
  const out = { query: q, protocols: [], tokens: [], addresses: [] };
  if (q.length < 2) return out;

  // Protocols: name, id, vendor, category and description, in that order of confidence. Sorted by
  // where the match landed so "circle" ranks the issuer above anything merely mentioning it.
  const scored = [];
  for (const p of PROTOCOLS) {
    const name = p.name.toLowerCase();
    let score = 0;
    if (name === q || p.id === q) score = 100;
    else if (name.startsWith(q) || p.id.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if ((p.vendor || '').toLowerCase().includes(q)) score = 40;
    else if (p.category.includes(q)) score = 30;
    else if ((p.desc || '').toLowerCase().includes(q)) score = 10;
    if (score) scored.push({ score, p });
  }
  out.protocols = scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map(({ p }) => {
      const s = publicShape(p);
      return { id: s.id, name: s.name, category: s.category, categoryLabel: s.categoryLabel, vendor: s.vendor, verified: s.verified };
    });

  for (const [address, t] of Object.entries(CHAIN.tokens)) {
    const sym = t.symbol.toLowerCase();
    if (sym.includes(q) || q.includes(sym)) out.tokens.push({ symbol: t.symbol, address, decimals: t.decimals, kind: t.kind });
  }

  const dress = (r) => {
    const proto = protocolForAddress(r.address);
    return {
      address: r.address,
      label: getLabel(r.address)?.name || null,
      protocol: proto ? { id: proto.id, name: proto.name } : null,
      transfers: r.transfers ?? 0,
      volume: r.volume ?? 0,
    };
  };

  if (ADDR_RE.test(q)) {
    // Exact address: return it even with no indexed activity, so a lookup of a known contract
    // doesn't come back empty just because it hasn't moved anything in the retained window.
    const stats = db.addressStats(q) || { address: q, transfers: 0, volume: 0 };
    out.addresses = [dress(stats)];
  } else if (HEX_PREFIX.test(q)) {
    // Registry contracts are matched from the registry itself, not only from indexed activity: a
    // protocol that has just deployed has a known address and no transfers yet, and searching its
    // address prefix should still find it. Registry hits rank first, then activity-ranked matches.
    const registryHits = PROTOCOLS
      .flatMap((p) => p.contracts)
      .filter((c) => c.startsWith(q))
      .map((address) => dress(db.addressStats(address) || { address, transfers: 0, volume: 0 }));
    const seen = new Set(registryHits.map((r) => r.address));
    const indexed = db.searchAddresses(q, limit).map(dress).filter((r) => !seen.has(r.address));
    out.addresses = [...registryHits, ...indexed].slice(0, limit);
  }

  out.total = out.protocols.length + out.tokens.length + out.addresses.length;
  return out;
}
