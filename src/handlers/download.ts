import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { assertValidCID } from '../utils/cid';

/**
 * GET /cat/:cid
 * Download file content by CID
 * Streams bytes directly from IPFS
 */
export async function downloadHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const cid = c.req.param('cid');

  // Validate CID format
  assertValidCID(cid, 'CID parameter');

  // Stream file content from IPFS
  const response = await ipfs.cat(cid);

  // Detect content type from CID or default to octet-stream
  const contentType = guessContentType(cid) || 'application/octet-stream';

  // Return the response with proper headers
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable', // CIDs are immutable
      'X-IPFS-CID': cid,
    },
  });
}

/**
 * Guess content type from CID or filename
 * This is basic - could be enhanced with magic number detection
 */
function guessContentType(cid: string): string | null {
  // Note: CIDs don't contain filenames, so this is very limited
  // In production, you'd want to store content-type in metadata
  // or detect from magic numbers in the file content

  // For now, return null to use octet-stream
  return null;
}
