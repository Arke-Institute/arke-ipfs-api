import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { CASError, ValidationError } from '../../utils/errors';
import {
  Eidos,
  EidosMerged,
  link,
  MergeEntityRequest,
  MergeEntityResponse,
} from '../../types/eidos';
import { mergeComponents } from './core';

/**
 * Merge source entity into target entity
 *
 * Process:
 * 1. Fetch and validate both entities (must be active, not already merged)
 * 2. Merge components (properties union, relationships concat, files target-wins)
 * 3. Update target: add source to merged_entities array, increment version
 * 4. Create tombstone for source (arke/eidos-merged@v1 schema)
 * 5. Return merged result
 *
 * Features:
 * - CAS protection for atomic updates
 * - Component merge rules from core.ts
 * - Tombstone redirects future lookups to target
 * - merged_entities tracking for audit trail
 */
export async function mergeEntities(
  ipfs: IPFSService,
  tipSvc: TipService,
  sourceId: string,
  req: MergeEntityRequest
): Promise<MergeEntityResponse> {
  // ==========================================================================
  // STEP 1: READ AND VALIDATE SOURCE AND TARGET
  // ==========================================================================
  const sourceTip = await tipSvc.readTip(sourceId);
  const targetTip = await tipSvc.readTip(req.target_id);

  // CAS check for target
  if (targetTip !== req.expect_target_tip) {
    throw new CASError({
      actual: targetTip,
      expect: req.expect_target_tip,
    });
  }

  const sourceManifest = (await ipfs.dagGet(sourceTip)) as Eidos | EidosMerged;
  const targetManifest = (await ipfs.dagGet(targetTip)) as Eidos | EidosMerged;

  // Validate source is active (not already merged)
  if (sourceManifest.schema === 'arke/eidos-merged@v1') {
    throw new ValidationError(
      `Source entity ${sourceId} is already merged into ${(sourceManifest as EidosMerged).merged_into}`,
      { source_id: sourceId, merged_into: (sourceManifest as EidosMerged).merged_into }
    );
  }

  // Validate target is active (not already merged)
  if (targetManifest.schema === 'arke/eidos-merged@v1') {
    throw new ValidationError(
      `Target entity ${req.target_id} is already merged into ${(targetManifest as EidosMerged).merged_into}`,
      { target_id: req.target_id, merged_into: (targetManifest as EidosMerged).merged_into }
    );
  }

  const source = sourceManifest as Eidos;
  const target = targetManifest as Eidos;

  // ==========================================================================
  // STEP 2: MERGE COMPONENTS
  // ==========================================================================
  const mergedComponentsObj = await mergeComponents(
    ipfs,
    source,
    target,
    req.note || `Merged ${sourceId} into ${req.target_id}`
  );

  // ==========================================================================
  // STEP 3: UPDATE TARGET WITH MERGED COMPONENTS AND TRACKING
  // ==========================================================================
  const now = new Date().toISOString();

  // Add source to merged_entities tracking
  // Include source's merged_entities to preserve full audit trail
  const updatedMergedEntities = [
    ...(target.merged_entities || []),
    sourceId,
    ...(source.merged_entities || []),
  ];

  const updatedTarget: Eidos = {
    ...target,
    ver: target.ver + 1,
    ts: now,
    prev: link(targetTip),
    components: mergedComponentsObj,
    merged_entities: updatedMergedEntities,
    note: req.note || `Merged ${sourceId} into ${req.target_id}`,
  };

  const newTargetTip = await ipfs.dagPut(updatedTarget);
  await tipSvc.writeTipAtomic(req.target_id, newTargetTip, targetTip);

  console.log(`[MERGE] Updated target ${req.target_id} to v${updatedTarget.ver}`);

  // ==========================================================================
  // STEP 4: CREATE TOMBSTONE FOR SOURCE
  // ==========================================================================
  const tombstone: EidosMerged = {
    schema: 'arke/eidos-merged@v1',
    id: sourceId,
    type: source.type,
    ver: source.ver + 1,
    ts: now,
    prev: link(sourceTip),
    merged_into: req.target_id,
    note: req.note || `Merged into ${req.target_id}`,
  };

  const tombstoneCid = await ipfs.dagPut(tombstone);
  await tipSvc.writeTip(sourceId, tombstoneCid);

  console.log(`[MERGE] Created tombstone for ${sourceId} → ${req.target_id}`);

  // ==========================================================================
  // STEP 5: TODO - FIRE-AND-FORGET INDEX-SYNC EVENT (Phase 3)
  // ==========================================================================
  // TODO: Append merge event to index-sync service
  // try {
  //   const eventCid = await appendEvent(backendURL, {
  //     type: 'merge',
  //     source_id: req.source_id,
  //     target_id: req.target_id,
  //     target_ver: updatedTarget.ver,
  //     target_tip_cid: newTargetTip,
  //   });
  //   console.log(`[EVENT] Appended merge event: ${eventCid}`);
  // } catch (error) {
  //   console.error(`[EVENT] Failed to append merge event:`, error);
  // }

  // ==========================================================================
  // STEP 6: RETURN RESPONSE
  // ==========================================================================
  return {
    source_id: sourceId,
    target_id: req.target_id,
    target_ver: updatedTarget.ver,
    target_tip: newTargetTip,
    tombstone_cid: tombstoneCid,
  };
}
