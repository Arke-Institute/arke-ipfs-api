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

### Initialize Arke Origin Block

**`POST /arke/init`**

Initialize the Arke origin block (genesis entity) if it doesn't already exist. This is the root of the archive tree with a well-known PI.

**Request:** No body required

**Response:** `201 Created` (if created) or `200 OK` (if already exists)
```json
{
  "message": "Arke origin block initialized",
  "metadata_cid": "bafkreiabc123...",
  "pi": "00000000000000000000000000",
  "ver": 1,
  "manifest_cid": "bafybeiabc789...",
  "tip": "bafybeiabc789..."
}
```

If already exists:
```json
{
  "message": "Arke origin block already exists",
  "pi": "00000000000000000000000000",
  "ver": 2,
  "ts": "2025-10-12T17:35:39.621Z",
  "manifest_cid": "bafybeiabc789...",
  "prev_cid": "bafybeiabc456...",
  "components": {
    "metadata": "bafkreiabc123..."
  },
  "children_pi": ["01K7..."],
  "note": "..."
}
```

**Side Effects:**
- Creates Arke metadata JSON and stores in IPFS
- Creates v1 manifest with well-known PI
- Sets up `.tip` file in MFS
- Appends to backend chain for indexing

**Arke Metadata:**
```json
{
  "name": "Arke",
  "type": "root",
  "description": "Origin block of the Arke Institute archive tree. Contains all institutional collections.",
  "note": "Arke (ἀρχή) - Ancient Greek for 'origin' or 'beginning'"
}
```

**Note:** The Arke PI is configurable via `ARKE_PI` environment variable (defaults to `00000000000000000000000000`).

---

### Get Arke Origin Block

**`GET /arke`**

Convenience endpoint to fetch the Arke origin block without needing to know the PI.

**Response:** `200 OK` (same format as `GET /entities/{pi}`)

**Errors:**
- `404` - Arke origin block not initialized (call `POST /arke/init` first)

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

List entities with cursor-based pagination. Uses event-sourced backend with snapshots for scalable performance.

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
- **Latest entities**: < 100ms (queries from snapshot)
- **Deep pagination**: < 500ms (cursor-based navigation)
- Sub-100ms queries regardless of total entity count
- Scales to millions of entities without performance degradation

**Implementation:**
- Entity list queried from latest snapshot
- Backend tracks all creates/updates via event stream
- Periodic snapshots capture complete entity list with event checkpoint
- Event stream enables incremental sync for mirroring clients

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
- "create" event appended to backend event stream for tracking
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

**Note:** Event tracking is an optimization and happens asynchronously. Entity creation succeeds even if backend is temporarily unavailable. Parent updates also happen asynchronously and are logged if they fail.

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

### Event Stream + Snapshot System

The API delegates entity indexing to an IPFS Server backend (FastAPI) that manages an event-sourced data structure:

**Components:**
1. **Event Stream** - Time-ordered log of all creates and updates
   - Stored as dag-json event entries in IPFS
   - Each event links to previous via `prev` field
   - Tracks both entity **creation** and **version updates**
   - Events include: `type` (create/update), `pi`, `ver`, `tip_cid`, `ts`
   - Enables complete change history and mirroring

2. **Snapshots** - Point-in-time entity index with event checkpoints
   - Periodic snapshots of all entities
   - Each snapshot includes `event_cid` checkpoint for incremental sync
   - Stored as dag-json with entity list
   - Enables efficient bulk mirroring and recovery

3. **Index Pointer** - Single source of truth
   - Stored in MFS at `/arke/index-pointer`
   - Tracks current snapshot CID and event stream head
   - Maintains total entity and event counts

**Query Strategy:**
- **GET /entities**: Returns paginated entity list from latest snapshot
- **GET /events**: Returns time-ordered event stream for change tracking
- **GET /snapshot/latest**: Returns complete snapshot with event checkpoint

**Lifecycle:**
1. Entity created → Append "create" event to stream
2. Version added → Append "update" event to stream
3. Periodic snapshots capture current state + event checkpoint
4. Clients can sync incrementally from checkpoint to head

**Event Types:**
- **create**: New entity added to system (ver typically 1)
- **update**: Existing entity received new version (ver > 1)

**Performance Benefits:**
- No MFS directory traversal (was O(n) with n=40K+ entities)
- Sub-100ms queries regardless of total entity count
- Event stream enables efficient mirroring and change tracking
- Scales to millions of entities and events

**Environment Variables:**
- `IPFS_SERVER_API_URL` - Backend API endpoint (e.g., `http://localhost:3000`)

**Backend Endpoints Used:**
- `POST /events/append` - Append create/update event to stream
- `GET /entities?limit=N&cursor=C` - Query entities with pagination
- `GET /events?limit=N&cursor=C` - Query event stream
- `GET /snapshot/latest` - Get latest snapshot with checkpoint

See `BACKEND_API_WALKTHROUGH.md` for complete backend architecture and event stream details.
