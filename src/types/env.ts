/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /**
   * IPFS Kubo RPC API URL
   * Example: http://ipfs-kubo:5001 or http://127.0.0.1:5001
   * Set with: wrangler secret put IPFS_API_URL
   */
  IPFS_API_URL: string;

  /**
   * IPFS Server Backend API URL
   * Example: http://localhost:3000 or http://ipfs-api:3000
   * Set with: wrangler secret put IPFS_SERVER_API_URL
   */
  IPFS_SERVER_API_URL: string;

  /**
   * Optional: deployment environment identifier
   */
  ENVIRONMENT?: string;
}
