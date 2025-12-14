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
- **Prefix:** `bafy` (dag-pb) or `baguqee` (dag-json)
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
- Used in dag-json encoding

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
│      (Immutable Content - dag-json manifests + files)       │
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
- Immutable versioned manifests (dag-json)
- File content (raw bytes or dag-pb)
- Version history chain via `prev` links
- Permanent, content-addressed storage

---

## Manifest Schema

### EidosV1 (IPLD dag-json) - Current Schema

The core data structure representing an entity version. This is the unified schema that replaced legacy `arke/manifest@v1` and `arke/entity@v1` schemas.

#### TypeScript Definition

```typescript
interface EidosV1 {
  schema: 'arke/eidos@v1';              // Schema version identifier
  id: string;                            // Entity identifier (ULID)
  type: string;                          // Entity type (e.g., "PI", "Collection", "Document")
  source_pi?: string;                    // Optional: Provenance (which PI extracted this)
  created_at: string;                    // ISO 8601 timestamp of version 1 (immutable)
  ver: number;                           // Version number (1, 2, 3, ...)
  ts: string;                            // ISO 8601 timestamp of this version
  prev: IPLDLink | null;                 // Link to previous version (null for v1)
  components: {                          // Named CID references
    [label: string]: IPLDLink;
  };
  children_pi?: string[];                // Optional: Child entity IDs (tree structure)
  parent_pi?: string;                    // Optional: Parent entity ID (tree structure)
  merged_entities?: string[];            // Optional: IDs of entities merged into this one
  label?: string;                        // Optional: Display name
  description?: string;                  // Optional: Human-readable description
  note?: string;                         // Optional: Change description
}

interface IPLDLink {
  '/': string;                           // CID string
}
```

#### Legacy Schemas

**ManifestV1** (deprecated, preserved in version history):
```typescript
interface ManifestV1 {
  schema: 'arke/manifest@v1';
  pi: string;
  ver: number;
  ts: string;
  prev: IPLDLink | null;
  components: { [label: string]: IPLDLink };
  children_pi?: string[];
  parent_pi?: string;
  note?: string;
}
```

**EntityV1** (deprecated, preserved in version history):
```typescript
interface EntityV1 {
  schema: 'arke/entity@v1';
  pi: string;
  entity_type: string;
  ver: number;
  ts: string;
  prev: IPLDLink | null;
  components: { [label: string]: IPLDLink };
  parent_pi?: string;
  label?: string;
  description?: string;
  note?: string;
}
```

**Migration Status:** All entities have been migrated to `arke/eidos@v1`. Legacy schemas exist only in historical versions.

#### JSON Representation

Before dag-json encoding, manifests are JSON:

```json
{
  "schema": "arke/eidos@v1",
  "id": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "type": "PI",
  "created_at": "2025-10-09T22:30:00.000Z",
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
  "label": "WJC-NSCSW Collection",
  "description": "World Jewish Congress collection from NARA",
  "note": "Added Blinken series to collection"
}
```

#### Field Specifications

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | string | ✅ | Always `"arke/eidos@v1"` |
| `id` | string | ✅ | Entity identifier (26-char ULID) |
| `type` | string | ✅ | Entity type (e.g., "PI", "Collection") |
| `source_pi` | string | ❌ | Provenance - which PI extracted this entity |
| `created_at` | string | ✅ | ISO 8601 timestamp of v1 (immutable) |
| `ver` | number | ✅ | Version number, starts at 1 |
| `ts` | string | ✅ | ISO 8601 timestamp of this version (UTC) |
| `prev` | IPLDLink \| null | ✅ | Previous version CID, null for v1 |
| `components` | object | ✅ | Map of label → CID, min 1 entry |
| `children_pi` | string[] | ❌ | Array of child entity IDs (tree structure) |
| `parent_pi` | string | ❌ | Parent entity ID (tree structure) |
| `merged_entities` | string[] | ❌ | IDs of entities merged into this one |
| `label` | string | ❌ | Display name for UI |
| `description` | string | ❌ | Human-readable description |
| `note` | string | ❌ | Change note for this version |

#### Storage Format

Manifests are stored as **dag-json** in IPFS:
- JSON text encoding
- IPLD links encoded as CID objects
- Produces deterministic CIDs
- Larger than dag-cbor but preserves IPLD link semantics

---

### Merged Tombstone (dag-json)

Schema: **`arke/eidos-merged@v1`**

When an entity is merged into another, a tombstone redirect manifest is created that preserves the version chain while redirecting to the target entity.

```json
{
  "schema": "arke/eidos-merged@v1",
  "id": "01SOURCE123...",
  "type": "PI",
  "ver": 3,
  "ts": "2025-10-09T15:30:00Z",
  "prev": { "/": "bafybeilast..." },
  "merged_into": "01TARGET456...",
  "note": "Merged - duplicate entry"
}
```

**Field Specifications:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | string | ✅ | Always `"arke/eidos-merged@v1"` |
| `id` | string | ✅ | Source entity ID (the one being merged) |
| `type` | string | ✅ | Preserved entity type from source |
| `ver` | number | ✅ | Version number (incremented from last active) |
| `ts` | string | ✅ | Merge timestamp (ISO 8601) |
| `prev` | IPLDLink | ✅ | Link to last active version (required - not nullable) |
| `merged_into` | string | ✅ | Target entity ID (where data was merged into) |
| `note` | string | ❌ | Optional merge reason/description |

**Key Properties:**
- Minimal tombstone with redirect (no components)
- Version chain continues from source entity (`ver + 1`)
- `prev` link required (points to last real version before merge)
- Preserves entity type for context
- API automatically follows redirect chains
- Can be restored via unmerge operation
- Target entity tracks merge via `merged_entities` array

**Target Entity Tracking:**

When entities with existing merge histories are merged together, the `merged_entities` arrays are concatenated:

```typescript
// Before merge:
A.merged_entities = ["M1", "M2"]  // A previously absorbed M1 and M2
B.merged_entities = ["M3", "M4"]  // B previously absorbed M3 and M4

// After merging A into B:
B.merged_entities = ["M3", "M4", "A", "M1", "M2"]  // Complete audit trail
```

This concatenation ensures full lineage tracking even through nested merges.

**TypeScript Definition:**
```typescript
interface EidosMerged {
  schema: 'arke/eidos-merged@v1';
  id: string;
  type: string;
  ver: number;
  ts: string;
  prev: IPLDLink;
  merged_into: string;
  note?: string;
}
```

---

### Deleted Tombstone (dag-json)

Schema: **`arke/eidos-deleted@v1`**

When an entity is soft deleted, a lightweight tombstone manifest is created that preserves the version chain while marking the entity as deleted.

```json
{
  "schema": "arke/eidos-deleted@v1",
  "id": "01SOURCE123...",
  "type": "PI",
  "ver": 4,
  "ts": "2025-12-14T18:00:00Z",
  "prev": { "/": "bafybeilast..." },
  "note": "Deleted - duplicate record"
}
```

**Field Specifications:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | string | ✅ | Always `"arke/eidos-deleted@v1"` |
| `id` | string | ✅ | Original entity ID |
| `type` | string | ✅ | Preserved entity type |
| `ver` | number | ✅ | Version number (incremented from last active) |
| `ts` | string | ✅ | Deletion timestamp (ISO 8601) |
| `prev` | IPLDLink | ✅ | Link to last active version (required - not nullable) |
| `note` | string | ❌ | Optional deletion reason |

**Key Properties:**
- Minimal tombstone (no components, no relationships)
- Version chain continues from deleted entity (`ver + 1`)
- `prev` link required (unlike active Eidos where it's nullable for v1)
- Preserves entity type for context
- All previous versions remain accessible via `prev` chain
- Can be restored via undelete operation

**TypeScript Definition:**
```typescript
interface EidosDeleted {
  schema: 'arke/eidos-deleted@v1';
  id: string;
  type: string;
  ver: number;
  ts: string;
  prev: IPLDLink;
  note?: string;
}
```

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
  ├── K7/
  │   ├── E5/
  │   │   └── 01J8ME3H6FZ3KQ5W1P2XY8K7E5.tip
  │   └── D7/
  │       └── 01J8NFQR2GZ8MP4X3N5YT9K2D7.tip
  ├── AW/
  │   └── YA/
  │       ├── 01K75GZSKKSP2K6TP05AWYAN09.tip
  │       └── 01K75HQQXNTDG7BBP7PS9AWYAN.tip
  └── V4/
      └── H5/
          └── 01K75HQQZKGZY0ZGEHFWJVY4H5.tip
```

**Sharding Algorithm:**
- Extract characters [-4:-2] of ULID → Level 1 directory (e.g., `AW`)
- Extract characters [-2:] of ULID → Level 2 directory (e.g., `YA`)
- Filename: `{ULID}.tip`

**Why Last 4 Chars:**
ULIDs have this structure:
```
TTTTTTTTTTRRRRRRRRRRRRRRRR
|---------|---------------|
timestamp  randomness
(10 chars) (16 chars)
```

The first 10 chars are timestamp-based and change very slowly (chars 0-1 change every ~278 years!). Using the last 4 chars from the random portion provides uniform distribution across 32^4 = 1,048,576 possible shard combinations.

**Example:**
```
ULID: 01K75HQQXNTDG7BBP7PS9AWYAN
                          ││││
                          │││└── Shard 2 (last 2)
                          ││└────
                          └────── Shard 1 (chars -4 to -2)
Path: /arke/index/AW/YA/01K75HQQXNTDG7BBP7PS9AWYAN.tip
```

**Migration Note:** The sharding algorithm was updated on 2025-12-13. All tip files have been migrated to the new path structure. See `scripts/migrations/migrate-sharding.ts` for details.

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
- Codec: `dag-json` (0x0129)
- CID prefix: `baguqee` (base32, dag-json, sha256)
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
  - `baguqee` - dag-json
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

### EidosV1 JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema", "id", "type", "created_at", "ver", "ts", "prev", "components"],
  "properties": {
    "schema": {
      "type": "string",
      "const": "arke/eidos@v1"
    },
    "id": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$",
      "description": "Entity identifier (ULID)"
    },
    "type": {
      "type": "string",
      "minLength": 1,
      "description": "Entity type (e.g., PI, Collection, Document)"
    },
    "created_at": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of version 1 (immutable)"
    },
    "ver": {
      "type": "integer",
      "minimum": 1
    },
    "ts": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of this version"
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
    "source_pi": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$",
      "description": "Provenance - which PI extracted this entity"
    },
    "parent_pi": {
      "type": "string",
      "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$",
      "description": "Parent entity ID (tree structure)"
    },
    "children_pi": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"
      },
      "uniqueItems": true,
      "description": "Array of child entity IDs"
    },
    "label": {
      "type": "string",
      "description": "Display name for UI"
    },
    "description": {
      "type": "string",
      "description": "Human-readable description"
    },
    "note": {
      "type": "string",
      "description": "Change note for this version"
    }
  }
}
```

### Legacy Schema Definitions

**ManifestV1 JSON Schema** (deprecated):
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema", "pi", "ver", "ts", "prev", "components"],
  "properties": {
    "schema": { "type": "string", "const": "arke/manifest@v1" },
    "pi": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "ver": { "type": "integer", "minimum": 1 },
    "ts": { "type": "string", "format": "date-time" },
    "prev": { "oneOf": [{ "type": "null" }, { "type": "object", "required": ["/"], "properties": { "/": { "type": "string" }}}]},
    "components": { "type": "object", "minProperties": 1 },
    "children_pi": { "type": "array", "items": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" }},
    "parent_pi": { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "note": { "type": "string" }
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

**Stored Manifest (dag-json):**
```json
{
  "schema": "arke/eidos@v1",
  "id": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "type": "PI",
  "created_at": "2025-10-09T22:33:45.724Z",
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

**Tip File:** `/arke/index/AW/YA/01K75HQQXNTDG7BBP7PS9AWYAN.tip`
```
bafyreidz6ouknvrb74dytwp4bezjdh6fqxdsz4nynmp2xjvjw6ia6ijbse
```

**Note:** Path uses last 4 chars of ULID for sharding: `...AWYAN` → `AW/YA/`

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

**Stored Manifest (dag-json):**
```json
{
  "schema": "arke/eidos@v1",
  "id": "01K75HQQXNTDG7BBP7PS9AWYAN",
  "type": "PI",
  "created_at": "2025-10-09T22:33:45.724Z",
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
