import { IPFSError, parseIPFSError } from '../utils/errors';

/**
 * IPFS RPC client for Kubo HTTP API
 * All methods use POST and call /api/v0/* endpoints
 */
export class IPFSService {
  constructor(private baseURL: string) {
    // Remove trailing slash if present
    this.baseURL = baseURL.replace(/\/$/, '');
  }

  /**
   * Build full API endpoint URL
   */
  private endpoint(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.baseURL}/api/v0${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Make RPC call and handle errors
   */
  private async call(
    endpoint: string,
    options?: RequestInit
  ): Promise<Response> {
    const startTime = Date.now();
    const path = new URL(endpoint).pathname;

    try {
      console.log(`[IPFS] → ${path}`);

      const response = await fetch(endpoint, {
        method: 'POST',
        ...options,
      });

      const duration = Date.now() - startTime;
      console.log(`[IPFS] ← ${path} (${duration}ms, status: ${response.status})`);

      if (!response.ok) {
        // Try to parse IPFS error response
        let errorMessage = `IPFS RPC failed with status ${response.status}`;
        try {
          const errorBody = await response.json();
          errorMessage = parseIPFSError(errorBody);
        } catch {
          // Ignore JSON parse errors
        }
        throw new IPFSError(errorMessage, { status: response.status });
      }

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`[IPFS] ✘ ${path} (${duration}ms, error: ${error})`);

      if (error instanceof IPFSError) {
        throw error;
      }
      throw new IPFSError(
        `Failed to connect to IPFS node: ${parseIPFSError(error)}`
      );
    }
  }

  /**
   * Add file(s) to IPFS
   * POST /api/v0/add
   */
  async add(formData: FormData): Promise<
    Array<{
      Name: string;
      Hash: string;
      Size: string;
    }>
  > {
    const url = this.endpoint('/add', {
      quieter: 'true',
      'cid-version': '1',
      pin: 'true',
    });

    const response = await this.call(url, { body: formData });
    const text = await response.text();

    // IPFS returns newline-delimited JSON
    const results = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    return results;
  }

  /**
   * Store DAG node (dag-cbor)
   * POST /api/v0/dag/put
   *
   * IMPORTANT: Uses input-codec=dag-json to ensure IPLD links
   * are properly typed (CBOR tag-42) for DAG traversal and CAR exports.
   */
  async dagPut(obj: unknown): Promise<string> {
    const url = this.endpoint('/dag/put', {
      'store-codec': 'dag-cbor',
      'input-codec': 'dag-json',
      pin: 'true',
    });

    // Send as multipart form data with field name "object"
    const formData = new FormData();
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    formData.append('object', blob);

    const response = await this.call(url, { body: formData });

    const result = await response.json<{ Cid: { '/': string } }>();
    return result.Cid['/'];
  }

  /**
   * Get DAG node
   * POST /api/v0/dag/get
   */
  async dagGet(cid: string): Promise<unknown> {
    const url = this.endpoint('/dag/get', { arg: cid });
    const response = await this.call(url);
    return await response.json();
  }

  /**
   * Cat file content (stream bytes)
   * POST /api/v0/cat
   */
  async cat(cid: string): Promise<Response> {
    const url = this.endpoint('/cat', { arg: cid });
    return await this.call(url);
  }

  /**
   * Check if block exists
   * POST /api/v0/block/stat
   */
  async blockExists(cid: string): Promise<boolean> {
    try {
      const url = this.endpoint('/block/stat', { arg: cid });
      await this.call(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pin content
   * POST /api/v0/pin/add
   */
  async pinAdd(cid: string, recursive: boolean = true): Promise<void> {
    const url = this.endpoint('/pin/add', {
      arg: cid,
      recursive: recursive.toString(),
    });
    await this.call(url);
  }

  /**
   * Unpin content
   * POST /api/v0/pin/rm
   */
  async pinRm(cid: string, recursive: boolean = true): Promise<void> {
    const url = this.endpoint('/pin/rm', {
      arg: cid,
      recursive: recursive.toString(),
    });
    await this.call(url);
  }

  /**
   * Update pin (efficient pin swap)
   * POST /api/v0/pin/update
   */
  async pinUpdate(oldCid: string, newCid: string): Promise<void> {
    const url = this.endpoint('/pin/update', {
      arg: oldCid,
      arg2: newCid, // Note: second arg parameter
    });
    await this.call(url);
  }

  /**
   * Create MFS directory
   * POST /api/v0/files/mkdir
   */
  async mfsMkdir(path: string, parents: boolean = false): Promise<void> {
    const url = this.endpoint('/files/mkdir', {
      arg: path,
      parents: parents.toString(),
    });
    await this.call(url);
  }

  /**
   * Write to MFS file
   * POST /api/v0/files/write
   */
  async mfsWrite(
    path: string,
    content: string | Uint8Array,
    options: { create?: boolean; truncate?: boolean } = {}
  ): Promise<void> {
    const { create = false, truncate = false } = options;

    const url = this.endpoint('/files/write', {
      arg: path,
      create: create.toString(),
      truncate: truncate.toString(),
    });

    // Send content as form data
    const formData = new FormData();
    const blob = typeof content === 'string'
      ? new Blob([content], { type: 'text/plain' })
      : new Blob([content], { type: 'application/octet-stream' });
    formData.append('file', blob);

    await this.call(url, { body: formData });
  }

  /**
   * Read from MFS file
   * POST /api/v0/files/read
   */
  async mfsRead(path: string): Promise<string> {
    const url = this.endpoint('/files/read', { arg: path });
    const response = await this.call(url);
    return await response.text();
  }

  /**
   * Check if MFS path exists
   * POST /api/v0/files/stat
   */
  async mfsExists(path: string): Promise<boolean> {
    try {
      const url = this.endpoint('/files/stat', { arg: path });
      await this.call(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get MFS file/directory info
   * POST /api/v0/files/stat
   */
  async mfsStat(path: string): Promise<{
    Hash: string;
    Size: number;
    CumulativeSize: number;
    Blocks: number;
    Type: 'directory' | 'file';
  }> {
    const url = this.endpoint('/files/stat', { arg: path });
    const response = await this.call(url);
    return await response.json();
  }

  /**
   * List MFS directory contents
   * POST /api/v0/files/ls
   */
  async mfsList(path: string): Promise<
    Array<{
      Name: string;
      Type: number; // 0=file, 1=directory
      Size: number;
      Hash: string;
    }>
  > {
    const url = this.endpoint('/files/ls', { arg: path, long: 'true' });
    const response = await this.call(url);
    const result = await response.json<{ Entries: Array<{ Name: string; Type: number; Size: number; Hash: string }> | null }>();
    return result.Entries || [];
  }

  /**
   * List directory contents
   * POST /api/v0/ls
   */
  async ls(cid: string): Promise<{
    Objects: Array<{
      Hash: string;
      Links: Array<{
        Name: string;
        Hash: string;
        Size: number;
        Type: number;
      }>;
    }>;
  }> {
    const url = this.endpoint('/ls', { arg: cid });
    const response = await this.call(url);
    return await response.json();
  }

  /**
   * Get repository statistics
   * POST /api/v0/repo/stat
   */
  async repoStat(): Promise<{
    RepoSize: number;
    StorageMax: number;
    NumObjects: number;
    RepoPath: string;
    Version: string;
  }> {
    const url = this.endpoint('/repo/stat');
    const response = await this.call(url);
    return await response.json();
  }
}
