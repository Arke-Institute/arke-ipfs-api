import { Context } from 'hono';
import { IPFSService } from '../services/ipfs';
import { TipService } from '../services/tip';
import { ValidationError } from '../utils/errors';
import { validateBody } from '../utils/validation';
import { updateHierarchy } from '../services/eidos-ops';
import {
  UpdateHierarchyRequest,
  UpdateHierarchyRequestSchema,
} from '../types/eidos';
import { Network, validatePiMatchesNetwork } from '../types/network';

// Maximum number of children that can be added/removed in a single request
const MAX_CHILDREN_PER_REQUEST = 100;

/**
 * POST /hierarchy (formerly /relations)
 * Update parent-child hierarchy relationships
 *
 * Coordinates bulk updates to prevent race conditions:
 * - Updates parent's children_pi array (add/remove)
 * - Updates all affected children's hierarchy_parent field
 * - Processes children in batches of 10 for optimal performance
 * - Uses CAS protection with automatic retry
 *
 * Note: This endpoint handles the hierarchical tree structure (parent-child).
 * For semantic graph relationships (e.g., "extracted_from", "created"), use
 * the relationships component instead.
 */
export async function updateHierarchyHandler(c: Context): Promise<Response> {
  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');

  // Validate request body
  const body = await validateBody(c.req.raw, UpdateHierarchyRequestSchema);

  // Validate parent_pi matches network
  validatePiMatchesNetwork(body.parent_pi, network);

  // Validate add_children match network (prevents cross-network relationships)
  if (body.add_children) {
    for (const childPi of body.add_children) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  // Validate remove_children match network
  if (body.remove_children) {
    for (const childPi of body.remove_children) {
      validatePiMatchesNetwork(childPi, network);
    }
  }

  // Validate child count limits
  if (body.add_children && body.add_children.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot add ${body.add_children.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  if (body.remove_children && body.remove_children.length > MAX_CHILDREN_PER_REQUEST) {
    throw new ValidationError(
      `Cannot remove ${body.remove_children.length} children in one request. Maximum is ${MAX_CHILDREN_PER_REQUEST}. Please split into multiple requests.`
    );
  }

  // Call service layer (includes automatic retry on race conditions)
  const response = await updateHierarchy(ipfs, tipSvc, body);

  return c.json(response, 200);
}

/**
 * @deprecated Use updateHierarchyHandler instead
 * Kept for backward compatibility
 */
export async function updateRelationsHandler(c: Context): Promise<Response> {
  return updateHierarchyHandler(c);
}
