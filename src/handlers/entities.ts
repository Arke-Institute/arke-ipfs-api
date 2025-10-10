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

  // Store manifest in IPFS (dag-cbor, pinned)
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
 * List all entities with pagination
 * Query params: offset, limit, include_metadata
 */
export async function listEntitiesHandler(c: Context): Promise<Response> {
  const tipSvc: TipService = c.get('tipService');
  const ipfs: IPFSService = c.get('ipfs');

  // Parse query parameters
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const includeMetadata = c.req.query('include_metadata') === 'true';

  // Validate parameters
  if (offset < 0 || limit < 1 || limit > 1000) {
    return c.json(
      {
        error: 'INVALID_PARAMS',
        message: 'offset must be >= 0, limit must be 1-1000',
      },
      400
    );
  }

  // Get paginated list
  const result = await tipSvc.listEntities({ offset, limit });

  // If include_metadata is requested, fetch manifests
  let entities;
  if (includeMetadata) {
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

  return c.json({
    entities,
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    has_more: result.offset + result.limit < result.total,
  });
}
