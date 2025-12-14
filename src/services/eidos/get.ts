import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { NotFoundError } from '../../utils/errors';
import { processBatchedSettled } from '../../utils/batch';
import {
  Eidos,
  EidosMerged,
  EidosDeleted,
  GetEntityResponse,
  GetEntityMergedResponse,
  GetEntityDeletedResponse,
  LightweightEntity,
  toLightweight,
  BatchLightweightResponse,
} from '../../types/eidos';
import { resolveEntityChain, linksToComponents } from './core';

/**
 * Get an entity by ID
 * Returns redirect info if entity was merged, or deleted status if deleted
 */
export async function getEntity(
  ipfs: IPFSService,
  tipSvc: TipService,
  id: string,
  resolveLightweight: boolean = false
): Promise<GetEntityResponse | GetEntityMergedResponse | GetEntityDeletedResponse | LightweightEntity> {
  const tipCid = await tipSvc.readTip(id);
  if (!tipCid) {
    throw new NotFoundError('Entity', id);
  }

  const manifest = (await ipfs.dagGet(tipCid)) as Eidos | EidosMerged | EidosDeleted;

  // ==========================================================================
  // HANDLE MERGED ENTITY
  // ==========================================================================
  if (manifest.schema === 'arke/eidos-merged@v1') {
    const merged = manifest as EidosMerged;

    // If resolve=lightweight, follow chain and return lightweight
    if (resolveLightweight) {
      const resolved = await resolveEntityChain(ipfs, tipSvc, merged.merged_into);
      return toLightweight(resolved.manifest);
    }

    // Otherwise return redirect info
    return {
      pi: id, // DEPRECATED: backward compatibility
      id,
      type: merged.type,
      manifest_cid: tipCid,
      merged: true,
      merged_into: merged.merged_into,
      merged_at: merged.ts,
      note: merged.note,
    };
  }

  // ==========================================================================
  // HANDLE DELETED ENTITY
  // ==========================================================================
  if (manifest.schema === 'arke/eidos-deleted@v1') {
    const deleted = manifest as EidosDeleted;

    return {
      pi: id, // DEPRECATED
      id,
      type: deleted.type,
      manifest_cid: tipCid,
      status: 'deleted',
      deleted_at: deleted.ts,
      note: deleted.note,
      prev_cid: deleted.prev['/'],
    };
  }

  // ==========================================================================
  // HANDLE ACTIVE ENTITY
  // ==========================================================================
  const entity = manifest as Eidos;

  // If resolve=lightweight requested, return lightweight
  if (resolveLightweight) {
    return toLightweight(entity);
  }

  // Return full entity
  return {
    pi: id, // DEPRECATED: backward compatibility
    id: entity.id,
    type: entity.type,
    label: entity.label,
    description: entity.description,
    ver: entity.ver,
    ts: entity.ts,
    manifest_cid: tipCid,
    prev_cid: entity.prev ? entity.prev['/'] : null,
    components: linksToComponents(entity.components),
    children_pi: entity.children_pi,
    parent_pi: entity.parent_pi,
    source_pi: entity.source_pi,
    merged_entities: entity.merged_entities,
    note: entity.note,
  };
}

/**
 * Get a single entity in lightweight format (follows redirects)
 */
export async function getEntityLightweight(
  ipfs: IPFSService,
  tipSvc: TipService,
  id: string
): Promise<LightweightEntity> {
  const result = await getEntity(ipfs, tipSvc, id, true);
  return result as LightweightEntity;
}

/**
 * Batch fetch entities in lightweight format
 * Follows redirects automatically
 * Returns results in same order as requested IDs
 */
export async function getEntitiesLightweight(
  ipfs: IPFSService,
  tipSvc: TipService,
  ids: string[]
): Promise<BatchLightweightResponse> {
  const BATCH_SIZE = 10;

  const results = await processBatchedSettled(
    ids,
    BATCH_SIZE,
    async (id) => getEntityLightweight(ipfs, tipSvc, id)
  );

  // Filter out failures, return successes
  const entities: LightweightEntity[] = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => (r as PromiseFulfilledResult<LightweightEntity>).value);

  // Log failures
  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      console.error(`[BATCH] Failed to fetch entity ${ids[idx]}:`, r.reason);
    }
  });

  return { entities };
}
