import { IPFSService } from './ipfs';
import { TipService } from './tip';
import { Network } from '../types/network';
import { link } from '../types/manifest';
import {
  EntityManifestV1,
  EntityMergedV1,
  CreateEntityKGRequest,
  CreateEntityKGResponse,
  GetEntityKGResponse,
  GetEntityMergedResponse,
  MergeEntityResponse,
  AppendEntityVersionRequest,
  AppendEntityVersionResponse,
  LightweightEntity,
  toLightweight,
} from '../types/entity-manifest';
import { RelationshipsComponent } from '../types/relationships';
import { ConflictError, NotFoundError, CASError } from '../utils/errors';
import { generatePi } from '../utils/ulid';

/**
 * Create a new entity in the knowledge graph
 */
export async function createEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  req: CreateEntityKGRequest,
  network: Network = 'main'
): Promise<CreateEntityKGResponse> {
  // Generate or use provided entity_id
  const entityId = req.entity_id || generatePi(network);

  // Check for collision
  if (await tipSvc.entityTipExists(entityId)) {
    throw new ConflictError('Entity', entityId);
  }

  const now = new Date().toISOString();

  // Build components
  const components: EntityManifestV1['components'] = {};

  // Store properties if provided
  if (req.properties && Object.keys(req.properties).length > 0) {
    const propsCid = await ipfs.dagPut(req.properties);
    components.properties = link(propsCid);
  }

  // Store relationships if provided
  if (req.relationships && req.relationships.length > 0) {
    const relComponent: RelationshipsComponent = {
      schema: 'arke/relationships@v1',
      relationships: req.relationships,
      timestamp: now,
      note: req.note,
    };
    const relCid = await ipfs.dagPut(relComponent);
    components.relationships = link(relCid);
  }

  // Build manifest
  const manifest: EntityManifestV1 = {
    schema: 'arke/entity@v1',
    entity_id: entityId,
    created_by_pi: req.created_by_pi,
    created_at: now,
    ver: 1,
    ts: now,
    prev: null,
    type: req.type,
    label: req.label,
    description: req.description,
    components,
    source_pis: req.source_pis || [req.created_by_pi],
    ...(req.note && { note: req.note }),
  };

  // Store manifest
  const manifestCid = await ipfs.dagPut(manifest);

  // Write tip
  await tipSvc.writeEntityTip(entityId, manifestCid);

  console.log(`[ENTITY-KG] Created entity ${entityId} (type: ${req.type}, label: ${req.label})`);

  return {
    entity_id: entityId,
    ver: 1,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}

/**
 * Get an entity by ID
 * Returns redirect info if entity was merged
 */
export async function getEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string
): Promise<GetEntityKGResponse | GetEntityMergedResponse> {
  const tipCid = await tipSvc.readEntityTip(entityId);
  if (!tipCid) {
    throw new NotFoundError('Entity', entityId);
  }

  const manifest = (await ipfs.dagGet(tipCid)) as EntityManifestV1 | EntityMergedV1;

  // Handle merged entity - return redirect info
  if (manifest.schema === 'arke/entity-merged@v1') {
    const merged = manifest as EntityMergedV1;
    return {
      status: 'merged',
      entity_id: merged.entity_id,
      merged_into: merged.merged_into,
      merged_at: merged.ts,
      prev_cid: merged.prev['/'],
    };
  }

  const entity = manifest as EntityManifestV1;
  return {
    entity_id: entity.entity_id,
    ver: entity.ver,
    ts: entity.ts,
    manifest_cid: tipCid,
    prev_cid: entity.prev?.['/'] || null,
    type: entity.type,
    label: entity.label,
    description: entity.description,
    components: {
      properties: entity.components.properties?.['/'],
      relationships: entity.components.relationships?.['/'],
    },
    source_pis: entity.source_pis,
    note: entity.note,
  };
}

/**
 * Get lightweight entity for context loading
 */
export async function getEntityKGLightweight(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string
): Promise<LightweightEntity> {
  const tipCid = await tipSvc.readEntityTip(entityId);
  if (!tipCid) {
    throw new NotFoundError('Entity', entityId);
  }

  const manifest = (await ipfs.dagGet(tipCid)) as EntityManifestV1 | EntityMergedV1;

  // If merged, follow the redirect
  if (manifest.schema === 'arke/entity-merged@v1') {
    const merged = manifest as EntityMergedV1;
    return getEntityKGLightweight(ipfs, tipSvc, merged.merged_into);
  }

  return toLightweight(manifest as EntityManifestV1);
}

/**
 * Batch lightweight fetch for context loading
 */
export async function getEntitiesKGLightweight(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityIds: string[]
): Promise<LightweightEntity[]> {
  const results = await Promise.all(
    entityIds.map(async (id) => {
      try {
        return await getEntityKGLightweight(ipfs, tipSvc, id);
      } catch {
        return null; // Skip missing entities
      }
    })
  );
  return results.filter((r): r is LightweightEntity => r !== null);
}

/**
 * Append a new version to an entity
 */
export async function appendEntityVersion(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string,
  req: AppendEntityVersionRequest
): Promise<AppendEntityVersionResponse> {
  // Read current tip
  const currentTip = await tipSvc.readEntityTip(entityId);
  if (!currentTip) {
    throw new NotFoundError('Entity', entityId);
  }

  // CAS check
  if (currentTip !== req.expect_tip) {
    throw new CASError({ actual: currentTip, expect: req.expect_tip });
  }

  // Get current manifest
  const currentManifest = (await ipfs.dagGet(currentTip)) as EntityManifestV1 | EntityMergedV1;

  // Can't update a merged entity
  if (currentManifest.schema === 'arke/entity-merged@v1') {
    throw new ConflictError('Entity', `${entityId} has been merged and cannot be updated`);
  }

  const current = currentManifest as EntityManifestV1;
  const now = new Date().toISOString();

  // Build new components (carry forward from current if not updated)
  const components: EntityManifestV1['components'] = { ...current.components };

  // Update properties if provided
  if (req.properties !== undefined) {
    if (Object.keys(req.properties).length > 0) {
      const propsCid = await ipfs.dagPut(req.properties);
      components.properties = link(propsCid);
    } else {
      // Empty object = remove properties
      delete components.properties;
    }
  }

  // Update relationships if provided
  if (req.relationships !== undefined) {
    if (req.relationships.length > 0) {
      const relComponent: RelationshipsComponent = {
        schema: 'arke/relationships@v1',
        relationships: req.relationships,
        timestamp: now,
        note: req.note,
      };
      const relCid = await ipfs.dagPut(relComponent);
      components.relationships = link(relCid);
    } else {
      // Empty array = remove relationships
      delete components.relationships;
    }
  }

  // Update source_pis
  let source_pis = [...current.source_pis];
  if (req.source_pis_add) {
    source_pis = [...new Set([...source_pis, ...req.source_pis_add])];
  }
  if (req.source_pis_remove) {
    source_pis = source_pis.filter((pi) => !req.source_pis_remove!.includes(pi));
  }

  // Build new manifest
  const newManifest: EntityManifestV1 = {
    schema: 'arke/entity@v1',
    entity_id: entityId,
    created_by_pi: current.created_by_pi,
    created_at: current.created_at,
    ver: current.ver + 1,
    ts: now,
    prev: link(currentTip),
    type: req.type ?? current.type,
    label: req.label ?? current.label,
    description: req.description ?? current.description,
    components,
    source_pis,
    ...(req.note && { note: req.note }),
  };

  // Store manifest
  const manifestCid = await ipfs.dagPut(newManifest);

  // Atomic tip update
  await tipSvc.writeEntityTipAtomic(entityId, manifestCid, currentTip);

  console.log(`[ENTITY-KG] Updated entity ${entityId} to v${newManifest.ver}`);

  return {
    entity_id: entityId,
    ver: newManifest.ver,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}

/**
 * Merge entity A into entity B (creates redirect version of A)
 *
 * This creates a redirect version of the source entity pointing to the target.
 * The source entity's history is preserved via the prev link.
 * The target entity gains the source's source_pis.
 */
export async function mergeEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  sourceEntityId: string,
  targetEntityId: string,
  expectTip: string,
  note?: string
): Promise<MergeEntityResponse> {
  // 1. Verify source exists and tip matches
  const sourceTip = await tipSvc.readEntityTip(sourceEntityId);
  if (!sourceTip) {
    throw new NotFoundError('Entity', sourceEntityId);
  }
  if (sourceTip !== expectTip) {
    throw new CASError({ actual: sourceTip, expect: expectTip });
  }

  // 2. Get source manifest to get version number and source_pis
  const sourceManifest = (await ipfs.dagGet(sourceTip)) as EntityManifestV1 | EntityMergedV1;

  // Can't merge an already-merged entity
  if (sourceManifest.schema === 'arke/entity-merged@v1') {
    throw new ConflictError('Entity', `${sourceEntityId} has already been merged`);
  }

  const source = sourceManifest as EntityManifestV1;

  // 3. Verify target exists
  const targetTip = await tipSvc.readEntityTip(targetEntityId);
  if (!targetTip) {
    throw new NotFoundError('Entity', targetEntityId);
  }

  const targetManifest = (await ipfs.dagGet(targetTip)) as EntityManifestV1 | EntityMergedV1;

  // Can't merge into a merged entity
  if (targetManifest.schema === 'arke/entity-merged@v1') {
    throw new ConflictError('Entity', `Target ${targetEntityId} has been merged`);
  }

  const target = targetManifest as EntityManifestV1;
  const now = new Date().toISOString();

  // 4. Create merged (redirect) version of source
  const mergedManifest: EntityMergedV1 = {
    schema: 'arke/entity-merged@v1',
    entity_id: sourceEntityId,
    ver: source.ver + 1,
    ts: now,
    prev: link(sourceTip), // Preserves full history!
    merged_into: targetEntityId,
    note: note || `Merged into ${target.label}`,
  };

  const sourceMergedCid = await ipfs.dagPut(mergedManifest);
  await tipSvc.writeEntityTipAtomic(sourceEntityId, sourceMergedCid, sourceTip);

  // 5. Update target with source's source_pis
  const combinedSourcePis = [...new Set([...target.source_pis, ...source.source_pis])];

  const updatedTargetManifest: EntityManifestV1 = {
    ...target,
    ver: target.ver + 1,
    ts: now,
    prev: link(targetTip),
    source_pis: combinedSourcePis,
    note: `Absorbed entity ${source.label}`,
  };

  const targetUpdatedCid = await ipfs.dagPut(updatedTargetManifest);
  await tipSvc.writeEntityTipAtomic(targetEntityId, targetUpdatedCid, targetTip);

  console.log(`[ENTITY-KG] Merged entity ${sourceEntityId} into ${targetEntityId}`);

  return {
    source_entity_id: sourceEntityId,
    merged_into: targetEntityId,
    source_new_ver: mergedManifest.ver,
    source_manifest_cid: sourceMergedCid,
    target_new_ver: updatedTargetManifest.ver,
    target_manifest_cid: targetUpdatedCid,
  };
}
