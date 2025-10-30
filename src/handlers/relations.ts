import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { CASError, ValidationError } from '../utils/errors';
import { validateBody } from '../utils/validation';
import { appendEvent } from '../clients/ipfs-server';
import { getBackendURL } from '../config';
import { processBatchedSettled } from '../utils/batch';
import {
  ManifestV1,
  link,
  UpdateRelationsRequest,
  AppendVersionResponse,
  UpdateRelationsRequestSchema,
} from '../types/manifest';

// Maximum number of children that can be added/removed in a single request
const MAX_CHILDREN_PER_REQUEST = 100;

// Batch size for parallel processing (to avoid overwhelming Cloudflare Workers)
const BATCH_SIZE = 10;

/**
 * POST /relations
 * Update parent-child relationships
 * This is essentially an append-version operation that only modifies children_pi
 */
export async function updateRelationsHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  // Validate request
  const body = await validateBody(c.req.raw, UpdateRelationsRequestSchema);

  const parentPi = body.parent_pi;

  // Validate child count limits
  if (body.add_children && body.add_children.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot add ${body.add_children.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  if (body.remove_children && body.remove_children.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot remove ${body.remove_children.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  // Read current tip
  const currentTip = await tipSvc.readTip(parentPi);

  // CAS check
  if (currentTip !== body.expect_tip) {
    throw new CASError({
      actual: currentTip,
      expect: body.expect_tip,
    });
  }

  // Fetch old manifest
  const oldManifest = (await ipfs.dagGet(currentTip)) as ManifestV1;

  // Compute new children_pi (apply add/remove)
  let newChildrenPi = oldManifest.children_pi || [];

  if (body.add_children) {
    // Add new children (dedupe)
    const existingSet = new Set(newChildrenPi);
    for (const childPi of body.add_children) {
      if (!existingSet.has(childPi)) {
        newChildrenPi.push(childPi);
      }
    }
  }

  if (body.remove_children) {
    const removeSet = new Set(body.remove_children);
    newChildrenPi = newChildrenPi.filter((pi) => !removeSet.has(pi));
  }

  // Build new manifest
  const now = new Date().toISOString();
  const newManifest: ManifestV1 = {
    schema: 'arke/manifest@v1',
    pi: parentPi,
    ver: oldManifest.ver + 1,
    ts: now,
    prev: link(currentTip),
    components: oldManifest.components, // Unchanged
    ...(newChildrenPi.length > 0 && { children_pi: newChildrenPi }),
    ...(oldManifest.parent_pi && { parent_pi: oldManifest.parent_pi }),
    ...(body.note && { note: body.note }),
  };

  // Store new manifest
  const newManifestCid = await ipfs.dagPut(newManifest);

  // Update .tip
  await tipSvc.writeTip(parentPi, newManifestCid);

  // Update children entities with parent_pi (bidirectional relationship)
  // Add parent_pi to newly added children (BATCHED PARALLELIZATION)
  if (body.add_children) {
    await processBatchedSettled(
      body.add_children,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as ManifestV1;

        // Only update if parent_pi is different (avoid unnecessary versions)
        if (childManifest.parent_pi !== parentPi) {
          const updatedChildManifest: ManifestV1 = {
            schema: 'arke/manifest@v1',
            pi: childPi,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            components: childManifest.components,
            ...(childManifest.children_pi && { children_pi: childManifest.children_pi }),
            parent_pi: parentPi, // Set parent reference
            note: `Set parent to ${parentPi}`,
          };

          const newChildTip = await ipfs.dagPut(updatedChildManifest);
          await tipSvc.writeTip(childPi, newChildTip);

          console.log(`[RELATION] Updated child ${childPi} to set parent_pi=${parentPi}`);
        }
      }
    );
  }

  // Remove parent_pi from removed children (BATCHED PARALLELIZATION)
  if (body.remove_children) {
    await processBatchedSettled(
      body.remove_children,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as ManifestV1;

        // Only update if child actually has this parent
        if (childManifest.parent_pi === parentPi) {
          const updatedChildManifest: ManifestV1 = {
            schema: 'arke/manifest@v1',
            pi: childPi,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            components: childManifest.components,
            ...(childManifest.children_pi && { children_pi: childManifest.children_pi }),
            // parent_pi is omitted (removed)
            note: `Removed parent ${parentPi}`,
          };

          const newChildTip = await ipfs.dagPut(updatedChildManifest);
          await tipSvc.writeTip(childPi, newChildTip);

          console.log(`[RELATION] Updated child ${childPi} to remove parent_pi`);
        }
      }
    );
  }

  // Optional: efficient pin swap
  try {
    await ipfs.pinUpdate(currentTip, newManifestCid);
  } catch {
    // Ignore pin update failures
  }

  // Append update event to event stream (optimization - don't fail relation update if this fails)
  try {
    const backendURL = getBackendURL(c.env);
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi: parentPi,
      ver: newManifest.ver,
      tip_cid: newManifestCid,
    });
    console.log(`[EVENT] Appended update event for parent entity ${parentPi} v${newManifest.ver}: ${eventCid}`);
  } catch (error) {
    // Log error but don't fail the request - event append is async optimization
    console.error(`[EVENT] Failed to append update event for parent entity ${parentPi}:`, error);
  }

  // Response
  const response: AppendVersionResponse = {
    pi: parentPi,
    ver: newManifest.ver,
    manifest_cid: newManifestCid,
    tip: newManifestCid,
  };

  return c.json(response, 201);
}
