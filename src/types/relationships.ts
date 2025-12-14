import { z } from 'zod';

/**
 * Entity ID regex that accepts both main and test networks
 */
const ENTITY_ID_REGEX = /^(?:II[0-9A-HJKMNP-TV-Z]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export const EntityIdSchema = z.string().regex(ENTITY_ID_REGEX, 'Invalid entity ID');

// =============================================================================
// Relationships Component Schema (arke/relationships@v1)
// =============================================================================

/**
 * Relationship - A single edge in the semantic graph
 *
 * Represents a typed, directional relationship from the source entity
 * to a target entity or PI.
 *
 * Predicates are completely flexible - use any string that makes sense
 * for your domain (e.g., "created", "mentions", "authored_by", "located_in", etc.)
 */
export const RelationshipSchema = z.object({
  predicate: z.string().min(1), // Any string - completely flexible
  target_type: z.enum(['pi', 'entity']),
  target_id: EntityIdSchema,
  target_label: z.string().min(1), // For display (e.g., "Alice Austen")
  target_entity_type: z.string().optional(), // e.g., "person", "place" (if target is entity)
  properties: z.record(z.any()).optional(), // Optional metadata on the edge
});

export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * RelationshipsComponent - Semantic graph relationships
 *
 * Stored as dag-json in components.relationships
 * Supports many-to-many, typed relationships with metadata
 *
 * Example:
 * {
 *   "schema": "arke/relationships@v1",
 *   "relationships": [
 *     { "predicate": "authored_by", "target_type": "entity", "target_id": "person_456", "target_label": "Alice Austen" },
 *     { "predicate": "mentions", "target_type": "entity", "target_id": "place_789", "target_label": "Staten Island" }
 *   ],
 *   "timestamp": "2025-12-13T00:00:00.000Z"
 * }
 */
export const RelationshipsComponentSchema = z.object({
  schema: z.literal('arke/relationships@v1'),
  relationships: z.array(RelationshipSchema),
  timestamp: z.string().datetime(), // ISO 8601
  note: z.string().optional(),
});

export type RelationshipsComponent = z.infer<typeof RelationshipsComponentSchema>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a new relationships component
 */
export function createRelationshipsComponent(
  relationships: Relationship[],
  note?: string
): RelationshipsComponent {
  return {
    schema: 'arke/relationships@v1',
    relationships,
    timestamp: new Date().toISOString(),
    note,
  };
}

/**
 * Add a relationship to an existing component
 */
export function addRelationship(
  component: RelationshipsComponent,
  relationship: Relationship
): RelationshipsComponent {
  return {
    ...component,
    relationships: [...component.relationships, relationship],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Remove a relationship from an existing component
 */
export function removeRelationship(
  component: RelationshipsComponent,
  predicate: string,
  targetId: string
): RelationshipsComponent {
  return {
    ...component,
    relationships: component.relationships.filter(
      (r) => !(r.predicate === predicate && r.target_id === targetId)
    ),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Find relationships by predicate
 */
export function findRelationshipsByPredicate(
  component: RelationshipsComponent,
  predicate: string
): Relationship[] {
  return component.relationships.filter((r) => r.predicate === predicate);
}

/**
 * Find relationships by target
 */
export function findRelationshipsByTarget(
  component: RelationshipsComponent,
  targetId: string
): Relationship[] {
  return component.relationships.filter((r) => r.target_id === targetId);
}

/**
 * Check if a relationship exists
 */
export function hasRelationship(
  component: RelationshipsComponent,
  predicate: string,
  targetId: string
): boolean {
  return component.relationships.some(
    (r) => r.predicate === predicate && r.target_id === targetId
  );
}
