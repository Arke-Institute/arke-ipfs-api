import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { syncPI } from '../services/sync';
import { CASError, ValidationError, TipWriteRaceError } from '../utils/errors';
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
  ListVersionsResponse,
  GetEntityResponse,
} from '../types/manifest';
import {
  Eidos,
  AppendVersionRequest,
  AppendVersionResponse,
  AppendVersionRequestSchema,
} from '../types/eidos';
import { appendVersion } from '../services/eidos-ops';
import { Network, validatePiMatchesNetwork } from '../types/network';
import { HonoEnv } from '../types/hono';
import { checkEditPermission } from '../lib/permissions';

// Maximum number of children that can be added/removed in a single request
const MAX_CHILDREN_PER_REQUEST = 100;

// Batch size for parallel processing (to avoid overwhelming Cloudflare Workers)
// Reduced to 2 to stay well under the 6 concurrent subrequest limit
// Each child update makes ~5 IPFS requests, so 2 children = ~10 concurrent requests
const BATCH_SIZE = 2;

/**
 * POST /entities/:pi/versions
 * Append new version (CAS-protected with automatic retry on race conditions)
 */
export async function appendVersionHandler(c: Context<HonoEnv>): Promise<Response> {
  const MAX_CAS_RETRIES = 3;

  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const pi = c.req.param('pi');

  // Validate PI matches the requested network
  validatePiMatchesNetwork(pi, network);

  // Permission check - verify user can edit this entity
  // Skip permission check for test network (ephemeral data, no access control needed)
  if (network !== 'test') {
    const userId = c.req.header('X-User-Id') || null;
    const permCheck = await checkEditPermission(c.env, userId, pi);

    if (!permCheck.allowed) {
      return c.json({
        error: 'FORBIDDEN',
        message: permCheck.reason || 'Not authorized to edit this entity',
      }, 403);
    }
  }

  // Parse body ONCE (can't re-read request body stream)
  const body = await validateBody(c.req.raw, AppendVersionRequestSchema);

  // Validate children_pi_add match network (prevents cross-network relationships)
  if (body.children_pi_add) {
    for (const childPi of body.children_pi_add) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  // Validate children_pi_remove match network
  if (body.children_pi_remove) {
    for (const childPi of body.children_pi_remove) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  let response: Response | undefined;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    try {
      response = await appendVersionAttempt(ipfs, tipSvc, pi, body, c.env);
      break;
    } catch (error) {
      // Retry on both CASError (initial check failure) and TipWriteRaceError (atomic write race)
      const isRetryableError = (error instanceof TipWriteRaceError) || (error instanceof CASError);

      if (isRetryableError && attempt < MAX_CAS_RETRIES - 1) {
        // Exponential backoff: 50ms, 100ms, 200ms
        const delay = 50 * (2 ** attempt) + Math.random() * 50;
        const errorType = error instanceof TipWriteRaceError ? 'Tip write race' : 'CAS failure';
        console.log(`[CAS] ${errorType} detected for ${pi}, retrying in ${delay.toFixed(0)}ms (attempt ${attempt + 2}/${MAX_CAS_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  if (!response) {
    // Should never reach here, but TypeScript needs this
    throw new CASError({
      actual: 'unknown',
      expect: 'unknown',
    });
  }

  // Fire-and-forget sync to index-sync service
  c.executionCtx.waitUntil(
    syncPI(c.env, {
      pi,
      network,
      event: 'updated',
    })
  );

  return response;
}

/**
 * Single attempt at appending a version
 * Throws TipWriteRaceError if race condition detected
 */
async function appendVersionAttempt(
  ipfs: IPFSService,
  tipSvc: TipService,
  pi: string,
  body: AppendVersionRequest,
  env: any
): Promise<Response> {

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

  // Call eidos-ops appendVersion (handles CAS, manifest update, tip write)
  const response = await appendVersion(ipfs, tipSvc, pi, body);

  const newManifestCid = response.tip;

  // Update children entities with hierarchy_parent (bidirectional relationship)
  // Add hierarchy_parent to newly added children (BATCHED PARALLELIZATION)
  if (body.children_pi_add) {
    await processBatchedSettled(
      body.children_pi_add,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as Eidos;

        // Only update if hierarchy_parent is different (avoid unnecessary versions)
        if (childManifest.hierarchy_parent !== pi) {
          const updatedChildManifest: Eidos = {
            ...childManifest,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            hierarchy_parent: pi, // Set hierarchy parent reference
            note: `Set hierarchy parent to ${pi}`,
          };

          const newChildTip = await ipfs.dagPut(updatedChildManifest);
          await tipSvc.writeTipAtomic(childPi, newChildTip, childTip);

          console.log(`[RELATION] Updated child ${childPi} to set hierarchy_parent=${pi}`);
        }
      }
    );
  }

  // Remove hierarchy_parent from removed children (BATCHED PARALLELIZATION)
  if (body.children_pi_remove) {
    await processBatchedSettled(
      body.children_pi_remove,
      BATCH_SIZE,
      async (childPi) => {
        const childTip = await tipSvc.readTip(childPi);
        const childManifest = (await ipfs.dagGet(childTip)) as Eidos;

        // Only update if child actually has this parent
        if (childManifest.hierarchy_parent === pi) {
          const updatedChildManifest: Eidos = {
            ...childManifest,
            ver: childManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(childTip),
            // hierarchy_parent is omitted (removed)
            note: `Removed hierarchy parent ${pi}`,
          };
          // Remove hierarchy_parent field
          delete updatedChildManifest.hierarchy_parent;

          const newChildTip = await ipfs.dagPut(updatedChildManifest);
          await tipSvc.writeTipAtomic(childPi, newChildTip, childTip);

          console.log(`[RELATION] Updated child ${childPi} to remove hierarchy_parent`);
        }
      }
    );
  }

  // Append update event to event stream (optimization - don't fail version append if this fails)
  try {
    const backendURL = getBackendURL(env);
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi,
      ver: response.ver,
      tip_cid: newManifestCid,
    });
    console.log(`[EVENT] Appended update event for entity ${pi} v${response.ver}: ${eventCid}`);
  } catch (error) {
    // Log error but don't fail the request - event append is async optimization
    console.error(`[EVENT] Failed to append update event for entity ${pi}:`, error);
  }

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /entities/:pi/versions
 * List version history (paginated, newest first)
 */
export async function listVersionsHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const pi = c.req.param('pi');

  // Validate PI matches the requested network
  validatePiMatchesNetwork(pi, network);

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
  const network: Network = c.get('network');

  const pi = c.req.param('pi');

  // Validate PI matches the requested network
  validatePiMatchesNetwork(pi, network);

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
