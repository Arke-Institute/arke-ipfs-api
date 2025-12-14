# Archived Tests

This directory contains **DEPRECATED** test suites that are no longer maintained.

## ⚠️ DO NOT USE THESE TESTS

These tests are archived because they test against legacy schemas that have been replaced:

| Directory | Legacy Schema | Replaced By | Archived Date |
|-----------|---------------|-------------|---------------|
| `entities-kg/` | `arke/entity@v1` | `arke/eidos@v1` | December 2024 |
| `race-conditions/` | `arke/manifest@v1` | `arke/eidos@v1` | December 2024 |
| `integration/` | Mixed legacy | `arke/eidos@v1` | December 2024 |

## Schema Migration

In December 2024, all 3,285 entities were migrated from legacy schemas to the unified `arke/eidos@v1` schema:

- `arke/manifest@v1` (PIs) → `arke/eidos@v1`
- `arke/entity@v1` (Entities) → `arke/eidos@v1`

The legacy schemas no longer exist in the codebase, except in historical version chains.

## Current Tests

**For current, maintained test suites, see:**
- [`tests/eidos/`](../eidos/) - All active tests using `arke/eidos@v1` schema
- [`tests/README.md`](../README.md) - Test suite documentation

## Why Keep Archived Tests?

These tests are kept for reference purposes:
- Historical context for schema evolution
- Examples of legacy test patterns
- Reference for migration validation

**They should not be run or maintained.**

## Migration History

1. **October 2024**: Initial PI implementation with `arke/manifest@v1`
2. **November 2024**: Added knowledge graph with `arke/entity@v1`
3. **December 2024**: Unified migration to `arke/eidos@v1`
4. **December 2024**: Archived legacy test suites

---

**For all current testing needs, use the tests in [`tests/eidos/`](../eidos/)**
