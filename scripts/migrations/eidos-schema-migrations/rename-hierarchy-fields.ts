#!/usr/bin/env tsx
/**
 * Migration Script: Rename hierarchy fields
 *
 * This script renames fields in all entities:
 * - parent_pi → source_pi (provenance)
 * - hierarchy_parent → parent_pi (tree parent)
 * - children_pi → unchanged
 *
 * Usage:
 *   npx tsx scripts/migrations/rename-hierarchy-fields.ts --dry-run    # Preview changes
 *   npx tsx scripts/migrations/rename-hierarchy-fields.ts --sample 10  # Migrate 10 entities
 *   npx tsx scripts/migrations/rename-hierarchy-fields.ts --all        # Migrate all entities
 *
 * Safety features:
 * - Dry-run mode (default): Shows what would be migrated without writing
 * - Sample mode: Migrate only N entities for testing
 * - Backs up original tips before migration (writes to /tmp/field-rename-backup.json)
 * - Creates new versions (preserves complete version history)
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
  migrated: 0,
  skipped: 0, // Already has new field names
  failed: 0,
};

const backup: Array<{ id: string; tipCid: string }> = [];

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

  const response = await fetch(`${IPFS_API_URL}/api/v0/dag/put?store-codec=dag-json&input-codec=dag-json&pin=true`, {
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
  // Compute shard path
  const shard1 = id.slice(-4, -2);
  const shard2 = id.slice(-2);
  const tipPath = `/arke/index/${shard1}/${shard2}/${id}.tip`;

  // Ensure parent directories exist
  await fetch(`${IPFS_API_URL}/api/v0/files/mkdir?arg=/arke&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/api/v0/files/mkdir?arg=/arke/index&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/api/v0/files/mkdir?arg=/arke/index/${shard1}&parents=true`, { method: 'POST' });
  await fetch(`${IPFS_API_URL}/api/v0/files/mkdir?arg=/arke/index/${shard1}/${shard2}&parents=true`, { method: 'POST' });

  // Write tip file (overwrite if exists)
  const formData = new FormData();
  formData.append('file', new Blob([tipCid], { type: 'text/plain' }));

  const response = await fetch(
    `${IPFS_API_URL}/api/v0/files/write?arg=${encodeURIComponent(tipPath)}&create=true&truncate=true`,
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

async function fetchAllEntities(): Promise<Entity[]> {
  console.log('Fetching all entities from snapshot...');
  const snapshot = await fetchSnapshot();

  // Map snapshot entries to Entity interface
  const entities = snapshot.entries.map((entry: SnapshotEntry) => ({
    id: entry.pi,
    tip: entry.tip_cid['/'],
  }));

  console.log(`Fetched ${entities.length} entities from snapshot`);
  return entities;
}

async function migrateEntity(entity: Entity, dryRun: boolean): Promise<void> {
  try {
    // Fetch current manifest
    const oldManifest = await fetchDag(entity.tip);

    // Skip if schema is not arke/eidos@v1
    if (oldManifest.schema !== 'arke/eidos@v1') {
      console.log(`  [SKIP] ${entity.id}: Not eidos@v1 schema (${oldManifest.schema})`);
      stats.skipped++;
      return;
    }

    // Check if already migrated (has source_pi field, no hierarchy_parent field)
    const hasOldFields = oldManifest.hierarchy_parent !== undefined ||
                         (oldManifest.parent_pi !== undefined && oldManifest.source_pi === undefined);
    const hasNewFields = oldManifest.source_pi !== undefined ||
                         (oldManifest.parent_pi !== undefined && oldManifest.hierarchy_parent === undefined);

    if (!hasOldFields && hasNewFields) {
      console.log(`  [SKIP] ${entity.id}: Already has new field names`);
      stats.skipped++;
      return;
    }

    // Create new manifest with renamed fields
    const newManifest = {
      ...oldManifest,
      ver: oldManifest.ver + 1,
      ts: new Date().toISOString(),
      prev: { '/': entity.tip },
      // Rename fields
      ...(oldManifest.parent_pi !== undefined && { source_pi: oldManifest.parent_pi }),
      ...(oldManifest.hierarchy_parent !== undefined && { parent_pi: oldManifest.hierarchy_parent }),
      note: 'Field rename migration: parent_pi→source_pi, hierarchy_parent→parent_pi',
    };

    // Remove old field names
    delete (newManifest as any).hierarchy_parent;
    if (oldManifest.hierarchy_parent !== undefined) {
      // Only delete old parent_pi if we had hierarchy_parent (otherwise we renamed it to source_pi)
      delete (newManifest as any).parent_pi;
      // And set the new parent_pi from hierarchy_parent
      newManifest.parent_pi = oldManifest.hierarchy_parent;
    } else if (oldManifest.parent_pi !== undefined) {
      // We had parent_pi but no hierarchy_parent, so parent_pi→source_pi
      delete (newManifest as any).parent_pi;
      newManifest.source_pi = oldManifest.parent_pi;
    }

    if (dryRun) {
      console.log(`  [DRY-RUN] ${entity.id}: Would migrate v${oldManifest.ver} → v${newManifest.ver}`);
      if (oldManifest.parent_pi) console.log(`    - parent_pi: ${oldManifest.parent_pi} → source_pi: ${newManifest.source_pi}`);
      if (oldManifest.hierarchy_parent) console.log(`    - hierarchy_parent: ${oldManifest.hierarchy_parent} → parent_pi: ${newManifest.parent_pi}`);
      stats.migrated++;
      return;
    }

    // Backup original tip
    backup.push({ id: entity.id, tipCid: entity.tip });

    // Write new manifest to IPFS
    const newTipCid = await putDag(newManifest);

    // Update tip
    await writeTip(entity.id, newTipCid);

    console.log(`  [SUCCESS] ${entity.id}: Migrated v${oldManifest.ver} → v${newManifest.ver} (${entity.tip} → ${newTipCid})`);
    stats.migrated++;
  } catch (error: any) {
    console.error(`  [ERROR] ${entity.id}: ${error.message}`);
    stats.failed++;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--all');
  const sampleSize = args.includes('--sample') ? parseInt(args[args.indexOf('--sample') + 1]) : 0;

  console.log('='.repeat(80));
  console.log('Field Rename Migration Script');
  console.log('='.repeat(80));
  console.log(`Mode: ${dryRun ? 'DRY-RUN (preview only)' : 'LIVE (will write changes)'}`);
  if (sampleSize > 0) {
    console.log(`Sample size: ${sampleSize} entities`);
  }
  console.log('='.repeat(80));
  console.log();

  // Fetch all entities
  const allEntities = await fetchAllEntities();
  stats.total = allEntities.length;

  // Determine entities to migrate
  const entitiesToMigrate = sampleSize > 0 ? allEntities.slice(0, sampleSize) : allEntities;

  console.log(`Migrating ${entitiesToMigrate.length} of ${allEntities.length} entities...`);
  console.log();

  // Migrate entities
  for (const entity of entitiesToMigrate) {
    await migrateEntity(entity, dryRun);
  }

  // Write backup file
  if (!dryRun && backup.length > 0) {
    const backupPath = '/tmp/field-rename-backup.json';
    await Bun.write(backupPath, JSON.stringify(backup, null, 2));
    console.log();
    console.log(`Backup written to: ${backupPath}`);
  }

  // Print summary
  console.log();
  console.log('='.repeat(80));
  console.log('Migration Summary');
  console.log('='.repeat(80));
  console.log(`Total entities:        ${stats.total}`);
  console.log(`Migrated:              ${stats.migrated}`);
  console.log(`Skipped:               ${stats.skipped}`);
  console.log(`Failed:                ${stats.failed}`);
  console.log('='.repeat(80));

  if (dryRun) {
    console.log();
    console.log('This was a DRY-RUN. No changes were written.');
    console.log('To apply changes, run with --all flag');
    console.log('To test with a sample, run with --sample N flag');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
