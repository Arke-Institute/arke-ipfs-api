import { ValidationError } from '../utils/errors';

/**
 * Network type for separating test and production data
 */
export type Network = 'main' | 'test';

/**
 * Header name for specifying network
 */
export const NETWORK_HEADER = 'X-Arke-Network';

/**
 * Test PI prefix - uses 'II' which is impossible in valid ULIDs
 * (Crockford Base32 excludes I, L, O, U to avoid visual confusion)
 */
export const TEST_PI_PREFIX = 'II';

/**
 * Regex for test PIs: starts with II, followed by 24 valid Crockford Base32 chars
 */
export const TEST_PI_REGEX = /^II[0-9A-HJKMNP-TV-Z]{24}$/;

/**
 * Regex for main PIs: standard ULID format (26 Crockford Base32 chars, no I/L/O/U)
 */
export const MAIN_PI_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Check if a PI belongs to the test network
 */
export function isTestPi(pi: string): boolean {
  return pi.startsWith(TEST_PI_PREFIX);
}

/**
 * Determine which network a PI belongs to based on its format
 */
export function getNetworkFromPi(pi: string): Network {
  return isTestPi(pi) ? 'test' : 'main';
}

/**
 * Validate that a PI matches the expected network
 * Throws ValidationError if there's a mismatch
 */
export function validatePiMatchesNetwork(pi: string, network: Network): void {
  const piNetwork = getNetworkFromPi(pi);
  if (piNetwork !== network) {
    throw new ValidationError(
      `PI ${pi} belongs to ${piNetwork} network but request is for ${network} network`,
      { pi, expected_network: network, actual_network: piNetwork }
    );
  }
}

/**
 * Validate PI format for a specific network
 */
export function isValidPiForNetwork(pi: string, network: Network): boolean {
  if (network === 'test') {
    return TEST_PI_REGEX.test(pi);
  }
  return MAIN_PI_REGEX.test(pi);
}

/**
 * Assert that a PI is valid for the given network
 * Throws ValidationError if invalid
 */
export function assertValidPi(pi: string, network: Network, label: string = 'PI'): void {
  if (network === 'test') {
    if (!TEST_PI_REGEX.test(pi)) {
      throw new ValidationError(
        `Invalid ${label}: test network PIs must start with '${TEST_PI_PREFIX}' followed by 24 valid characters (got: ${pi})`
      );
    }
  } else {
    if (!MAIN_PI_REGEX.test(pi)) {
      throw new ValidationError(
        `Invalid ${label}: must be 26-character ULID (got: ${pi})`
      );
    }
  }
}
