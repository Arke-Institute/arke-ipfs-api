/**
 * Client for IPFS Server Backend API
 * Handles chain append operations and snapshot-based entity listing
 */

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @param fn - Function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param baseDelay - Base delay in ms (default: 100)
 * @returns Result of the function
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 100
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

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
 * Append a new entity to the recent chain (with retry logic)
 * Called after entity creation to update the snapshot system
 *
 * @param backendURL - Base URL of IPFS Server API
 * @param pi - Persistent identifier (ULID)
 * @param maxRetries - Maximum number of retries (default: 5)
 * @returns Chain entry CID
 * @throws Error if all retries fail
 */
export async function appendToChain(
  backendURL: string,
  pi: string,
  maxRetries: number = 5
): Promise<string> {
  return retryWithBackoff(async () => {
    const url = `${backendURL}/chain/append`;

    const body: ChainAppendRequest = {
      pi,
    };

    // Add timeout to prevent hanging (10 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Chain append failed: ${response.status} ${response.statusText} - ${text}`
        );
      }

      const result: ChainAppendResponse = await response.json();
      return result.cid;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error).name === 'AbortError') {
        throw new Error('Chain append timeout after 10s');
      }
      throw error;
    }
  }, maxRetries);
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
