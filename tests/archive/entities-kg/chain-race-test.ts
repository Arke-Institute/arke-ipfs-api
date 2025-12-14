#!/usr/bin/env tsx
/**
 * Chain Race Condition Tests
 *
 * Tests scenarios where merges form chains rather than cycles:
 *
 * Test 1: Concurrent chain formation (A→B and B→C simultaneously)
 *   - What happens when A merges into B while B merges into C?
 *   - Expected: Either a chain forms (A→B→C or A→C) or one merge fails
 *
 * Test 2: Target merged during operation (A→B, but B already merged into C)
 *   - A tries to merge into B, but B has already merged into C
 *   - Expected: Error or auto-follow to C
 *
 * Run: npm run test:chain-race
 * Or:  tsx tests/entities-kg/chain-race-test.ts
 */

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

function info(msg: string) { log('cyan', `ℹ️  ${msg}`); }
function warn(msg: string) { log('yellow', `⚠️  ${msg}`); }
function error(msg: string) { log('red', `❌ ${msg}`); }
function success(msg: string) { log('green', `✅ ${msg}`); }
function section(title: string) {
  console.log('');
  log('magenta', '═'.repeat(70));
  log('magenta', `  ${title}`);
  log('magenta', '═'.repeat(70));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// API helpers
async function api(method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_ENDPOINT}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Arke-Network': NETWORK,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createSourcePI(): Promise<string> {
  const formData = new FormData();
  formData.append('file', new Blob(['test data'], { type: 'text/plain' }), 'test.txt');

  const uploadRes = await fetch(`${API_ENDPOINT}/upload`, { method: 'POST', body: formData });
  const [{ cid }] = await uploadRes.json();

  const res = await fetch(`${API_ENDPOINT}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Arke-Network': NETWORK },
    body: JSON.stringify({ components: { data: cid }, note: 'Test PI' }),
  });
  const data = await res.json();
  return data.pi;
}

async function createEntity(sourcePI: string, label: string): Promise<{ id: string; cid: string }> {
  const { data } = await api('POST', '/entities-kg', {
    created_by_pi: sourcePI,
    type: 'test-entity',
    label,
    description: `Entity ${label} for chain race testing`,
  });
  return { id: data.entity_id, cid: data.manifest_cid };
}

async function getEntity(entityId: string): Promise<any> {
  const { data } = await api('GET', `/entities-kg/${entityId}`);
  return data;
}

async function mergeEntity(sourceId: string, targetId: string, expectTip: string): Promise<{ status: number; data: any }> {
  return api('POST', `/entities-kg/${sourceId}/merge`, {
    expect_tip: expectTip,
    merge_into: targetId,
  });
}

// ===========================================================================
// TEST 1: Concurrent Chain Formation (A→B and B→C simultaneously)
// ===========================================================================

async function testConcurrentChainFormation(): Promise<void> {
  section('Test 1: Concurrent Chain Formation (A→B and B→C)');

  const pi = await createSourcePI();
  info(`Created source PI: ${pi}`);

  const A = await createEntity(pi, 'Entity A');
  const B = await createEntity(pi, 'Entity B');
  const C = await createEntity(pi, 'Entity C');

  info(`Created A: ${A.id}`);
  info(`Created B: ${B.id}`);
  info(`Created C: ${C.id}`);

  console.log('');
  info('Attempting concurrent merges:');
  info('  Worker 1: A → B (A becomes redirect to B)');
  info('  Worker 2: B → C (B becomes redirect to C)');
  console.log('');

  const startTime = Date.now();

  const [resultAB, resultBC] = await Promise.all([
    mergeEntity(A.id, B.id, A.cid),
    mergeEntity(B.id, C.id, B.cid),
  ]);

  const duration = Date.now() - startTime;
  info(`Both merges completed in ${duration}ms`);

  console.log('');
  log('blue', '── Merge Results ──');
  console.log('');
  console.log('A→B result:', JSON.stringify(resultAB, null, 2));
  console.log('');
  console.log('B→C result:', JSON.stringify(resultBC, null, 2));

  // Check final states
  console.log('');
  log('blue', '── Final Entity States ──');
  console.log('');

  const stateA = await getEntity(A.id);
  const stateB = await getEntity(B.id);
  const stateC = await getEntity(C.id);

  console.log('A state:', JSON.stringify(stateA, null, 2));
  console.log('');
  console.log('B state:', JSON.stringify(stateB, null, 2));
  console.log('');
  console.log('C state:', JSON.stringify(stateC, null, 2));

  // Lightweight fetches
  console.log('');
  log('blue', '── Lightweight Fetches (follow redirects) ──');
  console.log('');

  const lwA = await api('GET', `/entities-kg/${A.id}?resolve=lightweight`);
  const lwB = await api('GET', `/entities-kg/${B.id}?resolve=lightweight`);
  const lwC = await api('GET', `/entities-kg/${C.id}?resolve=lightweight`);

  info(`Lightweight A → ${lwA.data.entity_id} (${lwA.data.label})`);
  info(`Lightweight B → ${lwB.data.entity_id} (${lwB.data.label})`);
  info(`Lightweight C → ${lwC.data.entity_id} (${lwC.data.label})`);

  // Analysis
  console.log('');
  log('blue', '── Analysis ──');
  console.log('');

  const aIsMerged = stateA.status === 'merged';
  const bIsMerged = stateB.status === 'merged';
  const cIsMerged = stateC.status === 'merged';

  if (aIsMerged && bIsMerged && !cIsMerged) {
    if (stateA.merged_into === B.id && stateB.merged_into === C.id) {
      success('Chain formed: A → B → C');
      info(`  A.merged_into = ${stateA.merged_into}`);
      info(`  B.merged_into = ${stateB.merged_into}`);
      info(`  C is active at version ${stateC.ver}`);
    } else if (stateA.merged_into === C.id && stateB.merged_into === C.id) {
      success('Both merged directly into C: A → C, B → C');
      info(`  A.merged_into = ${stateA.merged_into}`);
      info(`  B.merged_into = ${stateB.merged_into}`);
    } else {
      warn('Both merged but unexpected targets');
      info(`  A.merged_into = ${stateA.merged_into}`);
      info(`  B.merged_into = ${stateB.merged_into}`);
    }
  } else if (aIsMerged && !bIsMerged && !cIsMerged) {
    warn('Only A→B succeeded');
    info(`  A.merged_into = ${stateA.merged_into}`);
    info(`  B is active at version ${stateB.ver}`);
    info(`  B→C failed with: ${resultBC.status}`);
  } else if (!aIsMerged && bIsMerged && !cIsMerged) {
    warn('Only B→C succeeded, A→B failed');
    info(`  A is active at version ${stateA.ver}`);
    info(`  B.merged_into = ${stateB.merged_into}`);
    info(`  A→B failed with: ${resultAB.status}`);
    if (resultAB.status === 409) {
      info(`  A→B error: ${resultAB.data.message || resultAB.data.error}`);
    }
  } else if (!aIsMerged && !bIsMerged) {
    error('Neither merge succeeded');
    info(`  A→B: ${resultAB.status} - ${resultAB.data.message || resultAB.data.error}`);
    info(`  B→C: ${resultBC.status} - ${resultBC.data.message || resultBC.data.error}`);
  } else {
    warn('Unexpected state');
    info(`  A merged? ${aIsMerged}`);
    info(`  B merged? ${bIsMerged}`);
    info(`  C merged? ${cIsMerged}`);
  }
}

// ===========================================================================
// TEST 2: Target Merged During Operation (A→B, but B already merged into C)
// ===========================================================================

async function testTargetMergedDuringOperation(): Promise<void> {
  section('Test 2: Target Merged During Operation');
  info('Scenario: A tries to merge into B, but B has already merged into C');

  const pi = await createSourcePI();
  info(`Created source PI: ${pi}`);

  const A = await createEntity(pi, 'Entity A');
  const B = await createEntity(pi, 'Entity B');
  const C = await createEntity(pi, 'Entity C');

  info(`Created A: ${A.id}`);
  info(`Created B: ${B.id}`);
  info(`Created C: ${C.id}`);

  // First, merge B into C
  console.log('');
  info('Step 1: Merge B → C first');

  const resultBC = await mergeEntity(B.id, C.id, B.cid);
  console.log('B→C result:', JSON.stringify(resultBC, null, 2));

  if (resultBC.status !== 201) {
    error('B→C failed unexpectedly');
    return;
  }
  success('B→C completed successfully');

  // Small delay to ensure B is fully merged
  await sleep(100);

  // Now try to merge A into B (which is now a redirect)
  console.log('');
  info('Step 2: Try to merge A → B (but B is now a redirect to C)');

  const resultAB = await mergeEntity(A.id, B.id, A.cid);
  console.log('A→B result:', JSON.stringify(resultAB, null, 2));

  // Check final states
  console.log('');
  log('blue', '── Final Entity States ──');
  console.log('');

  const stateA = await getEntity(A.id);
  const stateB = await getEntity(B.id);
  const stateC = await getEntity(C.id);

  console.log('A state:', JSON.stringify(stateA, null, 2));
  console.log('');
  console.log('B state:', JSON.stringify(stateB, null, 2));
  console.log('');
  console.log('C state:', JSON.stringify(stateC, null, 2));

  // Analysis
  console.log('');
  log('blue', '── Analysis ──');
  console.log('');

  const aIsMerged = stateA.status === 'merged';

  if (resultAB.status === 201 && aIsMerged) {
    if (stateA.merged_into === C.id) {
      success('A→B auto-followed chain: A now points directly to C');
      info(`  A.merged_into = ${stateA.merged_into} (followed B→C)`);
    } else if (stateA.merged_into === B.id) {
      warn('A points to B (which is a redirect) - chain formed');
      info(`  A.merged_into = ${stateA.merged_into}`);
      info(`  B.merged_into = ${stateB.merged_into}`);
    } else {
      warn(`A merged into unexpected target: ${stateA.merged_into}`);
    }
  } else if (resultAB.status === 409) {
    info('A→B returned 409 Conflict');
    info(`  Message: ${resultAB.data.message || resultAB.data.error}`);
    if (resultAB.data.error === 'CONFLICT_ERROR') {
      success('Correctly detected that target B was merged');
    }
  } else {
    warn(`Unexpected A→B status: ${resultAB.status}`);
    console.log('Response:', resultAB.data);
  }

  // Test lightweight fetch on A
  if (aIsMerged) {
    console.log('');
    log('blue', '── Lightweight Fetch Test ──');
    const lwA = await api('GET', `/entities-kg/${A.id}?resolve=lightweight`);
    info(`Lightweight A → ${lwA.data.entity_id} (${lwA.data.label})`);
    if (lwA.data.entity_id === C.id) {
      success('Lightweight fetch correctly resolves A through chain to C');
    }
  }
}

// ===========================================================================
// TEST 3: Repeated concurrent chain formation
// ===========================================================================

async function testRepeatedChainRace(iterations: number): Promise<void> {
  section(`Test 3: Repeated Chain Race (${iterations} iterations)`);

  let bothSucceed = 0;
  let onlyAB = 0;
  let onlyBC = 0;
  let neitherSucceed = 0;

  for (let i = 0; i < iterations; i++) {
    const pi = await createSourcePI();
    const A = await createEntity(pi, `A-${i}`);
    const B = await createEntity(pi, `B-${i}`);
    const C = await createEntity(pi, `C-${i}`);

    const [resultAB, resultBC] = await Promise.all([
      mergeEntity(A.id, B.id, A.cid),
      mergeEntity(B.id, C.id, B.cid),
    ]);

    const abSuccess = resultAB.status === 201;
    const bcSuccess = resultBC.status === 201;

    if (abSuccess && bcSuccess) {
      bothSucceed++;
      process.stdout.write(COLORS.green + '✓' + COLORS.reset);
    } else if (abSuccess && !bcSuccess) {
      onlyAB++;
      process.stdout.write(COLORS.yellow + 'A' + COLORS.reset);
    } else if (!abSuccess && bcSuccess) {
      onlyBC++;
      process.stdout.write(COLORS.yellow + 'B' + COLORS.reset);
    } else {
      neitherSucceed++;
      process.stdout.write(COLORS.red + '✗' + COLORS.reset);
    }

    await sleep(50);
  }

  console.log('');
  console.log('');
  log('blue', '── Summary ──');
  console.log('');
  console.log(`Total iterations: ${iterations}`);
  log('green', `Both succeed (chain formed): ${bothSucceed} (${((bothSucceed / iterations) * 100).toFixed(1)}%)`);
  log('yellow', `Only A→B succeeded: ${onlyAB} (${((onlyAB / iterations) * 100).toFixed(1)}%)`);
  log('yellow', `Only B→C succeeded: ${onlyBC} (${((onlyBC / iterations) * 100).toFixed(1)}%)`);
  if (neitherSucceed > 0) {
    log('red', `Neither succeeded: ${neitherSucceed}`);
  }
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main(): Promise<void> {
  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  CHAIN RACE CONDITION TESTS');
  log('blue', '═'.repeat(70) + '\n');

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);

  try {
    // Test 1: Concurrent chain formation
    await testConcurrentChainFormation();
    await sleep(500);

    // Test 2: Target merged during operation
    await testTargetMergedDuringOperation();
    await sleep(500);

    // Test 3: Repeated to see distribution
    await testRepeatedChainRace(10);

  } catch (e) {
    error(`Test failed: ${e}`);
    process.exit(1);
  }

  console.log('');
  log('magenta', '═'.repeat(70));
  log('magenta', '  TESTS COMPLETE');
  log('magenta', '═'.repeat(70));
}

main().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
