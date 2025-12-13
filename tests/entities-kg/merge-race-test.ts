#!/usr/bin/env tsx
/**
 * Merge Race Condition Test
 *
 * Tests concurrent mutual merges to identify race conditions.
 * This simulates the scenario where:
 *   - Owner A tries to merge entity X into Y
 *   - Owner B tries to merge entity Y into X
 *   - Both happen simultaneously
 *
 * Expected problem: Both entities could become redirects pointing to each other (cycle).
 *
 * Run: npm run test:merge-race
 * Or:  tsx tests/entities-kg/merge-race-test.ts
 */

import { ulid } from '../../src/utils/ulid';

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

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function info(message: string) {
  log('cyan', `ℹ️  ${message}`);
}

function warn(message: string) {
  log('yellow', `⚠️  ${message}`);
}

function error(message: string) {
  log('red', `❌ ${message}`);
}

function success(message: string) {
  log('green', `✅ ${message}`);
}

function section(title: string) {
  console.log('');
  log('magenta', `${'═'.repeat(70)}`);
  log('magenta', `  ${title}`);
  log('magenta', `${'═'.repeat(70)}`);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const blob = new Blob(['test source data'], { type: 'text/plain' });
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
      note: 'Test source PI',
    }),
  });

  const data = await response.json();
  return { pi: data.pi, tip: data.tip };
}

async function createEntity(
  sourcePI: string,
  label: string
): Promise<{ entity_id: string; manifest_cid: string }> {
  const { status, data } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI,
    type: 'test-entity',
    label: label,
    description: `Entity ${label} for merge race testing`,
  });

  if (status !== 201) {
    throw new Error(`Failed to create entity: ${JSON.stringify(data)}`);
  }

  return { entity_id: data.entity_id, manifest_cid: data.manifest_cid };
}

async function getEntity(entityId: string): Promise<any> {
  const { status, data } = await apiRequest('GET', `/entities-kg/${entityId}`);
  return data;
}

async function mergeEntity(
  sourceId: string,
  targetId: string,
  expectTip: string
): Promise<{ status: number; data: any }> {
  return apiRequest('POST', `/entities-kg/${sourceId}/merge`, {
    expect_tip: expectTip,
    merge_into: targetId,
    note: `Merging ${sourceId} into ${targetId}`,
  });
}

// ===========================================================================
// RACE CONDITION TESTS
// ===========================================================================

/**
 * Test 1: Mutual Merge Race Condition
 *
 * Creates two entities and tries to merge them into each other simultaneously.
 * This should trigger a cycle (both become redirects pointing to each other).
 */
async function testMutualMergeRace(): Promise<void> {
  section('Test: Mutual Merge Race Condition');

  const sourcePI = await createSourcePI();
  info(`Created source PI: ${sourcePI.pi}`);

  // Create two entities
  const entityA = await createEntity(sourcePI.pi, 'Entity A');
  const entityB = await createEntity(sourcePI.pi, 'Entity B');

  info(`Created Entity A: ${entityA.entity_id}`);
  info(`Created Entity B: ${entityB.entity_id}`);

  console.log('');
  info('Attempting simultaneous merges:');
  info(`  Worker 1: A → B (A becomes redirect to B)`);
  info(`  Worker 2: B → A (B becomes redirect to A)`);
  console.log('');

  // Attempt both merges simultaneously
  const startTime = Date.now();

  const [resultAtoB, resultBtoA] = await Promise.all([
    mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid),
    mergeEntity(entityB.entity_id, entityA.entity_id, entityB.manifest_cid),
  ]);

  const duration = Date.now() - startTime;
  info(`Both merges completed in ${duration}ms`);

  console.log('');
  log('blue', '── Results ──');
  console.log('');

  console.log('Merge A→B result:', JSON.stringify(resultAtoB, null, 2));
  console.log('');
  console.log('Merge B→A result:', JSON.stringify(resultBtoA, null, 2));

  // Check the state of both entities
  console.log('');
  log('blue', '── Entity States After Merges ──');
  console.log('');

  const stateA = await getEntity(entityA.entity_id);
  const stateB = await getEntity(entityB.entity_id);

  console.log('Entity A state:', JSON.stringify(stateA, null, 2));
  console.log('');
  console.log('Entity B state:', JSON.stringify(stateB, null, 2));

  // Analyze the result
  console.log('');
  log('blue', '── Analysis ──');
  console.log('');

  const aIsMerged = stateA.status === 'merged';
  const bIsMerged = stateB.status === 'merged';
  const aPointsToB = stateA.merged_into === entityB.entity_id;
  const bPointsToA = stateB.merged_into === entityA.entity_id;

  if (aIsMerged && bIsMerged) {
    if (aPointsToB && bPointsToA) {
      error('CYCLE DETECTED! Both entities are redirects pointing to each other.');
      error('  A.merged_into = B');
      error('  B.merged_into = A');
      warn('This is the race condition we need to fix in Phase 2!');
    } else if (aPointsToB) {
      info(`Both merged, but A → B, and B → ${stateB.merged_into}`);
      warn('Chain formed - B was merged somewhere else');
    } else if (bPointsToA) {
      info(`Both merged, but B → A, and A → ${stateA.merged_into}`);
      warn('Chain formed - A was merged somewhere else');
    }
  } else if (aIsMerged && !bIsMerged) {
    success('Only A→B succeeded. B is still a valid entity.');
    info(`A.merged_into = ${stateA.merged_into}`);
    info(`B is active with version ${stateB.ver}`);
  } else if (!aIsMerged && bIsMerged) {
    success('Only B→A succeeded. A is still a valid entity.');
    info(`B.merged_into = ${stateB.merged_into}`);
    info(`A is active with version ${stateA.ver}`);
  } else {
    warn('Neither merge succeeded?');
    info(`A state: ${JSON.stringify(stateA)}`);
    info(`B state: ${JSON.stringify(stateB)}`);
  }

  // Try to use the entities
  console.log('');
  log('blue', '── Usability Check ──');
  console.log('');

  try {
    const lightweightA = await apiRequest(
      'GET',
      `/entities-kg/${entityA.entity_id}?resolve=lightweight`
    );
    info(`Lightweight fetch A: ${JSON.stringify(lightweightA.data)}`);
  } catch (e) {
    error(`Lightweight fetch A failed: ${e}`);
  }

  try {
    const lightweightB = await apiRequest(
      'GET',
      `/entities-kg/${entityB.entity_id}?resolve=lightweight`
    );
    info(`Lightweight fetch B: ${JSON.stringify(lightweightB.data)}`);
  } catch (e) {
    error(`Lightweight fetch B failed: ${e}`);
  }
}

/**
 * Test 2: Multiple Concurrent Mutual Merges
 *
 * Run the mutual merge race multiple times to see consistency.
 */
async function testRepeatedMutualMergeRace(iterations: number): Promise<void> {
  section(`Test: Repeated Mutual Merge Race (${iterations} iterations)`);

  let cycles = 0;
  let aWins = 0;
  let bWins = 0;
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const sourcePI = await createSourcePI();
    const entityA = await createEntity(sourcePI.pi, `Entity A-${i}`);
    const entityB = await createEntity(sourcePI.pi, `Entity B-${i}`);

    // Attempt both merges simultaneously
    const [resultAtoB, resultBtoA] = await Promise.all([
      mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid),
      mergeEntity(entityB.entity_id, entityA.entity_id, entityB.manifest_cid),
    ]);

    // Check states
    const stateA = await getEntity(entityA.entity_id);
    const stateB = await getEntity(entityB.entity_id);

    const aIsMerged = stateA.status === 'merged';
    const bIsMerged = stateB.status === 'merged';
    const aPointsToB = stateA.merged_into === entityB.entity_id;
    const bPointsToA = stateB.merged_into === entityA.entity_id;

    if (aIsMerged && bIsMerged && aPointsToB && bPointsToA) {
      cycles++;
      process.stdout.write(COLORS.red + 'C' + COLORS.reset);
    } else if (aIsMerged && !bIsMerged) {
      aWins++;
      process.stdout.write(COLORS.green + 'A' + COLORS.reset);
    } else if (!aIsMerged && bIsMerged) {
      bWins++;
      process.stdout.write(COLORS.green + 'B' + COLORS.reset);
    } else {
      errors++;
      process.stdout.write(COLORS.yellow + '?' + COLORS.reset);
    }

    // Small delay between iterations
    await sleep(50);
  }

  console.log('');
  console.log('');
  log('blue', '── Summary ──');
  console.log('');
  console.log(`Total iterations: ${iterations}`);
  log('red', `Cycles (race condition): ${cycles} (${((cycles / iterations) * 100).toFixed(1)}%)`);
  log('green', `A wins: ${aWins} (${((aWins / iterations) * 100).toFixed(1)}%)`);
  log('green', `B wins: ${bWins} (${((bWins / iterations) * 100).toFixed(1)}%)`);
  if (errors > 0) {
    log('yellow', `Errors/Unknown: ${errors}`);
  }

  if (cycles > 0) {
    console.log('');
    error(`Found ${cycles} cycles! This is the race condition that Phase 2 needs to fix.`);
  } else {
    success('No cycles detected - merges are serializing correctly.');
  }
}

/**
 * Test 3: What happens when we try to use a cycled entity?
 */
async function testCycleUsability(): Promise<void> {
  section('Test: Cycle Usability (if cycle created)');

  const sourcePI = await createSourcePI();
  const entityA = await createEntity(sourcePI.pi, 'Cycle Test A');
  const entityB = await createEntity(sourcePI.pi, 'Cycle Test B');

  info(`Created Entity A: ${entityA.entity_id}`);
  info(`Created Entity B: ${entityB.entity_id}`);

  // Force both merges
  await Promise.all([
    mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid),
    mergeEntity(entityB.entity_id, entityA.entity_id, entityB.manifest_cid),
  ]);

  const stateA = await getEntity(entityA.entity_id);
  const stateB = await getEntity(entityB.entity_id);

  if (
    stateA.status === 'merged' &&
    stateB.status === 'merged' &&
    stateA.merged_into === entityB.entity_id &&
    stateB.merged_into === entityA.entity_id
  ) {
    warn('Cycle created! Testing what happens when we try to use these entities...');

    // Try lightweight fetch - should this follow the redirect?
    // If it does, it will loop forever (A→B→A→B...)
    console.log('');
    info('Attempting lightweight fetch on A (may hang if infinite loop)...');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        `${API_ENDPOINT}/entities-kg/${entityA.entity_id}?resolve=lightweight`,
        {
          headers: { 'X-Arke-Network': NETWORK },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);
      const data = await response.json();
      info(`Lightweight fetch returned: ${JSON.stringify(data)}`);
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') {
        error('Lightweight fetch TIMED OUT - likely infinite loop!');
      } else {
        error(`Lightweight fetch failed: ${e.message}`);
      }
    }

    // Try to update one of the entities
    console.log('');
    info('Attempting to update Entity A (should fail - it\'s merged)...');
    const updateResult = await apiRequest(
      'POST',
      `/entities-kg/${entityA.entity_id}/versions`,
      {
        expect_tip: entityA.manifest_cid,
        label: 'Updated A',
      }
    );
    if (updateResult.status === 409) {
      info('Update correctly rejected (409 Conflict)');
    } else {
      warn(`Unexpected update result: ${JSON.stringify(updateResult)}`);
    }
  } else {
    info('No cycle created in this run. One merge won.');
  }
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main(): Promise<void> {
  log('blue', `\n${'═'.repeat(70)}`);
  log('blue', '  MERGE RACE CONDITION TEST');
  log('blue', `${'═'.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);

  try {
    // Test 1: Single mutual merge race
    await testMutualMergeRace();
    await sleep(500);

    // Test 2: Repeated mutual merge races
    await testRepeatedMutualMergeRace(10);
    await sleep(500);

    // Test 3: Cycle usability
    await testCycleUsability();
  } catch (e) {
    error(`Test failed: ${e}`);
    process.exit(1);
  }

  console.log('');
  log('magenta', `${'═'.repeat(70)}`);
  log('magenta', '  TEST COMPLETE');
  log('magenta', `${'═'.repeat(70)}`);
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
