#!/usr/bin/env tsx
/**
 * Migration Script: arke/manifest@v1 → arke/eidos@v1 (Sequential, One-by-One)
 *
 * Migrates entities sequentially using the production API.
 * Tracks progress in a JSON file so migration can be resumed if interrupted.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-eidos-sequential.ts                # Migrate all (dry run)
 *   npx tsx scripts/migrate-to-eidos-sequential.ts --execute      # Actually migrate
 *   npx tsx scripts/migrate-to-eidos-sequential.ts --resume       # Resume from last run
 *   npx tsx scripts/migrate-to-eidos-sequential.ts --execute --resume  # Resume and execute
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API endpoints
const API_ENDPOINT = process.env.API_ENDPOINT || 'https://api.arke.institute';
const BACKEND_API = process.env.IPFS_SERVER_API_URL || 'https://ipfs-api.arke.institute';
const PROGRESS_FILE = path.join(__dirname, '.migration-progress.json');

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

  return await res.json();
}

// =============================================================================
// Progress Tracking
// =============================================================================

interface MigrationProgress {
  started_at: string;
  last_updated: string;
  total_entities: number;
  processed: string[];  // PIs that have been processed (success or fail)
  succeeded: string[];  // PIs that migrated successfully
  already_migrated: string[];  // PIs that were already on eidos
  failed: { pi: string; error: string }[];
}

async function loadProgress(): Promise<MigrationProgress | null> {
  try {
    const content = await fs.readFile(PROGRESS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveProgress(progress: MigrationProgress): Promise<void> {
  progress.last_updated = new Date().toISOString();
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function createNewProgress(totalEntities: number): MigrationProgress {
  return {
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    total_entities: totalEntities,
    processed: [],
    succeeded: [],
    already_migrated: [],
    failed: [],
  };
}

// =============================================================================
// Migration API Call
// =============================================================================

interface MigrationResult {
  pi: string;
  status: 'migrated' | 'already_migrated' | 'failed';
  error?: string;
}

async function migrateOne(pi: string, dryRun: boolean): Promise<MigrationResult> {
  try {
    const res = await fetch(`${API_ENDPOINT}/migrate/${pi}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        pi,
        status: 'failed',
        error: `HTTP ${res.status}: ${text}`,
      };
    }

    const result = await res.json();

    if (result.message === 'Entity already migrated') {
      return { pi, status: 'already_migrated' };
    }

    return { pi, status: 'migrated' };
  } catch (err: any) {
    return {
      pi,
      status: 'failed',
      error: err.message,
    };
  }
}

// =============================================================================
// Main Migration Logic
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const resume = args.includes('--resume');

  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  EIDOS SCHEMA MIGRATION (SEQUENTIAL)');
  log('blue', '═'.repeat(70) + '\n');

  info(`API Endpoint: ${API_ENDPOINT}`);
  info(`Backend API: ${BACKEND_API}`);
  info(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  info(`Resume: ${resume ? 'YES' : 'NO'}`);
  console.log('');

  // Load or create progress
  let progress: MigrationProgress;

  if (resume) {
    const existing = await loadProgress();
    if (existing) {
      progress = existing;
      info(`Resuming from previous run (started ${progress.started_at})`);
      info(`Already processed: ${progress.processed.length}/${progress.total_entities}`);
      console.log('');
    } else {
      warn('No previous progress found, starting fresh');
      console.log('');
      const snapshot = await fetchSnapshot();
      const entities = snapshot.entries
        .map(e => e.pi)
        .filter(pi => !pi.startsWith('II'));
      progress = createNewProgress(entities.length);
    }
  } else {
    // Fetch snapshot
    const snapshot = await fetchSnapshot();
    success(`Loaded ${snapshot.entries.length} entries from snapshot`);
    console.log('');

    // Filter to main network only
    const entities = snapshot.entries
      .map(e => e.pi)
      .filter(pi => !pi.startsWith('II'));

    info(`Filtered to ${entities.length} main network entities`);
    console.log('');

    progress = createNewProgress(entities.length);
  }

  // Get all entities
  const snapshot = await fetchSnapshot();
  const allEntities = snapshot.entries
    .map(e => e.pi)
    .filter(pi => !pi.startsWith('II'));

  // Get entities to process (skip already processed)
  const toProcess = allEntities.filter(pi => !progress.processed.includes(pi));

  if (toProcess.length === 0) {
    success('All entities already processed!');
    console.log('');
    printSummary(progress);
    return;
  }

  info(`Processing ${toProcess.length} remaining entities...`);
  console.log('');

  log('magenta', '── Migration Progress ──\n');

  // Process each entity
  let count = 0;
  for (const pi of toProcess) {
    count++;
    const result = await migrateOne(pi, !execute);

    // Update progress
    progress.processed.push(pi);

    if (result.status === 'migrated') {
      progress.succeeded.push(pi);
      process.stdout.write(`\r  [${count}/${toProcess.length}] ${pi}: ✅ migrated`);
    } else if (result.status === 'already_migrated') {
      progress.already_migrated.push(pi);
      process.stdout.write(`\r  [${count}/${toProcess.length}] ${pi}: ⏭️  already migrated`);
    } else {
      progress.failed.push({ pi, error: result.error || 'Unknown error' });
      process.stdout.write(`\r  [${count}/${toProcess.length}] ${pi}: ❌ ${result.error?.slice(0, 50)}`);
    }

    console.log(''); // New line after each entity

    // Save progress every 10 entities
    if (count % 10 === 0) {
      await saveProgress(progress);
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Final save
  await saveProgress(progress);

  console.log('\n');
  printSummary(progress);
}

function printSummary(progress: MigrationProgress) {
  log('blue', '── Summary ──\n');
  console.log(`  Total entities:     ${progress.total_entities}`);
  console.log(`  Processed:          ${progress.processed.length}`);
  log('green', `  Migrated:           ${progress.succeeded.length}`);
  log('cyan', `  Already migrated:   ${progress.already_migrated.length}`);
  if (progress.failed.length > 0) {
    log('red', `  Failed:             ${progress.failed.length}`);
  }
  console.log('');

  // Show failed entities
  if (progress.failed.length > 0) {
    log('red', '── Failed Entities ──\n');
    for (const f of progress.failed.slice(0, 10)) {
      console.log(`  ${f.pi}: ${f.error}`);
    }
    if (progress.failed.length > 10) {
      log('gray', `  ... and ${progress.failed.length - 10} more`);
    }
    console.log('');
  }

  info(`Progress saved to: ${PROGRESS_FILE}`);
  console.log('');
}

main().catch(e => {
  error(`Fatal error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
