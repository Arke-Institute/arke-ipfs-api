import { IPFSService } from '../ipfs';
import { TipService } from '../tip';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { Eidos, EidosMerged, IPLDLink, link } from '../../types/eidos';
import { RelationshipsComponent } from '../../types/relationships';

// Maximum number of redirect hops to follow before failing
const MAX_CHAIN_HOPS = 10;

/**
 * Result of resolving an entity through its redirect chain
 */
export interface ResolvedEntity {
  id: string;
  tipCid: string;
  manifest: Eidos;
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
  startId: string
): Promise<ResolvedEntity> {
  const seen = new Set<string>();
  let currentId = startId;
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
        { start: startId, hops, lastSeen: currentId }
      );
    }

    // Read entity
    const tipCid = await tipSvc.readTip(currentId);
    if (!tipCid) {
      throw new NotFoundError('Entity', currentId);
    }

    const manifest = (await ipfs.dagGet(tipCid)) as Eidos | EidosMerged;

    // If not merged, we found the active entity
    if (manifest.schema !== 'arke/eidos-merged@v1') {
      return {
        id: currentId,
        tipCid,
        manifest: manifest as Eidos,
        hops,
      };
    }

    // Follow redirect
    const merged = manifest as EidosMerged;
    currentId = merged.merged_into;
    hops++;
  }
}

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
export async function mergeComponents(
  ipfs: IPFSService,
  source: Eidos,
  target: Eidos,
  note?: string
): Promise<Eidos['components']> {
  const now = new Date().toISOString();
  const merged: Eidos['components'] = {};

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
 * Helper to convert plain CID record to IPLD link record
 */
export function componentsToLinks(components: Record<string, string>): Record<string, IPLDLink> {
  return Object.fromEntries(
    Object.entries(components).map(([label, cid]) => [label, link(cid)])
  );
}

/**
 * Helper to convert IPLD link record to plain CID record
 */
export function linksToComponents(components: Record<string, IPLDLink>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(components).map(([label, linkObj]) => [label, linkObj['/']])
  );
}
