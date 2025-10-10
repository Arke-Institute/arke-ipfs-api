# Arke IPFS API Service

Cloudflare Worker implementing the Arke entity management API over IPFS/Kubo.

## Architecture

This service orchestrates IPFS RPC calls to manage:
- **Entities**: immutable manifests (IPLD dag-cbor) with versioning via `prev` links
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

## API Endpoints

### `POST /upload`
Upload raw bytes to IPFS; returns CID for use in manifests.

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

- `IPFS_API_URL` (secret): Kubo RPC endpoint
- `ENVIRONMENT`: deployment environment (set in wrangler.jsonc)

## See Also

- [IPFS API Complete Guide](./IPFS_API_Complete_Guide.md)
