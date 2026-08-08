// Address label registry — the seed of the "entity intelligence" moat.
// Known Arc testnet contracts + system addresses, keyed by lowercase address.
// Grows over time (heuristics, crowd-sourcing) — this is the static core.
//
// Lookup order is deliberate: the hand-written labels below win, then the protocol registry
// (protocols.js) names anything a listed protocol claims. So adding a protocol to the registry
// labels all of its contracts everywhere they already appear — top addresses, transfer feeds,
// alerts — without touching this file.

import { protocolLabel } from './protocols.js';
import { CHAIN } from './chains.js';

// Addresses that are the same on every EVM chain because they are deployed deterministically, plus
// the zero address. Safe to state as literals: CREATE2 puts them at the same place everywhere.
const UNIVERSAL = {
  '0x0000000000000000000000000000000000000000': { name: 'Null · mint/burn', type: 'system' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', type: 'infra' },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', type: 'infra' },
  '0x4e59b44847b379578588920ca78fbf26c0b4956c': { name: 'CREATE2 Factory', type: 'infra' },
  '0x5294e9927c3306dcbadb03fe70b92e01ccede505': { name: 'Memo', type: 'infra' },
  '0x522faf9a91c41c443c66765030741e4aace147d0': { name: 'Multicall3From', type: 'infra' },
};

// The token contracts, derived from the active network profile rather than written in. They used to
// be three testnet literals, which meant that on mainnet the three most important addresses on the
// chain — the token contracts themselves — appeared unlabelled in every top-addresses table and
// transfer feed, while three dead testnet entries sat in the map. Everything else here is
// network-derived already; this was the one place it was not.
const tokenLabels = Object.fromEntries(
  Object.entries(CHAIN.tokens).map(([addr, meta]) => [addr.toLowerCase(), { name: meta.symbol, type: 'token' }]),
);

export const LABELS = { ...UNIVERSAL, ...tokenLabels };

export const getLabel = (addr) => {
  if (!addr) return null;
  const k = addr.toLowerCase();
  return LABELS[k] || protocolLabel(k);
};
