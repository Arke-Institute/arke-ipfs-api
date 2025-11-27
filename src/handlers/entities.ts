import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { validateBody } from '../utils/validation';
import { getBackendURL } from '../config';
import { listEventsFromBackend } from '../clients/ipfs-server';
import { createEntity, getEntity } from '../services/entity-ops';
import {
  ManifestV1,
  CreateEntityRequestSchema,
} from '../types/manifest';
import { Network, validatePiMatchesNetwork } from '../types/network';

/**
 * POST /entities
 * Create new entity with v1 manifest
 */
export async function createEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const backendURL = getBackendURL(c.env);

  // Validate request body
  const body = await validateBody(c.req.raw, CreateEntityRequestSchema);

  // Call service layer (network validation happens inside createEntity)
  const response = await createEntity(ipfs, tipSvc, backendURL, body, network);

  return c.json(response, 201);
}

/**
 * GET /entities/:pi
 * Fetch latest manifest for entity
 */
export async function getEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const pi = c.req.param('pi');

  // Validate PI matches the requested network
  validatePiMatchesNetwork(pi, network);

  // Call service layer
  const response = await getEntity(ipfs, tipSvc, pi);

  return c.json(response);
}

/**
 * GET /entities
 * List entities with cursor-based pagination
 * Query params: cursor, limit, include_metadata
 */
export async function listEntitiesHandler(c: Context): Promise<Response> {
  const startTime = Date.now();
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
    // CID format check (CIDv1 base32: starts with 'b' + base32 multibase prefix)
    // Accepts: bafyb... (raw/dag-pb), baguqeera... (dag-json), etc.
    if (!/^b[a-z2-7]{52,}$/i.test(cursor)) {
      return c.json(
        {
          error: 'INVALID_CURSOR',
          message: 'cursor must be a valid CID (base32 format)',
        },
        400
      );
    }
  }

  // Get event stream from backend API
  let backendResult;
  try {
    const backendURL = getBackendURL(c.env);
    backendResult = await listEventsFromBackend(backendURL, {
      limit,
      cursor: cursor || undefined,
    });
    console.log(`[HANDLER] Got ${backendResult.items.length} events from backend API`);
  } catch (error) {
    console.error('[HANDLER] Backend API request failed:', error);
    return c.json(
      {
        error: 'BACKEND_ERROR',
        message: 'Failed to retrieve entities from backend',
      },
      503
    );
  }

  // Transform events to entities (events are chronological, deduplicate by PI)
  // Note: Events are ordered newest-first, so first occurrence of each PI is the latest
  const seenPIs = new Set<string>();
  const baseEntities = backendResult.items
    .filter((event) => {
      if (seenPIs.has(event.pi)) {
        return false; // Skip duplicate PIs
      }
      seenPIs.add(event.pi);
      return true;
    })
    .map((event) => ({
      pi: event.pi,
      tip: event.tip_cid,
    }));

  // If include_metadata is requested, fetch manifests
  let entities;
  if (includeMetadata) {
    console.log(`[HANDLER] Fetching metadata for ${baseEntities.length} entities...`);
    entities = await Promise.all(
      baseEntities.map(async ({ pi, tip }) => {
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
    entities = baseEntities;
  }

  const duration = Date.now() - startTime;
  console.log(`[HANDLER] Response ready (${duration}ms): ${entities.length} entities, next_cursor=${backendResult.next_cursor || 'null'}`);

  return c.json({
    entities,
    limit,
    next_cursor: backendResult.next_cursor,
  });
}
