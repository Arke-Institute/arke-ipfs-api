import { IPFSService } from './ipfs';
import { TipService } from './tip';
import { Network } from '../types/network';
import { link } from '../types/manifest';
import {
  EntityManifestV1,
  EntityMergedV1,
  EntityDeletedV1,
  CreateEntityKGRequest,
  CreateEntityKGResponse,
  GetEntityKGResponse,
  GetEntityMergedResponse,
  GetEntityDeletedResponse,
  MergeEntityResponse,
  MergeConflictResponse,
  AppendEntityVersionRequest,
  AppendEntityVersionResponse,
  LightweightEntity,
  toLightweight,
  UnmergeEntityResponse,
  DeleteEntityResponse,
} from '../types/entity-manifest';
import { RelationshipsComponent } from '../types/relationships';
import { ConflictError, NotFoundError, CASError, ValidationError } from '../utils/errors';
import { generatePi } from '../utils/ulid';
import { appendEvent } from '../clients/ipfs-server';

// Maximum number of redirect hops to follow before failing
const MAX_CHAIN_HOPS = 10;

/**
 * Merge components from source entity into target entity.
 *
 * Rules:
 * - Properties: Union with target winning on conflicts
 * - Relationships: Concatenate arrays (source's rels appended to target's)
 * - File components: Union with target winning on same filename
 *
 * @param ipfs - IPFS service for fetching/storing data
 * @param source - Source entity manifest (being merged into target)
 * @param target - Target entity manifest (absorbing source)
 * @param note - Optional note for the merge
 * @returns Merged components object
 */
async function mergeComponents(
  ipfs: IPFSService,
  source: EntityManifestV1,
  target: EntityManifestV1,
  note?: string
): Promise<EntityManifestV1['components']> {
  const now = new Date().toISOString();
  const merged: EntityManifestV1['components'] = {};

  // Get all unique component keys from both
  const allKeys = new Set([
    ...Object.keys(source.components),
    ...Object.keys(target.components),
  ]);

  for (const key of allKeys) {
    const sourceLink = source.components[key];
    const targetLink = target.components[key];

    if (key === 'properties') {
      // Properties: Deep merge with target winning on conflicts
      const sourceProps = sourceLink
        ? await ipfs.dagGet(sourceLink['/']) as Record<string, unknown>
        : null;
      const targetProps = targetLink
        ? await ipfs.dagGet(targetLink['/']) as Record<string, unknown>
        : null;

      if (sourceProps || targetProps) {
        // Merge: source first, then target overwrites (target wins conflicts)
        const mergedProps = {
          ...(sourceProps || {}),
          ...(targetProps || {}),
        };
        const propsCid = await ipfs.dagPut(mergedProps);
        merged.properties = link(propsCid);
      }
    } else if (key === 'relationships') {
      // Relationships: Concatenate arrays
      const sourceRels = sourceLink
        ? await ipfs.dagGet(sourceLink['/']) as RelationshipsComponent
        : null;
      const targetRels = targetLink
        ? await ipfs.dagGet(targetLink['/']) as RelationshipsComponent
        : null;

      const combinedRels = [
        ...(targetRels?.relationships || []),
        ...(sourceRels?.relationships || []),
      ];

      if (combinedRels.length > 0) {
        const relComponent: RelationshipsComponent = {
          schema: 'arke/relationships@v1',
          relationships: combinedRels,
          timestamp: now,
          note,
        };
        const relCid = await ipfs.dagPut(relComponent);
        merged.relationships = link(relCid);
      }
    } else {
      // File components: Target wins on conflict, otherwise take whatever exists
      if (targetLink) {
        merged[key] = targetLink;
      } else if (sourceLink) {
        merged[key] = sourceLink;
      }
    }
  }

  return merged;
}

/**
 * Result of resolving an entity through its redirect chain
 */
interface ResolvedEntity {
  entityId: string;
  tipCid: string;
  manifest: EntityManifestV1;
  hops: number;
}

/**
 * Follow redirect chain to find the final active entity.
 * Detects cycles and enforces max hop limit.
 *
 * @throws ValidationError if cycle detected or chain too long
 * @throws NotFoundError if entity in chain not found
 */
export async function resolveEntityChain(
  ipfs: IPFSService,
  tipSvc: TipService,
  startEntityId: string
): Promise<ResolvedEntity> {
  const seen = new Set<string>();
  let currentId = startEntityId;
  let hops = 0;

  while (true) {
    // Cycle detection
    if (seen.has(currentId)) {
      const chain = [...seen, currentId].join(' → ');
      throw new ValidationError(
        `Cycle detected in entity redirect chain: ${chain}`,
        { cycle: [...seen], repeated: currentId }
      );
    }
    seen.add(currentId);

    // Max hops check
    if (hops > MAX_CHAIN_HOPS) {
      throw new ValidationError(
        `Entity redirect chain too long (>${MAX_CHAIN_HOPS} hops)`,
        { start: startEntityId, hops, lastSeen: currentId }
      );
    }

    // Read entity
    const tipCid = await tipSvc.readEntityTip(currentId);
    if (!tipCid) {
      throw new NotFoundError('Entity', currentId);
    }

    const manifest = (await ipfs.dagGet(tipCid)) as EntityManifestV1 | EntityMergedV1;

    // If not merged, we found the active entity
    if (manifest.schema !== 'arke/entity-merged@v1') {
      return {
        entityId: currentId,
        tipCid,
        manifest: manifest as EntityManifestV1,
        hops,
      };
    }

    // Follow redirect
    const merged = manifest as EntityMergedV1;
    currentId = merged.merged_into;
    hops++;
  }
}

/**
 * Create a new entity in the knowledge graph
 */
export async function createEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  backendURL: string,
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

  // Store arbitrary file components if provided (description.md, pinax.json, etc.)
  if (req.components) {
    for (const [filename, cid] of Object.entries(req.components)) {
      // Skip empty CIDs (used for removal in updates)
      if (cid) {
        components[filename] = link(cid);
      }
    }
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

  // Append create event to event stream (non-blocking, don't fail if this fails)
  try {
    const eventCid = await appendEvent(backendURL, {
      type: 'create',
      pi: entityId, // Entity IDs go in the same event stream as PIs
      ver: 1,
      tip_cid: manifestCid,
    });
    console.log(`[EVENT] Appended create event for entity ${entityId}: ${eventCid}`);
  } catch (error) {
    console.error(`[EVENT] Failed to append create event for entity ${entityId}:`, error);
  }

  return {
    entity_id: entityId,
    ver: 1,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}

/**
 * Get an entity by ID
 * Returns redirect info if entity was merged, or deleted info if deleted
 */
export async function getEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string
): Promise<GetEntityKGResponse | GetEntityMergedResponse | GetEntityDeletedResponse> {
  const tipCid = await tipSvc.readEntityTip(entityId);
  if (!tipCid) {
    throw new NotFoundError('Entity', entityId);
  }

  const manifest = (await ipfs.dagGet(tipCid)) as EntityManifestV1 | EntityMergedV1 | EntityDeletedV1;

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

  // Handle deleted entity - return tombstone info
  if (manifest.schema === 'arke/entity-deleted@v1') {
    const deleted = manifest as EntityDeletedV1;
    return {
      status: 'deleted',
      entity_id: deleted.entity_id,
      deleted_at: deleted.ts,
      deleted_ver: deleted.ver,
      prev_cid: deleted.prev['/'],
    };
  }

  const entity = manifest as EntityManifestV1;

  // Build components object with all component CIDs
  const componentsResponse: Record<string, string | undefined> = {};
  for (const [key, ipldLink] of Object.entries(entity.components)) {
    if (ipldLink && typeof ipldLink === 'object' && '/' in ipldLink) {
      componentsResponse[key] = ipldLink['/'];
    }
  }

  return {
    entity_id: entity.entity_id,
    ver: entity.ver,
    ts: entity.ts,
    manifest_cid: tipCid,
    prev_cid: entity.prev?.['/'] || null,
    type: entity.type,
    label: entity.label,
    description: entity.description,
    components: componentsResponse,
    source_pis: entity.source_pis,
    note: entity.note,
  };
}

/**
 * Get lightweight entity for context loading.
 * Follows redirect chain with cycle detection and max hop limit.
 */
export async function getEntityKGLightweight(
  ipfs: IPFSService,
  tipSvc: TipService,
  entityId: string
): Promise<LightweightEntity> {
  const resolved = await resolveEntityChain(ipfs, tipSvc, entityId);
  return toLightweight(resolved.manifest);
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
  backendURL: string,
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

  // Update arbitrary file components if provided
  if (req.components) {
    for (const [filename, cid] of Object.entries(req.components)) {
      if (cid) {
        // Add or update component
        components[filename] = link(cid);
      } else {
        // Empty string = remove component
        delete components[filename];
      }
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

  // Append update event to event stream (non-blocking, don't fail if this fails)
  try {
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi: entityId,
      ver: newManifest.ver,
      tip_cid: manifestCid,
    });
    console.log(`[EVENT] Appended update event for entity ${entityId}: ${eventCid}`);
  } catch (error) {
    console.error(`[EVENT] Failed to append update event for entity ${entityId}:`, error);
  }

  return {
    entity_id: entityId,
    ver: newManifest.ver,
    manifest_cid: manifestCid,
    tip: manifestCid,
  };
}

// Maximum retries for target update CAS failures
const MAX_TARGET_UPDATE_RETRIES = 5;

/**
 * Merge entity A into entity B (creates redirect version of A)
 *
 * Uses lock-then-check pattern to handle race conditions:
 * 1. Lock source by writing redirect
 * 2. Check if target became a redirect to us (cycle detection)
 * 3. If cycle: apply tiebreaker (smaller source ID wins)
 * 4. If no cycle: update target with source_pis
 *
 * This creates a redirect version of the source entity pointing to the target.
 * The source entity's history is preserved via the prev link.
 * The target entity gains the source's source_pis.
 */
export async function mergeEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  backendURL: string,
  sourceEntityId: string,
  targetEntityId: string,
  expectTip: string,
  note?: string
): Promise<MergeEntityResponse | MergeConflictResponse> {
  // ==========================================================================
  // STEP 1: VALIDATE SOURCE
  // ==========================================================================
  const sourceTip = await tipSvc.readEntityTip(sourceEntityId);
  if (!sourceTip) {
    throw new NotFoundError('Entity', sourceEntityId);
  }
  if (sourceTip !== expectTip) {
    throw new CASError({ actual: sourceTip, expect: expectTip });
  }

  const sourceManifest = (await ipfs.dagGet(sourceTip)) as EntityManifestV1 | EntityMergedV1;

  // Can't merge an already-merged entity
  if (sourceManifest.schema === 'arke/entity-merged@v1') {
    throw new ConflictError('Entity', `${sourceEntityId} has already been merged`);
  }

  const source = sourceManifest as EntityManifestV1;

  // ==========================================================================
  // STEP 2: VALIDATE TARGET (follow chain if already merged)
  // ==========================================================================
  let finalTargetId = targetEntityId;
  let resolved: ResolvedEntity;

  try {
    resolved = await resolveEntityChain(ipfs, tipSvc, targetEntityId);
    finalTargetId = resolved.entityId;
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new NotFoundError('Entity', targetEntityId);
    }
    throw e;
  }

  // If target chain leads back to source, that's already a problem
  if (finalTargetId === sourceEntityId) {
    throw new ConflictError('Entity', `Cannot merge ${sourceEntityId} into itself`);
  }

  const target = resolved.manifest;
  const initialTargetTip = resolved.tipCid;

  // ==========================================================================
  // STEP 3: LOCK SOURCE (create redirect)
  // ==========================================================================
  const mergeTs = new Date().toISOString();
  const mergedManifest: EntityMergedV1 = {
    schema: 'arke/entity-merged@v1',
    entity_id: sourceEntityId,
    ver: source.ver + 1,
    ts: mergeTs,
    prev: link(sourceTip),
    merged_into: finalTargetId, // Always point to final active entity
    note: note || `Merged into ${target.label}`,
  };

  const sourceMergedCid = await ipfs.dagPut(mergedManifest);
  await tipSvc.writeEntityTipAtomic(sourceEntityId, sourceMergedCid, sourceTip);

  console.log(`[ENTITY-KG] Locked source ${sourceEntityId} → ${finalTargetId}`);

  // ==========================================================================
  // STEP 4: CHECK FOR CYCLE (re-read target after locking source)
  // ==========================================================================
  const currentTargetTip = await tipSvc.readEntityTip(finalTargetId);
  if (!currentTargetTip) {
    // Target was deleted? Shouldn't happen, but restore source and error
    throw new ConflictError('Entity', `Target ${finalTargetId} disappeared during merge`);
  }

  const currentTargetManifest = (await ipfs.dagGet(currentTargetTip)) as EntityManifestV1 | EntityMergedV1;

  if (currentTargetManifest.schema === 'arke/entity-merged@v1') {
    const targetMerged = currentTargetManifest as EntityMergedV1;

    if (targetMerged.merged_into === sourceEntityId) {
      // =======================================================================
      // CYCLE DETECTED! Both entities merged into each other.
      // Apply tiebreaker: smaller source ID wins
      // =======================================================================
      console.log(`[ENTITY-KG] CYCLE DETECTED: ${sourceEntityId} ↔ ${finalTargetId}`);

      if (sourceEntityId < finalTargetId) {
        // =====================================================================
        // WE WIN - restore target from its prev, then update it
        // =====================================================================
        console.log(`[ENTITY-KG] Tiebreaker: ${sourceEntityId} < ${finalTargetId}, we win`);

        const originalTargetCid = targetMerged.prev['/'];
        const originalTarget = (await ipfs.dagGet(originalTargetCid)) as EntityManifestV1;

        // Combine source_pis from both entities
        const combinedSourcePis = [...new Set([...originalTarget.source_pis, ...source.source_pis])];

        // Merge all components (properties, relationships, file components)
        const mergedComponents = await mergeComponents(ipfs, source, originalTarget, note);

        const restoredTarget: EntityManifestV1 = {
          ...originalTarget,
          ver: originalTarget.ver + 2, // +1 for failed merge, +1 for restore
          ts: new Date().toISOString(),
          prev: link(currentTargetTip),
          components: mergedComponents,
          source_pis: combinedSourcePis,
          note: `Restored after merge conflict; absorbed ${source.label}`,
        };

        const restoredCid = await ipfs.dagPut(restoredTarget);

        try {
          await tipSvc.writeEntityTipAtomic(finalTargetId, restoredCid, currentTargetTip);
        } catch (e) {
          // If CAS fails, the other worker might have already handled it
          // Re-check target state
          const retryTip = await tipSvc.readEntityTip(finalTargetId);
          const retryManifest = (await ipfs.dagGet(retryTip!)) as EntityManifestV1 | EntityMergedV1;
          if (retryManifest.schema === 'arke/entity-merged@v1') {
            // Still merged - retry restore
            throw e;
          }
          // Target is now active - use its current state
          console.log(`[ENTITY-KG] Target already restored by other worker`);
          return {
            source_entity_id: sourceEntityId,
            merged_into: finalTargetId,
            source_new_ver: mergedManifest.ver,
            source_manifest_cid: sourceMergedCid,
            target_new_ver: (retryManifest as EntityManifestV1).ver,
            target_manifest_cid: retryTip!,
            conflict_resolved: true,
          };
        }

        console.log(`[ENTITY-KG] Cycle resolved: ${sourceEntityId} → ${finalTargetId} wins`);

        // Emit events for both source (merge redirect) and target (absorbed)
        try {
          await appendEvent(backendURL, {
            type: 'update',
            pi: sourceEntityId,
            ver: mergedManifest.ver,
            tip_cid: sourceMergedCid,
          });
          await appendEvent(backendURL, {
            type: 'update',
            pi: finalTargetId,
            ver: restoredTarget.ver,
            tip_cid: restoredCid,
          });
          console.log(`[EVENT] Appended merge events for ${sourceEntityId} → ${finalTargetId}`);
        } catch (error) {
          console.error(`[EVENT] Failed to append merge events:`, error);
        }

        return {
          source_entity_id: sourceEntityId,
          merged_into: finalTargetId,
          source_new_ver: mergedManifest.ver,
          source_manifest_cid: sourceMergedCid,
          target_new_ver: restoredTarget.ver,
          target_manifest_cid: restoredCid,
          conflict_resolved: true,
        };

      } else {
        // =====================================================================
        // WE LOSE - restore our source, return conflict
        // =====================================================================
        console.log(`[ENTITY-KG] Tiebreaker: ${sourceEntityId} > ${finalTargetId}, we lose`);

        const restoredSource: EntityManifestV1 = {
          ...source,
          ver: source.ver + 2, // +1 for failed merge, +1 for restore
          ts: new Date().toISOString(),
          prev: link(sourceMergedCid),
          note: `Restored after merge conflict (lost to ${finalTargetId})`,
        };

        const restoredCid = await ipfs.dagPut(restoredSource);

        try {
          await tipSvc.writeEntityTipAtomic(sourceEntityId, restoredCid, sourceMergedCid);
          console.log(`[ENTITY-KG] Restored source ${sourceEntityId} after losing tiebreaker`);
        } catch {
          // CAS fail means winner may have already touched our entity (rare)
          // Just return conflict - entity state will be correct
          console.log(`[ENTITY-KG] Source restore CAS failed, winner likely handled it`);
        }

        return {
          conflict: true,
          message: `Merge conflict: ${finalTargetId}→${sourceEntityId} won (smaller source ID)`,
          winner_source: finalTargetId,
          winner_target: sourceEntityId,
        };
      }
    }

    // Target merged into something else (not us) - RESTORE SOURCE and error
    // The caller should retry with the new target
    console.log(`[ENTITY-KG] Target ${finalTargetId} merged into ${targetMerged.merged_into} during operation, restoring source`);

    const restoredSource: EntityManifestV1 = {
      ...source,
      ver: source.ver + 2, // +1 for failed merge, +1 for restore
      ts: new Date().toISOString(),
      prev: link(sourceMergedCid),
      note: `Restored: target ${finalTargetId} was merged during operation`,
    };

    const restoredCid = await ipfs.dagPut(restoredSource);

    try {
      await tipSvc.writeEntityTipAtomic(sourceEntityId, restoredCid, sourceMergedCid);
      console.log(`[ENTITY-KG] Restored source ${sourceEntityId} after target-merged-during-operation`);
    } catch {
      // CAS fail is unlikely here but log it
      console.log(`[ENTITY-KG] Source restore CAS failed (unexpected)`);
    }

    throw new ConflictError(
      'Entity',
      `Target ${finalTargetId} was merged into ${targetMerged.merged_into} during operation. Source restored - please retry.`
    );
  }

  // ==========================================================================
  // STEP 5: NO CYCLE - Update target with source_pis (with retry)
  // ==========================================================================
  let attempts = 0;
  while (attempts < MAX_TARGET_UPDATE_RETRIES) {
    try {
      const latestTargetTip = await tipSvc.readEntityTip(finalTargetId);
      if (!latestTargetTip) {
        throw new ConflictError('Entity', `Target ${finalTargetId} disappeared`);
      }

      const latestTarget = (await ipfs.dagGet(latestTargetTip)) as EntityManifestV1 | EntityMergedV1;

      // Check again that target wasn't merged while we were retrying
      if (latestTarget.schema === 'arke/entity-merged@v1') {
        throw new ConflictError(
          'Entity',
          `Target ${finalTargetId} was merged during operation`
        );
      }

      const targetEntity = latestTarget as EntityManifestV1;
      const combinedSourcePis = [...new Set([...targetEntity.source_pis, ...source.source_pis])];

      // Merge all components (properties, relationships, file components)
      const mergedComponents = await mergeComponents(ipfs, source, targetEntity, note);

      const updatedTargetManifest: EntityManifestV1 = {
        ...targetEntity,
        ver: targetEntity.ver + 1,
        ts: new Date().toISOString(),
        prev: link(latestTargetTip),
        components: mergedComponents,
        source_pis: combinedSourcePis,
        note: `Absorbed entity ${source.label}`,
      };

      const updatedCid = await ipfs.dagPut(updatedTargetManifest);
      await tipSvc.writeEntityTipAtomic(finalTargetId, updatedCid, latestTargetTip);

      console.log(`[ENTITY-KG] Merged entity ${sourceEntityId} into ${finalTargetId}`);

      // Emit events for both source (merge redirect) and target (absorbed)
      try {
        await appendEvent(backendURL, {
          type: 'update',
          pi: sourceEntityId,
          ver: mergedManifest.ver,
          tip_cid: sourceMergedCid,
        });
        await appendEvent(backendURL, {
          type: 'update',
          pi: finalTargetId,
          ver: updatedTargetManifest.ver,
          tip_cid: updatedCid,
        });
        console.log(`[EVENT] Appended merge events for ${sourceEntityId} → ${finalTargetId}`);
      } catch (error) {
        console.error(`[EVENT] Failed to append merge events:`, error);
      }

      return {
        source_entity_id: sourceEntityId,
        merged_into: finalTargetId,
        source_new_ver: mergedManifest.ver,
        source_manifest_cid: sourceMergedCid,
        target_new_ver: updatedTargetManifest.ver,
        target_manifest_cid: updatedCid,
      };

    } catch (e) {
      // Retry on CAS failures for target update
      if (e instanceof Error && e.message.includes('CAS')) {
        attempts++;
        const delay = 50 * Math.pow(2, attempts) + Math.random() * 50;
        console.log(`[ENTITY-KG] Target update CAS retry ${attempts}/${MAX_TARGET_UPDATE_RETRIES}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }

  throw new ConflictError('Entity', `Max retries exceeded updating target ${finalTargetId}`);
}

// Maximum hops when walking version history
const MAX_HISTORY_HOPS = 100;

/**
 * Find a specific version in an entity's history by walking the prev chain.
 *
 * @param ipfs - IPFS service
 * @param startCid - CID to start from (current tip)
 * @param targetVer - Version number to find
 * @returns The manifest and CID at that version, or null if not found
 */
async function findVersionInHistory(
  ipfs: IPFSService,
  startCid: string,
  targetVer: number
): Promise<{ manifest: EntityManifestV1; cid: string } | null> {
  let currentCid = startCid;
  let hops = 0;

  while (hops < MAX_HISTORY_HOPS) {
    const manifest = (await ipfs.dagGet(currentCid)) as EntityManifestV1 | EntityMergedV1;

    // Check if this is the version we're looking for
    if (manifest.ver === targetVer) {
      // Must be a real entity manifest, not a merged redirect
      if (manifest.schema === 'arke/entity-merged@v1') {
        // This version is a merge redirect, not a real entity
        return null;
      }
      return { manifest: manifest as EntityManifestV1, cid: currentCid };
    }

    // If we've gone past the target version, it doesn't exist
    if (manifest.ver < targetVer) {
      return null;
    }

    // Follow prev link
    if (!manifest.prev) {
      return null;
    }

    currentCid = manifest.prev['/'];
    hops++;
  }

  throw new ValidationError(
    `Version history too deep (>${MAX_HISTORY_HOPS} hops)`,
    { startCid, targetVer }
  );
}

/**
 * Unmerge an entity - restore it from merged state back to active.
 *
 * This operation:
 * 1. Validates the entity is currently merged
 * 2. Finds the restore point (prev or specific version)
 * 3. Creates a new version with restored data
 * 4. Does NOT modify the target entity
 *
 * @param ipfs - IPFS service
 * @param tipSvc - Tip service
 * @param backendURL - Backend API URL for events
 * @param entityId - Entity ID to unmerge
 * @param expectTip - CAS guard (current tip CID)
 * @param options - Optional settings (restore_from_ver, note, skipSync)
 * @returns Response with restored entity details
 */
export async function unmergeEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  backendURL: string,
  entityId: string,
  expectTip: string,
  options?: {
    restoreFromVer?: number;
    note?: string;
    skipSync?: boolean;
  }
): Promise<UnmergeEntityResponse> {
  // ==========================================================================
  // STEP 1: VALIDATE - Entity must be merged
  // ==========================================================================
  const currentTip = await tipSvc.readEntityTip(entityId);
  if (!currentTip) {
    throw new NotFoundError('Entity', entityId);
  }

  // CAS check
  if (currentTip !== expectTip) {
    throw new CASError({ actual: currentTip, expect: expectTip });
  }

  const currentManifest = (await ipfs.dagGet(currentTip)) as EntityManifestV1 | EntityMergedV1;

  // Must be a merged entity
  if (currentManifest.schema !== 'arke/entity-merged@v1') {
    throw new ValidationError(
      `Entity is not merged (schema: ${currentManifest.schema})`,
      { entityId, schema: currentManifest.schema }
    );
  }

  const mergedManifest = currentManifest as EntityMergedV1;
  const wasMergedInto = mergedManifest.merged_into;

  console.log(`[ENTITY-KG] Unmerging entity ${entityId} (was merged into ${wasMergedInto})`);

  // ==========================================================================
  // STEP 2: FIND RESTORE POINT
  // ==========================================================================
  let restoreManifest: EntityManifestV1;
  let restoreCid: string;

  if (options?.restoreFromVer !== undefined) {
    // Find specific version in history
    const found = await findVersionInHistory(ipfs, currentTip, options.restoreFromVer);
    if (!found) {
      throw new NotFoundError('Version', `${options.restoreFromVer} in entity ${entityId}`);
    }
    restoreManifest = found.manifest;
    restoreCid = found.cid;
  } else {
    // Use prev link (last version before merge)
    const prevCid = mergedManifest.prev['/'];
    const prevManifest = (await ipfs.dagGet(prevCid)) as EntityManifestV1 | EntityMergedV1;

    // Prev should be a real entity manifest
    if (prevManifest.schema === 'arke/entity-merged@v1') {
      throw new ValidationError(
        'Previous version is also a merge redirect - cannot restore',
        { entityId, prevCid }
      );
    }

    restoreManifest = prevManifest as EntityManifestV1;
    restoreCid = prevCid;
  }

  console.log(`[ENTITY-KG] Restoring from v${restoreManifest.ver} (cid: ${restoreCid})`);

  // ==========================================================================
  // STEP 3: BUILD RESTORED MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();

  const restoredManifest: EntityManifestV1 = {
    schema: 'arke/entity@v1',
    entity_id: entityId,
    created_by_pi: restoreManifest.created_by_pi,
    created_at: restoreManifest.created_at,
    ver: mergedManifest.ver + 1,
    ts: now,
    prev: link(currentTip), // Link to merged version (maintains full history)
    type: restoreManifest.type,
    label: restoreManifest.label,
    description: restoreManifest.description,
    components: restoreManifest.components,
    source_pis: restoreManifest.source_pis,
    note: options?.note || `Restored from merge (was merged into ${wasMergedInto})`,
  };

  // ==========================================================================
  // STEP 4: WRITE ATOMICALLY
  // ==========================================================================
  const restoredCid = await ipfs.dagPut(restoredManifest);
  await tipSvc.writeEntityTipAtomic(entityId, restoredCid, currentTip);

  console.log(`[ENTITY-KG] Unmerged entity ${entityId} to v${restoredManifest.ver}`);

  // ==========================================================================
  // STEP 5: APPEND EVENT
  // ==========================================================================
  try {
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi: entityId,
      ver: restoredManifest.ver,
      tip_cid: restoredCid,
    });
    console.log(`[EVENT] Appended unmerge event for entity ${entityId}: ${eventCid}`);
  } catch (error) {
    console.error(`[EVENT] Failed to append unmerge event for entity ${entityId}:`, error);
  }

  return {
    entity_id: entityId,
    restored_from_ver: restoreManifest.ver,
    new_ver: restoredManifest.ver,
    new_manifest_cid: restoredCid,
    was_merged_into: wasMergedInto,
  };
}

/**
 * Delete an entity - creates a tombstone manifest preserving history.
 *
 * This operation:
 * 1. Validates the entity exists and is active (not merged/deleted)
 * 2. Creates a tombstone manifest with only prev link
 * 3. History is preserved via the prev chain
 *
 * @param ipfs - IPFS service
 * @param tipSvc - Tip service
 * @param backendURL - Backend API URL for events
 * @param entityId - Entity ID to delete
 * @param expectTip - CAS guard (current tip CID)
 * @param options - Optional settings (deletedByPi, note, skipSync)
 * @returns Response with deletion details
 */
export async function deleteEntityKG(
  ipfs: IPFSService,
  tipSvc: TipService,
  backendURL: string,
  entityId: string,
  expectTip: string,
  options?: {
    deletedByPi?: string;
    note?: string;
    skipSync?: boolean;
  }
): Promise<DeleteEntityResponse> {
  // ==========================================================================
  // STEP 1: VALIDATE - Entity must exist and be active
  // ==========================================================================
  const currentTip = await tipSvc.readEntityTip(entityId);
  if (!currentTip) {
    throw new NotFoundError('Entity', entityId);
  }

  // CAS check
  if (currentTip !== expectTip) {
    throw new CASError({ actual: currentTip, expect: expectTip });
  }

  const currentManifest = (await ipfs.dagGet(currentTip)) as EntityManifestV1 | EntityMergedV1 | EntityDeletedV1;

  // Check if already deleted
  if (currentManifest.schema === 'arke/entity-deleted@v1') {
    throw new ValidationError(
      `Entity ${entityId} is already deleted`,
      { entityId, schema: currentManifest.schema }
    );
  }

  // Check if merged (can't delete a merged entity - unmerge first or delete the target)
  if (currentManifest.schema === 'arke/entity-merged@v1') {
    const merged = currentManifest as EntityMergedV1;
    throw new ValidationError(
      `Entity ${entityId} is merged into ${merged.merged_into}. Unmerge first or delete the target entity.`,
      { entityId, mergedInto: merged.merged_into }
    );
  }

  const activeManifest = currentManifest as EntityManifestV1;

  console.log(`[ENTITY-KG] Deleting entity ${entityId} (label: ${activeManifest.label})`);

  // ==========================================================================
  // STEP 2: BUILD TOMBSTONE MANIFEST
  // ==========================================================================
  const now = new Date().toISOString();

  const deletedManifest: EntityDeletedV1 = {
    schema: 'arke/entity-deleted@v1',
    entity_id: entityId,
    ver: activeManifest.ver + 1,
    ts: now,
    prev: link(currentTip), // Preserves history
    ...(options?.deletedByPi && { deleted_by_pi: options.deletedByPi }),
    ...(options?.note && { note: options.note }),
  };

  // ==========================================================================
  // STEP 3: WRITE ATOMICALLY
  // ==========================================================================
  const deletedCid = await ipfs.dagPut(deletedManifest);
  await tipSvc.writeEntityTipAtomic(entityId, deletedCid, currentTip);

  console.log(`[ENTITY-KG] Deleted entity ${entityId} (v${deletedManifest.ver})`);

  // ==========================================================================
  // STEP 4: APPEND EVENT
  // ==========================================================================
  try {
    const eventCid = await appendEvent(backendURL, {
      type: 'update',
      pi: entityId,
      ver: deletedManifest.ver,
      tip_cid: deletedCid,
    });
    console.log(`[EVENT] Appended delete event for entity ${entityId}: ${eventCid}`);
  } catch (error) {
    console.error(`[EVENT] Failed to append delete event for entity ${entityId}:`, error);
  }

  return {
    entity_id: entityId,
    deleted_ver: deletedManifest.ver,
    deleted_manifest_cid: deletedCid,
    previous_ver: activeManifest.ver,
    previous_manifest_cid: currentTip,
  };
}
