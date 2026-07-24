// Address label registry — the seed of the "entity intelligence" moat.
// Known Arc testnet contracts + system addresses, keyed by lowercase address.
// Grows over time (heuristics, crowd-sourcing) — this is the static core.

export const LABELS = {
  '0x0000000000000000000000000000000000000000': { name: 'Null · mint/burn', type: 'system' },
  '0x3600000000000000000000000000000000000000': { name: 'USDC', type: 'token' },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { name: 'EURC', type: 'token' },
  '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c': { name: 'USYC', type: 'token' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', type: 'infra' },
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', type: 'infra' },
  '0x4e59b44847b379578588920ca78fbf26c0b4956c': { name: 'CREATE2 Factory', type: 'infra' },
  '0x5294e9927c3306dcbadb03fe70b92e01ccede505': { name: 'Memo', type: 'infra' },
  '0x522faf9a91c41c443c66765030741e4aace147d0': { name: 'Multicall3From', type: 'infra' },
};

export const getLabel = (addr) => (addr ? LABELS[addr.toLowerCase()] || null : null);
