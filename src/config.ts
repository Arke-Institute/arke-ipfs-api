import type { Env } from './types/env';

/**
 * Validate and parse environment configuration
 */
export function validateEnv(env: Env): void {
  if (!env.IPFS_API_URL) {
    throw new Error(
      'IPFS_API_URL is required. Set it with: wrangler secret put IPFS_API_URL'
    );
  }

  // Validate URL format
  try {
    new URL(env.IPFS_API_URL);
  } catch {
    throw new Error(`Invalid IPFS_API_URL: ${env.IPFS_API_URL}`);
  }
}

/**
 * Get IPFS API URL from environment
 */
export function getIPFSURL(env: Env): string {
  return env.IPFS_API_URL;
}
