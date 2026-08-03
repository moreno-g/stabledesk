// Network profile — the single switch between Arc testnet and Arc mainnet.
//
//   ARC_NETWORK=mainnet
//
// Everything chain-specific lives here: chain id, RPC endpoints, token contracts, and the
// activity thresholds that only make sense relative to how much real money is moving.
//
// Testnet values are baked in because they are known and stable. Mainnet values are read from
// the environment because they do not exist yet — and if any of them is missing, this module
// throws rather than falling back. Serving testnet data under a mainnet banner would be far
// worse than failing to boot: the numbers would look plausible and be entirely wrong.

const ADDR = /^0x[0-9a-f]{40}$/;

// Descriptions of what each asset is, reused across networks so the env var stays short.
const KINDS = { USDC: 'native gas', EURC: 'euro', USYC: 'yield / MMF' };

// "USDC:0x36…00:6,EURC:0x89…2a:6" -> { '0x36…00': { symbol, decimals, kind } }
export function parseTokens(spec) {
  const out = {};
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [symbol, address, decimals] = part.split(':').map((s) => (s || '').trim());
    const addr = (address || '').toLowerCase();
    const dec = Number(decimals);
    if (!symbol || !ADDR.test(addr) || !Number.isInteger(dec) || dec < 0 || dec > 36) {
      throw new Error(`ARC_TOKENS: cannot parse "${part}" (expected SYMBOL:0xaddress:decimals)`);
    }
    out[addr] = { symbol: symbol.toUpperCase(), decimals: dec, kind: KINDS[symbol.toUpperCase()] || 'stablecoin' };
  }
  return Object.keys(out).length ? out : null;
}

// Circle Gateway contracts, from Circle's published deployment list. Gateway holds one USDC
// balance spendable across every supported chain, so the USDC it moves onto Arc is liquidity
// being repositioned — not somebody choosing to hold USDC here. Counting it as issuance would
// report a treasury operation as demand, which is the single most misleading thing this index
// could say. The addresses are deterministic per environment: one pair across every testnet,
// a different pair across every mainnet.
//
// Arc testnet is a Gateway chain (domain 26). Arc mainnet is not — it does not exist yet — so
// the mainnet pair is read from the environment rather than written in: publishing an address
// Circle has not deployed would attribute flows to a contract that isn't there.
const GATEWAY_TESTNET = {
  wallet: '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  minter: '0x0022222abe238cc2c7bb1f21003f0a260052475b',
};

const TESTNET = {
  id: 'testnet',
  isTestnet: true,
  chainId: 5042002,
  label: 'Arc testnet',
  gateway: GATEWAY_TESTNET,
  endpoints: [
    'https://rpc.testnet.arc.io',
    'https://rpc.drpc.testnet.arc.io',
    'https://rpc.quicknode.testnet.arc.io',
    'https://rpc.blockdaemon.testnet.arc.io',
  ],
  tokens: {
    '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6, kind: 'native gas' },
    '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { symbol: 'EURC', decimals: 6, kind: 'euro' },
    '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c': { symbol: 'USYC', decimals: 6, kind: 'yield / MMF' },
  },
  // Faucet-funded play money: the interesting threshold is low, and a short backfill is enough.
  notableMin: 1000,
  tweetWorthyMin: 250000,
  maxBackfill: 3000,
  dbFile: 'arc.db',   // unchanged, so an existing deployment keeps its history
};

function mainnetProfile() {
  const missing = [];

  const chainId = Number(process.env.ARC_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) missing.push('ARC_CHAIN_ID');

  const endpoints = String(process.env.ARC_RPC_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!endpoints.length) missing.push('ARC_RPC_URLS');
  for (const url of endpoints) {
    if (!/^https:\/\//.test(url)) throw new Error(`ARC_RPC_URLS: "${url}" is not an https URL`);
  }

  let tokens = null;
  try { tokens = parseTokens(process.env.ARC_TOKENS); } catch (e) { throw new Error(`Arc mainnet config — ${e.message}`); }
  if (!tokens) missing.push('ARC_TOKENS');

  // Gateway is optional, and its absence is a fact rather than a misconfiguration: Arc is not on
  // Circle's mainnet Gateway list today. Unset means "no Gateway on this network", and every
  // bridge-adjusted figure is then reported as null rather than as a measured zero.
  let gateway = null;
  const gwWallet = String(process.env.ARC_GATEWAY_WALLET || '').toLowerCase();
  const gwMinter = String(process.env.ARC_GATEWAY_MINTER || '').toLowerCase();
  if (gwWallet || gwMinter) {
    if (!ADDR.test(gwWallet) || !ADDR.test(gwMinter)) {
      throw new Error('ARC_GATEWAY_WALLET and ARC_GATEWAY_MINTER must both be set to 0x-prefixed addresses, or both left unset.');
    }
    gateway = { wallet: gwWallet, minter: gwMinter };
  }

  if (missing.length) {
    throw new Error(
      `ARC_NETWORK=mainnet but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. `
      + 'Refusing to start: falling back to testnet here would serve play-money figures as real ones. '
      + 'Set ARC_CHAIN_ID, ARC_RPC_URLS (comma-separated https), and ARC_TOKENS (SYMBOL:0xaddress:decimals,…).',
    );
  }

  return {
    id: 'mainnet',
    isTestnet: false,
    chainId,
    label: 'Arc',
    endpoints,
    tokens,
    gateway,
    // Real money: what deserves attention is orders of magnitude higher, and a longer backfill
    // is worth the RPC cost so the terminal isn't empty on day one.
    notableMin: Number(process.env.ARC_NOTABLE_MIN) || 100000,
    tweetWorthyMin: Number(process.env.ARC_WHALE_MIN) || 1000000,
    maxBackfill: Number(process.env.ARC_MAX_BACKFILL) || 20000,
    // A separate file: mixing faucet volume into mainnet history would poison every aggregate,
    // and the aggregates are additive, so it could never be unmixed afterwards.
    dbFile: 'arc-mainnet.db',
  };
}

export const NETWORK = process.env.ARC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
export const CHAIN = NETWORK === 'mainnet' ? mainnetProfile() : TESTNET;
