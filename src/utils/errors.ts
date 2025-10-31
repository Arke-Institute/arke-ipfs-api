/**
 * Base error class for API errors
 */
export class APIError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * 409 Conflict - CAS (Compare-And-Set) failure
 */
export class CASError extends APIError {
  constructor(details: { actual: string; expect: string }) {
    super(
      `CAS failure: expected tip ${details.expect}, got ${details.actual}`,
      409,
      'CAS_FAILURE',
      details
    );
  }
}

/**
 * 404 Not Found - Resource doesn't exist
 */
export class NotFoundError extends APIError {
  constructor(resource: string, identifier: string) {
    super(`${resource} not found: ${identifier}`, 404, 'NOT_FOUND', {
      resource,
      identifier,
    });
  }
}

/**
 * 400 Bad Request - Invalid input
 */
export class ValidationError extends APIError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/**
 * 409 Conflict - Resource already exists
 */
export class ConflictError extends APIError {
  constructor(resource: string, identifier: string) {
    super(`${resource} already exists: ${identifier}`, 409, 'CONFLICT', {
      resource,
      identifier,
    });
  }
}

/**
 * 503 Service Unavailable - IPFS node unreachable or error
 */
export class IPFSError extends APIError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(`IPFS error: ${message}`, 503, 'IPFS_ERROR', details);
  }
}

/**
 * Parse IPFS JSON error response
 */
export interface IPFSErrorResponse {
  Message?: string;
  Code?: number;
  Type?: string;
}

/**
 * Extract error message from IPFS response
 */
export function parseIPFSError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const ipfsError = error as IPFSErrorResponse;
    if (ipfsError.Message) {
      return ipfsError.Message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Internal error for tip write race detection (not exposed to API)
 * Triggers retry in appendVersionHandler
 */
export class TipWriteRaceError extends Error {
  constructor(
    public pi: string,
    public expectedCid: string,
    public actualCid: string
  ) {
    super(`Tip write race for ${pi}: expected ${expectedCid}, got ${actualCid}`);
    this.name = 'TipWriteRaceError';
  }
}

/**
 * Map error to HTTP Response
 */
export function errorToResponse(error: unknown): Response {
  if (error instanceof APIError) {
    return new Response(JSON.stringify(error.toJSON()), {
      status: error.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Unknown error - return 500
  console.error('Unexpected error:', error);
  return new Response(
    JSON.stringify({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
