import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { validateBody } from '../utils/validation';
import { deleteEntity } from '../services/eidos/delete';
import { DeleteEntityRequestSchema } from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';

/**
 * POST /entities/:id/delete
 * Soft delete an entity (creates tombstone, preserves history)
 */
export async function deleteEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const entityId = c.req.param('id');

  // Validate entity_id matches the requested network
  validatePiMatchesNetwork(entityId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, DeleteEntityRequestSchema);

  // Delete entity (creates tombstone)
  const response = await deleteEntity(ipfs, tipSvc, entityId, body);

  // TODO: Backend sync (if needed in future)
  // Fire-and-forget sync to index-sync service:
  // c.executionCtx.waitUntil(
  //   syncEntity(c.env, {
  //     entity_id: entityId,
  //     network,
  //     event: 'deleted',
  //   })
  // );

  return c.json(response, 201);
}
