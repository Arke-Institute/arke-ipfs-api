import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { CASError } from '../../utils/errors';
import {
  Eidos,
  link,
  AppendVersionRequest,
  AppendVersionResponse,
} from '../../types/eidos';
import { componentsToLinks, linksToComponents } from './core';
import { createRelationshipsComponent } from '../../types/relationships';

/**
 * Append a new version to an existing entity
 *
 * Supports:
 * - Partial component updates (merge with previous)
 * - Component removal
 * - Children add/remove
 * - Type, label, description updates
 * - Properties and relationships updates (TODO: Phase 3)
 */
export async function appendVersion(
  ipfs: IPFSService,
  tipSvc: TipService,
  id: string,
  req: AppendVersionRequest
): Promise<AppendVersionResponse> {
  // ==========================================================================
  // STEP 1: READ CURRENT TIP AND VALIDATE CAS
  // ==========================================================================
  const currentTip = await tipSvc.readTip(id);

  // CAS check
  if (currentTip !== req.expect_tip) {
    throw new CASError({
      actual: currentTip,
      expect: req.expect_tip,
    });
  }

  // ==========================================================================
  // STEP 2: FETCH OLD MANIFEST
  // ==========================================================================
  const oldManifest = (await ipfs.dagGet(currentTip)) as Eidos;

  // ==========================================================================
  // STEP 3: MERGE COMPONENTS
  // ==========================================================================
  let newComponents = { ...oldManifest.components };

  // Add/update components
  if (req.components) {
    const updatedComponents = componentsToLinks(req.components);
    newComponents = { ...newComponents, ...updatedComponents };
  }

  // Remove components
  if (req.components_remove) {
    for (const key of req.components_remove) {
      delete newComponents[key];
    }
  }

  // Handle properties updates (replace entire properties object)
  if (req.properties !== undefined) {
    if (Object.keys(req.properties).length > 0) {
      const propsCid = await ipfs.dagPut(req.properties);
      newComponents.properties = link(propsCid);
    } else {
      // Empty properties object removes the component
      delete newComponents.properties;
    }
  }

  // Handle relationships updates (replace entire relationships array with schema wrapper)
  if (req.relationships !== undefined) {
    if (req.relationships.length > 0) {
      const relsComponent = createRelationshipsComponent(req.relationships, req.note);
      const relsCid = await ipfs.dagPut(relsComponent);
      newComponents.relationships = link(relsCid);
    } else {
      // Empty relationships array removes the component
      delete newComponents.relationships;
    }
  }

  // ==========================================================================
  // STEP 4: UPDATE CHILDREN_PI ARRAY
  // ==========================================================================
  let newChildrenPi = oldManifest.children_pi || [];

  if (req.children_pi_add) {
    // Add new children (dedupe)
    const existingSet = new Set(newChildrenPi);
    for (const childId of req.children_pi_add) {
      if (!existingSet.has(childId)) {
        newChildrenPi.push(childId);
      }
    }
  }

  if (req.children_pi_remove) {
    const removeSet = new Set(req.children_pi_remove);
    newChildrenPi = newChildrenPi.filter((id) => !removeSet.has(id));
  }

  // ==========================================================================
  // STEP 5: BUILD NEW MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();

  const newManifest: Eidos = {
    ...oldManifest,
    ver: oldManifest.ver + 1,
    ts: now,
    prev: link(currentTip),
    components: newComponents,
    // Allow updating type, label, description
    ...(req.type && { type: req.type }),
    ...(req.label !== undefined && { label: req.label }),
    ...(req.description !== undefined && { description: req.description }),
    // Update children_pi if modified
    ...(newChildrenPi.length > 0 && { children_pi: newChildrenPi }),
    // Note
    ...(req.note && { note: req.note }),
  };

  // ==========================================================================
  // STEP 6: STORE NEW MANIFEST
  // ==========================================================================
  const newManifestCid = await ipfs.dagPut(newManifest);

  // ==========================================================================
  // STEP 7: UPDATE .TIP WITH ATOMIC CAS VERIFICATION
  // ==========================================================================
  await tipSvc.writeTipAtomic(id, newManifestCid, currentTip);

  console.log(`[EIDOS] Updated entity ${id} to v${newManifest.ver}`);

  // ==========================================================================
  // STEP 8: TODO - FIRE-AND-FORGET INDEX-SYNC EVENT (Phase 3)
  // ==========================================================================
  // TODO: Append update event to index-sync service
  // try {
  //   const eventCid = await appendEvent(backendURL, {
  //     type: 'update',
  //     id,
  //     ver: newManifest.ver,
  //     tip_cid: newManifestCid,
  //     entity_type: newManifest.type,
  //   });
  //   console.log(`[EVENT] Appended update event for entity ${id}: ${eventCid}`);
  // } catch (error) {
  //   console.error(`[EVENT] Failed to append update event for entity ${id}:`, error);
  // }

  // ==========================================================================
  // STEP 9: RETURN RESPONSE
  // ==========================================================================
  return {
    pi: id, // DEPRECATED: backward compatibility
    id,
    ver: newManifest.ver,
    manifest_cid: newManifestCid,
    tip: newManifestCid,
  };
}
