import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { syncEidos } from '../services/sync';
import { validateBody } from '../utils/validation';
import { mergeEntities, unmergeEntity } from '../services/eidos-ops';
import {
  MergeEntityRequest,
  MergeEntityRequestSchema,
  UnmergeEntityRequest,
  UnmergeEntityRequestSchema,
} from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';
import { HonoEnv } from '../types/hono';

/**
 * POST /entities/:sourceId/merge
 * Merge source entity into target entity
 */
export async function mergeEntityHandler(c: Context<HonoEnv>): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const sourceId = c.req.param('id');

  // Validate source ID matches network
  validatePiMatchesNetwork(sourceId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, MergeEntityRequestSchema);

  // Validate target ID matches network
  validatePiMatchesNetwork(body.target_id, network);

  // Call service layer
  const response = await mergeEntities(ipfs, tipSvc, sourceId, body);

  // Fire-and-forget sync to index-sync service (if not skip_sync)
  if (!body.skip_sync) {
    c.executionCtx.waitUntil(
      syncEidos(c.env, {
        id: sourceId,
        network,
        event: 'merged',
        merged_into: body.target_id,
      })
    );
  }

  return c.json(response, 201);
}

/**
 * POST /entities/:sourceId/unmerge
 * Unmerge (restore) a previously merged entity
 */
export async function unmergeEntityHandler(c: Context<HonoEnv>): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const sourceId = c.req.param('id');

  // Validate source ID matches network
  validatePiMatchesNetwork(sourceId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, UnmergeEntityRequestSchema);

  // Validate target ID matches network
  validatePiMatchesNetwork(body.target_id, network);

  // Call service layer
  const response = await unmergeEntity(ipfs, tipSvc, sourceId, body);

  // Fire-and-forget sync to index-sync service
  c.executionCtx.waitUntil(
    syncEidos(c.env, {
      id: sourceId,
      network,
      event: 'unmerged',
    })
  );

  return c.json(response, 201);
}
