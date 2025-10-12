import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { CASError } from '../utils/errors';
import { validateBody } from '../utils/validation';
import {
  ManifestV1,
  link,
  UpdateRelationsRequest,
  AppendVersionResponse,
  UpdateRelationsRequestSchema,
} from '../types/manifest';

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
  // Add parent_pi to newly added children
  if (body.add_children) {
    for (const childPi of body.add_children) {
      try {
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
      } catch (error) {
        // Log but don't fail if child update fails
        console.error(`[RELATION] Failed to update child ${childPi}:`, error);
      }
    }
  }

  // Remove parent_pi from removed children
  if (body.remove_children) {
    for (const childPi of body.remove_children) {
      try {
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
      } catch (error) {
        // Log but don't fail if child update fails
        console.error(`[RELATION] Failed to update child ${childPi}:`, error);
      }
    }
  }

  // Optional: efficient pin swap
  try {
    await ipfs.pinUpdate(currentTip, newManifestCid);
  } catch {
    // Ignore pin update failures
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
