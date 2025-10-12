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

  if (!env.IPFS_SERVER_API_URL) {
    throw new Error(
      'IPFS_SERVER_API_URL is required. Set it with: wrangler secret put IPFS_SERVER_API_URL'
    );
  }

  // Validate URL formats
  try {
    new URL(env.IPFS_API_URL);
  } catch {
    throw new Error(`Invalid IPFS_API_URL: ${env.IPFS_API_URL}`);
  }

  try {
    new URL(env.IPFS_SERVER_API_URL);
  } catch {
    throw new Error(`Invalid IPFS_SERVER_API_URL: ${env.IPFS_SERVER_API_URL}`);
  }
}

/**
 * Get IPFS API URL from environment
 */
export function getIPFSURL(env: Env): string {
  return env.IPFS_API_URL;
}

/**
 * Get IPFS Server Backend API URL from environment
 */
export function getBackendURL(env: Env): string {
  return env.IPFS_SERVER_API_URL;
}

/**
 * Get Arke origin block PI from environment (with default)
 */
export function getArkePI(env: Env): string {
  return env.ARKE_PI || '00000000000000000000000000';
}
