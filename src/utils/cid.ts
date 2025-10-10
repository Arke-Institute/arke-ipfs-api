import { CID } from 'multiformats/cid';

/**
 * Validate CID format using multiformats library
 */
export function isValidCID(value: string): boolean {
  try {
    CID.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate CID and throw if invalid
 */
export function assertValidCID(value: string, label: string = 'CID'): void {
  if (!isValidCID(value)) {
    throw new Error(`Invalid ${label}: must be a valid CID (got: ${value})`);
  }
}

/**
 * Parse CID string to CID object
 */
export function parseCID(value: string): CID {
  try {
    return CID.parse(value);
  } catch (error) {
    throw new Error(`Failed to parse CID: ${value}`);
  }
}

/**
 * Validate multiple CIDs in a record (e.g., components)
 */
export function validateCIDRecord(
  record: Record<string, string>,
  recordLabel: string = 'record'
): void {
  for (const [key, cid] of Object.entries(record)) {
    assertValidCID(cid, `${recordLabel}["${key}"]`);
  }
}
