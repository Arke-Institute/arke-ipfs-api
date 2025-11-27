# Arke IPFS API Service

Cloudflare Worker implementing the Arke entity management API over IPFS/Kubo.

## Architecture

This service orchestrates IPFS RPC calls to manage:
- **Entities**: immutable manifests (IPLD dag-json) with versioning via `prev` links
- **Tips**: `.tip` files in MFS that point to the latest manifest CID for each PI (Persistent Identifier)
- **Components**: CID references to metadata, images, and other assets
- **Relations**: parent-child relationships via `children_pi` arrays

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure IPFS node URL:
   ```bash
   wrangler secret put IPFS_API_URL
   # Enter: http://your-kubo-node:5001
   ```

3. Run locally:
   ```bash
   npm run dev
   ```

4. Deploy:
   ```bash
   npm run deploy
   ```

## Testnet Support

The API supports separate test and production networks to prevent mixing test data with real data.

**Quick Start:**
```bash
# Create entity on test network
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{"components": {"data": "bafyrei..."}}'
# Returns PI with "II" prefix: {"pi": "IIAK75HQQ...", ...}
```

**Key Features:**
- Add `X-Arke-Network: test` header to use testnet (default is `main`)
- Test PIs are prefixed with `II` (impossible in real ULIDs)
- Test data stored separately in `/arke/test/index/`
- Cross-network relationships are blocked (can't mix test/main parent-child)

See [TESTNET.md](./TESTNET.md) for complete documentation.

## API Endpoints

### `POST /upload`
Upload raw bytes to IPFS; returns CID for use in manifests.

**Known Limitation:** Maximum file size is **100 MB** due to Cloudflare Workers request body size constraints. For files larger than 100 MB, upload directly to the Kubo instance via its HTTP API (port 5001). See [UPLOAD_LIMITS_TEST_RESULTS.md](./UPLOAD_LIMITS_TEST_RESULTS.md) for details.

### `GET /cat/{cid}`
Download file content by CID.

### `GET /entities`
List all entities with cursor-based pagination.
- Query params: `cursor` (optional), `limit` (default: 100, max: 1000), `include_metadata` (default: false)
- Returns: paginated list of entities with PI and tip CID
- With `include_metadata=true`: includes version, timestamp, note, component count, and children count

### `POST /entities`
Create new entity with v1 manifest.

### `GET /entities/{pi}`
Fetch latest manifest for entity.

### `POST /entities/{pi}/versions`
Append new version (requires `expect_tip` for CAS).

### `GET /entities/{pi}/versions`
List version history (paginated).

### `GET /entities/{pi}/versions/{selector}`
Fetch specific version by `cid:<CID>` or `ver:<N>`.

### `POST /relations`
Update parent-child relationships.

### `GET /resolve/{pi}`
Fast PI → tip CID lookup.

## Development

- Type check: `npm run type-check`
- Test: `npm run test`

## Environment Variables

- `IPFS_API_URL` (secret): Kubo RPC endpoint (e.g., `https://ipfs-api.arke.institute`)
- `IPFS_SERVER_API_URL` (secret): Backend API endpoint for event stream and entity indexing (e.g., `https://ipfs-api.arke.institute`)
- `ARKE_PI`: Well-known PI for Arke origin block (default: `00000000000000000000000000`)
- `ENVIRONMENT`: deployment environment (set in wrangler.jsonc)

## Production Deployment

**Production URLs:**
- **API Worker:** `https://api.arke.institute`
- **IPFS Gateway:** `https://ipfs.arke.institute`
- **IPFS Backend:** `https://ipfs-api.arke.institute` (Kubo RPC + Backend API)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment instructions.

## Testing

Run the comprehensive integration test suite covering all 20 test cases across 13 endpoints:

```bash
cd tests/integration
./api-test-suite.sh
```

**Test against production:**
```bash
./api-test-suite.sh
```

**Test against local development:**
```bash
API_ENDPOINT=http://localhost:8787 \
GATEWAY_ENDPOINT=https://ipfs.arke.institute \
KUBO_ENDPOINT=https://ipfs-api.arke.institute \
./api-test-suite.sh
```

See [tests/integration/README.md](./tests/integration/README.md) for complete test documentation.

## See Also

- [IPFS API Complete Guide](./IPFS_API_Complete_Guide.md)
- [Testnet Guide](./TESTNET.md)
