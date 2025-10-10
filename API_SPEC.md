# Arke IPFS API Specification

## Overview

This API manages versioned entities (PIs) as immutable IPLD manifests in IPFS, with mutable `.tip` pointers in MFS for fast lookups.

**Base URL:** `https://your-worker.workers.dev`

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

List all entities with pagination. Scans MFS directory structure to discover all entities.

**Query Parameters:**
- `offset` - Starting position (default: 0)
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
  "total": 42,
  "offset": 0,
  "limit": 100,
  "has_more": false
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
  "total": 42,
  "offset": 0,
  "limit": 100,
  "has_more": false
}
```

**Errors:**
- `400` - Invalid pagination params (offset < 0 or limit > 1000)

---

### Create Entity

**`POST /entities`**

Create new entity with v1 manifest.

**Request:**
```json
{
  "pi": "01J8ME3H6FZ3KQ5W1P2XY8K7E5",  // optional; server generates if omitted
  "components": {
    "metadata": "bafybeiabc123...",
    "image": "bafybeiabc456..."
  },
  "children_pi": ["01GX...", "01GZ..."],  // optional
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

**Errors:**
- `400` - Invalid request body
- `409` - PI already exists

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
- `NOT_FOUND` (404)
- `CONFLICT` (409) - PI exists or CAS failure
- `CAS_FAILURE` (409) - Specific CAS error with actual/expected tips
- `IPFS_ERROR` (503)
- `INTERNAL_ERROR` (500)

---

## Data Model

### Manifest (dag-cbor)

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
  "children_pi": ["01GX...", "01GZ..."],
  "note": "Optional change note"
}
```

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
