#!/usr/bin/env tsx
/**
 * Migration Script: arke/manifest@v1 → arke/eidos@v1 (Batch)
 *
 * Migrates all entities from old schemas to the unified Eidos schema.
 * Uses the /migrate/batch endpoint for efficient batch processing.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-eidos-batch.ts                # Dry run (all entities)
 *   npx tsx scripts/migrate-to-eidos-batch.ts --limit 100    # Dry run (first 100)
 *   npx tsx scripts/migrate-to-eidos-batch.ts --execute      # Actually migrate all
 *   npx tsx scripts/migrate-to-eidos-batch.ts --execute --limit 500  # Migrate first 500
 */

// API endpoints
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
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
// Migration API Calls
// =============================================================================

interface MigrationBatchRequest {
  pis: string[];
  dry_run?: boolean;
}

interface MigrationBatchResult {
  pi: string;
  status: 'migrated' | 'already_migrated' | 'would_migrate' | 'failed' | 'not_found' | 'unsupported_schema';
  from?: string;
  to?: string;
  new_tip?: string;
  error?: string;
  schema?: string;
}

interface MigrationBatchResponse {
  dry_run: boolean;
  summary: {
    total: number;
    already_migrated: number;
    migrated: number;
    would_migrate: number;
    failed: number;
    not_found: number;
    unsupported: number;
  };
  results: MigrationBatchResult[];
}

async function migrateBatch(pis: string[], dryRun: boolean): Promise<MigrationBatchResponse> {
  const res = await fetch(`${API_ENDPOINT}/migrate/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pis,
      dry_run: dryRun,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Batch migration failed: ${res.status} - ${text}`);
  }

  return await res.json();
}

// =============================================================================
// Main Migration Logic
// =============================================================================

interface AggregateStats {
  total: number;
  already_migrated: number;
  migrated: number;
  would_migrate: number;
  failed: number;
  not_found: number;
  unsupported: number;
  batches_processed: number;
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : undefined;

  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  EIDOS SCHEMA MIGRATION (BATCH)');
  log('blue', '═'.repeat(70) + '\n');

  info(`API Endpoint: ${API_ENDPOINT}`);
  info(`Backend API: ${BACKEND_API}`);
  info(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  if (limit) {
    info(`Limit: ${limit} entities`);
  }
  console.log('');

  // Load snapshot
  const snapshot = await fetchSnapshot();
  success(`Loaded ${snapshot.entries.length} entries from snapshot`);
  console.log('');

  // Filter to main network only (skip test entities starting with 'II')
  let entities = snapshot.entries
    .map(e => e.pi)
    .filter(pi => !pi.startsWith('II'));

  info(`Filtered to ${entities.length} main network entities`);

  // Apply limit if specified
  if (limit && limit < entities.length) {
    entities = entities.slice(0, limit);
    info(`Limited to first ${entities.length} entities`);
  }
  console.log('');

  // Process in batches of 10 (smaller to avoid worker timeout)
  const BATCH_SIZE = 10;
  const batches: string[][] = [];
  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    batches.push(entities.slice(i, i + BATCH_SIZE));
  }

  info(`Processing ${entities.length} entities in ${batches.length} batches of ${BATCH_SIZE}`);
  console.log('');

  // Aggregate stats
  const stats: AggregateStats = {
    total: 0,
    already_migrated: 0,
    migrated: 0,
    would_migrate: 0,
    failed: 0,
    not_found: 0,
    unsupported: 0,
    batches_processed: 0,
  };

  const allResults: MigrationBatchResult[] = [];
  const failedResults: MigrationBatchResult[] = [];

  log('magenta', '── Migration Progress ──\n');

  // Process each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNum = i + 1;
    const totalBatches = batches.length;

    try {
      const response = await migrateBatch(batch, !execute);

      // Aggregate stats
      stats.total += response.summary.total;
      stats.already_migrated += response.summary.already_migrated;
      stats.migrated += response.summary.migrated;
      stats.would_migrate += response.summary.would_migrate;
      stats.failed += response.summary.failed;
      stats.not_found += response.summary.not_found;
      stats.unsupported += response.summary.unsupported;
      stats.batches_processed++;

      // Collect results
      allResults.push(...response.results);
      failedResults.push(...response.results.filter(r => r.status === 'failed'));

      // Progress indicator
      const processedCount = Math.min((i + 1) * BATCH_SIZE, entities.length);
      process.stdout.write(
        `\r  Batch ${batchNum}/${totalBatches} - Processed ${processedCount}/${entities.length} entities...`
      );

      // Small delay between batches to avoid overwhelming the worker
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (err: any) {
      error(`\nBatch ${batchNum} failed: ${err.message}`);
      console.error('Full error:', err);
      stats.failed += batch.length;
      stats.batches_processed++;

      // Continue with next batch after error
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log('\n');

  // Summary
  log('blue', '── Summary ──\n');
  console.log(`  Total entities:     ${stats.total}`);
  log('green', `  Migrated:           ${stats.migrated}`);
  log('cyan', `  Would migrate:      ${stats.would_migrate}`);
  log('yellow', `  Already migrated:   ${stats.already_migrated}`);
  if (stats.failed > 0) {
    log('red', `  Failed:             ${stats.failed}`);
  }
  if (stats.not_found > 0) {
    log('gray', `  Not found:          ${stats.not_found}`);
  }
  if (stats.unsupported > 0) {
    log('red', `  Unsupported schema: ${stats.unsupported}`);
  }
  console.log(`  Batches processed:  ${stats.batches_processed}/${batches.length}`);
  console.log('');

  // Show sample migrations
  const migratedResults = allResults.filter(
    r => r.status === 'migrated' || r.status === 'would_migrate'
  );

  if (migratedResults.length > 0) {
    log('cyan', '── Sample Migrations ──\n');
    const samples = migratedResults.slice(0, 5);
    for (const m of samples) {
      console.log(`  ${m.pi.slice(0, 12)}...`);
      log('gray', `    ${m.from} → ${m.to}`);
      if (m.new_tip) {
        log('green', `    tip: ${m.new_tip.slice(0, 20)}...`);
      }
    }
    if (migratedResults.length > 5) {
      log('gray', `  ... and ${migratedResults.length - 5} more`);
    }
    console.log('');
  }

  // Show errors if any
  if (failedResults.length > 0) {
    log('red', '── Errors ──\n');
    for (const e of failedResults.slice(0, 10)) {
      console.log(`  ${e.pi}: ${e.error || 'Unknown error'}`);
    }
    if (failedResults.length > 10) {
      log('gray', `  ... and ${failedResults.length - 10} more errors`);
    }
    console.log('');
  }

  // Final message
  if (!execute && (stats.would_migrate > 0 || stats.migrated > 0)) {
    log('yellow', '⚠️  DRY RUN - No changes made. Run with --execute to apply changes.\n');
  } else if (execute && stats.migrated > 0) {
    success(`Migration complete! ${stats.migrated} entities migrated to arke/eidos@v1.\n`);
  } else if (stats.already_migrated === stats.total) {
    success('All entities already migrated to arke/eidos@v1!\n');
  } else {
    success('Migration complete!\n');
  }

  // Exit with error if there were failures
  if (stats.failed > 0) {
    error(`${stats.failed} entities failed to migrate. Review errors above.`);
    process.exit(1);
  }
}

main().catch(e => {
  error(`Fatal error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
