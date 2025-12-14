# Arke IPFS API - Test Suite

This directory contains integration tests for the Arke IPFS API service.

## Current Tests (Eidos Schema)

**Directory:** `tests/eidos/`

These are the **CURRENT** and **MAINTAINED** test suites using the unified `arke/eidos@v1` schema.

### Available Test Suites

| File | Description | Run Command |
|------|-------------|-------------|
| `phase1-test-suite.ts` | Basic CRUD operations (create, read, update, list) | `npx tsx tests/eidos/phase1-test-suite.ts` |
| `phase2-test-suite.ts` | Merge/unmerge operations and component merge rules | `npx tsx tests/eidos/phase2-test-suite.ts` |
| `phase3-test-suite.ts` | Properties, relationships, and hierarchy | `npx tsx tests/eidos/phase3-test-suite.ts` |
| `delete-test-suite.ts` | Delete/undelete operations | `npx tsx tests/eidos/delete-test-suite.ts` |
| `race-test-suite.ts` | Concurrent update race conditions | `npx tsx tests/eidos/race-test-suite.ts` |
| `hierarchy-race-test-suite.ts` | Concurrent hierarchy update race conditions | `npx tsx tests/eidos/hierarchy-race-test-suite.ts` |

### Prerequisites

Before running tests:

1. **Start the dev server:**
   ```bash
   npm run dev
   ```

2. **Verify server is running:**
   ```bash
   curl http://localhost:8787/
   # Should return: {"service":"arke-ipfs-api","version":"0.1.0","status":"ok"}
   ```

3. **Run tests:**
   ```bash
   npx tsx tests/eidos/phase1-test-suite.ts
   ```

### Test Configuration

All Eidos tests use:
- **API Endpoint:** `http://localhost:8787` (configurable via `API_ENDPOINT` env var)
- **Network:** `test` (uses `II` prefix for entity IDs)
- **Network Header:** `X-Arke-Network: test`

### Understanding Test Output

Tests use color-coded output:
- 🟢 **Green (PASS)**: Test passed successfully
- 🔴 **Red (FAIL)**: Test failed with error details
- 🔵 **Blue**: Section headers
- 🟣 **Magenta**: Test suite titles
- 🟡 **Cyan**: Informational messages

Example success output:
```
✅ PASS: Entity created successfully
✅ PASS: Entity version incremented to v2
✅ PASS: Components merged correctly

Total Tests:  17
Passed:       17 ✅
Failed:       0 ❌
Success Rate: 100.0%
```

---

## Archived Tests (Legacy)

**Directory:** `tests/archive/`

These test suites are **DEPRECATED** and use legacy schemas that have been replaced by the unified Eidos schema:

### Archived Directories

| Directory | Schema | Status | Notes |
|-----------|--------|--------|-------|
| `archive/entities-kg/` | `arke/entity@v1` | ❌ Deprecated | Legacy entity-KG tests, replaced by Eidos |
| `archive/race-conditions/` | `arke/manifest@v1` | ❌ Deprecated | Legacy PI race condition tests |
| `archive/integration/` | Mixed legacy | ❌ Deprecated | Old integration tests |

**⚠️ DO NOT USE ARCHIVED TESTS** - They test against schemas that no longer exist in the codebase. All entities have been migrated to `arke/eidos@v1`.

### Why Archived?

- **Schema Migration**: All entities migrated from `arke/manifest@v1` and `arke/entity@v1` to unified `arke/eidos@v1`
- **Feature Consolidation**: Eidos schema combines PI and entity features into one unified system
- **Simplified Codebase**: Single schema reduces complexity and maintenance burden

---

## Writing New Tests

When adding new test coverage:

1. **Add tests to `tests/eidos/` directory** - This is the only active test directory
2. **Use the Eidos schema** (`arke/eidos@v1`) - All new tests should target this schema
3. **Follow existing patterns** - See `phase1-test-suite.ts` for structure and style
4. **Test against `X-Arke-Network: test`** - Use test network to avoid polluting main data
5. **Include comprehensive error cases** - Test both happy paths and error conditions

### Test Template

```typescript
#!/usr/bin/env tsx
/**
 * My New Test Suite
 *
 * Description of what this test suite covers
 *
 * Run: npx tsx tests/eidos/my-new-test-suite.ts
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = 'test';

// ... test implementation
```

---

## Schema Documentation

For detailed schema specifications, see:
- [`SCHEMA.md`](../SCHEMA.md) - Complete schema documentation
- [`docs/ENTITY-SCHEMA.md`](../docs/ENTITY-SCHEMA.md) - Entity schema details
- [`docs/ENTITY-MERGE.md`](../docs/ENTITY-MERGE.md) - Merge operation documentation
- [`API_SPEC.md`](../API_SPEC.md) - API endpoint specifications

---

## Troubleshooting

### Tests Fail with "fetch failed" or "ECONNREFUSED"

**Solution:** Start the dev server first:
```bash
npm run dev
```

Wait for startup message, then run tests in a separate terminal.

### Tests Fail with 400/409 Errors

**Common causes:**
- **400 VALIDATION_ERROR**: Check request body matches schema
- **409 CAS_FAILURE**: Concurrent modification - tests may need retry logic
- **409 CONFLICT**: Entity ID already exists - use unique IDs per test run

### Network Isolation Issues

Make sure all test requests include the network header:
```typescript
headers: {
  'X-Arke-Network': 'test'
}
```

Test entities should have `II` prefix (e.g., `IIAK75HQQXNTDG7BBP7PS9AWY`)

---

## Migration History

- **Oct 2024**: Initial `arke/manifest@v1` schema for PIs
- **Nov 2024**: Added `arke/entity@v1` schema for knowledge graph
- **Dec 2024**: Migrated all 3,285 entities to unified `arke/eidos@v1` schema
- **Dec 2024**: Archived legacy test suites, consolidated to Eidos tests

All production entities now use `arke/eidos@v1`. Legacy schemas exist only in version history.
