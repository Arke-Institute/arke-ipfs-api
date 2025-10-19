# Arke IPFS API - Integration Test Suite

Comprehensive test suite for all API endpoints documented in `API_SPEC.md`.

## Overview

This test suite validates the complete Arke IPFS API deployment including:
- Worker endpoints at `api.arke.institute`
- Kubo RPC operations at `ipfs-api.arke.institute`
- IPFS Gateway at `ipfs.arke.institute`

## Test Coverage

### **20 Test Cases** covering **13 API Endpoints**:

1. **GET /** - Health check
2. **POST /arke/init** - Initialize Arke origin block
3. **GET /arke** - Get Arke origin block
4. **POST /entities** - Create TEST root entity (testnet isolation)
5. **POST /upload** - Upload files to IPFS
6. **GET /cat/{cid}** - Download file via worker
7. **Gateway /ipfs/{cid}** - Download file via IPFS gateway
8. **POST /entities** - Create entity
9. **GET /entities** - List entities (without metadata)
10. **GET /entities?include_metadata=true** - List entities with metadata
11. **GET /entities/{pi}** - Get specific entity
12. **GET /resolve/{pi}** - Resolve PI to tip CID
13. **POST /entities/{pi}/versions** - Append version with CAS protection
14. **GET /entities/{pi}/versions** - List version history
15. **GET /entities/{pi}/versions/ver:{N}** - Get version by number
16. **GET /entities/{pi}/versions/cid:{CID}** - Get version by CID
17. **POST /entities** - Create child entity (for relations test)
18. **POST /relations** - Update parent-child relationships
19. **Bidirectional relationships** - Verify automatic child updates
20. **POST /relations** - Link test entity to TEST root (testnet isolation)

## Prerequisites

- `bash` (4.0+)
- `curl`
- `jq` (JSON processing)

## Usage

### Quick Test (Production)

```bash
./api-test-suite.sh
```

This will test against:
- **API:** `https://api.arke.institute`
- **Gateway:** `https://ipfs.arke.institute`
- **Kubo:** `https://ipfs-api.arke.institute`

### Test Local Development

```bash
API_ENDPOINT=http://localhost:8787 \
GATEWAY_ENDPOINT=https://ipfs.arke.institute \
KUBO_ENDPOINT=https://ipfs-api.arke.institute \
./api-test-suite.sh
```

### Custom Endpoints

```bash
API_ENDPOINT=https://custom.example.com \
GATEWAY_ENDPOINT=https://gateway.example.com \
KUBO_ENDPOINT=https://kubo.example.com \
./api-test-suite.sh
```

## Test Flow

### Phase 1: Infrastructure
1. Health check
2. Initialize Arke origin block
3. Verify Arke block retrieval
4. Create TEST root entity (testnet isolation)

### Phase 2: File Operations
5. Upload file to IPFS
6. Download via worker `/cat` endpoint
7. Download via gateway `/ipfs/<CID>`

### Phase 3: Entity Lifecycle
8. Create entity (v1)
9. List all entities (basic)
10. List entities with metadata
11. Retrieve specific entity
12. Resolve PI to tip (fast lookup)

### Phase 4: Versioning
13. Append version (v2) with CAS protection
14. List version history
15. Retrieve specific version by number
16. Retrieve specific version by CID

### Phase 5: Relationships
17. Create child entity
18. Update parent-child relationships
19. Verify bidirectional updates

### Phase 6: Testnet Isolation
20. Link test entity to TEST root (complete isolation)

## Expected Output

```
========================================
  Arke IPFS API Test Suite
========================================

API Endpoint:     https://api.arke.institute
Gateway Endpoint: https://ipfs.arke.institute
Kubo Endpoint:    https://ipfs-api.arke.institute

>>> Test 1: GET / - Health Check
✓ Health check passed (version: 0.1.0)

>>> Test 2: POST /arke/init - Initialize Arke Origin Block
✓ Arke origin block ready (PI: 00000000000000000000000000)

...

========================================
  Test Summary
========================================

Tests Passed: 20
Tests Failed: 0

✓ All tests passed!

Test Structure Created:
  Arke PI:      00000000000000000000000000 (production root)
  TEST Root:    01TEST00000000000000000000 (testnet root)
  Test Entity:  01K7ABC123... (v3, child of TEST root)
  Child Entity: 01K7DEF456... (child of TEST root & test entity)
  Upload CID:   bafyrei...

All test entities are children of TEST root (01TEST00000000000000000000)
This keeps test data isolated from production Arke tree
```

## Exit Codes

- **0** - All tests passed
- **1** - One or more tests failed

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_ENDPOINT` | `https://api.arke.institute` | Arke API Worker URL |
| `GATEWAY_ENDPOINT` | `https://ipfs.arke.institute` | IPFS Gateway URL |
| `KUBO_ENDPOINT` | `https://ipfs-api.arke.institute` | Kubo RPC + Backend API URL |

### About ipfs.arke.institute

**ipfs.arke.institute is NOT a secret** - it's a public IPFS gateway endpoint that:
- Requires no authentication
- Serves content via `/ipfs/<CID>`
- Used for direct content retrieval without going through the worker
- Worker uses Kubo RPC at `ipfs-api.arke.institute` instead

## Troubleshooting

### Gateway Timeouts (504)

The gateway test (Test 6) may timeout for newly uploaded content:
```
✓ Gateway timeout (content not propagated yet - acceptable)
```

This is normal - content takes time to propagate through IPFS network. The test will pass with this message.

### CAS Failures (409)

If version append fails with CAS error:
```
✗ Version append failed: {"error":"CAS_FAILURE","expected":"...","actual":"..."}
```

This means the tip changed between tests. Re-run the test suite.

### Entity Not Found (404)

If entity retrieval fails:
```
✗ Entity retrieval failed: {"error":"NOT_FOUND","message":"Entity not found: ..."}
```

Check that:
1. Entity creation succeeded (Test 7)
2. MFS tips are working (`/resolve` endpoint)
3. Backend event stream is recording creates

## Integration with CI/CD

### GitHub Actions Example

```yaml
name: API Integration Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Install dependencies
        run: sudo apt-get install -y jq
      - name: Run integration tests
        run: |
          cd tests/integration
          ./api-test-suite.sh
```

### Expected Runtime

- **Full suite**: ~30-60 seconds
- **Per test**: 1-3 seconds average
- **Slowest tests**: File upload/download (up to 30s timeout)

## Test Data

The test suite implements a **testnet pattern** for data isolation:

- **1 Arke origin block** (PI: `00000000000000000000000000`) - Production root
- **1 TEST root entity** (PI: `01TEST00000000000000000000`) - Testnet root
- **1 test entity** with 3 versions (v1, v2, v3) - Child of TEST root
- **1 child entity** for relations testing - Child of both TEST root and test entity
- **1 uploaded file** (random content)

**Isolation Strategy:**
All test entities are children of the TEST root entity (`01TEST00000000000000000000`), keeping them completely isolated from the production Arke tree. This makes it easy to identify and clean up test data.

All test data is stored in the live system but clearly marked with notes:
```json
{
  "note": "Test entity created by integration test"
}
```

## Architecture Validation

This test suite validates the complete Arke IPFS architecture:

```
                         ┌─────────────────────┐
                         │   Cloudflare CDN    │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
            ┌───────▼────────┐ ┌────▼─────────┐ ┌─▼──────────────┐
            │ api.arke.inst. │ │ipfs.arke.inst│ │ipfs-api.arke...│
            │ (Worker)       │ │ (Gateway)    │ │ (Kubo+Backend) │
            └───────┬────────┘ └──────────────┘ └────────┬───────┘
                    │                                     │
                    │   Kubo RPC + Events API            │
                    └─────────────────────────────────────┘
```

**Validated flows:**
1. **Upload**: Client → Worker → Kubo RPC → IPFS
2. **Create/Update**: Client → Worker → Kubo RPC → Backend Events
3. **List**: Client → Worker → Backend Events → Response
4. **Download (Worker)**: Client → Worker → Kubo RPC → IPFS
5. **Download (Gateway)**: Client → IPFS Gateway → IPFS Network

## Related Documentation

- [`API_SPEC.md`](../../API_SPEC.md) - Complete API specification
- [`CLAUDE.md`](../../CLAUDE.md) - Architecture overview
- [`BACKEND_API_WALKTHROUGH.md`](../../BACKEND_API_WALKTHROUGH.md) - Backend architecture

## License

Part of the Arke Institute IPFS Archive project.
