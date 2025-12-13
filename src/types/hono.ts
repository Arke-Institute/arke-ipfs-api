/**
 * Shared Hono context types for handlers
 */
import type { Env } from './env';
import type { IPFSService } from '../services/ipfs';
import type { TipService } from '../services/tip';
import type { Network } from './network';

/**
 * Variables injected by middleware into the Hono context
 */
export type Variables = {
  ipfs: IPFSService;
  tipService: TipService;
  network: Network;
};

/**
 * Full Hono environment type (Bindings + Variables)
 * Use this for handler context types: Context<HonoEnv>
 */
export type HonoEnv = {
  Bindings: Env;
  Variables: Variables;
};
