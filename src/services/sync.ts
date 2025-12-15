/**
 * Index Sync Service Helper
 *
 * Fire-and-forget sync calls to index-sync worker after IPFS writes.
 * These calls update GraphDB and Pinecone indexes in real-time.
 */

import { Env } from '../types/env';
import { Network } from '../types/network';

type EntitySyncEvent = 'created' | 'updated' | 'merged' | 'unmerged' | 'deleted';
type PISyncEvent = 'created' | 'updated';
type EidosSyncEvent = 'created' | 'updated' | 'merged' | 'unmerged' | 'deleted' | 'undeleted';

interface EntitySyncRequest {
  entity_id: string;
  network: Network;
  event: EntitySyncEvent;
  merged_into?: string;      // For 'merged' event
  was_merged_into?: string;  // For 'unmerged' event
}

interface PISyncRequest {
  pi: string;
  network: Network;
  event: PISyncEvent;
}

interface EidosSyncRequest {
  id: string;
  network: Network;
  event: EidosSyncEvent;
  merged_into?: string;  // For 'merged' event
}

/**
 * Fire-and-forget entity sync to index-sync service.
 * Returns a Promise that can be passed to ctx.waitUntil().
 * Never throws - logs errors and continues.
 */
export function syncEntity(env: Env, event: EntitySyncRequest): Promise<void> {
  return env.INDEX_SYNC.fetch('https://index-sync/sync/entity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[Sync] Entity sync failed for ${event.entity_id}: ${res.status}`);
      } else {
        console.log(`[Sync] Entity sync queued: ${event.entity_id} event=${event.event}`);
      }
    })
    .catch((err) => {
      console.error(`[Sync] Entity sync error for ${event.entity_id}:`, err);
    });
}

/**
 * Fire-and-forget PI sync to index-sync service.
 * Returns a Promise that can be passed to ctx.waitUntil().
 * Never throws - logs errors and continues.
 */
export function syncPI(env: Env, event: PISyncRequest): Promise<void> {
  return env.INDEX_SYNC.fetch('https://index-sync/sync/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[Sync] PI sync failed for ${event.pi}: ${res.status}`);
      } else {
        console.log(`[Sync] PI sync queued: ${event.pi} event=${event.event}`);
      }
    })
    .catch((err) => {
      console.error(`[Sync] PI sync error for ${event.pi}:`, err);
    });
}

/**
 * Fire-and-forget unified eidos sync to index-sync service.
 * Returns a Promise that can be passed to ctx.waitUntil().
 * Never throws - logs errors and continues.
 */
export function syncEidos(env: Env, event: EidosSyncRequest): Promise<void> {
  return env.INDEX_SYNC.fetch('https://index-sync/sync/eidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[Sync] Eidos sync failed for ${event.id}: ${res.status}`);
      } else {
        console.log(`[Sync] Eidos sync queued: ${event.id} event=${event.event}`);
      }
    })
    .catch((err) => {
      console.error(`[Sync] Eidos sync error for ${event.id}:`, err);
    });
}
