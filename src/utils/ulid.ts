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
 * Returns [first2chars, next2chars] for sharding
 * Example: "01J8ME3H6FZ3KQ5W1P2XY8K7E5" -> ["01", "J8"]
 */
export function shard2(ulid: string): [string, string] {
  return [ulid.slice(0, 2), ulid.slice(2, 4)];
}
