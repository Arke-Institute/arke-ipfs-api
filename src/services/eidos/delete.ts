import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { link } from '../../types/manifest';
import {
  Eidos,
  EidosMerged,
  EidosDeleted,
  DeleteEntityRequest,
  DeleteEntityResponse,
} from '../../types/eidos';
import {
  ValidationError,
  NotFoundError,
  CASError,
} from '../../utils/errors';

/**
 * Delete an entity (soft delete - creates tombstone)
 *
 * Process:
 * 1. Validate entity exists and is active (not already deleted/merged)
 * 2. CAS validation (expect_tip matches actual)
 * 3. Create tombstone manifest (arke/eidos-deleted@v1)
 * 4. Write tombstone to IPFS and update tip atomically
 *
 * @param ipfs - IPFS service
 * @param tipSvc - Tip service
 * @param entityId - Entity ID to delete
 * @param req - Delete request (expect_tip, optional metadata)
 * @returns Delete response with tombstone details
 */
export async function deleteEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string,
  req: DeleteEntityRequest
): Promise<DeleteEntityResponse> {

  // ==========================================================================
  // STEP 1: VALIDATE - Entity must exist and be active
  // ==========================================================================
  const currentTip = await tipSvc.readTip(entityId);
  if (!currentTip) {
    throw new NotFoundError('Entity', entityId);
  }

  // CAS check
  if (currentTip !== req.expect_tip) {
    throw new CASError({
      actual: currentTip,
      expect: req.expect_tip,
    });
  }

  const currentManifest = (await ipfs.dagGet(currentTip)) as
    Eidos | EidosMerged | EidosDeleted;

  // Check if already deleted
  if (currentManifest.schema === 'arke/eidos-deleted@v1') {
    const deleted = currentManifest as EidosDeleted;
    throw new ValidationError(
      `Entity ${entityId} is already deleted`,
      {
        entity_id: entityId,
        deleted_at: deleted.ts,
      }
    );
  }

  // Check if merged (cannot delete merged entity - must unmerge or delete target)
  if (currentManifest.schema === 'arke/eidos-merged@v1') {
    const merged = currentManifest as EidosMerged;
    throw new ValidationError(
      `Cannot delete entity ${entityId} - it is merged into ${merged.merged_into}. ` +
      `Unmerge first or delete the target entity.`,
      {
        entity_id: entityId,
        merged_into: merged.merged_into,
      }
    );
  }

  const activeManifest = currentManifest as Eidos;

  console.log(
    `[EIDOS] Deleting entity ${entityId} ` +
    `(type: ${activeManifest.type}, label: ${activeManifest.label || 'N/A'})`
  );

  // ==========================================================================
  // STEP 2: BUILD TOMBSTONE MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();

  const tombstone: EidosDeleted = {
    schema: 'arke/eidos-deleted@v1',
    id: entityId,
    type: activeManifest.type, // Preserve original type
    ver: activeManifest.ver + 1,
    ts: now,
    prev: link(currentTip), // Preserve version history
    ...(req.note && { note: req.note }),
  };

  // ==========================================================================
  // STEP 3: WRITE TOMBSTONE ATOMICALLY
  // ==========================================================================
  const tombstoneCid = await ipfs.dagPut(tombstone);
  await tipSvc.writeTip(entityId, tombstoneCid);

  console.log(
    `[EIDOS] Deleted entity ${entityId} ` +
    `(v${tombstone.ver}, tombstone: ${tombstoneCid})`
  );

  // ==========================================================================
  // STEP 4: RETURN RESPONSE
  // ==========================================================================
  return {
    id: entityId,
    deleted_ver: tombstone.ver,
    deleted_at: tombstone.ts,
    deleted_manifest_cid: tombstoneCid,
    previous_ver: activeManifest.ver,
    prev_cid: currentTip,
  };
}
