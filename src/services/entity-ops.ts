import { IPFSService } from './ipfs';
import { TipService } from './tip';
import { ulid } from '../utils/ulid';
import { validateCIDRecord } from '../utils/cid';
import { ConflictError } from '../utils/errors';
import { appendEvent } from '../clients/ipfs-server';
import {
  ManifestV1,
  link,
  CreateEntityRequest,
  CreateEntityResponse,
  GetEntityResponse,
} from '../types/manifest';

/**
 * Create a new entity (extracted core logic from createEntityHandler)
 * Pure business logic - no Hono Context dependency
 */
export async function createEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  backendURL: string,
  req: CreateEntityRequest
): Promise<CreateEntityResponse> {
  // Generate or validate PI
  const pi = req.pi || ulid();

  // Check for collision
  const exists = await tipSvc.tipExists(pi);
  if (exists) {
    throw new ConflictError('Entity', pi);
  }

  // Validate component CIDs
  validateCIDRecord(req.components, 'components');

  // Build manifest v1
  const now = new Date().toISOString();
  const manifest: ManifestV1 = {
    schema: 'arke/manifest@v1',
    pi,
    ver: 1,
    ts: now,
    prev: null, // v1 has no previous version
    components: Object.fromEntries(
      Object.entries(req.components).map(([label, cid]) => [label, link(cid)])
    ),
    ...(req.children_pi && { children_pi: req.children_pi }),
    ...(req.parent_pi && { parent_pi: req.parent_pi }),
    ...(req.note && { note: req.note }),
  };

  // Store manifest in IPFS (dag-cbor, pinned)
  const manifestCid = await ipfs.dagPut(manifest);

  // Write .tip file
  await tipSvc.writeTip(pi, manifestCid);

  // If parent_pi provided, update parent entity to include this child
  if (req.parent_pi) {
    try {
      const parentTip = await tipSvc.readTip(req.parent_pi);
      const parentManifest = (await ipfs.dagGet(parentTip)) as ManifestV1;

      // Add this entity to parent's children_pi (dedupe)
      const existingChildren = new Set(parentManifest.children_pi || []);
      if (!existingChildren.has(pi)) {
        const newChildren = [...(parentManifest.children_pi || []), pi];

        const updatedParentManifest: ManifestV1 = {
          schema: 'arke/manifest@v1',
          pi: req.parent_pi,
          ver: parentManifest.ver + 1,
          ts: new Date().toISOString(),
          prev: link(parentTip),
          components: parentManifest.components,
          children_pi: newChildren,
          ...(parentManifest.parent_pi && { parent_pi: parentManifest.parent_pi }),
          note: `Added child entity ${pi}`,
        };

        const newParentTip = await ipfs.dagPut(updatedParentManifest);
        await tipSvc.writeTip(req.parent_pi, newParentTip);

        console.log(`[RELATION] Auto-updated parent ${req.parent_pi} to include child ${pi}`);
      }
    } catch (error) {
      // Log but don't fail entity creation if parent update fails
      console.error(`[RELATION] Failed to update parent ${req.parent_pi}:`, error);
    }
  }

  // Append create event to event stream (optimization - don't fail entity creation if this fails)
  try {
    const eventCid = await appendEvent(backendURL, {
      type: 'create',
      pi,
      ver: 1,
      tip_cid: manifestCid,
    });
    console.log(`[EVENT] Appended create event for entity ${pi}: ${eventCid}`);
  } catch (error) {
    // Log error but don't fail the request - event append is async optimization
    console.error(`[EVENT] Failed to append create event for entity ${pi}:`, error);
  }

  // Response
  return {
    pi,
    ver: 1,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}

/**
 * Get entity by PI (extracted core logic from getEntityHandler)
 * Pure business logic - no Hono Context dependency
 */
export async function getEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  pi: string
): Promise<GetEntityResponse> {
  // Read tip
  const tipCid = await tipSvc.readTip(pi);

  // Fetch manifest
  const manifest = (await ipfs.dagGet(tipCid)) as ManifestV1;

  // Transform manifest to response format
  return {
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
    ...(manifest.parent_pi && { parent_pi: manifest.parent_pi }),
    ...(manifest.note && { note: manifest.note }),
  };
}
