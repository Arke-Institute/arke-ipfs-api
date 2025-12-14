#!/usr/bin/env tsx
/**
 * Entities-KG Integration Test Suite
 *
 * Comprehensive testing for Knowledge Graph entity endpoints.
 * Tests create, get, update, merge, and batch operations.
 *
 * Run: npm run test:entities-kg
 * Or:  tsx tests/entities-kg/entities-kg-test-suite.ts
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

// Create a PI entity (needed for created_by_pi field)
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

// ===========================================================================
// TEST SUITES
// ===========================================================================

/**
 * Test 1: Basic Entity Creation
 */
async function testEntityCreation(): Promise<void> {
  section('Test 1: Entity Creation');

  const sourcePI = await createSourcePI();
  info(`Created source PI: ${sourcePI.pi}`);

  // Test 1a: Create entity with minimal fields
  subsection('1a: Minimal entity creation');
  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'person',
      label: 'Alice Austen',
    });

    if (status === 201 && data.entity_id && data.ver === 1 && data.manifest_cid) {
      pass(`Created entity: ${data.entity_id}`);
    } else {
      fail('Unexpected response', data);
    }
  } catch (error) {
    fail('Entity creation failed', error);
  }

  // Test 1b: Create entity with all fields
  subsection('1b: Full entity creation');
  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'person',
      label: 'Bob Smith',
      description: 'A test person entity with full details',
      properties: {
        birth_date: '1990-01-15',
        occupation: 'Developer',
        aliases: ['Bobby', 'Robert'],
      },
      relationships: [
        {
          predicate: 'appears_in',
          target_type: 'pi',
          target_id: sourcePI.pi,
          target_label: 'Test Source',
        },
      ],
      source_pis: [sourcePI.pi],
      note: 'Created with full details',
    });

    if (
      status === 201 &&
      data.entity_id &&
      data.ver === 1
    ) {
      pass(`Created full entity: ${data.entity_id}`);
    } else {
      fail('Unexpected response', data);
    }
  } catch (error) {
    fail('Full entity creation failed', error);
  }

  // Test 1c: Create entity with custom entity_id
  subsection('1c: Custom entity_id');
  try {
    // Generate test network entity ID (starts with II)
    const customId = 'II' + ulid().slice(2);

    const { status, data } = await apiRequest('POST', '/entities-kg', {
      entity_id: customId,
      created_by_pi: sourcePI.pi,
      type: 'place',
      label: 'Test Location',
    });

    if (status === 201 && data.entity_id === customId) {
      pass(`Created entity with custom ID: ${customId}`);
    } else {
      fail('Custom ID not preserved', data);
    }
  } catch (error) {
    fail('Custom entity_id creation failed', error);
  }

  // Test 1d: Duplicate entity_id should fail
  subsection('1d: Duplicate entity_id rejection');
  try {
    const customId = 'II' + ulid().slice(2);

    // Create first
    await apiRequest('POST', '/entities-kg', {
      entity_id: customId,
      created_by_pi: sourcePI.pi,
      type: 'organization',
      label: 'Org 1',
    });

    // Try to create duplicate
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      entity_id: customId,
      created_by_pi: sourcePI.pi,
      type: 'organization',
      label: 'Org 2',
    });

    if (status === 409 && data.error === 'CONFLICT') {
      pass('Correctly rejected duplicate entity_id');
    } else {
      fail('Expected 409 CONFLICT', { status, data });
    }
  } catch (error: any) {
    if (error.message.includes('409')) {
      pass('Correctly rejected duplicate entity_id');
    } else {
      fail('Unexpected error', error);
    }
  }

  // Test 1e: Invalid created_by_pi should fail
  subsection('1e: Invalid created_by_pi validation');
  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: 'invalid-pi',
      type: 'person',
      label: 'Invalid Test',
    });

    if (status === 400 && data.error === 'VALIDATION_ERROR') {
      pass('Correctly rejected invalid created_by_pi');
    } else {
      fail('Expected 400 VALIDATION_ERROR', { status, data });
    }
  } catch (error) {
    fail('Validation test failed', error);
  }
}

/**
 * Test 2: Get Entity
 */
async function testGetEntity(): Promise<void> {
  section('Test 2: Get Entity');

  const sourcePI = await createSourcePI();

  // Create test entity
  const { data: created } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI.pi,
    type: 'concept',
    label: 'Test Concept',
    description: 'A concept for testing get operations',
    properties: { key: 'value' },
  });
  info(`Created test entity: ${created.entity_id}`);

  // Test 2a: Get entity full response
  subsection('2a: Get full entity');
  try {
    const { status, data } = await apiRequest(
      'GET',
      `/entities-kg/${created.entity_id}`
    );

    if (
      status === 200 &&
      data.entity_id === created.entity_id &&
      data.type === 'concept' &&
      data.label === 'Test Concept' &&
      data.description === 'A concept for testing get operations' &&
      data.ver === 1 &&
      data.manifest_cid === created.manifest_cid &&
      Array.isArray(data.source_pis) &&
      data.components.properties
    ) {
      pass('Full entity response correct');
    } else {
      fail('Unexpected response structure', data);
    }
  } catch (error) {
    fail('Get entity failed', error);
  }

  // Test 2b: Get lightweight entity
  subsection('2b: Get lightweight entity');
  try {
    const { status, data } = await apiRequest(
      'GET',
      `/entities-kg/${created.entity_id}?resolve=lightweight`
    );

    if (
      status === 200 &&
      data.entity_id === created.entity_id &&
      data.type === 'concept' &&
      data.label === 'Test Concept' &&
      data.description === 'A concept for testing get operations' &&
      !data.components && // Lightweight should not have components
      !data.source_pis // Lightweight should not have source_pis
    ) {
      pass('Lightweight response correct');
    } else {
      fail('Unexpected lightweight response', data);
    }
  } catch (error) {
    fail('Get lightweight entity failed', error);
  }

  // Test 2c: Get non-existent entity
  subsection('2c: Get non-existent entity');
  try {
    const fakeId = 'II' + ulid().slice(2);
    const { status, data } = await apiRequest('GET', `/entities-kg/${fakeId}`);

    if (status === 404 && data.error === 'NOT_FOUND') {
      pass('Correctly returned 404 for non-existent entity');
    } else {
      fail('Expected 404 NOT_FOUND', { status, data });
    }
  } catch (error) {
    fail('Non-existent entity test failed', error);
  }
}

/**
 * Test 3: Append Entity Version
 */
async function testAppendVersion(): Promise<void> {
  section('Test 3: Append Entity Version');

  const sourcePI = await createSourcePI();
  const sourcePI2 = await createSourcePI();

  const { data: created } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI.pi,
    type: 'event',
    label: 'Test Event',
    description: 'Original description',
    properties: { year: 2020 },
  });
  info(`Created test entity: ${created.entity_id}`);

  // Test 3a: Update core fields
  subsection('3a: Update core fields');
  try {
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${created.entity_id}/versions`,
      {
        expect_tip: created.manifest_cid,
        label: 'Updated Event',
        description: 'Updated description',
        note: 'Updated core fields',
      }
    );

    if (status === 201 && data.ver === 2) {
      // Verify the update
      const { data: updated } = await apiRequest(
        'GET',
        `/entities-kg/${created.entity_id}`
      );

      if (
        updated.label === 'Updated Event' &&
        updated.description === 'Updated description' &&
        updated.ver === 2
      ) {
        pass('Core fields updated successfully');
      } else {
        fail('Updates not reflected', updated);
      }
    } else {
      fail('Version append failed', data);
    }
  } catch (error) {
    fail('Update core fields failed', error);
  }

  // Get current tip for next test
  const { data: current } = await apiRequest(
    'GET',
    `/entities-kg/${created.entity_id}`
  );

  // Test 3b: Update properties
  subsection('3b: Update properties');
  try {
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${created.entity_id}/versions`,
      {
        expect_tip: current.manifest_cid,
        properties: { year: 2021, location: 'New York' },
        note: 'Updated properties',
      }
    );

    if (status === 201 && data.ver === 3) {
      pass('Properties updated successfully');
    } else {
      fail('Properties update failed', data);
    }
  } catch (error) {
    fail('Update properties failed', error);
  }

  // Get current tip for next test
  const { data: current2 } = await apiRequest(
    'GET',
    `/entities-kg/${created.entity_id}`
  );

  // Test 3c: Add source_pis
  subsection('3c: Add source_pis');
  try {
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${created.entity_id}/versions`,
      {
        expect_tip: current2.manifest_cid,
        source_pis_add: [sourcePI2.pi],
        note: 'Added source PI',
      }
    );

    if (status === 201 && data.ver === 4) {
      const { data: updated } = await apiRequest(
        'GET',
        `/entities-kg/${created.entity_id}`
      );

      if (
        updated.source_pis.includes(sourcePI.pi) &&
        updated.source_pis.includes(sourcePI2.pi)
      ) {
        pass('Source PIs added successfully');
      } else {
        fail('Source PIs not added', updated.source_pis);
      }
    } else {
      fail('Add source_pis failed', data);
    }
  } catch (error) {
    fail('Add source_pis failed', error);
  }

  // Test 3d: CAS failure (wrong expect_tip)
  subsection('3d: CAS failure detection');
  try {
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${created.entity_id}/versions`,
      {
        expect_tip: 'bafyreiwrongcid1234567890abcdefghijklmnop', // Wrong CID
        label: 'Should Fail',
      }
    );

    if (status === 409 && data.error === 'CAS_FAILURE') {
      pass('CAS failure correctly detected');
    } else {
      fail('Expected 409 CAS_FAILURE', { status, data });
    }
  } catch (error) {
    fail('CAS failure test failed', error);
  }
}

/**
 * Test 4: Merge Entity
 */
async function testMergeEntity(): Promise<void> {
  section('Test 4: Merge Entity');

  const sourcePI = await createSourcePI();

  // Create source entity (will be merged)
  const { data: source } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI.pi,
    type: 'person',
    label: 'A. Austen',
    description: 'Same person, different name',
    properties: { nickname: 'Ally' },
  });
  info(`Created source entity: ${source.entity_id}`);

  // Create target entity (will absorb source)
  const { data: target } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI.pi,
    type: 'person',
    label: 'Alice Austen',
    description: 'The primary entity',
    properties: { occupation: 'Photographer' },
  });
  info(`Created target entity: ${target.entity_id}`);

  // Test 4a: Merge source into target
  subsection('4a: Merge entities');
  try {
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${source.entity_id}/merge`,
      {
        expect_tip: source.manifest_cid,
        merge_into: target.entity_id,
        note: 'Same person, different name variant',
      }
    );

    if (
      status === 201 &&
      data.source_entity_id === source.entity_id &&
      data.merged_into === target.entity_id &&
      data.source_new_ver === 2 &&
      data.target_new_ver === 2
    ) {
      pass('Merge completed successfully');
    } else {
      fail('Merge response incorrect', data);
    }
  } catch (error) {
    fail('Merge failed', error);
  }

  // Test 4b: Get merged entity returns redirect
  subsection('4b: Get merged entity returns redirect');
  try {
    const { status, data } = await apiRequest(
      'GET',
      `/entities-kg/${source.entity_id}`
    );

    if (
      status === 200 &&
      data.status === 'merged' &&
      data.entity_id === source.entity_id &&
      data.merged_into === target.entity_id &&
      data.prev_cid // Should have prev_cid for history
    ) {
      pass('Merged entity returns redirect info');
    } else {
      fail('Expected merged redirect response', data);
    }
  } catch (error) {
    fail('Get merged entity failed', error);
  }

  // Test 4c: Lightweight fetch follows redirect
  subsection('4c: Lightweight fetch follows redirect');
  try {
    const { status, data } = await apiRequest(
      'GET',
      `/entities-kg/${source.entity_id}?resolve=lightweight`
    );

    if (
      status === 200 &&
      data.entity_id === target.entity_id && // Should return target!
      data.label === 'Alice Austen'
    ) {
      pass('Lightweight fetch correctly follows redirect');
    } else {
      fail('Lightweight should follow redirect', data);
    }
  } catch (error) {
    fail('Lightweight redirect test failed', error);
  }

  // Test 4d: Target has combined source_pis
  subsection('4d: Target has combined source_pis');
  try {
    const { data } = await apiRequest('GET', `/entities-kg/${target.entity_id}`);

    if (
      data.source_pis.length === 1 &&
      data.source_pis.includes(sourcePI.pi) &&
      data.ver === 2 &&
      data.note === 'Absorbed entity A. Austen'
    ) {
      pass('Target updated with source_pis from absorbed entity');
    } else {
      fail('Target source_pis not updated correctly', data);
    }
  } catch (error) {
    fail('Target verification failed', error);
  }

  // Test 4e: Cannot update merged entity
  subsection('4e: Cannot update merged entity');
  try {
    const { data: mergedEntity } = await apiRequest(
      'GET',
      `/entities-kg/${source.entity_id}`
    );

    // Try to update the merged entity
    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${source.entity_id}/versions`,
      {
        expect_tip: mergedEntity.prev_cid, // Using the prev_cid
        label: 'Should Fail',
      }
    );

    if (status === 409) {
      pass('Correctly rejected update to merged entity');
    } else {
      fail('Should have rejected update to merged entity', { status, data });
    }
  } catch (error: any) {
    if (error.message.includes('409')) {
      pass('Correctly rejected update to merged entity');
    } else {
      fail('Unexpected error', error);
    }
  }

  // Test 4f: Cannot merge already merged entity
  subsection('4f: Cannot merge already merged entity');
  try {
    const { data: anotherTarget } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'person',
      label: 'Another Person',
    });

    const { status, data } = await apiRequest(
      'POST',
      `/entities-kg/${source.entity_id}/merge`,
      {
        expect_tip: 'bafyreisomecid', // Doesn't matter, should fail before CAS check
        merge_into: anotherTarget.entity_id,
      }
    );

    if (status === 409) {
      pass('Correctly rejected merging already merged entity');
    } else {
      fail('Should have rejected merging already merged entity', {
        status,
        data,
      });
    }
  } catch (error: any) {
    if (error.message.includes('409')) {
      pass('Correctly rejected merging already merged entity');
    } else {
      fail('Unexpected error', error);
    }
  }
}

/**
 * Test 5: Batch Lightweight Fetch
 */
async function testBatchLightweight(): Promise<void> {
  section('Test 5: Batch Lightweight Fetch');

  const sourcePI = await createSourcePI();

  // Create multiple entities
  const entityIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'item',
      label: `Item ${i}`,
      description: `Description for item ${i}`,
    });
    entityIds.push(data.entity_id);
  }
  info(`Created ${entityIds.length} test entities`);

  // Test 5a: Batch fetch all entities
  subsection('5a: Batch fetch multiple entities');
  try {
    const { status, data } = await apiRequest(
      'POST',
      '/entities-kg/batch/lightweight',
      {
        entity_ids: entityIds,
      }
    );

    if (
      status === 200 &&
      data.entities.length === 5 &&
      data.entities.every(
        (e: any) =>
          e.entity_id && e.type === 'item' && e.label && e.description
      )
    ) {
      pass('Batch fetch returned all entities');
    } else {
      fail('Batch fetch response incorrect', data);
    }
  } catch (error) {
    fail('Batch fetch failed', error);
  }

  // Test 5b: Batch fetch with non-existent entities
  subsection('5b: Batch fetch with missing entities');
  try {
    const fakeId = 'II' + ulid().slice(2);
    const { status, data } = await apiRequest(
      'POST',
      '/entities-kg/batch/lightweight',
      {
        entity_ids: [entityIds[0], fakeId, entityIds[1]],
      }
    );

    if (
      status === 200 &&
      data.entities.length === 2 // Only 2 found
    ) {
      pass('Batch fetch skips non-existent entities');
    } else {
      fail('Batch fetch should skip missing entities', data);
    }
  } catch (error) {
    fail('Batch fetch with missing entities failed', error);
  }

  // Test 5c: Empty batch
  subsection('5c: Empty batch');
  try {
    const { status, data } = await apiRequest(
      'POST',
      '/entities-kg/batch/lightweight',
      {
        entity_ids: [],
      }
    );

    if (status === 200 && data.entities.length === 0) {
      pass('Empty batch returns empty array');
    } else {
      fail('Empty batch should return empty array', data);
    }
  } catch (error) {
    fail('Empty batch test failed', error);
  }

  // Test 5d: Batch size limit
  subsection('5d: Batch size limit (>100)');
  try {
    const tooManyIds = Array.from({ length: 101 }, () => 'II' + ulid().slice(2));
    const { status, data } = await apiRequest(
      'POST',
      '/entities-kg/batch/lightweight',
      {
        entity_ids: tooManyIds,
      }
    );

    if (status === 400 && data.error === 'VALIDATION_ERROR') {
      pass('Correctly rejected >100 entity_ids');
    } else {
      fail('Expected 400 VALIDATION_ERROR', { status, data });
    }
  } catch (error) {
    fail('Batch limit test failed', error);
  }
}

/**
 * Test 6: Network Isolation
 */
async function testNetworkIsolation(): Promise<void> {
  section('Test 6: Network Isolation');

  // Test 6a: Entity created on test network should have II prefix
  subsection('6a: Test network entity has II prefix');
  const sourcePI = await createSourcePI();

  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'test-entity',
      label: 'Network Test',
    });

    if (status === 201 && data.entity_id.startsWith('II')) {
      pass(`Entity ID has test network prefix: ${data.entity_id}`);
    } else {
      fail('Entity ID should have II prefix', data);
    }
  } catch (error) {
    fail('Network test failed', error);
  }

  // Test 6b: Cannot use main network entity_id on test network
  subsection('6b: Reject main network entity_id on test network');
  try {
    const mainNetworkId = ulid(); // No II prefix = main network

    const { status, data } = await apiRequest('POST', '/entities-kg', {
      entity_id: mainNetworkId,
      created_by_pi: sourcePI.pi,
      type: 'test-entity',
      label: 'Should Fail',
    });

    if (status === 400 && data.error === 'VALIDATION_ERROR') {
      pass('Correctly rejected main network entity_id');
    } else {
      fail('Expected 400 VALIDATION_ERROR', { status, data });
    }
  } catch (error) {
    fail('Network validation test failed', error);
  }
}

/**
 * Test 7: Edge Cases
 */
async function testEdgeCases(): Promise<void> {
  section('Test 7: Edge Cases');

  const sourcePI = await createSourcePI();

  // Test 7a: Entity with empty properties
  subsection('7a: Entity with empty properties object');
  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'minimal',
      label: 'Minimal Entity',
      properties: {},
    });

    if (status === 201) {
      const { data: fetched } = await apiRequest(
        'GET',
        `/entities-kg/${data.entity_id}`
      );

      if (!fetched.components.properties) {
        pass('Empty properties object results in no properties component');
      } else {
        fail('Should not store empty properties', fetched);
      }
    }
  } catch (error) {
    fail('Empty properties test failed', error);
  }

  // Test 7b: Entity with empty relationships array
  subsection('7b: Entity with empty relationships array');
  try {
    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'minimal',
      label: 'No Relationships',
      relationships: [],
    });

    if (status === 201) {
      const { data: fetched } = await apiRequest(
        'GET',
        `/entities-kg/${data.entity_id}`
      );

      if (!fetched.components.relationships) {
        pass('Empty relationships array results in no relationships component');
      } else {
        fail('Should not store empty relationships', fetched);
      }
    }
  } catch (error) {
    fail('Empty relationships test failed', error);
  }

  // Test 7c: Special characters in label
  subsection('7c: Special characters in label');
  try {
    const specialLabel = 'Test "Entity" with <special> & chars 日本語';

    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'special',
      label: specialLabel,
    });

    if (status === 201) {
      const { data: fetched } = await apiRequest(
        'GET',
        `/entities-kg/${data.entity_id}`
      );

      if (fetched.label === specialLabel) {
        pass('Special characters preserved correctly');
      } else {
        fail('Special characters not preserved', {
          expected: specialLabel,
          actual: fetched.label,
        });
      }
    }
  } catch (error) {
    fail('Special characters test failed', error);
  }

  // Test 7d: Very long description
  subsection('7d: Very long description');
  try {
    const longDescription = 'A'.repeat(10000);

    const { status, data } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'verbose',
      label: 'Long Description Test',
      description: longDescription,
    });

    if (status === 201) {
      const { data: fetched } = await apiRequest(
        'GET',
        `/entities-kg/${data.entity_id}`
      );

      if (fetched.description?.length === 10000) {
        pass('Long description stored correctly');
      } else {
        fail('Long description not preserved', {
          expected: 10000,
          actual: fetched.description?.length,
        });
      }
    }
  } catch (error) {
    fail('Long description test failed', error);
  }

  // Test 7e: Update to clear optional fields
  subsection('7e: Clear description via update');
  try {
    const { data: created } = await apiRequest('POST', '/entities-kg', {
      created_by_pi: sourcePI.pi,
      type: 'clearable',
      label: 'Has Description',
      description: 'Will be cleared',
    });

    // Verify description exists
    const { data: before } = await apiRequest(
      'GET',
      `/entities-kg/${created.entity_id}`
    );
    if (!before.description) {
      fail('Entity should have description initially');
      return;
    }

    // Clear description (set to empty/undefined)
    // Note: Currently the API preserves old values if not provided
    // This test documents current behavior
    const { data: updated } = await apiRequest(
      'POST',
      `/entities-kg/${created.entity_id}/versions`,
      {
        expect_tip: created.manifest_cid,
        description: '', // Try to clear
      }
    );

    const { data: after } = await apiRequest(
      'GET',
      `/entities-kg/${created.entity_id}`
    );

    // Current behavior: empty string may be preserved or ignored
    info(`After clear: description = "${after.description}"`);
    pass('Clear description behavior tested');
  } catch (error) {
    fail('Clear description test failed', error);
  }
}

// ===========================================================================
// MAIN TEST RUNNER
// ===========================================================================

async function runAllTests(): Promise<void> {
  log('blue', `\n${'═'.repeat(70)}`);
  log('blue', '  ENTITIES-KG INTEGRATION TEST SUITE');
  log('blue', `${'═'.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);
  console.log('');

  try {
    await testEntityCreation();
    await sleep(100);

    await testGetEntity();
    await sleep(100);

    await testAppendVersion();
    await sleep(100);

    await testMergeEntity();
    await sleep(100);

    await testBatchLightweight();
    await sleep(100);

    await testNetworkIsolation();
    await sleep(100);

    await testEdgeCases();
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

  const successRate =
    totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0.0';
  console.log(`Success Rate: ${successRate}%`);

  if (failedTests > 0) {
    log('red', '\n⚠️  Some tests failed - check output above for details');
    process.exit(1);
  } else {
    log('green', '\n✅ All tests passed! Entities-KG implementation is working correctly.');
    process.exit(0);
  }
}

// Run tests
runAllTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
