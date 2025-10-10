# Arke IPFS API - Schema Documentation

This document defines all data structures, storage formats, and schemas used in the Arke IPFS API.

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Storage Architecture](#storage-architecture)
3. [Manifest Schema](#manifest-schema)
4. [Request/Response Schemas](#requestresponse-schemas)
5. [Storage Layout](#storage-layout)
6. [Validation Rules](#validation-rules)

---

## Core Concepts

### Persistent Identifier (PI)

A unique, immutable identifier for an entity.

**Format:** ULID (Universally Unique Lexicographically Sortable Identifier)
- **Length:** 26 characters
- **Alphabet:** Crockford Base32 (0-9, A-Z excluding I, L, O, U)
- **Example:** `01K75HQQXNTDG7BBP7PS9AWYAN`
- **Regex:** `^[0-9A-HJKMNP-TV-Z]{26}$`

**Properties:**
- Sortable by creation time (first 10 chars = timestamp)
- Collision-resistant (120 bits of randomness)
- Case-insensitive
- URL-safe

### Content Identifier (CID)

IPFS content address for immutable data.

**Format:** CIDv1 with base32 encoding
- **Prefix:** `bafy` (dag-pb) or `bafyrei` (dag-cbor)
- **Example:** `bafyreicdsbeei3ry566ok2co7oqfpv2r3s34e5h4gagzy3nnvbqlnyi2n4`

**Properties:**
- Self-describing (contains codec and hash info)
- Immutable (same content = same CID)
- Cryptographically secure

### IPLD Link

Reference to another IPFS object.

**Format:**
```json
{
  "/": "bafyreicdsbeei3ry566ok2co7oqfpv2r3s34e5h4gagzy3nnvbqlnyi2n4"
}
```

**Properties:**
- Standard IPLD link format
- Key is always `"/"`
- Value is a CID string
- Used in dag-cbor encoding

---

## Storage Architecture

### Two-Layer Storage Model

```
┌─────────────────────────────────────────────────────────────┐
│                         MFS Layer                           │
│  (Mutable File System - Fast lookups via .tip files)       │
│                                                             │
│  /arke/index/01/K7/01K75HQQXNTDG7BBP7PS9AWYAN.tip         │
│    └─> Contains: bafyreidw2yist... (latest manifest CID)   │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Points to
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        IPFS Layer                           │
│      (Immutable Content - dag-cbor manifests + files)       │
│                                                             │
│  bafyreidw2yist... (Manifest v2)                           │
│    ├─ prev: bafyreidz6oukn... (Manifest v1)               │
│    ├─ components.metadata: bafkreidkihx... (JSON)          │
│    └─ children_pi: ["01K75HQQZKGZY0..."]                   │
└─────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

**MFS Layer (.tip files):**
- Fast PI → latest manifest CID lookup
- Mutable pointers that can be updated
- Sharded directory structure for scalability
- Single source of truth for "current version"

**IPFS Layer (Content):**
- Immutable versioned manifests (dag-cbor)
- File content (raw bytes or dag-pb)
- Version history chain via `prev` links
- Permanent, content-addressed storage

---

## Manifest Schema

### ManifestV1 (IPLD dag-cbor)

The core data structure representing an entity version.

#### TypeScript Definition

```typescript
interface ManifestV1 {
  schema: 'arke/manifest@v1';           // Schema version identifier
  pi: string;                            // Entity PI (ULID)
  ver: number;                           // Version number (1, 2, 3, ...)
  ts: string;                            // ISO 8601 timestamp
  prev: IPLDLink | null;                 // Link to previous version (null for v1)
  components: {                          // Named CID references
    [label: string]: IPLDLink;
  };
  children_pi?: string[];                // Optional: Child entity PIs
  note?: string;                         // Optional: Change description
}

interface IPLDLink {
  '/': string;                           // CID string
}
```

#### JSON Representation

Before dag-cbor encoding, manifests are JSON:

```json
{
  "schema": "arke/manifest@v1",
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "ver": 2,
  "ts": "2025-10-09T22:33:45.746Z",
  "prev": {
    "/": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse"
  },
  "components": {
    "metadata": {
      "/": "bafkreidkihxb4ni6i6oqb3lz337jx5smd3id3d7qiucvxvfqbm3zzghbaq"
    }
  },
  "children_pi": [
    "01K75HQQZKGZY0ZGEHFWJVY4H5"
  ],
  "note": "Added Blinken series to collection"
}
```

#### Field Specifications

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | string | ✅ | Always `"arke/manifest@v1"` |
| `pi` | string | ✅ | Entity PI (26-char ULID) |
| `ver` | number | ✅ | Version number, starts at 1 |
| `ts` | string | ✅ | ISO 8601 timestamp (UTC) |
| `prev` | IPLDLink \| null | ✅ | Previous version CID, null for v1 |
| `components` | object | ✅ | Map of label → CID, min 1 entry |
| `children_pi` | string[] | ❌ | Array of child PIs (if parent) |
| `note` | string | ❌ | Human-readable change note |

#### Storage Format

Manifests are stored as **dag-cbor** in IPFS:
- Binary CBOR encoding
- IPLD links encoded as CID objects
- Produces deterministic CIDs
- Smaller than JSON (~20-30% compression)

---

## Request/Response Schemas

### POST /upload

**Request:** `multipart/form-data`
```
Content-Type: multipart/form-data; boundary=----...

------...
Content-Disposition: form-data; name="file"; filename="image.jpg"
Content-Type: image/jpeg

<binary data>
------...--
```

**Response:**
```json
[
  {
    "name": "file",
    "cid": "bafybeibsjtzzgiflg3xqnhxsqd5cwtfgidifyndetw4i2moz7x4j4qzkgq",
    "size": 385024
  }
]
```

**TypeScript:**
```typescript
interface UploadResponse {
  name: string;    // Form field name
  cid: string;     // IPFS CID
  size: number;    // Bytes
}
```

---

### GET /cat/:cid

**Path Parameters:**
```typescript
{
  cid: string;  // CIDv1 base32
}
```

**Response:** Binary stream with headers
```
Content-Type: application/octet-stream
Cache-Control: public, max-age=31536000, immutable
X-IPFS-CID: bafybeibsjtzzgiflg3xqnhxsqd5cwtfgidifyndetw4i2moz7x4j4qzkgq
```

---

### GET /entities

**Query Parameters:**
```typescript
interface ListEntitiesParams {
  offset?: number;           // Default: 0
  limit?: number;            // Default: 100, max: 1000
  include_metadata?: boolean; // Default: false
}
```

**Response (without metadata):**
```json
{
  "entities": [
    {
      "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
      "tip": "bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu"
    }
  ],
  "total": 4,
  "offset": 0,
  "limit": 100,
  "has_more": false
}
```

**Response (with metadata):**
```json
{
  "entities": [
    {
      "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
      "tip": "bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu",
      "ver": 2,
      "ts": "2025-10-09T22:33:45.746Z",
      "note": "Added Blinken series to collection",
      "component_count": 1,
      "children_count": 1
    }
  ],
  "total": 4,
  "offset": 0,
  "limit": 100,
  "has_more": false
}
```

**TypeScript:**
```typescript
interface ListEntitiesResponse {
  entities: EntityListItem[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

interface EntityListItem {
  pi: string;
  tip: string;
  // If include_metadata=true:
  ver?: number;
  ts?: string;
  note?: string | null;
  component_count?: number;
  children_count?: number;
}
```

---

### POST /entities

**Request:**
```json
{
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "components": {
    "metadata": "bafkreidkihxb4ni6i6oqb3lz337jx5smd3id3d7qiucvxvfqbm3zzghbaq",
    "image": "bafybeibsjtzzgiflg3xqnhxsqd5cwtfgidifyndetw4i2moz7x4j4qzkgq"
  },
  "children_pi": ["01K75HQQZKGZY0ZGEHFWJVY4H5"],
  "note": "Initial creation"
}
```

**TypeScript:**
```typescript
interface CreateEntityRequest {
  pi?: string;                    // Optional: server generates if omitted
  components: {                   // Required: min 1 component
    [label: string]: string;      // label → CID
  };
  children_pi?: string[];         // Optional: array of child PIs
  note?: string;                  // Optional: description
}
```

**Response:**
```json
{
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "ver": 1,
  "manifest_cid": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse",
  "tip": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse"
}
```

**TypeScript:**
```typescript
interface CreateEntityResponse {
  pi: string;           // Entity PI
  ver: number;          // Always 1 for creation
  manifest_cid: string; // CID of manifest v1
  tip: string;          // Same as manifest_cid for v1
}
```

---

### GET /entities/:pi

**Path Parameters:**
```typescript
{
  pi: string;  // 26-char ULID
}
```

**Response:**
```json
{
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "ver": 2,
  "ts": "2025-10-09T22:33:45.746Z",
  "manifest_cid": "bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu",
  "prev_cid": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse",
  "components": {
    "metadata": "bafkreidkihxb4ni6i6oqb3lz337jx5smd3id3d7qiucvxvfqbm3zzghbaq"
  },
  "children_pi": [
    "01K75HQQZKGZY0ZGEHFWJVY4H5"
  ],
  "note": "Added Blinken series to collection"
}
```

**TypeScript:**
```typescript
interface GetEntityResponse {
  pi: string;
  ver: number;
  ts: string;                    // ISO 8601
  manifest_cid: string;          // CID of this version's manifest
  prev_cid: string | null;       // CID of previous version, null for v1
  components: {                  // Resolved to plain CID strings
    [label: string]: string;
  };
  children_pi?: string[];
  note?: string;
}
```

---

### POST /entities/:pi/versions

**Request:**
```json
{
  "expect_tip": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse",
  "components": {
    "image": "bafybeihd3gsnlp6f65ppcxsv2d2wehamtxmjxcks4simdogoib2ckgmhsq"
  },
  "children_pi_add": ["01K75HQR3AQH9R5SCTG5T2GT0S"],
  "children_pi_remove": [],
  "note": "Added new image and child"
}
```

**TypeScript:**
```typescript
interface AppendVersionRequest {
  expect_tip: string;             // Required: current tip CID (CAS)
  components?: {                  // Optional: partial update
    [label: string]: string;
  };
  children_pi_add?: string[];     // Optional: PIs to add
  children_pi_remove?: string[];  // Optional: PIs to remove
  note?: string;                  // Optional: change description
}
```

**Response:** Same as `CreateEntityResponse` but `ver` is incremented

---

### GET /entities/:pi/versions

**Query Parameters:**
```typescript
interface ListVersionsParams {
  limit?: number;   // Default: 50, max: 1000
  cursor?: string;  // Optional: manifest CID to continue from
}
```

**Response:**
```json
{
  "items": [
    {
      "ver": 2,
      "cid": "bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu",
      "ts": "2025-10-09T22:33:45.746Z",
      "note": "Added Blinken series to collection"
    },
    {
      "ver": 1,
      "cid": "bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse",
      "ts": "2025-10-09T22:33:45.724Z",
      "note": "WJC-NSCSW Collection (naId: 7388842)"
    }
  ],
  "next_cursor": null
}
```

**TypeScript:**
```typescript
interface ListVersionsResponse {
  items: VersionListItem[];
  next_cursor: string | null;  // CID of next page start, null if no more
}

interface VersionListItem {
  ver: number;
  cid: string;      // Manifest CID
  ts: string;       // ISO 8601
  note?: string;
}
```

---

### GET /entities/:pi/versions/:selector

**Path Parameters:**
```typescript
{
  pi: string;
  selector: string;  // Format: "cid:<CID>" or "ver:<number>"
}
```

**Examples:**
- `/entities/01K75HQQXNTDG7BBP7PS9AWYAN/versions/ver:1`
- `/entities/01K75HQQXNTDG7BBP7PS9AWYAN/versions/cid:bafyreidz6oukn...`

**Response:** Same as `GET /entities/:pi`

---

### POST /relations

**Request:**
```json
{
  "parent_pi": "01K75HQQZKGZY0ZGEHFWJVY4H5",
  "expect_tip": "bafyreiej3auugk4vx776kpviruitpnjsvcn5ruw45ugeoa6rez6wgqvthu",
  "add_children": ["01K75HQR3AQH9R5SCTG5T2GT0S"],
  "remove_children": [],
  "note": "Added VJ Day file unit to Blinken series"
}
```

**TypeScript:**
```typescript
interface UpdateRelationsRequest {
  parent_pi: string;              // Required: parent entity PI
  expect_tip: string;             // Required: current parent tip (CAS)
  add_children?: string[];        // Optional: child PIs to add
  remove_children?: string[];     // Optional: child PIs to remove
  note?: string;                  // Optional: change description
}
```

**Response:** Same as `CreateEntityResponse` with incremented version

---

### GET /resolve/:pi

**Path Parameters:**
```typescript
{
  pi: string;  // 26-char ULID
}
```

**Response:**
```json
{
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "tip": "bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu"
}
```

**TypeScript:**
```typescript
interface ResolveResponse {
  pi: string;   // Entity PI
  tip: string;  // Current tip CID (latest manifest)
}
```

---

## Storage Layout

### MFS Directory Structure

All tip files are stored in a sharded directory tree for scalability:

```
/arke/index/
  ├── 01/
  │   ├── J8/
  │   │   ├── 01J8ME3H6FZ3KQ5W1P2XY8K7E5.tip
  │   │   └── 01J8NFQR2GZ8MP4X3N5YT9K2D7.tip
  │   └── K7/
  │       ├── 01K75GZSKKSP2K6TP05JBFNV09.tip
  │       ├── 01K75HQQXNTDG7BBP7PS9AWYAN.tip
  │       ├── 01K75HQQZKGZY0ZGEHFWJVY4H5.tip
  │       └── 01K75HQR3AQH9R5SCTG5T2GT0S.tip
  └── 02/
      └── A3/
          └── ...
```

**Sharding Algorithm:**
- Extract first 2 characters of PI → Level 1 directory (e.g., `01`)
- Extract characters 3-4 of PI → Level 2 directory (e.g., `K7`)
- Filename: `{PI}.tip`

**Example:**
```
PI: 01K75HQQXNTDG7BBP7PS9AWYAN
    ││ └─ Shard 2
    └───── Shard 1
Path: /arke/index/01/K7/01K75HQQXNTDG7BBP7PS9AWYAN.tip
```

### Tip File Format

**Location:** `/arke/index/{shard1}/{shard2}/{PI}.tip`

**Content:** Single line with CID
```
bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu
```

**Properties:**
- Plain text file
- Single line
- No trailing whitespace (trimmed on read)
- Updated atomically on version creation
- Always points to latest manifest CID

### IPFS Content Layout

**Manifests:**
- Codec: `dag-cbor` (0x71)
- CID prefix: `bafyrei` (base32, dag-cbor, sha256)
- Pinned: Yes (permanent storage)

**Files (components):**
- Codec: `raw` (0x55) or `dag-pb` (0x70)
- CID prefix: `bafkrei` (raw) or `bafybei` (dag-pb)
- Pinned: Yes

**Version Chain:**
```
v3 (tip) ──prev──> v2 ──prev──> v1 (genesis)
 │                  │             │
 └─ Components      └─ Comp.      └─ Comp.
```

---

## Validation Rules

### PI (Persistent Identifier)

```typescript
function isValidPI(pi: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(pi);
}
```

**Rules:**
- Exactly 26 characters
- Base32 Crockford alphabet (0-9, A-Z excluding I, L, O, U)
- Case-insensitive (normalized to uppercase)

### CID (Content Identifier)

```typescript
function isValidCID(cid: string): boolean {
  // Use multiformats library
  try {
    CID.parse(cid);
    return true;
  } catch {
    return false;
  }
}
```

**Rules:**
- Must be valid CIDv1 base32
- Starts with `b` (base32)
- Common prefixes:
  - `bafyrei` - dag-cbor
  - `bafybei` - dag-pb
  - `bafkrei` - raw

### Component Labels

**Rules:**
- Non-empty string
- Recommended: alphanumeric + underscore (e.g., `metadata`, `image_001`)
- No reserved characters: `/`, `\`, `.`, `..`

**Examples:**
- ✅ `metadata`
- ✅ `page_001`
- ✅ `thumbnail_jpg`
- ❌ `` (empty)
- ❌ `../etc` (path traversal)

### Version Numbers

**Rules:**
- Positive integer starting at 1
- Incremented sequentially (no gaps)
- Immutable (cannot edit existing versions)

### Timestamps

**Format:** ISO 8601 UTC
```
2025-10-09T22:33:45.746Z
```

**Rules:**
- Must be valid ISO 8601
- Must include timezone (Z for UTC)
- Microsecond precision optional

### Children PIs

**Rules:**
- Each entry must be a valid PI
- No duplicates
- No self-reference (PI cannot be its own child)
- No circular references (enforced at application level)

---

## JSON Schema Definitions

### ManifestV1 JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema", "pi", "ver", "ts", "prev", "components"],
  "properties": {
    "schema": {
      "type": "string",
      "const": "arke/manifest@v1"
    },
    "pi": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
    },
    "ver": {
      "type": "integer",
      "minimum": 1
    },
    "ts": {
      "type": "string",
      "format": "date-time"
    },
    "prev": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "required": ["/"],
          "properties": {
            "/": { "type": "string" }
          }
        }
      ]
    },
    "components": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": {
        "type": "object",
        "required": ["/"],
        "properties": {
          "/": { "type": "string" }
        }
      }
    },
    "children_pi": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "uniqueItems": true
    },
    "note": {
      "type": "string"
    }
  }
}
```

---

## Example: Complete Entity Lifecycle

### 1. Create Entity (v1)

**Request:**
```bash
POST /entities
{
  "components": {
    "metadata": "bafkreidkihxb4..."
  },
  "note": "Initial creation"
}
```

**Stored Manifest (dag-cbor):**
```json
{
  "schema": "arke/manifest@v1",
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "ver": 1,
  "ts": "2025-10-09T22:33:45.724Z",
  "prev": null,
  "components": {
    "metadata": { "/": "bafkreidkihxb4..." }
  },
  "note": "Initial creation"
}
```
→ Stored as CID: `bafyreidz6ouknvrb74...`

**Tip File:** `/arke/index/01/K7/01K75HQQXNTDG7BBP7PS9AWYAN.tip`
```
bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse
```

### 2. Update Relations (v2)

**Request:**
```bash
POST /relations
{
  "parent_pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "expect_tip": "bafyreidz6ouknvrb74...",
  "add_children": ["01K75HQQZKGZY0..."],
  "note": "Added child"
}
```

**Stored Manifest (dag-cbor):**
```json
{
  "schema": "arke/manifest@v1",
  "pi": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "ver": 2,
  "ts": "2025-10-09T22:33:45.746Z",
  "prev": { "/": "bafyreidz6ouknvrb74..." },
  "components": {
    "metadata": { "/": "bafkreidkihxb4..." }
  },
  "children_pi": ["01K75HQQZKGZY0..."],
  "note": "Added child"
}
```
→ Stored as CID: `bafyreidw2yistgsv37...`

**Updated Tip File:**
```
bafyreidw2yistgsv37ercgfm7g3uwif6uj7oquzo6h2fwzo3lsesnzanwu
```

### 3. Query Entity

**Request:**
```bash
GET /entities/01K75HQQXNTDG7BBP7PS9AWYAN
```

**Flow:**
1. Read tip file → `bafyreidw2yist...`
2. Fetch manifest from IPFS: `ipfs dag get bafyreidw2yist...`
3. Transform to response format (resolve IPLD links)
4. Return JSON

---

## Version History Graph

```
Entity: 01K75HQQXNTDG7BBP7PS9AWYAN

v2: bafyreidw2yist...
├─ prev → v1
├─ components.metadata → bafkreidkihxb4...
└─ children_pi: ["01K75HQQZKGZY0..."]
    │
    └─> v1: bafyreidz6ouknv...
        ├─ prev → null (genesis)
        └─ components.metadata → bafkreidkihxb4...
```

**Traversal:**
- Forward: Start at v1 (requires walking entire chain)
- Backward: Start at tip, follow `prev` links
- Random access: Use version number selector

---

## Summary

This schema provides:
- **Clear data structures** for all objects
- **Type safety** with TypeScript definitions
- **Validation rules** for all fields
- **Storage layout** documentation
- **IPLD link format** specifications
- **Complete examples** of entity lifecycle

All schemas are enforced at runtime using Zod validators in the implementation.
