/**
 * Unified Eidos Operations
 *
 * This module exports all Eidos entity operations for use by HTTP handlers.
 * Eidos (arke/eidos@v1) is the unified schema that replaces separate
 * PI manifests (arke/manifest@v1) and Entity manifests (arke/entity@v1).
 *
 * All entities now have a required `type` field:
 * - "PI" for documents (backward compatible)
 * - "person", "place", "organization", etc. for knowledge graph entities
 *
 * Core features:
 * - Versioned IPLD manifests with CAS protection
 * - Dual relationship systems (hierarchical tree + semantic graph)
 * - Component storage (properties, relationships, files)
 * - Merge/unmerge with tombstone redirects
 * - Network isolation (main vs test)
 */

// Core helpers
export {
  resolveEntityChain,
  mergeComponents,
  componentsToLinks,
  linksToComponents,
} from './eidos/core';
export type { ResolvedEntity } from './eidos/core';

// Create
export { createEntity } from './eidos/create';

// Read
export {
  getEntity,
  getEntityLightweight,
  getEntitiesLightweight,
} from './eidos/get';

// Update
export { appendVersion } from './eidos/update';

// Hierarchy (tree structure: parent-child relationships)
export { updateHierarchy } from './eidos/hierarchy';

// Merge/Unmerge
export { mergeEntities } from './eidos/merge';
export { unmergeEntity } from './eidos/unmerge';

// Delete/Undelete (soft delete with tombstone)
export { deleteEntity } from './eidos/delete';
export { undeleteEntity } from './eidos/undelete';

// Relationships (semantic graph: automatic bidirectional creation)
export { createParentChildRelationships } from './eidos/relationships';
