#!/usr/bin/env tsx
/**
 * Eidos Race Condition Test Suite
 *
 * Comprehensive distributed systems testing for atomic CAS operations
 * with the unified Eidos schema (arke/eidos@v1).
 *
 * Tests concurrent operations to ensure no data loss occurs:
 * - Concurrent field updates (type, label, description)
 * - Concurrent component updates
 * - Concurrent hierarchy operations
 * - Mixed chaos scenarios
 *
 * Run: npx tsx tests/eidos/race-test-suite.ts
 *
 * Prerequisites:
 * - IPFS wrapper running locally (npm run dev)
 * - IPFS/Kubo node accessible
 */

import { ulid } from '../../src/utils/ulid';

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = 'test'; // Use test network for all race tests
const CONCURRENCY_LEVELS = [2, 5, 10, 20, 50];

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
  log('green', `✅ PASS: ${message}`);
  passedTests++;
  totalTests++;
}

function fail(message: string, error?: any) {
  log('red', `❌ FAIL: ${message}`);
  if (error) {
    console.error(error);
  }
  failedTests++;
  totalTests++;
}

function info(message: string) {
  log('cyan', `ℹ️  ${message}`);
}

function warn(message: string) {
  log('yellow', `⚠️  ${message}`);
}

function section(title: string) {
  console.log('');
  log('magenta', `${'═'.repeat(70)}`);
  log('magenta', `  ${title}`);
  log('magenta', `${'═'.repeat(70)}`);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// API helper functions
async function apiRequest(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
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
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return { status: response.status, data };
}

async function uploadTestFile(content: string, filename: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([content], { type: 'text/plain' });
  formData.append('file', blob, filename);

  const response = await fetch(`${API_ENDPOINT}/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data[0].cid;
}

async function createEntity(options: {
  type: string;
  components?: Record<string, string>;
  label?: string;
  description?: string;
  id?: string;
  parent_pi?: string;
  children_pi?: string[];
  note?: string;
}): Promise<{ id: string; tip: string; ver: number }> {
  const { data } = await apiRequest('POST', '/entities', options);
  return data;
}

async function getEntity(id: string): Promise<any> {
  const { data } = await apiRequest('GET', `/entities/${id}`);
  return data;
}

async function appendVersion(id: string, expectTip: string, updates: {
  type?: string;
  label?: string;
  description?: string;
  components?: Record<string, string>;
  components_remove?: string[];
  children_pi_add?: string[];
  children_pi_remove?: string[];
  note?: string;
}): Promise<{ id: string; tip: string; ver: number }> {
  const MAX_RETRIES = 10;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { data } = await apiRequest('POST', `/entities/${id}/versions`, {
        expect_tip: expectTip,
        ...updates,
      });
      return data;
    } catch (error: any) {
      // Check if this is a 409 CAS_FAILURE
      if (error.message.includes('HTTP 409') && error.message.includes('CAS_FAILURE') && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter
        const baseDelay = 100 * (2 ** attempt);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        await sleep(delay);

        // Fetch fresh tip and retry
        const entity = await getEntity(id);
        expectTip = entity.manifest_cid;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to append version after ${MAX_RETRIES} retries`);
}

async function updateHierarchy(parentId: string, expectTip: string, updates: {
  add_children?: string[];
  remove_children?: string[];
  note?: string;
}): Promise<{ parent_pi: string; parent_tip: string; parent_ver: number }> {
  const MAX_RETRIES = 10;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const { data } = await apiRequest('POST', '/hierarchy', {
        parent_pi: parentId,
        expect_tip: expectTip,
        ...updates,
      });
      return data;
    } catch (error: any) {
      // Check if this is a 409 CAS_FAILURE
      if (error.message.includes('HTTP 409') && error.message.includes('CAS_FAILURE') && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter
        const baseDelay = 100 * (2 ** attempt);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        await sleep(delay);

        // Fetch fresh tip and retry
        const entity = await getEntity(parentId);
        expectTip = entity.manifest_cid;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to update hierarchy after ${MAX_RETRIES} retries`);
}

/**
 * Test 1: Concurrent label/description updates
 *
 * Tests that concurrent updates to entity metadata fields
 * are properly serialized and all updates are preserved.
 */
async function testConcurrentMetadataUpdates(concurrency: number): Promise<void> {
  section(`Test 1: Concurrent Metadata Updates (${concurrency} operations)`);

  try {
    // Create base entity
    info('Creating test entity...');
    const dataCid = await uploadTestFile('base-data', 'base.txt');
    const entity = await createEntity({
      type: 'PI',
      components: { data: dataCid },
      label: 'Original Label',
      description: 'Original Description',
      note: 'Race test entity',
    });
    info(`Created entity ${entity.id} at v${entity.ver}`);

    // Launch concurrent label/description updates
    info(`Launching ${concurrency} concurrent metadata updates...`);
    const startTime = Date.now();

    const updatePromises = Array.from({ length: concurrency }, async (_, i) => {
      return appendVersion(entity.id, entity.tip, {
        label: `Label Update ${i}`,
        description: `Description Update ${i}`,
        note: `Metadata update ${i}`,
      });
    });

    const results = await Promise.allSettled(updatePromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Verify entity is in valid state
    await sleep(500);
    const finalEntity = await getEntity(entity.id);

    // At least one update should have succeeded
    const hasUpdate = finalEntity.label !== 'Original Label' || finalEntity.description !== 'Original Description';
    const hasValidVersion = finalEntity.ver > 1 && finalEntity.ver <= concurrency + 1;

    if (hasUpdate && hasValidVersion) {
      pass(`Concurrent metadata updates handled correctly (final version: v${finalEntity.ver})`);
      info(`Final label: "${finalEntity.label}", description: "${finalEntity.description}"`);
    } else {
      fail(`Metadata updates failed validation (ver: v${finalEntity.ver}, label: ${finalEntity.label})`);
    }

  } catch (error) {
    fail('Concurrent metadata updates test failed', error);
  }
}

/**
 * Test 2: Concurrent component updates (original OCR bug scenario)
 *
 * Simulates multiple operations updating different components simultaneously.
 */
async function testConcurrentComponentUpdates(concurrency: number): Promise<void> {
  section(`Test 2: Concurrent Component Updates (${concurrency} operations)`);

  try {
    // Create base entity with N placeholder components
    info(`Creating entity with ${concurrency} placeholder components...`);
    const components: Record<string, string> = {};
    for (let i = 0; i < concurrency; i++) {
      const cid = await uploadTestFile(`placeholder-${i}`, `file-${i}.txt`);
      components[`component-${i}`] = cid;
    }

    const entity = await createEntity({
      type: 'PI',
      components,
      label: 'Race Test Entity',
      note: 'Component race test',
    });
    info(`Created entity ${entity.id} at v${entity.ver}`);

    // Launch concurrent updates to different components
    info(`Launching ${concurrency} concurrent component updates...`);
    const startTime = Date.now();

    const updatePromises = Array.from({ length: concurrency }, async (_, i) => {
      const newCid = await uploadTestFile(`updated-content-${i}`, `updated-${i}.txt`);

      return appendVersion(entity.id, entity.tip, {
        components: {
          [`component-${i}`]: newCid,
        },
        note: `Update component-${i}`,
      });
    });

    const results = await Promise.allSettled(updatePromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Verify ALL components were updated
    await sleep(500);
    const finalEntity = await getEntity(entity.id);

    let allUpdatesPresent = true;
    const missingUpdates: number[] = [];

    for (let i = 0; i < concurrency; i++) {
      const componentCid = finalEntity.components[`component-${i}`];
      if (!componentCid || componentCid === components[`component-${i}`]) {
        allUpdatesPresent = false;
        missingUpdates.push(i);
      }
    }

    if (allUpdatesPresent) {
      pass(`All ${concurrency} concurrent component updates preserved (final version: v${finalEntity.ver})`);
    } else {
      fail(`Missing updates for components: ${missingUpdates.join(', ')} (final version: v${finalEntity.ver})`);
    }

  } catch (error) {
    fail('Concurrent component updates test failed', error);
  }
}

/**
 * Test 3: Concurrent hierarchy updates
 *
 * Tests POST /hierarchy endpoint with multiple concurrent add_children operations.
 */
async function testConcurrentHierarchyAdds(concurrency: number): Promise<void> {
  section(`Test 3: Concurrent Hierarchy Adds (${concurrency} children)`);

  try {
    // Create parent entity
    const parentCid = await uploadTestFile('parent-data', 'parent.txt');
    const parent = await createEntity({
      type: 'PI',
      components: { data: parentCid },
      label: 'Parent Entity',
      note: 'Hierarchy test parent',
    });
    info(`Created parent entity ${parent.id}`);

    // Create N child entities
    info(`Creating ${concurrency} child entities...`);
    const children: string[] = [];
    for (let i = 0; i < concurrency; i++) {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      const child = await createEntity({
        type: 'PI',
        components: { data: childCid },
        label: `Child ${i}`,
        note: `Child ${i}`,
      });
      children.push(child.id);
    }
    info(`Created ${children.length} children`);

    // Add all children concurrently using POST /hierarchy
    info(`Adding ${concurrency} children concurrently via POST /hierarchy...`);
    const startTime = Date.now();

    const addPromises = children.map(async (childId, i) => {
      return updateHierarchy(parent.id, parent.tip, {
        add_children: [childId],
        note: `Add child ${i}`,
      });
    });

    const results = await Promise.allSettled(addPromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Verify all children are in parent's children_pi
    await sleep(500);
    const finalParent = await getEntity(parent.id);

    const childrenSet = new Set(finalParent.children_pi || []);
    const missingChildren = children.filter(c => !childrenSet.has(c));

    if (missingChildren.length === 0) {
      pass(`All ${concurrency} children present in parent (final version: v${finalParent.ver})`);

      // Verify bidirectional relationship - check parent_pi on children
      info('Verifying bidirectional parent_pi updates...');
      let allChildrenUpdated = true;
      for (const childId of children) {
        const child = await getEntity(childId);
        if (child.parent_pi !== parent.id) {
          allChildrenUpdated = false;
          break;
        }
      }

      if (allChildrenUpdated) {
        pass(`All children have parent_pi set to ${parent.id}`);
      } else {
        warn('Some children missing parent_pi field');
      }
    } else {
      fail(`Missing ${missingChildren.length} children in parent: ${missingChildren.slice(0, 3).join(', ')}...`);
    }

  } catch (error) {
    fail('Concurrent hierarchy adds test failed', error);
  }
}

/**
 * Test 4: Concurrent entity creation with parent_pi
 *
 * Tests parent auto-update when multiple entities are created
 * with the same parent_pi simultaneously.
 */
async function testConcurrentEntityCreationWithParent(concurrency: number): Promise<void> {
  section(`Test 4: Concurrent Entity Creation with parent_pi (${concurrency} entities)`);

  try {
    // Create parent entity
    const parentCid = await uploadTestFile('parent-data', 'parent.txt');
    const parent = await createEntity({
      type: 'PI',
      components: { data: parentCid },
      label: 'Auto-update Parent',
      note: 'Parent for creation test',
    });
    info(`Created parent entity ${parent.id}`);

    // Create N entities concurrently, all with same parent_pi
    info(`Creating ${concurrency} entities with parent_pi=${parent.id} concurrently...`);
    const startTime = Date.now();

    const createPromises = Array.from({ length: concurrency }, async (_, i) => {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      return createEntity({
        type: 'PI',
        components: { data: childCid },
        label: `Auto Child ${i}`,
        parent_pi: parent.id,
        note: `Child ${i} via creation`,
      });
    });

    const results = await Promise.allSettled(createPromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded.length} succeeded, ${failed} failed`);

    // Verify all created children are in parent's children_pi
    await sleep(1000); // Give more time for parent auto-updates
    const finalParent = await getEntity(parent.id);

    const createdIds = succeeded.map(r => r.value.id);
    const childrenSet = new Set(finalParent.children_pi || []);
    const missingChildren = createdIds.filter(id => !childrenSet.has(id));

    if (missingChildren.length === 0) {
      pass(`All ${succeeded.length} created entities registered in parent (final version: v${finalParent.ver})`);
    } else {
      fail(`Missing ${missingChildren.length}/${succeeded.length} entities in parent's children_pi`);
    }

  } catch (error) {
    fail('Concurrent entity creation with parent test failed', error);
  }
}

/**
 * Test 5: Mixed concurrent operations (chaos test)
 *
 * Simulates realistic chaotic scenario with multiple operation types.
 */
async function testChaosScenario(concurrency: number): Promise<void> {
  section(`Test 5: Chaos Test - Mixed Operations (${concurrency} ops)`);

  try {
    // Create base entity
    const baseCid = await uploadTestFile('base-data', 'base.txt');
    const entity = await createEntity({
      type: 'PI',
      components: { base: baseCid },
      label: 'Chaos Entity',
      description: 'Testing mixed operations',
      note: 'Chaos test entity',
    });
    info(`Created entity ${entity.id}`);

    // Create some children
    const children: string[] = [];
    for (let i = 0; i < 3; i++) {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      const child = await createEntity({
        type: 'PI',
        components: { data: childCid },
        label: `Chaos Child ${i}`,
      });
      children.push(child.id);
    }

    info(`Launching ${concurrency} mixed concurrent operations...`);
    const startTime = Date.now();

    // Mix of different operation types, all racing
    const operations = Array.from({ length: concurrency }, async (_, i) => {
      const opType = i % 5;

      switch (opType) {
        case 0: // Component update
          const cid1 = await uploadTestFile(`chaos-${i}`, `file-${i}.txt`);
          return appendVersion(entity.id, entity.tip, {
            components: { [`comp-${i}`]: cid1 },
            note: `Chaos component ${i}`,
          });

        case 1: // Label update
          return appendVersion(entity.id, entity.tip, {
            label: `Chaos Label ${i}`,
            note: `Chaos label ${i}`,
          });

        case 2: // Add child
          const childIdx = i % children.length;
          return updateHierarchy(entity.id, entity.tip, {
            add_children: [children[childIdx]],
            note: `Chaos add child ${i}`,
          });

        case 3: // Description update
          return appendVersion(entity.id, entity.tip, {
            description: `Chaos description ${i}`,
            note: `Chaos desc ${i}`,
          });

        case 4: // Type update
          return appendVersion(entity.id, entity.tip, {
            type: i % 2 === 0 ? 'document' : 'PI',
            note: `Chaos type ${i}`,
          });
      }
    });

    const results = await Promise.allSettled(operations);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Chaos completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Verify entity is still in valid state
    await sleep(500);
    const finalEntity = await getEntity(entity.id);

    const isValid = finalEntity &&
                    finalEntity.ver > 1 &&
                    finalEntity.type &&
                    Object.keys(finalEntity.components).length > 0;

    if (isValid) {
      pass(`Entity survived chaos (final version: v${finalEntity.ver}, type: ${finalEntity.type}, components: ${Object.keys(finalEntity.components).length})`);
    } else {
      fail('Entity in invalid state after chaos test');
    }

  } catch (error) {
    fail('Chaos test failed', error);
  }
}

/**
 * Test 6: Component removal under concurrency
 *
 * Tests that components_remove works correctly with concurrent operations.
 */
async function testConcurrentComponentRemoval(): Promise<void> {
  section('Test 6: Concurrent Component Removal');

  try {
    // Create entity with multiple components
    info('Creating entity with 10 components...');
    const components: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      const cid = await uploadTestFile(`comp-${i}`, `file-${i}.txt`);
      components[`comp-${i}`] = cid;
    }

    const entity = await createEntity({
      type: 'PI',
      components,
      label: 'Removal Test',
      note: 'Component removal test',
    });
    info(`Created entity ${entity.id} with 10 components`);

    // Concurrently remove different components
    info('Launching concurrent component removals...');
    const removePromises = Array.from({ length: 5 }, async (_, i) => {
      return appendVersion(entity.id, entity.tip, {
        components_remove: [`comp-${i * 2}`], // Remove comp-0, comp-2, comp-4, comp-6, comp-8
        note: `Remove comp-${i * 2}`,
      });
    });

    const results = await Promise.allSettled(removePromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;

    info(`Completed: ${succeeded} removals succeeded`);

    // Verify removed components are gone, others remain
    await sleep(500);
    const finalEntity = await getEntity(entity.id);

    const remainingComponents = Object.keys(finalEntity.components);
    const expectedRemaining = ['comp-1', 'comp-3', 'comp-5', 'comp-7', 'comp-9'];
    const allPresentCorrectly = expectedRemaining.every(key => remainingComponents.includes(key));
    const noneRemovedIncorrectly = !remainingComponents.some(key => ['comp-0', 'comp-2', 'comp-4', 'comp-6', 'comp-8'].includes(key));

    if (allPresentCorrectly && noneRemovedIncorrectly) {
      pass(`Component removal worked correctly (${remainingComponents.length} components remain)`);
    } else {
      fail(`Component removal failed validation (remaining: ${remainingComponents.join(', ')})`);
    }

  } catch (error) {
    fail('Concurrent component removal test failed', error);
  }
}

/**
 * Main test runner
 */
async function runAllTests(selectedTests?: string[]): Promise<void> {
  log('blue', `\n${'═'.repeat(70)}`);
  log('blue', '  EIDOS ATOMIC CAS RACE CONDITION TEST SUITE');
  log('blue', `${'═'.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);
  info('Testing atomic CAS protection with unified Eidos schema...\n');

  if (selectedTests && selectedTests.length > 0) {
    info(`Running selected tests: ${selectedTests.join(', ')}\n`);
  }

  const shouldRun = (testName: string) => {
    if (!selectedTests || selectedTests.length === 0) return true;
    return selectedTests.some(t => testName.includes(t));
  };

  try {
    // Test 1: Concurrent metadata updates
    if (shouldRun('test1') || shouldRun('metadata')) {
      for (const concurrency of [2, 5, 10]) {
        await testConcurrentMetadataUpdates(concurrency);
        await sleep(500);
      }
    }

    // Test 2: Concurrent component updates
    if (shouldRun('test2') || shouldRun('component')) {
      for (const concurrency of [2, 5, 10, 20]) {
        await testConcurrentComponentUpdates(concurrency);
        await sleep(500);
      }
    }

    // Test 3: Concurrent hierarchy updates
    if (shouldRun('test3') || shouldRun('hierarchy')) {
      for (const concurrency of [5, 10, 20]) {
        await testConcurrentHierarchyAdds(concurrency);
        await sleep(500);
      }
    }

    // Test 4: Concurrent entity creation with parent
    if (shouldRun('test4') || shouldRun('creation')) {
      for (const concurrency of [5, 10, 20]) {
        await testConcurrentEntityCreationWithParent(concurrency);
        await sleep(500);
      }
    }

    // Test 5: Chaos test
    if (shouldRun('test5') || shouldRun('chaos')) {
      await testChaosScenario(20);
      await sleep(500);
    }

    // Test 6: Component removal
    if (shouldRun('test6') || shouldRun('removal')) {
      await testConcurrentComponentRemoval();
      await sleep(500);
    }

  } catch (error) {
    log('red', `\nFatal error during test execution: ${error}`);
  }

  // Print summary
  console.log('\n');
  log('magenta', `${'═'.repeat(70)}`);
  log('magenta', '  TEST SUMMARY');
  log('magenta', `${'═'.repeat(70)}`);

  console.log(`Total Tests:  ${totalTests}`);
  log('green', `Passed:       ${passedTests} ✅`);
  log('red', `Failed:       ${failedTests} ❌`);

  const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0.0';
  console.log(`Success Rate: ${successRate}%`);

  if (failedTests > 0) {
    log('red', '\n⚠️  RACE CONDITIONS DETECTED - Atomic CAS implementation has issues!');
    process.exit(1);
  } else {
    log('green', '\n✅ All tests passed! Atomic CAS protection is working correctly with Eidos schema.');
    process.exit(0);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const selectedTests = args.length > 0 ? args : undefined;

if (selectedTests) {
  console.log(`\n📋 Available tests: test1 (metadata), test2 (component), test3 (hierarchy), test4 (creation), test5 (chaos), test6 (removal)`);
  console.log(`   Usage: npx tsx tests/eidos/race-test-suite.ts [test1] [test2] ...\n`);
}

// Run tests
runAllTests(selectedTests).catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
