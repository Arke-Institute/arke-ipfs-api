#!/usr/bin/env tsx
/**
 * Eidos Phase 2 Integration Test Suite
 *
 * Tests merge/unmerge operations with the unified Eidos schema:
 * - Entity merging (component merge rules, tombstone creation)
 * - Entity unmerging (restoration from tombstone)
 * - Redirect following (GET on merged entity)
 * - CAS protection for merge/unmerge
 * - Error handling (double merge, unmerge validation)
 *
 * Run: npx tsx tests/eidos/phase2-test-suite.ts
 *
 * Prerequisites:
 * - IPFS wrapper running locally (npm run dev)
 * - IPFS/Kubo node accessible
 */

import { ulid } from '../../src/utils/ulid';

// Configuration
const API_ENDPOINT = process.env.API_ENDPOINT || 'http://localhost:8787';
const NETWORK = 'test'; // Use test network for all tests
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

function fail(message: string, details?: any) {
  log('red', `❌ FAIL: ${message}`);
  if (details) {
    console.error('Details:', details);
  }
  failedTests++;
  totalTests++;
}

function info(message: string) {
  log('cyan', `ℹ️  ${message}`);
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
  note?: string;
}): Promise<{ id: string; tip: string; ver: number }> {
  const { data } = await apiRequest('POST', '/entities', options);
  return data;
}

async function getEntity(id: string): Promise<any> {
  const { data } = await apiRequest('GET', `/entities/${id}`);
  return data;
}

async function mergeEntities(sourceId: string, targetId: string, expectTargetTip: string, note?: string): Promise<any> {
  const { status, data } = await apiRequest('POST', `/entities/${sourceId}/merge`, {
    target_id: targetId,
    expect_target_tip: expectTargetTip,
    note,
  });

  if (status !== 201) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function unmergeEntity(sourceId: string, targetId: string, expectTargetTip: string, note?: string): Promise<any> {
  const { status, data } = await apiRequest('POST', `/entities/${sourceId}/unmerge`, {
    target_id: targetId,
    expect_target_tip: expectTargetTip,
    note,
  });

  if (status !== 201) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(data)}`);
  }

  return data;
}

/**
 * Test 1: Basic merge operation
 */
async function testBasicMerge(): Promise<void> {
  section('Test 1: Basic Merge Operation');

  try {
    subsection('1a: Merge two simple entities');

    // Create source entity
    const sourceCid = await uploadTestFile('source data', 'source.txt');
    const source = await createEntity({
      type: 'PI',
      components: { data: sourceCid },
      label: 'Source Entity',
      description: 'This will be merged',
      note: 'Source entity for merge test',
    });
    info(`Created source entity: ${source.id}`);

    // Create target entity
    const targetCid = await uploadTestFile('target data', 'target.txt');
    const target = await createEntity({
      type: 'PI',
      components: { info: targetCid },
      label: 'Target Entity',
      description: 'This will absorb source',
      note: 'Target entity for merge test',
    });
    info(`Created target entity: ${target.id}`);

    // Merge source into target
    const mergeResult = await mergeEntities(source.id, target.id, target.tip, 'Merging for test');

    if (mergeResult.source_id === source.id && mergeResult.target_id === target.id) {
      pass(`Merge completed: ${source.id} → ${target.id}`);
    } else {
      fail('Merge response incorrect', mergeResult);
    }

    // Verify target was updated
    const updatedTarget = await getEntity(target.id);
    if (updatedTarget.ver === 2 && updatedTarget.merged_entities?.includes(source.id)) {
      pass(`Target updated to v${updatedTarget.ver} with merged_entities tracking`);
    } else {
      fail(`Target not properly updated (ver: ${updatedTarget.ver}, merged_entities: ${updatedTarget.merged_entities})`);
    }

    // Verify target has both components (merge rule)
    if (updatedTarget.components.data && updatedTarget.components.info) {
      pass('Target has merged components from both entities');
    } else {
      fail('Component merging failed', updatedTarget.components);
    }

    // Verify source is now a tombstone
    const tombstone = await getEntity(source.id);
    if (tombstone.merged === true && tombstone.merged_into === target.id) {
      pass(`Source is now tombstone redirecting to ${target.id}`);
    } else {
      fail('Tombstone not created correctly', tombstone);
    }

    subsection('1b: Prevent double merge');
    try {
      // Try to merge the tombstone again
      await mergeEntities(source.id, target.id, updatedTarget.manifest_cid);
      fail('Double merge should have been rejected');
    } catch (error: any) {
      if (error.message.includes('400') && error.message.includes('already merged')) {
        pass('Double merge correctly rejected with 400 error');
      } else {
        fail('Wrong error for double merge', error);
      }
    }

    subsection('1c: Prevent merging into tombstone');
    const anotherCid = await uploadTestFile('another entity', 'another.txt');
    const another = await createEntity({
      type: 'PI',
      components: { data: anotherCid },
      label: 'Another Entity',
    });

    try {
      // Try to merge into the tombstone
      await mergeEntities(another.id, source.id, tombstone.manifest_cid);
      fail('Merging into tombstone should have been rejected');
    } catch (error: any) {
      if (error.message.includes('400') && error.message.includes('already merged')) {
        pass('Merging into tombstone correctly rejected');
      } else {
        fail('Wrong error for merging into tombstone', error);
      }
    }

  } catch (error) {
    fail('Basic merge test failed', error);
  }
}

/**
 * Test 2: Basic unmerge operation
 */
async function testBasicUnmerge(): Promise<void> {
  section('Test 2: Basic Unmerge Operation');

  try {
    subsection('2a: Merge and then unmerge');

    // Create and merge entities
    const sourceCid = await uploadTestFile('unmerge source', 'unmerge-source.txt');
    const source = await createEntity({
      type: 'person',
      components: { bio: sourceCid },
      label: 'John Doe',
      description: 'Person entity to be merged and unmerged',
    });
    info(`Created source: ${source.id}`);

    const targetCid = await uploadTestFile('unmerge target', 'unmerge-target.txt');
    const target = await createEntity({
      type: 'person',
      components: { profile: targetCid },
      label: 'Jane Smith',
      description: 'Target for unmerge test',
    });
    info(`Created target: ${target.id}`);

    // Merge
    const mergeResult = await mergeEntities(source.id, target.id, target.tip, 'Test merge for unmerge');
    info(`Merged ${source.id} → ${target.id}`);

    // Get updated target tip
    const mergedTarget = await getEntity(target.id);

    // Unmerge
    const unmergeResult = await unmergeEntity(source.id, target.id, mergedTarget.manifest_cid, 'Restoring entity');

    if (unmergeResult.source_id === source.id && unmergeResult.target_id === target.id) {
      pass(`Unmerge completed: restored ${source.id}`);
    } else {
      fail('Unmerge response incorrect', unmergeResult);
    }

    // Verify source is restored
    const restoredSource = await getEntity(source.id);
    if (restoredSource.merged !== true && restoredSource.ver === 3) {
      pass(`Source restored as active entity at v${restoredSource.ver}`);
    } else {
      fail(`Source not properly restored (merged: ${restoredSource.merged}, ver: ${restoredSource.ver})`);
    }

    // Verify source has original components
    if (restoredSource.components.bio && restoredSource.label === 'John Doe') {
      pass('Source has original components and metadata');
    } else {
      fail('Source components not restored', restoredSource);
    }

    // Verify target's merged_entities array updated
    const updatedTarget = await getEntity(target.id);
    if (!updatedTarget.merged_entities?.includes(source.id)) {
      pass('Target merged_entities array updated (source removed)');
    } else {
      fail('Target merged_entities not updated', updatedTarget.merged_entities);
    }

    subsection('2b: Prevent unmerge of active entity');
    try {
      await unmergeEntity(target.id, source.id, restoredSource.manifest_cid);
      fail('Unmerge of active entity should have been rejected');
    } catch (error: any) {
      if (error.message.includes('400') && error.message.includes('not merged')) {
        pass('Unmerge of active entity correctly rejected');
      } else {
        fail('Wrong error for unmerging active entity', error);
      }
    }

  } catch (error) {
    fail('Basic unmerge test failed', error);
  }
}

/**
 * Test 3: Component merge rules
 */
async function testComponentMergeRules(): Promise<void> {
  section('Test 3: Component Merge Rules');

  try {
    subsection('3a: Files component - target wins');

    const sourceCid1 = await uploadTestFile('source file 1', 'file1.txt');
    const sourceCid2 = await uploadTestFile('source file 2', 'file2.txt');
    const targetCid1 = await uploadTestFile('target file 1', 'file1.txt');
    const targetCid3 = await uploadTestFile('target file 3', 'file3.txt');

    const source = await createEntity({
      type: 'PI',
      components: {
        'file1.txt': sourceCid1,
        'file2.txt': sourceCid2,
      },
      label: 'Source with files',
    });

    const target = await createEntity({
      type: 'PI',
      components: {
        'file1.txt': targetCid1,
        'file3.txt': targetCid3,
      },
      label: 'Target with files',
    });

    await mergeEntities(source.id, target.id, target.tip);

    const merged = await getEntity(target.id);

    // file1.txt: target wins (conflict)
    // file2.txt: from source (no conflict)
    // file3.txt: from target (no conflict)
    const hasTargetFile1 = merged.components['file1.txt'] === targetCid1;
    const hasSourceFile2 = merged.components['file2.txt'] === sourceCid2;
    const hasTargetFile3 = merged.components['file3.txt'] === targetCid3;

    if (hasTargetFile1 && hasSourceFile2 && hasTargetFile3) {
      pass('File merge rule: target wins on conflict, union otherwise');
    } else {
      fail('File merge rule failed', {
        'file1.txt': merged.components['file1.txt'],
        'file2.txt': merged.components['file2.txt'],
        'file3.txt': merged.components['file3.txt'],
      });
    }

  } catch (error) {
    fail('Component merge rules test failed', error);
  }
}

/**
 * Test 4: CAS protection for merge/unmerge
 */
async function testCASProtection(): Promise<void> {
  section('Test 4: CAS Protection for Merge/Unmerge');

  try {
    subsection('4a: Merge with stale target tip');

    const sourceCid = await uploadTestFile('cas source', 'cas-source.txt');
    const source = await createEntity({
      type: 'PI',
      components: { data: sourceCid },
      label: 'CAS Source',
    });

    const targetCid = await uploadTestFile('cas target', 'cas-target.txt');
    const target = await createEntity({
      type: 'PI',
      components: { info: targetCid },
      label: 'CAS Target',
    });

    // Get stale tip
    const staleTip = target.tip;

    // Update target (makes tip stale)
    const updateCid = await uploadTestFile('update', 'update.txt');
    await apiRequest('POST', `/entities/${target.id}/versions`, {
      expect_tip: target.tip,
      components: { extra: updateCid },
      note: 'Making tip stale',
    });

    // Try to merge with stale tip
    try {
      await mergeEntities(source.id, target.id, staleTip);
      fail('Merge with stale tip should have been rejected');
    } catch (error: any) {
      if (error.message.includes('409') && error.message.includes('CAS')) {
        pass('Merge with stale tip correctly rejected with 409 CAS error');
      } else {
        fail('Wrong error for stale tip merge', error);
      }
    }

    subsection('4b: Unmerge with stale target tip');

    // Merge with correct tip
    const freshTarget = await getEntity(target.id);
    await mergeEntities(source.id, target.id, freshTarget.manifest_cid);

    // Get stale tip
    const mergedTarget = await getEntity(target.id);
    const staleUnmergeTip = mergedTarget.manifest_cid;

    // Update target again
    const anotherCid = await uploadTestFile('another', 'another.txt');
    await apiRequest('POST', `/entities/${target.id}/versions`, {
      expect_tip: mergedTarget.manifest_cid,
      components: { another: anotherCid },
      note: 'Making tip stale again',
    });

    // Try to unmerge with stale tip
    try {
      await unmergeEntity(source.id, target.id, staleUnmergeTip);
      fail('Unmerge with stale tip should have been rejected');
    } catch (error: any) {
      if (error.message.includes('409') && error.message.includes('CAS')) {
        pass('Unmerge with stale tip correctly rejected with 409 CAS error');
      } else {
        fail('Wrong error for stale tip unmerge', error);
      }
    }

  } catch (error) {
    fail('CAS protection test failed', error);
  }
}

/**
 * Test 5: Multiple merges into same target
 */
async function testMultipleMerges(): Promise<void> {
  section('Test 5: Multiple Merges Into Same Target');

  try {
    // Create one target
    const targetCid = await uploadTestFile('main target', 'main.txt');
    const target = await createEntity({
      type: 'organization',
      components: { profile: targetCid },
      label: 'Main Organization',
      description: 'Primary entity',
    });
    info(`Created target: ${target.id}`);

    // Create 3 source entities
    const sources = [];
    for (let i = 1; i <= 3; i++) {
      const cid = await uploadTestFile(`duplicate ${i}`, `dup${i}.txt`);
      const source = await createEntity({
        type: 'organization',
        components: { [`data${i}`]: cid },
        label: `Duplicate ${i}`,
        description: `Duplicate organization ${i}`,
      });
      sources.push(source);
      info(`Created source ${i}: ${source.id}`);
    }

    // Merge all sources into target
    let currentTarget = target;
    for (let i = 0; i < sources.length; i++) {
      const mergeResult = await mergeEntities(
        sources[i].id,
        target.id,
        currentTarget.tip || currentTarget.manifest_cid,
        `Merging duplicate ${i + 1}`
      );
      info(`Merged source ${i + 1} into target`);
      currentTarget = await getEntity(target.id);
    }

    // Verify target has all merged_entities
    if (currentTarget.merged_entities?.length === 3 &&
        currentTarget.merged_entities.includes(sources[0].id) &&
        currentTarget.merged_entities.includes(sources[1].id) &&
        currentTarget.merged_entities.includes(sources[2].id)) {
      pass('Target has all 3 merged entities tracked');
    } else {
      fail('Target merged_entities tracking incorrect', currentTarget.merged_entities);
    }

    // Verify target has components from all sources
    const hasAllComponents = currentTarget.components.profile &&
                            currentTarget.components.data1 &&
                            currentTarget.components.data2 &&
                            currentTarget.components.data3;

    if (hasAllComponents) {
      pass('Target has merged components from all 3 sources');
    } else {
      fail('Not all components merged', Object.keys(currentTarget.components));
    }

    // Verify target version
    if (currentTarget.ver === 4) { // v1 (create) + v2 (merge1) + v3 (merge2) + v4 (merge3)
      pass(`Target at v${currentTarget.ver} after 3 merges`);
    } else {
      fail(`Target version unexpected: v${currentTarget.ver}, expected v4`);
    }

  } catch (error) {
    fail('Multiple merges test failed', error);
  }
}

/**
 * Main test runner
 */
async function runAllTests(): Promise<void> {
  log('blue', `\n${'═'.repeat(70)}`);
  log('blue', '  EIDOS PHASE 2: MERGE/UNMERGE TEST SUITE');
  log('blue', `${'═'.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}\n`);

  try {
    await testBasicMerge();
    await testBasicUnmerge();
    await testComponentMergeRules();
    await testCASProtection();
    await testMultipleMerges();

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
    log('red', '\n⚠️  SOME TESTS FAILED - Merge/Unmerge implementation has issues!');
    process.exit(1);
  } else {
    log('green', '\n✅ All tests passed! Merge/Unmerge operations working correctly.');
    process.exit(0);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
