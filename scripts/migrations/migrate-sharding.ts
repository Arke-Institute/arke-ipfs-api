#!/usr/bin/env tsx
/**
 * Migration Script: Shard Path Migration
 *
 * ============================================================================
 * CONTEXT & BACKGROUND
 * ============================================================================
 *
 * This migration was run on 2025-12-13 to fix a sharding algorithm bug.
 *
 * PROBLEM:
 * The original sharding used the FIRST 4 characters of ULIDs:
 *   shard2(id) = [id.slice(0,2), id.slice(2,4)]
 *
 * However, ULIDs have this structure:
 *   TTTTTTTTTTRRRRRRRRRRRRRRRR
 *   |---------|---------------|
 *   timestamp  randomness
 *   (10 chars) (16 chars)
 *
 * The timestamp portion changes extremely slowly:
 *   - Characters 0-1: Change every ~278 years
 *   - Characters 2-3: Change every ~99 days
 *
 * This meant ALL tip files were clustered in just a few directories like:
 *   /arke/index/01/KC/  (thousands of files)
 *
 * SOLUTION:
 * Changed sharding to use the LAST 4 characters (from random portion):
 *   shard2(id) = [id.slice(-4,-2), id.slice(-2)]
 *
 * This provides uniform distribution across 32^4 = 1,048,576 possible
 * directory combinations.
 *
 * ============================================================================
 * MIGRATION RESULTS (2025-12-13)
 * ============================================================================
 *
 * - Total entries processed: 3,285
 * - Successfully migrated: 3,279 files
 * - Already at new location: 5 (test batch from earlier)
 * - Same path: 1 (rare case where old and new sharding matched)
 * - Errors: 0
 *
 * ============================================================================
 * FILE PATH CHANGES
 * ============================================================================
 *
 * OLD: /arke/index/01/KC/01J8ME3H6FZ3KQ5W1P2XY8K7E5.tip
 * NEW: /arke/index/K7/E5/01J8ME3H6FZ3KQ5W1P2XY8K7E5.tip
 *
 * ============================================================================
 * USAGE (for reference or future migrations)
 * ============================================================================
 *
 *   # Dry run (default) - shows what would be done
 *   tsx scripts/migrate-sharding.ts
 *
 *   # Small batch test (first 10)
 *   tsx scripts/migrate-sharding.ts --limit 10
 *
 *   # Actually run the migration
 *   tsx scripts/migrate-sharding.ts --execute
 *
 *   # Execute with limit
 *   tsx scripts/migrate-sharding.ts --execute --limit 50
 */

// IPFS Kubo RPC API (for MFS operations)
const IPFS_API = process.env.IPFS_API_URL || 'https://ipfs-api.arke.institute/api/v0';
// IPFS Server Backend API (for snapshot)
const BACKEND_API = process.env.IPFS_SERVER_API_URL || 'https://ipfs-api.arke.institute';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function info(msg: string) { log('cyan', `ℹ️  ${msg}`); }
function warn(msg: string) { log('yellow', `⚠️  ${msg}`); }
function error(msg: string) { log('red', `❌ ${msg}`); }
function success(msg: string) { log('green', `✅ ${msg}`); }
function debug(msg: string) { log('gray', `   ${msg}`); }

// =============================================================================
// Sharding Functions
// =============================================================================

function shard2Old(id: string): [string, string] {
  return [id.slice(0, 2), id.slice(2, 4)];
}

function shard2New(id: string): [string, string] {
  return [id.slice(-4, -2), id.slice(-2)];
}

function getOldPath(id: string, baseDir: string): string {
  const [a, b] = shard2Old(id);
  return `${baseDir}/${a}/${b}/${id}.tip`;
}

function getNewPath(id: string, baseDir: string): string {
  const [a, b] = shard2New(id);
  return `${baseDir}/${a}/${b}/${id}.tip`;
}

function getNewDir(id: string, baseDir: string): string {
  const [a, b] = shard2New(id);
  return `${baseDir}/${a}/${b}`;
}

// =============================================================================
// IPFS MFS Operations
// =============================================================================

async function mfsExists(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${IPFS_API}/files/stat?arg=${encodeURIComponent(path)}`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function mfsMkdir(path: string): Promise<void> {
  const res = await fetch(`${IPFS_API}/files/mkdir?arg=${encodeURIComponent(path)}&parents=true`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mkdir failed for ${path}: ${text}`);
  }
}

async function mfsMv(src: string, dst: string): Promise<void> {
  const res = await fetch(`${IPFS_API}/files/mv?arg=${encodeURIComponent(src)}&arg=${encodeURIComponent(dst)}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`mv failed ${src} -> ${dst}: ${text}`);
  }
}

async function mfsCp(src: string, dst: string): Promise<void> {
  const res = await fetch(`${IPFS_API}/files/cp?arg=${encodeURIComponent(src)}&arg=${encodeURIComponent(dst)}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cp failed ${src} -> ${dst}: ${text}`);
  }
}

// =============================================================================
// Snapshot Loading
// =============================================================================

interface SnapshotEntry {
  pi: string;
  ver: number;
  tip_cid: { '/': string };
  ts: string;
}

interface Snapshot {
  schema?: string;
  seq?: number;
  ts?: string;
  entries: SnapshotEntry[];
}

async function fetchSnapshot(): Promise<Snapshot> {
  info(`Fetching snapshot from ${BACKEND_API}/snapshot/latest...`);
  const res = await fetch(`${BACKEND_API}/snapshot/latest`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch snapshot: ${res.status} - ${text}`);
  }

  // Get metadata from headers
  const snapshotCid = res.headers.get('X-Snapshot-CID');
  const snapshotSeq = res.headers.get('X-Snapshot-Seq');
  const snapshotCount = res.headers.get('X-Snapshot-Count');

  if (snapshotCid) {
    info(`Snapshot CID: ${snapshotCid.slice(0, 20)}...`);
  }
  if (snapshotSeq && snapshotCount) {
    info(`Snapshot seq=${snapshotSeq}, count=${snapshotCount}`);
  }

  return await res.json();
}

// =============================================================================
// Migration Logic
// =============================================================================

interface MigrationResult {
  id: string;
  oldPath: string;
  newPath: string;
  status: 'migrated' | 'skipped' | 'error' | 'same';
  error?: string;
}

async function migrateOne(
  id: string,
  baseDir: string,
  execute: boolean
): Promise<MigrationResult> {
  const oldPath = getOldPath(id, baseDir);
  const newPath = getNewPath(id, baseDir);
  const newDir = getNewDir(id, baseDir);

  // If paths are the same, skip
  if (oldPath === newPath) {
    return { id, oldPath, newPath, status: 'same' };
  }

  // Check if old path exists
  const oldExists = await mfsExists(oldPath);
  if (!oldExists) {
    // Maybe already migrated? Check new path
    const newExists = await mfsExists(newPath);
    if (newExists) {
      return { id, oldPath, newPath, status: 'skipped' };
    }
    return { id, oldPath, newPath, status: 'error', error: 'Source not found' };
  }

  // Check if new path already exists (shouldn't happen normally)
  const newExists = await mfsExists(newPath);
  if (newExists) {
    return { id, oldPath, newPath, status: 'skipped' };
  }

  if (!execute) {
    return { id, oldPath, newPath, status: 'migrated' }; // Dry run
  }

  // Actually do the migration
  try {
    // Ensure new directory exists
    await mfsMkdir(newDir);

    // Move the file
    await mfsMv(oldPath, newPath);

    return { id, oldPath, newPath, status: 'migrated' };
  } catch (e) {
    return { id, oldPath, newPath, status: 'error', error: String(e) };
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : undefined;

  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  SHARD PATH MIGRATION');
  log('blue', '═'.repeat(70) + '\n');

  info(`IPFS API: ${IPFS_API}`);
  info(`Backend API: ${BACKEND_API}`);
  info(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  if (limit) {
    info(`Limit: ${limit} entries`);
  }
  console.log('');

  // Load snapshot from backend API
  const snapshot = await fetchSnapshot();
  success(`Loaded ${snapshot.entries.length} entries from snapshot`);
  console.log('');

  // Get entries to migrate
  let entries = snapshot.entries;
  if (limit) {
    entries = entries.slice(0, limit);
    info(`Processing first ${entries.length} entries (limit applied)`);
  }

  // Analyze what needs migration
  const baseDir = '/arke/index';
  const results: MigrationResult[] = [];

  log('magenta', '── Migration Progress ──\n');

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await migrateOne(entry.pi, baseDir, execute);
    results.push(result);

    // Progress indicator
    if ((i + 1) % 50 === 0 || i === entries.length - 1) {
      process.stdout.write(`\r  Processed ${i + 1}/${entries.length} entries...`);
    }
  }
  console.log('\n');

  // Summary
  const migrated = results.filter(r => r.status === 'migrated');
  const skipped = results.filter(r => r.status === 'skipped');
  const same = results.filter(r => r.status === 'same');
  const errors = results.filter(r => r.status === 'error');

  log('blue', '── Summary ──\n');
  console.log(`  Total processed: ${results.length}`);
  log('green', `  Migrated:        ${migrated.length}`);
  log('yellow', `  Skipped:         ${skipped.length} (already at new location)`);
  log('gray', `  Same path:       ${same.length} (no change needed)`);
  if (errors.length > 0) {
    log('red', `  Errors:          ${errors.length}`);
  }
  console.log('');

  // Show sample migrations
  if (migrated.length > 0) {
    log('cyan', '── Sample Migrations ──\n');
    const samples = migrated.slice(0, 5);
    for (const m of samples) {
      console.log(`  ${m.id.slice(0, 12)}...`);
      log('gray', `    ${m.oldPath}`);
      log('green', `    → ${m.newPath}`);
    }
    if (migrated.length > 5) {
      log('gray', `  ... and ${migrated.length - 5} more`);
    }
    console.log('');
  }

  // Show errors if any
  if (errors.length > 0) {
    log('red', '── Errors ──\n');
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${e.id}: ${e.error}`);
    }
    if (errors.length > 10) {
      log('gray', `  ... and ${errors.length - 10} more errors`);
    }
    console.log('');
  }

  // Final message
  if (!execute && migrated.length > 0) {
    log('yellow', '⚠️  DRY RUN - No changes made. Run with --execute to apply changes.\n');
  } else if (execute && migrated.length > 0) {
    success(`Migration complete! ${migrated.length} files moved.\n`);
  } else {
    success('No migration needed!\n');
  }
}

main().catch(e => {
  error(`Fatal error: ${e}`);
  process.exit(1);
});
