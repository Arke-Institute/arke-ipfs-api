import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { link } from '../../types/manifest';
import {
  Eidos,
  EidosMerged,
  EidosDeleted,
  UndeleteEntityRequest,
  UndeleteEntityResponse,
} from '../../types/eidos';
import {
  ValidationError,
  NotFoundError,
  CASError,
} from '../../utils/errors';

/**
 * Undelete an entity - restore it from deleted state back to active
 *
 * Process:
 * 1. Validate entity is currently deleted (arke/eidos-deleted@v1)
 * 2. CAS validation (expect_tip matches tombstone)
 * 3. Fetch previous version (the last active version before deletion)
 * 4. Create new active version with restored data
 * 5. Update tip to point to restored version
 *
 * @param ipfs - IPFS service
 * @param tipSvc - Tip service
 * @param entityId - Entity ID to restore
 * @param req - Undelete request (expect_tip, optional note)
 * @returns Undelete response with restored entity details
 */
export async function undeleteEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string,
  req: UndeleteEntityRequest
): Promise<UndeleteEntityResponse> {

  // ==========================================================================
  // STEP 1: VALIDATE - Entity must be deleted
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

  const tombstone = (await ipfs.dagGet(currentTip)) as
    Eidos | EidosMerged | EidosDeleted;

  // Validate entity is deleted
  if (tombstone.schema !== 'arke/eidos-deleted@v1') {
    throw new ValidationError(
      `Entity ${entityId} is not deleted (current schema: ${tombstone.schema})`,
      {
        entity_id: entityId,
        schema: tombstone.schema,
      }
    );
  }

  const deleted = tombstone as EidosDeleted;

  console.log(
    `[EIDOS] Undeleting entity ${entityId} ` +
    `(type: ${deleted.type}, deleted_at: ${deleted.ts})`
  );

  // ==========================================================================
  // STEP 2: FETCH PREVIOUS VERSION (last active version before deletion)
  // ==========================================================================
  const prevCid = deleted.prev['/'];
  const prevManifest = (await ipfs.dagGet(prevCid)) as Eidos;

  // Sanity check: prev should be an active Eidos manifest
  if (prevManifest.schema !== 'arke/eidos@v1') {
    throw new ValidationError(
      `Cannot restore: previous version is not active Eidos (schema: ${prevManifest.schema})`,
      {
        entity_id: entityId,
        prev_cid: prevCid,
        prev_schema: prevManifest.schema,
      }
    );
  }

  // ==========================================================================
  // STEP 3: BUILD RESTORED MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();

  // Create new version with restored data
  const restored: Eidos = {
    ...prevManifest, // Restore all fields from last active version
    ver: deleted.ver + 1, // Continue version chain from tombstone
    ts: now,
    prev: link(currentTip), // Link to tombstone (preserves full history)
    note: req.note || `Restored from deletion (was v${prevManifest.ver})`,
  };

  // ==========================================================================
  // STEP 4: WRITE RESTORED MANIFEST ATOMICALLY
  // ==========================================================================
  const restoredCid = await ipfs.dagPut(restored);
  await tipSvc.writeTip(entityId, restoredCid);

  console.log(
    `[EIDOS] Undeleted entity ${entityId} ` +
    `(v${restored.ver}, restored from v${prevManifest.ver}, cid: ${restoredCid})`
  );

  // ==========================================================================
  // STEP 5: RETURN RESPONSE
  // ==========================================================================
  return {
    id: entityId,
    restored_ver: restored.ver,
    restored_from_ver: prevManifest.ver,
    new_manifest_cid: restoredCid,
  };
}
