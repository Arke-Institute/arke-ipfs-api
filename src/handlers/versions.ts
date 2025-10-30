import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { CASError, ValidationError } from '../utils/errors';
import { validateCIDRecord } from '../utils/cid';
import {
  validateBody,
  validatePagination,
  parseVersionSelector,
} from '../utils/validation';
import { appendEvent } from '../clients/ipfs-server';
import { getBackendURL } from '../config';
import { processBatchedSettled } from '../utils/batch';
import {
  ManifestV1,
  link,
  AppendVersionRequest,
  AppendVersionResponse,
  AppendVersionRequestSchema,
  ListVersionsResponse,
  GetEntityResponse,
} from '../types/manifest';

// Maximum number of children that can be added/removed in a single request
const MAX_CHILDREN_PER_REQUEST = 100;

// Batch size for parallel processing (to avoid overwhelming Cloudflare Workers)
const BATCH_SIZE = 10;

/**
 * POST /entities/:pi/versions
 * Append new version (CAS-protected)
 */
export async function appendVersionHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  const pi = c.req.param('pi');

  // Validate request
  const body = await validateBody(c.req.raw, AppendVersionRequestSchema);

  // Read current tip
  const currentTip = await tipSvc.readTip(pi);

  // CAS check
  if (currentTip !== body.expect_tip) {
    throw new CASError({
      actual: currentTip,
      expect: body.expect_tip,
    });
  }

  // Fetch old manifest
  const oldManifest = (await ipfs.dagGet(currentTip)) as ManifestV1;

  // Validate component CIDs if provided
  if (body.components) {
    validateCIDRecord(body.components, 'components');
  }

  // Validate child count limits
  if (body.children_pi_add && body.children_pi_add.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot add ${body.children_pi_add.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  if (body.children_pi_remove && body.children_pi_remove.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot remove ${body.children_pi_remove.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  // Compute new manifest
  const now = new Date().toISOString();

  // Merge components (carry forward unchanged, apply updates)
  const newComponents = { ...oldManifest.components };
  if (body.components) {
    for (const [label, cid] of Object.entries(body.components)) {
      newComponents[label] = link(cid);
    }
  }

  // Compute new children_pi (apply add/remove)
  let newChildrenPi = oldManifest.children_pi || [];
  if (body.children_pi_add) {
    newChildrenPi = [...newChildrenPi, ...body.children_pi_add];
  }
  if (body.children_pi_remove) {
    const removeSet = new Set(body.children_pi_remove);
    newChildrenPi = newChildrenPi.filter((childPi) => !removeSet.has(childPi));
  }

  const newManifest: ManifestV1 = {
    schema: 'arke/manifest@v1',
    pi,
    ver: oldManifest.ver + 1,
    ts: now,
    prev: link(currentTip), // Link to old manifest
    components: newComponents,
    ...(newChildrenPi.length > 0 && { children_pi: newChildrenPi }),
    ...(oldManifest.parent_pi && { parent_pi: oldManifest.parent_pi }),
    ...(body.note && { note: body.note }),
  };

  // Store new manifest
  const newManifestCid = await ipfs.dagPut(newManifest);

  // Update .tip
  await tipSvc.writeTip(pi, newManifestCid);

  // Update children entities with parent_pi (bidirectional relationship)
  // Add parent_pi to newly added children (BATCHED PARALLELIZATION)
  if (body.children_pi_add) {
    await processBatchedSettled(
      body.children_pi_add,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as ManifestV1;

        // Only update if parent_pi is different (avoid unnecessary versions)
        if (childManifest.parent_pi !== pi) {
          const updatedChildManifest: ManifestV1 = {
            schema: 'arke/manifest@v1',
            pi: childPi,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            components: childManifest.components,
            ...(childManifest.children_pi && { children_pi: childManifest.children_pi }),
            parent_pi: pi, // Set parent reference
            note: `Set parent to ${pi}`,
          };

          const newChildTip = await ipfs.dagPut(updatedChildManifest);
          await tipSvc.writeTip(childPi, newChildTip);

          console.log(`[RELATION] Updated child ${childPi} to set parent_pi=${pi}`);
        }
      }
    );
  }

  // Remove parent_pi from removed children (BATCHED PARALLELIZATION)
  if (body.children_pi_remove) {
    await processBatchedSettled(
      body.children_pi_remove,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as ManifestV1;

        // Only update if child actually has this parent
        if (childManifest.parent_pi === pi) {
          const updatedChildManifest: ManifestV1 = {
            schema: 'arke/manifest@v1',
            pi: childPi,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            components: childManifest.components,
            ...(childManifest.children_pi && { children_pi: childManifest.children_pi }),
            // parent_pi is omitted (removed)
            note: `Removed parent ${pi}`,
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
    // Pin update can fail if old manifest isn't pinned; ignore
  }

  // Append update event to event stream (optimization - don't fail version append if this fails)
  try {
    const backendURL = getBackendURL(c.env);
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi,
      ver: newManifest.ver,
      tip_cid: newManifestCid,
    });
    console.log(`[EVENT] Appended update event for entity ${pi} v${newManifest.ver}: ${eventCid}`);
  } catch (error) {
    // Log error but don't fail the request - event append is async optimization
    console.error(`[EVENT] Failed to append update event for entity ${pi}:`, error);
  }

  // Response
  const response: AppendVersionResponse = {
    pi,
    ver: newManifest.ver,
    manifest_cid: newManifestCid,
    tip: newManifestCid,
  };

  return c.json(response, 201);
}

/**
 * GET /entities/:pi/versions
 * List version history (paginated, newest first)
 */
export async function listVersionsHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  const pi = c.req.param('pi');
  const { limit, cursor } = validatePagination(new URL(c.req.url));

  // Start from cursor or tip
  let currentCid = cursor || (await tipSvc.readTip(pi));

  const items = [];
  let nextCursor: string | null = null;

  // Walk backward through prev links
  for (let i = 0; i < limit; i++) {
    const manifest = (await ipfs.dagGet(currentCid)) as ManifestV1;

    items.push({
      ver: manifest.ver,
      cid: currentCid,
      ts: manifest.ts,
      ...(manifest.note && { note: manifest.note }),
    });

    // Check if there's a previous version
    if (manifest.prev) {
      currentCid = manifest.prev['/'];
    } else {
      // Reached v1, no more history
      break;
    }
  }

  // If we stopped before reaching v1, set next_cursor
  if (items.length === limit) {
    const lastManifest = (await ipfs.dagGet(currentCid)) as ManifestV1;
    if (lastManifest.prev) {
      nextCursor = lastManifest.prev['/'];
    }
  }

  const response: ListVersionsResponse = {
    items,
    next_cursor: nextCursor,
  };

  return c.json(response);
}

/**
 * GET /entities/:pi/versions/:selector
 * Get specific version by cid:<CID> or ver:<N>
 */
export async function getVersionHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');

  const pi = c.req.param('pi');
  const selectorParam = c.req.param('selector');

  const selector = parseVersionSelector(selectorParam);

  let manifestCid: string;

  if (selector.type === 'cid') {
    // Direct CID lookup
    manifestCid = selector.value as string;
  } else {
    // Walk back from tip to find version number
    const targetVer = selector.value as number;
    let currentCid = await tipSvc.readTip(pi);

    while (true) {
      const manifest = (await ipfs.dagGet(currentCid)) as ManifestV1;

      if (manifest.ver === targetVer) {
        manifestCid = currentCid;
        break;
      }

      if (!manifest.prev) {
        throw new ValidationError(
          `Version ${targetVer} not found (oldest is v${manifest.ver})`
        );
      }

      if (manifest.ver < targetVer) {
        throw new ValidationError(
          `Version ${targetVer} not found (latest is v${manifest.ver})`
        );
      }

      currentCid = manifest.prev['/'];
    }
  }

  // Fetch manifest
  const manifest = (await ipfs.dagGet(manifestCid)) as ManifestV1;

  // Transform to response format
  const response: GetEntityResponse = {
    pi: manifest.pi,
    ver: manifest.ver,
    ts: manifest.ts,
    manifest_cid: manifestCid,
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

  return c.json(response);
}
