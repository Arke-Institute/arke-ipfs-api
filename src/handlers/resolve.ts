import { Context } from 'hono';
import { TipService } from '../services/tip';
import type { ResolveResponse } from '../types/manifest';

/**
 * GET /resolve/:pi
 * Fast PI -> tip CID lookup
 * Does not fetch the manifest, just returns the tip CID
 */
export async function resolveHandler(c: Context): Promise<Response> {
  const tipSvc: TipService = c.get('tipService');

  const pi = c.req.param('pi');

  // Read tip CID
  const tipCid = await tipSvc.readTip(pi);

  const response: ResolveResponse = {
    pi,
    tip: tipCid,
  };

  return c.json(response);
}
