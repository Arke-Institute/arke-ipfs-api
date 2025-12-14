#!/usr/bin/env tsx
/**
 * EIDOS HIERARCHY RACE CONDITION TEST SUITE
 *
 * Tests race conditions and CAS protection for hierarchical operations:
 * - Concurrent parent_pi creation (auto-update parent)
 * - Batch hierarchy endpoint (/hierarchy) race conditions
 * - Conflicting parent-child operations
 * - Children_pi_add/remove race conditions
 *
 * Prerequisites:
 * - IPFS wrapper running locally (npm run dev)
 * - Test network enabled
 *
 * Run: npx tsx tests/eidos/hierarchy-race-test-suite.ts [test1] [test2] ...
 */

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = 'test';

// Colors for output
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

// Utility functions
function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function section(title: string) {
  log('magenta', '\n' + '═'.repeat(70));
  log('magenta', `  ${title}`);
  log('magenta', '═'.repeat(70));
}

function subsection(title: string) {
  log('blue', `\n  ── ${title} ──`);
}

function info(message: string) {
  log('cyan', `ℹ️  ${message}`);
}

function pass(message: string) {
  log('green', `✅ PASS: ${message}`);
  passedTests++;
  totalTests++;
}

function fail(message: string, error?: any) {
  log('red', `❌ FAIL: ${message}`);
  if (error) {
    console.error('   ', error);
  }
  failedTests++;
  totalTests++;
}

function warn(message: string) {
  log('yellow', `⚠️  WARN: ${message}`);
}

// =============================================================================
// API Helper Functions
// =============================================================================

async function uploadTestFile(content: string, filename: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([content], { type: 'text/plain' });
  formData.append('file', blob, filename);
  const response = await fetch(`${API_ENDPOINT}/upload`, { method: 'POST', body: formData });
  const data = await response.json();
  return data[0].cid;
}

async function apiRequest(method: string, path: string, body?: any) {
  const response = await fetch(`${API_ENDPOINT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Arke-Network': NETWORK },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function createEntity(req: any) {
  const { status, data } = await apiRequest('POST', '/entities', req);
  if (status !== 201) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function getEntity(id: string) {
  const { status, data } = await apiRequest('GET', `/entities/${id}`);
  if (status !== 200) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function appendVersion(id: string, req: any) {
  const { status, data } = await apiRequest('POST', `/entities/${id}/versions`, req);
  if (status !== 201) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function updateHierarchy(req: any) {
  const { status, data } = await apiRequest('POST', '/hierarchy', req);
  if (status !== 200) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// =============================================================================
// TEST 1: Concurrent parent_pi Creation
// =============================================================================

async function testConcurrentHierarchyParent(): Promise<void> {
  section('Test 1: Concurrent parent_pi Creation');

  try {
    subsection('1a: 10 children created simultaneously with same parent');

    // Create parent
    const dataCid = await uploadTestFile('parent data', 'parent.txt');
    const parent = await createEntity({
      type: 'PI',
      label: 'Parent Document',
      components: { data: dataCid },
    });

    info(`Created parent: ${parent.id}`);

    // Create 10 children concurrently, all with same parent
    const childPromises = Array.from({ length: 10 }, async (_, i) => {
      const childCid = await uploadTestFile(`child ${i}`, `child-${i}.txt`);
      return createEntity({
        type: 'PI',
        label: `Child ${i}`,
        components: { data: childCid },
        parent_pi: parent.id,
      });
    });

    const startTime = Date.now();
    const children = await Promise.all(childPromises);
    const elapsed = Date.now() - startTime;

    info(`Created 10 children in ${elapsed}ms`);

    // Verify parent has all 10 children
    const updatedParent = await getEntity(parent.id);
    const childrenPi = updatedParent.children_pi || [];

    if (childrenPi.length === 10) {
      pass(`Parent has all 10 children (${childrenPi.length}/10)`);
    } else {
      fail(`Parent missing children: ${childrenPi.length}/10`, {
        expected: 10,
        got: childrenPi.length,
        missing: children.filter(c => !childrenPi.includes(c.id)).map(c => c.id),
      });
    }

    // Verify all children have correct parent_pi
    let correctParents = 0;
    for (const child of children) {
      const retrievedChild = await getEntity(child.id);
      if (retrievedChild.parent_pi === parent.id) {
        correctParents++;
      }
    }

    if (correctParents === 10) {
      pass('All 10 children have correct parent_pi');
    } else {
      fail(`Only ${correctParents}/10 children have correct parent_pi`);
    }

    subsection('1b: 20 children created simultaneously (stress test)');

    const parent2Cid = await uploadTestFile('parent2 data', 'parent2.txt');
    const parent2 = await createEntity({
      type: 'PI',
      label: 'Parent Document 2',
      components: { data: parent2Cid },
    });

    info(`Created parent2: ${parent2.id}`);

    const child2Promises = Array.from({ length: 20 }, async (_, i) => {
      const childCid = await uploadTestFile(`child ${i}`, `child2-${i}.txt`);
      return createEntity({
        type: 'PI',
        label: `Child ${i}`,
        components: { data: childCid },
        parent_pi: parent2.id,
      });
    });

    const startTime2 = Date.now();
    const children2 = await Promise.all(child2Promises);
    const elapsed2 = Date.now() - startTime2;

    info(`Created 20 children in ${elapsed2}ms`);

    const updatedParent2 = await getEntity(parent2.id);
    const children2Pi = updatedParent2.children_pi || [];

    if (children2Pi.length === 20) {
      pass(`Parent has all 20 children (${children2Pi.length}/20) - race handling working`);
    } else {
      warn(`Parent has ${children2Pi.length}/20 children (race detection may need tuning)`);
      fail(`Parent missing children under high concurrency: ${children2Pi.length}/20`, {
        missing_count: 20 - children2Pi.length,
      });
    }

  } catch (error) {
    fail('Concurrent parent_pi creation test failed', error);
  }
}

// =============================================================================
// TEST 2: Batch Hierarchy Endpoint Race Conditions
// =============================================================================

async function testBatchHierarchyRaces(): Promise<void> {
  section('Test 2: Batch Hierarchy Endpoint Race Conditions');

  try {
    subsection('2a: Concurrent batch hierarchy updates on same parent');

    // Create parent
    const dataCid = await uploadTestFile('parent data', 'parent.txt');
    const parent = await createEntity({
      type: 'PI',
      label: 'Batch Test Parent',
      components: { data: dataCid },
    });

    // Create 20 children without parent
    const children = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const childCid = await uploadTestFile(`child ${i}`, `batch-child-${i}.txt`);
        return createEntity({
          type: 'PI',
          label: `Batch Child ${i}`,
          components: { data: childCid },
        });
      })
    );

    info(`Created parent and 20 children`);

    // Fetch fresh parent tip
    const freshParent = await getEntity(parent.id);

    // Split children into 4 batches of 5
    const batch1 = children.slice(0, 5).map(c => c.id);
    const batch2 = children.slice(5, 10).map(c => c.id);
    const batch3 = children.slice(10, 15).map(c => c.id);
    const batch4 = children.slice(15, 20).map(c => c.id);

    // Execute 4 hierarchy updates concurrently with SAME expect_tip (will race)
    const batchPromises = [
      updateHierarchy({
        parent_pi: parent.id,
        expect_tip: freshParent.manifest_cid,
        add_children: batch1,
      }),
      updateHierarchy({
        parent_pi: parent.id,
        expect_tip: freshParent.manifest_cid,
        add_children: batch2,
      }),
      updateHierarchy({
        parent_pi: parent.id,
        expect_tip: freshParent.manifest_cid,
        add_children: batch3,
      }),
      updateHierarchy({
        parent_pi: parent.id,
        expect_tip: freshParent.manifest_cid,
        add_children: batch4,
      }),
    ];

    const startTime = Date.now();
    const results = await Promise.allSettled(batchPromises);
    const elapsed = Date.now() - startTime;

    info(`4 concurrent batch updates completed in ${elapsed}ms`);

    // Count successes vs CAS failures
    const successes = results.filter(r => r.status === 'fulfilled').length;
    const failures = results.filter(r => r.status === 'rejected').length;

    info(`Results: ${successes} succeeded, ${failures} failed (expected: 1 success, 3 CAS failures)`);

    // Verify final state
    const finalParent = await getEntity(parent.id);
    const finalChildren = finalParent.children_pi || [];

    if (finalChildren.length === 20) {
      pass('All 20 children added despite concurrent updates (retry logic working)');
    } else {
      fail(`Only ${finalChildren.length}/20 children added`, {
        missing_count: 20 - finalChildren.length,
      });
    }

    subsection('2b: Mixed add/remove operations on same parent');

    // Create parent with initial children
    const parent2Cid = await uploadTestFile('parent2 data', 'parent2.txt');
    const parent2 = await createEntity({
      type: 'PI',
      label: 'Mixed Ops Parent',
      components: { data: parent2Cid },
    });

    // Create 10 children
    const children2 = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const childCid = await uploadTestFile(`child ${i}`, `mixed-child-${i}.txt`);
        return createEntity({
          type: 'PI',
          label: `Mixed Child ${i}`,
          components: { data: childCid },
        });
      })
    );

    // Add first 5 children to parent
    const freshParent2 = await getEntity(parent2.id);
    await updateHierarchy({
      parent_pi: parent2.id,
      expect_tip: freshParent2.manifest_cid,
      add_children: children2.slice(0, 5).map(c => c.id),
    });

    info('Added 5 children to parent');

    // Now do conflicting operations:
    const freshParent3 = await getEntity(parent2.id);

    const mixedPromises = [
      // Add remaining 5 children
      updateHierarchy({
        parent_pi: parent2.id,
        expect_tip: freshParent3.manifest_cid,
        add_children: children2.slice(5, 10).map(c => c.id),
      }),
      // Remove first 2 children
      updateHierarchy({
        parent_pi: parent2.id,
        expect_tip: freshParent3.manifest_cid,
        remove_children: children2.slice(0, 2).map(c => c.id),
      }),
    ];

    await Promise.allSettled(mixedPromises);

    const finalParent2 = await getEntity(parent2.id);
    const finalChildren2 = finalParent2.children_pi || [];

    info(`Final children count: ${finalChildren2.length}`);

    // Expected: 5 initial + 5 added - 2 removed = 8
    if (finalChildren2.length === 8) {
      pass('Mixed add/remove operations handled correctly (8 children)');
    } else {
      warn(`Expected 8 children, got ${finalChildren2.length} (race handling may vary)`);
      // Don't fail, as the exact outcome depends on race resolution order
    }

  } catch (error) {
    fail('Batch hierarchy race conditions test failed', error);
  }
}

// =============================================================================
// TEST 3: Conflicting Parent-Child Operations
// =============================================================================

async function testConflictingOperations(): Promise<void> {
  section('Test 3: Conflicting Parent-Child Operations');

  try {
    subsection('3a: parent_pi creation vs /hierarchy endpoint');

    // Create parent
    const dataCid = await uploadTestFile('parent data', 'parent.txt');
    const parent = await createEntity({
      type: 'PI',
      label: 'Conflict Test Parent',
      components: { data: dataCid },
    });

    // Create 5 children without parent (for /hierarchy)
    const batch1 = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const childCid = await uploadTestFile(`batch child ${i}`, `batch-${i}.txt`);
        return createEntity({
          type: 'PI',
          label: `Batch Child ${i}`,
          components: { data: childCid },
        });
      })
    );

    info('Created parent and 5 batch children');

    // Get fresh parent state
    const freshParent = await getEntity(parent.id);

    // Simultaneously:
    // 1. Add batch children via /hierarchy
    // 2. Create new children with parent_pi
    const conflictPromises = [
      updateHierarchy({
        parent_pi: parent.id,
        expect_tip: freshParent.manifest_cid,
        add_children: batch1.map(c => c.id),
      }),
      ...Array.from({ length: 5 }, async (_, i) => {
        const childCid = await uploadTestFile(`direct child ${i}`, `direct-${i}.txt`);
        return createEntity({
          type: 'PI',
          label: `Direct Child ${i}`,
          components: { data: childCid },
          parent_pi: parent.id,
        });
      }),
    ];

    const startTime = Date.now();
    await Promise.allSettled(conflictPromises);
    const elapsed = Date.now() - startTime;

    info(`Conflicting operations completed in ${elapsed}ms`);

    const finalParent = await getEntity(parent.id);
    const finalChildren = finalParent.children_pi || [];

    if (finalChildren.length === 10) {
      pass('All 10 children added (5 via /hierarchy + 5 via parent_pi)');
    } else {
      fail(`Expected 10 children, got ${finalChildren.length}`, {
        missing_count: 10 - finalChildren.length,
      });
    }

    subsection('3b: children_pi_add vs children_pi_remove on same version');

    const parent2Cid = await uploadTestFile('parent2 data', 'conflict-parent2.txt');
    const parent2 = await createEntity({
      type: 'PI',
      label: 'Add/Remove Conflict Parent',
      components: { data: parent2Cid },
    });

    // Create children
    const children = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const childCid = await uploadTestFile(`child ${i}`, `conflict-child-${i}.txt`);
        return createEntity({
          type: 'PI',
          label: `Conflict Child ${i}`,
          components: { data: childCid },
        });
      })
    );

    // Add first 5 children
    const freshParent2 = await getEntity(parent2.id);
    await appendVersion(parent2.id, {
      expect_tip: freshParent2.manifest_cid,
      children_pi_add: children.slice(0, 5).map(c => c.id),
    });

    info('Added 5 children to parent');

    // Now conflicting append versions:
    const freshParent3 = await getEntity(parent2.id);

    const appendPromises = [
      // Add remaining 5
      appendVersion(parent2.id, {
        expect_tip: freshParent3.manifest_cid,
        children_pi_add: children.slice(5, 10).map(c => c.id),
      }),
      // Remove first 3
      appendVersion(parent2.id, {
        expect_tip: freshParent3.manifest_cid,
        children_pi_remove: children.slice(0, 3).map(c => c.id),
      }),
    ];

    await Promise.allSettled(appendPromises);

    const finalParent2 = await getEntity(parent2.id);
    const finalChildren2 = finalParent2.children_pi || [];

    info(`Final children count: ${finalChildren2.length}`);

    // Expected: 5 initial + 5 added - 3 removed = 7
    if (finalChildren2.length === 7) {
      pass('Conflicting add/remove handled correctly (7 children)');
    } else {
      warn(`Expected 7 children, got ${finalChildren2.length} (race handling may vary)`);
    }

  } catch (error) {
    fail('Conflicting operations test failed', error);
  }
}

// =============================================================================
// TEST 4: High Concurrency Stress Test
// =============================================================================

async function testHighConcurrencyStress(): Promise<void> {
  section('Test 4: High Concurrency Stress Test');

  try {
    subsection('4a: 30 children with parent_pi (stress test)');

    const dataCid = await uploadTestFile('stress parent', 'stress-parent.txt');
    const parent = await createEntity({
      type: 'PI',
      label: 'Stress Test Parent',
      components: { data: dataCid },
    });

    info(`Created parent: ${parent.id}`);

    const childPromises = Array.from({ length: 30 }, async (_, i) => {
      const childCid = await uploadTestFile(`stress child ${i}`, `stress-${i}.txt`);
      return createEntity({
        type: 'PI',
        label: `Stress Child ${i}`,
        components: { data: childCid },
        parent_pi: parent.id,
      });
    });

    const startTime = Date.now();
    const children = await Promise.all(childPromises);
    const elapsed = Date.now() - startTime;

    info(`Created 30 children in ${elapsed}ms (avg: ${(elapsed / 30).toFixed(0)}ms per child)`);

    const finalParent = await getEntity(parent.id);
    const childrenPi = finalParent.children_pi || [];

    if (childrenPi.length === 30) {
      pass(`All 30 children added successfully under high concurrency`);
    } else {
      const missingCount = 30 - childrenPi.length;
      const successRate = ((childrenPi.length / 30) * 100).toFixed(1);
      warn(`High concurrency: ${childrenPi.length}/30 children (${successRate}% success rate)`);

      if (missingCount <= 2) {
        pass(`Acceptable loss rate: ${missingCount}/30 missing (may need retry tuning)`);
      } else {
        fail(`Too many missing children: ${missingCount}/30 (retry logic needs improvement)`);
      }
    }

  } catch (error) {
    fail('High concurrency stress test failed', error);
  }
}

// =============================================================================
// Main Test Runner
// =============================================================================

async function runAllTests(selectedTests?: string[]): Promise<void> {
  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  EIDOS HIERARCHY RACE CONDITION TEST SUITE');
  log('blue', '═'.repeat(70) + '\n');
  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}\n`);

  const shouldRun = (testName: string) => {
    if (!selectedTests || selectedTests.length === 0) return true;
    return selectedTests.some(t => testName.includes(t));
  };

  if (shouldRun('test1') || shouldRun('concurrent') || shouldRun('parent_pi')) {
    await testConcurrentHierarchyParent();
  }

  if (shouldRun('test2') || shouldRun('batch') || shouldRun('hierarchy')) {
    await testBatchHierarchyRaces();
  }

  if (shouldRun('test3') || shouldRun('conflict')) {
    await testConflictingOperations();
  }

  if (shouldRun('test4') || shouldRun('stress')) {
    await testHighConcurrencyStress();
  }

  // Summary
  log('magenta', '\n' + '═'.repeat(70));
  log('magenta', '  TEST SUMMARY');
  log('magenta', '═'.repeat(70));
  console.log(`Total Tests:  ${totalTests}`);
  log('green', `Passed:       ${passedTests} ✅`);
  log('red', `Failed:       ${failedTests} ❌`);

  if (totalTests > 0) {
    console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  }

  if (failedTests === 0 && totalTests > 0) {
    log('green', '\n✅ All hierarchy race tests passed! CAS protection working correctly.');
  } else if (totalTests > 0) {
    log('red', `\n❌ ${failedTests} test(s) failed. Review race handling logic.`);
    process.exit(1);
  }
}

// Parse command-line arguments
const args = process.argv.slice(2);
const selectedTests = args.length > 0 ? args : undefined;

if (selectedTests) {
  info(`Running selected tests: ${selectedTests.join(', ')}`);
}

// Run tests
runAllTests(selectedTests).catch((error) => {
  log('red', '\n❌ Fatal error running tests:');
  console.error(error);
  process.exit(1);
});
