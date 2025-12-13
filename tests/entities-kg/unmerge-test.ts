#!/usr/bin/env tsx
/**
 * Entity Unmerge Test
 *
 * Tests the unmerge functionality:
 * 1. Basic unmerge - merged entity restored to active state
 * 2. CAS failure - expect_tip doesn't match
 * 3. Not merged error - entity is active, not merged
 * 4. Restore from specific version
 * 5. Version not found in history
 * 6. Relationships restored from prev manifest
 *
 * Run: npx tsx tests/entities-kg/unmerge-test.ts
 */

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = process.env.NETWORK || 'test';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

// Test statistics
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function pass(message: string) {
  log('green', `  PASS: ${message}`);
  passedTests++;
  totalTests++;
}

function fail(message: string, error?: any) {
  log('red', `  FAIL: ${message}`);
  if (error) {
    console.error('    ', error);
  }
  failedTests++;
  totalTests++;
}

function info(message: string) {
  log('cyan', `  INFO: ${message}`);
}

function section(title: string) {
  console.log('');
  log('magenta', `${'='.repeat(70)}`);
  log('magenta', `  ${title}`);
  log('magenta', `${'='.repeat(70)}`);
}

function subsection(title: string) {
  console.log('');
  log('blue', `  -- ${title} --`);
}

// API helpers
async function apiRequest(
  method: string,
  path: string,
  body?: any
): Promise<{ status: number; data: any }> {
  const url = `${API_ENDPOINT}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': NETWORK,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  return { status: response.status, data };
}

async function createSourcePI(): Promise<{ pi: string; tip: string }> {
  const formData = new FormData();
  const blob = new Blob(['test source data for unmerge'], { type: 'text/plain' });
  formData.append('file', blob, 'source.txt');

  const uploadResponse = await fetch(`${API_ENDPOINT}/upload`, {
    method: 'POST',
    body: formData,
  });
  const uploadData = await uploadResponse.json();
  const cid = uploadData[0].cid;

  const response = await fetch(`${API_ENDPOINT}/entities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': NETWORK,
    },
    body: JSON.stringify({
      components: { data: cid },
      note: 'Test source PI for unmerge tests',
    }),
  });

  const data = await response.json();
  return { pi: data.pi, tip: data.tip };
}

interface EntityResult {
  entity_id: string;
  manifest_cid: string;
  ver: number;
}

async function createEntity(
  sourcePI: string,
  type: string,
  label: string,
  options?: {
    properties?: Record<string, any>;
    relationships?: Array<{
      predicate: string;
      target_type: 'entity' | 'pi';
      target_id: string;
      target_label: string;
    }>;
  }
): Promise<EntityResult> {
  const { status, data } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI,
    type,
    label,
    description: `Test entity: ${label}`,
    properties: options?.properties,
    relationships: options?.relationships,
  });

  if (status !== 201) {
    throw new Error(`Failed to create entity: ${JSON.stringify(data)}`);
  }

  return {
    entity_id: data.entity_id,
    manifest_cid: data.manifest_cid,
    ver: data.ver,
  };
}

async function getEntity(entityId: string): Promise<any> {
  const { status, data } = await apiRequest('GET', `/entities-kg/${entityId}`);
  return data;
}

async function mergeEntity(
  sourceId: string,
  targetId: string,
  expectTip: string,
  note?: string
): Promise<{ status: number; data: any }> {
  return apiRequest('POST', `/entities-kg/${sourceId}/merge`, {
    expect_tip: expectTip,
    merge_into: targetId,
    note: note || 'Test merge',
    skip_sync: true, // Skip index-sync for tests
  });
}

async function unmergeEntity(
  entityId: string,
  expectTip: string,
  options?: {
    restore_from_ver?: number;
    note?: string;
  }
): Promise<{ status: number; data: any }> {
  return apiRequest('POST', `/entities-kg/${entityId}/unmerge`, {
    expect_tip: expectTip,
    ...options,
    skip_sync: true, // Skip index-sync for tests
  });
}

// =============================================================================
// TESTS
// =============================================================================

async function testBasicUnmerge() {
  section('Test 1: Basic Unmerge');

  // Create source PI
  const { pi: sourcePI } = await createSourcePI();
  info(`Created source PI: ${sourcePI}`);

  // Create two entities
  const entityA = await createEntity(sourcePI, 'person', 'Test Person A', {
    properties: { occupation: 'Engineer', age: 30 },
  });
  info(`Created entity A: ${entityA.entity_id} (v${entityA.ver})`);

  const entityB = await createEntity(sourcePI, 'person', 'Test Person B', {
    properties: { occupation: 'Doctor' },
  });
  info(`Created entity B: ${entityB.entity_id} (v${entityB.ver})`);

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);
  if (mergeResult.status !== 201) {
    fail('Merge should succeed', mergeResult.data);
    return;
  }
  pass('Merge succeeded');
  info(`Source new ver: ${mergeResult.data.source_new_ver}`);

  // Verify A is merged
  const mergedA = await getEntity(entityA.entity_id);
  if (mergedA.status !== 'merged') {
    fail('Entity A should show merged status');
    return;
  }
  pass('Entity A shows merged status');
  info(`Merged into: ${mergedA.merged_into}`);
  info(`Prev CID: ${mergedA.prev_cid}`);

  // Unmerge A
  subsection('Unmerging entity A');
  const unmergeResult = await unmergeEntity(entityA.entity_id, mergeResult.data.source_manifest_cid);

  if (unmergeResult.status !== 201) {
    fail('Unmerge should succeed', unmergeResult.data);
    return;
  }
  pass('Unmerge succeeded');
  info(`Restored from ver: ${unmergeResult.data.restored_from_ver}`);
  info(`New ver: ${unmergeResult.data.new_ver}`);
  info(`Was merged into: ${unmergeResult.data.was_merged_into}`);

  // Verify A is restored
  const restoredA = await getEntity(entityA.entity_id);
  if (restoredA.status === 'merged') {
    fail('Entity A should no longer be merged');
    return;
  }
  pass('Entity A is no longer merged');

  // Verify original data is restored
  if (restoredA.type !== 'person') {
    fail(`Type should be 'person', got '${restoredA.type}'`);
  } else {
    pass('Type restored correctly');
  }

  if (restoredA.label !== 'Test Person A') {
    fail(`Label should be 'Test Person A', got '${restoredA.label}'`);
  } else {
    pass('Label restored correctly');
  }

  // Version should be incremented
  if (restoredA.ver !== entityA.ver + 2) {
    // +1 for merge, +1 for unmerge
    fail(`Version should be ${entityA.ver + 2}, got ${restoredA.ver}`);
  } else {
    pass('Version incremented correctly');
  }
}

async function testUnmergeCASFailure() {
  section('Test 2: Unmerge CAS Failure');

  const { pi: sourcePI } = await createSourcePI();

  const entityA = await createEntity(sourcePI, 'person', 'CAS Test Person A');
  const entityB = await createEntity(sourcePI, 'person', 'CAS Test Person B');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);
  if (mergeResult.status !== 201) {
    fail('Merge should succeed');
    return;
  }

  // Try to unmerge with wrong expect_tip
  const wrongTip = 'bafyreiwrongcidthatwillnotmatch12345678901234567890123456';
  const unmergeResult = await unmergeEntity(entityA.entity_id, wrongTip);

  if (unmergeResult.status !== 409) {
    fail(`Should get 409 CAS failure, got ${unmergeResult.status}`, unmergeResult.data);
    return;
  }
  pass('Got expected 409 CAS failure');

  if (!unmergeResult.data.error?.includes('CAS') && !unmergeResult.data.message?.includes('CAS')) {
    fail('Error should mention CAS', unmergeResult.data);
  } else {
    pass('Error message mentions CAS');
  }
}

async function testUnmergeNotMerged() {
  section('Test 3: Unmerge Non-Merged Entity');

  const { pi: sourcePI } = await createSourcePI();

  // Create an entity but don't merge it
  const entity = await createEntity(sourcePI, 'person', 'Not Merged Person');
  info(`Created entity: ${entity.entity_id}`);

  // Try to unmerge an entity that isn't merged
  const unmergeResult = await unmergeEntity(entity.entity_id, entity.manifest_cid);

  if (unmergeResult.status !== 400) {
    fail(`Should get 400 validation error, got ${unmergeResult.status}`, unmergeResult.data);
    return;
  }
  pass('Got expected 400 validation error');

  if (!unmergeResult.data.message?.includes('not merged')) {
    fail('Error should mention entity is not merged', unmergeResult.data);
  } else {
    pass('Error message indicates entity is not merged');
  }
}

async function testUnmergeWithRelationships() {
  section('Test 4: Unmerge Restores Relationships');

  const { pi: sourcePI } = await createSourcePI();

  // Create target entity first (for relationship target)
  const targetEntity = await createEntity(sourcePI, 'organization', 'Test Company');
  info(`Created target entity: ${targetEntity.entity_id}`);

  // Create entity with relationships
  const entityA = await createEntity(sourcePI, 'person', 'Person With Relationships', {
    relationships: [
      {
        predicate: 'WORKS_AT',
        target_type: 'entity',
        target_id: targetEntity.entity_id,
        target_label: 'Test Company',
      },
    ],
  });
  info(`Created entity A with relationships: ${entityA.entity_id}`);

  // Create entity B
  const entityB = await createEntity(sourcePI, 'person', 'Person B');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);
  if (mergeResult.status !== 201) {
    fail('Merge should succeed');
    return;
  }
  pass('Merge succeeded');

  // Unmerge A
  const unmergeResult = await unmergeEntity(entityA.entity_id, mergeResult.data.source_manifest_cid);
  if (unmergeResult.status !== 201) {
    fail('Unmerge should succeed', unmergeResult.data);
    return;
  }
  pass('Unmerge succeeded');

  // Verify relationships are restored
  const restoredA = await getEntity(entityA.entity_id);
  if (!restoredA.components?.relationships) {
    fail('Relationships component should be restored');
    return;
  }
  pass('Relationships component restored');
  info(`Relationships CID: ${restoredA.components.relationships}`);
}

async function testUnmergeRestoreFromSpecificVersion() {
  section('Test 5: Unmerge Restore From Specific Version');

  const { pi: sourcePI } = await createSourcePI();

  // Create entity
  const entityA = await createEntity(sourcePI, 'person', 'Version Test Person', {
    properties: { version: 1 },
  });
  info(`Created entity A v1: ${entityA.entity_id}`);

  // Update entity to create v2
  const updateResult = await apiRequest('POST', `/entities-kg/${entityA.entity_id}/versions`, {
    expect_tip: entityA.manifest_cid,
    label: 'Version Test Person v2',
    properties: { version: 2, updated: true },
  });
  if (updateResult.status !== 201) {
    fail('Update should succeed');
    return;
  }
  info(`Updated to v2: ${updateResult.data.manifest_cid}`);

  // Create entity B for merge
  const entityB = await createEntity(sourcePI, 'person', 'Target Person');

  // Merge A into B (now at v3 as merged)
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, updateResult.data.manifest_cid);
  if (mergeResult.status !== 201) {
    fail('Merge should succeed');
    return;
  }
  pass('Merge succeeded (A is now v3)');

  // Unmerge A, restoring from v1 specifically (skipping v2)
  const unmergeResult = await unmergeEntity(entityA.entity_id, mergeResult.data.source_manifest_cid, {
    restore_from_ver: 1,
    note: 'Restoring to original v1',
  });

  if (unmergeResult.status !== 201) {
    fail('Unmerge with specific version should succeed', unmergeResult.data);
    return;
  }
  pass('Unmerge from specific version succeeded');

  if (unmergeResult.data.restored_from_ver !== 1) {
    fail(`Should restore from ver 1, got ${unmergeResult.data.restored_from_ver}`);
  } else {
    pass('Restored from correct version (v1)');
  }

  // Verify the label is from v1, not v2
  const restoredA = await getEntity(entityA.entity_id);
  if (restoredA.label !== 'Version Test Person') {
    fail(`Label should be v1's label, got '${restoredA.label}'`);
  } else {
    pass('Label restored from v1 (not v2)');
  }
}

async function testUnmergeVersionNotFound() {
  section('Test 6: Unmerge Version Not Found');

  const { pi: sourcePI } = await createSourcePI();

  const entityA = await createEntity(sourcePI, 'person', 'Not Found Version Test');
  const entityB = await createEntity(sourcePI, 'person', 'Target');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);
  if (mergeResult.status !== 201) {
    fail('Merge should succeed');
    return;
  }

  // Try to restore from a version that doesn't exist
  const unmergeResult = await unmergeEntity(entityA.entity_id, mergeResult.data.source_manifest_cid, {
    restore_from_ver: 999,
  });

  if (unmergeResult.status !== 404) {
    fail(`Should get 404 for non-existent version, got ${unmergeResult.status}`, unmergeResult.data);
    return;
  }
  pass('Got expected 404 for non-existent version');
}

async function testMergeUnmergeCycle() {
  section('Test 7: Merge/Unmerge Cycle (History Integrity)');

  const { pi: sourcePI } = await createSourcePI();

  const entityA = await createEntity(sourcePI, 'person', 'Cycle Test Person', {
    properties: { initial: true },
  });
  info(`Created entity A v1: ${entityA.entity_id}`);

  const entityB = await createEntity(sourcePI, 'person', 'Target Person');

  // Merge A into B (A becomes v2)
  const merge1 = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);
  if (merge1.status !== 201) {
    fail('First merge should succeed');
    return;
  }
  pass('First merge: A -> B (A is now v2)');

  // Unmerge A (A becomes v3)
  const unmerge1 = await unmergeEntity(entityA.entity_id, merge1.data.source_manifest_cid);
  if (unmerge1.status !== 201) {
    fail('First unmerge should succeed');
    return;
  }
  pass('First unmerge: A restored (A is now v3)');

  // Merge again (A becomes v4)
  const currentA = await getEntity(entityA.entity_id);
  const merge2 = await mergeEntity(entityA.entity_id, entityB.entity_id, currentA.manifest_cid);
  if (merge2.status !== 201) {
    fail('Second merge should succeed');
    return;
  }
  pass('Second merge: A -> B again (A is now v4)');

  // Unmerge again (A becomes v5)
  const unmerge2 = await unmergeEntity(entityA.entity_id, merge2.data.source_manifest_cid);
  if (unmerge2.status !== 201) {
    fail('Second unmerge should succeed');
    return;
  }
  pass('Second unmerge: A restored again (A is now v5)');

  // Verify final state
  const finalA = await getEntity(entityA.entity_id);

  if (finalA.ver !== 5) {
    fail(`Version should be 5, got ${finalA.ver}`);
  } else {
    pass('Final version is correct (v5)');
  }

  if (finalA.status === 'merged') {
    fail('Entity should not be merged');
  } else {
    pass('Entity is active (not merged)');
  }

  if (finalA.label !== 'Cycle Test Person') {
    fail(`Label should be preserved, got '${finalA.label}'`);
  } else {
    pass('Label preserved through merge/unmerge cycles');
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('');
  log('cyan', '╔════════════════════════════════════════════════════════════════════╗');
  log('cyan', '║              Entity Unmerge Test Suite                             ║');
  log('cyan', '╠════════════════════════════════════════════════════════════════════╣');
  log('cyan', `║  Endpoint: ${API_ENDPOINT.padEnd(55)}║`);
  log('cyan', `║  Network:  ${NETWORK.padEnd(55)}║`);
  log('cyan', '╚════════════════════════════════════════════════════════════════════╝');

  try {
    await testBasicUnmerge();
    await testUnmergeCASFailure();
    await testUnmergeNotMerged();
    await testUnmergeWithRelationships();
    await testUnmergeRestoreFromSpecificVersion();
    await testUnmergeVersionNotFound();
    await testMergeUnmergeCycle();

    // Summary
    console.log('');
    log('magenta', '═'.repeat(70));
    log('magenta', '  TEST SUMMARY');
    log('magenta', '═'.repeat(70));
    console.log('');
    log('cyan', `  Total tests: ${totalTests}`);
    log('green', `  Passed:      ${passedTests}`);
    if (failedTests > 0) {
      log('red', `  Failed:      ${failedTests}`);
    } else {
      log('cyan', `  Failed:      ${failedTests}`);
    }
    console.log('');

    if (failedTests === 0) {
      log('green', '  ✓ All tests passed!');
    } else {
      log('red', `  ✗ ${failedTests} test(s) failed`);
      process.exit(1);
    }
  } catch (error) {
    console.error('');
    log('red', 'Test suite failed with error:');
    console.error(error);
    process.exit(1);
  }
}

main();
