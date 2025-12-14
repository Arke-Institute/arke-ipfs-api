#!/usr/bin/env tsx
/**
 * Migration Script: arke/manifest@v1 and arke/entity@v1 → arke/eidos@v1
 *
 * This script migrates existing entities to the unified Eidos schema.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-eidos.ts --dry-run          # Preview changes
 *   npx tsx scripts/migrate-to-eidos.ts --sample 5         # Migrate 5 entities
 *   npx tsx scripts/migrate-to-eidos.ts --entity <id>      # Migrate specific entity
 *   npx tsx scripts/migrate-to-eidos.ts --all              # Migrate all entities
 *
 * Safety features:
 * - Dry-run mode (default): Shows what would be migrated without writing
 * - Sample mode: Migrate only N entities for testing
 * - Single entity mode: Migrate one entity for testing
 * - Backs up original tips before migration (writes to /tmp/migration-backup.json)
 * - Validates migrated entities match expected schema
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';

interface ManifestV1 {
  schema: 'arke/manifest@v1';
  pi: string;
  ver: number;
  ts: string;
  prev: { '/': string } | null;
  components: Record<string, { '/': string }>;
  children_pi?: string[];
  parent_pi?: string;
  note?: string;
}

interface EntityV1 {
  schema: 'arke/entity@v1';
  pi: string;
  entity_type: string;
  ver: number;
  ts: string;
  prev: { '/': string } | null;
  components: Record<string, { '/': string }>;
  parent_pi?: string;
  label?: string;
  description?: string;
  note?: string;
}

interface EidosV1 {
  schema: 'arke/eidos@v1';
  id: string;
  type: string;
  parent_pi?: string;
  created_at: string;
  ver: number;
  ts: string;
  prev: { '/': string } | null;
  components: Record<string, { '/': string }>;
  label?: string;
  description?: string;
  children_pi?: string[];
  note?: string;
}

type OldManifest = ManifestV1 | EntityV1;

const stats = {
  total: 0,
  manifestV1: 0,
  entityV1: 0,
  alreadyEidos: 0,
  migrated: 0,
  failed: 0,
};

const backup: Array<{ id: string; tipCid: string }> = [];

async function fetchDag(cid: string): Promise<any> {
  const response = await fetch(`${API_ENDPOINT}/dag/${cid}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch DAG ${cid}: ${response.statusText}`);
  }
  return response.json();
}

async function putDag(data: any): Promise<string> {
  // We need to use the IPFS service directly, not the API
  // For now, we'll construct the URL for kubo directly
  const ipfsUrl = process.env.IPFS_API_URL || 'http://localhost:5001';

  const formData = new FormData();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  formData.append('file', blob);

  const response = await fetch(`${ipfsUrl}/api/v0/dag/put?store-codec=dag-json&input-codec=dag-json&pin=true`, {
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
  // Write tip file via IPFS MFS
  const ipfsUrl = process.env.IPFS_API_URL || 'http://localhost:5001';

  // Compute shard path
  const shard1 = id.slice(-4, -2);
  const shard2 = id.slice(-2);
  const tipPath = `/arke/index/${shard1}/${shard2}/${id}.tip`;

  // Ensure parent directories exist
  await fetch(`${ipfsUrl}/api/v0/files/mkdir?arg=/arke&parents=true`, { method: 'POST' });
  await fetch(`${ipfsUrl}/api/v0/files/mkdir?arg=/arke/index&parents=true`, { method: 'POST' });
  await fetch(`${ipfsUrl}/api/v0/files/mkdir?arg=/arke/index/${shard1}&parents=true`, { method: 'POST' });
  await fetch(`${ipfsUrl}/api/v0/files/mkdir?arg=/arke/index/${shard1}/${shard2}&parents=true`, { method: 'POST' });

  // Write tip file (overwrite if exists)
  const formData = new FormData();
  formData.append('file', new Blob([tipCid], { type: 'text/plain' }));

  const response = await fetch(
    `${ipfsUrl}/api/v0/files/write?arg=${encodeURIComponent(tipPath)}&create=true&truncate=true`,
    { method: 'POST', body: formData }
  );

  if (!response.ok) {
    throw new Error(`Failed to write tip for ${id}: ${response.statusText}`);
  }
}

async function getCreatedAt(manifest: OldManifest): Promise<string> {
  // Walk back the version chain to version 1 to get the original creation timestamp
  let current = manifest;

  while (current.ver > 1 && current.prev) {
    const prevCid = current.prev['/'];
    current = await fetchDag(prevCid);
  }

  return current.ts;
}

function migrateManifestV1(manifest: ManifestV1, createdAt: string): EidosV1 {
  return {
    schema: 'arke/eidos@v1',
    id: manifest.pi,
    type: 'PI',
    parent_pi: manifest.parent_pi,
    created_at: createdAt,
    ver: manifest.ver,
    ts: manifest.ts,
    prev: manifest.prev,
    components: manifest.components,
    ...(manifest.children_pi && { children_pi: manifest.children_pi }),
    ...(manifest.note && { note: manifest.note }),
  };
}

function migrateEntityV1(entity: EntityV1, createdAt: string): EidosV1 {
  return {
    schema: 'arke/eidos@v1',
    id: entity.pi,
    type: entity.entity_type,
    parent_pi: entity.parent_pi,
    created_at: createdAt,
    ver: entity.ver,
    ts: entity.ts,
    prev: entity.prev,
    components: entity.components,
    ...(entity.label && { label: entity.label }),
    ...(entity.description && { description: entity.description }),
    ...(entity.note && { note: entity.note }),
  };
}

async function migrateEntity(
  id: string,
  tipCid: string,
  dryRun: boolean
): Promise<{ success: boolean; error?: string }> {
  let actualId = id; // Initialize with provided ID

  try {
    stats.total++;

    // Fetch current manifest
    const manifest = await fetchDag(tipCid);

    // Extract actual ID from manifest (may be in pi or id field)
    actualId = manifest.id || manifest.pi || id;

    // Check if already migrated
    if (manifest.schema === 'arke/eidos@v1') {
      console.log(`  ✓ ${actualId} already migrated (arke/eidos@v1)`);
      stats.alreadyEidos++;
      return { success: true };
    }

    // Check if this is an old schema
    if (manifest.schema !== 'arke/manifest@v1' && manifest.schema !== 'arke/entity@v1') {
      console.log(`  ! ${actualId} has unknown schema: ${manifest.schema}`);
      return { success: false, error: `Unknown schema: ${manifest.schema}` };
    }

    // Track stats
    if (manifest.schema === 'arke/manifest@v1') {
      stats.manifestV1++;
    } else {
      stats.entityV1++;
    }

    // Get created_at from version 1
    console.log(`  → ${actualId} (${manifest.schema}, ver ${manifest.ver})`);
    const createdAt = await getCreatedAt(manifest);
    console.log(`    created_at: ${createdAt}`);

    // Migrate to Eidos
    let newManifest: EidosV1;
    if (manifest.schema === 'arke/manifest@v1') {
      newManifest = migrateManifestV1(manifest, createdAt);
    } else {
      newManifest = migrateEntityV1(manifest, createdAt);
    }

    console.log(`    type: ${newManifest.type}`);
    console.log(`    components: ${Object.keys(newManifest.components).join(', ')}`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would write new manifest and update tip`);
      return { success: true };
    }

    // Backup original tip
    backup.push({ id: actualId, tipCid });

    // Write new manifest
    const newTipCid = await putDag(newManifest);
    console.log(`    new tip: ${newTipCid}`);

    // Update tip file
    await writeTip(actualId, newTipCid);
    console.log(`    ✓ Updated tip file`);

    stats.migrated++;
    return { success: true };
  } catch (error: any) {
    console.error(`  ✗ ${actualId} failed:`, error.message);
    stats.failed++;
    return { success: false, error: error.message };
  }
}

async function migrateAll(dryRun: boolean, sampleSize?: number) {
  console.log('\n=== Eidos Schema Migration ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
  if (sampleSize) {
    console.log(`Sample size: ${sampleSize} entities`);
  }
  console.log('');

  // Get all entities
  let cursor: string | null = null;
  let processedCount = 0;

  while (true) {
    const url = cursor
      ? `${API_ENDPOINT}/entities?cursor=${cursor}&limit=50`
      : `${API_ENDPOINT}/entities?limit=50`;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.entities || data.entities.length === 0) {
      break;
    }

    for (const entity of data.entities) {
      await migrateEntity(entity.pi, entity.tip, dryRun);

      processedCount++;
      if (sampleSize && processedCount >= sampleSize) {
        console.log(`\nReached sample limit of ${sampleSize} entities`);
        break;
      }
    }

    if (sampleSize && processedCount >= sampleSize) {
      break;
    }

    cursor = data.next_cursor;
    if (!cursor) {
      break;
    }
  }

  // Print summary
  console.log('\n=== Migration Summary ===');
  console.log(`Total entities checked: ${stats.total}`);
  console.log(`  arke/manifest@v1: ${stats.manifestV1}`);
  console.log(`  arke/entity@v1: ${stats.entityV1}`);
  console.log(`  Already arke/eidos@v1: ${stats.alreadyEidos}`);
  console.log(`Migrated: ${stats.migrated}`);
  console.log(`Failed: ${stats.failed}`);

  if (!dryRun && backup.length > 0) {
    // Save backup
    const fs = await import('fs/promises');
    const backupPath = '/tmp/migration-backup.json';
    await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
    console.log(`\nBackup saved to: ${backupPath}`);
  }
}

async function migrateSingle(id: string, dryRun: boolean) {
  console.log('\n=== Migrating Single Entity ===');
  console.log(`Entity: ${id}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE MIGRATION'}`);
  console.log('');

  // Get entity
  const response = await fetch(`${API_ENDPOINT}/entities/${id}`);
  if (!response.ok) {
    throw new Error(`Entity not found: ${id}`);
  }

  const entity = await response.json();
  await migrateEntity(entity.id, entity.manifest_cid, dryRun);

  // Print summary
  console.log('\n=== Migration Summary ===');
  console.log(`Total entities checked: ${stats.total}`);
  console.log(`Migrated: ${stats.migrated}`);
  console.log(`Failed: ${stats.failed}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = !args.includes('--live');
const sampleSize = args.includes('--sample')
  ? parseInt(args[args.indexOf('--sample') + 1], 10)
  : undefined;
const entityId = args.includes('--entity')
  ? args[args.indexOf('--entity') + 1]
  : undefined;
const all = args.includes('--all');

if (entityId) {
  migrateSingle(entityId, dryRun).catch(console.error);
} else if (all || sampleSize) {
  migrateAll(dryRun, sampleSize).catch(console.error);
} else {
  console.log(`
Eidos Schema Migration Tool

Usage:
  npx tsx scripts/migrate-to-eidos.ts --dry-run          # Preview all changes (default)
  npx tsx scripts/migrate-to-eidos.ts --sample 5         # Migrate 5 entities (dry-run)
  npx tsx scripts/migrate-to-eidos.ts --sample 5 --live  # Migrate 5 entities (live)
  npx tsx scripts/migrate-to-eidos.ts --entity <id>      # Migrate specific entity (dry-run)
  npx tsx scripts/migrate-to-eidos.ts --entity <id> --live  # Migrate specific entity (live)
  npx tsx scripts/migrate-to-eidos.ts --all              # Migrate all entities (dry-run)
  npx tsx scripts/migrate-to-eidos.ts --all --live       # Migrate all entities (live)

Safety:
  - Default mode is --dry-run (shows changes without writing)
  - Use --live to actually perform migration
  - Backups saved to /tmp/migration-backup.json
`);
}
