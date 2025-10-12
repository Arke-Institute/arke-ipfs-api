# Arke IPFS API Specification

## Overview

This API manages versioned entities (PIs) as immutable IPLD manifests in IPFS, with mutable `.tip` pointers in MFS for fast lookups.

**Base URL:** `https://your-worker.workers.dev`
**Test URL:** `http://localhost:8787`

### Architecture

The API uses a hybrid snapshot + linked list backend for scalable entity listing:
- **IPFS Storage**: Immutable manifests stored as dag-json with version chains
- **MFS Tips**: Fast `.tip` file lookups for current versions
- **Backend API**: IPFS Server (FastAPI) manages snapshot-based entity indexing
- **Recent Chain**: New entities appended to linked list for fast access
- **Snapshots**: Periodic snapshots for efficient deep pagination

This architecture supports millions of entities while maintaining sub-100ms query performance.

---

## Endpoints

### Health Check

**`GET /`**

Returns service status.

**Response:**
```json
{
  "service": "arke-ipfs-api",
  "version": "0.1.0",
  "status": "ok"
}
```

---

### Upload Files

**`POST /upload`**

Upload raw bytes to IPFS. Returns CID(s) for use in manifest components.

**Request:** `multipart/form-data` with one or more file parts

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

**Errors:**
- `400` - No files provided

---

### Download File

**`GET /cat/{cid}`**

Download file content by CID. Streams bytes directly from IPFS.

**Path Parameters:**
- `cid` - IPFS CID (e.g., `bafybeiabc123...`)

**Response:** `200 OK`
- Content-Type: `application/octet-stream` (or detected type)
- Headers:
  - `Cache-Control: public, max-age=31536000, immutable`
  - `X-IPFS-CID: {cid}`

**Errors:**
- `400` - Invalid CID format
- `404` - Content not found in IPFS

---

### List Entities

**`GET /entities`**

List entities with cursor-based pagination. Uses hybrid snapshot + recent chain backend for scalable performance.

**Query Parameters:**
- `cursor` - Pagination cursor (CID from previous page's `next_cursor`, optional)
- `limit` - Max results per page (1-1000, default: 100)
- `include_metadata` - Include full entity details (default: false)

**Response:** `200 OK`

Without metadata:
```json
{
  "entities": [
    {
      "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
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
      "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
      "tip": "bafybeiabc789...",
      "ver": 3,
      "ts": "2025-10-08T22:10:15Z",
      "note": "Updated metadata",
      "component_count": 2,
      "children_count": 1
    }
  ],
  "limit": 100,
  "next_cursor": "bafybeiabc789..."
}
```

**Pagination:**
- First page: `GET /entities?limit=100`
- Next page: `GET /entities?limit=100&cursor={next_cursor}`
- `next_cursor` is `null` when no more pages available
- Cursor is an opaque CID returned by backend; do not construct manually

**Performance:**
- **Latest entities**: < 100ms (queries recent chain)
- **Deep pagination**: < 500ms (queries chunked snapshots)
- **O(1) chunk access** for arbitrary offsets
- Scales to millions of entities without performance degradation

**Implementation:**
- Recent entities (< 10K) queried from linked list chain
- Historical entities queried from chunked snapshots (10K entries/chunk)
- Backend automatically appends new entities to chain
- Periodic snapshot rebuilds consolidate chain into immutable snapshots

**Errors:**
- `400` - Invalid pagination params (limit not 1-1000 or invalid cursor format)
- `503` - Backend API unavailable (temporary)

---

### Create Entity

**`POST /entities`**

Create new entity with v1 manifest. Automatically appends entity to backend chain for indexing.

**Request:**
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",  // optional; server generates if omitted
  "components": {
    "metadata": "bafybeiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX...", "01GZ..."],  // optional
  "parent_pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",  // optional; auto-updates parent
  "note": "Initial version"  // optional
}
```

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

**Side Effects:**
- Manifest stored in IPFS as dag-json with `parent_pi` field set (if provided)
- `.tip` file created in MFS for fast lookups
- Entity appended to backend recent chain for indexing
- Entity immediately appears in `/entities` listings
- **If `parent_pi` provided:** Parent entity automatically updated with new child in `children_pi` array

**Bidirectional Relationships:**
When creating an entity with `parent_pi`, the API automatically maintains bidirectional relationships:
1. Child entity gets `parent_pi` field set in manifest
2. Parent entity automatically appends new child to its `children_pi` array (creates new version)
3. Both entities are updated atomically

This allows seamless graph traversal in both directions without manual coordination.

**Errors:**
- `400` - Invalid request body
- `409` - PI already exists

**Note:** Chain append is an optimization and happens asynchronously. Entity creation succeeds even if backend is temporarily unavailable. Parent updates also happen asynchronously and are logged if they fail.

---

### Get Entity

**`GET /entities/{pi}`**

Fetch latest manifest for entity.

**Query Parameters:**
- `resolve` - `cids` (default) | `bytes` (future: stream component bytes)

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "manifest_cid": "bafybeiabc789...",
  "prev_cid": "bafybeiabc456...",
  "components": {
    "metadata": "bafybeiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX..."],
  "parent_pi": "01J8PARENT...",  // optional: parent entity PI
  "note": "Updated metadata"
}
```

**Errors:**
- `404` - Entity not found

---

### Append Version

**`POST /entities/{pi}/versions`**

Append new version (CAS-protected).

**Request:**
```json
{
  "expect_tip": "bafybeiabc789...",  // required for CAS
  "components": {
    "metadata": "bafybeinew123..."  // partial updates ok
  },
  "children_pi_add": ["01NEW..."],
  "children_pi_remove": ["01OLD..."],
  "note": "Updated metadata"
}
```

**Response:** `201 Created`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 4,
  "manifest_cid": "bafybeinew789...",
  "tip": "bafybeinew789..."
}
```

**Bidirectional Relationships:**
When using `children_pi_add` or `children_pi_remove`, the API automatically maintains bidirectional relationships:
- **Adding children:** Each child entity is automatically updated with `parent_pi` set to this entity's PI
- **Removing children:** Each removed child entity has its `parent_pi` field cleared
- All affected entities get new versions with descriptive notes

**Errors:**
- `400` - Invalid request body
- `404` - Entity not found
- `409` - CAS failure (tip changed)

---

### List Versions

**`GET /entities/{pi}/versions`**

List version history (newest first).

**Query Parameters:**
- `limit` - Max items (1-1000, default 50)
- `cursor` - Pagination cursor (manifest CID)

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
  "next_cursor": "bafybeiabc456..."  // null if no more
}
```

**Errors:**
- `400` - Invalid pagination params
- `404` - Entity not found

---

### Get Specific Version

**`GET /entities/{pi}/versions/{selector}`**

Fetch specific version by `cid:<CID>` or `ver:<N>`.

**Examples:**
- `/entities/01J8.../versions/cid:bafybeiabc123...`
- `/entities/01J8.../versions/ver:2`

**Response:** `200 OK` (same format as GET /entities/{pi})

**Errors:**
- `400` - Invalid selector
- `404` - Entity or version not found

---

### Update Relations

**`POST /relations`**

Update parent-child relationships.

**Request:**
```json
{
  "parent_pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "expect_tip": "bafybeiabc789...",
  "add_children": ["01NEW1...", "01NEW2..."],
  "remove_children": ["01OLD..."],
  "note": "Linked new items"
}
```

**Response:** `201 Created` (same format as append version)

**Bidirectional Relationships:**
This endpoint automatically maintains bidirectional relationships:
- **Adding children:** Each child entity is automatically updated with `parent_pi` set to parent's PI
- **Removing children:** Each removed child entity has its `parent_pi` field cleared
- Parent's `parent_pi` field is preserved across updates
- All affected entities get new versions with descriptive notes

**Errors:**
- `400` - Invalid request body
- `404` - Parent not found
- `409` - CAS failure

---

### Resolve PI to Tip

**`GET /resolve/{pi}`**

Fast lookup: PI → tip CID (no manifest fetch).

**Response:** `200 OK`
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "tip": "bafybeiabc789..."
}
```

**Errors:**
- `404` - Entity not found

---

## Error Responses

All errors return JSON:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": {}  // optional
}
```

**Error Codes:**
- `VALIDATION_ERROR` (400)
- `INVALID_PARAMS` (400)
- `INVALID_CURSOR` (400)
- `NOT_FOUND` (404)
- `CONFLICT` (409) - PI exists or CAS failure
- `CAS_FAILURE` (409) - Specific CAS error with actual/expected tips
- `BACKEND_ERROR` (503) - Backend API unavailable
- `IPFS_ERROR` (503)
- `INTERNAL_ERROR` (500)

---

## Data Model

### Manifest (dag-json)

```json
{
  "schema": "arke/manifest@v1",
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",
  "ver": 3,
  "ts": "2025-10-08T22:10:15Z",
  "prev": { "/": "bafybeiprev..." },  // IPLD link to previous version
  "components": {
    "metadata": { "/": "bafybeimeta..." },
    "image": { "/": "bafybeiimg..." }
  },
  "children_pi": ["01GX...", "01GZ..."],  // optional: child entities
  "parent_pi": "01J8PARENT...",  // optional: parent entity (for bidirectional traversal)
  "note": "Optional change note"
}
```

**Bidirectional Relationships:**
- `children_pi`: Array of child entity PIs (parent → children navigation)
- `parent_pi`: Single parent entity PI (child → parent navigation)
- Automatically maintained by the API when using `parent_pi` in entity creation or relationship endpoints
- Enables efficient graph traversal in both directions

### Tip (MFS)

Path: `/arke/index/<shard2[0]>/<shard2[1]>/<PI>.tip`

Content: `<manifest_cid>\n`

---

## ULID Format

PIs are ULIDs: 26-character base32 (Crockford alphabet), e.g., `01J8ME3H6FZ3KQ5W1P2XY8K7E5`

Regex: `^[0-9A-HJKMNP-TV-Z]{26}$`

---

## CID Format

All CIDs are CIDv1 (base32), e.g., `bafybeiabc123...`

---

## Backend Architecture

### Snapshot + Linked List Hybrid System

The API delegates entity indexing to an IPFS Server backend (FastAPI) that manages a hybrid data structure:

**Components:**
1. **Recent Chain** - Linked list of newest entities (< 10K)
   - Stored as dag-json chain entries in IPFS
   - Each entry links to previous via `prev` field
   - Fast append-only operations
   - Queried for latest entity listings

2. **Chunked Snapshots** - Immutable historical index
   - Periodic snapshots of all entities
   - Split into 10K-entry chunks for O(1) random access
   - Stored as dag-json with IPLD links to chunks
   - Enables efficient deep pagination

3. **Index Pointer** - Single source of truth
   - Stored in MFS at `/arke/index-pointer`
   - Tracks current snapshot CID and chain head
   - Maintains total entity count

**Query Strategy:**
- **Offset 0-10K**: Query recent chain (fast append-only list)
- **Offset > 10K**: Calculate chunk index, fetch specific chunk(s)
- **Hybrid queries**: Combine chain + snapshot for complete results

**Lifecycle:**
1. Entity created → Appended to recent chain
2. Chain grows to 10K items → Trigger snapshot rebuild
3. Snapshot rebuild: Merge chain + old snapshot → New chunked snapshot
4. Reset chain to empty, update index pointer

**Performance Benefits:**
- No MFS directory traversal (was O(n) with n=40K+ entities)
- O(1) chunk access for arbitrary pagination offsets
- Sub-100ms queries regardless of total entity count
- Scales to millions of entities

**Environment Variables:**
- `IPFS_SERVER_API_URL` - Backend API endpoint (e.g., `http://localhost:3000`)

**Backend Endpoints Used:**
- `POST /chain/append` - Append new entity to chain
- `GET /entities?limit=N&offset=M` - Query entities with pagination
- `GET /index-pointer` - Get current system state

See `SNAPSHOT_LINKED_LIST_IMPLEMENTATION.md` for complete backend architecture details.
