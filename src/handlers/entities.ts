import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { ulid } from '../utils/ulid';
import { validateCIDRecord } from '../utils/cid';
import { ConflictError } from '../utils/errors';
import { validateBody } from '../utils/validation';
import {
  ManifestV1,
  link,
  CreateEntityRequest,
  CreateEntityResponse,
  GetEntityResponse,
  CreateEntityRequestSchema,
} from '../types/manifest';

/**
 * POST /entities
 * Create new entity with v1 manifest
 */
export async function createEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  // Validate request body
  const body = await validateBody(c.req.raw, CreateEntityRequestSchema);

  // Generate or validate PI
  const pi = body.pi || ulid();

  // Check for collision
  const exists = await tipSvc.tipExists(pi);
  if (exists) {
    throw new ConflictError('Entity', pi);
  }

  // Validate component CIDs
  validateCIDRecord(body.components, 'components');

  // Build manifest v1
  const now = new Date().toISOString();
  const manifest: ManifestV1 = {
    schema: 'arke/manifest@v1',
    pi,
    ver: 1,
    ts: now,
    prev: null, // v1 has no previous version
    components: Object.fromEntries(
      Object.entries(body.components).map(([label, cid]) => [label, link(cid)])
    ),
    ...(body.children_pi && { children_pi: body.children_pi }),
    ...(body.note && { note: body.note }),
  };

  // Store manifest in IPFS (dag-json, pinned)
  const manifestCid = await ipfs.dagPut(manifest);

  // Write .tip file
  await tipSvc.writeTip(pi, manifestCid);

  // Response
  const response: CreateEntityResponse = {
    pi,
    ver: 1,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };

  return c.json(response, 201);
}

/**
 * GET /entities/:pi
 * Fetch latest manifest for entity
 */
export async function getEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  const pi = c.req.param('pi');

  // Read tip
  const tipCid = await tipSvc.readTip(pi);

  // Fetch manifest
  const manifest = (await ipfs.dagGet(tipCid)) as ManifestV1;

  // Optional: resolve component bytes if requested
  const resolve = c.req.query('resolve') || 'cids';

  if (resolve === 'bytes') {
    // TODO: stream component bytes
    // For MVP, just return CIDs
  }

  // Transform manifest to response format
  const response: GetEntityResponse = {
    pi: manifest.pi,
    ver: manifest.ver,
    ts: manifest.ts,
    manifest_cid: tipCid,
    prev_cid: manifest.prev ? manifest.prev['/'] : null,
    components: Object.fromEntries(
      Object.entries(manifest.components).map(([label, linkObj]) => [
        label,
        linkObj['/'],
      ])
    ),
    ...(manifest.children_pi && { children_pi: manifest.children_pi }),
    ...(manifest.note && { note: manifest.note }),
  };

  return c.json(response);
}

/**
 * GET /entities
 * List entities with cursor-based pagination
 * Query params: cursor, limit, include_metadata
 */
export async function listEntitiesHandler(c: Context): Promise<Response> {
  const startTime = Date.now();
  const tipSvc: TipService = c.get('tipService');
  const ipfs: IPFSService = c.get('ipfs');

  // Parse query parameters
  const cursor = c.req.query('cursor');
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const includeMetadata = c.req.query('include_metadata') === 'true';

  console.log(`[HANDLER] GET /entities?limit=${limit}&cursor=${cursor || 'none'}&include_metadata=${includeMetadata}`);

  // Validate parameters
  if (limit < 1 || limit > 1000) {
    return c.json(
      {
        error: 'INVALID_PARAMS',
        message: 'limit must be 1-1000',
      },
      400
    );
  }

  // Validate cursor if provided
  if (cursor) {
    // Basic ULID format check (26 chars, valid alphabet)
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cursor)) {
      return c.json(
        {
          error: 'INVALID_CURSOR',
          message: 'cursor must be a valid 26-character ULID',
        },
        400
      );
    }
  }

  // Get paginated list with cursor
  const result = await tipSvc.listEntitiesWithCursor({
    limit,
    cursor: cursor || undefined
  });

  console.log(`[HANDLER] Got ${result.entities.length} entities from TipService`);

  // If include_metadata is requested, fetch manifests
  let entities;
  if (includeMetadata) {
    console.log(`[HANDLER] Fetching metadata for ${result.entities.length} entities...`);
    entities = await Promise.all(
      result.entities.map(async ({ pi, tip }) => {
        const manifest = (await ipfs.dagGet(tip)) as ManifestV1;
        return {
          pi,
          tip,
          ver: manifest.ver,
          ts: manifest.ts,
          note: manifest.note || null,
          component_count: Object.keys(manifest.components).length,
          children_count: manifest.children_pi?.length || 0,
        };
      })
    );
  } else {
    // Just return PI and tip CID
    entities = result.entities;
  }

  const duration = Date.now() - startTime;
  console.log(`[HANDLER] Response ready (${duration}ms): ${entities.length} entities, next_cursor=${result.next_cursor || 'null'}`);

  return c.json({
    entities,
    limit,
    next_cursor: result.next_cursor,
  });
}
