# IPFS Wrapper Permission Check - Implementation Plan

## Overview

Add permission checking to `POST /entities/:pi/versions` to ensure users can only edit entities they have access to.

## Current Flow

```
Client → Gateway → IPFS Wrapper
         ↓
    Sets X-User-Id header
    Sets X-User-Email header
```

The gateway already:
1. Validates JWT
2. Sets `X-User-Id` and `X-User-Email` headers
3. Proxies to IPFS Wrapper

**Problem:** IPFS Wrapper accepts any request with valid auth, doesn't check if user can edit that specific PI.

## Target Flow

```
Client → Gateway → IPFS Wrapper → Collections Worker
         ↓              ↓
    Sets X-User-Id     Checks /pi/:pi/permissions
                             ↓
                       canEdit? → proceed or 403
```

## Implementation Steps

### Step 1: Add Service Binding

**File:** `wrangler.jsonc`

```jsonc
{
  // ... existing config
  "services": [
    { "binding": "COLLECTIONS_WORKER", "service": "collections-worker" }
  ]
}
```

### Step 2: Update Env Type

**File:** `src/types/env.ts`

```typescript
export interface Env {
  // ... existing

  /**
   * Service binding to collections worker for permission checks
   */
  COLLECTIONS_WORKER: Fetcher;
}
```

### Step 3: Create Permission Helper

**File:** `src/lib/permissions.ts` (NEW)

```typescript
import type { Env } from '../types/env';

/**
 * Permission check result from collections worker
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

/**
 * Check if user can edit a PI by calling collections worker
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
): Promise<{ allowed: boolean; reason?: string; permissions?: PiPermissions }> {
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
```

### Step 4: Add Permission Check to Handler

**File:** `src/handlers/versions.ts`

Add at the top of `appendVersionHandler`:

```typescript
import { checkEditPermission } from '../lib/permissions';

export async function appendVersionHandler(c: Context): Promise<Response> {
  const MAX_CAS_RETRIES = 3;

  const ipfs: IPFSService = c.get('ipfs');
  const tipSvc: TipService = c.get('tipService');
  const network: Network = c.get('network');
  const pi = c.req.param('pi');

  // Validate PI matches the requested network
  validatePiMatchesNetwork(pi, network);

  // === NEW: Permission check ===
  const userId = c.req.header('X-User-Id') || null;
  const permCheck = await checkEditPermission(c.env, userId, pi);

  if (!permCheck.allowed) {
    return c.json({
      error: 'FORBIDDEN',
      message: permCheck.reason || 'Not authorized to edit this entity',
    }, 403);
  }
  // === END NEW ===

  // Parse body ONCE (can't re-read request body stream)
  const body = await validateBody(c.req.raw, AppendVersionRequestSchema);

  // ... rest of existing handler
}
```

### Step 5: Also Protect `createEntityHandler` (Optional)

For entity creation with `parent_pi`, we should also check permission on the parent:

**File:** `src/handlers/entities.ts`

```typescript
// In createEntityHandler, after parsing body:
if (body.parent_pi) {
  const userId = c.req.header('X-User-Id') || null;
  const permCheck = await checkEditPermission(c.env, userId, body.parent_pi);

  if (!permCheck.allowed) {
    return c.json({
      error: 'FORBIDDEN',
      message: `Not authorized to add children to entity ${body.parent_pi}`,
    }, 403);
  }
}
```

### Step 6: Also Protect `updateRelationsHandler`

**File:** `src/handlers/relations.ts`

```typescript
// Check permission on parent before modifying relations
const userId = c.req.header('X-User-Id') || null;
const permCheck = await checkEditPermission(c.env, userId, body.parent_pi);

if (!permCheck.allowed) {
  return c.json({
    error: 'FORBIDDEN',
    message: `Not authorized to modify relations for ${body.parent_pi}`,
  }, 403);
}
```

## Files Changed Summary

| File | Change |
|------|--------|
| `wrangler.jsonc` | Add COLLECTIONS_WORKER service binding |
| `src/types/env.ts` | Add COLLECTIONS_WORKER to Env interface |
| `src/lib/permissions.ts` | NEW: Permission check helper |
| `src/handlers/versions.ts` | Add permission check to appendVersionHandler |
| `src/handlers/entities.ts` | (Optional) Add permission check for parent_pi |
| `src/handlers/relations.ts` | (Optional) Add permission check |

## Testing Plan

### Test 1: User can edit entity in their collection
```bash
# User 1 creates collection and entity
# User 1 edits entity → should succeed (200)
```

### Test 2: User cannot edit entity in another's collection
```bash
# User 1 creates collection and entity
# User 2 tries to edit entity → should fail (403)
```

### Test 3: Anyone can edit entity not in any collection
```bash
# Entity exists without collection membership
# Any authenticated user edits → should succeed (200)
```

### Test 4: Unauthenticated user cannot edit
```bash
# No X-User-Id header
# Edit attempt → should fail (403 or 401 depending on gateway)
```

## Deployment Steps

1. Deploy collections-worker first (already deployed)
2. Update ipfs_wrapper wrangler.jsonc with service binding
3. Deploy ipfs_wrapper
4. Test with real tokens from arke-sdk/test/.env

## Notes

- The collections worker `/pi/:pi/permissions` endpoint already exists and handles:
  - GraphDB traversal to find parent collection
  - Supabase lookup for membership
  - Returns `canEdit: true` if entity is NOT in any collection (free entities)

- Gateway already sets `X-User-Id` header from JWT validation

- Service bindings work across workers in same Cloudflare account without additional auth
