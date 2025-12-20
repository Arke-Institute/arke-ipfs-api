import { z } from 'zod';

/**
 * Entity ID regex that accepts both main and test networks:
 * - Main network: Standard ULID (26 chars, Crockford Base32)
 * - Test network: 'II' prefix + 24 chars
 */
const ENTITY_ID_REGEX = /^(?:II[0-9A-HJKMNP-TV-Z]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export const EntityIdSchema = z.string().regex(ENTITY_ID_REGEX, 'Invalid entity ID');

/**
 * IPLD link format: { "/": "<cid>" }
 * Used for dag-json encoding to create proper DAG links
 */
export interface IPLDLink {
  '/': string;
}

export const IPLDLinkSchema = z.object({
  '/': z.string().min(1),
});

/**
 * Convert CID string to IPLD link object
 */
export function link(cid: string): IPLDLink {
  return { '/': cid };
}

// =============================================================================
// Eidos Manifest Schema (arke/eidos@v1) - UNIFIED SCHEMA
// =============================================================================

/**
 * Eidos - Unified manifest schema for both PIs and Entities
 *
 * Key features:
 * - Required `type` field: "PI", "person", "place", etc.
 * - Dual relationship systems: hierarchical tree + semantic graph
 * - Simplified merge tracking via `merged_entities` array
 * - Universal relationships (PIs can have relationships too)
 */
export const EidosSchema = z.object({
  schema: z.literal('arke/eidos@v1'),

  // Identity (immutable after creation)
  id: EntityIdSchema,
  type: z.string().min(1), // REQUIRED: "PI", "person", "place", etc.
  source_pi: EntityIdSchema.optional(), // Optional: provenance (which PI extracted this entity)
  created_at: z.string().datetime(),

  // Version chain
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema.nullable(),

  // Lightweight fields (optional, for efficient context loading)
  label: z.string().optional(),
  description: z.string().optional(),

  // Components (CID references)
  components: z
    .object({
      properties: IPLDLinkSchema.optional(),
      relationships: IPLDLinkSchema.optional(), // Semantic graph (arke/relationships@v1)
    })
    .catchall(IPLDLinkSchema), // Allow arbitrary file components

  // Hierarchical tree structure (optional, bidirectional)
  children_pi: z.array(EntityIdSchema).optional(), // Downward pointers
  parent_pi: EntityIdSchema.optional(), // Upward pointer (tree parent)

  // Merge tracking (entities that merged into this one)
  merged_entities: z.array(EntityIdSchema).optional(),

  // Version note
  note: z.string().optional(),
});

export type Eidos = z.infer<typeof EidosSchema>;

// =============================================================================
// Merged Entity Schema (redirect version - no deletions!)
// =============================================================================

export const EidosMergedSchema = z.object({
  schema: z.literal('arke/eidos-merged@v1'),

  // Identity (preserved from original)
  id: EntityIdSchema,
  type: z.string().min(1), // Preserved from original
  source_pi: EntityIdSchema.optional(), // Preserved: which PI extracted this entity (for lineage tracking)

  // Version chain (continues from original - preserves history!)
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema, // Links to last real version (not nullable - must have history)

  // Redirect target
  merged_into: EntityIdSchema,

  // Version note
  note: z.string().optional(),
});

export type EidosMerged = z.infer<typeof EidosMergedSchema>;

// =============================================================================
// Deleted Entity Schema (tombstone version - soft delete!)
// =============================================================================

export const EidosDeletedSchema = z.object({
  schema: z.literal('arke/eidos-deleted@v1'),

  // Identity (preserved from original)
  id: EntityIdSchema,
  type: z.string().min(1),

  // Version chain (continues from original - preserves history!)
  ver: z.number().int().positive(),
  ts: z.string().datetime(),
  prev: IPLDLinkSchema, // Links to last real version (required - not nullable)

  // Deletion metadata
  note: z.string().optional(), // Optional: deletion reason
});

export type EidosDeleted = z.infer<typeof EidosDeletedSchema>;

// =============================================================================
// Lightweight Entity (for context loading and batch fetching)
// =============================================================================

export interface LightweightEntity {
  id: string;
  type: string;
  label?: string;
  description?: string;
}

export function toLightweight(manifest: Eidos): LightweightEntity {
  return {
    id: manifest.id,
    type: manifest.type,
    label: manifest.label,
    description: manifest.description,
  };
}

// =============================================================================
// API Request/Response Types
// =============================================================================

// Create Entity Request
export const CreateEntityRequestSchema = z.object({
  id: EntityIdSchema.optional(), // Server generates if omitted
  type: z.string().min(1).optional(), // Defaults to "PI" if omitted (backward compat)
  label: z.string().optional(),
  description: z.string().optional(),

  // Components
  components: z.record(z.string()), // label → CID (will be converted to IPLDLink)

  // Hierarchical tree structure (optional)
  children_pi: z.array(EntityIdSchema).optional(),
  parent_pi: EntityIdSchema.optional(), // Set tree parent (also auto-updates parent's children_pi)

  // Provenance (optional)
  source_pi: EntityIdSchema.optional(), // Which PI extracted this entity

  // Initial properties and relationships (optional)
  properties: z.record(z.any()).optional(),
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

  note: z.string().optional(),
});

export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export interface CreateEntityResponse {
  id: string;
  type: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

// Append Version Request
export const AppendVersionRequestSchema = z.object({
  expect_tip: z.string().min(1), // CAS guard

  // Type, label, description can be updated
  type: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),

  // Components (partial updates)
  components: z.record(z.string()).optional(),
  components_remove: z.array(z.string()).optional(),

  // Hierarchical tree structure updates
  children_pi_add: z.array(EntityIdSchema).optional(),
  children_pi_remove: z.array(EntityIdSchema).optional(),

  // Properties and relationships (replace all)
  properties: z.record(z.any()).optional(),
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

  note: z.string().optional(),
});

export type AppendVersionRequest = z.infer<typeof AppendVersionRequestSchema>;

export interface AppendVersionResponse {
  id: string;
  type: string;
  ver: number;
  manifest_cid: string;
  tip: string;
}

// Get Entity Response
export interface GetEntityResponse {
  id: string;
  type: string;
  created_at: string;
  label?: string;
  description?: string;
  ver: number;
  ts: string;
  manifest_cid: string;
  prev_cid: string | null;
  components: {
    properties?: string;
    relationships?: string;
    [key: string]: string | undefined;
  };
  children_pi?: string[];
  parent_pi?: string;
  source_pi?: string;
  merged_entities?: string[];
  note?: string;
}

// Merged entity redirect response
export interface GetEntityMergedResponse {
  id: string;
  type: string;
  source_pi?: string; // Preserved for lineage tracking
  manifest_cid: string; // CID of the tombstone manifest
  merged: true;
  merged_into: string;
  merged_at: string;
  note?: string;
}

// Merge Entity Request
export const MergeEntityRequestSchema = z.object({
  target_id: EntityIdSchema, // Entity to merge into
  expect_target_tip: z.string().min(1), // CAS guard for target entity
  note: z.string().optional(),
  skip_sync: z.boolean().optional(), // Skip index-sync callback (for internal use)
});

export type MergeEntityRequest = z.infer<typeof MergeEntityRequestSchema>;

// Success response - merge completed
export interface MergeEntityResponse {
  source_id: string;
  target_id: string;
  target_ver: number;
  target_tip: string;
  tombstone_cid: string;
}

// Unmerge Entity Request
export const UnmergeEntityRequestSchema = z.object({
  target_id: EntityIdSchema, // Entity it was merged into
  expect_target_tip: z.string().min(1), // CAS guard for target entity
  note: z.string().optional(),
  skip_sync: z.boolean().optional(), // Skip index-sync callback (for internal use)
});

export type UnmergeEntityRequest = z.infer<typeof UnmergeEntityRequestSchema>;

// Success response - entity restored
export interface UnmergeEntityResponse {
  source_id: string;
  source_ver: number;
  source_tip: string;
  target_id: string;
  target_ver: number;
  target_tip: string;
}

// Delete Entity Request
export const DeleteEntityRequestSchema = z.object({
  expect_tip: z.string().min(1), // CAS guard
  note: z.string().optional(), // Optional: deletion reason
});

export type DeleteEntityRequest = z.infer<typeof DeleteEntityRequestSchema>;

// Delete Entity Response
export interface DeleteEntityResponse {
  id: string;
  deleted_ver: number;
  deleted_at: string;
  deleted_manifest_cid: string;
  previous_ver: number;
  prev_cid: string;
}

// Get Deleted Entity Response
export interface GetEntityDeletedResponse {
  id: string;
  type: string;
  manifest_cid: string;
  status: 'deleted';
  deleted_at: string;
  note?: string;
  prev_cid: string;
}

// Undelete Entity Request
export const UndeleteEntityRequestSchema = z.object({
  expect_tip: z.string().min(1), // CAS guard (current tombstone tip)
  note: z.string().optional(), // Optional: reason for restoration
});

export type UndeleteEntityRequest = z.infer<typeof UndeleteEntityRequestSchema>;

// Undelete Entity Response
export interface UndeleteEntityResponse {
  id: string;
  restored_ver: number;
  restored_from_ver: number;
  new_manifest_cid: string;
}

// Batch Lightweight Request
export const BatchLightweightRequestSchema = z.object({
  ids: z.array(EntityIdSchema).min(1).max(1000),
});

export type BatchLightweightRequest = z.infer<typeof BatchLightweightRequestSchema>;

export interface BatchLightweightResponse {
  entities: LightweightEntity[];
}

// List Entities Response
export interface ListEntitiesResponse {
  entities: EntityListItem[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface EntityListItem {
  id: string;
  tip: string;
  type?: string; // (if include_metadata)
  label?: string; // (if include_metadata)
  ver?: number; // (if include_metadata)
  ts?: string; // (if include_metadata)
  component_count?: number; // (if include_metadata)
  children_count?: number; // (if include_metadata)
}

// Version History
export interface VersionHistoryItem {
  ver: number;
  cid: string;
  ts: string;
  note?: string;
}

export interface ListVersionsResponse {
  items: VersionHistoryItem[];
  next_cursor: string | null;
}

// Resolve Response
export interface ResolveResponse {
  id: string;
  tip: string;
}

// Hierarchy (formerly relations) Request
export const UpdateHierarchyRequestSchema = z.object({
  parent_pi: EntityIdSchema,
  expect_tip: z.string().min(1), // CAS guard
  add_children: z.array(EntityIdSchema).max(100).optional(),
  remove_children: z.array(EntityIdSchema).max(100).optional(),
  note: z.string().optional(),
});

export type UpdateHierarchyRequest = z.infer<typeof UpdateHierarchyRequestSchema>;

export interface UpdateHierarchyResponse {
  parent_pi: string;
  parent_ver: number;
  parent_tip: string;
  children_updated: number;
  children_failed: number;
}
