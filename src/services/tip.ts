import { IPFSService } from './ipfs';
import { shard2 } from '../utils/ulid';
import { NotFoundError, IPFSError } from '../utils/errors';
import { generateShardPairsFromCursor } from '../utils/shard';

/**
 * Tip file management in MFS
 * Tips are stored at: /arke/index/<shard2[0]>/<shard2[1]>/<PI>.tip
 * Each .tip file contains a single line: <manifest_cid>\n
 */
export class TipService {
  private readonly baseDir = '/arke/index';

  constructor(private ipfs: IPFSService) {}

  /**
   * Build MFS path for PI's .tip file
   * Example: "01J8ME3H..." -> "/arke/index/01/J8/01J8ME3H....tip"
   */
  tipPath(pi: string): string {
    const [a, b] = shard2(pi);
    return `${this.baseDir}/${a}/${b}/${pi}.tip`;
  }

  /**
   * Build directory path for PI
   */
  private tipDir(pi: string): string {
    const [a, b] = shard2(pi);
    return `${this.baseDir}/${a}/${b}`;
  }

  /**
   * Read tip CID for PI
   * Throws NotFoundError if tip doesn't exist
   */
  async readTip(pi: string): Promise<string> {
    const path = this.tipPath(pi);
    try {
      const content = await this.ipfs.mfsRead(path);
      return content.trim();
    } catch (error) {
      throw new NotFoundError('Entity', pi);
    }
  }

  /**
   * Write tip CID for PI
   * Creates parent directories if needed
   */
  async writeTip(pi: string, cid: string): Promise<void> {
    const dir = this.tipDir(pi);
    const path = this.tipPath(pi);

    try {
      // Ensure parent directories exist
      const dirExists = await this.ipfs.mfsExists(dir);
      if (!dirExists) {
        await this.ipfs.mfsMkdir(dir, true);
      }

      // Write tip file (create or overwrite)
      await this.ipfs.mfsWrite(path, `${cid}\n`, {
        create: true,
        truncate: true,
      });
    } catch (error) {
      throw new IPFSError(`Failed to write tip for ${pi}: ${error}`);
    }
  }

  /**
   * Check if tip exists for PI
   */
  async tipExists(pi: string): Promise<boolean> {
    const path = this.tipPath(pi);
    return await this.ipfs.mfsExists(path);
  }

  /**
   * Delete tip for PI
   * Used for cleanup/testing (not part of normal API)
   */
  async deleteTip(pi: string): Promise<void> {
    const path = this.tipPath(pi);
    try {
      // Note: files/rm not implemented in IPFSService yet
      // Would need: await this.ipfs.mfsRm(path);
      throw new Error('Delete not implemented');
    } catch (error) {
      throw new IPFSError(`Failed to delete tip for ${pi}: ${error}`);
    }
  }

  /**
   * Get MFS stat for tip file (useful for debugging)
   */
  async tipStat(pi: string): Promise<{
    Hash: string;
    Size: number;
    Type: 'file';
  }> {
    const path = this.tipPath(pi);
    try {
      const stat = await this.ipfs.mfsStat(path);
      return {
        Hash: stat.Hash,
        Size: stat.Size,
        Type: 'file',
      };
    } catch (error) {
      throw new NotFoundError('Entity', pi);
    }
  }

  /**
   * List .tip files in a specific shard directory
   * Returns array of PIs (without .tip extension)
   */
  private async listTipFiles(shard1: string, shard2: string): Promise<string[]> {
    try {
      const entries = await this.ipfs.mfsList(`${this.baseDir}/${shard1}/${shard2}`);
      const pis = entries
        .filter((e) => e.Type === 0 && e.Name.endsWith('.tip')) // Only .tip files
        .map((e) => e.Name.replace(/\.tip$/, ''))
        .sort(); // Sort by PI (lexicographic = chronological for ULIDs)
      return pis;
    } catch (error) {
      // Directory doesn't exist - this is expected for most shard combinations
      return [];
    }
  }

  /**
   * Iterate through entities in shard order, starting after cursor
   * Uses precomputed shard enumeration with parallel batch processing
   * Yields {pi, tip} for each entity found
   */
  private async *iterateShards(cursor?: string): AsyncGenerator<{ pi: string; tip: string }> {
    const [cursorShard1, cursorShard2] = cursor ? shard2(cursor) : [undefined, undefined];
    console.log(`[TIP] Starting parallel shard enumeration${cursor ? ` from cursor: ${cursor} (shard ${cursorShard1}/${cursorShard2})` : ''}`);

    const BATCH_SIZE = 100; // Check 100 shards in parallel
    let shardsChecked = 0;
    let shardsWithData = 0;

    const shardGenerator = generateShardPairsFromCursor(cursorShard1, cursorShard2);

    while (true) {
      // Collect batch of shards to check
      const batch: Array<[string, string]> = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const next = shardGenerator.next();
        if (next.done) break;
        batch.push(next.value);
      }

      if (batch.length === 0) break; // No more shards to check

      // Check all shards in batch in parallel
      const results = await Promise.all(
        batch.map(async ([shard1, shard2]) => {
          const pis = await this.listTipFiles(shard1, shard2);
          return { shard1, shard2, pis };
        })
      );

      shardsChecked += batch.length;

      // Process results in order (maintain lexicographic sorting)
      for (const { shard1, shard2, pis } of results) {
        if (pis.length > 0) {
          shardsWithData++;
          console.log(`[TIP] Shard ${shard1}/${shard2}: Found ${pis.length} entities (batch checked ${shardsChecked} shards total)`);

          // Yield entities in sorted order
          for (const pi of pis) {
            // Skip PIs up to and including the cursor
            if (cursor && pi <= cursor) continue;

            // Read tip and yield
            const tip = await this.readTip(pi);
            yield { pi, tip };
          }
        }
      }
    }

    console.log(`[TIP] Iteration complete: checked ${shardsChecked} shards in parallel batches, found data in ${shardsWithData}`);
  }

  /**
   * List entities with cursor-based pagination
   * Returns entities and next cursor (null if no more pages)
   */
  async listEntitiesWithCursor(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<{
    entities: Array<{ pi: string; tip: string }>;
    next_cursor: string | null;
  }> {
    const limit = options?.limit ?? 100;
    const cursor = options?.cursor;

    console.log(`[TIP] listEntitiesWithCursor(limit=${limit}, cursor=${cursor || 'none'})`);

    const entities: Array<{ pi: string; tip: string }> = [];

    // Iterate through shards and collect entities
    for await (const entity of this.iterateShards(cursor)) {
      entities.push(entity);

      if (entities.length >= limit) {
        // We have enough entities, return with next cursor
        const lastPI = entities[entities.length - 1].pi;
        console.log(`[TIP] Returning ${entities.length} entities, next_cursor=${lastPI}`);
        return {
          entities,
          next_cursor: lastPI, // Cursor is just the last PI
        };
      }
    }

    // No more entities available
    console.log(`[TIP] Returning ${entities.length} entities (end of list)`);
    return {
      entities,
      next_cursor: null,
    };
  }
}
