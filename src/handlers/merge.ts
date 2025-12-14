import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { validateBody } from '../utils/validation';
import { mergeEntities, unmergeEntity } from '../services/eidos-ops';
import {
  MergeEntityRequest,
  MergeEntityRequestSchema,
  UnmergeEntityRequest,
  UnmergeEntityRequestSchema,
} from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';

/**
 * POST /entities/:sourceId/merge
 * Merge source entity into target entity
 */
export async function mergeEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const sourceId = c.req.param('sourceId');

  // Validate source ID matches network
  validatePiMatchesNetwork(sourceId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, MergeEntityRequestSchema);

  // Validate target ID matches network
  validatePiMatchesNetwork(body.target_id, network);

  // Call service layer
  const response = await mergeEntities(ipfs, tipSvc, sourceId, body);

  return c.json(response, 201);
}

/**
 * POST /entities/:sourceId/unmerge
 * Unmerge (restore) a previously merged entity
 */
export async function unmergeEntityHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const sourceId = c.req.param('sourceId');

  // Validate source ID matches network
  validatePiMatchesNetwork(sourceId, network);

  // Validate request body
  const body = await validateBody(c.req.raw, UnmergeEntityRequestSchema);

  // Validate target ID matches network
  validatePiMatchesNetwork(body.target_id, network);

  // Call service layer
  const response = await unmergeEntity(ipfs, tipSvc, sourceId, body);

  return c.json(response, 201);
}
