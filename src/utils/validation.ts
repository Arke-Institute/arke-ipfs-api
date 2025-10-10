import { z, ZodSchema } from 'zod';
import { ValidationError } from './errors';

/**
 * Validate request body against Zod schema
 * Throws ValidationError on failure
 */
export async function validateBody<T>(
  request: Request,
  schema: ZodSchema<T>
): Promise<T> {
  try {
    const body = await request.json();
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid request body', {
        errors: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }
    throw new ValidationError('Failed to parse request body');
  }
}

/**
 * Validate query parameters against Zod schema
 * Throws ValidationError on failure
 */
export function validateQuery<T>(url: URL, schema: ZodSchema<T>): T {
  try {
    const params = Object.fromEntries(url.searchParams.entries());
    return schema.parse(params);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid query parameters', {
        errors: error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }
    throw new ValidationError('Failed to parse query parameters');
  }
}

/**
 * Parse version selector: "cid:<CID>" or "ver:<N>"
 */
export interface VersionSelector {
  type: 'cid' | 'ver';
  value: string | number;
}

export function parseVersionSelector(selector: string): VersionSelector {
  if (selector.startsWith('cid:')) {
    return { type: 'cid', value: selector.slice(4) };
  }
  if (selector.startsWith('ver:')) {
    const ver = parseInt(selector.slice(4), 10);
    if (isNaN(ver) || ver < 1) {
      throw new ValidationError('Invalid version number: must be positive integer');
    }
    return { type: 'ver', value: ver };
  }
  throw new ValidationError(
    'Invalid version selector: must be "cid:<CID>" or "ver:<N>"'
  );
}

/**
 * Validate pagination parameters
 */
export interface PaginationParams {
  limit: number;
  cursor?: string;
}

export function validatePagination(url: URL): PaginationParams {
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor') || undefined;

  const limit = limitParam ? parseInt(limitParam, 10) : 50;

  if (isNaN(limit) || limit < 1 || limit > 1000) {
    throw new ValidationError('Invalid limit: must be between 1 and 1000');
  }

  return { limit, cursor };
}
