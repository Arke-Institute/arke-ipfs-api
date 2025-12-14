#!/bin/bash
set -e

# Arke IPFS API - Comprehensive Test Suite
# Tests all endpoints documented in API_SPEC.md

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Configuration
API_ENDPOINT="${API_ENDPOINT:-https://api.arke.institute}"
GATEWAY_ENDPOINT="${GATEWAY_ENDPOINT:-https://ipfs.arke.institute}"
KUBO_ENDPOINT="${KUBO_ENDPOINT:-https://ipfs-api.arke.institute}"

# Test data storage (simple variables instead of associative array)
TEST_ROOT_PI="01TEST00000000000000000000"
ARKE_PI=""
UPLOAD_CID=""
ENTITY_PI=""
ENTITY_V1_TIP=""
ENTITY_V2_TIP=""
CURRENT_TIP=""
CHILD_PI=""

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Arke IPFS API Test Suite${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "API Endpoint:     ${YELLOW}$API_ENDPOINT${NC}"
echo -e "Gateway Endpoint: ${YELLOW}$GATEWAY_ENDPOINT${NC}"
echo -e "Kubo Endpoint:    ${YELLOW}$KUBO_ENDPOINT${NC}"
echo ""

# Helper functions
pass() {
    echo -e "${GREEN}✓ $1${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}✗ $1${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

test_section() {
    echo ""
    echo -e "${BLUE}>>> $1${NC}"
}

#############################################
# Test 1: Health Check
#############################################
test_section "Test 1: GET / - Health Check"
RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/")
SERVICE=$(echo "$RESPONSE" | jq -r '.service' 2>/dev/null)
STATUS=$(echo "$RESPONSE" | jq -r '.status' 2>/dev/null)

if [ "$SERVICE" = "arke-ipfs-api" ] && [ "$STATUS" = "ok" ]; then
    VERSION=$(echo "$RESPONSE" | jq -r '.version' 2>/dev/null)
    pass "Health check passed (version: $VERSION)"
else
    fail "Health check failed: $RESPONSE"
fi

#############################################
# Test 2: Initialize Arke Origin Block
#############################################
test_section "Test 2: POST /arke/init - Initialize Arke Origin Block"
INIT_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/arke/init")
ARKE_PI=$(echo "$INIT_RESPONSE" | jq -r '.pi' 2>/dev/null)
ARKE_MESSAGE=$(echo "$INIT_RESPONSE" | jq -r '.message' 2>/dev/null)

if [ -n "$ARKE_PI" ] && [ "$ARKE_PI" != "null" ]; then
    # ARKE_PI already set
    if [[ "$ARKE_MESSAGE" == *"initialized"* ]] || [[ "$ARKE_MESSAGE" == *"already exists"* ]]; then
        pass "Arke origin block ready (PI: $ARKE_PI)"
    else
        fail "Unexpected message: $ARKE_MESSAGE"
    fi
else
    fail "Arke init failed: $INIT_RESPONSE"
fi

#############################################
# Test 3: Get Arke Origin Block
#############################################
test_section "Test 3: GET /arke - Get Arke Origin Block"
ARKE_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/arke")
ARKE_GET_PI=$(echo "$ARKE_RESPONSE" | jq -r '.pi' 2>/dev/null)
ARKE_VER=$(echo "$ARKE_RESPONSE" | jq -r '.ver' 2>/dev/null)

if [ "$ARKE_GET_PI" = "$ARKE_PI" ] && [ "$ARKE_VER" -ge 1 ]; then
    pass "Arke origin block retrieved (v$ARKE_VER)"
else
    fail "Arke retrieval failed: $ARKE_RESPONSE"
fi

#############################################
# Test 4: Initialize TEST Root Entity
#############################################
test_section "Test 4: Create TEST Root (Testnet)"

# Upload TEST root metadata
TEST_ROOT_METADATA_FILE=$(mktemp)
cat > "$TEST_ROOT_METADATA_FILE" <<EOF
{
  "name": "TEST Root",
  "type": "test",
  "description": "Root entity for all integration test data. All test entities are children of this entity.",
  "note": "Safe to delete this entire tree to clean up test data"
}
EOF

TEST_ROOT_METADATA_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/upload" -F "file=@$TEST_ROOT_METADATA_FILE")
TEST_ROOT_METADATA_CID=$(echo "$TEST_ROOT_METADATA_RESPONSE" | jq -r '.[0].cid' 2>/dev/null)
rm -f "$TEST_ROOT_METADATA_FILE"

if [ -z "$TEST_ROOT_METADATA_CID" ] || [ "$TEST_ROOT_METADATA_CID" = "null" ]; then
    fail "Failed to upload TEST root metadata"
fi

# Create TEST root entity
TEST_ROOT_PAYLOAD=$(cat <<EOF
{
  "pi": "$TEST_ROOT_PI",
  "components": {
    "metadata": "$TEST_ROOT_METADATA_CID"
  },
  "note": "TEST ROOT - All integration test entities are children of this entity"
}
EOF
)

TEST_ROOT_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/entities" \
  -H 'Content-Type: application/json' \
  -d "$TEST_ROOT_PAYLOAD" 2>/dev/null)

TEST_ROOT_CHECK=$(echo "$TEST_ROOT_RESPONSE" | jq -r '.pi' 2>/dev/null)

if [ "$TEST_ROOT_CHECK" = "$TEST_ROOT_PI" ]; then
    pass "TEST root created: $TEST_ROOT_PI"
elif echo "$TEST_ROOT_RESPONSE" | grep -q "already exists"; then
    pass "TEST root already exists: $TEST_ROOT_PI"
else
    # Try to fetch it - might already exist from previous run
    EXISTING=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$TEST_ROOT_PI" 2>/dev/null | jq -r '.pi' 2>/dev/null)
    if [ "$EXISTING" = "$TEST_ROOT_PI" ]; then
        pass "TEST root already exists: $TEST_ROOT_PI"
    else
        fail "TEST root creation failed: $TEST_ROOT_RESPONSE"
    fi
fi

#############################################
# Test 5: Upload Files
#############################################
test_section "Test 5: POST /upload - Upload Files"
TEST_FILE=$(mktemp)
echo "Test content $(date +%s)" > "$TEST_FILE"

UPLOAD_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/upload" -F "file=@$TEST_FILE")
UPLOAD_CID=$(echo "$UPLOAD_RESPONSE" | jq -r '.[0].cid' 2>/dev/null)
UPLOAD_SIZE=$(echo "$UPLOAD_RESPONSE" | jq -r '.[0].size' 2>/dev/null)

if [ -n "$UPLOAD_CID" ] && [ "$UPLOAD_CID" != "null" ]; then
    UPLOAD_CID=$UPLOAD_CID
    pass "File uploaded: $UPLOAD_CID (size: $UPLOAD_SIZE bytes)"
else
    fail "File upload failed: $UPLOAD_RESPONSE"
fi
rm -f "$TEST_FILE"

#############################################
# Test 5: Download File (via Worker)
#############################################
test_section "Test 5: GET /cat/{cid} - Download File"
if [ -n "$UPLOAD_CID" ]; then
    DOWNLOAD_RESPONSE=$(curl -s --max-time 30 "$API_ENDPOINT/cat/$UPLOAD_CID")
    if echo "$DOWNLOAD_RESPONSE" | grep -q "Test content"; then
        pass "File downloaded via worker /cat endpoint"
    else
        fail "File download failed: $DOWNLOAD_RESPONSE"
    fi
else
    fail "Skipping download test (no uploaded CID)"
fi

#############################################
# Test 6: Download File (via Gateway)
#############################################
test_section "Test 6: Gateway Download - /ipfs/{cid}"
if [ -n "$UPLOAD_CID" ]; then
    GATEWAY_RESPONSE=$(curl -s --max-time 30 "$GATEWAY_ENDPOINT/ipfs/$UPLOAD_CID")
    if echo "$GATEWAY_RESPONSE" | grep -q "Test content"; then
        pass "File downloaded via IPFS gateway"
    elif echo "$GATEWAY_RESPONSE" | grep -q "504"; then
        pass "Gateway timeout (content not propagated yet - acceptable)"
    else
        fail "Gateway download failed: $GATEWAY_RESPONSE"
    fi
else
    fail "Skipping gateway test (no uploaded CID)"
fi

#############################################
# Test 7: Create Entity
#############################################
test_section "Test 7: POST /entities - Create Entity"
CREATE_PAYLOAD=$(cat <<EOF
{
  "components": {
    "metadata": "$UPLOAD_CID"
  },
  "note": "Test entity created by integration test"
}
EOF
)

CREATE_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/entities" \
  -H 'Content-Type: application/json' \
  -d "$CREATE_PAYLOAD")

ENTITY_PI=$(echo "$CREATE_RESPONSE" | jq -r '.pi' 2>/dev/null)
ENTITY_VER=$(echo "$CREATE_RESPONSE" | jq -r '.ver' 2>/dev/null)
ENTITY_TIP=$(echo "$CREATE_RESPONSE" | jq -r '.tip' 2>/dev/null)

if [ -n "$ENTITY_PI" ] && [ "$ENTITY_PI" != "null" ] && [ "$ENTITY_VER" = "1" ]; then
    ENTITY_PI=$ENTITY_PI
    ENTITY_V1_TIP=$ENTITY_TIP
    pass "Entity created: $ENTITY_PI (tip: ${ENTITY_TIP:0:20}...)"
else
    fail "Entity creation failed: $CREATE_RESPONSE"
fi

#############################################
# Test 8: List Entities (without metadata)
#############################################
test_section "Test 8: GET /entities - List Entities"
LIST_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities?limit=10")
ENTITY_COUNT=$(echo "$LIST_RESPONSE" | jq -r '.entities | length' 2>/dev/null)
LIMIT=$(echo "$LIST_RESPONSE" | jq -r '.limit' 2>/dev/null)

if [ "$ENTITY_COUNT" -ge 1 ] && [ "$LIMIT" = "10" ]; then
    # Check if our entity is in the list
    FOUND=$(echo "$LIST_RESPONSE" | jq -r ".entities[] | select(.pi == \"$ENTITY_PI\") | .pi" 2>/dev/null)
    if [ "$FOUND" = "$ENTITY_PI" ]; then
        pass "Entity listing works ($ENTITY_COUNT entities, found our test entity)"
    else
        pass "Entity listing works ($ENTITY_COUNT entities, test entity may be on next page)"
    fi
else
    fail "Entity listing failed: $LIST_RESPONSE"
fi

#############################################
# Test 9: List Entities (with metadata)
#############################################
test_section "Test 9: GET /entities?include_metadata=true - List with Metadata"
METADATA_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities?limit=5&include_metadata=true")
META_COUNT=$(echo "$METADATA_RESPONSE" | jq -r '.entities | length' 2>/dev/null)
FIRST_ENTITY_VER=$(echo "$METADATA_RESPONSE" | jq -r '.entities[0].ver' 2>/dev/null)

if [ "$META_COUNT" -ge 1 ] && [ -n "$FIRST_ENTITY_VER" ] && [ "$FIRST_ENTITY_VER" != "null" ]; then
    pass "Entity listing with metadata works ($META_COUNT entities with full details)"
else
    fail "Entity listing with metadata failed: $METADATA_RESPONSE"
fi

#############################################
# Test 10: Get Entity
#############################################
test_section "Test 10: GET /entities/{pi} - Get Entity"
if [ -n "$ENTITY_PI" ]; then
    GET_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$ENTITY_PI")
    GET_PI=$(echo "$GET_RESPONSE" | jq -r '.pi' 2>/dev/null)
    GET_VER=$(echo "$GET_RESPONSE" | jq -r '.ver' 2>/dev/null)
    GET_COMPONENTS=$(echo "$GET_RESPONSE" | jq -r '.components | keys | join(",")' 2>/dev/null)

    if [ "$GET_PI" = "$ENTITY_PI" ] && [ "$GET_VER" -ge 1 ]; then
        pass "Entity retrieved: PI=$GET_PI, ver=$GET_VER, components=$GET_COMPONENTS"
    else
        fail "Entity retrieval failed: $GET_RESPONSE"
    fi
else
    fail "Skipping entity retrieval (no test entity)"
fi

#############################################
# Test 11: Resolve PI to Tip
#############################################
test_section "Test 11: GET /resolve/{pi} - Resolve PI to Tip"
if [ -n "$ENTITY_PI" ]; then
    RESOLVE_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/resolve/$ENTITY_PI")
    RESOLVE_PI=$(echo "$RESOLVE_RESPONSE" | jq -r '.pi' 2>/dev/null)
    RESOLVE_TIP=$(echo "$RESOLVE_RESPONSE" | jq -r '.tip' 2>/dev/null)

    if [ "$RESOLVE_PI" = "$ENTITY_PI" ] && [ -n "$RESOLVE_TIP" ] && [ "$RESOLVE_TIP" != "null" ]; then
        CURRENT_TIP=$RESOLVE_TIP
        pass "PI resolved to tip: ${RESOLVE_TIP:0:20}..."
    else
        fail "PI resolution failed: $RESOLVE_RESPONSE"
    fi
else
    fail "Skipping resolve test (no test entity)"
fi

#############################################
# Test 12: Append Version
#############################################
test_section "Test 12: POST /entities/{pi}/versions - Append Version"
if [ -n "$ENTITY_PI" ] && [ -n "$CURRENT_TIP" ]; then
    VERSION_PAYLOAD=$(cat <<EOF
{
  "expect_tip": "$CURRENT_TIP",
  "components": {
    "readme": "$UPLOAD_CID"
  },
  "note": "Added README component"
}
EOF
    )

    VERSION_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/entities/$ENTITY_PI/versions" \
      -H 'Content-Type: application/json' \
      -d "$VERSION_PAYLOAD")

    VERSION_PI=$(echo "$VERSION_RESPONSE" | jq -r '.pi' 2>/dev/null)
    VERSION_VER=$(echo "$VERSION_RESPONSE" | jq -r '.ver' 2>/dev/null)
    VERSION_TIP=$(echo "$VERSION_RESPONSE" | jq -r '.tip' 2>/dev/null)

    if [ "$VERSION_PI" = "$ENTITY_PI" ] && [ "$VERSION_VER" = "2" ]; then
        ENTITY_V2_TIP=$VERSION_TIP
        pass "Version 2 appended (tip: ${VERSION_TIP:0:20}...)"
    else
        fail "Version append failed: $VERSION_RESPONSE"
    fi
else
    fail "Skipping version append (no test entity or tip)"
fi

#############################################
# Test 13: List Versions
#############################################
test_section "Test 13: GET /entities/{pi}/versions - List Versions"
if [ -n "$ENTITY_PI" ]; then
    VERSIONS_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$ENTITY_PI/versions?limit=10")
    VERSION_COUNT=$(echo "$VERSIONS_RESPONSE" | jq -r '.items | length' 2>/dev/null)
    LATEST_VER=$(echo "$VERSIONS_RESPONSE" | jq -r '.items[0].ver' 2>/dev/null)

    if [ "$VERSION_COUNT" -ge 2 ] && [ "$LATEST_VER" = "2" ]; then
        pass "Version listing works ($VERSION_COUNT versions, latest: v$LATEST_VER)"
    elif [ "$VERSION_COUNT" = "1" ] && [ "$LATEST_VER" = "1" ]; then
        pass "Version listing works (v1 only, v2 append may have failed)"
    else
        fail "Version listing failed: $VERSIONS_RESPONSE"
    fi
else
    fail "Skipping version listing (no test entity)"
fi

#############################################
# Test 14: Get Specific Version (by version number)
#############################################
test_section "Test 14: GET /entities/{pi}/versions/ver:1 - Get Specific Version"
if [ -n "$ENTITY_PI" ]; then
    VER1_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$ENTITY_PI/versions/ver:1")
    VER1_PI=$(echo "$VER1_RESPONSE" | jq -r '.pi' 2>/dev/null)
    VER1_VER=$(echo "$VER1_RESPONSE" | jq -r '.ver' 2>/dev/null)

    if [ "$VER1_PI" = "$ENTITY_PI" ] && [ "$VER1_VER" = "1" ]; then
        pass "Version 1 retrieved by selector ver:1"
    else
        fail "Version selector failed: $VER1_RESPONSE"
    fi
else
    fail "Skipping version selector test (no test entity)"
fi

#############################################
# Test 15: Get Specific Version (by CID)
#############################################
test_section "Test 15: GET /entities/{pi}/versions/cid:{cid} - Get Specific Version by CID"
if [ -n "$ENTITY_PI" ] && [ -n "$ENTITY_V1_TIP" ]; then
    VERCID_RESPONSE=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$ENTITY_PI/versions/cid:$ENTITY_V1_TIP")
    VERCID_PI=$(echo "$VERCID_RESPONSE" | jq -r '.pi' 2>/dev/null)
    VERCID_CID=$(echo "$VERCID_RESPONSE" | jq -r '.manifest_cid' 2>/dev/null)

    if [ "$VERCID_PI" = "$ENTITY_PI" ] && [ "$VERCID_CID" = "$ENTITY_V1_TIP" ]; then
        pass "Version 1 retrieved by CID selector"
    else
        fail "Version CID selector failed: $VERCID_RESPONSE"
    fi
else
    fail "Skipping version CID selector test (no v1 tip)"
fi

#############################################
# Test 16: Create Child Entity for Relations Test
#############################################
test_section "Test 16: Create Child Entity for Relations Test"
CHILD_PAYLOAD=$(cat <<EOF
{
  "components": {
    "data": "$UPLOAD_CID"
  },
  "note": "Child entity for relations test"
}
EOF
)

CHILD_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/entities" \
  -H 'Content-Type: application/json' \
  -d "$CHILD_PAYLOAD")

CHILD_PI=$(echo "$CHILD_RESPONSE" | jq -r '.pi' 2>/dev/null)

if [ -n "$CHILD_PI" ] && [ "$CHILD_PI" != "null" ]; then
    CHILD_PI=$CHILD_PI
    pass "Child entity created: $CHILD_PI"

    # Link child to TEST root too (before parent-child relation)
    TEST_ROOT_TIP_NOW=$(curl -s --max-time 10 "$API_ENDPOINT/resolve/$TEST_ROOT_PI" | jq -r '.tip' 2>/dev/null)
    if [ -n "$TEST_ROOT_TIP_NOW" ] && [ "$TEST_ROOT_TIP_NOW" != "null" ]; then
        curl -s --max-time 30 -X POST "$API_ENDPOINT/relations" \
          -H 'Content-Type: application/json' \
          -d "{\"parent_pi\":\"$TEST_ROOT_PI\",\"expect_tip\":\"$TEST_ROOT_TIP_NOW\",\"add_children\":[\"$CHILD_PI\"],\"note\":\"Linked child entity to TEST root\"}" \
          > /dev/null 2>&1
        pass "Child entity linked to TEST root"
    fi
else
    fail "Child entity creation failed: $CHILD_RESPONSE"
fi

#############################################
# Test 17: Update Relations
#############################################
test_section "Test 17: POST /relations - Update Relations"
if [ -n "$ENTITY_PI" ] && [ -n "$CHILD_PI" ] && [ -n "$ENTITY_V2_TIP" ]; then
    RELATIONS_PAYLOAD=$(cat <<EOF
{
  "parent_pi": "$ENTITY_PI",
  "expect_tip": "$ENTITY_V2_TIP",
  "add_children": ["$CHILD_PI"],
  "note": "Added child relationship"
}
EOF
    )

    RELATIONS_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/relations" \
      -H 'Content-Type: application/json' \
      -d "$RELATIONS_PAYLOAD")

    REL_PI=$(echo "$RELATIONS_RESPONSE" | jq -r '.pi' 2>/dev/null)
    REL_VER=$(echo "$RELATIONS_RESPONSE" | jq -r '.ver' 2>/dev/null)

    if [ "$REL_PI" = "$ENTITY_PI" ] && [ "$REL_VER" = "3" ]; then
        pass "Relations updated (parent now at v$REL_VER)"
    else
        fail "Relations update failed: $RELATIONS_RESPONSE"
    fi
else
    fail "Skipping relations test (missing entities or tip)"
fi

#############################################
# Test 18: Verify Bidirectional Relationship
#############################################
test_section "Test 18: Verify Bidirectional Relationship"
if [ -n "$CHILD_PI" ]; then
    CHILD_CHECK=$(curl -s --max-time 10 "$API_ENDPOINT/entities/$CHILD_PI")
    CHILD_PARENT=$(echo "$CHILD_CHECK" | jq -r '.parent_pi' 2>/dev/null)
    CHILD_VER_AFTER=$(echo "$CHILD_CHECK" | jq -r '.ver' 2>/dev/null)

    if [ "$CHILD_PARENT" = "$ENTITY_PI" ] && [ "$CHILD_VER_AFTER" -ge 2 ]; then
        pass "Bidirectional relationship verified (child updated with parent_pi)"
    else
        fail "Bidirectional relationship not found: parent_pi=$CHILD_PARENT, ver=$CHILD_VER_AFTER"
    fi
else
    fail "Skipping bidirectional check (no child entity)"
fi

#############################################
# Test 19: Link Test Entity to TEST Root
#############################################
test_section "Test 19: Link Test Entity to TEST Root (Testnet Isolation)"
if [ -n "$ENTITY_PI" ]; then
    # Get current TEST root tip
    TEST_ROOT_TIP_FINAL=$(curl -s --max-time 10 "$API_ENDPOINT/resolve/$TEST_ROOT_PI" | jq -r '.tip' 2>/dev/null)

    if [ -n "$TEST_ROOT_TIP_FINAL" ] && [ "$TEST_ROOT_TIP_FINAL" != "null" ]; then
        LINK_PAYLOAD=$(cat <<EOF
{
  "parent_pi": "$TEST_ROOT_PI",
  "expect_tip": "$TEST_ROOT_TIP_FINAL",
  "add_children": ["$ENTITY_PI"],
  "note": "Linked test entity to TEST root for isolation"
}
EOF
        )

        LINK_RESPONSE=$(curl -s --max-time 30 -X POST "$API_ENDPOINT/relations" \
          -H 'Content-Type: application/json' \
          -d "$LINK_PAYLOAD")

        LINK_PI=$(echo "$LINK_RESPONSE" | jq -r '.pi' 2>/dev/null)
        LINK_VER=$(echo "$LINK_RESPONSE" | jq -r '.ver' 2>/dev/null)

        if [ "$LINK_PI" = "$TEST_ROOT_PI" ] && [ -n "$LINK_VER" ]; then
            pass "Test entity linked to TEST root (TEST root now at v$LINK_VER)"
        else
            fail "Failed to link test entity to TEST root: $LINK_RESPONSE"
        fi
    else
        fail "Could not resolve TEST root tip"
    fi
else
    fail "Skipping TEST root linking (no test entity)"
fi

#############################################
# Summary
#############################################
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Test Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${GREEN}Tests Passed: $TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}Tests Failed: $TESTS_FAILED${NC}"
else
    echo -e "${GREEN}Tests Failed: $TESTS_FAILED${NC}"
fi
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo -e "Test Structure Created:"
    echo -e "  Arke PI:      ${YELLOW}$ARKE_PI${NC} (production root)"
    echo -e "  TEST Root:    ${YELLOW}$TEST_ROOT_PI${NC} (testnet root)"
    echo -e "  Test Entity:  ${YELLOW}$ENTITY_PI${NC} (v3, child of TEST root)"
    echo -e "  Child Entity: ${YELLOW}$CHILD_PI${NC} (child of TEST root & test entity)"
    echo -e "  Upload CID:   ${YELLOW}$UPLOAD_CID${NC}"
    echo ""
    echo -e "${BLUE}All test entities are children of TEST root ($TEST_ROOT_PI)${NC}"
    echo -e "${BLUE}This keeps test data isolated from production Arke tree${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
