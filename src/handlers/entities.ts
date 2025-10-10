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
