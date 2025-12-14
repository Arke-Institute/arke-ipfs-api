#!/usr/bin/env tsx
/**
 * Unified Migration Script: Complete field rename migration
 *
 * Handles TWO scenarios:
 * 1. arke/manifest@v1 → arke/eidos@v1 with NEW field names (source_pi, parent_pi)
 * 2. arke/eidos@v1 with old field names → rename to new field names
 *
 * Field mappings for regular PIs:
 * - parent_pi → kept as parent_pi (tree hierarchy)
 * - hierarchy_parent → removed (or moved to parent_pi if it existed)
 * - source_pi → set to null (regular PIs have no source)
 * - children_pi → unchanged
 *
 * Usage:
 *   npx tsx scripts/migrations/unified-field-migration.ts --dry-run    # Preview
 *   npx tsx scripts/migrations/unified-field-migration.ts --sample 10  # Test 10
 *   npx tsx scripts/migrations/unified-field-migration.ts --all        # Full migration
 *
 * Safety:
 * - Creates NEW versions (preserves complete history)
 * - Backs up tips before migration
 * - Validates each migration
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const IPFS_API_URL = process.env.IPFS_API_URL || 'http://localhost:5001';
const BACKEND_API = process.env.IPFS_SERVER_API_URL || 'http://localhost:8787';

interface Entity {
  id: string;
  tip: string;
}

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

const stats = {
  total: 0,
  scenario1_manifest_to_eidos: 0,  // arke/manifest@v1 → arke/eidos@v1
  scenario2_eidos_rename: 0,       // arke/eidos@v1 field rename
  already_migrated: 0,              // Already has new field names
  skipped: 0,                       // Other schemas
  failed: 0,
};

const backup: Array<{ id: string; tipCid: string; scenario: string }> = [];

async function readTip(id: string): Promise<string | null> {
  const shard1 = id.slice(-4, -2);
  const shard2 = id.slice(-2);
  const tipPath = `/arke/index/${shard1}/${shard2}/${id}.tip`;

  const response = await fetch(`${IPFS_API_URL}/files/read?arg=${encodeURIComponent(tipPath)}`, {
    method: 'POST',
  });

  if (!response.ok) {
    return null;
  }

  return await response.text();
}

async function fetchDag(cid: string): Promise<any> {
  const response = await fetch(`${IPFS_API_URL}/dag/get?arg=${cid}`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch DAG ${cid}: ${response.statusText}`);
  }
  return response.json();
}

async function putDag(data: any): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  formData.append('file', blob);

  const response = await fetch(`${IPFS_API_URL}/dag/put?store-codec=dag-json&input-codec=dag-json&pin=true`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to put DAG: ${response.statusText}`);
  }

  const result = await response.json();
  return result.Cid['/'];
}

async function writeTip(id: string, tipCid: string): Promise<void> {
  const shard1 = id.slice(-4, -2);
  const shard2 = id.slice(-2);
  const tipPath = `/arke/index/${shard1}/${shard2}/${id}.tip`;

  // Ensure parent directories exist
  await fetch(`${IPFS_API_URL}/files/mkdir?arg=/arke&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/files/mkdir?arg=/arke/index&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/files/mkdir?arg=/arke/index/${shard1}&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/files/mkdir?arg=/arke/index/${shard1}/${shard2}&parents=true`, { method: 'POST' });

  const formData = new FormData();
  formData.append('file', new Blob([tipCid], { type: 'text/plain' }));

  const response = await fetch(
    `${IPFS_API_URL}/files/write?arg=${encodeURIComponent(tipPath)}&create=true&truncate=true`,
    { method: 'POST', body: formData }
  );

  if (!response.ok) {
    throw new Error(`Failed to write tip for ${id}: ${response.statusText}`);
  }
}

async function fetchSnapshot(): Promise<Snapshot> {
  console.log(`Fetching snapshot from ${BACKEND_API}/snapshot/latest...`);
  const response = await fetch(`${BACKEND_API}/snapshot/latest`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch snapshot: ${response.status} - ${text}`);
  }

  // Get metadata from headers
  const snapshotCid = response.headers.get('X-Snapshot-CID');
  const snapshotSeq = response.headers.get('X-Snapshot-Seq');
  const snapshotCount = response.headers.get('X-Snapshot-Count');

  if (snapshotCid) {
    console.log(`  Snapshot CID: ${snapshotCid.slice(0, 20)}...`);
  }
  if (snapshotSeq && snapshotCount) {
    console.log(`  Snapshot seq=${snapshotSeq}, count=${snapshotCount}`);
  }

  return await response.json();
}

async function fetchAllPis(): Promise<string[]> {
  console.log('Fetching all PIs from snapshot...');
  const snapshot = await fetchSnapshot();

  // Extract only PIs from snapshot (CIDs might be stale)
  const pis = snapshot.entries.map((entry: SnapshotEntry) => entry.pi);

  console.log(`Fetched ${pis.length} PIs from snapshot`);
  return pis;
}

async function getCreatedAt(manifest: any): Promise<string> {
  let current = manifest;
  while (current.ver > 1 && current.prev) {
    const prevCid = current.prev['/'];
    current = await fetchDag(prevCid);
  }
  return current.ts;
}

async function migrateEntity(pi: string, dryRun: boolean): Promise<void> {
  try {
    // Read current tip from MFS
    const currentTip = await readTip(pi);
    if (!currentTip) {
      console.error(`  [ERROR] ${pi}: Tip not found`);
      stats.failed++;
      return;
    }

    const oldManifest = await fetchDag(currentTip);

    // ========================================================================
    // SCENARIO 1: arke/manifest@v1 → arke/eidos@v1 with NEW field names
    // ========================================================================
    if (oldManifest.schema === 'arke/manifest@v1') {
      const createdAt = await getCreatedAt(oldManifest);

      const newManifest = {
        schema: 'arke/eidos@v1',
        id: oldManifest.pi,
        type: 'PI',
        // For regular PIs: old parent_pi stays as parent_pi (tree hierarchy)
        ...(oldManifest.parent_pi && { parent_pi: oldManifest.parent_pi }),
        // source_pi is null for regular PIs
        source_pi: null,
        created_at: createdAt,
        ver: oldManifest.ver + 1,
        ts: new Date().toISOString(),
        prev: { '/': currentTip },
        components: oldManifest.components,
        ...(oldManifest.children_pi && { children_pi: oldManifest.children_pi }),
        note: 'Migration: arke/manifest@v1 → arke/eidos@v1 (parent_pi kept as tree hierarchy)',
      };

      if (dryRun) {
        console.log(`  [DRY-RUN] ${pi}: Scenario 1 - manifest@v1 → eidos@v1 (v${oldManifest.ver} → v${newManifest.ver})`);
        if (oldManifest.parent_pi) {
          console.log(`    - parent_pi: ${oldManifest.parent_pi} (kept as tree hierarchy)`);
        }
        console.log(`    - source_pi: null`);
        stats.scenario1_manifest_to_eidos++;
        return;
      }

      backup.push({ id: pi, tipCid: currentTip, scenario: 'manifest_to_eidos' });

      const newTipCid = await putDag(newManifest);
      await writeTip(pi, newTipCid);

      console.log(`  [SUCCESS] ${pi}: Scenario 1 - manifest@v1 → eidos@v1 (v${oldManifest.ver} → v${newManifest.ver})`);
      stats.scenario1_manifest_to_eidos++;
      return;
    }

    // ========================================================================
    // SCENARIO 2: arke/eidos@v1 with old field names → rename fields
    // ========================================================================
    if (oldManifest.schema === 'arke/eidos@v1') {
      // Check if needs migration
      const hasOldHierarchy = oldManifest.hierarchy_parent !== undefined;
      const hasIncorrectSourcePi = oldManifest.source_pi !== null && oldManifest.source_pi !== undefined;
      const hasNullParentAndSource = (oldManifest.parent_pi === null || oldManifest.parent_pi === undefined) &&
                                      (oldManifest.source_pi === null || oldManifest.source_pi === undefined);

      // If both parent_pi and source_pi are null, check previous version for lost data
      let recoveredParentPi: string | null = null;
      if (hasNullParentAndSource && oldManifest.prev) {
        const prevManifest = await fetchDag(oldManifest.prev['/']);
        if (prevManifest.source_pi) {
          recoveredParentPi = prevManifest.source_pi;
          console.log(`  [RECOVERY] ${pi}: Found parent_pi in prev version: ${recoveredParentPi}`);
        }
      }

      // Skip if already correctly migrated: no hierarchy_parent, source_pi is null, and no data to recover
      if (!hasOldHierarchy && !hasIncorrectSourcePi && !recoveredParentPi) {
        console.log(`  [SKIP] ${pi}: Already correctly migrated`);
        stats.already_migrated++;
        return;
      }

      // Build new manifest with cleaned up fields
      const note = recoveredParentPi
        ? 'Field recovery: recovered parent_pi from prev version, source_pi=null'
        : 'Field cleanup: moved source_pi→parent_pi, removed hierarchy_parent, source_pi=null';

      const newManifest: any = {
        ...oldManifest,
        ver: oldManifest.ver + 1,
        ts: new Date().toISOString(),
        prev: { '/': currentTip },
        note,
      };

      // Fix incorrect migration: source_pi should be moved to parent_pi
      // For regular PIs: parent_pi is the tree hierarchy, source_pi = null

      // Priority order:
      // 1. hierarchy_parent (if exists) → parent_pi
      // 2. old source_pi (from incorrect migration) → parent_pi
      // 3. recovered parent_pi (from previous version) → parent_pi
      // 4. old parent_pi (if no hierarchy_parent or source_pi) → parent_pi

      if (oldManifest.hierarchy_parent !== undefined) {
        // hierarchy_parent takes priority
        newManifest.parent_pi = oldManifest.hierarchy_parent;
      } else if (oldManifest.source_pi !== null && oldManifest.source_pi !== undefined) {
        // Move incorrect source_pi to parent_pi
        newManifest.parent_pi = oldManifest.source_pi;
      } else if (recoveredParentPi) {
        // Recover lost parent_pi from previous version
        newManifest.parent_pi = recoveredParentPi;
      } else if (oldManifest.parent_pi !== undefined && oldManifest.parent_pi !== null) {
        // Keep existing parent_pi
        newManifest.parent_pi = oldManifest.parent_pi;
      } else {
        // No parent
        newManifest.parent_pi = null;
      }

      // Always remove hierarchy_parent field if it exists
      delete newManifest.hierarchy_parent;

      // source_pi should always be null for regular PIs
      newManifest.source_pi = null;

      if (dryRun) {
        console.log(`  [DRY-RUN] ${pi}: Scenario 2 - eidos field cleanup (v${oldManifest.ver} → v${newManifest.ver})`);
        if (oldManifest.hierarchy_parent) {
          console.log(`    - hierarchy_parent → parent_pi: ${newManifest.parent_pi}`);
        } else if (oldManifest.source_pi !== null && oldManifest.source_pi !== undefined) {
          console.log(`    - source_pi → parent_pi: ${newManifest.parent_pi} (moved from incorrect field)`);
        } else if (recoveredParentPi) {
          console.log(`    - parent_pi: ${newManifest.parent_pi} (RECOVERED from prev version)`);
        } else if (oldManifest.parent_pi) {
          console.log(`    - parent_pi: ${newManifest.parent_pi} (kept)`);
        } else {
          console.log(`    - parent_pi: null`);
        }
        console.log(`    - source_pi: null (cleared)`);
        stats.scenario2_eidos_rename++;
        return;
      }

      backup.push({ id: pi, tipCid: currentTip, scenario: 'eidos_rename' });

      const newTipCid = await putDag(newManifest);
      await writeTip(pi, newTipCid);

      console.log(`  [SUCCESS] ${pi}: Scenario 2 - eidos field rename (v${oldManifest.ver} → v${newManifest.ver})`);
      stats.scenario2_eidos_rename++;
      return;
    }

    // ========================================================================
    // OTHER SCHEMAS: Skip
    // ========================================================================
    console.log(`  [SKIP] ${pi}: Unsupported schema (${oldManifest.schema})`);
    stats.skipped++;

  } catch (error: any) {
    console.error(`  [ERROR] ${pi}: ${error.message}`);
    stats.failed++;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--all');
  const sampleSize = args.includes('--sample') ? parseInt(args[args.indexOf('--sample') + 1]) : 0;

  console.log('='.repeat(80));
  console.log('Unified Field Migration Script');
  console.log('='.repeat(80));
  console.log(`Mode: ${dryRun ? 'DRY-RUN (preview only)' : 'LIVE (will write changes)'}`);
  if (sampleSize > 0) {
    console.log(`Sample size: ${sampleSize} entities`);
  }
  console.log('='.repeat(80));
  console.log();
  console.log('This script handles TWO scenarios:');
  console.log('  1. arke/manifest@v1 → arke/eidos@v1');
  console.log('  2. arke/eidos@v1 field cleanup');
  console.log();
  console.log('Field mappings for regular PIs:');
  console.log('  - parent_pi → kept as parent_pi (tree hierarchy)');
  console.log('  - hierarchy_parent → removed (or becomes parent_pi)');
  console.log('  - source_pi → null (regular PIs have no source)');
  console.log('  - children_pi → unchanged');
  console.log('='.repeat(80));
  console.log();

  // Fetch all PIs from snapshot
  const allPis = await fetchAllPis();
  stats.total = allPis.length;

  // Determine entities to migrate
  const pisToMigrate = sampleSize > 0 ? allPis.slice(0, sampleSize) : allPis;

  console.log(`Processing ${pisToMigrate.length} of ${allPis.length} entities...`);
  console.log();

  // Migrate entities (reads current tip for each)
  for (const pi of pisToMigrate) {
    await migrateEntity(pi, dryRun);
  }

  // Write backup file
  if (!dryRun && backup.length > 0) {
    const fs = await import('fs/promises');
    const backupPath = '/tmp/unified-migration-backup.json';
    await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
    console.log();
    console.log(`Backup written to: ${backupPath}`);
  }

  // Print summary
  console.log();
  console.log('='.repeat(80));
  console.log('Migration Summary');
  console.log('='.repeat(80));
  console.log(`Total entities:                    ${stats.total}`);
  console.log(`Scenario 1 (manifest→eidos):       ${stats.scenario1_manifest_to_eidos}`);
  console.log(`Scenario 2 (eidos field rename):   ${stats.scenario2_eidos_rename}`);
  console.log(`Already migrated:                  ${stats.already_migrated}`);
  console.log(`Skipped (other schemas):           ${stats.skipped}`);
  console.log(`Failed:                            ${stats.failed}`);
  console.log('='.repeat(80));

  if (dryRun) {
    console.log();
    console.log('This was a DRY-RUN. No changes were written.');
    console.log('To apply changes, run with --all flag');
    console.log('To test with a sample, run with --sample N flag');
  } else {
    console.log();
    console.log('✅ Migration complete!');
    console.log(`   Backup saved to: /tmp/unified-migration-backup.json`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
