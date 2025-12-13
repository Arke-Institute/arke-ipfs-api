/**
 * Permission checking via collections worker
 *
 * Calls the collections worker to check if a user can edit a PI.
 * The collections worker handles GraphDB traversal and Supabase membership checks.
 */

import type { Env } from '../types/env';

/**
 * Permission check result from collections worker /pi/:pi/permissions endpoint
 */
export interface PiPermissions {
  pi: string;
  canView: boolean;
  canEdit: boolean;
  canAdminister: boolean;
  collection: {
    id: string;
    title: string;
    slug: string;
    visibility: string;
    role: 'owner' | 'editor' | null;
    rootPi: string;
    hops: number;
  } | null;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  permissions?: PiPermissions;
}

/**
 * Check if user can edit a PI by calling collections worker.
 *
 * Permission logic (handled by collections worker):
 * - If PI is NOT in any collection → canEdit: true (anyone can edit)
 * - If PI IS in a collection → canEdit: true only if user is owner or editor
 *
 * @param env - Worker environment with service bindings
 * @param userId - User ID from X-User-Id header (null if unauthenticated)
 * @param pi - The PI to check permissions for
 * @returns Permission check result
 */
export async function checkEditPermission(
  env: Env,
  userId: string | null,
  pi: string
): Promise<PermissionCheckResult> {
  try {
    const headers: Record<string, string> = {};
    if (userId) {
      headers['X-User-Id'] = userId;
    }

    const response = await env.COLLECTIONS_WORKER.fetch(
      `https://internal/pi/${pi}/permissions`,
      { headers }
    );

    if (!response.ok) {
      console.error(`[PERMISSIONS] Failed to check permissions for ${pi}: ${response.status}`);
      return { allowed: false, reason: 'Permission check failed' };
    }

    const permissions: PiPermissions = await response.json();

    if (!permissions.canEdit) {
      const reason = permissions.collection
        ? `Not authorized to edit entities in collection "${permissions.collection.title}"`
        : 'Not authorized to edit this entity';
      return { allowed: false, reason, permissions };
    }

    return { allowed: true, permissions };
  } catch (error) {
    console.error(`[PERMISSIONS] Error checking permissions for ${pi}:`, error);
    return { allowed: false, reason: 'Permission check error' };
  }
}
