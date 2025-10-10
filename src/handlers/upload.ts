import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { ValidationError } from '../utils/errors';
import type { UploadResponse } from '../types/manifest';

/**
 * POST /upload
 * Upload raw bytes to IPFS
 * Returns CID(s) for use in manifest components
 */
export async function uploadHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');

  // Parse multipart form data
  const formData = await c.req.formData();

  if (formData.entries().next().done) {
    throw new ValidationError('No files provided in upload');
  }

  // Forward to IPFS
  const results = await ipfs.add(formData);

  // Transform to response format
  const uploads: UploadResponse[] = results.map((r) => ({
    name: r.Name || 'file',
    cid: r.Hash,
    size: parseInt(r.Size, 10),
  }));

  return c.json(uploads);
}
