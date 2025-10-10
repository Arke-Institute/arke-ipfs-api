# Deployment Guide

## Prerequisites

1. **Node.js** (v18+)
2. **Cloudflare account** with Workers enabled
3. **IPFS Kubo node** accessible from the Worker (HTTP API on port 5001)
4. **Wrangler CLI** installed globally or via npm

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure IPFS Node URL

#### For Local Development

Create `.dev.vars` file (copy from `.dev.vars.example`):

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
```
IPFS_API_URL=http://127.0.0.1:5001
ENVIRONMENT=development
```

#### For Production

Set secrets using Wrangler:

```bash
wrangler secret put IPFS_API_URL
# When prompted, enter: http://your-ipfs-node:5001
```

### 3. Configure Worker Name

Edit `wrangler.jsonc` and update:
```jsonc
{
  "name": "your-worker-name"
}
```

## Local Development

Start the local development server:

```bash
npm run dev
```

The Worker will be available at `http://localhost:8787`

**Test the health endpoint:**
```bash
curl http://localhost:8787/
```

## Deploy to Production

### Type Check

```bash
npm run type-check
```

### Deploy

```bash
npm run deploy
```

Wrangler will output the deployed Worker URL, e.g.:
```
https://your-worker-name.your-subdomain.workers.dev
```

## Verify Deployment

### Check Health

```bash
curl https://your-worker-name.your-subdomain.workers.dev/
```

### Test Upload

```bash
echo "test content" > test.txt
curl -X POST -F "file=@test.txt" \
  https://your-worker-name.your-subdomain.workers.dev/upload
```

### Create Entity

```bash
curl -X POST https://your-worker-name.your-subdomain.workers.dev/entities \
  -H "Content-Type: application/json" \
  -d '{
    "components": {
      "metadata": "bafybei...",
      "image": "bafybei..."
    },
    "note": "Initial version"
  }'
```

## Monitoring

View logs:
```bash
wrangler tail
```

View metrics in [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → your-worker-name

## Troubleshooting

### "IPFS_API_URL is required"

The secret hasn't been set. Run:
```bash
wrangler secret put IPFS_API_URL
```

### Connection to IPFS fails

1. Verify the IPFS node is running and accessible
2. Check firewall rules allow traffic on port 5001
3. Test IPFS directly:
   ```bash
   curl -X POST http://your-ipfs-node:5001/api/v0/version
   ```

### CAS failures

This is expected behavior when concurrent requests modify the same entity. Clients should retry with the updated `tip` value.

## Network Architecture

```
┌─────────┐
│ Clients │
└────┬────┘
     │ HTTPS
     ▼
┌────────────────┐
│ Cloudflare CDN │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│ Worker (API)   │
└───────┬────────┘
        │ HTTP
        ▼
┌────────────────┐
│ Kubo IPFS Node │
└───────┬────────┘
        │
        ▼
┌────────────────┐
│ S3 Datastore   │
└────────────────┘
```

## Security Considerations

1. **API Access Control**: Add authentication middleware before production use
2. **IPFS Node Security**: Ensure the Kubo RPC API is NOT exposed to the public internet
3. **Rate Limiting**: Configure via Cloudflare Dashboard or add middleware
4. **CORS**: Configure allowed origins in `src/index.ts`

## Production Checklist

- [ ] IPFS_API_URL secret configured
- [ ] Worker name configured in wrangler.jsonc
- [ ] CORS origins configured
- [ ] Authentication middleware added
- [ ] Rate limiting configured
- [ ] Monitoring/alerting set up
- [ ] Backup/DR strategy for IPFS node
- [ ] Test all endpoints
- [ ] Document custom domain setup (if applicable)

## Scaling

Cloudflare Workers automatically scale. Bottlenecks will likely be:

1. **IPFS node capacity**: Consider clustering or pinning services
2. **MFS operations**: Tip writes are sequential per PI (by design for CAS)
3. **Large file uploads**: May hit Worker request size limits (100MB)

For high-traffic scenarios, consider:
- Multiple IPFS nodes with load balancing
- Caching layer for frequently accessed manifests
- Offloading large uploads to direct S3 → IPFS pipeline
