import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { TipWriteRaceError } from '../../utils/errors';
import { Eidos, link } from '../../types/eidos';
import {
  RelationshipsComponent,
  Relationship,
  addRelationship,
} from '../../types/relationships';

/**
 * Create bidirectional relationships between entity and its parent PI
 *
 * When an entity is created with parent_pi (provenance):
 * 1. Add "extracted_from" relationship to entity's relationships component
 * 2. Add "created" relationship to PI's relationships component
 *
 * This function is called automatically during entity creation (Phase 3)
 * and should not fail the creation if relationship updates fail.
 *
 * Features:
 * - Bidirectional semantic relationships
 * - Automatic retry on race conditions
 * - Non-blocking: logs errors but doesn't throw
 * - Flexible predicates (any string allowed)
 */
export async function createParentChildRelationships(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string,
  entityType: string,
  entityLabel: string | undefined,
  parentPi: string,
  parentType: string = 'PI',
  parentLabel: string | undefined,
  maxRetries: number = 3
): Promise<void> {
  // ==========================================================================
  // STEP 1: ADD "extracted_from" RELATIONSHIP TO ENTITY
  // ==========================================================================
  try {
    await addRelationshipToEntity(
      ipfs,
      tipSvc,
      entityId,
      {
        predicate: 'extracted_from',
        target_type: 'pi',
        target_id: parentPi,
        target_label: parentLabel || parentPi,
        target_entity_type: parentType,
      },
      `Added provenance relationship to ${parentPi}`,
      maxRetries
    );
  } catch (error) {
    console.error(
      `[RELATIONSHIPS] Failed to add extracted_from relationship to entity ${entityId}:`,
      error
    );
  }

  // ==========================================================================
  // STEP 2: ADD "created" RELATIONSHIP TO PARENT PI
  // ==========================================================================
  try {
    await addRelationshipToEntity(
      ipfs,
      tipSvc,
      parentPi,
      {
        predicate: 'created',
        target_type: 'entity',
        target_id: entityId,
        target_label: entityLabel || entityId,
        target_entity_type: entityType,
      },
      `Added created relationship to entity ${entityId}`,
      maxRetries
    );
  } catch (error) {
    console.error(
      `[RELATIONSHIPS] Failed to add created relationship to parent ${parentPi}:`,
      error
    );
  }
}

/**
 * Helper: Add a single relationship to an entity's relationships component
 *
 * This function:
 * 1. Reads entity's current tip
 * 2. Fetches relationships component (or creates new one)
 * 3. Adds new relationship using addRelationship helper
 * 4. Updates entity with new relationships component
 * 5. Retries on race conditions
 */
async function addRelationshipToEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string,
  relationship: Relationship,
  note: string,
  maxRetries: number
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Read current tip
      const currentTip = await tipSvc.readTip(entityId);
      const manifest = (await ipfs.dagGet(currentTip)) as Eidos;

      // Fetch existing relationships component or create new one
      let relationshipsComponent: RelationshipsComponent;

      if (manifest.components.relationships) {
        const existingCid = manifest.components.relationships['/'];
        relationshipsComponent = (await ipfs.dagGet(existingCid)) as RelationshipsComponent;
      } else {
        // Create new relationships component
        relationshipsComponent = {
          schema: 'arke/relationships@v1',
          relationships: [],
          timestamp: new Date().toISOString(),
        };
      }

      // Add new relationship (uses helper from relationships.ts)
      const updatedComponent = addRelationship(relationshipsComponent, relationship);

      // Store updated component
      const newRelsCid = await ipfs.dagPut(updatedComponent);

      // Update manifest with new relationships component
      const now = new Date().toISOString();
      const updatedManifest: Eidos = {
        ...manifest,
        ver: manifest.ver + 1,
        ts: now,
        prev: link(currentTip),
        components: {
          ...manifest.components,
          relationships: link(newRelsCid),
        },
        note,
      };

      const newTip = await ipfs.dagPut(updatedManifest);
      await tipSvc.writeTipAtomic(entityId, newTip, currentTip);

      console.log(
        `[RELATIONSHIPS] Added ${relationship.predicate} relationship to ${entityId} → ${relationship.target_id}`
      );
      return; // Success
    } catch (error) {
      if (error instanceof TipWriteRaceError && attempt < maxRetries - 1) {
        // Race detected, retry with exponential backoff
        const delay = 50 * (2 ** attempt);
        console.log(
          `[RELATIONSHIPS] Race detected for ${entityId}, retrying in ${delay}ms (attempt ${attempt + 2}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}
