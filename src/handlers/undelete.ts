import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { validateBody } from '../utils/validation';
import { undeleteEntity } from '../services/eidos/undelete';
import { UndeleteEntityRequestSchema } from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';
import { syncEidos } from '../services/sync';

/**
 * POST /entities/:id/undelete
 * Restore a deleted entity back to active state
 */
export async function undeleteEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const entityId = c.req.param('id');

  // Validate entity_id matches the requested network
  validatePiMatchesNetwork(entityId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, UndeleteEntityRequestSchema);

  // Undelete entity (restore from tombstone)
  const response = await undeleteEntity(ipfs, tipSvc, entityId, body);

  // Fire-and-forget sync to index-sync service
  c.executionCtx.waitUntil(
    syncEidos(c.env, {
      id: entityId,
      network,
      event: 'undeleted',
    })
  );

  return c.json(response, 201);
}
