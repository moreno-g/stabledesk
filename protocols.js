// Protocol registry — the curated core of the Arc ecosystem page.
//
// This file is deliberately *data*, not engineering. It is the cheapest and most defensible
// asset in the product: being the canonical answer to "what is deployed on Arc" is worth more
// than any single metric we compute, and it costs a pull request rather than an indexer.
//
// Two hard rules, both about not making things up:
//
//   1. Nothing is listed here that has not been verified against the chain or asserted by the
//      team that operates it. A registry whose entries are guesses is worse than an empty one —
//      it would be a fabricated record of an ecosystem, and every number attributed to a wrong
//      address would be wrong in a way nobody could see.
//   2. `source` records *how* we know. 'canonical' = a deterministic address that is the same on
//      every EVM chain. 'team' = the operator told us. 'observed' = we found it on-chain and
//      classified it ourselves, and it is not a claim about who runs it.
//
// Third-party protocols are added two ways: contributions (see PROTOCOLS.md) and discovery —
// tvl.js surfaces unregistered contracts holding real stablecoin balances, which is the queue
// of things worth naming. The registry grows from evidence, never from assumption.

import { CHAIN, NETWORK } from './chains.js';

// Display order matters: the page groups by category, and the ordering here is roughly
// "closest to the money" first, so an empty ecosystem still reads sensibly.
export const CATEGORIES = {
  issuer: { label: 'Issuer', desc: 'Mints and redeems the asset itself' },
  payments: { label: 'Payments', desc: 'Transfers, invoicing, payroll, subscriptions' },
  dex: { label: 'Exchange', desc: 'Spot, FX or perpetual trading' },
  lending: { label: 'Lending', desc: 'Credit markets, over- or under-collateralised' },
  yield: { label: 'Yield', desc: 'Treasuries, money-market funds, staking' },
  rwa: { label: 'RWA', desc: 'Tokenised off-chain assets' },
  bridge: { label: 'Bridge', desc: 'Cross-chain transfer of value' },
  custody: { label: 'Custody', desc: 'Wallets, multisig, key management' },
  oracle: { label: 'Oracle', desc: 'Off-chain data delivered on-chain' },
  infra: { label: 'Infra', desc: 'Developer plumbing with no end-user product' },
};
export const CATEGORY_IDS = Object.keys(CATEGORIES);

// Stablecoin addresses come from the network profile rather than being written out here, so the
// issuer entry is correct on mainnet the moment ARC_TOKENS is set — no second place to update.
const STABLECOIN_ADDRS = Object.keys(CHAIN.tokens);
const STABLECOIN_SYMBOLS = Object.values(CHAIN.tokens).map((t) => t.symbol);

// Same idea for Gateway: the addresses live in the network profile, so this entry appears only on
// a network where Gateway is actually deployed and never has to be updated in two places.
const GATEWAY_ADDRS = CHAIN.gateway ? [CHAIN.gateway.wallet, CHAIN.gateway.minter] : [];

// `networks` omitted means "same address on every Arc network" — true for deterministic
// deployments and for anything derived from CHAIN.tokens. An entry that only exists on one
// network must say so, or it would be listed as missing-in-action on the other.
const REGISTRY = [
  {
    id: 'circle',
    name: 'Circle',
    vendor: 'Circle Internet Financial',
    category: 'issuer',
    desc: `Issuer of ${STABLECOIN_SYMBOLS.join(', ')} and operator of Arc itself. USDC is the native gas token.`,
    links: { site: 'https://www.circle.com', docs: 'https://developers.circle.com', x: 'https://x.com/circle' },
    contracts: STABLECOIN_ADDRS,
    source: 'canonical',
    verified: true,
    added: '2026-07-26',
  },
  // Present only where Gateway is deployed. On a network without it there is no entry at all,
  // rather than an entry with no contracts — which validate() would reject, and which would read
  // on the ecosystem page as a protocol we failed to measure instead of one that isn't there.
  ...(GATEWAY_ADDRS.length ? [{
    id: 'circle-gateway',
    name: 'Circle Gateway',
    vendor: 'Circle Internet Financial',
    category: 'bridge',
    desc: 'One USDC balance spendable across every supported chain. Liquidity is drawn onto a chain on demand instead of being pre-positioned, so the USDC it moves here is a treasury operation rather than new demand — the indexer reports it separately from issuance.',
    links: { site: 'https://www.circle.com/gateway', docs: 'https://developers.circle.com/gateway' },
    contracts: GATEWAY_ADDRS,
    source: 'canonical',
    verified: true,
    added: '2026-08-03',
  }] : []),
  {
    id: 'permit2',
    name: 'Permit2',
    vendor: 'Uniswap Labs',
    category: 'infra',
    desc: 'Signature-based token approvals shared across applications. Deployed at the same deterministic address on every EVM chain.',
    links: { site: 'https://github.com/Uniswap/permit2', docs: 'https://docs.uniswap.org/contracts/permit2/overview' },
    contracts: ['0x000000000022d473030f116ddee9f6b43ac78ba3'],
    source: 'canonical',
    verified: true,
    added: '2026-07-26',
  },
  {
    id: 'multicall3',
    name: 'Multicall3',
    vendor: 'MakerDAO / community',
    category: 'infra',
    desc: 'Batches many read calls into one RPC round-trip. Deterministic address, present on essentially every EVM chain.',
    links: { site: 'https://www.multicall3.com', github: 'https://github.com/mds1/multicall' },
    contracts: ['0xca11bde05977b3631167028862be2a173976ca11'],
    source: 'canonical',
    verified: true,
    added: '2026-07-26',
  },
  {
    id: 'create2-factory',
    name: 'CREATE2 Factory',
    vendor: 'community',
    category: 'infra',
    desc: 'Deterministic deployment proxy — lets a contract get the same address on every chain.',
    links: { github: 'https://github.com/Arachnid/deterministic-deployment-proxy' },
    contracts: ['0x4e59b44847b379578588920ca78fbf26c0b4956c'],
    source: 'canonical',
    verified: true,
    added: '2026-07-26',
  },
  // The next two were found on Arc testnet and named from their own behaviour. We do not know who
  // deployed them, so no vendor is claimed and neither is marked verified — see rule 2 above.
  {
    id: 'arc-memo',
    name: 'Memo',
    vendor: null,
    category: 'infra',
    desc: 'Attaches a reference note to a transfer. Observed on Arc testnet; operator unattributed.',
    links: {},
    contracts: ['0x5294e9927c3306dcbadb03fe70b92e01ccede505'],
    networks: ['testnet'],
    source: 'observed',
    verified: false,
    added: '2026-07-26',
  },
  {
    id: 'multicall3from',
    name: 'Multicall3From',
    vendor: null,
    category: 'infra',
    desc: 'Multicall variant that preserves the original caller. Observed on Arc testnet; operator unattributed.',
    links: {},
    contracts: ['0x522faf9a91c41c443c66765030741e4aace147d0'],
    networks: ['testnet'],
    source: 'observed',
    verified: false,
    added: '2026-07-26',
  },
];

const ADDR = /^0x[0-9a-f]{40}$/;

// Fail loudly at import time rather than serving a broken registry. A malformed entry here would
// otherwise show up as a protocol with no TVL, which looks like a real (zero) measurement.
function validate(p) {
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) throw new Error(`protocols: bad id "${p.id}"`);
  if (!p.name) throw new Error(`protocols: ${p.id} has no name`);
  if (!CATEGORIES[p.category]) throw new Error(`protocols: ${p.id} has unknown category "${p.category}"`);
  if (!['canonical', 'team', 'observed'].includes(p.source)) throw new Error(`protocols: ${p.id} has bad source "${p.source}"`);
  if (!Array.isArray(p.contracts) || !p.contracts.length) throw new Error(`protocols: ${p.id} lists no contracts`);
  for (const c of p.contracts) if (!ADDR.test(c)) throw new Error(`protocols: ${p.id} has non-lowercase/invalid address "${c}"`);
  return p;
}

const seen = new Set();
for (const p of REGISTRY) {
  validate(p);
  if (seen.has(p.id)) throw new Error(`protocols: duplicate id "${p.id}"`);
  seen.add(p.id);
}

// Entries deployed on the network this process is indexing. Everything downstream reads this,
// never REGISTRY, so a testnet-only contract can never be attributed mainnet balances.
export const PROTOCOLS = REGISTRY.filter((p) => !p.networks || p.networks.includes(NETWORK));

// address → protocol. One address can only belong to one protocol; a collision means two entries
// claim the same contract, which would double-count its balance in total TVL.
const byAddress = new Map();
for (const p of PROTOCOLS) {
  for (const c of p.contracts) {
    const prev = byAddress.get(c);
    if (prev) throw new Error(`protocols: ${c} claimed by both "${prev.id}" and "${p.id}"`);
    byAddress.set(c, p);
  }
}

const byId = new Map(PROTOCOLS.map((p) => [p.id, p]));

export const protocolById = (id) => byId.get(String(id || '').toLowerCase()) || null;
export const protocolForAddress = (addr) => byAddress.get(String(addr || '').toLowerCase()) || null;
export const protocolAddresses = () => [...byAddress.keys()];
export const isRegistered = (addr) => byAddress.has(String(addr || '').toLowerCase());

// Name for an address, if a registered protocol claims it. labels.js falls back to this so a
// contributed protocol automatically names its contracts everywhere they appear.
export const protocolLabel = (addr) => {
  const p = protocolForAddress(addr);
  return p ? { name: p.name, type: p.category, protocol: p.id } : null;
};

// The public shape: what the API and pages serialise. Runtime metrics are merged in by tvl.js —
// this only ever returns curated facts, so a registry entry with no measurement is visibly
// unmeasured rather than silently zero.
export function publicShape(p) {
  return {
    id: p.id,
    name: p.name,
    vendor: p.vendor || null,
    category: p.category,
    categoryLabel: CATEGORIES[p.category].label,
    desc: p.desc || null,
    links: p.links || {},
    contracts: p.contracts,
    networks: p.networks || ['testnet', 'mainnet'],
    source: p.source,
    verified: !!p.verified,
    added: p.added || null,
  };
}

export const listProtocols = () => PROTOCOLS.map(publicShape);

// Registry-wide counts for the page header. `unverified` is shown deliberately: it is the honest
// measure of how much of the list is our classification rather than the operator's confirmation.
export function registryStats() {
  const byCategory = {};
  let verified = 0;
  for (const p of PROTOCOLS) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    if (p.verified) verified += 1;
  }
  return {
    total: PROTOCOLS.length,
    verified,
    unverified: PROTOCOLS.length - verified,
    contracts: byAddress.size,
    byCategory,
    network: NETWORK,
  };
}
