import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { CASError, ValidationError, NotFoundError } from '../../utils/errors';
import {
  Eidos,
  EidosMerged,
  link,
  UnmergeEntityRequest,
  UnmergeEntityResponse,
} from '../../types/eidos';

/**
 * Unmerge (restore) a previously merged entity
 *
 * Process:
 * 1. Validate source is a tombstone (arke/eidos-merged@v1)
 * 2. Validate target matches tombstone's merged_into field
 * 3. Fetch source's previous version (before merge)
 * 4. Restore source entity with incremented version
 * 5. Update target's merged_entities array (remove source)
 * 6. Return restored entity info
 *
 * Features:
 * - CAS protection for atomic updates
 * - Restores entity state from before merge
 * - Updates target's merged_entities tracking
 * - Preserves version history (unmerge creates new version)
 */
export async function unmergeEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  sourceId: string,
  req: UnmergeEntityRequest
): Promise<UnmergeEntityResponse> {
  // ==========================================================================
  // STEP 1: READ AND VALIDATE SOURCE TOMBSTONE
  // ==========================================================================
  const sourceTip = await tipSvc.readTip(sourceId);
  if (!sourceTip) {
    throw new NotFoundError('Entity', sourceId);
  }

  const sourceManifest = (await ipfs.dagGet(sourceTip)) as Eidos | EidosMerged;

  // Validate source is a tombstone
  if (sourceManifest.schema !== 'arke/eidos-merged@v1') {
    throw new ValidationError(
      `Entity ${sourceId} is not merged (cannot unmerge an active entity)`,
      { source_id: sourceId, schema: sourceManifest.schema }
    );
  }

  const tombstone = sourceManifest as EidosMerged;

  // Validate target matches tombstone
  if (tombstone.merged_into !== req.target_id) {
    throw new ValidationError(
      `Entity ${sourceId} is merged into ${tombstone.merged_into}, not ${req.target_id}`,
      { source_id: sourceId, expected_target: tombstone.merged_into, provided_target: req.target_id }
    );
  }

  // ==========================================================================
  // STEP 2: READ AND VALIDATE TARGET
  // ==========================================================================
  const targetTip = await tipSvc.readTip(req.target_id);

  // CAS check for target
  if (targetTip !== req.expect_target_tip) {
    throw new CASError({
      actual: targetTip,
      expect: req.expect_target_tip,
    });
  }

  const targetManifest = (await ipfs.dagGet(targetTip)) as Eidos | EidosMerged;

  // Validate target is active
  if (targetManifest.schema === 'arke/eidos-merged@v1') {
    throw new ValidationError(
      `Target entity ${req.target_id} is already merged (cannot unmerge into a tombstone)`,
      { target_id: req.target_id }
    );
  }

  const target = targetManifest as Eidos;

  // ==========================================================================
  // STEP 3: FETCH SOURCE'S PREVIOUS VERSION (BEFORE MERGE)
  // ==========================================================================
  if (!tombstone.prev) {
    throw new ValidationError(
      `Cannot unmerge ${sourceId}: tombstone has no previous version`,
      { source_id: sourceId }
    );
  }

  const preMergeCid = tombstone.prev['/'];
  const preMergeManifest = (await ipfs.dagGet(preMergeCid)) as Eidos;

  // ==========================================================================
  // STEP 4: RESTORE SOURCE ENTITY
  // ==========================================================================
  const now = new Date().toISOString();

  const restoredSource: Eidos = {
    ...preMergeManifest,
    ver: tombstone.ver + 1, // Continue version sequence from tombstone
    ts: now,
    prev: link(sourceTip), // Link to tombstone
    note: req.note || `Unmerged from ${req.target_id}`,
  };

  const newSourceTip = await ipfs.dagPut(restoredSource);
  await tipSvc.writeTip(sourceId, newSourceTip);

  console.log(`[UNMERGE] Restored entity ${sourceId} to v${restoredSource.ver}`);

  // ==========================================================================
  // STEP 5: UPDATE TARGET'S merged_entities ARRAY
  // ==========================================================================
  const updatedMergedEntities = (target.merged_entities || []).filter(
    (id) => id !== sourceId
  );

  const updatedTarget: Eidos = {
    ...target,
    ver: target.ver + 1,
    ts: now,
    prev: link(targetTip),
    merged_entities: updatedMergedEntities.length > 0 ? updatedMergedEntities : undefined,
    note: req.note || `Unmerged entity ${sourceId}`,
  };

  // Remove merged_entities field if empty
  if (updatedMergedEntities.length === 0) {
    delete updatedTarget.merged_entities;
  }

  const newTargetTip = await ipfs.dagPut(updatedTarget);
  await tipSvc.writeTipAtomic(req.target_id, newTargetTip, targetTip);

  console.log(`[UNMERGE] Updated target ${req.target_id} to v${updatedTarget.ver}`);

  // ==========================================================================
  // STEP 6: RETURN RESPONSE
  // ==========================================================================
  return {
    source_id: sourceId,
    source_ver: restoredSource.ver,
    source_tip: newSourceTip,
    target_id: req.target_id,
    target_ver: updatedTarget.ver,
    target_tip: newTargetTip,
  };
}
