import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { CASError, TipWriteRaceError } from '../../utils/errors';
import { processBatchedSettled } from '../../utils/batch';
import {
  Eidos,
  link,
  UpdateHierarchyRequest,
  UpdateHierarchyResponse,
} from '../../types/eidos';

/**
 * Update parent-child hierarchy relationships with atomic CAS protection
 *
 * This function coordinates bulk updates to prevent race conditions:
 * - Updates parent's children_pi array (add/remove)
 * - Updates all affected children's parent_pi field
 * - Processes children in batches of 10 for optimal performance
 * - Uses CAS protection for atomic updates
 * - Retries automatically on race conditions
 *
 * Features:
 * - Bidirectional storage: both parent → children and children → parent
 * - Deduplication: prevents duplicate children in parent's array
 * - Batch processing: handles large child arrays efficiently
 * - Automatic retry: handles concurrent updates gracefully
 */
export async function updateHierarchy(
  ipfs: IPFSService,
  tipSvc: TipService,
  req: UpdateHierarchyRequest
): Promise<UpdateHierarchyResponse> {
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 10; // Higher retry limit for batch operations with high contention

  // ==========================================================================
  // STEP 1: UPDATE PARENT WITH RETRY LOGIC
  // ==========================================================================
  let parentVer: number;
  let parentTip: string;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Read current tip
      const currentTip = await tipSvc.readTip(req.parent_pi);

      // Validate CAS only on first attempt
      // On retries, use current state (race was detected, so expect_tip is stale)
      if (attempt === 0 && currentTip !== req.expect_tip) {
        throw new CASError({
          actual: currentTip,
          expect: req.expect_tip,
        });
      }

      // Fetch parent manifest
      const parentManifest = (await ipfs.dagGet(currentTip)) as Eidos;

      // Update children_pi array
      let newChildrenPi = parentManifest.children_pi || [];

      // Add children (dedupe)
      if (req.add_children && req.add_children.length > 0) {
        const existingSet = new Set(newChildrenPi);
        for (const childId of req.add_children) {
          if (!existingSet.has(childId)) {
            newChildrenPi.push(childId);
          }
        }
      }

      // Remove children
      if (req.remove_children && req.remove_children.length > 0) {
        const removeSet = new Set(req.remove_children);
        newChildrenPi = newChildrenPi.filter((id) => !removeSet.has(id));
      }

      // Build new manifest
      const now = new Date().toISOString();
      const updatedParent: Eidos = {
        ...parentManifest,
        ver: parentManifest.ver + 1,
        ts: now,
        prev: link(currentTip),
        children_pi: newChildrenPi,
        note: req.note || `Updated hierarchy: +${req.add_children?.length || 0} -${req.remove_children?.length || 0} children`,
      };

      // Store new manifest
      const newParentTip = await ipfs.dagPut(updatedParent);

      // Update tip atomically
      await tipSvc.writeTipAtomic(req.parent_pi, newParentTip, currentTip);

      parentVer = updatedParent.ver;
      parentTip = newParentTip;

      console.log(`[HIERARCHY] Updated parent ${req.parent_pi} to v${parentVer}`);
      break; // Success, exit retry loop
    } catch (error) {
      // Retry on both CASError (initial check failure) and TipWriteRaceError (atomic write race)
      const isRetryableError = (error instanceof TipWriteRaceError) || (error instanceof CASError);

      if (isRetryableError && attempt < MAX_RETRIES - 1) {
        // Race detected, retry with exponential backoff
        const delay = 50 * (2 ** attempt);
        const errorType = error instanceof TipWriteRaceError ? 'Tip write race' : 'CAS failure';
        console.log(`[HIERARCHY] ${errorType} for ${req.parent_pi}, retrying in ${delay}ms (attempt ${attempt + 2}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  // ==========================================================================
  // STEP 2: UPDATE CHILDREN'S parent_pi FIELD (BATCHED)
  // ==========================================================================
  const allAffectedChildren = [
    ...(req.add_children || []),
    ...(req.remove_children || []),
  ];

  if (allAffectedChildren.length === 0) {
    // No children to update, return early
    return {
      parent_pi: req.parent_pi,
      parent_ver: parentVer!,
      parent_tip: parentTip!,
      children_updated: 0,
      children_failed: 0,
    };
  }

  // Update children in batches
  const results = await processBatchedSettled(
    allAffectedChildren,
    BATCH_SIZE,
    async (childId) => {
      const isAdding = req.add_children?.includes(childId) || false;
      const isRemoving = req.remove_children?.includes(childId) || false;

      // Retry logic for child update
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const childTip = await tipSvc.readTip(childId);
          const childManifest = (await ipfs.dagGet(childTip)) as Eidos;

          // Determine new parent_pi value
          let newParentPi: string | undefined;
          if (isAdding) {
            newParentPi = req.parent_pi;
          } else if (isRemoving) {
            // Only remove if current parent matches
            if (childManifest.parent_pi === req.parent_pi) {
              newParentPi = undefined;
            } else {
              // Child has different parent, skip update
              return;
            }
          }

          // Skip if no change needed
          if (childManifest.parent_pi === newParentPi) {
            return;
          }

          // Build new manifest
          const now = new Date().toISOString();
          const updatedChild: Eidos = {
            ...childManifest,
            ver: childManifest.ver + 1,
            ts: now,
            prev: link(childTip),
            ...(newParentPi !== undefined && { parent_pi: newParentPi }),
            note: isAdding
              ? `Added to parent ${req.parent_pi}`
              : `Removed from parent ${req.parent_pi}`,
          };

          // If removing parent, explicitly delete the field
          if (isRemoving && newParentPi === undefined) {
            delete updatedChild.parent_pi;
          }

          // Store new manifest
          const newChildTip = await ipfs.dagPut(updatedChild);

          // Update tip atomically
          await tipSvc.writeTipAtomic(childId, newChildTip, childTip);

          console.log(`[HIERARCHY] Updated child ${childId} parent_pi: ${newParentPi || 'null'}`);
          return;
        } catch (error) {
          // Retry on both CASError and TipWriteRaceError
          const isRetryableError = (error instanceof TipWriteRaceError) || (error instanceof CASError);

          if (isRetryableError && attempt < MAX_RETRIES - 1) {
            // Race detected, retry with exponential backoff
            const delay = 50 * (2 ** attempt);
            const errorType = error instanceof TipWriteRaceError ? 'Tip write race' : 'CAS failure';
            console.log(`[HIERARCHY] ${errorType} for child ${childId}, retrying in ${delay}ms (attempt ${attempt + 2}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw error;
        }
      }
    }
  );

  // Count successes and failures
  const childrenUpdated = results.filter((r) => r.status === 'fulfilled').length;
  const childrenFailed = results.filter((r) => r.status === 'rejected').length;

  // Log failures
  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      console.error(`[HIERARCHY] Failed to update child ${allAffectedChildren[idx]}:`, r.reason);
    }
  });

  // ==========================================================================
  // STEP 3: TODO - FIRE-AND-FORGET INDEX-SYNC EVENT (Phase 3)
  // ==========================================================================
  // TODO: Append hierarchy update event to index-sync service

  // ==========================================================================
  // STEP 4: RETURN RESPONSE
  // ==========================================================================
  return {
    parent_pi: req.parent_pi,
    parent_ver: parentVer!,
    parent_tip: parentTip!,
    children_updated: childrenUpdated,
    children_failed: childrenFailed,
  };
}
