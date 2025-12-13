import { Network, TEST_PI_PREFIX } from '../types/network';

/**
 * ULID validation regex
 * ULIDs are 26 characters, using Crockford's base32 alphabet
 */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Crockford's Base32 alphabet (excludes I, L, O, U to avoid confusion)
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a new ULID using Web Crypto API (compatible with Cloudflare Workers)
 *
 * ULID format: TTTTTTTTTTRRRRRRRRRRRRRRRR
 * - 10 chars: timestamp (48 bits)
 * - 16 chars: randomness (80 bits)
 */
export function ulid(): string {
  // Get current timestamp in milliseconds
  const now = Date.now();

  // Encode timestamp (10 characters, 48 bits)
  let time = now;
  let timeStr = '';
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeStr = ENCODING[mod] + timeStr;
    time = Math.floor(time / 32);
  }

  // Generate random bytes for randomness part (16 characters, 80 bits = 10 bytes)
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);

  // Encode randomness (16 characters)
  let randomStr = '';
  let bits = 0;
  let buffer = 0;

  for (let i = 0; i < randomBytes.length; i++) {
    buffer = (buffer << 8) | randomBytes[i];
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      const index = (buffer >> bits) & 0x1f;
      randomStr += ENCODING[index];
    }
  }

  // Add remaining bits if any
  if (bits > 0) {
    const index = (buffer << (5 - bits)) & 0x1f;
    randomStr += ENCODING[index];
  }

  // Ensure exactly 16 characters
  randomStr = randomStr.slice(0, 16);

  return timeStr + randomStr;
}

/**
 * Validate ULID format
 */
export function isValidUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}

/**
 * Validate ULID and throw if invalid
 */
export function assertValidUlid(value: string, label: string = 'ULID'): void {
  if (!isValidUlid(value)) {
    throw new Error(`Invalid ${label}: must be 26-character ULID (got: ${value})`);
  }
}

/**
 * Extract shard prefix for MFS path organization
 * Uses LAST 4 characters (from the random portion) for even distribution.
 *
 * ULID structure: TTTTTTTTTTRRRRRRRRRRRRRRRR
 *                 |---------|---------------|
 *                 timestamp  randomness
 *                 (10 chars) (16 chars)
 *
 * Using first 4 chars (old approach) was problematic because:
 * - Char 0-1 change every ~278 years (essentially constant)
 * - Char 2-3 change every ~99 days
 * - Result: all data in same few directories
 *
 * Using last 4 chars (new approach):
 * - Fully random, uniform distribution
 * - 32^4 = 1,048,576 possible shard combinations
 *
 * Example: "01J8ME3H6FZ3KQ5W1P2XY8K7E5" -> ["K7", "E5"]
 * Example: "IIAK75HQQXNTDG7BBP7PS9AWY" -> ["AW", "Y"]  (note: test IDs are 25 chars)
 */
export function shard2(ulid: string): [string, string] {
  return [ulid.slice(-4, -2), ulid.slice(-2)];
}

/**
 * OLD sharding function - used for migration only
 * DO NOT USE for new code
 */
export function shard2Old(ulid: string): [string, string] {
  return [ulid.slice(0, 2), ulid.slice(2, 4)];
}

/**
 * Generate a PI (Persistent Identifier) for the specified network
 *
 * - Main network: Standard ULID (timestamp + random)
 * - Test network: 'II' prefix + 24 chars from ULID (drops first 2 timestamp chars)
 *
 * Test PIs use 'II' prefix because 'I' is excluded from Crockford Base32,
 * making it impossible for a real ULID to ever start with 'II'.
 */
export function generatePi(network: Network = 'main'): string {
  const id = ulid();
  if (network === 'test') {
    // Replace first 2 chars with test prefix
    return TEST_PI_PREFIX + id.slice(2);
  }
  return id;
}
