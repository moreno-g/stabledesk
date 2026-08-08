// Consistent snapshot of the live database, without stopping the service.
//
//   node backup.js [destination]
//
// Why this exists as a script rather than a line in DEPLOY.md: most of what this database holds can
// be rebuilt by pointing the indexer at the chain again, and four things cannot.
//
//   chain_events   the availability record — a log of *observations*. Re-indexing can recover what
//                  the chain did; it cannot recover our having been there to see it, which is the
//                  entire claim the record makes.
//   buckets_daily  per-day history, kept indefinitely. Re-indexable only for as long as the RPC still
//                  serves those blocks' logs, which for a public endpoint is not forever.
//   tvl_history    daily TVL levels. A level is a reading taken at an instant; balanceOf today cannot
//                  tell you last Tuesday's balance.
//   api_keys/orders  issued keys and paid subscriptions. Losing them revokes access people paid for.
//
// `cp` is not a backup of a live SQLite database: with WAL enabled the file on disk is not a complete
// database on its own, and a copy taken mid-write is a torn one. node:sqlite's backup() drives
// SQLite's online-backup API, which takes a consistent snapshot of a database that is being written
// to — no downtime, no lock held for the duration.
//
// Zero dependencies, and deliberately not the sqlite3 CLI: the deployed image is node:24-slim, which
// does not ship it. This runs anywhere the app runs.

import { backup, DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHAIN } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The same resolution db.js uses, so this can never snapshot a different file than the one the
// service is writing to.
function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (vol) return join(vol, CHAIN.dbFile);
  return join(__dirname, CHAIN.dbFile);
}

// Tables whose contents cannot be reconstructed from the chain. Counted after the snapshot, because a
// backup nobody verified is a file, not a backup — and the failure mode that matters is a snapshot
// that is technically valid and missing the one table it was taken for.
const IRREPLACEABLE = ['chain_events', 'buckets_daily', 'tvl_history', 'api_keys', 'orders'];

const src = resolveDbPath();
const stamp = new Date().toISOString().slice(0, 10);
const dest = process.argv[2] || join(__dirname, `${CHAIN.dbFile}.${stamp}.backup`);

if (src === dest) {
  console.error('Refusing to back up a database onto itself.');
  process.exit(1);
}

console.log(`[backup] ${src} → ${dest}`);

const source = new DatabaseSync(src, { readOnly: true });
try {
  await backup(source, dest);
} finally {
  source.close();
}

// Verify. integrity_check on the snapshot rather than on the source: it is the copy we are going to
// rely on, and it is the copy that can be torn.
const check = new DatabaseSync(dest, { readOnly: true });
try {
  const integrity = check.prepare('PRAGMA integrity_check').get();
  const verdict = Object.values(integrity ?? {})[0];
  if (verdict !== 'ok') {
    console.error(`[backup] integrity_check failed: ${verdict}`);
    process.exit(1);
  }
  const counts = IRREPLACEABLE.map((t) => {
    try { return `${t}=${check.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c}`; } catch { return `${t}=absent`; }
  });
  console.log(`[backup] ok · ${(statSync(dest).size / 1e6).toFixed(1)} MB · ${counts.join(' ')}`);
} finally {
  check.close();
}
