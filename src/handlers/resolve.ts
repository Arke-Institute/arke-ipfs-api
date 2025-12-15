import { Context } from 'hono';
import { TipService } from '../services/tip';
import type { ResolveResponse } from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';

/**
 * GET /resolve/:pi
 * Fast PI -> tip CID lookup
 * Does not fetch the manifest, just returns the tip CID
 */
export async function resolveHandler(c: Context): Promise<Response> {
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  const id = c.req.param('id');

  // Validate ID matches the requested network
  validatePiMatchesNetwork(id, network);

  // Read tip CID
  const tipCid = await tipSvc.readTip(id);

  const response: ResolveResponse = {
    pi: id, // Backward compatibility
    id,
    tip: tipCid,
  };

  return c.json(response);
}
