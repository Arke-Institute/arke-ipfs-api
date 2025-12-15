# Arke IPFS API Specification

## Overview

This API manages versioned entities using the unified **`arke/eidos@v1`** schema as immutable IPLD manifests in IPFS, with mutable `.tip` pointers in MFS for fast lookups.

**Production URL:** `https://api.arke.institute`
**Local Development URL:** `http://localhost:8787`

**Related Services:**
- **IPFS Gateway:** `https://ipfs.arke.institute`
- **IPFS Backend:** `https://ipfs-api.arke.institute` (Kubo RPC + Backend API)

### Architecture

The API uses a hybrid snapshot + event stream backend for scalable entity listing:
- **IPFS Storage**: Immutable manifests stored as dag-json with version chains
- **MFS Tips**: Fast `.tip` file lookups for current versions (sharded by last 4 chars)
- **Backend API**: Event-sourced index with snapshots for entity listing
- **Eidos Schema**: Unified `arke/eidos@v1` schema for all entities

This architecture supports millions of entities while maintaining sub-100ms query performance.

---

## Current Schema: arke/eidos@v1

All entities now use the unified **`arke/eidos@v1`** schema:

```typescript
interface Eidos {
  schema: 'arke/eidos@v1';
  id: string;                    // Entity identifier (ULID)
  type: string;                  // Entity type (e.g., "PI", "Document")
  source_pi?: string;            // Optional: provenance (which PI extracted this)
  created_at: string;            // ISO 8601 timestamp of v1 (immutable)
  ver: number;                   // Version number (1, 2, 3, ...)
  ts: string;                    // ISO 8601 timestamp of this version
  prev: IPLDLink | null;         // Link to previous version (null for v1)
  components: {                  // Named CID references
    [label: string]: IPLDLink;
  };
  children_pi?: string[];        // Optional: child entity IDs (tree structure)
  parent_pi?: string;            // Optional: parent entity ID (tree structure)
  merged_entities?: string[];    // Optional: IDs merged into this entity
  label?: string;                // Optional: display name
  description?: string;          // Optional: human-readable description
  note?: string;                 // Optional: change description
}
```

**Key Features:**
- **Unified type system**: Single schema for all entity types
- **Immutable created_at**: Tracks original creation time across all versions
- **Provenance tracking**: `source_pi` tracks which PI extracted this entity
- **Hierarchy tracking**: `parent_pi` and `children_pi` for tree navigation
- **Merge tracking**: `merged_entities` array tracks merged entity IDs
- **Rich metadata**: `label` and `description` for UI display

---

## Concurrency & Race Condition Handling

### Compare-And-Swap (CAS) Protection

All write operations use **atomic Compare-And-Swap (CAS)** to prevent data loss from concurrent updates:

1. **Client provides `expect_tip`** - The manifest CID they read
2. **Server validates** - Checks actual tip matches expected tip
3. **Server retries internally** - Up to 3 attempts with 50ms backoff
4. **Client handles 409** - Retry with fresh tip if server validation fails

### CRITICAL: Client-Side Retry Logic Required

**✅ ALWAYS retry these errors:**
- `409 CAS_FAILURE` - Tip changed; fetch fresh tip and retry
- `503 IPFS_ERROR` - Temporary IPFS issue; retry with backoff
- `503 BACKEND_ERROR` - Backend unavailable; retry with backoff
- Network errors (`ECONNRESET`, `ETIMEDOUT`, fetch failures)

**❌ NEVER retry these errors:**
- `400 VALIDATION_ERROR` - Invalid request; fix the request
- `404 NOT_FOUND` - Entity doesn't exist; create it or check ID
- `409 CONFLICT` (non-CAS) - ID already exists; use different ID
- `413 PAYLOAD_TOO_LARGE` - File too large; reduce size

### Recommended Retry Configuration

```typescript
const RETRY_CONFIG = {
  maxRetries: 10,                  // Max retry attempts
  baseDelay: 100,                  // Base delay in ms
  maxDelay: 5000,                  // Cap at 5 seconds
  jitterFactor: 0.3,               // Add ±30% randomness
  retryableStatuses: [409, 503],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'fetch failed']
};
```

### Production Test Results

Based on testing with 50 concurrent writers:
- **Success rate**: 100% with 10 retries
- **Average retries**: 1-2 per operation
- **Max retries observed**: 6 retries under extreme load
- **Performance**: Sub-second even with retries

---

## Endpoints

### Health Check

**`GET /`**

Returns service status.

**Response:** `200 OK`
```json
{
  "service": "arke-ipfs-api",
  "version": "0.1.0",
  "status": "ok"
}
```

---

### File Operations

#### Upload Files

**`POST /upload`**

Upload raw files to IPFS. Returns CIDs for use in manifest components.

**Request:** `multipart/form-data` with one or more files

**Response:** `200 OK`
```json
[
  {
    "name": "file",
    "cid": "bafybeiabc123...",
    "size": 12345
  }
]
```

**Upload Limits:**
- Maximum: 100 MB per request (Cloudflare Workers constraint)
- For larger files: Upload directly to Kubo and use the CID

---

#### Download File Content

**`GET /cat/:cid`**

Download file content by CID.

**Path Parameters:**
- `cid` - IPFS CID (e.g., `bafybeiabc123...`)

**Response:** Binary stream
- `Content-Type`: Detected or `application/octet-stream`
- `Cache-Control`: `public, max-age=31536000, immutable`
- `X-IPFS-CID`: `{cid}`

**Errors:**
- `400` - Invalid CID
- `404` - Content not found

---

#### Download DAG Node

**`GET /dag/:cid`**

Download IPLD DAG node as JSON (for manifests, properties, relationships).

**Path Parameters:**
- `cid` - IPFS CID of dag-json node

**Response:** `200 OK`
```json
{
  "schema": "arke/eidos@v1",
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "ver": 3,
  ...
}
```

**Errors:**
- `400` - Invalid CID
- `404` - DAG node not found

---

### Entity Operations

#### List Entities

**`GET /entities`**

List entities with cursor-based pagination.

**Query Parameters:**
- `cursor` - Pagination cursor from `next_cursor` (optional)
- `limit` - Results per page (1-1000, default: 100)
- `include_metadata` - Include full details (default: false)

**Response:** `200 OK`

Without metadata:
```json
{
  "entities": [
    {
      "pi": "01J8ME3H6FZ3...",
      "id": "01J8ME3H6FZ3...",
      "tip": "bafybeiabc789..."
    }
  ],
  "limit": 100,
  "next_cursor": "bafybeiabc789..."
}
```

With `include_metadata=true`:
```json
{
  "entities": [
    {
      "pi": "01J8ME3H6FZ3...",
      "id": "01J8ME3H6FZ3...",
      "tip": "bafybeiabc789...",
      "type": "PI",
      "label": "Collection Name",
      "ver": 3,
      "ts": "2025-10-08T22:10:15Z",
      "component_count": 2,
      "children_count": 1
    }
  ],
  "limit": 100,
  "next_cursor": null
}
```

**Note:** `next_cursor` is `null` when no more results.

---

#### Create Entity

**`POST /entities`**

Create new entity with v1 manifest.

**Request:**
```json
{
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "components": {
    "metadata": "bafkreiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX..."],
  "parent_pi": "01PARENT...",
  "source_pi": "01SOURCE...",
  "label": "Collection Name",
  "description": "Description text",
  "note": "Initial version"
}
```

**Fields:**
- `id` - Optional; server generates ULID if omitted
- `type` - Required; entity type (e.g., "PI", "Collection", "Document")
- `components` - Required; at least 1 component
- `parent_pi` - Optional; parent entity ID for tree structure (auto-updates parent)
- `source_pi` - Optional; provenance - which PI extracted this entity
- `children_pi` - Optional; child entity IDs (manual linking required)
- `label`, `description`, `note` - Optional metadata

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3...",
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

**Side Effects:**
- If `parent_pi` provided: Parent automatically updated with new child
- Entity added to backend event stream
- Immediately appears in `/entities` listings

**Errors:**
- `400` - Invalid request body
- `409` - ID already exists

---

#### Get Entity

**`GET /entities/:id`**

Fetch latest manifest for entity.

**Path Parameters:**
- `id` - Entity identifier (ULID)

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3...",
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "created_at": "2025-10-08T21:00:00Z",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "manifest_cid": "bafybeiabc789...",
  "prev_cid": "bafybeiabc456...",
  "components": {
    "metadata": "bafkreiabc123...",
    "image": "bafybeiabc456..."
  },
  "parent_pi": "01PARENT...",
  "source_pi": "01SOURCE...",
  "children_pi": ["01GX..."],
  "label": "Collection Name",
  "description": "Description text",
  "note": "Updated metadata"
}
```

**Errors:**
- `404` - Entity not found

---

#### Append Version

**`POST /entities/:id/versions`**

Append new version to entity (CAS-protected).

**Request:**
```json
{
  "expect_tip": "bafybeiabc789...",
  "components": {
    "metadata": "bafybeinew123..."
  },
  "components_remove": ["old-file.txt"],
  "children_pi_add": ["01NEW..."],
  "children_pi_remove": ["01OLD..."],
  "label": "Updated Name",
  "description": "Updated description",
  "note": "Updated metadata"
}
```

**Fields:**
- `expect_tip` - Required; current tip CID (CAS guard)
- `type` - Optional; change entity type
- `components` - Optional; partial component updates
- `components_remove` - Optional; component keys to remove
- `children_pi_add` - Optional; children to add (max 100, auto-updates children)
- `children_pi_remove` - Optional; children to remove (max 100, auto-updates children)
- `properties` - Optional; replace entire properties object
- `relationships` - Optional; replace entire relationships array
- `label`, `description` - Optional; metadata updates
- `note` - Optional; change description

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3...",
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "ver": 4,
  "manifest_cid": "bafybeinew789...",
  "tip": "bafybeinew789..."
}
```

**Processing Order:**
1. Remove components (from `components_remove`)
2. Add/update components (from `components`)
3. Remove children (from `children_pi_remove`)
4. Add children (from `children_pi_add`)
5. Update label/description if provided

**Child Processing:**
- Children processed in parallel batches of 10
- Maximum 100 children per request
- Auto-updates child's `parent_pi` field

**Errors:**
- `400` - Invalid request (>100 children, invalid component key, etc.)
- `404` - Entity not found
- `409` - CAS failure (tip changed)

---

#### List Versions

**`GET /entities/:id/versions`**

List version history (newest first).

**Query Parameters:**
- `limit` - Max items (1-1000, default: 50)
- `cursor` - Pagination cursor (manifest CID, optional)

**Response:** `200 OK`
```json
{
  "items": [
    {
      "ver": 4,
      "cid": "bafybeinew789...",
      "ts": "2025-10-08T23:00:00Z",
      "note": "Updated metadata"
    },
    {
      "ver": 3,
      "cid": "bafybeiabc789...",
      "ts": "2025-10-08T22:10:15Z"
    }
  ],
  "next_cursor": "bafybeiabc456..."
}
```

**Errors:**
- `400` - Invalid pagination params
- `404` - Entity not found

---

#### Get Specific Version

**`GET /entities/:id/versions/:selector`**

Fetch specific version by CID or version number.

**Path Parameters:**
- `id` - Entity identifier
- `selector` - `cid:<CID>` or `ver:<N>`

**Examples:**
- `/entities/01J8.../versions/cid:bafybeiabc123...`
- `/entities/01J8.../versions/ver:2`

**Response:** `200 OK` (same format as GET /entities/:id)

**Errors:**
- `400` - Invalid selector
- `404` - Entity or version not found

---

### Hierarchy Operations

#### Update Hierarchy

**`POST /hierarchy`**

Update parent-child hierarchy relationships (replaces deprecated `/relations`).

**Request:**
```json
{
  "parent_pi": "01J8ME3H6FZ3...",
  "expect_tip": "bafybeiabc789...",
  "add_children": ["01NEW1...", "01NEW2...", "01NEW3..."],
  "remove_children": ["01OLD..."],
  "note": "Linked new items"
}
```

**Fields:**
- `parent_pi` - Required; parent entity ID
- `expect_tip` - Required; current parent tip (CAS guard)
- `add_children` - Optional; children to add (max 100)
- `remove_children` - Optional; children to remove (max 100)
- `note` - Optional; change description

**Response:** `200 OK`
```json
{
  "parent_pi": "01J8ME3H6FZ3...",
  "parent_ver": 4,
  "parent_tip": "bafybeinew789...",
  "children_updated": 3,
  "children_failed": 0
}
```

**Processing:**
- Updates parent's `children_pi` array
- Auto-updates each child's `parent_pi` field
- Processes children in parallel batches of 10
- Maximum 100 children per request

**Errors:**
- `400` - Invalid request (>100 children)
- `404` - Parent not found
- `409` - CAS failure

**Note:** For semantic relationships (e.g., "extracted_from"), use the `relationships` component instead.

**Backward Compatibility:** The deprecated `POST /relations` endpoint is still available and works identically to `/hierarchy`.

---

### Merge Operations

#### Merge Entities

**`POST /entities/:id/merge`**

Merge source entity into target entity.

**Path Parameters:**
- `id` - Entity to merge (will become tombstone)

**Request:**
```json
{
  "target_id": "01TARGET...",
  "expect_target_tip": "bafybeiabc789...",
  "note": "Duplicate entry",
  "skip_sync": false
}
```

**Fields:**
- `target_id` - Required; entity to merge into
- `expect_target_tip` - Required; current target tip CID (CAS guard)
- `note` - Optional; reason for merge
- `skip_sync` - Optional; skip index-sync callback (internal use)

**Response:** `201 Created`
```json
{
  "source_id": "01SOURCE...",
  "target_id": "01TARGET...",
  "target_ver": 5,
  "target_tip": "bafybeinew789...",
  "tombstone_cid": "bafybeitomb..."
}
```

**Merge Process:**
1. Validates both entities are active (not already merged)
2. Merges components using smart merge rules:
   - **Properties**: Union of both
   - **Relationships**: Concatenate both
   - **Files**: Target wins on conflicts
3. Updates target: adds merged components, increments version
4. Creates tombstone for source (`arke/eidos-merged@v1` schema)
5. Adds source ID to target's `merged_entities` array

**Errors:**
- `400` - Source or target already merged
- `404` - Entity not found
- `409` - CAS failure

---

#### Unmerge Entity

**`POST /entities/:id/unmerge`**

Restore a previously merged entity.

**Path Parameters:**
- `id` - Entity to restore

**Request:**
```json
{
  "target_id": "01TARGET...",
  "expect_target_tip": "bafybeiabc789...",
  "note": "Restore incorrect merge",
  "skip_sync": false
}
```

**Fields:**
- `target_id` - Required; entity it was merged into
- `expect_target_tip` - Required; current target tip CID (CAS guard)
- `note` - Optional; reason for unmerge
- `skip_sync` - Optional; skip index-sync callback (internal use)

**Response:** `201 Created`
```json
{
  "source_id": "01SOURCE...",
  "source_ver": 2,
  "source_tip": "bafybeinew456...",
  "target_id": "01TARGET...",
  "target_ver": 6,
  "target_tip": "bafybeinew789..."
}
```

**Unmerge Process:**
1. Validates source is tombstone, target is active
2. Restores source from tombstone data
3. Removes source ID from target's `merged_entities` array
4. Creates new versions for both entities

**Errors:**
- `400` - Source not merged or wrong target
- `404` - Entity not found
- `409` - CAS failure

---

### Delete Operations

#### Delete Entity

**`POST /entities/:id/delete`**

Soft delete an entity by creating a tombstone manifest.

**Path Parameters:**
- `id` - Entity identifier

**Request:**
```json
{
  "expect_tip": "bafybeiabc789...",
  "note": "Duplicate record"
}
```

**Fields:**
- `expect_tip` - Required; current tip CID (CAS guard)
- `note` - Optional; reason for deletion

**Response:** `201 Created`
```json
{
  "id": "01J8ME3H6FZ3...",
  "deleted_ver": 4,
  "deleted_at": "2025-12-14T18:00:00Z",
  "deleted_manifest_cid": "bafybeitomb...",
  "previous_ver": 3,
  "prev_cid": "bafybeiprev..."
}
```

**What Happens:**
1. Validates entity is active (not already deleted or merged)
2. Creates tombstone with `arke/eidos-deleted@v1` schema
3. Preserves version history via `prev` link
4. Updates tip to point to tombstone

**What Gets Preserved:**
- Version history (accessible via `prev` chain)
- Entity type (in tombstone)
- All previous versions remain in IPFS

**GET Deleted Entity:**
```json
{
  "id": "01J8ME3H6FZ3...",
  "type": "PI",
  "manifest_cid": "bafybeitomb...",
  "status": "deleted",
  "deleted_at": "2025-12-14T18:00:00Z",
  "note": "Duplicate record",
  "prev_cid": "bafybeiprev..."
}
```

**Errors:**
- `400` - Entity already deleted or is merged
- `404` - Entity not found
- `409` - CAS failure (tip changed)

---

#### Undelete Entity

**`POST /entities/:id/undelete`**

Restore a deleted entity back to active state.

**Path Parameters:**
- `id` - Entity identifier

**Request:**
```json
{
  "expect_tip": "bafybeitomb...",
  "note": "Restoring incorrectly deleted record"
}
```

**Fields:**
- `expect_tip` - Required; current tip CID (tombstone CID) for CAS guard
- `note` - Optional; reason for restoration

**Response:** `201 Created`
```json
{
  "id": "01J8ME3H6FZ3...",
  "restored_ver": 5,
  "restored_from_ver": 3,
  "new_manifest_cid": "bafybeirestored..."
}
```

**What Happens:**
1. Validates entity is currently deleted (tombstone)
2. Fetches last active version before deletion
3. Creates new active version with all restored data
4. Preserves full history including tombstone

**Version History:**
```
v1 (created) → v2 (updated) → v3 (active) → v4 (deleted) → v5 (restored)
                                  ↑                           |
                                  └───────────restored────────┘
```

**What Gets Restored:**
- All components (CID references)
- Properties and relationships
- Children/parent links
- Type, label, description
- Complete version history

**Errors:**
- `400` - Entity is not deleted
- `404` - Entity not found
- `409` - CAS failure (tip changed)

---

### Migration Operations

#### Migrate Single Entity

**`POST /migrate/:id`**

Migrate entity from legacy schema to `arke/eidos@v1`.

**Path Parameters:**
- `id` - Entity identifier

**Response:** `200 OK`

Already migrated:
```json
{
  "message": "Entity already migrated",
  "pi": "01J8ME3H6FZ3...",
  "schema": "arke/eidos@v1",
  "ver": 3
}
```

Successfully migrated:
```json
{
  "message": "Entity migrated successfully",
  "pi": "01J8ME3H6FZ3...",
  "old_schema": "arke/manifest@v1",
  "new_schema": "arke/eidos@v1",
  "old_tip": "bafybeiabc123...",
  "new_tip": "bafybeinew456...",
  "type": "PI",
  "created_at": "2025-10-08T21:00:00Z"
}
```

**Migration Process:**
1. Reads current manifest
2. Checks if already `arke/eidos@v1` (returns success)
3. Validates old schema is `arke/manifest@v1` or `arke/entity@v1`
4. Walks version chain to v1 for `created_at` timestamp
5. Creates new manifest with eidos schema
6. Updates tip to new manifest

**Note:** Preserves all version history via `prev` links.

**Errors:**
- `404` - Entity not found
- `400` - Unsupported schema

---

#### Migrate Batch

**`POST /migrate/batch`**

Migrate multiple entities in one request.

**Request:**
```json
{
  "pis": ["01J8ME3H6FZ3...", "01K75HQQXNT..."],
  "dry_run": false
}
```

**Fields:**
- `pis` - Required; array of 1-100 entity IDs
- `dry_run` - Optional; preview without applying (default: false)

**Response:** `200 OK`
```json
{
  "dry_run": false,
  "summary": {
    "total": 100,
    "already_migrated": 30,
    "migrated": 68,
    "would_migrate": 0,
    "failed": 2,
    "not_found": 0,
    "unsupported": 0
  },
  "results": [
    {
      "pi": "01J8ME3H6FZ3...",
      "status": "migrated",
      "from": "arke/manifest@v1",
      "to": "arke/eidos@v1",
      "new_tip": "bafybeinew..."
    },
    {
      "pi": "01K75HQQXNT...",
      "status": "already_migrated"
    }
  ]
}
```

**Status Values:**
- `migrated` - Successfully migrated
- `already_migrated` - Already on arke/eidos@v1
- `would_migrate` - Would migrate (dry_run only)
- `failed` - Migration failed (see error field)
- `not_found` - Entity doesn't exist
- `unsupported_schema` - Schema not migratable

**Errors:**
- `400` - Invalid request (empty, >100 entities)

---

### Utility Operations

#### Resolve ID to Tip

**`GET /resolve/:id`**

Fast lookup: entity ID → tip CID (no manifest fetch).

**Path Parameters:**
- `id` - Entity identifier

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3...",
  "id": "01J8ME3H6FZ3...",
  "tip": "bafybeiabc789..."
}
```

**Errors:**
- `404` - Entity not found

---

### Arke Origin Block

#### Initialize Arke

**`POST /arke/init`**

Initialize Arke origin block (genesis entity) if it doesn't exist.

**Request:** No body required

**Response:** `201 Created` (if created) or `200 OK` (if exists)
```json
{
  "message": "Arke origin block initialized",
  "metadata_cid": "bafkreiabc123...",
  "id": "00000000000000000000000000",
  "type": "PI",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

**Side Effects:**
- Creates Arke metadata JSON
- Creates v1 manifest with well-known ID
- Sets up `.tip` file in MFS

---

#### Get Arke

**`GET /arke`**

Convenience endpoint for Arke origin block.

**Response:** `200 OK` (same format as GET /entities/:id)

**Errors:**
- `404` - Arke not initialized (call POST /arke/init)

---

## Error Responses

All errors return JSON:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": {}
}
```

**Error Codes:**
- `VALIDATION_ERROR` (400) - Invalid request body
- `INVALID_PARAMS` (400) - Invalid query parameters
- `INVALID_CURSOR` (400) - Invalid pagination cursor
- `FORBIDDEN` (403) - Not authorized to edit entity
- `NOT_FOUND` (404) - Entity not found
- `CONFLICT` (409) - ID already exists
- `CAS_FAILURE` (409) - Tip changed (includes actual/expected)
- `BACKEND_ERROR` (503) - Backend API unavailable
- `IPFS_ERROR` (503) - IPFS operation failed
- `INTERNAL_ERROR` (500) - Server error

---

## Authorization

Write operations (append version, update hierarchy) support optional authorization via the `X-User-Id` header.

**Header:** `X-User-Id: <user-id>`

When provided, the server checks if the user has permission to edit the entity. If not authorized, returns `403 FORBIDDEN`.

**Note:** Authorization is skipped for test network (`X-Arke-Network: test`) since test data is ephemeral.

---

## Network Isolation (Testnet)

The API supports separate test and main networks.

**Network Header:** `X-Arke-Network: main` (default) or `test`

**PI Prefix Convention:**
- **Main network**: Standard ULIDs (e.g., `01K75HQQ...`)
- **Test network**: Prefix with `II` (e.g., `IIAK75HQQ...`)

**Cross-Network Prevention:**
All endpoints validate PI matches requested network. Cannot mix test and main entities.

**MFS Paths:**
- Main: `/arke/index/{shard1}/{shard2}/{id}.tip`
- Test: `/arke/test/index/{shard1}/{shard2}/{id}.tip`

---

## Data Model

### Eidos Manifest (dag-json)

Current schema: **`arke/eidos@v1`**

```json
{
  "schema": "arke/eidos@v1",
  "id": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "type": "PI",
  "source_pi": "01SOURCE...",
  "created_at": "2025-10-08T21:00:00Z",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "prev": { "/": "bafybeiprev..." },
  "components": {
    "metadata": { "/": "bafybeimeta..." },
    "image": { "/": "bafybeiimg..." }
  },
  "parent_pi": "01PARENT...",
  "children_pi": ["01GX...", "01GZ..."],
  "merged_entities": ["01MERGED1...", "01MERGED2..."],
  "label": "Collection Name",
  "description": "Brief description",
  "note": "Updated metadata"
}
```

### Merged Tombstone (dag-json)

Schema: **`arke/eidos-merged@v1`**

```json
{
  "schema": "arke/eidos-merged@v1",
  "id": "01SOURCE123...",
  "type": "PI",
  "ver": 4,
  "ts": "2025-10-09T15:30:00Z",
  "merged_into": "01TARGET456...",
  "prev": { "/": "bafybeilast..." },
  "note": "Merged - duplicate entry"
}
```

**Note:** The `ts` field indicates when the merge occurred. The `ver` continues the version chain from the original entity.

### Tip File (MFS)

**Path:** `/arke/index/{shard1}/{shard2}/{id}.tip`

**Sharding:** Last 4 chars of ULID for uniform distribution
- `01K75HQQXNTDG7BBP7PS9AWYAN` → `AW/YA/`

**Content:** Single line with tip CID
```
bafybeiabc789...
```

---

## Schema History

- **`arke/eidos@v1`** (current) - Unified schema for all entities
- **`arke/eidos-merged@v1`** (current) - Tombstone for merged entities
- **`arke/entity@v1`** (legacy) - Previous typed entity schema
- **`arke/manifest@v1`** (legacy) - Original PI entity schema

All 3,285 entities migrated to `arke/eidos@v1`. Legacy schemas preserved in version history.
