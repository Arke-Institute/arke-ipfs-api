import { isValidUlid } from './ulid';

/**
 * Cursor-based pagination utilities
 *
 * Cursor is simply the last PI (ULID) seen in the previous page.
 * Since the PI contains the shard info in its first 4 characters,
 * we can extract the shard from the PI itself.
 *
 * Example cursor: "01K78F523TFN01651HDSEV6PVF"
 */

/**
 * Create cursor from PI
 * Cursor is just the PI itself (URL-safe, no encoding needed)
 */
export function encodeCursor(lastPI: string): string {
  if (!isValidUlid(lastPI)) {
    throw new Error('Invalid PI for cursor');
  }
  return lastPI;
}

/**
 * Validate and return cursor (PI)
 * The cursor is the PI itself, so just validate it
 */
export function decodeCursor(cursor: string): string {
  if (!isValidUlid(cursor)) {
    throw new Error('Invalid cursor: must be a valid 26-character ULID');
  }
  return cursor;
}

/**
 * Validate cursor string
 */
export function isValidCursor(cursor: string): boolean {
  return isValidUlid(cursor);
}
