# Eidos Schema Migration Scripts (Historical)

This folder contains historical migration scripts related to the Eidos schema evolution. These scripts were used during development and testing but have been **superseded by the unified migration script** in the parent directory.

## Files

### Investigation Tools
- **investigate-schemas.ts** - Tool to investigate entity schemas in the database

### Early Migration Attempts (arke/manifest@v1 → arke/eidos@v1)
- **migrate-to-eidos.ts** - Initial migration approach
- **migrate-to-eidos-batch.ts** - Batch migration attempt
- **migrate-to-eidos-sequential.ts** - Sequential migration attempt
- **migrate-via-api.ts** - API-based migration attempt

### Field Rename Migration
- **rename-hierarchy-fields.ts** - Initial field rename script (superseded by unified-field-migration.ts)

## Current Production Migration

**The active migration script is now:** `../unified-field-migration.ts`

This unified script handles:
1. Schema migration (arke/manifest@v1 → arke/eidos@v1)
2. Field cleanup and renaming
3. Data recovery from version history

## Note

These scripts are kept for historical reference and should not be used for new migrations.
