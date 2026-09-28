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
//      every EVM chain. 'team' = the operator told us or published it (its docs, its repository).
//      'observed' = we found it on-chain and classified it ourselves, and it is not a claim about who
//      runs it.
//
// Two entry fields attribute contracts that cannot be listed one by one, both checked against the
// chain before anything is attributed (tvl.js):
//   `factories`       — a pool is claimed by its protocol when the factory itself returns the pool's
//                       address (getPool / getPair). A contract that merely *says* factory() is X is
//                       not enough: anyone can deploy that.
//   `implementations` — an EIP-1967 proxy is claimed when its implementation slot points at one of
//                       these. The slot is chain state, not a self-description.
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
const CCTP_ADDRS = CHAIN.cctp ? [CHAIN.cctp.tokenMessenger, CHAIN.cctp.messageTransmitter, CHAIN.cctp.tokenMinter] : [];

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
  // Same rule as Gateway: present only where the network profile configures CCTP.
  ...(CCTP_ADDRS.length ? [{
    id: 'circle-cctp',
    name: 'Circle CCTP',
    vendor: 'Circle Internet Financial',
    category: 'bridge',
    desc: 'Cross-Chain Transfer Protocol: USDC is burned on one chain and minted on another, so what crosses is a transfer, not new money. The indexer reports CCTP mints and burns separately from issuance, with the chain on the other side.',
    links: { site: 'https://www.circle.com/cross-chain-transfer-protocol', docs: 'https://developers.circle.com/cctp' },
    contracts: CCTP_ADDRS,
    source: 'canonical',
    verified: true,
    added: '2026-09-18',
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
  // Memo and Multicall3From were first found on Arc testnet and named from their own behaviour. Arc's
  // published contract list now names both, at the same address on mainnet, as transaction extensions.
  {
    id: 'arc-memo',
    name: 'Memo',
    vendor: 'Circle Internet Financial',
    category: 'infra',
    desc: 'Attaches a reference note to a transfer. One of Arc\'s transaction extensions.',
    links: { docs: 'https://docs.arc.io/arc/references/contract-addresses' },
    contracts: ['0x5294e9927c3306dcbadb03fe70b92e01ccede505'],
    source: 'team',
    verified: true,
    added: '2026-07-26',
  },
  {
    id: 'wrapped-usdc',
    name: 'Wrapped USDC',
    vendor: null,
    category: 'infra',
    desc: 'ERC-20 wrapper around USDC at 18 decimals. Its supply is exactly the USDC it custodies, so it '
      + 'is measured here as a contract holding value, never as issuance — counting both would report the '
      + 'same dollars twice. Observed on Arc testnet; operator unattributed.',
    links: {},
    contracts: ['0x911b4000d3422f482f4062a913885f7b035382df'],
    networks: ['testnet'],
    source: 'observed',
    verified: false,
    added: '2026-08-22',
  },
  {
    id: 'multicall3from',
    name: 'Multicall3From',
    vendor: 'Circle Internet Financial',
    category: 'infra',
    desc: 'Multicall variant that preserves the original caller. One of Arc\'s transaction extensions.',
    links: { docs: 'https://docs.arc.io/arc/references/contract-addresses' },
    contracts: ['0x522faf9a91c41c443c66765030741e4aace147d0'],
    source: 'team',
    verified: true,
    added: '2026-07-26',
  },

  // ---- Arc mainnet, from each operator's own published address list (28 Sept 2026) ----
  // Every address below was also checked for bytecode on Arc mainnet, and the ones holding funds were
  // matched to their role from their own functions before being attributed (see the commit).
  {
    id: 'uniswap',
    name: 'Uniswap',
    vendor: 'Uniswap Labs',
    category: 'dex',
    desc: 'Spot exchange. v4 keeps every pool\'s liquidity in one PoolManager; v3 and v2 pools are separate '
      + 'contracts, attributed here when Uniswap\'s own factory confirms it created them.',
    links: { site: 'https://uniswap.org', docs: 'https://developers.uniswap.org/contracts/v4/deployments',
      github: 'https://github.com/Uniswap/contracts/blob/main/deployments/5042.md' },
    contracts: [
      '0x8366a39cc670b4001a1121b8f6a443a643e40951',   // v4 PoolManager — holds v4 liquidity
      '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',   // v4 PositionManager
      '0x516b8a945700d6bbfdedaa6dcfc4586ba60b8707',   // v4 PositionDescriptor
      '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',   // v4 Quoter
      '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',   // v4 StateView
      '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',   // Universal Router
      '0x8702463e73f74d0b6765abceb314ef07acb92650',   // Universal Router 2.1.2
      '0xf0db7b58379503491d857db50ac9ece64c653918',   // v3 Factory
      '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',   // v3 NonfungiblePositionManager
      '0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77',   // SwapRouter02
      '0x7dfd4f31be6814d2906bde155c3e1b146eac1468',   // v3 QuoterV2
      '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',   // v2 Factory
      '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',   // v2 Router02
    ],
    factories: [
      { address: '0xf0db7b58379503491d857db50ac9ece64c653918', type: 'uniswap-v3' },
      { address: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba', type: 'uniswap-v2' },
    ],
    networks: ['mainnet'],
    source: 'team',
    verified: true,
    added: '2026-09-28',
  },
  {
    id: 'aave-v4',
    name: 'Aave v4',
    vendor: 'Aave',
    category: 'lending',
    desc: 'Lending. Liquidity sits in the Hub; Spokes are the markets users borrow and lend through.',
    links: { site: 'https://aave.com', docs: 'https://aave.com/docs/aave-v4',
      github: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV4Arc.sol' },
    contracts: [
      '0x17288dfc86205301064577b98b02b81017e6f79c',   // Core Hub — holds the liquidity
      '0xb843bdc3a87a05e77e07df9fe48928b3a34b134d',   // Main Spoke
      '0x4164ebcaf74670aa74c8d4f59de6157c0780f1bb',   // Forex Spoke
      '0xcbd466cb8709d9f6dd8312668b4dbef394ce0e15',   // Treasury Spoke
      '0x42eab64310e1d1c66b4d8af7c9c4ce253885eb83',   // USDC tokenization spoke
      '0x5a10b1533c0f1f181dc8a428bf5eb58b08fc8d2c',   // EURC tokenization spoke
      '0x83d364dbaf4e7018e0b87db3fab3d1d8535a6f13',   // cirBTC tokenization spoke
      '0xe8b890fea6e1e3915a337ed3136487f2f4f7e59d',   // WETH tokenization spoke
      '0x01da80eef3004ebbf90b7637b1de7ff30fbc7cf1',   // Giver position manager
      '0xe9fae1c386c6f45b1fb3c3ef01ade424dad4bccf',   // Taker position manager
      '0xa5aa65ae1c830d2ae10853ceea42ae653adb3312',   // Config position manager
      '0x0d36a4a21119bbbde559d59002254171d976289f',   // Signature gateway
    ],
    networks: ['mainnet'],
    source: 'team',
    verified: true,
    added: '2026-09-28',
  },
  {
    id: 'morpho',
    name: 'Morpho',
    vendor: 'Morpho Labs',
    category: 'lending',
    desc: 'Lending. Every Morpho market lives in one contract, so its balance is the protocol\'s liquidity.',
    links: { site: 'https://morpho.org', docs: 'https://docs.morpho.org/get-started/resources/addresses/' },
    contracts: [
      '0x34cd04070dd72b14e241112f6d83812df5af7fcd',   // Morpho — holds every market's liquidity
      '0xf02615d094fc02fc031c35fe705e175aa4653f20',   // Adaptive Curve IRM
    ],
    networks: ['mainnet'],
    source: 'team',
    verified: true,
    added: '2026-09-28',
  },
  {
    id: 'circle-stablefx',
    name: 'Circle StableFX',
    vendor: 'Circle Internet Financial',
    category: 'dex',
    desc: 'Stablecoin FX settlement. The escrow holds both legs of a trade until it settles.',
    links: { docs: 'https://docs.arc.io/arc/references/contract-addresses' },
    contracts: ['0xe2e5f173576b513d994073ccbdacbe027d43dfe6'],   // FxEscrow
    networks: ['mainnet'],
    source: 'team',
    verified: true,
    added: '2026-09-28',
  },
  {
    id: 'usyc-teller',
    name: 'USYC Teller',
    vendor: 'Circle Internet Financial',
    category: 'yield',
    desc: 'Subscribes and redeems USYC, the tokenised money-market fund, against USDC.',
    links: { docs: 'https://docs.arc.io/arc/references/contract-addresses' },
    contracts: [
      '0x51a8ce47dc08ba5cd19c7aa84ea6fd6664f60f9b',   // Teller
      '0xb69ecb156dc0028198028c501340d5367845ca72',   // Entitlements
    ],
    networks: ['mainnet'],
    source: 'team',
    verified: true,
    added: '2026-09-28',
  },
  // Wallets, not a protocol: each account belongs to whoever owns it. They run Circle's open-source
  // modular account code — the implementation declares NAME "Circle_SingleOwnerMSCA" and AUTHOR "Circle
  // Internet Financial" — but that address is not in a list Circle publishes, so this stays 'observed'
  // and claims no operator. Listed so that two such accounts holding ~$100M on 28 Sept 2026 read as
  // what they are rather than as an unnamed protocol.
  {
    id: 'circle-msca-accounts',
    name: 'Smart accounts (Circle MSCA)',
    vendor: null,
    category: 'custody',
    desc: 'ERC-6900 single-owner smart-contract wallets running Circle\'s modular account code. Each account '
      + 'belongs to its owner: balances here are wallets, not deposits in a protocol.',
    links: { github: 'https://github.com/circlefin/buidl-wallet-contracts' },
    contracts: ['0xd206ac7fef53d83ed4563e770b28dba90d0d9ec8'],   // the implementation every account points at
    implementations: ['0xd206ac7fef53d83ed4563e770b28dba90d0d9ec8'],
    // Wallets: named wherever they appear, but their balances are not TVL — see tvl.js computeAggregate.
    wallets: true,
    networks: ['mainnet'],
    source: 'observed',
    verified: false,
    added: '2026-09-28',
  },
];

const ADDR = /^0x[0-9a-f]{40}$/;
// How a factory is asked whether it created a pool. Each type is one question the factory answers
// from its own storage, which is what makes the attribution unforgeable.
export const FACTORY_TYPES = ['uniswap-v2', 'uniswap-v3'];

// Fail loudly at import time rather than serving a broken registry. A malformed entry here would
// otherwise show up as a protocol with no TVL, which looks like a real (zero) measurement.
function validate(p) {
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) throw new Error(`protocols: bad id "${p.id}"`);
  if (!p.name) throw new Error(`protocols: ${p.id} has no name`);
  if (!CATEGORIES[p.category]) throw new Error(`protocols: ${p.id} has unknown category "${p.category}"`);
  if (!['canonical', 'team', 'observed'].includes(p.source)) throw new Error(`protocols: ${p.id} has bad source "${p.source}"`);
  if (!Array.isArray(p.contracts) || !p.contracts.length) throw new Error(`protocols: ${p.id} lists no contracts`);
  for (const c of p.contracts) if (!ADDR.test(c)) throw new Error(`protocols: ${p.id} has non-lowercase/invalid address "${c}"`);
  for (const f of p.factories || []) {
    if (!ADDR.test(f.address)) throw new Error(`protocols: ${p.id} has invalid factory "${f.address}"`);
    if (!FACTORY_TYPES.includes(f.type)) throw new Error(`protocols: ${p.id} has unknown factory type "${f.type}"`);
  }
  for (const i of p.implementations || []) if (!ADDR.test(i)) throw new Error(`protocols: ${p.id} has invalid implementation "${i}"`);
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

// The attribution rules, indexed. Read by tvl.js, which checks each candidate against the chain.
const factoryIndex = new Map();
const implIndex = new Map();
for (const p of PROTOCOLS) {
  for (const f of p.factories || []) factoryIndex.set(f.address, { protocol: p.id, type: f.type });
  for (const i of p.implementations || []) implIndex.set(i, p.id);
}
export const attributionRules = () => ({ factories: factoryIndex, implementations: implIndex });

// Every address, listed or derived, that belongs to an entry marked `wallets`. Smart-contract wallets
// have bytecode, which is how TVL tells a contract from a wallet — and account abstraction makes that
// test wrong. Their balances are someone's money, like any wallet's, and stay out of TVL.
export const walletAddresses = () => PROTOCOLS.filter((p) => p.wallets)
  .flatMap((p) => [...p.contracts, ...[...derived.entries()].filter(([, d]) => d.protocol.id === p.id).map(([a]) => a)]);

// Contracts attributed by a rule rather than listed: address → { protocol, basis }. Filled by tvl.js
// from what it verified on the chain and persisted; a listed address always wins over a derived one.
const derived = new Map();
export function setDerivedAttributions(rows) {
  derived.clear();
  for (const r of rows || []) {
    const p = byId.get(r.protocol);
    if (p && !byAddress.has(r.address)) derived.set(r.address, { protocol: p, basis: r.basis || null });
  }
}
export const derivedAddresses = (id) => [...derived.entries()].filter(([, d]) => d.protocol.id === id).map(([a]) => a);
export const attributionBasis = (addr) => {
  const a = String(addr || '').toLowerCase();
  return byAddress.has(a) ? 'listed' : derived.get(a)?.basis || null;
};

export const protocolById = (id) => byId.get(String(id || '').toLowerCase()) || null;
export const protocolForAddress = (addr) => {
  const a = String(addr || '').toLowerCase();
  return byAddress.get(a) || derived.get(a)?.protocol || null;
};
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
    // The rules that attribute contracts not listed above, published so they can be checked.
    factories: p.factories || [],
    implementations: p.implementations || [],
    derivedContracts: derivedAddresses(p.id).length,
    wallets: !!p.wallets,
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
  // Protocols only: an entry naming smart-contract wallets is not ranked, so it is not counted either —
  // a category filter reading "Custody 1" over an empty table is a count of something not shown.
  const protocols = PROTOCOLS.filter((p) => !p.wallets);
  for (const p of protocols) {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
    if (p.verified) verified += 1;
  }
  return {
    total: protocols.length,
    verified,
    unverified: protocols.length - verified,
    walletEntries: PROTOCOLS.length - protocols.length,
    contracts: byAddress.size,
    derivedContracts: derived.size,
    byCategory,
    network: NETWORK,
  };
}
