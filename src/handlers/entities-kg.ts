import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { validateBody } from '../utils/validation';
import {
  createEntityKG,
  getEntityKG,
  getEntityKGLightweight,
  getEntitiesKGLightweight,
  appendEntityVersion,
  mergeEntityKG,
} from '../services/entity-kg-ops';
import {
  CreateEntityKGRequestSchema,
  AppendEntityVersionRequestSchema,
  MergeEntityRequestSchema,
} from '../types/entity-manifest';
import { Network, validatePiMatchesNetwork } from '../types/network';

/**
 * POST /entities-kg
 * Create new entity in knowledge graph
 */
export async function createEntityKGHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  // Validate request body
  const body = await validateBody(c.req.raw, CreateEntityKGRequestSchema);

  // Validate network consistency
  if (body.entity_id) {
    validatePiMatchesNetwork(body.entity_id, network);
  }
  validatePiMatchesNetwork(body.created_by_pi, network);
  if (body.source_pis) {
    for (const pi of body.source_pis) {
      validatePiMatchesNetwork(pi, network);
    }
  }

  // Create entity
  const response = await createEntityKG(ipfs, tipSvc, body, network);

  return c.json(response, 201);
}

/**
 * GET /entities-kg/:entity_id
 * Fetch entity by ID (returns redirect info if merged)
 */
export async function getEntityKGHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const entityId = c.req.param('entity_id');

  // Validate entity_id matches the requested network
  validatePiMatchesNetwork(entityId, network);

  // Check for lightweight resolve mode
  const resolve = c.req.query('resolve');
  if (resolve === 'lightweight') {
    const result = await getEntityKGLightweight(ipfs, tipSvc, entityId);
    return c.json(result);
  }

  // Full entity fetch
  const result = await getEntityKG(ipfs, tipSvc, entityId);
  return c.json(result);
}

/**
 * POST /entities-kg/:entity_id/versions
 * Append new version to entity
 */
export async function appendEntityVersionHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const entityId = c.req.param('entity_id');

  // Validate entity_id matches the requested network
  validatePiMatchesNetwork(entityId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, AppendEntityVersionRequestSchema);

  // Validate network consistency for source_pis
  if (body.source_pis_add) {
    for (const pi of body.source_pis_add) {
      validatePiMatchesNetwork(pi, network);
    }
  }
  if (body.source_pis_remove) {
    for (const pi of body.source_pis_remove) {
      validatePiMatchesNetwork(pi, network);
    }
  }

  // Append version
  const response = await appendEntityVersion(ipfs, tipSvc, entityId, body);

  return c.json(response, 201);
}

/**
 * POST /entities-kg/:entity_id/merge
 * Merge this entity into another entity
 */
export async function mergeEntityKGHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const entityId = c.req.param('entity_id');

  // Validate entity_id matches the requested network
  validatePiMatchesNetwork(entityId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, MergeEntityRequestSchema);

  // Validate target entity matches network
  validatePiMatchesNetwork(body.merge_into, network);

  // Merge entity
  const response = await mergeEntityKG(
    ipfs,
    tipSvc,
    entityId,
    body.merge_into,
    body.expect_tip,
    body.note
  );

  return c.json(response, 201);
}

/**
 * POST /entities-kg/batch/lightweight
 * Batch fetch lightweight entities (for context loading)
 */
export async function batchGetLightweightHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  // Parse body
  const body = await c.req.json() as { entity_ids: string[] };

  if (!body.entity_ids || !Array.isArray(body.entity_ids)) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'entity_ids array required' }, 400);
  }

  if (body.entity_ids.length > 100) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Maximum 100 entity_ids per request' }, 400);
  }

  // Validate all entity IDs match network
  for (const entityId of body.entity_ids) {
    validatePiMatchesNetwork(entityId, network);
  }

  // Batch fetch
  const entities = await getEntitiesKGLightweight(ipfs, tipSvc, body.entity_ids);

  return c.json({ entities });
}
