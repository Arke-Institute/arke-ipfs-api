#!/usr/bin/env tsx
/**
 * Race Condition Test Suite
 *
 * Comprehensive distributed systems testing for atomic CAS operations.
 * Attempts to break the IPFS wrapper API by simulating concurrent operations
 * that would cause data loss without proper atomic CAS protection.
 *
 * Run: npm run test:race
 * Or:  tsx tests/race-conditions/race-test-suite.ts
 */

import { ulid } from '../../src/utils/ulid';

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const CONCURRENCY_LEVELS = [2, 5, 10, 20, 50]; // Test with increasing concurrency
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

// API helper functions
async function apiRequest(method: string, path: string, body?: any): Promise<any> {
  const url = `${API_ENDPOINT}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { error: 'UNKNOWN', message: errorText };
    }
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  return data;
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

  // Validate response format according to API_SPEC.md
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Invalid upload response format: ${JSON.stringify(data)}`);
  }

  if (!data[0].cid) {
    throw new Error(`Upload response missing CID: ${JSON.stringify(data[0])}`);
  }

  return data[0].cid;
}

async function createEntity(components: Record<string, string>, options?: {
  pi?: string;
  parent_pi?: string;
  children_pi?: string[];
  note?: string;
}): Promise<{ pi: string; tip: string; ver: number }> {
  return apiRequest('POST', '/entities', {
    components,
    ...options,
  });
}

async function getEntity(pi: string): Promise<any> {
  return apiRequest('GET', `/entities/${pi}`);
}

async function appendVersion(pi: string, expectTip: string, updates: {
  components?: Record<string, string>;
  components_remove?: string[];
  children_pi_add?: string[];
  children_pi_remove?: string[];
  note?: string;
}): Promise<{ pi: string; tip: string; ver: number }> {
  const MAX_RETRIES = 10; // Increased for high concurrency scenarios

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await apiRequest('POST', `/entities/${pi}/versions`, {
        expect_tip: expectTip,
        ...updates,
      });
    } catch (error: any) {
      // Check if this is a 409 CAS_FAILURE
      if (error.message.includes('HTTP 409') && error.message.includes('CAS_FAILURE') && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter: 100-200ms, 200-400ms, 400-800ms, etc.
        const baseDelay = 100 * (2 ** attempt);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        await sleep(delay);

        // Fetch fresh tip and retry
        const entity = await getEntity(pi);
        expectTip = entity.manifest_cid;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to append version after ${MAX_RETRIES} retries`);
}

async function updateRelations(parentPi: string, expectTip: string, updates: {
  add_children?: string[];
  remove_children?: string[];
  note?: string;
}): Promise<{ pi: string; tip: string; ver: number }> {
  const MAX_RETRIES = 10; // Increased for high concurrency scenarios

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await apiRequest('POST', '/relations', {
        parent_pi: parentPi,
        expect_tip: expectTip,
        ...updates,
      });
    } catch (error: any) {
      // Check if this is a 409 CAS_FAILURE
      if (error.message.includes('HTTP 409') && error.message.includes('CAS_FAILURE') && attempt < MAX_RETRIES - 1) {
        // Exponential backoff with jitter: 100-200ms, 200-400ms, 400-800ms, etc.
        const baseDelay = 100 * (2 ** attempt);
        const jitter = Math.random() * baseDelay;
        const delay = baseDelay + jitter;
        await sleep(delay);

        // Fetch fresh tip and retry
        const entity = await getEntity(parentPi);
        expectTip = entity.manifest_cid;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed to update relations after ${MAX_RETRIES} retries`);
}

// Sleep helper for exponential backoff
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test 1: Concurrent appendVersion with different components
 *
 * This simulates the original OCR bug scenario where multiple
 * OCR operations update different components simultaneously.
 */
async function testConcurrentComponentUpdates(concurrency: number): Promise<void> {
  section(`Test 1: Concurrent Component Updates (${concurrency} operations)`);

  try {
    // Create base entity with N empty components
    info(`Creating entity with ${concurrency} placeholder components...`);
    const components: Record<string, string> = {};
    for (let i = 0; i < concurrency; i++) {
      const cid = await uploadTestFile(`placeholder-${i}`, `file-${i}.txt`);
      components[`component-${i}`] = cid;
    }

    const entity = await createEntity(components, { note: 'Race test entity' });
    info(`Created entity ${entity.pi} at v${entity.ver}`);

    // Now simulate concurrent updates to different components
    info(`Launching ${concurrency} concurrent component updates...`);
    const startTime = Date.now();

    const updatePromises = Array.from({ length: concurrency }, async (_, i) => {
      // Each operation updates a different component
      const newCid = await uploadTestFile(`updated-content-${i}`, `updated-${i}.txt`);

      // All operations use the same expect_tip (simulating race condition)
      return appendVersion(entity.pi, entity.tip, {
        components: {
          [`component-${i}`]: newCid,
        },
        note: `Update component-${i}`,
      });
    });

    const results = await Promise.allSettled(updatePromises);
    const duration = Date.now() - startTime;

    // Check results and log errors
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Log first few failures for debugging
    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      warn(`Sample failures (first 3):`);
      failures.slice(0, 3).forEach((f, idx) => {
        console.log(`  [${idx}] ${f.reason}`);
      });
    }

    info(`Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Fetch final entity state
    await sleep(500); // Give server more time to settle (IPFS + MFS writes)
    const finalEntity = await getEntity(entity.pi);

    // Verify ALL components were updated
    let allUpdatesPresent = true;
    const missingUpdates: number[] = [];

    for (let i = 0; i < concurrency; i++) {
      const componentCid = finalEntity.components[`component-${i}`];
      // Check if this is the updated CID (starts with 'baf')
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

    // Check version number is reasonable
    if (finalEntity.ver >= concurrency) {
      info(`Version progression: v1 → v${finalEntity.ver} (expected ~${concurrency} versions)`);
    } else {
      warn(`Unexpected version: v${finalEntity.ver} (expected at least v${concurrency})`);
    }

  } catch (error) {
    fail('Concurrent component updates test failed', error);
  }
}

/**
 * Test 2: Concurrent relation updates (adding children)
 *
 * Tests POST /relations endpoint with multiple concurrent
 * add_children operations.
 */
async function testConcurrentRelationAdds(concurrency: number): Promise<void> {
  section(`Test 2: Concurrent Relation Adds (${concurrency} children)`);

  try {
    // Create parent entity
    const parentCid = await uploadTestFile('parent-data', 'parent.txt');
    const parent = await createEntity({ 'data': parentCid }, { note: 'Parent entity' });
    info(`Created parent entity ${parent.pi}`);

    // Create N child entities
    info(`Creating ${concurrency} child entities...`);
    const children: string[] = [];
    for (let i = 0; i < concurrency; i++) {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      const child = await createEntity({ 'data': childCid }, { note: `Child ${i}` });
      children.push(child.pi);
    }
    info(`Created ${children.length} children`);

    // Now add all children concurrently using POST /relations
    info(`Adding ${concurrency} children concurrently via POST /relations...`);
    const startTime = Date.now();

    const addPromises = children.map(async (childPi, i) => {
      // All operations use the parent's initial tip (race condition!)
      return updateRelations(parent.pi, parent.tip, {
        add_children: [childPi],
        note: `Add child ${i}`,
      });
    });

    const results = await Promise.allSettled(addPromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Verify all children are in parent's children_pi
    await sleep(500); // Give server more time to settle
    const finalParent = await getEntity(parent.pi);

    const childrenSet = new Set(finalParent.children_pi || []);
    const missingChildren = children.filter(c => !childrenSet.has(c));

    if (missingChildren.length === 0) {
      pass(`All ${concurrency} children present in parent (final version: v${finalParent.ver})`);
    } else {
      fail(`Missing ${missingChildren.length} children in parent: ${missingChildren.slice(0, 3).join(', ')}...`);
    }

  } catch (error) {
    fail('Concurrent relation adds test failed', error);
  }
}

/**
 * Test 3: Concurrent entity creation with same parent_pi
 *
 * Tests the parent auto-update logic in POST /entities
 * when multiple entities are created with the same parent.
 */
async function testConcurrentEntityCreationWithParent(concurrency: number): Promise<void> {
  section(`Test 3: Concurrent Entity Creation with Parent (${concurrency} entities)`);

  try {
    // Create parent entity
    const parentCid = await uploadTestFile('parent-data', 'parent.txt');
    const parent = await createEntity({ 'data': parentCid }, { note: 'Parent for creation test' });
    info(`Created parent entity ${parent.pi}`);

    // Create N entities concurrently, all with same parent_pi
    info(`Creating ${concurrency} entities with parent_pi=${parent.pi} concurrently...`);
    const startTime = Date.now();

    const createPromises = Array.from({ length: concurrency }, async (_, i) => {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      return createEntity(
        { 'data': childCid },
        { parent_pi: parent.pi, note: `Child ${i} via creation` }
      );
    });

    const results = await Promise.allSettled(createPromises);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Completed in ${duration}ms: ${succeeded.length} succeeded, ${failed} failed`);

    // Verify all created children are in parent's children_pi
    await sleep(1000); // Give even more time for parent auto-updates to settle
    const finalParent = await getEntity(parent.pi);

    const createdPis = succeeded.map(r => r.value.pi);
    const childrenSet = new Set(finalParent.children_pi || []);
    const missingChildren = createdPis.filter(pi => !childrenSet.has(pi));

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
 * Test 4: Mixed concurrent operations (chaos test)
 *
 * Simulates a realistic chaotic scenario with multiple
 * operation types happening simultaneously.
 */
async function testChaosScenario(concurrency: number): Promise<void> {
  section(`Test 4: Chaos Test - Mixed Operations (${concurrency} ops)`);

  try {
    // Create base entity
    const baseCid = await uploadTestFile('base-data', 'base.txt');
    const entity = await createEntity({ 'base': baseCid }, { note: 'Chaos test entity' });
    info(`Created entity ${entity.pi}`);

    // Create some children
    const children: string[] = [];
    for (let i = 0; i < 3; i++) {
      const childCid = await uploadTestFile(`child-${i}`, `child-${i}.txt`);
      const child = await createEntity({ 'data': childCid });
      children.push(child.pi);
    }

    info(`Launching ${concurrency} mixed concurrent operations...`);
    const startTime = Date.now();

    // Mix of different operation types, all racing
    const operations = Array.from({ length: concurrency }, async (_, i) => {
      const opType = i % 4;

      switch (opType) {
        case 0: // Component update
          const cid1 = await uploadTestFile(`chaos-${i}`, `file-${i}.txt`);
          return appendVersion(entity.pi, entity.tip, {
            components: { [`comp-${i}`]: cid1 },
            note: `Chaos component ${i}`,
          });

        case 1: // Add child
          const childIdx = i % children.length;
          return updateRelations(entity.pi, entity.tip, {
            add_children: [children[childIdx]],
            note: `Chaos add child ${i}`,
          });

        case 2: // Another component update
          const cid2 = await uploadTestFile(`chaos-alt-${i}`, `alt-${i}.txt`);
          return appendVersion(entity.pi, entity.tip, {
            components: { [`alt-${i}`]: cid2 },
            note: `Chaos alt ${i}`,
          });

        case 3: // Remove child (if any)
          if (children.length > 0) {
            return updateRelations(entity.pi, entity.tip, {
              remove_children: [children[0]],
              note: `Chaos remove child ${i}`,
            });
          }
          return Promise.resolve({ pi: entity.pi, tip: entity.tip, ver: 0 });
      }
    });

    const results = await Promise.allSettled(operations);
    const duration = Date.now() - startTime;

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    info(`Chaos completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);

    // Just verify the entity is still in a valid state
    await sleep(200);
    const finalEntity = await getEntity(entity.pi);

    if (finalEntity && finalEntity.ver > 1) {
      pass(`Entity survived chaos (final version: v${finalEntity.ver}, components: ${Object.keys(finalEntity.components).length})`);
    } else {
      fail('Entity in invalid state after chaos test');
    }

  } catch (error) {
    fail('Chaos test failed', error);
  }
}

/**
 * Test 5: Extreme stress test
 *
 * Pushes the system to its limits with many concurrent operations.
 */
async function testExtremeStress(): Promise<void> {
  section('Test 5: Extreme Stress Test (100 concurrent operations)');

  try {
    const EXTREME_CONCURRENCY = 100;

    // Create entity
    const baseCid = await uploadTestFile('stress-base', 'stress.txt');
    const entity = await createEntity({ 'base': baseCid }, { note: 'Stress test' });
    info(`Created stress test entity ${entity.pi}`);

    info(`Launching ${EXTREME_CONCURRENCY} concurrent component updates...`);
    warn('This may take a while and could trigger rate limits...');

    const startTime = Date.now();

    // Batch into groups to avoid overwhelming the system
    const BATCH_SIZE = 20;
    const batches = Math.ceil(EXTREME_CONCURRENCY / BATCH_SIZE);

    for (let batch = 0; batch < batches; batch++) {
      const batchStart = batch * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, EXTREME_CONCURRENCY);
      const batchSize = batchEnd - batchStart;

      info(`Processing batch ${batch + 1}/${batches} (${batchSize} operations)...`);

      const batchPromises = Array.from({ length: batchSize }, async (_, i) => {
        const idx = batchStart + i;
        const cid = await uploadTestFile(`stress-${idx}`, `stress-${idx}.txt`);
        return appendVersion(entity.pi, entity.tip, {
          components: { [`stress-${idx}`]: cid },
          note: `Stress ${idx}`,
        });
      });

      await Promise.allSettled(batchPromises);

      // Small delay between batches
      if (batch < batches - 1) {
        await sleep(100);
      }
    }

    const duration = Date.now() - startTime;

    await sleep(300);
    const finalEntity = await getEntity(entity.pi);

    const expectedComponents = EXTREME_CONCURRENCY;
    const actualComponents = Object.keys(finalEntity.components).filter(k => k.startsWith('stress-')).length;

    info(`Duration: ${duration}ms, Final version: v${finalEntity.ver}, Components: ${actualComponents}/${expectedComponents}`);

    if (actualComponents >= expectedComponents * 0.95) { // Allow 5% failure rate for extreme test
      pass(`Extreme stress test passed (${actualComponents}/${expectedComponents} components preserved)`);
    } else {
      warn(`Stress test partial success (${actualComponents}/${expectedComponents} components, ${((actualComponents/expectedComponents)*100).toFixed(1)}% success rate)`);
    }

  } catch (error) {
    fail('Extreme stress test failed', error);
  }
}

/**
 * Test 6: Component removal functionality
 *
 * Tests the new components_remove parameter for removing
 * component keys from manifests.
 */
async function testComponentRemoval(): Promise<void> {
  section('Test 6: Component Removal');

  try {
    // Test 6a: Remove existing component
    info('Test 6a: Remove existing component');
    const cid1 = await uploadTestFile('component-1', 'comp1.txt');
    const cid2 = await uploadTestFile('component-2', 'comp2.txt');
    const cid3 = await uploadTestFile('component-3', 'comp3.txt');

    const entity = await createEntity({
      'comp1': cid1,
      'comp2': cid2,
      'comp3': cid3,
    }, { note: 'Entity with 3 components' });

    info(`Created entity ${entity.pi} with 3 components`);

    // Remove comp2
    const updated = await appendVersion(entity.pi, entity.tip, {
      components_remove: ['comp2'],
      note: 'Removed comp2',
    });

    const finalEntity = await getEntity(entity.pi);

    if (!finalEntity.components['comp2'] && finalEntity.components['comp1'] && finalEntity.components['comp3']) {
      pass('Successfully removed component from manifest');
    } else {
      fail('Component removal did not work correctly', {
        expected: { comp1: 'present', comp2: 'removed', comp3: 'present' },
        actual: finalEntity.components,
      });
    }

    // Test 6b: Remove multiple components
    info('Test 6b: Remove multiple components');
    const updated2 = await appendVersion(entity.pi, updated.tip, {
      components_remove: ['comp1', 'comp3'],
      note: 'Removed comp1 and comp3',
    });

    const finalEntity2 = await getEntity(entity.pi);

    if (Object.keys(finalEntity2.components).length === 0) {
      pass('Successfully removed all components (empty components object)');
    } else {
      fail('Failed to remove all components', {
        expected: 'empty components object',
        actual: finalEntity2.components,
      });
    }

    // Test 6c: Remove and add same component key (should fail)
    info('Test 6c: Validation - Remove and add same component (should fail with 400)');
    try {
      const cid4 = await uploadTestFile('new-comp1', 'new-comp1.txt');
      await appendVersion(entity.pi, updated2.tip, {
        components: { 'comp1': cid4 },
        components_remove: ['comp1'],
        note: 'Should fail',
      });
      fail('Should have rejected removing and adding same component');
    } catch (error: any) {
      if (error.message.includes('HTTP 400')) {
        pass('Correctly rejected removing and adding same component');
      } else {
        fail('Wrong error type for remove/add conflict', error);
      }
    }

    // Test 6d: Remove non-existent component (should fail)
    info('Test 6d: Validation - Remove non-existent component (should fail with 400)');
    try {
      const cid5 = await uploadTestFile('comp5', 'comp5.txt');
      const entity2 = await createEntity({ 'comp5': cid5 });

      await appendVersion(entity2.pi, entity2.tip, {
        components_remove: ['nonexistent'],
        note: 'Should fail',
      });
      fail('Should have rejected removing non-existent component');
    } catch (error: any) {
      if (error.message.includes('HTTP 400')) {
        pass('Correctly rejected removing non-existent component');
      } else {
        fail('Wrong error type for non-existent component', error);
      }
    }

    // Test 6e: Empty components_remove array (should be no-op)
    info('Test 6e: Empty components_remove array (no-op)');
    const cid6 = await uploadTestFile('comp6', 'comp6.txt');
    const entity3 = await createEntity({ 'comp6': cid6 });

    const updated3 = await appendVersion(entity3.pi, entity3.tip, {
      components_remove: [],
      note: 'Empty remove array',
    });

    const finalEntity3 = await getEntity(entity3.pi);

    if (finalEntity3.components['comp6'] && finalEntity3.ver === 2) {
      pass('Empty components_remove array is a valid no-op');
    } else {
      fail('Empty components_remove array caused unexpected behavior');
    }

    // Test 6f: Reorganization use case - remove old components, add new
    info('Test 6f: Reorganization use case - remove old files, add description');
    const file1 = await uploadTestFile('file1', 'file1.pdf');
    const file2 = await uploadTestFile('file2', 'file2.pdf');
    const file3 = await uploadTestFile('file3', 'file3.pdf');

    const parent = await createEntity({
      'file1.pdf': file1,
      'file2.pdf': file2,
      'file3.pdf': file3,
    }, { note: 'Parent with 3 files' });

    // Create child group with same files
    const child = await createEntity({
      'file1.pdf': file1,
      'file2.pdf': file2,
    }, { note: 'Child group' });

    // Remove files from parent that moved to child, add description
    const desc = await uploadTestFile('Files moved to child group', 'description.txt');
    const reorganized = await appendVersion(parent.pi, parent.tip, {
      components_remove: ['file1.pdf', 'file2.pdf'],
      components: { 'description.txt': desc },
      children_pi_add: [child.pi],
      note: 'Reorganized into child group',
    });

    const finalParent = await getEntity(parent.pi);

    const hasOnlyFile3AndDesc =
      !finalParent.components['file1.pdf'] &&
      !finalParent.components['file2.pdf'] &&
      finalParent.components['file3.pdf'] &&
      finalParent.components['description.txt'] &&
      finalParent.children_pi.includes(child.pi);

    if (hasOnlyFile3AndDesc) {
      pass('Reorganization use case: removed files, added description, added child');
    } else {
      fail('Reorganization use case failed', {
        expected: 'file1,file2 removed; file3,description present; child added',
        actual: {
          components: Object.keys(finalParent.components),
          children: finalParent.children_pi,
        },
      });
    }

  } catch (error) {
    fail('Component removal test failed', error);
  }
}

/**
 * Main test runner
 */
async function runAllTests(): Promise<void> {
  log('blue', `\n${'═'.repeat(70)}`);
  log('blue', '  ATOMIC CAS RACE CONDITION TEST SUITE');
  log('blue', `${'═'.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info('Testing atomic CAS protection against concurrent operations...\n');

  try {
    // Test 1: Concurrent component updates with varying concurrency
    for (const concurrency of [2, 5, 10, 20]) {
      await testConcurrentComponentUpdates(concurrency);
      await sleep(500); // Cooldown between tests
    }

    // Test 2: Concurrent relation updates
    for (const concurrency of [5, 10, 20]) {
      await testConcurrentRelationAdds(concurrency);
      await sleep(500);
    }

    // Test 3: Concurrent entity creation with parent
    for (const concurrency of [5, 10, 20]) {
      await testConcurrentEntityCreationWithParent(concurrency);
      await sleep(500);
    }

    // Test 4: Chaos test
    await testChaosScenario(20);
    await sleep(500);

    // Test 5: Extreme stress (optional)
    if (process.env.RUN_STRESS === 'true') {
      await testExtremeStress();
    } else {
      warn('Skipping extreme stress test (set RUN_STRESS=true to enable)');
    }

    // Test 6: Component removal
    await testComponentRemoval();
    await sleep(500);

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
    log('green', '\n✅ All tests passed! Atomic CAS protection is working correctly.');
    process.exit(0);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
