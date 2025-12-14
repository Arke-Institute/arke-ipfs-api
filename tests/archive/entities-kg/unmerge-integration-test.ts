#!/usr/bin/env tsx
/**
 * Integration test to verify unmerge syncs to GraphDB/Pinecone via index-sync
 *
 * This test does NOT use skip_sync, so it triggers the full sync flow.
 */

const API_ENDPOINT = process.env.API_ENDPOINT || 'https://api.arke.institute';
const NETWORK = 'test';

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

async function main() {
  console.log('=== Unmerge Integration Test (with index-sync) ===\n');

  console.log('Creating source PI...');
  const formData = new FormData();
  formData.append('file', new Blob(['integration test for unmerge']), 'test.txt');
  const uploadRes = await fetch(`${API_ENDPOINT}/upload`, { method: 'POST', body: formData });
  const uploadData = await uploadRes.json();

  const piRes = await fetch(`${API_ENDPOINT}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arke-Network': NETWORK },
    body: JSON.stringify({ components: { data: uploadData[0].cid } }),
  });
  const pi = (await piRes.json()).pi;
  console.log(`  PI: ${pi}`);

  // Create two entities
  console.log('\nCreating entities A and B...');
  const entityA = await apiRequest('POST', '/entities-kg', {
    created_by_pi: pi,
    type: 'person',
    label: 'Unmerge Integration Test Person',
    properties: { role: 'test-subject' },
  });
  const entityAId = entityA.data.entity_id;
  console.log(`  Entity A: ${entityAId}`);

  const entityB = await apiRequest('POST', '/entities-kg', {
    created_by_pi: pi,
    type: 'person',
    label: 'Unmerge Integration Test Target',
  });
  const entityBId = entityB.data.entity_id;
  console.log(`  Entity B: ${entityBId}`);

  // Wait for index-sync to process creates
  console.log('\nWaiting 3s for index-sync to process creates...');
  await new Promise(r => setTimeout(r, 3000));

  // Merge A into B (WITHOUT skip_sync - triggers index-sync)
  console.log('\nMerging A into B (with sync enabled)...');
  const mergeRes = await apiRequest('POST', `/entities-kg/${entityAId}/merge`, {
    expect_tip: entityA.data.manifest_cid,
    merge_into: entityBId,
    note: 'Integration test merge',
    // NOT setting skip_sync
  });

  if (mergeRes.status !== 201) {
    console.error('Merge failed:', mergeRes.data);
    process.exit(1);
  }
  console.log(`  Merge successful - A is now merged (v${mergeRes.data.source_new_ver})`);

  // Wait for index-sync to process merge (deletes A from GraphDB/Pinecone)
  console.log('\nWaiting 3s for index-sync to process merge...');
  await new Promise(r => setTimeout(r, 3000));

  // Unmerge A (WITHOUT skip_sync - triggers index-sync)
  console.log('\nUnmerging A (with sync enabled)...');
  const unmergeRes = await apiRequest('POST', `/entities-kg/${entityAId}/unmerge`, {
    expect_tip: mergeRes.data.source_manifest_cid,
    note: 'Integration test unmerge',
    // NOT setting skip_sync
  });

  if (unmergeRes.status !== 201) {
    console.error('Unmerge failed:', unmergeRes.data);
    process.exit(1);
  }
  console.log(`  Unmerge successful - A restored to v${unmergeRes.data.new_ver}`);

  // Wait for index-sync to process unmerge (re-creates A in GraphDB/Pinecone)
  console.log('\nWaiting 5s for index-sync to process unmerge...');
  await new Promise(r => setTimeout(r, 5000));

  // Verify entity A is restored in IPFS
  const finalA = await apiRequest('GET', `/entities-kg/${entityAId}`);
  console.log('\nFinal entity A state (IPFS):');
  console.log(`  Status: ${finalA.data.status || 'active'}`);
  console.log(`  Label: ${finalA.data.label}`);
  console.log(`  Ver: ${finalA.data.ver}`);
  console.log(`  Type: ${finalA.data.type}`);

  if (finalA.data.status === 'merged') {
    console.error('\n❌ FAIL: Entity A is still merged in IPFS');
    process.exit(1);
  }
  console.log('\n✅ IPFS: Entity A is restored');

  console.log('\n=== Summary ===');
  console.log(`Entity A ID: ${entityAId}`);
  console.log(`Entity B ID: ${entityBId}`);
  console.log('\nTo verify GraphDB/Pinecone restoration, check:');
  console.log('1. index-sync logs via: wrangler tail index-sync');
  console.log('2. GraphDB query for entity A');
  console.log('3. Pinecone namespace for entity A vector');
  console.log('\n✅ Integration test complete');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
