import { IPFSService } from './ipfs';
import { shard2 } from '../utils/ulid';
import { NotFoundError, IPFSError } from '../utils/errors';

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
}
