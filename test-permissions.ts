#!/usr/bin/env npx tsx
/**
 * Test script for IPFS Wrapper permission checking
 *
 * This tests that the permission check on POST /entities/:pi/versions works correctly.
 *
 * Prerequisites:
 * - Collections worker deployed with /pi/:pi/permissions endpoint
 * - IPFS wrapper deployed with COLLECTIONS_WORKER service binding
 * - Auth tokens from arke-sdk/test/.env
 *
 * Usage:
 *   npx tsx test-permissions.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from arke-sdk/test
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../arke-sdk/test/.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  }
}

const GATEWAY_URL = process.env.ARKE_GATEWAY_URL || 'https://gateway.arke.institute';
const AUTH_TOKEN_1 = process.env.ARKE_AUTH_TOKEN;
const AUTH_TOKEN_2 = process.env.ARKE_AUTH_TOKEN_2;

// Known test PIs - update these based on your test data
// This PI is the root of "Permission Test Collection" owned by Token 1's user
// Only the owner (Token 1) should be able to edit it, Token 2 should be denied
const TEST_PI = '01K9CRZD8NTJP2KV14X12RCGPT';
const COLLECTION_ID = 'dda7c079-d3b8-4464-8d8d-28ed51f7e12f';

async function main() {
  console.log('=== IPFS Wrapper Permission Check Test ===\n');
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Token 1: ${AUTH_TOKEN_1 ? AUTH_TOKEN_1.slice(0, 20) + '...' : 'NOT SET'}`);
  console.log(`Token 2: ${AUTH_TOKEN_2 ? AUTH_TOKEN_2.slice(0, 20) + '...' : 'NOT SET'}\n`);

  if (!AUTH_TOKEN_1) {
    console.error('ERROR: ARKE_AUTH_TOKEN not set. Check arke-sdk/test/.env');
    process.exit(1);
  }

  // Test 1: Check permissions endpoint works for Token 1 (owner)
  console.log('1. Checking PI permissions for Token 1 (should be owner)...');
  try {
    const permsResp = await fetch(`${GATEWAY_URL}/pi/${TEST_PI}/permissions`, {
      headers: AUTH_TOKEN_1 ? { Authorization: `Bearer ${AUTH_TOKEN_1}` } : {},
    });
    const perms = await permsResp.json();
    console.log(`   Status: ${permsResp.status}`);
    console.log(`   canEdit: ${perms.canEdit}`);
    console.log(`   canAdminister: ${perms.canAdminister}`);
    console.log(`   collection: ${perms.collection ? perms.collection.title : 'none'}`);
    console.log(`   role: ${perms.collection?.role || 'none'}`);
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  // Test 1b: Check permissions for Token 2 (non-member)
  if (AUTH_TOKEN_2) {
    console.log('\n1b. Checking PI permissions for Token 2 (should be non-member)...');
    try {
      const permsResp = await fetch(`${GATEWAY_URL}/pi/${TEST_PI}/permissions`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN_2}` },
      });
      const perms = await permsResp.json();
      console.log(`   Status: ${permsResp.status}`);
      console.log(`   canEdit: ${perms.canEdit}`);
      console.log(`   canAdminister: ${perms.canAdminister}`);
      console.log(`   collection: ${perms.collection ? perms.collection.title : 'none'}`);
      console.log(`   role: ${perms.collection?.role || 'none'}`);
    } catch (e: any) {
      console.log(`   ERROR: ${e.message}`);
    }
  }

  // Test 2: Get entity to get current tip (for CAS)
  console.log('\n2. Getting entity to retrieve current tip...');
  let currentTip: string | null = null;
  try {
    const entityResp = await fetch(`${GATEWAY_URL}/api/entities/${TEST_PI}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN_1}` },
    });
    if (entityResp.ok) {
      const entity = await entityResp.json();
      currentTip = entity.manifest_cid;
      console.log(`   ✓ Entity version: ${entity.ver}`);
      console.log(`   ✓ Current tip: ${currentTip}`);
    } else {
      console.log(`   ✗ Entity not found: ${entityResp.status}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  if (!currentTip) {
    console.log('\n Cannot proceed without entity tip. Exiting.');
    return;
  }

  // Test 3: Try to edit with authorized user
  console.log('\n3. Testing edit with authorized user (Token 1)...');
  try {
    const editResp = await fetch(`${GATEWAY_URL}/api/entities/${TEST_PI}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN_1}`,
      },
      body: JSON.stringify({
        expect_tip: currentTip,
        note: 'Permission test - authorized user',
      }),
    });
    const result = await editResp.json();
    if (editResp.ok) {
      console.log(`   ✓ Edit succeeded: v${result.ver}`);
      currentTip = result.manifest_cid; // Update for next test
    } else if (editResp.status === 403) {
      console.log(`   ✗ 403 Forbidden: ${result.message}`);
      console.log(`   (This might be expected if user doesn't have access)`);
    } else {
      console.log(`   ✗ Unexpected status ${editResp.status}: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  // Test 4: Try to edit with unauthorized user (Token 2)
  if (AUTH_TOKEN_2) {
    console.log('\n4. Testing edit with different user (Token 2)...');
    try {
      const editResp = await fetch(`${GATEWAY_URL}/api/entities/${TEST_PI}/versions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN_2}`,
        },
        body: JSON.stringify({
          expect_tip: currentTip,
          note: 'Permission test - different user',
        }),
      });
      const result = await editResp.json();
      if (editResp.status === 403) {
        console.log(`   ✓ Correctly denied: ${result.message}`);
      } else if (editResp.ok) {
        console.log(`   ✗ Edit unexpectedly succeeded (user might have access)`);
        console.log(`   Result: v${result.ver}`);
      } else {
        console.log(`   ? Status ${editResp.status}: ${JSON.stringify(result)}`);
      }
    } catch (e: any) {
      console.log(`   ERROR: ${e.message}`);
    }
  } else {
    console.log('\n4. Skipping unauthorized user test (no ARKE_AUTH_TOKEN_2)');
  }

  // Test 5: Try to edit without auth
  console.log('\n5. Testing edit without authentication...');
  try {
    const editResp = await fetch(`${GATEWAY_URL}/api/entities/${TEST_PI}/versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expect_tip: currentTip,
        note: 'Permission test - no auth',
      }),
    });
    const result = await editResp.json();
    if (editResp.status === 401) {
      console.log(`   ✓ Correctly rejected unauthenticated request: ${result.message || result.error}`);
    } else if (editResp.status === 403) {
      console.log(`   ✓ Denied at permission check (entity not in collection, but no user ID): ${result.message}`);
    } else {
      console.log(`   ? Status ${editResp.status}: ${JSON.stringify(result)}`);
    }
  } catch (e: any) {
    console.log(`   ERROR: ${e.message}`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
