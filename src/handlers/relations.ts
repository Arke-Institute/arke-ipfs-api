import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { CASError, ValidationError, TipWriteRaceError } from '../utils/errors';
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
import { Network, validatePiMatchesNetwork } from '../types/network';

// Maximum number of children that can be added/removed in a single request
const MAX_CHILDREN_PER_REQUEST = 100;

// Batch size for parallel processing (to avoid overwhelming Cloudflare Workers)
const BATCH_SIZE = 10;

/**
 * POST /relations
 * Update parent-child relationships (CAS-protected with automatic retry on race conditions)
 * This is essentially an append-version operation that only modifies children_pi
 */
export async function updateRelationsHandler(c: Context): Promise<Response> {
  const MAX_CAS_RETRIES = 3;

  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  // Parse body ONCE (can't re-read request body stream)
  const body = await validateBody(c.req.raw, UpdateRelationsRequestSchema);

  // Validate parent_pi matches network
  validatePiMatchesNetwork(body.parent_pi, network);

  // Validate add_children match network (prevents cross-network relationships)
  if (body.add_children) {
    for (const childPi of body.add_children) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  // Validate remove_children match network
  if (body.remove_children) {
    for (const childPi of body.remove_children) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    try {
      return await updateRelationsAttempt(ipfs, tipSvc, body, c.env);
    } catch (error) {
      if (error instanceof TipWriteRaceError && attempt < MAX_CAS_RETRIES - 1) {
        // Exponential backoff: 50ms, 100ms, 200ms
        const delay = 50 * (2 ** attempt) + Math.random() * 50;
        console.log(`[CAS] Relation update race detected for ${error.pi}, retrying in ${delay.toFixed(0)}ms (attempt ${attempt + 2}/${MAX_CAS_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new CASError({
    actual: 'unknown',
    expect: 'unknown',
  });
}

/**
 * Single attempt at updating relations
 * Throws TipWriteRaceError if race condition detected
 */
async function updateRelationsAttempt(
  ipfs: IPFSService,
  tipSvc: TipService,
  body: UpdateRelationsRequest,
  env: any
): Promise<Response> {

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

  // Update .tip with atomic CAS verification
  await tipSvc.writeTipAtomic(parentPi, newManifestCid, currentTip);

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
          await tipSvc.writeTipAtomic(childPi, newChildTip, childTip);

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
          await tipSvc.writeTipAtomic(childPi, newChildTip, childTip);

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
    const backendURL = getBackendURL(env);
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

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}
