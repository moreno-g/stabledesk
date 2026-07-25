// Entity derivation — EXPERIMENTAL, self-contained.
//
// Works out what a high-volume address *is*, using nothing but public chain data: bytecode,
// storage slots, and block authorship. Nothing here is scraped from another analytics provider
// — their label sets are contractually and (in the EU) database-right protected, and a copied
// label set is somebody else's asset rather than a moat.
//
// Only the top addresses by volume are derived, because volume on Arc is extremely concentrated
// (measured on live data: the top 20 addresses carry ~92% of it). Labelling the head of the
// distribution covers nearly all flow for a fixed, small amount of work.
//
// Scope: infrastructure and organisations only. This never attempts to attach a natural person
// to an address — under GDPR a wallet tied to an identifiable individual is personal data, and
// the institutional use case has no need for it.
//
// To remove the feature entirely: delete this file, public/entities.html, the address_meta table
// in db.js, and the handful of lines referencing entities.* in server.js.

import { createHash } from 'node:crypto';
import { rpc, rpcSoft, hex } from './rpc.js';
import * as db from './db.js';
import { getLabel } from './labels.js';
import { ENTITY_TOP_N, ENTITY_REFRESH_MS, ENTITY_WARMUP_MS, DERIVE_CHUNK, DERIVE_DELAY } from './constants.js';

// Well-known 4-byte selectors. Their presence in deployed bytecode is strong evidence of the
// interface a contract implements — no ABI, no source, no verification service required.
const SELECTORS = {
  a9059cbb: 'transfer',
  '70a08231': 'balanceOf',
  '095ea7b3': 'approve',
  '23b872dd': 'transferFrom',
  '06fdde03': 'name',
  '95d89b41': 'symbol',
  d505accf: 'permit',
  ac9650d8: 'multicall',
  d0e30db0: 'deposit',
  '2e1a7d4d': 'withdraw',
  '5c60da1b': 'implementation',
  '3659cfe6': 'upgradeTo',
  a0e67e2b: 'getOwners',       // Safe
  e75235b8: 'getThreshold',    // Safe
  '6a761202': 'execTransaction', // Safe
};

// Proxy targets are read by calling implementation() rather than by reading the EIP-1967 storage
// slot. Two reasons, both measured against Arc's public RPC: the slot is empty on Arc's own
// contracts (USDC returns zero there but answers implementation() with a real address, so it uses
// a different proxy pattern), and eth_getStorageAt is rate-limited far more aggressively than
// eth_call on the public endpoint.
const ZERO_WORD = '0x' + '0'.repeat(64);
const addrFromWord = (w) => (w && w !== ZERO_WORD ? '0x' + w.slice(-40).toLowerCase() : null);

// ABI-decode a returned string. Falls back to a raw read for the bytes32-style tokens that
// predate the string convention.
export function decodeString(hexStr) {
  if (!hexStr || hexStr === '0x') return null;
  try {
    const b = Buffer.from(hexStr.slice(2), 'hex');
    if (b.length >= 64) {
      const len = Number(BigInt('0x' + b.subarray(32, 64).toString('hex')));
      if (len > 0 && len <= b.length - 64) {
        const s = b.subarray(64, 64 + len).toString('utf8').replace(/\0/g, '').trim();
        return s || null;
      }
    }
    const s = b.toString('utf8').replace(/\0/g, '').trim();
    return /^[\x20-\x7e]+$/.test(s) ? s : null;
  } catch { return null; }
}

export function detectInterfaces(code) {
  if (!code || code.length <= 2) return [];
  const body = code.toLowerCase();
  return Object.entries(SELECTORS).filter(([sel]) => body.includes(sel)).map(([, name]) => name);
}

// Pure: turn the raw on-chain facts into a classification. Ordered most specific first.
export function classify(m) {
  if (m.blocksMade > 0) return 'validator';
  if (!m.isContract) return 'wallet';
  const i = new Set(m.interfaces || []);
  if (m.tokenSymbol) return 'token';
  if (i.has('getOwners') && i.has('execTransaction')) return 'multisig';
  if (m.impl) return 'proxy';
  if (i.has('transfer') && i.has('balanceOf')) return 'token-handler';
  if (i.has('multicall')) return 'router';
  return 'contract';
}

// Human-readable justification, so the page can show *why* an address was classified.
export function explain(m) {
  switch (m.kind) {
    case 'validator': return `produced ${m.blocksMade} recent block${m.blocksMade === 1 ? '' : 's'}`;
    case 'wallet': return 'no bytecode at this address';
    case 'token': return `contract answers symbol() = "${m.tokenSymbol}"`;
    case 'multisig': return 'bytecode exposes getOwners + execTransaction (Safe-style)';
    case 'proxy': return `implementation() points at ${m.impl?.slice(0, 10)}…`;
    case 'token-handler': return 'bytecode exposes transfer + balanceOf';
    case 'router': return 'bytecode exposes multicall';
    default: return `contract, ${m.codeSize ?? 0} bytes`;
  }
}

let timer = null;
let lastRun = { at: null, derived: 0, error: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, size) => { const o = []; for (let i = 0; i < arr.length; i += size) o.push(arr.slice(i, i + size)); return o; };

// Derivation runs in two phases against a rate-limited public RPC. Phase 1 asks only for
// bytecode; phase 2 asks for the proxy target and token metadata, and only for the addresses that
// turned out to be contracts — most high-volume addresses are plain wallets, so skipping them
// removes the bulk of the calls. Batches are kept small and spaced out: this is a background job
// on a ten-minute cycle, so spending a few seconds on it costs nothing.
async function deriveBatch(addresses, validators) {
  if (!addresses.length) return 0;

  const codes = new Map();
  for (const part of chunk(addresses, DERIVE_CHUNK)) {
    const { out } = await rpcSoft(part.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    part.forEach((a, i) => codes.set(a, typeof out[i] === 'string' ? out[i] : null));
    await sleep(DERIVE_DELAY);
  }

  const contracts = addresses.filter((a) => (codes.get(a) || '0x').length > 2);
  const extra = new Map();
  for (const part of chunk(contracts, DERIVE_CHUNK)) {
    const { out } = await rpcSoft(part.flatMap((a) => [
      { method: 'eth_call', params: [{ to: a, data: '0x5c60da1b' }, 'latest'] }, // implementation()
      { method: 'eth_call', params: [{ to: a, data: '0x06fdde03' }, 'latest'] }, // name()
      { method: 'eth_call', params: [{ to: a, data: '0x95d89b41' }, 'latest'] }, // symbol()
    ]));
    part.forEach((a, i) => extra.set(a, {
      impl: addrFromWord(out[i * 3]),
      tokenName: decodeString(out[i * 3 + 1]),
      tokenSymbol: decodeString(out[i * 3 + 2]),
    }));
    await sleep(DERIVE_DELAY);
  }

  let n = 0;
  for (const address of addresses) {
    const code = codes.get(address);
    if (code == null) continue; // endpoint returned nothing usable — retry next cycle
    const isContract = code.length > 2;
    const e = extra.get(address) || {};
    const m = {
      address,
      isContract,
      codeSize: isContract ? (code.length - 2) / 2 : 0,
      codeHash: isContract ? createHash('sha256').update(code).digest('hex').slice(0, 16) : null,
      impl: e.impl || null,
      admin: null,   // not derived: costs an extra call per contract for little signal
      tokenName: e.tokenName || null,
      tokenSymbol: e.tokenSymbol || null,
      interfaces: detectInterfaces(code),
      blocksMade: validators.get(address) || 0,
    };
    m.kind = classify(m);
    db.upsertAddressMeta({ ...m, interfaces: m.interfaces.join(',') });
    n += 1;
  }
  return n;
}

// Sample recent block authorship. On Arc the fee recipient is the block producer, so this
// identifies the validator set — addresses that are infrastructure by definition.
async function sampleValidators() {
  const map = new Map();
  try {
    const { out } = await rpc([{ method: 'eth_blockNumber', params: [] }]);
    const latest = parseInt(out[0], 16);
    const nums = Array.from({ length: 20 }, (_, i) => latest - i);
    const { out: blocks } = await rpc(nums.map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), false] })));
    for (const b of blocks) {
      if (!b?.miner) continue;
      const a = b.miner.toLowerCase();
      map.set(a, (map.get(a) || 0) + 1);
    }
  } catch { /* best-effort: derivation still works without validator data */ }
  return map;
}

export async function refresh() {
  try {
    const validators = await sampleValidators();
    const top = db.getTop(ENTITY_TOP_N).map((r) => r.address);
    // Validators rarely appear in transfer rankings — they earn fees, they don't move stablecoins.
    const targets = [...new Set([...top, ...validators.keys()])];
    const derived = await deriveBatch(targets, validators);
    lastRun = { at: Date.now(), derived, error: null };
  } catch (e) {
    lastRun = { ...lastRun, at: Date.now(), error: String(e.message || e) };
    console.error('[entities]', e.message || e);
  }
}

// The view served to the page: top addresses by volume, enriched with what we derived.
export function snapshot() {
  const rows = db.topWithMeta(ENTITY_TOP_N);
  const total = rows.reduce((a, r) => a + r.volume, 0);
  let identified = 0, identifiedVolume = 0;
  const addresses = rows.map((r) => {
    const curated = getLabel(r.address);
    const m = {
      blocksMade: r.blocks_made || 0, isContract: !!r.is_contract, codeSize: r.code_size,
      tokenSymbol: r.token_symbol, impl: r.impl, interfaces: (r.interfaces || '').split(',').filter(Boolean),
      kind: r.kind,
    };
    if (r.kind) { identified += 1; identifiedVolume += r.volume; }
    return {
      address: r.address,
      label: curated?.name || null,
      // A curated label is asserted by us; a derived kind is computed from chain data. Keeping
      // them apart is the whole point — the page shows which is which.
      source: curated ? 'curated' : (r.kind ? 'derived' : null),
      kind: r.kind || null,
      why: r.kind ? explain(m) : null,
      transfers: r.transfers,
      volume: r.volume,
      firstFrom: r.first_from || null,
      firstFromLabel: r.first_from ? getLabel(r.first_from)?.name || null : null,
      tokenName: r.token_name || null,
      tokenSymbol: r.token_symbol || null,
      codeSize: r.code_size || null,
      codeHash: r.code_hash || null,
      impl: r.impl || null,
      admin: r.admin || null,
      interfaces: m.interfaces,
      blocksMade: r.blocks_made || 0,
    };
  });
  return {
    addresses,
    clusters: db.bytecodeClusters(),
    stats: {
      shown: rows.length,
      identified,
      // The number that matters: not how many addresses we named, but how much flow they carry.
      volumeCoverage: total ? identifiedVolume / total : 0,
      knownTotal: db.knownAddressCount(),
    },
    lastRun,
  };
}

// The indexer has to populate addr_stats before there is anything worth deriving, and on a cold
// start its backfill runs for a while. So poll on a short cycle until rankings exist, then settle
// into the slow refresh — rather than firing once at boot and sitting idle for ten minutes.
export function start() {
  const tick = async () => {
    await refresh();
    const warm = db.getTop(1).length > 0;
    timer = setTimeout(tick, warm ? ENTITY_REFRESH_MS : ENTITY_WARMUP_MS);
    timer.unref?.();
  };
  timer = setTimeout(tick, ENTITY_WARMUP_MS);
  timer.unref?.();
}
export function stop() { if (timer) { clearTimeout(timer); timer = null; } }
