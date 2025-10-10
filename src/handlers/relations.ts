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
    ...(body.note && { note: body.note }),
  };

  // Store new manifest
  const newManifestCid = await ipfs.dagPut(newManifest);

  // Update .tip
  await tipSvc.writeTip(parentPi, newManifestCid);

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
