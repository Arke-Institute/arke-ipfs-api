# Migration Scripts

This folder contains migration scripts used to upgrade the Arke IPFS API.

## Current Active Migrations

### `unified-field-migration.ts` (ACTIVE)
The current production migration script that handles:
1. Schema migration (arke/manifest@v1 → arke/eidos@v1)
2. Field cleanup and renaming
3. Data recovery from version history

**Latest run (2025-12-14):**
- **Purpose**: Recover lost parent relationship data and finalize field cleanup
- **Status**: ✅ Completed (367 entities recovered, 2,918 already correct, 0 failures)
- **Results**:
  - Recovered `parent_pi` values from version history for entities that lost data
  - All entities now have correct `source_pi: null` and proper `parent_pi` values
  - Backup saved to `/tmp/unified-migration-backup.json`

## Completed Historical Migrations

### 2025-12-13: Sharding Algorithm Fix (`migrate-sharding.ts`)
- **Purpose**: Fixed sharding to use last 4 chars instead of first 4 chars of ULID
- **Status**: ✅ Completed (3,279 files migrated)
- **Details**: See inline documentation in the script
- **Impact**: Uniform distribution across 1,048,576 possible shard combinations

## Historical Scripts

The `eidos-schema-migrations/` subfolder contains older migration attempts and investigation tools that have been superseded by the unified script. See the README in that folder for details.

## Migration Principles

- **Version preservation**: All migrations create new versions rather than rewriting
- **Data recovery**: Migrations can recover from version history when needed
- **Atomic operations**: Each entity migration is independent
- **Backup**: All migrations create backup files before making changes
- **Dry-run support**: Test migrations with `--dry-run` before applying

## Migration Endpoints

The following endpoints support migrations:

- `POST /migrate/:pi` - Migrate single entity to `arke/eidos@v1`
- `POST /migrate/batch` - Migrate multiple entities in one request (up to 100)

See `src/handlers/migrate.ts` for implementation.

## Running Migrations

**Always:**
1. Deploy latest code to production first
2. Run with `--dry-run` to preview changes
3. Test with `--sample N` on small batch
4. Review results before running `--all`
5. Keep backup files until verification complete

**Example:**
```bash
# Preview
npx tsx scripts/migrations/unified-field-migration.ts --dry-run

# Test sample
npx tsx scripts/migrations/unified-field-migration.ts --sample 10 --all

# Full migration
IPFS_SERVER_API_URL=https://ipfs-api.arke.institute \
API_ENDPOINT=https://ipfs-api.arke.institute \
IPFS_API_URL=https://ipfs-api.arke.institute/api/v0 \
npx tsx scripts/migrations/unified-field-migration.ts --all
```
