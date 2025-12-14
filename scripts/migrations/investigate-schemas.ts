#!/usr/bin/env tsx
/**
 * Investigate existing schemas in the system
 * Check how many entities use arke/manifest@v1 vs arke/entity@v1 vs arke/eidos@v1
 */

const API_ENDPOINT = 'http://localhost:8787';
const NETWORKS = ['main', 'test'];

interface EntityListItem {
  pi: string;
  tip: string;
}

interface ListResponse {
  entities: EntityListItem[];
  next_cursor: string | null;
}

async function fetchManifest(cid: string): Promise<any> {
  const response = await fetch(`${API_ENDPOINT}/dag/${cid}`);
  return response.json();
}

async function investigateSchemas(network: string) {
  console.log(`\n=== Investigating ${network} network ===`);

  const schemas = new Map<string, number>();
  let totalEntities = 0;
  let cursor: string | null = null;

  // Sample first 100 entities to get a sense of the schema distribution
  for (let page = 0; page < 10; page++) {
    const url = cursor
      ? `${API_ENDPOINT}/entities?cursor=${cursor}&limit=10`
      : `${API_ENDPOINT}/entities?limit=10`;

    const response = await fetch(url, {
      headers: { 'X-Arke-Network': network },
    });

    const data: ListResponse = await response.json();

    if (!data.entities || data.entities.length === 0) {
      break;
    }

    // Check schema of each entity
    for (const entity of data.entities) {
      try {
        const manifest = await fetchManifest(entity.tip);
        const schema = manifest.schema || 'unknown';
        schemas.set(schema, (schemas.get(schema) || 0) + 1);
        totalEntities++;

        // Show first example of each schema type
        const count = schemas.get(schema)!;
        if (count === 1) {
          console.log(`\nFirst ${schema} entity: ${entity.pi}`);
          console.log(JSON.stringify(manifest, null, 2));
        }
      } catch (error) {
        console.error(`Error fetching ${entity.pi}:`, error);
      }
    }

    cursor = data.next_cursor;
    if (!cursor) {
      break;
    }
  }

  console.log(`\n--- Schema Distribution (sampled ${totalEntities} entities) ---`);
  for (const [schema, count] of Array.from(schemas.entries()).sort((a, b) => b[1] - a[1])) {
    const percentage = ((count / totalEntities) * 100).toFixed(1);
    console.log(`  ${schema}: ${count} (${percentage}%)`);
  }
}

async function main() {
  for (const network of NETWORKS) {
    await investigateSchemas(network);
  }
}

main().catch(console.error);
