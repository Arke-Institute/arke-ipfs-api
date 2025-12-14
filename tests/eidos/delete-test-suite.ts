#!/usr/bin/env tsx
/**
 * Eidos Delete & Undelete Test Suite
 *
 * Tests soft delete and restore functionality:
 * - Delete active entity
 * - Cannot delete already deleted
 * - Cannot delete merged entity
 * - CAS protection on delete
 * - Undelete restores entity
 * - Cannot undelete active entity
 * - CAS protection on undelete
 * - Version history preservation
 * - GET deleted entity returns status
 */

const API_URL = 'http://localhost:8787';

type TestResult = {
  name: string;
  passed: boolean;
  error?: string;
};

const results: TestResult[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✅ ${name}`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`❌ ${name}`);
    console.error(`   Error: ${error instanceof Error ? error.message : error}`);
  }
}

// =============================================================================
// DELETE TESTS
// =============================================================================

await runTest('Delete active entity', async () => {
  // Create entity
  const createRes = await fetch(`${API_URL}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'person',
      label: 'Test Person',
      components: {},
    }),
  });
  assert(createRes.status === 201, 'Entity created');
  const created = await createRes.json();

  // Delete entity
  const deleteRes = await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expect_tip: created.tip,
      note: 'Test deletion',
    }),
  });
  assert(deleteRes.status === 201, 'Delete request successful');
  const deleted = await deleteRes.json();

  assert(deleted.id === created.id, 'ID matches');
  assert(deleted.deleted_ver === 2, 'Version incremented');
  assert(deleted.previous_ver === 1, 'Previous version correct');
  assert(deleted.prev_cid === created.tip, 'prev_cid matches original tip');
  assert(deleted.deleted_manifest_cid, 'Tombstone CID returned');
});

await runTest('GET deleted entity returns status=deleted', async () => {
  // Create and delete entity
  const createRes = await fetch(`${API_URL}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'person',
      label: 'Test Person',
      components: {},
    }),
  });
  const created = await createRes.json();

  await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: created.tip }),
  });

  // Get deleted entity
  const getRes = await fetch(`${API_URL}/entities/${created.id}`);
  assert(getRes.status === 200, 'GET request successful');
  const entity = await getRes.json();

  assert(entity.status === 'deleted', 'Status is deleted');
  assert(entity.id === created.id, 'ID matches');
  assert(entity.type === 'person', 'Type preserved');
  assert(entity.deleted_at, 'Deleted timestamp present');
  assert(entity.prev_cid === created.tip, 'prev_cid points to last active version');
});

await runTest('Cannot delete already deleted entity', async () => {
  // Create and delete entity
  const createRes = await fetch(`${API_URL}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'person',
      components: {},
    }),
  });
  const created = await createRes.json();

  const deleteRes = await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: created.tip }),
  });
  const deleted = await deleteRes.json();

  // Try to delete again
  const deleteAgainRes = await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: deleted.deleted_manifest_cid }),
  });
  assert(deleteAgainRes.status === 400, 'Should return 400');
  const error = await deleteAgainRes.json();
  assert(error.error === 'VALIDATION_ERROR', 'Error type is VALIDATION_ERROR');
  assert(error.message.includes('already deleted'), 'Error message mentions already deleted');
});

await runTest('Cannot delete merged entity', async () => {
  // Create source and target entities
  const source = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  const target = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  // Merge source into target
  await fetch(`${API_URL}/entities/${source.id}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_id: target.id,
      expect_target_tip: target.tip,
    }),
  });

  // Get updated source tip (now a tombstone)
  const sourceAfterMerge = await (await fetch(`${API_URL}/entities/${source.id}`)).json();

  // Try to delete merged entity
  const deleteRes = await fetch(`${API_URL}/entities/${source.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: sourceAfterMerge.manifest_cid }),
  });
  assert(deleteRes.status === 400, 'Should return 400');
  const error = await deleteRes.json();
  assert(error.error === 'VALIDATION_ERROR', 'Error type is VALIDATION_ERROR');
  assert(error.message.includes('merged'), 'Error message mentions merged');
});

await runTest('CAS protection on delete (stale tip)', async () => {
  // Create entity
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  // Try to delete with wrong tip
  const deleteRes = await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: 'bafyreiwrongcid123456789' }),
  });
  assert(deleteRes.status === 409, 'Should return 409 CAS failure');
  const error = await deleteRes.json();
  assert(error.error === 'CAS_FAILURE', 'Error type is CAS_FAILURE');
});

await runTest('Version history preserved after delete', async () => {
  // Create entity
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', label: 'V1', components: {} }),
    })
  ).json();

  // Append version
  const v2 = await (
    await fetch(`${API_URL}/entities/${created.id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: created.tip, label: 'V2' }),
    })
  ).json();

  // Delete
  await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: v2.tip }),
  });

  // Verify version history still accessible
  const versionsRes = await fetch(`${API_URL}/entities/${created.id}/versions`);
  assert(versionsRes.status === 200, 'Version history accessible');
  const versions = await versionsRes.json();
  assert(versions.items.length >= 2, 'At least 2 versions (v1, v2)');
});

// =============================================================================
// UNDELETE TESTS
// =============================================================================

await runTest('Undelete restores entity to active state', async () => {
  // Create and delete entity
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', label: 'Original', components: {} }),
    })
  ).json();

  const deleted = await (
    await fetch(`${API_URL}/entities/${created.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: created.tip }),
    })
  ).json();

  // Undelete
  const undeleteRes = await fetch(`${API_URL}/entities/${created.id}/undelete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expect_tip: deleted.deleted_manifest_cid,
      note: 'Test restoration',
    }),
  });
  assert(undeleteRes.status === 201, 'Undelete successful');
  const restored = await undeleteRes.json();

  assert(restored.id === created.id, 'ID matches');
  assert(restored.restored_ver === 3, 'Restored version is 3 (v1 → v2 deleted → v3 restored)');
  assert(restored.restored_from_ver === 1, 'Restored from v1');
  assert(restored.new_manifest_cid, 'New manifest CID returned');

  // Verify entity is active again
  const entity = await (await fetch(`${API_URL}/entities/${created.id}`)).json();
  assert(!entity.status || entity.status !== 'deleted', 'Entity is active');
  assert(entity.label === 'Original', 'Label restored');
  assert(entity.ver === 3, 'Version is 3');
});

await runTest('Restored entity has all original data', async () => {
  // Create entity with components and relationships
  const uploadRes = await fetch(`${API_URL}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'test content',
  });
  const upload = await uploadRes.json();

  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'person',
        label: 'Rich Entity',
        description: 'Has components',
        components: {
          file: upload.cid,
        },
        properties: { age: 30, name: 'John' },
      }),
    })
  ).json();

  // Delete and undelete
  const deleted = await (
    await fetch(`${API_URL}/entities/${created.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: created.tip }),
    })
  ).json();

  await fetch(`${API_URL}/entities/${created.id}/undelete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: deleted.deleted_manifest_cid }),
  });

  // Verify all data restored
  const entity = await (await fetch(`${API_URL}/entities/${created.id}`)).json();
  assert(entity.label === 'Rich Entity', 'Label restored');
  assert(entity.description === 'Has components', 'Description restored');
  assert(entity.components.file === upload.cid, 'Component restored');
  assert(entity.components.properties, 'Properties component exists');
});

await runTest('Cannot undelete active entity', async () => {
  // Create entity (active)
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  // Try to undelete active entity
  const undeleteRes = await fetch(`${API_URL}/entities/${created.id}/undelete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: created.tip }),
  });
  assert(undeleteRes.status === 400, 'Should return 400');
  const error = await undeleteRes.json();
  assert(error.error === 'VALIDATION_ERROR', 'Error type is VALIDATION_ERROR');
  assert(error.message.includes('not deleted'), 'Error message mentions not deleted');
});

await runTest('CAS protection on undelete (stale tombstone tip)', async () => {
  // Create and delete entity
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  await fetch(`${API_URL}/entities/${created.id}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: created.tip }),
  });

  // Try to undelete with wrong tip
  const undeleteRes = await fetch(`${API_URL}/entities/${created.id}/undelete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: 'bafyreiwrongcid123456789' }),
  });
  assert(undeleteRes.status === 409, 'Should return 409 CAS failure');
  const error = await undeleteRes.json();
  assert(error.error === 'CAS_FAILURE', 'Error type is CAS_FAILURE');
});

await runTest('Version history includes tombstone after undelete', async () => {
  // Create, delete, undelete
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', components: {} }),
    })
  ).json();

  const deleted = await (
    await fetch(`${API_URL}/entities/${created.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: created.tip }),
    })
  ).json();

  await fetch(`${API_URL}/entities/${created.id}/undelete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expect_tip: deleted.deleted_manifest_cid }),
  });

  // Verify version history
  const versionsRes = await fetch(`${API_URL}/entities/${created.id}/versions`);
  const versions = await versionsRes.json();
  assert(versions.items.length === 3, 'Three versions: v1 (active), v2 (deleted), v3 (restored)');
});

await runTest('Multiple delete/undelete cycles work correctly', async () => {
  // Create entity
  const created = await (
    await fetch(`${API_URL}/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'person', label: 'Cycle Test', components: {} }),
    })
  ).json();

  let currentTip = created.tip;

  // Cycle 1: Delete → Undelete
  const del1 = await (
    await fetch(`${API_URL}/entities/${created.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: currentTip }),
    })
  ).json();

  const undel1 = await (
    await fetch(`${API_URL}/entities/${created.id}/undelete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: del1.deleted_manifest_cid }),
    })
  ).json();
  currentTip = undel1.new_manifest_cid;

  // Cycle 2: Delete → Undelete
  const del2 = await (
    await fetch(`${API_URL}/entities/${created.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: currentTip }),
    })
  ).json();

  const undel2 = await (
    await fetch(`${API_URL}/entities/${created.id}/undelete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect_tip: del2.deleted_manifest_cid }),
    })
  ).json();

  // Final entity should be active with version 5
  // v1 (created) → v2 (del1) → v3 (undel1) → v4 (del2) → v5 (undel2)
  const final = await (await fetch(`${API_URL}/entities/${created.id}`)).json();
  assert(!final.status || final.status !== 'deleted', 'Entity is active');
  assert(final.ver === 5, 'Version is 5 after two cycles');
  assert(final.label === 'Cycle Test', 'Label preserved through cycles');
});

// =============================================================================
// SUMMARY
// =============================================================================

console.log('\n' + '='.repeat(80));
console.log('DELETE & UNDELETE TEST SUITE RESULTS');
console.log('='.repeat(80));

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`\nTotal: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.log('\nFailed tests:');
  results
    .filter((r) => !r.passed)
    .forEach((r) => {
      console.log(`  ❌ ${r.name}`);
      console.log(`     ${r.error}`);
    });
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
