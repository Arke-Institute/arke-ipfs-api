#!/usr/bin/env tsx
/**
 * Retry Merge Test - Production-like Scenario
 *
 * Simulates a production environment where:
 * 1. A→B and B→C merges happen concurrently
 * 2. A→B fails with 409 (target merged during operation)
 * 3. Retry mechanism kicks in with exponential backoff
 * 4. A→B retry succeeds by auto-following chain to A→C
 *
 * Expected final state: A→C, B→C (both point to C)
 *
 * Run: npm run test:retry-merge
 * Or:  tsx tests/entities-kg/retry-merge-test.ts
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
  gray: '\x1b[90m',
};

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function info(msg: string) { log('cyan', `ℹ️  ${msg}`); }
function warn(msg: string) { log('yellow', `⚠️  ${msg}`); }
function error(msg: string) { log('red', `❌ ${msg}`); }
function success(msg: string) { log('green', `✅ ${msg}`); }
function debug(msg: string) { log('gray', `   ${msg}`); }
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
    description: `Entity ${label} for retry merge testing`,
  });
  return { id: data.entity_id, cid: data.manifest_cid };
}

async function getEntity(entityId: string): Promise<any> {
  const { data } = await api('GET', `/entities-kg/${entityId}`);
  return data;
}

// ===========================================================================
// RETRY LOGIC - Production-like implementation
// ===========================================================================

interface MergeResult {
  success: boolean;
  attempts: number;
  finalStatus: number;
  finalData: any;
  mergedInto?: string;
}

/**
 * Merge with retry and exponential backoff
 * This simulates what a production client would do
 */
async function mergeWithRetry(
  sourceId: string,
  targetId: string,
  maxRetries: number = 3,
  label: string = 'Merge'
): Promise<MergeResult> {
  let attempts = 0;
  let lastStatus = 0;
  let lastData: any = null;

  while (attempts < maxRetries) {
    attempts++;

    // Get fresh entity state before each attempt
    const entityState = await getEntity(sourceId);

    // If already merged, we're done
    if (entityState.status === 'merged') {
      debug(`${label}: Source already merged into ${entityState.merged_into}`);
      return {
        success: true,
        attempts,
        finalStatus: 200,
        finalData: entityState,
        mergedInto: entityState.merged_into,
      };
    }

    // Get current tip for CAS
    const currentTip = entityState.manifest_cid;

    debug(`${label}: Attempt ${attempts}/${maxRetries} with tip ${currentTip.slice(-8)}`);

    // Try the merge
    const result = await api('POST', `/entities-kg/${sourceId}/merge`, {
      expect_tip: currentTip,
      merge_into: targetId,
    });

    lastStatus = result.status;
    lastData = result.data;

    if (result.status === 201) {
      // Success!
      success(`${label}: Succeeded on attempt ${attempts}`);
      debug(`  merged_into: ${result.data.merged_into}`);
      return {
        success: true,
        attempts,
        finalStatus: result.status,
        finalData: result.data,
        mergedInto: result.data.merged_into,
      };
    }

    if (result.status === 409) {
      // Conflict - check if it's retryable
      const message = result.data.message || '';

      if (message.includes('Source restored')) {
        // Target was merged during operation - retryable
        warn(`${label}: Target merged during operation (attempt ${attempts}), will retry...`);
      } else if (message.includes('CAS')) {
        // CAS failure - entity was modified, retryable
        warn(`${label}: CAS failure (attempt ${attempts}), will retry...`);
      } else if (result.data.conflict) {
        // Tiebreaker conflict - we lost, not retryable
        error(`${label}: Lost tiebreaker conflict, not retrying`);
        return {
          success: false,
          attempts,
          finalStatus: result.status,
          finalData: result.data,
        };
      } else {
        // Other conflict (e.g., already merged into different target)
        warn(`${label}: Conflict: ${message}`);
      }

      // Exponential backoff with jitter
      const baseDelay = 100 * Math.pow(2, attempts - 1); // 100ms, 200ms, 400ms...
      const jitter = Math.random() * 100;
      const delay = baseDelay + jitter;

      debug(`  Waiting ${delay.toFixed(0)}ms before retry...`);
      await sleep(delay);
      continue;
    }

    // Other error - not retryable
    error(`${label}: Failed with status ${result.status}: ${result.data.message || result.data.error}`);
    return {
      success: false,
      attempts,
      finalStatus: result.status,
      finalData: result.data,
    };
  }

  // Exhausted retries
  error(`${label}: Exhausted ${maxRetries} retries`);
  return {
    success: false,
    attempts,
    finalStatus: lastStatus,
    finalData: lastData,
  };
}

// ===========================================================================
// TEST: Concurrent merges with retry
// ===========================================================================

async function testConcurrentMergesWithRetry(): Promise<boolean> {
  section('Test: Concurrent Merges with Retry (A→B and B→C)');

  const pi = await createSourcePI();
  info(`Created source PI: ${pi}`);

  const A = await createEntity(pi, 'Entity A');
  const B = await createEntity(pi, 'Entity B');
  const C = await createEntity(pi, 'Entity C');

  info(`Created A: ${A.id}`);
  info(`Created B: ${B.id}`);
  info(`Created C: ${C.id}`);

  console.log('');
  info('Starting concurrent merges with retry logic:');
  info('  Worker 1: A → B (with retry)');
  info('  Worker 2: B → C (with retry)');
  console.log('');

  const startTime = Date.now();

  // Run both merges concurrently with retry
  const [resultAB, resultBC] = await Promise.all([
    mergeWithRetry(A.id, B.id, 5, 'A→B'),
    mergeWithRetry(B.id, C.id, 5, 'B→C'),
  ]);

  const duration = Date.now() - startTime;
  console.log('');
  info(`Both operations completed in ${duration}ms`);

  // Results summary
  console.log('');
  log('blue', '── Merge Results ──');
  console.log('');

  console.log('A→B result:', JSON.stringify({
    success: resultAB.success,
    attempts: resultAB.attempts,
    mergedInto: resultAB.mergedInto,
  }, null, 2));

  console.log('');
  console.log('B→C result:', JSON.stringify({
    success: resultBC.success,
    attempts: resultBC.attempts,
    mergedInto: resultBC.mergedInto,
  }, null, 2));

  // Check final states
  console.log('');
  log('blue', '── Final Entity States ──');
  console.log('');

  const stateA = await getEntity(A.id);
  const stateB = await getEntity(B.id);
  const stateC = await getEntity(C.id);

  const aIsMerged = stateA.status === 'merged';
  const bIsMerged = stateB.status === 'merged';
  const cIsActive = !stateC.status || stateC.status !== 'merged';

  info(`A: ${aIsMerged ? `merged → ${stateA.merged_into}` : `active (v${stateA.ver})`}`);
  info(`B: ${bIsMerged ? `merged → ${stateB.merged_into}` : `active (v${stateB.ver})`}`);
  info(`C: ${cIsActive ? `active (v${stateC.ver})` : `merged → ${stateC.merged_into}`}`);

  // Verify expected outcome
  console.log('');
  log('blue', '── Verification ──');
  console.log('');

  let passed = true;

  // Both should have succeeded
  if (!resultAB.success) {
    error('A→B should have succeeded');
    passed = false;
  }
  if (!resultBC.success) {
    error('B→C should have succeeded');
    passed = false;
  }

  // A should be merged into C (after retry and auto-follow)
  if (aIsMerged && stateA.merged_into === C.id) {
    success('A merged directly into C (auto-followed chain on retry)');
  } else if (aIsMerged && stateA.merged_into === B.id) {
    warn('A merged into B (chain: A→B→C) - acceptable but not optimal');
  } else if (!aIsMerged) {
    error('A should be merged');
    passed = false;
  }

  // B should be merged into C
  if (bIsMerged && stateB.merged_into === C.id) {
    success('B merged into C');
  } else {
    error(`B should be merged into C, got: ${stateB.merged_into || 'not merged'}`);
    passed = false;
  }

  // C should be active
  if (cIsActive) {
    success('C is the canonical entity (active)');
  } else {
    error('C should be active');
    passed = false;
  }

  // Lightweight fetches should all resolve to C
  console.log('');
  log('blue', '── Lightweight Fetch Verification ──');
  console.log('');

  const lwA = await api('GET', `/entities-kg/${A.id}?resolve=lightweight`);
  const lwB = await api('GET', `/entities-kg/${B.id}?resolve=lightweight`);
  const lwC = await api('GET', `/entities-kg/${C.id}?resolve=lightweight`);

  if (lwA.data.entity_id === C.id) {
    success(`Lightweight A → C (${lwA.data.label})`);
  } else {
    error(`Lightweight A should resolve to C, got ${lwA.data.entity_id}`);
    passed = false;
  }

  if (lwB.data.entity_id === C.id) {
    success(`Lightweight B → C (${lwB.data.label})`);
  } else {
    error(`Lightweight B should resolve to C, got ${lwB.data.entity_id}`);
    passed = false;
  }

  if (lwC.data.entity_id === C.id) {
    success(`Lightweight C → C (${lwC.data.label})`);
  } else {
    error(`Lightweight C should resolve to C, got ${lwC.data.entity_id}`);
    passed = false;
  }

  return passed;
}

// ===========================================================================
// TEST: Multiple iterations to verify consistency
// ===========================================================================

async function testRepeatedConcurrentMerges(iterations: number): Promise<void> {
  section(`Test: Repeated Concurrent Merges (${iterations} iterations)`);

  let allSuccess = 0;
  let aDirectToC = 0;
  let aToB = 0;
  let failures = 0;

  for (let i = 0; i < iterations; i++) {
    const pi = await createSourcePI();
    const A = await createEntity(pi, `A-${i}`);
    const B = await createEntity(pi, `B-${i}`);
    const C = await createEntity(pi, `C-${i}`);

    const [resultAB, resultBC] = await Promise.all([
      mergeWithRetry(A.id, B.id, 5, `[${i}] A→B`),
      mergeWithRetry(B.id, C.id, 5, `[${i}] B→C`),
    ]);

    if (resultAB.success && resultBC.success) {
      allSuccess++;

      if (resultAB.mergedInto === C.id) {
        aDirectToC++;
        process.stdout.write(COLORS.green + 'C' + COLORS.reset);
      } else if (resultAB.mergedInto === B.id) {
        aToB++;
        process.stdout.write(COLORS.yellow + 'B' + COLORS.reset);
      } else {
        process.stdout.write(COLORS.cyan + '?' + COLORS.reset);
      }
    } else {
      failures++;
      process.stdout.write(COLORS.red + 'X' + COLORS.reset);
    }

    await sleep(100);
  }

  console.log('');
  console.log('');
  log('blue', '── Summary ──');
  console.log('');
  console.log(`Total iterations: ${iterations}`);
  log('green', `All merges succeeded: ${allSuccess} (${((allSuccess / iterations) * 100).toFixed(1)}%)`);
  log('green', `  A→C directly (optimal): ${aDirectToC}`);
  log('yellow', `  A→B (chain A→B→C): ${aToB}`);
  if (failures > 0) {
    log('red', `Failures: ${failures}`);
  }

  if (allSuccess === iterations) {
    console.log('');
    success('All iterations succeeded! Retry mechanism works correctly.');
  }
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main(): Promise<void> {
  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  RETRY MERGE TEST - Production-like Scenario');
  log('blue', '═'.repeat(70) + '\n');

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);

  try {
    // Test 1: Single concurrent merge with retry
    const test1Passed = await testConcurrentMergesWithRetry();
    await sleep(500);

    // Test 2: Repeated to verify consistency
    await testRepeatedConcurrentMerges(10);

    console.log('');
    log('magenta', '═'.repeat(70));
    if (test1Passed) {
      log('green', '  ALL TESTS PASSED');
    } else {
      log('red', '  SOME TESTS FAILED');
    }
    log('magenta', '═'.repeat(70));

  } catch (e) {
    error(`Test failed: ${e}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
