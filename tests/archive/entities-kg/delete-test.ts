#!/usr/bin/env tsx
/**
 * Delete Entity Test Suite
 *
 * Tests the delete endpoint for entities-kg.
 * Uses skip_sync: true to avoid triggering index-sync during tests.
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'https://api.arke.institute';
const NETWORK = 'test';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function apiRequest(method: string, path: string, body?: any) {
  const response = await fetch(`${API_ENDPOINT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': NETWORK,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

function test(name: string, passed: boolean, error?: string) {
  results.push({ name, passed, error });
  console.log(passed ? `  [PASS] ${name}` : `  [FAIL] ${name}: ${error}`);
}

async function createTestPI(): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob(['test content for delete tests']), 'test.txt');
  const uploadRes = await fetch(`${API_ENDPOINT}/upload`, { method: 'POST', body: formData });
  const uploadData = await uploadRes.json();

  const piRes = await fetch(`${API_ENDPOINT}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arke-Network': NETWORK },
    body: JSON.stringify({ components: { data: uploadData[0].cid } }),
  });
  return (await piRes.json()).pi;
}

async function main() {
  console.log('=== Delete Entity Test Suite ===\n');
  console.log(`Target: ${API_ENDPOINT}`);
  console.log(`Network: ${NETWORK}\n`);

  // Create a source PI for entity creation
  console.log('Creating source PI...');
  const sourcePi = await createTestPI();
  console.log(`  Source PI: ${sourcePi}\n`);

  // ========================================================================
  // Test 1: Delete active entity
  // ========================================================================
  console.log('Test 1: Delete active entity');
  const entity1 = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'Delete Test Person',
    properties: { role: 'test-subject' },
  });
  test('Create entity', entity1.status === 201, `status=${entity1.status}`);

  const deleteRes = await apiRequest('POST', `/entities-kg/${entity1.data.entity_id}/delete`, {
    expect_tip: entity1.data.manifest_cid,
    note: 'Test deletion',
    skip_sync: true,
  });
  test('Delete returns 201', deleteRes.status === 201, `status=${deleteRes.status}`);
  test('Delete returns entity_id', deleteRes.data.entity_id === entity1.data.entity_id);
  test('Delete returns deleted_ver', deleteRes.data.deleted_ver === 2);
  test('Delete returns previous_ver', deleteRes.data.previous_ver === 1);

  // Verify entity shows as deleted
  const getDeleted = await apiRequest('GET', `/entities-kg/${entity1.data.entity_id}`);
  test('Get deleted entity returns status=deleted', getDeleted.data.status === 'deleted');
  test('Get deleted entity has prev_cid', !!getDeleted.data.prev_cid);

  // ========================================================================
  // Test 2: Delete already deleted entity returns 400
  // ========================================================================
  console.log('\nTest 2: Delete already deleted entity');
  const deleteAgain = await apiRequest('POST', `/entities-kg/${entity1.data.entity_id}/delete`, {
    expect_tip: deleteRes.data.deleted_manifest_cid,
    skip_sync: true,
  });
  test('Delete already deleted returns 400', deleteAgain.status === 400, `status=${deleteAgain.status}`);
  test('Error mentions already deleted', deleteAgain.data.message?.includes('already deleted'));

  // ========================================================================
  // Test 3: Delete merged entity returns 400
  // ========================================================================
  console.log('\nTest 3: Delete merged entity');
  const entityA = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'Merge Source for Delete Test',
  });
  const entityB = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'Merge Target for Delete Test',
  });

  // Merge A into B
  const mergeRes = await apiRequest('POST', `/entities-kg/${entityA.data.entity_id}/merge`, {
    expect_tip: entityA.data.manifest_cid,
    merge_into: entityB.data.entity_id,
    skip_sync: true,
  });
  test('Merge succeeds', mergeRes.status === 201, `status=${mergeRes.status}`);

  // Try to delete the merged entity
  const deleteMerged = await apiRequest('POST', `/entities-kg/${entityA.data.entity_id}/delete`, {
    expect_tip: mergeRes.data.source_manifest_cid,
    skip_sync: true,
  });
  test('Delete merged entity returns 400', deleteMerged.status === 400, `status=${deleteMerged.status}`);
  test('Error mentions merged', deleteMerged.data.message?.includes('merged'));

  // ========================================================================
  // Test 4: Delete non-existent entity returns 404
  // ========================================================================
  console.log('\nTest 4: Delete non-existent entity');
  const fakeId = 'II' + 'A'.repeat(24);
  const deleteNonExistent = await apiRequest('POST', `/entities-kg/${fakeId}/delete`, {
    expect_tip: 'bafyreifake123',
    skip_sync: true,
  });
  test('Delete non-existent returns 404', deleteNonExistent.status === 404, `status=${deleteNonExistent.status}`);

  // ========================================================================
  // Test 5: Delete with wrong expect_tip returns 409
  // ========================================================================
  console.log('\nTest 5: Delete with wrong expect_tip');
  const entity5 = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'CAS Test Person',
  });

  const deleteWrongTip = await apiRequest('POST', `/entities-kg/${entity5.data.entity_id}/delete`, {
    expect_tip: 'bafyreiwrongtip123',
    skip_sync: true,
  });
  test('Delete with wrong expect_tip returns 409', deleteWrongTip.status === 409, `status=${deleteWrongTip.status}`);

  // ========================================================================
  // Test 6: Verify history preserved after delete
  // ========================================================================
  console.log('\nTest 6: Verify history preserved after delete');
  const entity6 = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'organization',
    label: 'History Test Org',
    properties: { original: 'data' },
  });

  // Update to create v2
  const update6 = await apiRequest('POST', `/entities-kg/${entity6.data.entity_id}/versions`, {
    expect_tip: entity6.data.manifest_cid,
    label: 'History Test Org Updated',
  });
  test('Update creates v2', update6.data.ver === 2);

  // Delete
  const delete6 = await apiRequest('POST', `/entities-kg/${entity6.data.entity_id}/delete`, {
    expect_tip: update6.data.manifest_cid,
    deleted_by_pi: sourcePi,
    note: 'Testing history preservation',
    skip_sync: true,
  });
  test('Delete creates v3', delete6.data.deleted_ver === 3);

  // Verify deleted state has prev_cid we can follow
  const getFinal = await apiRequest('GET', `/entities-kg/${entity6.data.entity_id}`);
  test('Deleted entity has prev_cid', !!getFinal.data.prev_cid);
  test('prev_cid matches update manifest', getFinal.data.prev_cid === update6.data.manifest_cid);

  // ========================================================================
  // Test 7: Delete entity that others merged INTO (allowed)
  // ========================================================================
  console.log('\nTest 7: Delete entity that others merged into');
  const sourceEntity = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'Will Merge Into Target',
  });
  const targetEntity = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePi,
    type: 'person',
    label: 'Target That Gets Deleted',
  });

  // Merge source into target
  const mergeIntoTarget = await apiRequest('POST', `/entities-kg/${sourceEntity.data.entity_id}/merge`, {
    expect_tip: sourceEntity.data.manifest_cid,
    merge_into: targetEntity.data.entity_id,
    skip_sync: true,
  });
  test('Merge into target succeeds', mergeIntoTarget.status === 201);

  // Now delete the target (which has entities merged into it)
  const deleteTarget = await apiRequest('POST', `/entities-kg/${targetEntity.data.entity_id}/delete`, {
    expect_tip: mergeIntoTarget.data.target_manifest_cid,
    note: 'Deleting target with merged sources',
    skip_sync: true,
  });
  test('Delete target (with merged sources) succeeds', deleteTarget.status === 201, `status=${deleteTarget.status}`);

  // Verify target is deleted
  const getTarget = await apiRequest('GET', `/entities-kg/${targetEntity.data.entity_id}`);
  test('Target shows as deleted', getTarget.data.status === 'deleted');

  // The source entity still points to the deleted target (which is fine)
  const getSource = await apiRequest('GET', `/entities-kg/${sourceEntity.data.entity_id}`);
  test('Source still shows as merged', getSource.data.status === 'merged');
  test('Source still points to deleted target', getSource.data.merged_into === targetEntity.data.entity_id);

  // ========================================================================
  // Summary
  // ========================================================================
  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => !r.passed).forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    process.exit(1);
  }

  console.log('\nAll tests passed!');
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
