# Entity Schema Documentation

This document describes the entity manifest schema used by the Arke IPFS API service. Entities are knowledge graph nodes stored as versioned IPLD dag-json manifests.

## Table of Contents

- [Overview](#overview)
- [Eidos Manifest Schema](#eidos-manifest-schema)
- [Components](#components)
- [Merged Entity Schema](#merged-entity-schema)
- [Deleted Entity Schema](#deleted-entity-schema)
- [Relationships Component](#relationships-component)
- [Storage Structure](#storage-structure)
- [Version Chain](#version-chain)
- [API Reference](#api-reference)

---

## Overview

Entities in Arke are IPFS-native knowledge graph nodes that support:

- **Immutable versioning** - Every change creates a new version linked to the previous
- **Flexible components** - Properties, relationships, and arbitrary file attachments
- **Merge operations** - Duplicate entities can be merged with full history preservation
- **Lightweight loading** - Core identity (type, label) available without fetching components

### Entity ID Format

Entities use **ULIDs** (Universally Unique Lexicographically Sortable Identifiers):

- 26 characters, Crockford Base32 alphabet
- Timestamp-sortable (first 10 chars = millisecond timestamp)
- URL-safe, no special characters
- Example: `01K75HQQXNTDG7BBP7PS9AWYAN`

**Network Isolation:**
- **Main network**: Standard ULIDs
- **Test network**: Prefixed with `II` (e.g., `IIAK75HQQXNTDG7BBP7PS9AWY`)

---

## Eidos Manifest Schema

**Schema ID:** `arke/eidos@v1`

The unified Eidos schema is used for all entities (PIs, people, places, organizations, etc.).

```typescript
interface Eidos {
  schema: 'arke/eidos@v1';

  // =========================================================================
  // IDENTITY (immutable after creation)
  // =========================================================================

  id: string;                  // ULID - unique identifier, never changes
  type: string;                // Entity type: "PI", "person", "place", "organization", etc.
  source_pi?: string;          // Optional: ULID of the PI that extracted this entity
  created_at: string;          // ISO 8601 timestamp of v1 creation (immutable)

  // =========================================================================
  // VERSION CHAIN
  // =========================================================================

  ver: number;                 // Version number (1, 2, 3...)
  ts: string;                  // ISO 8601 timestamp of this version
  prev: IPLDLink | null;       // IPLD link to previous version (null for v1)

  // =========================================================================
  // LIGHTWEIGHT FIELDS (for efficient context loading)
  // =========================================================================

  label?: string;              // Optional display name
  description?: string;        // Optional concise description

  // =========================================================================
  // COMPONENTS (CID references)
  // =========================================================================

  components: {
    properties?: IPLDLink;       // Structured key-value data
    relationships?: IPLDLink;    // Semantic graph (arke/relationships@v1)
    [filename: string]: IPLDLink; // Arbitrary file attachments
  };

  // =========================================================================
  // HIERARCHICAL TREE STRUCTURE (optional, bidirectional)
  // =========================================================================

  children_pi?: string[];      // Child entity IDs (downward pointers)
  parent_pi?: string;          // Parent entity ID (upward pointer)

  // =========================================================================
  // MERGE TRACKING
  // =========================================================================

  merged_entities?: string[];  // Entity IDs that were merged into this one

  // =========================================================================
  // VERSION NOTE
  // =========================================================================

  note?: string;               // Optional change description
}
```

### IPLD Link Format

IPLD links are JSON objects with a single `/` key pointing to a CID:

```json
{ "/": "bafyreihxyz123..." }
```

---

## Components

The `components` object contains CID references to data stored separately from the manifest. This allows:

- Efficient manifest loading without fetching large data
- Deduplication when multiple entities share the same component
- Flexible attachment of any file type

### Reserved Component Keys

| Key | Description | Format |
|-----|-------------|--------|
| `properties` | Structured key-value data | dag-json object |
| `relationships` | Outgoing relationships | `arke/relationships@v1` |

### Arbitrary File Components

Any other key is treated as a filename pointing to a CID:

```json
{
  "components": {
    "properties": { "/": "bafkrei..." },
    "relationships": { "/": "bafkrei..." },
    "description.md": { "/": "bafkrei..." },
    "pinax.json": { "/": "bafkrei..." },
    "profile.jpg": { "/": "bafkrei..." },
    "timeline.json": { "/": "bafkrei..." }
  }
}
```

**Common file components:**

| Filename | Purpose |
|----------|---------|
| `description.md` | Extended markdown description |
| `pinax.json` | Structured metadata (Dublin Core, etc.) |
| `biography.txt` | Biographical text |
| `notes.txt` | Research notes |
| `*.jpg/png` | Profile images |
| `timeline.json` | Chronological data |

### Properties Component

The `properties` component stores structured key-value data:

```json
{
  "birth_year": 1866,
  "death_year": 1952,
  "nationality": "American",
  "occupation": ["photographer", "author"],
  "notable_works": [
    { "title": "Street Types of New York", "year": 1896 }
  ]
}
```

**Best practices:**
- Use snake_case for keys
- Arrays for multi-valued properties
- Nested objects for complex structures
- Avoid deeply nested data (prefer separate components)

---

## Merged Entity Schema

When entity A is merged into entity B, a tombstone redirect version is created for A:

**Schema ID:** `arke/eidos-merged@v1`

```typescript
interface EidosMerged {
  schema: 'arke/eidos-merged@v1';

  // =========================================================================
  // IDENTITY (preserved from original)
  // =========================================================================

  id: string;                  // The entity that was merged (A)
  type: string;                // Preserved from original entity

  // =========================================================================
  // VERSION CHAIN (continues from original - preserves history!)
  // =========================================================================

  ver: number;                 // Next version number
  ts: string;                  // When merge happened
  prev: IPLDLink;              // Link to last real version (required - NOT null)

  // =========================================================================
  // REDIRECT TARGET
  // =========================================================================

  merged_into: string;         // Entity ID that this was merged into (B)

  // =========================================================================
  // VERSION NOTE
  // =========================================================================

  note?: string;               // e.g., "Merged into Alice Austen (duplicate)"
}
```

### Key Points

1. **History preserved** - The `prev` link points to the last real version before merge
2. **No deletion** - The entity still exists, just redirects
3. **Chain resolution** - API follows redirects automatically
4. **Unmerge possible** - Can create new version from `prev` to restore
5. **Type preserved** - The original entity type is preserved in the tombstone

### Merge Tracking

When entities are merged, the target entity tracks all absorbed entities:

```typescript
// Before merge
A.merged_entities = ["M1", "M2"]  // A previously absorbed M1 and M2
B.merged_entities = ["M3", "M4"]  // B previously absorbed M3 and M4

// After merging A into B
B.merged_entities = ["M3", "M4", "A", "M1", "M2"]  // Complete audit trail
```

This concatenation ensures full lineage tracking even through nested merges.

---

## Deleted Entity Schema

When an entity is soft-deleted, a tombstone version is created:

**Schema ID:** `arke/eidos-deleted@v1`

```typescript
interface EidosDeleted {
  schema: 'arke/eidos-deleted@v1';

  // =========================================================================
  // IDENTITY (preserved from original)
  // =========================================================================

  id: string;                  // The deleted entity ID
  type: string;                // Preserved from original entity

  // =========================================================================
  // VERSION CHAIN (continues from original - preserves history!)
  // =========================================================================

  ver: number;                 // Next version number
  ts: string;                  // When deletion happened
  prev: IPLDLink;              // Link to last real version (required - NOT null)

  // =========================================================================
  // DELETION METADATA
  // =========================================================================

  note?: string;               // Optional deletion reason
}
```

### Key Points

1. **Soft delete** - No data is actually destroyed
2. **History preserved** - Full version chain remains intact via `prev` links
3. **Undelete possible** - Can restore from `prev` to create new active version
4. **Type preserved** - The original entity type is preserved in the tombstone

---

## Relationships Component

**Schema ID:** `arke/relationships@v1`

```typescript
interface RelationshipsComponent {
  schema: 'arke/relationships@v1';
  relationships: Relationship[];
  timestamp: string;           // ISO 8601
  note?: string;
}

interface Relationship {
  predicate: string;           // Relationship type (e.g., "KNOWS", "WORKS_AT")
  target_type: 'pi' | 'entity'; // Target is a PI or another entity
  target_id: string;           // ULID of target
  target_label: string;        // Display label for target
  target_entity_type?: string; // Type of target entity (e.g., "person", "place")
  properties?: Record<string, any>; // Optional relationship properties
}
```

### Example

```json
{
  "schema": "arke/relationships@v1",
  "relationships": [
    {
      "predicate": "LIVES_IN",
      "target_type": "entity",
      "target_id": "01K75HQQXNTDG7BBP7PS9PLACE",
      "target_label": "Clear Comfort",
      "target_entity_type": "place"
    },
    {
      "predicate": "PHOTOGRAPHED",
      "target_type": "pi",
      "target_id": "01K75HQQXNTDG7BBP7PS9PHOTO",
      "target_label": "Street Types of New York"
    }
  ],
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Common Predicates

| Predicate | Description |
|-----------|-------------|
| `KNOWS` | Person knows person |
| `WORKS_AT` | Person works at organization |
| `LIVES_IN` | Person/organization at place |
| `MEMBER_OF` | Person member of organization |
| `CREATED_BY` | Work created by person |
| `LOCATED_IN` | Place within larger place |
| `OCCURRED_AT` | Event at place |
| `PARTICIPATED_IN` | Person/org in event |
| `MENTIONED_IN` | Entity mentioned in PI |

---

## Storage Structure

### MFS Layout

Entities are stored in MFS (Mutable File System) with 2-level sharding:

```
/arke/
  entities/                           # Main network entities
    {shard1}/{shard2}/{entity_id}.tip
  test/
    entities/                         # Test network entities
      {shard1}/{shard2}/{entity_id}.tip
```

### Sharding Algorithm

Uses **last 4 characters** of the ULID (from the random portion) for uniform distribution:

```typescript
function shard2(ulid: string): [string, string] {
  return [ulid.slice(-4, -2), ulid.slice(-2)];
}

// Example:
// "01K75HQQXNTDG7BBP7PS9AWYAN" -> ["AW", "YA"]
// Path: /arke/entities/AW/YA/01K75HQQXNTDG7BBP7PS9AWYAN.tip
```

**Why last 4 characters?**
- First 10 chars are timestamp (slow to change)
- Last 16 chars are random (uniform distribution)
- 32^4 = 1,048,576 possible shard combinations

### Tip Files

Each `.tip` file contains the CID of the latest manifest version:

```
bafyreihxyz123abc456def789...
```

---

## Version Chain

Entities form a linked list of versions via the `prev` field:

```
v3 (current tip)
 └─prev─→ v2
           └─prev─→ v1 (genesis)
                     └─prev─→ null
```

### Traversal

- **Forward**: Start from v1, follow `prev` links backward from tip
- **Backward**: Start from tip, follow `prev` links (efficient)
- **Random access**: Use version selectors (e.g., `ver:2`)

### Merged Entity Chain

When merged, the chain continues but with redirect schema:

```
v4 (merged redirect)  ← current tip
 └─prev─→ v3 (last real version)
           └─prev─→ v2
                     └─prev─→ v1
```

---

## API Reference

### Create Entity

```http
POST /entities-kg
Content-Type: application/json
X-Arke-Network: test

{
  "created_by_pi": "IITEST123...",
  "type": "person",
  "label": "Alice Austen",
  "description": "American photographer",
  "properties": {
    "birth_year": 1866
  },
  "relationships": [
    {
      "predicate": "LIVES_IN",
      "target_type": "entity",
      "target_id": "IIPLACE456...",
      "target_label": "Clear Comfort"
    }
  ],
  "components": {
    "description.md": "bafkrei...",
    "pinax.json": "bafkrei..."
  }
}
```

### Get Entity

```http
GET /entities-kg/{entity_id}
X-Arke-Network: test
```

**Response (active entity):**
```json
{
  "entity_id": "IIENTITY789...",
  "ver": 2,
  "ts": "2025-01-15T10:30:00.000Z",
  "manifest_cid": "bafyrei...",
  "prev_cid": "bafyrei...",
  "type": "person",
  "label": "Alice Austen",
  "description": "American photographer",
  "components": {
    "properties": "bafkrei...",
    "relationships": "bafkrei...",
    "description.md": "bafkrei..."
  },
  "source_pis": ["IITEST123..."]
}
```

**Response (merged entity):**
```json
{
  "status": "merged",
  "entity_id": "IIENTITY789...",
  "merged_into": "IIENTITY999...",
  "merged_at": "2025-01-20T14:00:00.000Z",
  "prev_cid": "bafyrei..."
}
```

### Append Version

```http
POST /entities-kg/{entity_id}/versions
Content-Type: application/json
X-Arke-Network: test

{
  "expect_tip": "bafyrei...",
  "label": "Alice Josephine Austen",
  "properties": {
    "birth_year": 1866,
    "death_year": 1952
  },
  "components": {
    "biography.md": "bafkrei...",
    "timeline.json": ""
  },
  "note": "Added biography, removed timeline"
}
```

**Component operations:**
- Provide CID string to add/update a component
- Provide empty string `""` to remove a component

### Merge Entity

See [ENTITY-MERGE.md](./ENTITY-MERGE.md) for detailed merge documentation.

---

## Type Definitions

Full TypeScript types are in:
- `src/types/eidos.ts` - Eidos manifest schemas (active, merged, deleted)
- `src/types/relationships.ts` - Relationships component schema

Zod validation schemas are exported for runtime validation.
