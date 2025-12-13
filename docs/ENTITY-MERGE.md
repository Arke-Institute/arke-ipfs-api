# Entity Merge Documentation

This document describes how entity merging works in the Arke IPFS API service, including the atomic merge protocol, component merging rules, and race condition handling.

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

### Source PIs Merge

**Rule:** Union of arrays (deduplicated)

```
A.source_pis: [PI_1, PI_2]
B.source_pis: [PI_2, PI_3]

Result: [PI_1, PI_2, PI_3]
```

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

While there's no direct "unmerge" operation, you can restore a merged entity:

### Method 1: Create New Version from History

```typescript
// 1. Get the merged entity
const merged = await getEntity(mergedEntityId);

// 2. Get the previous (real) version
const prevCid = merged.prev_cid;
const prevManifest = await ipfs.dagGet(prevCid);

// 3. Create a new version restoring the entity
await appendEntityVersion(mergedEntityId, {
  expect_tip: merged.manifest_cid,
  type: prevManifest.type,
  label: prevManifest.label,
  // ... restore other fields
  note: "Unmerged - restored from history"
});
```

### Method 2: Manual Restoration

The admin can manually:
1. Read the `prev` chain to find last real version
2. Create a new `arke/entity@v1` manifest with restored data
3. Write to entity tip

### History Preservation

The merge redirect remains in the version chain:
```
v4 (restored entity)
 └─prev─→ v3 (merge redirect)
           └─prev─→ v2 (last real version)
                     └─prev─→ v1
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
| `src/services/entity-kg-ops.ts` | Core merge logic |
| `src/types/entity-manifest.ts` | Merge request/response types |
| `src/handlers/entities-kg.ts` | HTTP handler |

### Functions

| Function | Description |
|----------|-------------|
| `mergeEntityKG()` | Main merge operation |
| `mergeComponents()` | Component merge logic |
| `resolveEntityChain()` | Follow redirect chain |

### Tests

| File | Description |
|------|-------------|
| `tests/entities-kg/merge-components-test.ts` | Component merge tests (37) |
| `tests/entities-kg/merge-race-test.ts` | Mutual merge race tests |
| `tests/entities-kg/chain-race-test.ts` | Chain formation tests |
| `tests/entities-kg/retry-merge-test.ts` | Retry mechanism tests |
