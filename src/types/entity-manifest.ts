import { z } from 'zod';
import { IPLDLinkSchema } from './manifest';

/**
 * Entity ID regex that accepts both main and test networks:
 * - Main network: Standard ULID (26 chars, Crockford Base32)
 * - Test network: 'II' prefix + 24 chars
 */
const ENTITY_ID_REGEX = /^(?:II[0-9A-HJKMNP-TV-Z]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export const EntityIdSchema = z.string().regex(ENTITY_ID_REGEX, 'Invalid entity ID');

// =============================================================================
// Entity Manifest Schema (arke/entity@v1)
// =============================================================================

export const EntityManifestV1Schema = z.object({
  schema: z.literal('arke/entity@v1'),

  // Identity (immutable after creation)
  entity_id: EntityIdSchema,
  created_by_pi: EntityIdSchema,
  created_at: z.string().datetime(),

  // Version chain
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema.nullable(),

  // Core identity (lightweight summary)
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),

  // Components (CID references)
  components: z.object({
    properties: IPLDLinkSchema.optional(),
    relationships: IPLDLinkSchema.optional(),
  }),

  // Source tracking (which PIs reference this entity)
  source_pis: z.array(EntityIdSchema),

  // Version note
  note: z.string().optional(),
});

export type EntityManifestV1 = z.infer<typeof EntityManifestV1Schema>;

// =============================================================================
// Merged Entity Schema (redirect version - no deletions!)
// =============================================================================

export const EntityMergedV1Schema = z.object({
  schema: z.literal('arke/entity-merged@v1'),

  // Identity (preserved from original)
  entity_id: EntityIdSchema,

  // Version chain (continues from original - preserves history!)
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema, // Links to last real version (not nullable - must have history)

  // Redirect target
  merged_into: EntityIdSchema,

  // Version note
  note: z.string().optional(),
});

export type EntityMergedV1 = z.infer<typeof EntityMergedV1Schema>;

// =============================================================================
// Lightweight Entity (for context loading)
// =============================================================================

export interface LightweightEntity {
  entity_id: string;
  type: string;
  label: string;
  description?: string;
}

export function toLightweight(manifest: EntityManifestV1): LightweightEntity {
  return {
    entity_id: manifest.entity_id,
    type: manifest.type,
    label: manifest.label,
    description: manifest.description,
  };
}

// =============================================================================
// API Request/Response Types
// =============================================================================

export const CreateEntityKGRequestSchema = z.object({
  entity_id: EntityIdSchema.optional(), // Server generates if omitted
  created_by_pi: EntityIdSchema, // Required: which PI extracted this
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  properties: z.record(z.any()).optional(), // Initial properties
  relationships: z
    .array(
      z.object({
        predicate: z.string().min(1),
        target_type: z.enum(['pi', 'entity']),
        target_id: EntityIdSchema,
        target_label: z.string().min(1),
        target_entity_type: z.string().optional(),
        properties: z.record(z.any()).optional(),
      })
    )
    .optional(),
  source_pis: z.array(EntityIdSchema).optional(), // Additional source PIs
  note: z.string().optional(),
});

export type CreateEntityKGRequest = z.infer<typeof CreateEntityKGRequestSchema>;

export interface CreateEntityKGResponse {
  entity_id: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

export const AppendEntityVersionRequestSchema = z.object({
  expect_tip: z.string().min(1), // CAS guard
  type: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  properties: z.record(z.any()).optional(), // Replace all properties
  relationships: z
    .array(
      z.object({
        predicate: z.string().min(1),
        target_type: z.enum(['pi', 'entity']),
        target_id: EntityIdSchema,
        target_label: z.string().min(1),
        target_entity_type: z.string().optional(),
        properties: z.record(z.any()).optional(),
      })
    )
    .optional(), // Replace all relationships
  source_pis_add: z.array(EntityIdSchema).optional(),
  source_pis_remove: z.array(EntityIdSchema).optional(),
  note: z.string().optional(),
});

export type AppendEntityVersionRequest = z.infer<typeof AppendEntityVersionRequestSchema>;

export interface AppendEntityVersionResponse {
  entity_id: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

// Merge request - creates redirect version
export const MergeEntityRequestSchema = z.object({
  expect_tip: z.string().min(1), // CAS guard for source entity
  merge_into: EntityIdSchema, // Target entity ID
  note: z.string().optional(),
});

export type MergeEntityRequest = z.infer<typeof MergeEntityRequestSchema>;

// Success response - merge completed
export interface MergeEntityResponse {
  source_entity_id: string;
  merged_into: string;
  source_new_ver: number; // Version of redirect
  source_manifest_cid: string;
  target_new_ver: number; // Version of target (with updated source_pis)
  target_manifest_cid: string;
  conflict_resolved?: boolean; // True if cycle was detected and we won tiebreaker
}

// Conflict response - caller lost tiebreaker in mutual merge race
export interface MergeConflictResponse {
  conflict: true;
  message: string;
  winner_source: string; // Entity that won (became redirect)
  winner_target: string; // Entity that absorbed winner
}

// Get entity response
export interface GetEntityKGResponse {
  entity_id: string;
  ver: number;
  ts: string;
  manifest_cid: string;
  prev_cid: string | null;
  type: string;
  label: string;
  description?: string;
  components: {
    properties?: string;
    relationships?: string;
  };
  source_pis: string[];
  note?: string;
}

// Merged entity redirect response
export interface GetEntityMergedResponse {
  status: 'merged';
  entity_id: string;
  merged_into: string;
  merged_at: string;
  prev_cid: string; // Can follow to see history
}
