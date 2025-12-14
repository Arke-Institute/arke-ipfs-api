import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { generatePi } from '../../utils/ulid';
import { validateCIDRecord } from '../../utils/cid';
import { ConflictError, TipWriteRaceError, CASError } from '../../utils/errors';
import {
  Eidos,
  link,
  CreateEntityRequest,
  CreateEntityResponse,
} from '../../types/eidos';
import {
  Network,
  validatePiMatchesNetwork,
  assertValidPi,
} from '../../types/network';
import { componentsToLinks } from './core';
import { createRelationshipsComponent } from '../../types/relationships';

/**
 * Create a new entity with the Eidos schema
 * Supports both PIs (type: "PI") and KG entities (type: "person", "place", etc.)
 *
 * Features:
 * - Auto-generates ID if not provided
 * - Auto-updates parent if parent_pi specified (tree structure)
 * - TODO: Auto-creates bidirectional relationships if source_pi specified (provenance)
 */
export async function createEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  req: CreateEntityRequest,
  network: Network = 'main'
): Promise<CreateEntityResponse> {
  // ==========================================================================
  // STEP 1: GENERATE OR VALIDATE ID
  // ==========================================================================
  let id: string;
  if (req.id || req.pi) {
    // Client-provided ID: validate format and network match
    const providedId = req.id || req.pi!;
    assertValidPi(providedId, network, 'id');
    validatePiMatchesNetwork(providedId, network);
    id = providedId;
  } else {
    // Server-generated ID for the appropriate network
    id = generatePi(network);
  }

  // ==========================================================================
  // STEP 2: VALIDATE NETWORK CONSISTENCY
  // ==========================================================================
  // Validate parent_pi matches network (tree parent - prevents cross-network relationships)
  if (req.parent_pi) {
    validatePiMatchesNetwork(req.parent_pi, network);
  }

  // Validate source_pi matches network (provenance)
  if (req.source_pi) {
    validatePiMatchesNetwork(req.source_pi, network);
  }

  // Validate all children_pi match network (prevents cross-network relationships)
  if (req.children_pi) {
    for (const childId of req.children_pi) {
      validatePiMatchesNetwork(childId, network);
    }
  }

  // ==========================================================================
  // STEP 3: CHECK FOR COLLISION
  // ==========================================================================
  const exists = await tipSvc.tipExists(id);
  if (exists) {
    throw new ConflictError('Entity', id);
  }

  // ==========================================================================
  // STEP 4: VALIDATE COMPONENT CIDs
  // ==========================================================================
  validateCIDRecord(req.components, 'components');

  // ==========================================================================
  // STEP 5: BUILD COMPONENTS
  // ==========================================================================
  const components = componentsToLinks(req.components);

  // Store properties if provided
  if (req.properties && Object.keys(req.properties).length > 0) {
    const propsCid = await ipfs.dagPut(req.properties);
    components.properties = link(propsCid);
  }

  // Store relationships if provided (with schema wrapper)
  if (req.relationships && req.relationships.length > 0) {
    const relsComponent = createRelationshipsComponent(req.relationships, req.note);
    const relsCid = await ipfs.dagPut(relsComponent);
    components.relationships = link(relsCid);
  }

  // ==========================================================================
  // STEP 6: BUILD MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();
  const type = req.type || 'PI'; // Default to "PI" for backward compatibility

  const manifest: Eidos = {
    schema: 'arke/eidos@v1',
    id,
    type,
    created_at: now,
    ver: 1,
    ts: now,
    prev: null, // v1 has no previous version
    components,
    ...(req.label && { label: req.label }),
    ...(req.description && { description: req.description }),
    ...(req.children_pi && { children_pi: req.children_pi }),
    ...(req.parent_pi && { parent_pi: req.parent_pi }),
    ...(req.source_pi && { source_pi: req.source_pi }),
    ...(req.note && { note: req.note }),
  };

  // ==========================================================================
  // STEP 7: STORE MANIFEST IN IPFS
  // ==========================================================================
  const manifestCid = await ipfs.dagPut(manifest);

  // ==========================================================================
  // STEP 8: WRITE .TIP FILE
  // ==========================================================================
  await tipSvc.writeTip(id, manifestCid);

  console.log(`[EIDOS] Created entity ${id} (type: ${type}, label: ${req.label || 'N/A'})`);

  // ==========================================================================
  // STEP 9: AUTO-UPDATE PARENT (if parent_pi provided)
  // ==========================================================================
  if (req.parent_pi) {
    // Higher retry limit for parent auto-update to handle high-concurrency scenarios
    // (e.g., 20 entities created simultaneously all updating same parent)
    const MAX_PARENT_UPDATE_RETRIES = 10;
    let parentUpdateSuccess = false;

    for (let attempt = 0; attempt < MAX_PARENT_UPDATE_RETRIES; attempt++) {
      try {
        const parentTip = await tipSvc.readTip(req.parent_pi);
        const parentManifest = (await ipfs.dagGet(parentTip)) as Eidos;

        // Add this entity to parent's children_pi (dedupe)
        const existingChildren = new Set(parentManifest.children_pi || []);
        if (!existingChildren.has(id)) {
          const newChildren = [...(parentManifest.children_pi || []), id];

          const updatedParentManifest: Eidos = {
            ...parentManifest,
            ver: parentManifest.ver + 1,
            ts: new Date().toISOString(),
            prev: link(parentTip),
            children_pi: newChildren,
            note: `Added child entity ${id}`,
          };

          const newParentTip = await ipfs.dagPut(updatedParentManifest);
          await tipSvc.writeTipAtomic(req.parent_pi, newParentTip, parentTip);

          console.log(`[HIERARCHY] Auto-updated parent ${req.parent_pi} to include child ${id}`);
          parentUpdateSuccess = true;
          break; // Success, exit retry loop
        } else {
          // Child already exists in parent, no update needed
          parentUpdateSuccess = true;
          break;
        }
      } catch (error) {
        // Retry on both CASError and TipWriteRaceError
        const isRetryableError = (error instanceof TipWriteRaceError) || (error instanceof CASError);

        if (isRetryableError && attempt < MAX_PARENT_UPDATE_RETRIES - 1) {
          // Race detected, retry with exponential backoff with jitter
          // Longer delays than other retry loops to spread out high-concurrency contention
          const baseDelay = 100 * (2 ** attempt);
          const jitter = Math.random() * baseDelay;
          const delay = baseDelay + jitter;
          const errorType = error instanceof TipWriteRaceError ? 'Tip write race' : 'CAS failure';
          console.log(`[HIERARCHY] ${errorType} for ${req.parent_pi}, retrying in ${delay.toFixed(0)}ms (attempt ${attempt + 2}/${MAX_PARENT_UPDATE_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        // Log but don't fail entity creation if parent update fails after retries
        console.error(`[HIERARCHY] Failed to update parent ${req.parent_pi} after ${attempt + 1} attempts:`, error);
        break;
      }
    }

    if (!parentUpdateSuccess) {
      console.warn(`[HIERARCHY] Entity ${id} created but parent ${req.parent_pi} update failed - parent's children_pi may be incomplete`);
    }
  }

  // ==========================================================================
  // STEP 10: TODO - AUTO-CREATE BIDIRECTIONAL RELATIONSHIPS (Phase 3)
  // ==========================================================================
  // TODO: If source_pi specified (provenance):
  //   1. Add "extracted_from" relationship to entity's relationships component
  //   2. Update PI's relationships component with "created" relationship
  // See eidos-relationships.ts for implementation

  // ==========================================================================
  // STEP 11: TODO - FIRE-AND-FORGET INDEX-SYNC EVENT (Phase 3)
  // ==========================================================================
  // TODO: Append create event to index-sync service
  // try {
  //   const eventCid = await appendEvent(backendURL, {
  //     type: 'create',
  //     id,
  //     ver: 1,
  //     tip_cid: manifestCid,
  //     entity_type: type,
  //   });
  //   console.log(`[EVENT] Appended create event for entity ${id}: ${eventCid}`);
  // } catch (error) {
  //   console.error(`[EVENT] Failed to append create event for entity ${id}:`, error);
  // }

  // ==========================================================================
  // STEP 12: RETURN RESPONSE
  // ==========================================================================
  return {
    pi: id, // DEPRECATED: for backward compatibility
    id,
    ver: 1,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}
