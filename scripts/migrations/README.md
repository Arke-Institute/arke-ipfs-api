# Migration Scripts

This folder contains historical migration scripts used to upgrade the Arke IPFS API.

## Completed Migrations

### 2025-12-13: Sharding Algorithm Fix (`migrate-sharding.ts`)
- **Purpose**: Fixed sharding to use last 4 chars instead of first 4 chars of ULID
- **Status**: ✅ Completed (3,279 files migrated)
- **Details**: See inline documentation in the script

### 2025-12-14: Schema Migration to Eidos (`migrate-to-eidos-sequential.ts`)
- **Purpose**: Migrated all entities from `arke/manifest@v1` and `arke/entity@v1` to unified `arke/eidos@v1` schema
- **Status**: ✅ Completed (955 newly migrated, 2,330 already migrated, 0 failures)
- **Method**: Sequential one-by-one migration using production API
- **Results**: All 3,285 main network entities now on `arke/eidos@v1`
- **Details**:
  - Adds `id`, `type`, `created_at` fields
  - Preserves all previous version history
  - Progress tracked in `.migration-progress.json`

## Other Migration Scripts (Not Used)

### `migrate-to-eidos-batch.ts`
- Attempted batch migration via `/migrate/batch` endpoint
- Abandoned due to connection errors with local dev worker
- Replaced by sequential approach

### `migrate-to-eidos.ts`
- Initial direct IPFS approach
- Abandoned in favor of API-based migration

### `migrate-via-api.ts`
- Early API-based exploration script
- Replaced by sequential script

## Migration Endpoints

The following endpoints were added to support migrations:

- `POST /migrate/:pi` - Migrate single entity to `arke/eidos@v1`
- `POST /migrate/batch` - Migrate multiple entities in one request (up to 100)

See `src/handlers/migrate.ts` for implementation.

## Notes

- All migrations preserve version history
- Migrations create new versions rather than rewriting existing data
- The `.migration-progress.json` file tracks sequential migration progress
- Always deploy to production before running migrations on real data
