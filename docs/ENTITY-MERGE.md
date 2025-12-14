# Entity Merge & Unmerge Documentation

This document describes how entity merging and unmerging works in the Arke IPFS API service, including the atomic merge protocol, component merging rules, race condition handling, and restore operations.

## Table of Contents

- [Overview](#overview)
- [Merge API](#merge-api)
- [Component Merge Rules](#component-merge-rules)
- [Atomic Merge Protocol](#atomic-merge-protocol)
- [Race Condition Handling](#race-condition-handling)
- [Redirect Resolution](#redirect-resolution)
- [Unmerging](#unmerging)
- [Best Practices](#best-practices)

---

## Overview

Entity merging combines two entities into one:
- **Source entity** becomes a redirect pointer
- **Target entity** absorbs all data from source
- **History preserved** - source's previous versions remain accessible via `prev` chain
- **Components merged** - properties, relationships, and files are combined

### When to Merge

- Duplicate detection found same real-world entity
- AI reconciliation determined entities are the same
- Manual review confirmed duplicates
- Entity alias consolidation

### Key Principles

1. **Caller controls direction** - you decide which entity becomes the redirect
2. **Target precedence** - target's data wins on conflicts
3. **No data loss** - everything preserved via version chain
4. **Atomic operation** - merge either fully succeeds or fully fails

---

## Merge API

### Endpoint

```http
POST /entities-kg/{source_entity_id}/merge
Content-Type: application/json
X-Arke-Network: test
```

The entity in the URL path is the **source** (will become redirect).

### Request

```json
{
  "expect_tip": "bafyrei...",  // CAS guard - current tip of source
  "merge_into": "IIENTITY...", // Target entity ID
  "note": "Duplicate entity"   // Optional description
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `expect_tip` | Yes | CAS guard - must match current source tip |
| `merge_into` | Yes | Entity ID to merge into |
| `note` | No | Reason for merge |
| `skip_sync` | No | Skip index-sync callback (internal use) |

### Success Response (201)

```json
{
  "source_entity_id": "IIENTITY_SOURCE...",
  "merged_into": "IIENTITY_TARGET...",
  "source_new_ver": 2,
  "source_manifest_cid": "bafyrei...",
  "target_new_ver": 3,
  "target_manifest_cid": "bafyrei..."
}
```

### Error Responses

**409 Conflict - CAS Failure:**
```json
{
  "error": "CAS_FAILURE",
  "message": "Expected tip bafyrei... but found bafyrei..."
}
```

**409 Conflict - Lost Tiebreaker:**
```json
{
  "conflict": true,
  "message": "Merge conflict: TARGET->SOURCE won (smaller source ID)",
  "winner_source": "IIENTITY_TARGET...",
  "winner_target": "IIENTITY_SOURCE..."
}
```

**409 Conflict - Target Merged:**
```json
{
  "error": "Entity conflict",
  "message": "Target was merged into IIENTITY_OTHER during operation. Source restored - please retry."
}
```

**400 Validation Error:**
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Cannot merge entity into itself"
}
```

---

## Component Merge Rules

When entity A is merged into entity B, ALL components are merged:

### Properties Merge

**Rule:** Union with target precedence

```
A.properties: { birth_year: 1879, nationality: "German", field: "Physics" }
B.properties: { death_year: 1955, nationality: "American" }

Result: {
  birth_year: 1879,    // A-only -> included
  death_year: 1955,    // B-only -> included
  nationality: "American",  // CONFLICT -> B wins
  field: "Physics"     // A-only -> included
}
```

**Implementation:**
```typescript
const merged = {
  ...sourceProps,  // A's properties first
  ...targetProps,  // B's properties overwrite
};
```

### Relationships Merge

**Rule:** Concatenate arrays (target first, then source)

```
A.relationships: [KNOWS -> C]
B.relationships: [WORKS_AT -> D, LIVES_IN -> E]

Result: [WORKS_AT -> D, LIVES_IN -> E, KNOWS -> C]
```

**Notes:**
- No deduplication - relationships are appended as-is
- Order: target relationships, then source relationships
- Duplicate relationships preserved (may represent different contexts)

### File Components Merge

**Rule:** Union with target precedence (same filename = target wins)

```
A.components: {
  description.md: "A's description"
  notes.txt: "A's notes"
}
B.components: {
  description.md: "B's description"
  summary.txt: "B's summary"
}

Result: {
  description.md: "B's description"  // CONFLICT -> B wins
  notes.txt: "A's notes"             // A-only -> included
  summary.txt: "B's summary"         // B-only -> included
}
```

### Merged Entities Tracking

**Rule:** Concatenate arrays with source ID in the middle (preserves full audit trail)

```
A.merged_entities: [M1, M2]
B.merged_entities: [M3, M4]

When merging A into B:
Result: [M3, M4, A, M1, M2]
```

This ensures all entities that have been absorbed into the canonical entity are tracked, even through nested merges.

---

## Atomic Merge Protocol

The merge operation uses a **lock-then-check** protocol to handle race conditions:

### Step 1: Validate

```
1. Check source is not already merged
2. If target is merged, follow chain to canonical entity
3. Validate CAS guard (expect_tip)
```

### Step 2: Lock Source

```
1. Create EntityMerged manifest pointing to target
2. CAS write to source.tip
3. If CAS fails -> source was modified, return error
```

### Step 3: Check for Cycle

```
1. Re-read target tip
2. If target is now merged into source -> CYCLE DETECTED
   - Apply tiebreaker (smaller source ID wins)
   - Winner restores target and completes merge
   - Loser restores source and returns 409
```

### Step 4: Handle Target Merged During Operation

```
1. If target merged into something else (not us):
   - Restore source to previous state
   - Return 409 with retry message
```

### Step 5: Update Target

```
1. Merge all components (properties, relationships, files)
2. Merge source_pis
3. CAS write with retry loop (up to 3 retries)
```

### Sequence Diagram

```
Client              Source MFS           Target MFS
  |                     |                    |
  |--1. Read source---->|                    |
  |<---manifest---------|                    |
  |                     |                    |
  |--2. Lock source---->|                    |
  |   (CAS write)       |                    |
  |                     |                    |
  |--3. Read target-----|---------------->|  |
  |<---manifest---------------------------|  |
  |                     |                    |
  |  [Check for cycle]  |                    |
  |                     |                    |
  |--4. Merge components|                    |
  |                     |                    |
  |--5. Update target---|---------------->|  |
  |   (CAS write)       |                    |
  |                     |                    |
  |<---success----------|                    |
```

---

## Race Condition Handling

### Mutual Merge (A->B and B->A)

Two parties try to merge into each other simultaneously:

```
T1: Owner A writes A.tip -> EntityMerged{merged_into: B}
T2: Owner B writes B.tip -> EntityMerged{merged_into: A}
T3: Owner A checks B.tip -> sees merged_into: A (CYCLE!)
    Tiebreaker: A < B, Owner A wins
T4: Owner A restores B, merges components, completes
T5: Owner B checks A.tip -> sees merged_into: B (CYCLE!)
    Tiebreaker: B > A, Owner B loses
T6: Owner B restores A -> CAS fails (already correct)
T7: Owner B returns 409 conflict
```

**Tiebreaker rule:** Smaller source entity ID wins.

### Chain Race (A->B and B->C)

Two merges create a chain:

```
T1: Worker X starts merge(A, B)
T2: Worker Y starts merge(B, C)
T3: Worker Y locks B->C (succeeds)
T4: Worker X locks A->B (B is now merged!)
T5: Worker X checks B -> EntityMerged{merged_into: C}
    Not a cycle, but target invalid
T6: Worker X restores A
T7: Worker X returns 409: "Target merged, please retry"
```

**Client retry:** `merge(A, C)` succeeds directly.

### Chain Auto-Follow

When target is already merged, we follow the chain:

```
State: B already merged into C
Request: merge(A, B)

T1: Read B.tip -> EntityMerged{merged_into: C}
T2: Follow chain: B -> C
T3: Lock A->C (not A->B!)
T4: Merge A's components into C
T5: Update C

Result: A points directly to C (no intermediate hops)
```

---

## Redirect Resolution

### Automatic Resolution

The API automatically follows redirect chains:

```http
GET /entities-kg/MERGED_ENTITY_ID
```

Returns redirect info:
```json
{
  "status": "merged",
  "entity_id": "MERGED_ENTITY_ID",
  "merged_into": "TARGET_ENTITY_ID",
  "merged_at": "2025-01-20T14:00:00.000Z",
  "prev_cid": "bafyrei..."
}
```

### Lightweight Resolution

```http
GET /entities-kg/MERGED_ENTITY_ID?resolve=lightweight
```

Follows redirects and returns canonical entity:
```json
{
  "entity_id": "TARGET_ENTITY_ID",
  "type": "person",
  "label": "Alice Austen"
}
```

### Chain Limits

- Maximum 10 hops to prevent infinite loops
- Cycle detection via visited set
- Error if limit exceeded

---

## Unmerging

The unmerge API restores a merged entity back to active state.

### Endpoint

```http
POST /entities-kg/{entity_id}/unmerge
Content-Type: application/json
X-Arke-Network: test
```

### Request

```json
{
  "expect_tip": "bafyrei...",     // CAS guard - current tip of merged entity
  "restore_from_ver": 3,          // Optional: restore from specific version
  "note": "Wrongful merge"        // Optional: reason for unmerge
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `expect_tip` | Yes | CAS guard - must match current merged entity tip |
| `restore_from_ver` | No | Version to restore from. Default: prev (last real version) |
| `note` | No | Reason for unmerge |
| `skip_sync` | No | Skip index-sync callback (internal use) |

### Success Response (201)

```json
{
  "entity_id": "IIENTITY...",
  "restored_from_ver": 3,
  "new_ver": 5,
  "new_manifest_cid": "bafyrei...",
  "was_merged_into": "IIENTITY_TARGET..."
}
```

### Error Responses

**400 - Not Merged:**
```json
{
  "error": "VALIDATION_ERROR",
  "message": "Entity is not merged (schema: arke/entity@v1)"
}
```

**409 - CAS Failure:**
```json
{
  "error": "CAS_FAILURE",
  "message": "Expected tip bafyrei... but found bafyrei..."
}
```

**404 - Version Not Found:**
```json
{
  "error": "NOT_FOUND",
  "message": "Version 3 not found in entity history"
}
```

### What Unmerge Does

1. **Validates** entity is currently merged (has `arke/entity-merged@v1` schema)
2. **Finds restore point** - uses `prev` link or walks chain for specific version
3. **Creates new version** with restored data (type, label, components, relationships)
4. **Does NOT modify target** - target keeps all merged components

### What Gets Restored

| Component | Behavior |
|-----------|----------|
| Type, Label, Description | ✅ Restored from prev manifest |
| Properties | ✅ Restored (CID reference) |
| Relationships | ✅ Restored (CID reference) |
| File components | ✅ Restored (CID references) |
| source_pis | ✅ Restored |

### What Happens to Target

The target entity (that absorbed the source during merge) is **not modified**:
- Target keeps the merged components
- Target keeps the relationships that were transferred
- This may result in relationships existing on both entities (acceptable)

### History Preservation

The merge redirect remains in the version chain:
```
v4 (restored entity)
 └─prev─→ v3 (merge redirect)
           └─prev─→ v2 (last real version)
                     └─prev─→ v1
```

### Client Retry Pattern

```typescript
async function unmergeWithRetry(entityId: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const entity = await getEntity(entityId);

    // Verify entity is merged
    if (entity.status !== 'merged') {
      throw new Error('Entity is not merged');
    }

    try {
      return await unmergeEntity(entityId, entity.prev_cid);
    } catch (e) {
      if (e.status === 409 && e.error === 'CAS_FAILURE') {
        // Entity was modified, retry with fresh tip
        continue;
      }
      throw e;
    }
  }
}
```

---

## Best Practices

### Before Merging

1. **Verify duplicates** - Ensure entities truly represent the same real-world entity
2. **Check components** - Review what data will be merged
3. **Consider direction** - Which entity should be canonical?

### Choosing Merge Direction

Merge the **newer/less important** entity INTO the **older/more canonical** one:

| Scenario | Direction |
|----------|-----------|
| Duplicate detection | Newer into older |
| Alias consolidation | Alias into primary |
| Data quality | Lower quality into higher |
| More relationships | Fewer into more |

### Handling Conflicts

For 409 responses:

1. **CAS failure** - Re-fetch entity, retry with new tip
2. **Tiebreaker loss** - Other party won, no action needed
3. **Target merged** - Retry merge into the new target

### Client Retry Pattern

```typescript
async function mergeWithRetry(sourceId, targetId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const source = await getEntity(sourceId);

    // Skip if already merged
    if (source.status === 'merged') {
      return { alreadyMerged: true, mergedInto: source.merged_into };
    }

    try {
      return await mergeEntity(sourceId, targetId, source.manifest_cid);
    } catch (e) {
      if (e.status === 409 && e.message.includes('Target merged')) {
        // Follow the chain
        const target = await getEntity(targetId);
        if (target.status === 'merged') {
          targetId = target.merged_into;
          continue;
        }
      }
      if (e.status === 409 && e.conflict) {
        // Lost tiebreaker - other party won
        return { conflict: true, winner: e.winner_target };
      }
      if (i === maxRetries - 1) throw e;
      await sleep(100 * Math.pow(2, i)); // Exponential backoff
    }
  }
}
```

---

## Implementation Reference

### Files

| File | Description |
|------|-------------|
| `src/services/entity-kg-ops.ts` | Core merge/unmerge logic |
| `src/types/entity-manifest.ts` | Merge/unmerge request/response types |
| `src/handlers/entities-kg.ts` | HTTP handlers |

### Functions

| Function | Description |
|----------|-------------|
| `mergeEntityKG()` | Main merge operation |
| `unmergeEntityKG()` | Main unmerge operation |
| `mergeComponents()` | Component merge logic |
| `resolveEntityChain()` | Follow redirect chain |
| `findVersionInHistory()` | Walk prev chain to find version |

### Tests

**Current Tests (Eidos Schema):**
- `tests/eidos/phase2-test-suite.ts` - Comprehensive merge/unmerge tests with component merge rules

**Archived Tests (Legacy):**
- `tests/archive/entities-kg/merge-components-test.ts` - Component merge tests (37) - Legacy
- `tests/archive/entities-kg/merge-race-test.ts` - Mutual merge race tests - Legacy
- `tests/archive/entities-kg/chain-race-test.ts` - Chain formation tests - Legacy
- `tests/archive/entities-kg/retry-merge-test.ts` - Retry mechanism tests - Legacy
- `tests/archive/entities-kg/unmerge-test.ts` - Unmerge functionality tests - Legacy

See [`tests/README.md`](../tests/README.md) for current test documentation.
