import { z } from 'zod';
import { EntityIdSchema } from './entity-manifest';

// =============================================================================
// Relationships Component Schema (shared by PIs and Entities)
// =============================================================================

export const RelationshipSchema = z.object({
  predicate: z.string().min(1),
  target_type: z.enum(['pi', 'entity']),
  target_id: EntityIdSchema,
  target_label: z.string().min(1),
  target_entity_type: z.string().optional(),
  properties: z.record(z.any()).optional(),
});

export type Relationship = z.infer<typeof RelationshipSchema>;

export const RelationshipsComponentSchema = z.object({
  schema: z.literal('arke/relationships@v1'),
  relationships: z.array(RelationshipSchema),
  timestamp: z.string().datetime(),
  note: z.string().optional(),
});

export type RelationshipsComponent = z.infer<typeof RelationshipsComponentSchema>;
