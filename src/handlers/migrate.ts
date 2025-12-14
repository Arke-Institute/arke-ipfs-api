import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { link } from '../types/eidos';

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
  source_pi?: string;
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

async function getCreatedAt(ipfs: IPFSService, manifest: ManifestV1 | EntityV1): Promise<string> {
  let current: any = manifest;
  while (current.ver > 1 && current.prev) {
    current = await ipfs.dagGet(current.prev['/']);
  }
  return current.ts;
}

function migrateManifestV1(manifest: ManifestV1, createdAt: string): EidosV1 {
  return {
    schema: 'arke/eidos@v1',
    id: manifest.pi,
    type: 'PI',
    source_pi: manifest.parent_pi,
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
    source_pi: entity.parent_pi,
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

/**
 * POST /migrate/:pi
 * Migrate a single entity from arke/manifest@v1 or arke/entity@v1 to arke/eidos@v1
 */
export async function migrateEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const pi = c.req.param('pi');

  try {
    // Read current tip
    const currentTipCid = await tipSvc.readTip(pi);
    if (!currentTipCid) {
      return c.json({ error: 'NOT_FOUND', message: `Entity ${pi} not found` }, 404);
    }

    // Fetch manifest
    const manifest = await ipfs.dagGet(currentTipCid) as any;

    // Check if already migrated
    if (manifest.schema === 'arke/eidos@v1') {
      return c.json({
        message: 'Entity already migrated',
        pi,
        schema: 'arke/eidos@v1',
        ver: manifest.ver,
      });
    }

    // Check if this is an old schema
    if (manifest.schema !== 'arke/manifest@v1' && manifest.schema !== 'arke/entity@v1') {
      return c.json(
        {
          error: 'UNSUPPORTED_SCHEMA',
          message: `Entity ${pi} has unsupported schema: ${manifest.schema}`,
        },
        400
      );
    }

    // Get created_at from version 1
    const createdAt = await getCreatedAt(ipfs, manifest);

    // Migrate to Eidos
    let newManifest: EidosV1;
    if (manifest.schema === 'arke/manifest@v1') {
      newManifest = migrateManifestV1(manifest, createdAt);
    } else {
      newManifest = migrateEntityV1(manifest, createdAt);
    }

    // Write new manifest
    const newTipCid = await ipfs.dagPut(newManifest);

    // Update tip
    await tipSvc.writeTip(pi, newTipCid);

    console.log(`[MIGRATE] Migrated ${pi} from ${manifest.schema} to arke/eidos@v1`);

    return c.json({
      message: 'Entity migrated successfully',
      pi,
      old_schema: manifest.schema,
      new_schema: 'arke/eidos@v1',
      old_tip: currentTipCid,
      new_tip: newTipCid,
      type: newManifest.type,
      created_at: createdAt,
    }, 200);
  } catch (error: any) {
    console.error(`[MIGRATE] Failed to migrate ${pi}:`, error);
    return c.json(
      {
        error: 'MIGRATION_ERROR',
        message: error.message || 'Migration failed',
      },
      500
    );
  }
}

/**
 * POST /migrate/batch
 * Migrate multiple entities in one request
 */
export async function migrateBatchHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  try {
    const body = await c.req.json();
    const { pis, dry_run = false } = body;

    if (!Array.isArray(pis) || pis.length === 0) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'pis must be a non-empty array' }, 400);
    }

    if (pis.length > 100) {
      return c.json({ error: 'VALIDATION_ERROR', message: 'Maximum 100 entities per batch' }, 400);
    }

    const results = [];

    for (const pi of pis) {
      try {
        const currentTipCid = await tipSvc.readTip(pi);
        if (!currentTipCid) {
          results.push({ pi, status: 'not_found' });
          continue;
        }

        const manifest = await ipfs.dagGet(currentTipCid) as any;

        if (manifest.schema === 'arke/eidos@v1') {
          results.push({ pi, status: 'already_migrated' });
          continue;
        }

        if (manifest.schema !== 'arke/manifest@v1' && manifest.schema !== 'arke/entity@v1') {
          results.push({ pi, status: 'unsupported_schema', schema: manifest.schema });
          continue;
        }

        if (dry_run) {
          results.push({
            pi,
            status: 'would_migrate',
            from: manifest.schema,
            to: 'arke/eidos@v1',
          });
          continue;
        }

        // Migrate
        const createdAt = await getCreatedAt(ipfs, manifest);
        let newManifest: EidosV1;
        if (manifest.schema === 'arke/manifest@v1') {
          newManifest = migrateManifestV1(manifest, createdAt);
        } else {
          newManifest = migrateEntityV1(manifest, createdAt);
        }

        const newTipCid = await ipfs.dagPut(newManifest);
        await tipSvc.writeTip(pi, newTipCid);

        results.push({
          pi,
          status: 'migrated',
          from: manifest.schema,
          to: 'arke/eidos@v1',
          new_tip: newTipCid,
        });
      } catch (error: any) {
        results.push({ pi, status: 'failed', error: error.message });
      }
    }

    const summary = {
      total: results.length,
      already_migrated: results.filter(r => r.status === 'already_migrated').length,
      migrated: results.filter(r => r.status === 'migrated').length,
      would_migrate: results.filter(r => r.status === 'would_migrate').length,
      failed: results.filter(r => r.status === 'failed').length,
      not_found: results.filter(r => r.status === 'not_found').length,
      unsupported: results.filter(r => r.status === 'unsupported_schema').length,
    };

    return c.json({
      dry_run,
      summary,
      results,
    });
  } catch (error: any) {
    console.error('[MIGRATE] Batch migration failed:', error);
    return c.json(
      {
        error: 'MIGRATION_ERROR',
        message: error.message || 'Batch migration failed',
      },
      500
    );
  }
}
