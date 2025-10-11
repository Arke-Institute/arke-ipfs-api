/**
 * Shard enumeration utilities
 *
 * Generates all possible shard combinations for efficient enumeration
 * without relying on slow MFS directory discovery.
 */

/**
 * Crockford's Base32 alphabet (32 characters)
 * Excludes I, L, O, U to avoid confusion
 */
export const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate all possible 2-character shard combinations
 * Returns array of [shard1, shard2] tuples in sorted order
 *
 * Total combinations: 32 * 32 = 1024
 *
 * Example output: [['00', '00'], ['00', '01'], ..., ['ZZ', 'ZZ']]
 */
export function generateAllShardPairs(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  // Generate all shard1 possibilities (first 2 chars of ULID)
  for (let i = 0; i < ENCODING.length; i++) {
    for (let j = 0; j < ENCODING.length; j++) {
      const shard1 = ENCODING[i] + ENCODING[j];

      // Generate all shard2 possibilities (next 2 chars of ULID)
      for (let k = 0; k < ENCODING.length; k++) {
        for (let l = 0; l < ENCODING.length; l++) {
          const shard2 = ENCODING[k] + ENCODING[l];
          pairs.push([shard1, shard2]);
        }
      }
    }
  }

  return pairs;
}

/**
 * Generate shard pairs starting from a cursor position
 * Skips all pairs that are <= cursor's shard position
 *
 * @param cursorShard1 - First shard component of cursor
 * @param cursorShard2 - Second shard component of cursor
 * @returns Generator that yields [shard1, shard2] tuples
 */
export function* generateShardPairsFromCursor(
  cursorShard1?: string,
  cursorShard2?: string
): Generator<[string, string]> {
  for (let i = 0; i < ENCODING.length; i++) {
    for (let j = 0; j < ENCODING.length; j++) {
      const shard1 = ENCODING[i] + ENCODING[j];

      // Skip shard1 values before cursor
      if (cursorShard1 && shard1 < cursorShard1) {
        continue;
      }

      for (let k = 0; k < ENCODING.length; k++) {
        for (let l = 0; l < ENCODING.length; l++) {
          const shard2 = ENCODING[k] + ENCODING[l];

          // Skip shard2 values before cursor (if same shard1)
          if (cursorShard1 && shard1 === cursorShard1) {
            if (cursorShard2 && shard2 < cursorShard2) {
              continue;
            }
          }

          yield [shard1, shard2];
        }
      }
    }
  }
}

/**
 * Count total possible shard combinations
 * Useful for logging/debugging
 */
export function getTotalShardCount(): number {
  return ENCODING.length * ENCODING.length * ENCODING.length * ENCODING.length;
}
