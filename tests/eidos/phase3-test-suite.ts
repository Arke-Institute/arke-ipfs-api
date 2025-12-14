#!/usr/bin/env tsx
/**
 * EIDOS PHASE 3: PROPERTIES, RELATIONSHIPS & HIERARCHY TEST SUITE
 *
 * Tests the knowledge graph features of the unified Eidos schema:
 * - Properties component (structured metadata)
 * - Relationships component (semantic graph)
 * - Hierarchical tree structure (children_pi, hierarchy_parent)
 *
 * Prerequisites:
 * - IPFS wrapper running locally (npm run dev)
 * - Test network enabled
 *
 * Run: npx tsx tests/eidos/phase3-test-suite.ts
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

async function downloadComponent(cid: string): Promise<any> {
  const response = await fetch(`${API_ENDPOINT}/dag/${cid}`);
  return response.json();
}

// =============================================================================
// TEST 1: Properties Component
// =============================================================================

async function testPropertiesComponent(): Promise<void> {
  section('Test 1: Properties Component');

  try {
    subsection('1a: Create entity with properties');

    const entity = await createEntity({
      type: 'person',
      label: 'John Doe',
      description: 'Software engineer',
      components: {},
      properties: {
        birth_year: 1990,
        email: 'john@example.com',
        occupation: 'Software Engineer',
        skills: ['TypeScript', 'Rust', 'Go'],
      },
    });

    info(`Created entity: ${entity.id}`);

    // Verify entity has properties component
    const retrieved = await getEntity(entity.id);
    if (retrieved.components.properties) {
      pass('Entity has properties component');
    } else {
      fail('Entity missing properties component');
      return;
    }

    // Download and verify properties
    const properties = await downloadComponent(retrieved.components.properties);
    if (
      properties.birth_year === 1990 &&
      properties.email === 'john@example.com' &&
      properties.occupation === 'Software Engineer' &&
      Array.isArray(properties.skills) &&
      properties.skills.length === 3
    ) {
      pass('Properties stored and retrieved correctly');
    } else {
      fail('Properties mismatch', { expected: 'original properties', got: properties });
    }

    subsection('1b: Update properties via append version');

    const updated = await appendVersion(entity.id, {
      expect_tip: retrieved.manifest_cid,
      properties: {
        birth_year: 1990,
        email: 'john.doe@newcompany.com', // Updated
        occupation: 'Senior Software Engineer', // Updated
        skills: ['TypeScript', 'Rust', 'Go', 'Python'], // Added skill
        location: 'San Francisco', // New field
      },
    });

    const retrieved2 = await getEntity(entity.id);
    const properties2 = await downloadComponent(retrieved2.components.properties);

    if (
      properties2.email === 'john.doe@newcompany.com' &&
      properties2.occupation === 'Senior Software Engineer' &&
      properties2.skills.length === 4 &&
      properties2.location === 'San Francisco'
    ) {
      pass('Properties updated correctly via append version');
    } else {
      fail('Properties update failed', properties2);
    }

    subsection('1c: Properties with empty object');

    const emptyProps = await createEntity({
      type: 'person',
      label: 'Jane Doe',
      components: {},
      properties: {},
    });

    const retrieved3 = await getEntity(emptyProps.id);
    if (retrieved3.components.properties) {
      const props3 = await downloadComponent(retrieved3.components.properties);
      if (Object.keys(props3).length === 0) {
        pass('Empty properties object handled correctly');
      } else {
        fail('Empty properties has unexpected data', props3);
      }
    } else {
      pass('Empty properties component not created (optimization)');
    }

  } catch (error) {
    fail('Properties component test failed', error);
  }
}

// =============================================================================
// TEST 2: Relationships Component
// =============================================================================

async function testRelationshipsComponent(): Promise<void> {
  section('Test 2: Relationships Component');

  try {
    subsection('2a: Create entities with relationships');

    // Create target entities first
    const alice = await createEntity({
      type: 'person',
      label: 'Alice',
      components: {},
    });

    const bob = await createEntity({
      type: 'person',
      label: 'Bob',
      components: {},
    });

    const acmeCorp = await createEntity({
      type: 'organization',
      label: 'ACME Corp',
      components: {},
    });

    // Create entity with relationships
    const charlie = await createEntity({
      type: 'person',
      label: 'Charlie',
      components: {},
      relationships: [
        {
          predicate: 'knows',
          target_type: 'entity',
          target_id: alice.id,
          target_label: 'Alice',
          target_entity_type: 'person',
        },
        {
          predicate: 'colleague_of',
          target_type: 'entity',
          target_id: bob.id,
          target_label: 'Bob',
          target_entity_type: 'person',
          properties: { since: 2020 },
        },
        {
          predicate: 'works_at',
          target_type: 'entity',
          target_id: acmeCorp.id,
          target_label: 'ACME Corp',
          target_entity_type: 'organization',
          properties: { role: 'Engineer', department: 'R&D' },
        },
      ],
    });

    info(`Created Charlie: ${charlie.id}`);

    // Verify relationships component
    const retrieved = await getEntity(charlie.id);
    if (retrieved.components.relationships) {
      pass('Entity has relationships component');
    } else {
      fail('Entity missing relationships component');
      return;
    }

    // Download and verify relationships (relationships are wrapped in schema)
    const relationshipsComponent = await downloadComponent(retrieved.components.relationships);
    const relationships = relationshipsComponent.relationships;
    if (
      relationshipsComponent.schema === 'arke/relationships@v1' &&
      Array.isArray(relationships) &&
      relationships.length === 3 &&
      relationships[0].predicate === 'knows' &&
      relationships[0].target_id === alice.id &&
      relationships[1].predicate === 'colleague_of' &&
      relationships[1].properties?.since === 2020 &&
      relationships[2].predicate === 'works_at' &&
      relationships[2].properties?.role === 'Engineer'
    ) {
      pass('Relationships stored and retrieved correctly');
    } else {
      fail('Relationships mismatch', relationshipsComponent);
    }

    subsection('2b: Update relationships via append version');

    // Add new relationship, keep existing ones
    const updated = await appendVersion(charlie.id, {
      expect_tip: retrieved.manifest_cid,
      relationships: [
        ...relationships,
        {
          predicate: 'friends_with',
          target_type: 'entity',
          target_id: alice.id,
          target_label: 'Alice',
          target_entity_type: 'person',
        },
      ],
    });

    const retrieved2 = await getEntity(charlie.id);
    const relationshipsComponent2 = await downloadComponent(retrieved2.components.relationships);
    const relationships2 = relationshipsComponent2.relationships;

    if (Array.isArray(relationships2) && relationships2.length === 4) {
      pass('Relationships updated correctly (4 relationships total)');
    } else {
      fail('Relationships update failed', { expected: 4, got: relationships2?.length });
    }

    subsection('2c: Relationships with empty array');

    const noRels = await createEntity({
      type: 'person',
      label: 'David',
      components: {},
      relationships: [],
    });

    const retrieved3 = await getEntity(noRels.id);
    if (retrieved3.components.relationships) {
      const relsComponent3 = await downloadComponent(retrieved3.components.relationships);
      if (Array.isArray(relsComponent3.relationships) && relsComponent3.relationships.length === 0) {
        pass('Empty relationships array handled correctly');
      } else {
        fail('Empty relationships has unexpected data', relsComponent3);
      }
    } else {
      pass('Empty relationships component not created (optimization)');
    }

  } catch (error) {
    fail('Relationships component test failed', error);
  }
}

// =============================================================================
// TEST 3: Hierarchical Tree Structure
// =============================================================================

async function testHierarchicalStructure(): Promise<void> {
  section('Test 3: Hierarchical Tree Structure');

  try {
    subsection('3a: Create entity with hierarchy_parent (auto-update parent)');

    // Create parent
    const parent = await createEntity({
      type: 'PI',
      label: 'Parent Document',
      components: {},
    });

    info(`Created parent: ${parent.id}`);

    // Create child with hierarchy_parent (should auto-update parent's children_pi)
    const child1 = await createEntity({
      type: 'PI',
      label: 'Child Document 1',
      components: {},
      hierarchy_parent: parent.id,
    });

    info(`Created child1: ${child1.id}`);

    // Verify child has hierarchy_parent set
    const retrievedChild1 = await getEntity(child1.id);
    if (retrievedChild1.hierarchy_parent === parent.id) {
      pass('Child has hierarchy_parent set correctly');
    } else {
      fail('Child hierarchy_parent mismatch', { expected: parent.id, got: retrievedChild1.hierarchy_parent });
    }

    // Verify parent was auto-updated with child
    const retrievedParent = await getEntity(parent.id);
    if (
      Array.isArray(retrievedParent.children_pi) &&
      retrievedParent.children_pi.includes(child1.id) &&
      retrievedParent.ver === 2 // Version should increment
    ) {
      pass('Parent auto-updated with child in children_pi array (v2)');
    } else {
      fail('Parent auto-update failed', { ver: retrievedParent.ver, children_pi: retrievedParent.children_pi });
    }

    subsection('3b: Add multiple children via hierarchy_parent');

    const child2 = await createEntity({
      type: 'PI',
      label: 'Child Document 2',
      components: {},
      hierarchy_parent: parent.id,
    });

    const child3 = await createEntity({
      type: 'PI',
      label: 'Child Document 3',
      components: {},
      hierarchy_parent: parent.id,
    });

    info(`Created child2: ${child2.id}`);
    info(`Created child3: ${child3.id}`);

    // Verify parent has all 3 children
    const retrievedParent2 = await getEntity(parent.id);
    if (
      Array.isArray(retrievedParent2.children_pi) &&
      retrievedParent2.children_pi.length === 3 &&
      retrievedParent2.children_pi.includes(child1.id) &&
      retrievedParent2.children_pi.includes(child2.id) &&
      retrievedParent2.children_pi.includes(child3.id) &&
      retrievedParent2.ver === 4 // v2 + child2 + child3
    ) {
      pass('Parent has all 3 children (bidirectional hierarchy)');
    } else {
      fail('Parent children_pi mismatch', {
        expected: 3,
        got: retrievedParent2.children_pi?.length,
        ver: retrievedParent2.ver,
      });
    }

    subsection('3c: Update children_pi via append version');

    // Create a new entity to add as child
    const child4 = await createEntity({
      type: 'PI',
      label: 'Child Document 4',
      components: {},
    });

    // Update parent to add child4
    const updatedParent = await appendVersion(parent.id, {
      expect_tip: retrievedParent2.manifest_cid,
      children_pi_add: [child4.id],
    });

    const retrievedParent3 = await getEntity(parent.id);
    if (
      Array.isArray(retrievedParent3.children_pi) &&
      retrievedParent3.children_pi.length === 4 &&
      retrievedParent3.children_pi.includes(child4.id)
    ) {
      pass('Children added via children_pi_add in append version');
    } else {
      fail('children_pi_add failed', retrievedParent3.children_pi);
    }

    subsection('3d: Remove children via children_pi_remove');

    const updatedParent2 = await appendVersion(parent.id, {
      expect_tip: retrievedParent3.manifest_cid,
      children_pi_remove: [child2.id],
    });

    const retrievedParent4 = await getEntity(parent.id);
    if (
      Array.isArray(retrievedParent4.children_pi) &&
      retrievedParent4.children_pi.length === 3 &&
      !retrievedParent4.children_pi.includes(child2.id)
    ) {
      pass('Children removed via children_pi_remove');
    } else {
      fail('children_pi_remove failed', retrievedParent4.children_pi);
    }

  } catch (error) {
    fail('Hierarchical structure test failed', error);
  }
}

// =============================================================================
// TEST 4: Combined Features
// =============================================================================

async function testCombinedFeatures(): Promise<void> {
  section('Test 4: Combined Features (Properties + Relationships + Hierarchy)');

  try {
    subsection('4a: Create knowledge graph entity with all features');

    // Create related entities
    const project = await createEntity({
      type: 'project',
      label: 'Project Alpha',
      components: {},
      properties: {
        status: 'active',
        budget: 100000,
      },
    });

    const team = await createEntity({
      type: 'organization',
      label: 'Engineering Team',
      components: {},
    });

    // Create main entity with properties, relationships, and hierarchy
    const taskParent = await createEntity({
      type: 'task',
      label: 'Development Sprint',
      components: {},
      properties: {
        sprint_number: 5,
        start_date: '2025-01-01',
        end_date: '2025-01-15',
      },
      relationships: [
        {
          predicate: 'part_of',
          target_type: 'entity',
          target_id: project.id,
          target_label: 'Project Alpha',
          target_entity_type: 'project',
        },
        {
          predicate: 'assigned_to',
          target_type: 'entity',
          target_id: team.id,
          target_label: 'Engineering Team',
          target_entity_type: 'organization',
        },
      ],
    });

    // Create child task
    const subtask = await createEntity({
      type: 'task',
      label: 'Implement Feature X',
      components: {},
      hierarchy_parent: taskParent.id,
      properties: {
        priority: 'high',
        estimate_hours: 8,
      },
    });

    info(`Created task parent: ${taskParent.id}`);
    info(`Created subtask: ${subtask.id}`);

    // Verify all components
    const retrievedParent = await getEntity(taskParent.id);
    const retrievedSubtask = await getEntity(subtask.id);

    // Check parent has all features
    if (
      retrievedParent.components.properties &&
      retrievedParent.components.relationships &&
      Array.isArray(retrievedParent.children_pi) &&
      retrievedParent.children_pi.includes(subtask.id)
    ) {
      pass('Parent entity has properties, relationships, and children');
    } else {
      fail('Parent missing some components', retrievedParent);
    }

    // Check subtask has all features
    if (
      retrievedSubtask.components.properties &&
      retrievedSubtask.hierarchy_parent === taskParent.id
    ) {
      pass('Subtask has properties and hierarchy_parent');
    } else {
      fail('Subtask missing some features', retrievedSubtask);
    }

    // Verify content
    const parentProps = await downloadComponent(retrievedParent.components.properties);
    const parentRelsComponent = await downloadComponent(retrievedParent.components.relationships);
    const subtaskProps = await downloadComponent(retrievedSubtask.components.properties);

    if (
      parentProps.sprint_number === 5 &&
      Array.isArray(parentRelsComponent.relationships) &&
      parentRelsComponent.relationships.length === 2 &&
      subtaskProps.priority === 'high'
    ) {
      pass('All component data retrieved correctly');
    } else {
      fail('Component data mismatch');
    }

  } catch (error) {
    fail('Combined features test failed', error);
  }
}

// =============================================================================
// TEST 5: Properties/Relationships Merge Behavior
// =============================================================================

async function testMergeBehavior(): Promise<void> {
  section('Test 5: Properties & Relationships Merge Behavior');

  try {
    subsection('5a: Properties merge (union)');

    const source = await createEntity({
      type: 'person',
      label: 'Source Person',
      components: {},
      properties: {
        name: 'John',
        age: 30,
        city: 'NYC',
      },
    });

    const target = await createEntity({
      type: 'person',
      label: 'Target Person',
      components: {},
      properties: {
        name: 'Jane',
        occupation: 'Engineer',
        city: 'SF',
      },
    });

    info(`Created source: ${source.id}`);
    info(`Created target: ${target.id}`);

    // Merge
    await apiRequest('POST', `/entities/${source.id}/merge`, {
      target_id: target.id,
      expect_target_tip: target.tip,
    });

    // Check merged properties (union, target wins on conflicts)
    const merged = await getEntity(target.id);
    const mergedProps = await downloadComponent(merged.components.properties);

    if (
      mergedProps.name === 'Jane' && // target wins
      mergedProps.age === 30 && // from source
      mergedProps.city === 'SF' && // target wins
      mergedProps.occupation === 'Engineer' // from target
    ) {
      pass('Properties merged correctly (union, target wins on conflicts)');
    } else {
      fail('Properties merge incorrect', mergedProps);
    }

    subsection('5b: Relationships merge (concatenate)');

    const person1 = await createEntity({
      type: 'person',
      label: 'Person 1',
      components: {},
    });

    const person2 = await createEntity({
      type: 'person',
      label: 'Person 2',
      components: {},
    });

    const source2 = await createEntity({
      type: 'person',
      label: 'Source',
      components: {},
      relationships: [
        {
          predicate: 'knows',
          target_type: 'entity',
          target_id: person1.id,
          target_label: 'Person 1',
          target_entity_type: 'person',
        },
      ],
    });

    const target2 = await createEntity({
      type: 'person',
      label: 'Target',
      components: {},
      relationships: [
        {
          predicate: 'knows',
          target_type: 'entity',
          target_id: person2.id,
          target_label: 'Person 2',
          target_entity_type: 'person',
        },
      ],
    });

    // Merge
    await apiRequest('POST', `/entities/${source2.id}/merge`, {
      target_id: target2.id,
      expect_target_tip: target2.tip,
    });

    // Check merged relationships (concatenate)
    const merged2 = await getEntity(target2.id);
    const mergedRelsComponent = await downloadComponent(merged2.components.relationships);
    const mergedRels = mergedRelsComponent.relationships;

    if (Array.isArray(mergedRels) && mergedRels.length === 2) {
      pass('Relationships merged correctly (concatenated)');
    } else {
      fail('Relationships merge incorrect', { expected: 2, got: mergedRels?.length });
    }

  } catch (error) {
    fail('Merge behavior test failed', error);
  }
}

// =============================================================================
// Main Test Runner
// =============================================================================

async function runAllTests(): Promise<void> {
  log('blue', '\n' + '═'.repeat(70));
  log('blue', '  EIDOS PHASE 3: PROPERTIES, RELATIONSHIPS & HIERARCHY');
  log('blue', '═'.repeat(70) + '\n');
  info(`Target API: ${API_ENDPOINT}`);
  info(`Network: ${NETWORK}\n`);

  await testPropertiesComponent();
  await testRelationshipsComponent();
  await testHierarchicalStructure();
  await testCombinedFeatures();
  await testMergeBehavior();

  // Summary
  log('magenta', '\n' + '═'.repeat(70));
  log('magenta', '  TEST SUMMARY');
  log('magenta', '═'.repeat(70));
  console.log(`Total Tests:  ${totalTests}`);
  log('green', `Passed:       ${passedTests} ✅`);
  log('red', `Failed:       ${failedTests} ❌`);
  console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

  if (failedTests === 0) {
    log('green', '\n✅ All tests passed! Properties, Relationships & Hierarchy working correctly.');
  } else {
    log('red', `\n❌ ${failedTests} test(s) failed. Please review the errors above.`);
    process.exit(1);
  }
}

// Run tests
runAllTests().catch((error) => {
  log('red', '\n❌ Fatal error running tests:');
  console.error(error);
  process.exit(1);
});
