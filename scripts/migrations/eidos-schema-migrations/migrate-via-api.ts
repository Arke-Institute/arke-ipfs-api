#!/usr/bin/env tsx
/**
 * Migration Script: arke/manifest@v1 → arke/eidos@v1 (via API)
 *
 * This script migrates entities by creating new versions via the API.
 * It reads the old manifest, creates a properly formatted Eidos manifest,
 * and uses appendVersion to create the new version.
 *
 * Usage:
 *   npx tsx scripts/migrate-via-api.ts --dry-run        # Preview
 *   npx tsx scripts/migrate-via-api.ts --sample 3       # Migrate 3 entities
 *   npx tsx scripts/migrate-via-api.ts --entity <id>    # Migrate one entity
 *   npx tsx scripts/migrate-via-api.ts --all --live     # Migrate all
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';

const stats = {
  total: 0,
  alreadyEidos: 0,
  migrated: 0,
  failed: 0,
};

async function fetchEntity(id: string): Promise<any> {
  const response = await fetch(`${API_ENDPOINT}/entities/${id}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch entity ${id}: ${response.statusText}`);
  }
  return response.json();
}

async function fetchDag(cid: string): Promise<any> {
  const response = await fetch(`${API_ENDPOINT}/dag/${cid}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch DAG ${cid}: ${response.statusText}`);
  }
  return response.json();
}

async function getCreatedAt(manifest: any): Promise<string> {
  // Walk back to version 1
  let current = manifest;
  while (current.ver > 1 && current.prev) {
    const prevCid = current.prev['/'];
    current = await fetchDag(prevCid);
  }
  return current.ts;
}

async function migrateEntity(id: string, dryRun: boolean): Promise<boolean> {
  try {
    stats.total++;

    // Fetch entity and manifest
    const entity = await fetchEntity(id);
    const manifest = await fetchDag(entity.manifest_cid);

    // Check if already migrated
    if (manifest.schema === 'arke/eidos@v1') {
      console.log(`  ✓ ${id} already migrated`);
      stats.alreadyEidos++;
      return true;
    }

    // Check if this is an old schema
    if (manifest.schema !== 'arke/manifest@v1' && manifest.schema !== 'arke/entity@v1') {
      console.log(`  ! ${id} has unknown schema: ${manifest.schema}`);
      return false;
    }

    console.log(`  → ${id} (${manifest.schema}, ver ${manifest.ver})`);

    // Get created_at from version 1
    const createdAt = await getCreatedAt(manifest);
    console.log(`    created_at: ${createdAt}`);

    // Determine type
    const type = manifest.schema === 'arke/manifest@v1' ? 'PI' : manifest.entity_type;
    console.log(`    type: ${type}`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would migrate to arke/eidos@v1`);
      return true;
    }

    // Migration strategy: We can't modify existing versions, so we need to
    // recreate the entire entity with the new schema. This is complex because:
    // 1. We'd need to rewrite all versions in the chain
    // 2. All children would need to be updated
    // 3. Parent references would need updating
    //
    // A safer approach is to use a migration service endpoint that can
    // directly manipulate IPFS and MFS.

    console.log(`    ⚠️  Migration requires direct IPFS access`);
    console.log(`        Please use wrangler dev with IPFS access or deploy a migration endpoint`);

    return false;
  } catch (error: any) {
    console.error(`  ✗ ${id} failed:`, error.message);
    stats.failed++;
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--live');
  const sample = args.includes('--sample') ? parseInt(args[args.indexOf('--sample') + 1], 10) : undefined;
  const entityId = args.includes('--entity') ? args[args.indexOf('--entity') + 1] : undefined;
  const all = args.includes('--all');

  console.log('\n=== Eidos Migration (API-based) ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');
  console.log('⚠️  Note: This script can only analyze entities.');
  console.log('    Actual migration requires direct IPFS access.');
  console.log('    Use the Cloudflare worker migration endpoint instead.');
  console.log('');

  if (entityId) {
    await migrateEntity(entityId, dryRun);
  } else {
    // List entities
    let cursor: string | null = null;
    let count = 0;

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
        await migrateEntity(entity.pi, dryRun);
        count++;

        if (sample && count >= sample) {
          break;
        }
      }

      if (sample && count >= sample) {
        break;
      }

      cursor = data.next_cursor;
      if (!cursor) {
        break;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total: ${stats.total}`);
  console.log(`Already migrated: ${stats.alreadyEidos}`);
  console.log(`Would migrate: ${stats.total - stats.alreadyEidos - stats.failed}`);
  console.log(`Failed: ${stats.failed}`);
}

main().catch(console.error);
