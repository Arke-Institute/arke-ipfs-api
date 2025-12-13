#!/usr/bin/env tsx
/**
 * Merge Components Transfer Test
 *
 * Tests that when entity A is merged into entity B, ALL of A's components
 * are properly transferred/merged to B.
 *
 * Component merge rules:
 * 1. Properties: Union with target precedence (A.prop + B.prop, B wins on conflicts)
 * 2. Relationships: Concatenate arrays (A's rels + B's rels)
 * 3. File components (description.md, pinax.json, etc.): Union with target precedence
 *    - If A has file X and B doesn't -> B gets file X
 *    - If A has file X and B has file X -> B keeps its version
 *    - If A has file Y and B has file Z -> B gets both Y and Z
 *
 * Run: npx tsx tests/entities-kg/merge-components-test.ts
 */

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

// Test statistics
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(color: keyof typeof COLORS, message: string) {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function pass(message: string) {
  log('green', `  PASS: ${message}`);
  passedTests++;
  totalTests++;
}

function fail(message: string, error?: any) {
  log('red', `  FAIL: ${message}`);
  if (error) {
    console.error('    ', error);
  }
  failedTests++;
  totalTests++;
}

function info(message: string) {
  log('cyan', `  INFO: ${message}`);
}

function warn(message: string) {
  log('yellow', `  WARN: ${message}`);
}

function section(title: string) {
  console.log('');
  log('magenta', `${'='.repeat(70)}`);
  log('magenta', `  ${title}`);
  log('magenta', `${'='.repeat(70)}`);
}

function subsection(title: string) {
  console.log('');
  log('blue', `  -- ${title} --`);
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
  const blob = new Blob(['test source data for component merge'], { type: 'text/plain' });
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
      note: 'Test source PI for merge component tests',
    }),
  });

  const data = await response.json();
  return { pi: data.pi, tip: data.tip };
}

/**
 * Upload content and return CID
 */
async function uploadContent(content: string, filename: string): Promise<string> {
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

interface EntityResult {
  entity_id: string;
  manifest_cid: string;
  ver: number;
}

async function createEntity(
  sourcePI: string,
  type: string,
  label: string,
  options?: {
    properties?: Record<string, any>;
    relationships?: Array<{
      predicate: string;
      target_type: 'entity' | 'pi';
      target_id: string;
      target_label: string;
    }>;
    // Arbitrary file components (e.g., 'description.md': cid, 'pinax.json': cid)
    components?: Record<string, string>;
  }
): Promise<EntityResult> {
  const { status, data } = await apiRequest('POST', '/entities-kg', {
    created_by_pi: sourcePI,
    type,
    label,
    description: `Test entity: ${label}`,
    properties: options?.properties,
    relationships: options?.relationships,
    components: options?.components,  // Arbitrary file components
  });

  if (status !== 201) {
    throw new Error(`Failed to create entity: ${JSON.stringify(data)}`);
  }

  return {
    entity_id: data.entity_id,
    manifest_cid: data.manifest_cid,
    ver: data.ver,
  };
}

async function getEntity(entityId: string): Promise<any> {
  const { status, data } = await apiRequest('GET', `/entities-kg/${entityId}`);
  return data;
}

async function fetchComponent<T>(cid: string): Promise<T> {
  // Use ?format=dag-json for IPLD dag-json content
  const response = await fetch(`https://ipfs.arke.institute/ipfs/${cid}?format=dag-json`, {
    method: 'GET',
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch component: ${response.status} - ${text}`);
  }
  return response.json();
}

async function fetchTextContent(cid: string): Promise<string> {
  const response = await fetch(`https://ipfs.arke.institute/ipfs/${cid}`, {
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch content: ${response.status}`);
  }
  return response.text();
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
// TESTS - Properties
// ===========================================================================

/**
 * Test 1: Properties merge - source has properties, target doesn't
 */
async function testPropertiesMergeSourceOnly(): Promise<void> {
  section('Test 1: Properties Merge - Source Has, Target Empty');

  const sourcePI = await createSourcePI();
  info(`Created source PI: ${sourcePI.pi}`);

  // Create entity A WITH properties
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    properties: {
      birth_year: 1879,
      nationality: 'German',
      occupation: 'Physicist',
    },
  });
  info(`Created entity A with properties`);

  // Create entity B WITHOUT properties
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B');
  info(`Created entity B (no properties)`);

  // Verify A has properties
  const aData = await getEntity(entityA.entity_id);
  if (aData.components?.properties) {
    const aProps = await fetchComponent<Record<string, any>>(aData.components.properties);
    info(`Entity A properties: ${JSON.stringify(aProps)}`);
    pass('Entity A has properties');
  } else {
    fail('Entity A should have properties');
    return;
  }

  // Merge A into B
  subsection('Merge A into B');
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status === 201) {
    pass('Merge completed');
  } else {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }

  // Check B now has A's properties
  subsection('Verify B has A\'s properties');
  const bAfterMerge = await getEntity(entityB.entity_id);

  if (!bAfterMerge.components?.properties) {
    fail('Entity B should have properties after merge');
    warn('Properties were NOT transferred during merge!');
    return;
  }

  const bProps = await fetchComponent<Record<string, any>>(bAfterMerge.components.properties);
  info(`Entity B properties after merge: ${JSON.stringify(bProps)}`);

  if (bProps.birth_year === 1879) {
    pass('B has birth_year from A');
  } else {
    fail(`B should have birth_year=1879, got ${bProps.birth_year}`);
  }

  if (bProps.nationality === 'German') {
    pass('B has nationality from A');
  } else {
    fail(`B should have nationality=German, got ${bProps.nationality}`);
  }
}

/**
 * Test 2: Properties merge - both have properties, target wins on conflicts
 */
async function testPropertiesMergeWithConflict(): Promise<void> {
  section('Test 2: Properties Merge - Both Have Properties (Target Wins)');

  const sourcePI = await createSourcePI();

  // Create entity A with properties
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    properties: {
      birth_year: 1879,        // A-only
      nationality: 'German',   // CONFLICT - A's value
      field: 'Physics',        // A-only
    },
  });
  info('Created entity A with properties: birth_year=1879, nationality=German, field=Physics');

  // Create entity B with different properties
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B', {
    properties: {
      nationality: 'American', // CONFLICT - B's value (should win)
      death_year: 1955,        // B-only
      location: 'Princeton',   // B-only
    },
  });
  info('Created entity B with properties: nationality=American, death_year=1955, location=Princeton');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  // Check merged properties
  subsection('Verify merged properties');
  const bAfterMerge = await getEntity(entityB.entity_id);
  const bProps = await fetchComponent<Record<string, any>>(bAfterMerge.components.properties);
  info(`Merged properties: ${JSON.stringify(bProps)}`);

  // A-only properties should be present
  if (bProps.birth_year === 1879) {
    pass('B has birth_year from A (A-only)');
  } else {
    fail(`B should have birth_year=1879 from A, got ${bProps.birth_year}`);
  }

  if (bProps.field === 'Physics') {
    pass('B has field from A (A-only)');
  } else {
    fail(`B should have field=Physics from A, got ${bProps.field}`);
  }

  // B-only properties should be present
  if (bProps.death_year === 1955) {
    pass('B retained death_year (B-only)');
  } else {
    fail(`B should have death_year=1955, got ${bProps.death_year}`);
  }

  if (bProps.location === 'Princeton') {
    pass('B retained location (B-only)');
  } else {
    fail(`B should have location=Princeton, got ${bProps.location}`);
  }

  // CONFLICT: B should win
  if (bProps.nationality === 'American') {
    pass('B retained nationality=American (B wins conflict)');
  } else {
    fail(`B should have nationality=American (B wins), got ${bProps.nationality}`);
  }
}

// ===========================================================================
// TESTS - Relationships
// ===========================================================================

/**
 * Test 3: Relationships merge - source has, target doesn't
 */
async function testRelationshipsMergeSourceOnly(): Promise<void> {
  section('Test 3: Relationships Merge - Source Has, Target Empty');

  const sourcePI = await createSourcePI();

  // Create target entities for relationships
  const entityC = await createEntity(sourcePI.pi, 'person', 'Person C');
  const entityD = await createEntity(sourcePI.pi, 'organization', 'Org D');

  // Create entity A WITH relationships
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    relationships: [
      {
        predicate: 'KNOWS',
        target_type: 'entity',
        target_id: entityC.entity_id,
        target_label: 'Person C',
      },
      {
        predicate: 'WORKS_AT',
        target_type: 'entity',
        target_id: entityD.entity_id,
        target_label: 'Org D',
      },
    ],
  });
  info(`Created entity A with 2 relationships`);

  // Create entity B WITHOUT relationships
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B');
  info(`Created entity B (no relationships)`);

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  // Check B now has A's relationships
  subsection('Verify B has A\'s relationships');
  const bAfterMerge = await getEntity(entityB.entity_id);

  if (!bAfterMerge.components?.relationships) {
    fail('Entity B should have relationships after merge');
    warn('Relationships were NOT transferred during merge!');
    return;
  }

  const bRels = await fetchComponent<any>(bAfterMerge.components.relationships);
  const relCount = bRels.relationships?.length || 0;
  info(`Entity B has ${relCount} relationships after merge`);

  if (relCount >= 2) {
    pass(`B has ${relCount} relationships`);
  } else {
    fail(`B should have 2 relationships, got ${relCount}`);
  }

  const hasKnows = bRels.relationships.some((r: any) => r.predicate === 'KNOWS');
  const hasWorksAt = bRels.relationships.some((r: any) => r.predicate === 'WORKS_AT');

  if (hasKnows) pass('B has KNOWS relationship from A');
  else fail('B should have KNOWS relationship from A');

  if (hasWorksAt) pass('B has WORKS_AT relationship from A');
  else fail('B should have WORKS_AT relationship from A');
}

/**
 * Test 4: Relationships merge - both have relationships
 */
async function testRelationshipsMergeBothHave(): Promise<void> {
  section('Test 4: Relationships Merge - Both Have Relationships');

  const sourcePI = await createSourcePI();

  // Create target entities
  const entityC = await createEntity(sourcePI.pi, 'person', 'Person C');
  const entityD = await createEntity(sourcePI.pi, 'organization', 'Org D');
  const entityE = await createEntity(sourcePI.pi, 'place', 'Place E');

  // Create entity A with 1 relationship
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    relationships: [
      {
        predicate: 'KNOWS',
        target_type: 'entity',
        target_id: entityC.entity_id,
        target_label: 'Person C',
      },
    ],
  });
  info('Created entity A with KNOWS relationship');

  // Create entity B with 2 relationships
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B', {
    relationships: [
      {
        predicate: 'WORKS_AT',
        target_type: 'entity',
        target_id: entityD.entity_id,
        target_label: 'Org D',
      },
      {
        predicate: 'LIVES_IN',
        target_type: 'entity',
        target_id: entityE.entity_id,
        target_label: 'Place E',
      },
    ],
  });
  info('Created entity B with WORKS_AT, LIVES_IN relationships');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  // Check merged relationships
  subsection('Verify merged relationships');
  const bAfterMerge = await getEntity(entityB.entity_id);
  const bRels = await fetchComponent<any>(bAfterMerge.components.relationships);
  const relCount = bRels.relationships?.length || 0;
  info(`Entity B has ${relCount} relationships after merge`);

  // Should have 3 relationships total
  if (relCount >= 3) {
    pass(`B has ${relCount} relationships (expected 3)`);
  } else {
    fail(`B should have 3 relationships, got ${relCount}`);
  }

  const hasKnows = bRels.relationships.some((r: any) => r.predicate === 'KNOWS');
  const hasWorksAt = bRels.relationships.some((r: any) => r.predicate === 'WORKS_AT');
  const hasLivesIn = bRels.relationships.some((r: any) => r.predicate === 'LIVES_IN');

  if (hasKnows && hasWorksAt && hasLivesIn) {
    pass('All relationships present: KNOWS (from A) + WORKS_AT, LIVES_IN (from B)');
  } else {
    fail(`Missing relationships: KNOWS=${hasKnows}, WORKS_AT=${hasWorksAt}, LIVES_IN=${hasLivesIn}`);
  }
}

// ===========================================================================
// TESTS - File Components (description.md, pinax.json, etc.)
// ===========================================================================

/**
 * Test 5: File components merge - source has files, target doesn't
 */
async function testFileComponentsMergeSourceOnly(): Promise<void> {
  section('Test 5: File Components Merge - Source Has, Target Empty');

  const sourcePI = await createSourcePI();

  // Upload files for source entity A
  const descriptionCid = await uploadContent(
    '# Person A\n\nThis is the description of Person A.',
    'description.md'
  );
  const notesCid = await uploadContent(
    'Research notes about Person A:\n- Born in Germany\n- Worked on physics',
    'notes.txt'
  );
  info(`Uploaded description.md (${descriptionCid}) and notes.txt (${notesCid})`);

  // Create entity A WITH file components
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    components: {
      'description.md': descriptionCid,
      'notes.txt': notesCid,
    },
  });
  info(`Created entity A with file components`);

  // Create entity B WITHOUT file components
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B');
  info(`Created entity B (no file components)`);

  // Verify A has file components
  const aData = await getEntity(entityA.entity_id);
  if (aData.components?.['description.md'] && aData.components?.['notes.txt']) {
    pass('Entity A has file components');
  } else {
    fail('Entity A should have file components (description.md, notes.txt)');
    warn('API may not support arbitrary components yet - this is expected before type update');
    return;
  }

  // Merge A into B
  subsection('Merge A into B');
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status === 201) {
    pass('Merge completed');
  } else {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }

  // Check B now has A's file components
  subsection('Verify B has A\'s file components');
  const bAfterMerge = await getEntity(entityB.entity_id);

  if (bAfterMerge.components?.['description.md']) {
    const content = await fetchTextContent(bAfterMerge.components['description.md']);
    if (content.includes('Person A')) {
      pass('B has description.md from A');
    } else {
      fail('B should have description.md content from A');
    }
  } else {
    fail('Entity B should have description.md after merge');
    warn('File components were NOT transferred during merge!');
  }

  if (bAfterMerge.components?.['notes.txt']) {
    pass('B has notes.txt from A');
  } else {
    fail('Entity B should have notes.txt after merge');
  }
}

/**
 * Test 6: File components merge - both have files, target wins on same filename
 */
async function testFileComponentsMergeWithConflict(): Promise<void> {
  section('Test 6: File Components Merge - Both Have Files (Target Wins)');

  const sourcePI = await createSourcePI();

  // Upload files for entity A
  const aDescCid = await uploadContent('# Description from A', 'description.md');
  const aNotesCid = await uploadContent('Notes from A', 'notes.txt');

  // Upload files for entity B (description.md CONFLICTS, summary.txt is B-only)
  const bDescCid = await uploadContent('# Description from B (should win)', 'description.md');
  const bSummaryCid = await uploadContent('Summary from B', 'summary.txt');

  // Create entity A with files
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    components: {
      'description.md': aDescCid,  // CONFLICT
      'notes.txt': aNotesCid,       // A-only
    },
  });
  info('Created entity A with description.md, notes.txt');

  // Create entity B with files
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B', {
    components: {
      'description.md': bDescCid,  // CONFLICT - should win
      'summary.txt': bSummaryCid,  // B-only
    },
  });
  info('Created entity B with description.md, summary.txt');

  // Verify both have their files
  const aData = await getEntity(entityA.entity_id);
  const bData = await getEntity(entityB.entity_id);

  if (!aData.components?.['description.md'] || !bData.components?.['description.md']) {
    fail('Entities should have file components');
    warn('API may not support arbitrary components yet - skipping this test');
    return;
  }
  pass('Both entities created with file components');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  // Check merged file components
  subsection('Verify merged file components');
  const bAfterMerge = await getEntity(entityB.entity_id);

  // A-only file should be present
  if (bAfterMerge.components?.['notes.txt']) {
    const content = await fetchTextContent(bAfterMerge.components['notes.txt']);
    if (content.includes('from A')) {
      pass('B has notes.txt from A (A-only file)');
    } else {
      fail('B should have notes.txt from A');
    }
  } else {
    fail('B should have notes.txt from A');
  }

  // B-only file should be present
  if (bAfterMerge.components?.['summary.txt']) {
    pass('B retained summary.txt (B-only file)');
  } else {
    fail('B should retain summary.txt');
  }

  // CONFLICT: B's description.md should win
  if (bAfterMerge.components?.['description.md']) {
    const content = await fetchTextContent(bAfterMerge.components['description.md']);
    if (content.includes('from B')) {
      pass('B retained its description.md (B wins conflict)');
    } else {
      fail('B should have kept its own description.md');
    }
  } else {
    fail('B should have description.md');
  }
}

// ===========================================================================
// TESTS - Combined (Properties + Relationships + Files)
// ===========================================================================

/**
 * Test 7: Full component merge - all component types
 */
async function testFullComponentMerge(): Promise<void> {
  section('Test 7: Full Component Merge (Properties + Relationships + Files)');

  const sourcePI = await createSourcePI();

  // Create target entities for relationships
  const entityC = await createEntity(sourcePI.pi, 'person', 'Person C');
  const entityD = await createEntity(sourcePI.pi, 'organization', 'Org D');

  // Upload files
  const aDescCid = await uploadContent('# A Description', 'description.md');
  const bBioCid = await uploadContent('Biography of B', 'bio.txt');

  // Create entity A with ALL component types
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A', {
    properties: {
      birth_year: 1879,
      nationality: 'German',  // CONFLICT
    },
    relationships: [
      {
        predicate: 'KNOWS',
        target_type: 'entity',
        target_id: entityC.entity_id,
        target_label: 'Person C',
      },
    ],
    components: {
      'description.md': aDescCid,  // A-only file
    },
  });
  info('Created entity A with properties, relationships, and files');

  // Create entity B with ALL component types
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B', {
    properties: {
      death_year: 1955,
      nationality: 'American',  // CONFLICT - should win
    },
    relationships: [
      {
        predicate: 'WORKS_AT',
        target_type: 'entity',
        target_id: entityD.entity_id,
        target_label: 'Org D',
      },
    ],
    components: {
      'bio.txt': bBioCid,  // B-only file
    },
  });
  info('Created entity B with properties, relationships, and files');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  const bAfterMerge = await getEntity(entityB.entity_id);

  // Verify properties merge
  subsection('Verify merged properties');
  if (bAfterMerge.components?.properties) {
    const props = await fetchComponent<Record<string, any>>(bAfterMerge.components.properties);
    info(`Properties: ${JSON.stringify(props)}`);

    if (props.birth_year === 1879) pass('B has birth_year from A');
    else fail('B should have birth_year from A');

    if (props.death_year === 1955) pass('B retained death_year');
    else fail('B should retain death_year');

    if (props.nationality === 'American') pass('B nationality=American (target wins)');
    else fail('B nationality should be American');
  } else {
    fail('B should have properties');
  }

  // Verify relationships merge
  subsection('Verify merged relationships');
  if (bAfterMerge.components?.relationships) {
    const rels = await fetchComponent<any>(bAfterMerge.components.relationships);
    const relCount = rels.relationships?.length || 0;
    info(`Relationships: ${relCount}`);

    if (relCount >= 2) pass(`B has ${relCount} relationships`);
    else fail('B should have 2 relationships');

    const hasKnows = rels.relationships.some((r: any) => r.predicate === 'KNOWS');
    const hasWorksAt = rels.relationships.some((r: any) => r.predicate === 'WORKS_AT');
    if (hasKnows && hasWorksAt) pass('B has KNOWS + WORKS_AT');
    else fail(`Missing: KNOWS=${hasKnows}, WORKS_AT=${hasWorksAt}`);
  } else {
    fail('B should have relationships');
  }

  // Verify file components merge
  subsection('Verify merged file components');
  if (bAfterMerge.components?.['description.md']) {
    pass('B has description.md from A');
  } else {
    warn('B should have description.md from A (may require type system update)');
  }

  if (bAfterMerge.components?.['bio.txt']) {
    pass('B retained bio.txt');
  } else {
    warn('B should retain bio.txt (may require type system update)');
  }
}

/**
 * Test 8: Merge preserves target when source is empty
 */
async function testMergePreservesTargetComponents(): Promise<void> {
  section('Test 8: Merge Preserves Target Components When Source Empty');

  const sourcePI = await createSourcePI();
  const entityC = await createEntity(sourcePI.pi, 'person', 'Person C');

  // Create entity A WITHOUT any components
  const entityA = await createEntity(sourcePI.pi, 'person', 'Person A');
  info('Created entity A (no components)');

  // Create entity B WITH components
  const entityB = await createEntity(sourcePI.pi, 'person', 'Person B', {
    properties: {
      important: true,
      score: 100,
    },
    relationships: [
      {
        predicate: 'KNOWS',
        target_type: 'entity',
        target_id: entityC.entity_id,
        target_label: 'Person C',
      },
    ],
  });
  info('Created entity B with properties and relationships');

  // Merge A into B
  const mergeResult = await mergeEntity(entityA.entity_id, entityB.entity_id, entityA.manifest_cid);

  if (mergeResult.status !== 201) {
    fail(`Merge failed: ${JSON.stringify(mergeResult.data)}`);
    return;
  }
  pass('Merge completed');

  // Verify B retained its components
  const bAfterMerge = await getEntity(entityB.entity_id);

  if (bAfterMerge.components?.properties) {
    const bProps = await fetchComponent<Record<string, any>>(bAfterMerge.components.properties);
    if (bProps.important === true && bProps.score === 100) {
      pass('B retained its properties');
    } else {
      fail('B should retain its properties');
    }
  } else {
    fail('B should still have properties');
  }

  if (bAfterMerge.components?.relationships) {
    const bRels = await fetchComponent<any>(bAfterMerge.components.relationships);
    if (bRels.relationships?.some((r: any) => r.predicate === 'KNOWS')) {
      pass('B retained its relationships');
    } else {
      fail('B should retain its KNOWS relationship');
    }
  } else {
    fail('B should still have relationships');
  }
}

// ===========================================================================
// MAIN
// ===========================================================================

async function main(): Promise<void> {
  log('blue', `\n${'='.repeat(70)}`);
  log('blue', '  MERGE COMPONENTS TRANSFER TEST');
  log('blue', `${'='.repeat(70)}\n`);

  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}`);

  try {
    // Properties tests
    await testPropertiesMergeSourceOnly();
    await testPropertiesMergeWithConflict();

    // Relationships tests
    await testRelationshipsMergeSourceOnly();
    await testRelationshipsMergeBothHave();

    // File components tests
    await testFileComponentsMergeSourceOnly();
    await testFileComponentsMergeWithConflict();

    // Combined tests
    await testFullComponentMerge();
    await testMergePreservesTargetComponents();
  } catch (e) {
    log('red', `\nFatal error: ${e}`);
  }

  // Summary
  console.log('\n');
  log('magenta', `${'='.repeat(70)}`);
  log('magenta', '  TEST SUMMARY');
  log('magenta', `${'='.repeat(70)}`);

  console.log(`Total Tests:  ${totalTests}`);
  log('green', `Passed:       ${passedTests}`);
  log('red', `Failed:       ${failedTests}`);

  const successRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : '0.0';
  console.log(`Success Rate: ${successRate}%`);

  if (failedTests > 0) {
    log('yellow', '\nSome tests failed.');
    log('yellow', 'Expected failures:');
    log('yellow', '  - Properties not merged (need to implement)');
    log('yellow', '  - Relationships not merged (need to implement)');
    log('yellow', '  - File components not supported (need type system update)');
    process.exit(1);
  } else {
    log('green', '\nAll tests passed!');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
