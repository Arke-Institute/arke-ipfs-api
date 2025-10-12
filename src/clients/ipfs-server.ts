/**
 * Client for IPFS Server Backend API
 * Handles chain append operations and snapshot-based entity listing
 */

/**
 * Request body for POST /chain/append
 */
export interface ChainAppendRequest {
  pi: string;
}

/**
 * Response from POST /chain/append
 */
export interface ChainAppendResponse {
  cid: string;
  success: boolean;
}

/**
 * Entity item returned from backend
 */
export interface BackendEntity {
  pi: string;
  ver: number;
  tip: string;
  ts: string;
}

/**
 * Response from GET /entities
 */
export interface BackendEntitiesResponse {
  items: BackendEntity[];
  total_count: number;
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * Append a new entity to the recent chain
 * Called after entity creation to update the snapshot system
 *
 * @param backendURL - Base URL of IPFS Server API
 * @param pi - Persistent identifier (ULID)
 * @returns Chain entry CID
 * @throws Error if the request fails
 */
export async function appendToChain(
  backendURL: string,
  pi: string
): Promise<string> {
  const url = `${backendURL}/chain/append`;

  const body: ChainAppendRequest = {
    pi,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Chain append failed: ${response.status} ${response.statusText} - ${text}`
    );
  }

  const result: ChainAppendResponse = await response.json();
  return result.cid;
}

/**
 * List entities from the backend using snapshot + chain hybrid system
 * Replaces MFS traversal with fast backend queries
 *
 * @param backendURL - Base URL of IPFS Server API
 * @param options - Query options
 * @param options.limit - Number of entities to return (default: 10)
 * @param options.cursor - Optional cursor for cursor-based pagination
 * @returns Entity list response
 * @throws Error if the request fails
 */
export async function listEntitiesFromBackend(
  backendURL: string,
  options?: {
    limit?: number;
    cursor?: string;
  }
): Promise<BackendEntitiesResponse> {
  const limit = options?.limit ?? 10;
  const cursor = options?.cursor;

  const url = new URL(`${backendURL}/entities`);
  url.searchParams.set('limit', limit.toString());

  // Use cursor-based pagination
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `List entities failed: ${response.status} ${response.statusText} - ${text}`
    );
  }

  return await response.json();
}

/**
 * Health check for backend API
 *
 * @param backendURL - Base URL of IPFS Server API
 * @returns true if backend is healthy, false otherwise
 */
export async function checkBackendHealth(backendURL: string): Promise<boolean> {
  try {
    const response = await fetch(`${backendURL}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json() as { status?: string };
    return data.status === 'healthy';
  } catch (error) {
    console.error('Backend health check failed:', error);
    return false;
  }
}
