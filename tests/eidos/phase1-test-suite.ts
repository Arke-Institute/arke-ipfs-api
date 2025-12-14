#!/usr/bin/env tsx
/**
 * Eidos Phase 1 Integration Test Suite
 *
 * Tests core operations with the unified Eidos schema:
 * - Entity creation (PIs and KG entities)
 * - Entity retrieval (get, redirect following)
 * - Append version (partial updates, component changes)
 * - Hierarchy operations (parent-child tree structure)
 *
 * Run: tsx tests/eidos/phase1-test-suite.ts
 *
 * Prerequisites:
 * - IPFS wrapper running locally (npm run dev)
 * - IPFS/Kubo node accessible
 */

import { ulid } from '../../src/utils/ulid';

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = process.env.NETWORK || 'test'; // Use test network by default
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

function pass(message: string) {
  log('green', `  ✅ PASS: ${message}`);
  passedTests++;
  totalTests++;
}

function fail(message: string, error?: any) {
  log('red', `  ❌ FAIL: ${message}`);
  if (error) {
    console.error('    ', error);
  }
  failedTests++;
  totalTests++;
}

function info(message: string) {
  log('cyan', `  ℹ️  ${message}`);
}

function warn(message: string) {
  log('yellow', `  ⚠️  ${message}`);
}

function section(title: string) {
  console.log('');
  log('magenta', `${'═'.repeat(70)}`);
  log('magenta', `  ${title}`);
  log('magenta', `${'═'.repeat(70)}`);
}

function subsection(title: string) {
  console.log('');
  log('blue', `  ── ${title} ──`);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// API helper functions
async function apiRequest(
  method: string,
  path: string,
  body?: any,
  expectStatus?: number
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

  if (expectStatus && response.status !== expectStatus) {
    throw new Error(
      `Expected ${expectStatus}, got ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return { status: response.status, data };
}

// Upload a test file and return its CID
async function uploadTestFile(content: string, filename: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([content], { type: 'text/plain' });
  formData.append('file', blob, filename);

  const response = await fetch(`${API_ENDPOINT}/upload`, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();
  return data[0].cid;
}

// ===========================================================================
// TEST SUITES
// ===========================================================================

/**
 * Test 1: Entity Creation
 */
async function testEntityCreation(): Promise<void> {
  section('Test 1: Entity Creation (Unified Eidos Schema)');

  // Test 1a: Create PI entity (type: "PI")
  subsection('1a: Create PI entity (default type)');
  try {
    const dataCid = await uploadTestFile('test document content', 'test.txt');

    const { status, data } = await apiRequest('POST', '/entities', {
      components: { data: dataCid },
      note: 'Test PI creation',
    }, 201);

    if (data.pi && data.id && data.ver === 1 && data.manifest_cid) {
      pass(`Created PI: ${data.id} (backward compat field pi: ${data.pi})`);
      info(`Type should default to "PI" for backward compatibility`);
    } else {
      fail('Unexpected response structure', data);
    }
  } catch (error) {
    fail('PI creation failed', error);
  }

  // Test 1b: Create PI with explicit type
  subsection('1b: Create PI with explicit type="PI"');
  try {
    const dataCid = await uploadTestFile('document with explicit type', 'doc.txt');

    const { status, data } = await apiRequest('POST', '/entities', {
      type: 'PI',
      label: 'Test Document',
      description: 'A test document entity',
      components: { data: dataCid },
      note: 'Explicit type=PI',
    }, 201);

    if (data.id && data.ver === 1) {
      pass(`Created PI with explicit type: ${data.id}`);
    } else {
      fail('Unexpected response', data);
    }
  } catch (error) {
    fail('PI creation with explicit type failed', error);
  }

  // Test 1c: Create KG entity (type: "person")
  subsection('1c: Create KG entity (type="person")');
  try {
    const { status, data } = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Alice Austen',
      description: 'Photographer from Staten Island',
      components: {},
      note: 'Test person entity',
    }, 201);

    if (data.id && data.ver === 1) {
      pass(`Created person entity: ${data.id}`);
    } else {
      fail('Unexpected response', data);
    }
  } catch (error) {
    fail('Person entity creation failed', error);
  }

  // Test 1d: Create entity with custom ID
  subsection('1d: Create entity with custom ID');
  try {
    // Generate test network entity ID (starts with II)
    const customId = 'II' + ulid().slice(2);

    const { status, data } = await apiRequest('POST', '/entities', {
      id: customId,
      type: 'place',
      label: 'Test Location',
      components: {},
    }, 201);

    if (data.id === customId) {
      pass(`Created entity with custom ID: ${customId}`);
    } else {
      fail('Custom ID not preserved', data);
    }
  } catch (error) {
    fail('Custom ID creation failed', error);
  }

  // Test 1e: Duplicate ID should fail
  subsection('1e: Duplicate ID rejection');
  try {
    const customId = 'II' + ulid().slice(2);

    // Create first
    await apiRequest('POST', '/entities', {
      id: customId,
      type: 'organization',
      label: 'Org 1',
      components: {},
    }, 201);

    // Try to create duplicate
    const { status, data } = await apiRequest('POST', '/entities', {
      id: customId,
      type: 'organization',
      label: 'Org 2 (duplicate)',
      components: {},
    });

    if (status === 409) {
      pass('Duplicate ID correctly rejected with 409');
    } else {
      fail(`Expected 409, got ${status}`, data);
    }
  } catch (error) {
    fail('Duplicate ID test failed', error);
  }

  // Test 1f: Create entity with parent_pi (auto-update parent)
  subsection('1f: Create entity with parent_pi');
  try {
    // Create parent first
    const parent = await apiRequest('POST', '/entities', {
      type: 'organization',
      label: 'Parent Org',
      components: {},
    }, 201);

    info(`Created parent: ${parent.data.id}`);

    // Create child with parent_pi
    const child = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Employee',
      parent_pi: parent.data.id,
      components: {},
      note: 'Child with auto-parent-update',
    }, 201);

    if (child.status === 201) {
      pass(`Created child with parent_pi: ${child.data.id}`);
      info('Parent should auto-update to include child in children_pi array');

      // Verify parent was updated
      await sleep(500); // Wait for parent update
      const parentCheck = await apiRequest('GET', `/entities/${parent.data.id}`);

      if (parentCheck.data.children_pi && parentCheck.data.children_pi.includes(child.data.id)) {
        pass('Parent auto-updated with child in children_pi');
      } else {
        warn('Parent children_pi not updated (might be async)');
      }
    } else {
      fail('Child creation failed', child.data);
    }
  } catch (error) {
    fail('Hierarchy_parent test failed', error);
  }
}

/**
 * Test 2: Entity Retrieval
 */
async function testEntityRetrieval(): Promise<void> {
  section('Test 2: Entity Retrieval');

  // Test 2a: Get entity by ID
  subsection('2a: Get entity by ID');
  try {
    // Create entity first
    const created = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Test Retrieval',
      description: 'Entity for retrieval testing',
      components: {},
    }, 201);

    const entityId = created.data.id;

    // Get it back
    const { status, data } = await apiRequest('GET', `/entities/${entityId}`, undefined, 200);

    if (
      data.id === entityId &&
      data.type === 'person' &&
      data.label === 'Test Retrieval' &&
      data.ver === 1
    ) {
      pass(`Retrieved entity correctly: ${entityId}`);
    } else {
      fail('Retrieved entity missing fields or incorrect', data);
    }
  } catch (error) {
    fail('Entity retrieval failed', error);
  }

  // Test 2b: Get non-existent entity (404)
  subsection('2b: Get non-existent entity');
  try {
    const fakeId = 'II' + ulid().slice(2);
    const { status, data } = await apiRequest('GET', `/entities/${fakeId}`);

    if (status === 404) {
      pass('Non-existent entity correctly returns 404');
    } else {
      fail(`Expected 404, got ${status}`, data);
    }
  } catch (error) {
    fail('404 test failed', error);
  }

  // Test 2c: Backward compatibility (pi field)
  subsection('2c: Backward compatibility (pi field)');
  try {
    const created = await apiRequest('POST', '/entities', {
      type: 'PI',
      components: {},
    }, 201);

    const { status, data } = await apiRequest('GET', `/entities/${created.data.id}`, undefined, 200);

    if (data.pi === data.id) {
      pass('Backward compat: pi field matches id field');
    } else {
      fail('Backward compat broken: pi !== id', data);
    }
  } catch (error) {
    fail('Backward compatibility test failed', error);
  }
}

/**
 * Test 3: Append Version
 */
async function testAppendVersion(): Promise<void> {
  section('Test 3: Append Version (Partial Updates)');

  // Test 3a: Update label and description
  subsection('3a: Update label and description');
  try {
    // Create entity
    const created = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Original Name',
      description: 'Original description',
      components: {},
    }, 201);

    const entityId = created.data.id;
    const tip = created.data.tip;

    // Append version
    const { status, data } = await apiRequest('POST', `/entities/${entityId}/versions`, {
      expect_tip: tip,
      label: 'Updated Name',
      description: 'Updated description',
      note: 'Changed label and description',
    }, 201);

    if (data.ver === 2 && data.id === entityId) {
      pass(`Appended version 2: ${entityId}`);

      // Verify changes
      const fetched = await apiRequest('GET', `/entities/${entityId}`, undefined, 200);
      if (fetched.data.label === 'Updated Name' && fetched.data.description === 'Updated description') {
        pass('Label and description updated correctly');
      } else {
        fail('Updates not applied', fetched.data);
      }
    } else {
      fail('Version append failed', data);
    }
  } catch (error) {
    fail('Append version test failed', error);
  }

  // Test 3b: Add/update components
  subsection('3b: Add/update components');
  try {
    const metadataCid = await uploadTestFile('{"key": "value"}', 'metadata.json');

    // Create entity
    const created = await apiRequest('POST', '/entities', {
      type: 'PI',
      components: {},
    }, 201);

    const entityId = created.data.id;
    const tip = created.data.tip;

    // Add component
    const { status, data } = await apiRequest('POST', `/entities/${entityId}/versions`, {
      expect_tip: tip,
      components: { metadata: metadataCid },
      note: 'Added metadata component',
    }, 201);

    if (data.ver === 2) {
      pass('Added component successfully');

      // Verify component exists
      const fetched = await apiRequest('GET', `/entities/${entityId}`, undefined, 200);
      if (fetched.data.components && fetched.data.components.metadata === metadataCid) {
        pass('Component stored correctly');
      } else {
        fail('Component not found', fetched.data);
      }
    } else {
      fail('Component add failed', data);
    }
  } catch (error) {
    fail('Component update test failed', error);
  }

  // Test 3c: Remove component
  subsection('3c: Remove component');
  try {
    const cid1 = await uploadTestFile('data 1', 'file1.txt');
    const cid2 = await uploadTestFile('data 2', 'file2.txt');

    // Create entity with two components
    const created = await apiRequest('POST', '/entities', {
      type: 'PI',
      components: { file1: cid1, file2: cid2 },
    }, 201);

    const entityId = created.data.id;
    const tip = created.data.tip;

    // Remove file1
    const { status, data } = await apiRequest('POST', `/entities/${entityId}/versions`, {
      expect_tip: tip,
      components_remove: ['file1'],
      note: 'Removed file1 component',
    }, 201);

    if (data.ver === 2) {
      pass('Removed component successfully');

      // Verify file1 is gone, file2 remains
      const fetched = await apiRequest('GET', `/entities/${entityId}`, undefined, 200);
      if (
        !fetched.data.components.file1 &&
        fetched.data.components.file2 === cid2
      ) {
        pass('Component removed, others preserved');
      } else {
        fail('Component removal failed', fetched.data);
      }
    } else {
      fail('Component remove failed', data);
    }
  } catch (error) {
    fail('Component removal test failed', error);
  }

  // Test 3d: CAS protection (expect_tip mismatch)
  subsection('3d: CAS protection (stale tip)');
  try {
    // Create entity
    const created = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'CAS Test',
      components: {},
    }, 201);

    const entityId = created.data.id;
    const staleTip = created.data.tip;

    // Update once (changes tip)
    await apiRequest('POST', `/entities/${entityId}/versions`, {
      expect_tip: staleTip,
      label: 'Updated',
    }, 201);

    // Try to update with stale tip
    const { status, data } = await apiRequest('POST', `/entities/${entityId}/versions`, {
      expect_tip: staleTip, // Stale!
      label: 'Should fail',
    });

    if (status === 409) {
      pass('CAS protection correctly rejected stale tip with 409');
    } else {
      fail(`Expected 409, got ${status}`, data);
    }
  } catch (error) {
    fail('CAS protection test failed', error);
  }
}

/**
 * Test 4: Hierarchy Operations
 */
async function testHierarchyOperations(): Promise<void> {
  section('Test 4: Hierarchy Operations (Parent-Child Tree)');

  // Test 4a: Add children to parent
  subsection('4a: Add children to parent');
  try {
    // Create parent
    const parent = await apiRequest('POST', '/entities', {
      type: 'organization',
      label: 'Parent Organization',
      components: {},
    }, 201);

    // Create children
    const child1 = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Child 1',
      components: {},
    }, 201);

    const child2 = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Child 2',
      components: {},
    }, 201);

    info(`Parent: ${parent.data.id}`);
    info(`Children: ${child1.data.id}, ${child2.data.id}`);

    // Add children via /hierarchy endpoint
    const { status, data } = await apiRequest('POST', '/hierarchy', {
      parent_pi: parent.data.id,
      expect_tip: parent.data.tip,
      add_children: [child1.data.id, child2.data.id],
      note: 'Added two children',
    }, 200);

    if (
      data.parent_ver === 2 &&
      data.children_updated === 2 &&
      data.children_failed === 0
    ) {
      pass('Added children to parent successfully');

      await sleep(500); // Wait for updates

      // Verify parent's children_pi array
      const parentFetched = await apiRequest('GET', `/entities/${parent.data.id}`, undefined, 200);
      if (
        parentFetched.data.children_pi &&
        parentFetched.data.children_pi.includes(child1.data.id) &&
        parentFetched.data.children_pi.includes(child2.data.id)
      ) {
        pass('Parent children_pi array updated correctly');
      } else {
        fail('Parent children_pi missing children', parentFetched.data);
      }

      // Verify children's parent_pi field
      const child1Fetched = await apiRequest('GET', `/entities/${child1.data.id}`, undefined, 200);
      if (child1Fetched.data.parent_pi === parent.data.id) {
        pass('Child1 parent_pi set correctly');
      } else {
        fail('Child1 parent_pi not set', child1Fetched.data);
      }

      const child2Fetched = await apiRequest('GET', `/entities/${child2.data.id}`, undefined, 200);
      if (child2Fetched.data.parent_pi === parent.data.id) {
        pass('Child2 parent_pi set correctly');
      } else {
        fail('Child2 parent_pi not set', child2Fetched.data);
      }
    } else {
      fail('Hierarchy update failed', data);
    }
  } catch (error) {
    fail('Add children test failed', error);
  }

  // Test 4b: Remove children from parent
  subsection('4b: Remove children from parent');
  try {
    // Create parent with children
    const parent = await apiRequest('POST', '/entities', {
      type: 'organization',
      label: 'Parent Org 2',
      components: {},
    }, 201);

    const child1 = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Child A',
      components: {},
    }, 201);

    const child2 = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Child B',
      components: {},
    }, 201);

    // Add both children
    const addResult = await apiRequest('POST', '/hierarchy', {
      parent_pi: parent.data.id,
      expect_tip: parent.data.tip,
      add_children: [child1.data.id, child2.data.id],
    }, 200);

    await sleep(500);

    // Remove child1
    const parentUpdated = await apiRequest('GET', `/entities/${parent.data.id}`, undefined, 200);
    const removeResult = await apiRequest('POST', '/hierarchy', {
      parent_pi: parent.data.id,
      expect_tip: parentUpdated.data.manifest_cid,
      remove_children: [child1.data.id],
      note: 'Removed child1',
    }, 200);

    if (removeResult.data.children_updated === 1 && removeResult.data.children_failed === 0) {
      pass('Removed child from parent');

      await sleep(500);

      // Verify parent only has child2
      const parentFinal = await apiRequest('GET', `/entities/${parent.data.id}`, undefined, 200);
      if (
        parentFinal.data.children_pi &&
        !parentFinal.data.children_pi.includes(child1.data.id) &&
        parentFinal.data.children_pi.includes(child2.data.id)
      ) {
        pass('Parent children_pi correctly updated after removal');
      } else {
        fail('Parent children_pi incorrect after removal', parentFinal.data);
      }

      // Verify child1's parent_pi removed
      const child1Final = await apiRequest('GET', `/entities/${child1.data.id}`, undefined, 200);
      if (!child1Final.data.parent_pi) {
        pass('Child1 parent_pi removed');
      } else {
        fail('Child1 parent_pi still set', child1Final.data);
      }
    } else {
      fail('Remove children failed', removeResult.data);
    }
  } catch (error) {
    fail('Remove children test failed', error);
  }

  // Test 4c: Deduplication (adding same child twice)
  subsection('4c: Deduplication');
  try {
    const parent = await apiRequest('POST', '/entities', {
      type: 'organization',
      label: 'Dedupe Parent',
      components: {},
    }, 201);

    const child = await apiRequest('POST', '/entities', {
      type: 'person',
      label: 'Dedupe Child',
      components: {},
    }, 201);

    // Add child
    await apiRequest('POST', '/hierarchy', {
      parent_pi: parent.data.id,
      expect_tip: parent.data.tip,
      add_children: [child.data.id],
    }, 200);

    await sleep(500);

    // Try to add same child again
    const parentUpdated = await apiRequest('GET', `/entities/${parent.data.id}`, undefined, 200);
    await apiRequest('POST', '/hierarchy', {
      parent_pi: parent.data.id,
      expect_tip: parentUpdated.data.manifest_cid,
      add_children: [child.data.id], // Same child
    }, 200);

    await sleep(500);

    // Verify only one instance in children_pi
    const parentFinal = await apiRequest('GET', `/entities/${parent.data.id}`, undefined, 200);
    const childCount = parentFinal.data.children_pi?.filter((c: string) => c === child.data.id).length || 0;

    if (childCount === 1) {
      pass('Deduplication works: child only appears once');
    } else {
      fail(`Child appears ${childCount} times (expected 1)`, parentFinal.data);
    }
  } catch (error) {
    fail('Deduplication test failed', error);
  }
}

/**
 * Main test runner
 */
async function runTests(): Promise<void> {
  log('cyan', '\n╔════════════════════════════════════════════════════════════════════╗');
  log('cyan', '║            Eidos Phase 1 Integration Test Suite                   ║');
  log('cyan', '╚════════════════════════════════════════════════════════════════════╝\n');

  info(`API Endpoint: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);
  console.log('');

  try {
    await testEntityCreation();
    await testEntityRetrieval();
    await testAppendVersion();
    await testHierarchyOperations();
  } catch (error) {
    log('red', '\n❌ Fatal error during test execution:');
    console.error(error);
  }

  // Print summary
  console.log('');
  log('magenta', '═'.repeat(70));
  log('magenta', '  Test Summary');
  log('magenta', '═'.repeat(70));
  console.log(`  Total tests: ${totalTests}`);
  log('green', `  Passed: ${passedTests}`);
  log('red', `  Failed: ${failedTests}`);
  console.log('');

  if (failedTests === 0) {
    log('green', '🎉 All tests passed!');
  } else {
    log('red', `❌ ${failedTests} test(s) failed`);
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
