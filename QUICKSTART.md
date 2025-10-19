# Quick Start Guide

## Choose Your Environment

**Production (recommended for testing):**
- API: `https://api.arke.institute`
- Gateway: `https://ipfs.arke.institute`
- No setup required - just start testing!

**Local Development:**
- API: `http://localhost:8787`
- Requires IPFS node setup (see below)

This guide shows both options. Use `$API` variable to switch between them.

---

## Local Development Setup

## 1. Install Dependencies

```bash
npm install
```

## 2. Start IPFS Node

Make sure you have Kubo running locally:

```bash
ipfs daemon
```

Verify it's accessible:
```bash
curl -X POST http://127.0.0.1:5001/api/v0/version
```

## 3. Configure Local Development

Create `.dev.vars`:
```bash
cp .dev.vars.example .dev.vars
```

## 4. Start Worker

```bash
npm run dev
```

The API will be available at `http://localhost:8787`

## 5. Test Basic Flow

**Set your API endpoint:**
```bash
# Production
API="https://api.arke.institute"

# OR Local
API="http://localhost:8787"
```

### Check health
```bash
curl $API/
```

### Initialize and check Arke origin block

The Arke origin block is the root entity of the archive tree. Initialize it (or verify it exists):

```bash
curl -X POST $API/arke/init
```

Response (if already exists):
```json
{
  "message": "Arke origin block already exists",
  "pi": "00000000000000000000000000",
  "ver": 2,
  "ts": "2025-10-12T17:35:39.621Z",
  "manifest_cid": "bafybeiabc789...",
  "components": {
    "metadata": "bafkreiabc123..."
  },
  "children_pi": ["01K7..."]
}
```

You can also fetch it anytime using:
```bash
curl $API/arke
```

This confirms:
- IPFS connectivity is working
- MFS operations are functional
- The backend indexing service is accessible
- The archive tree root is established

### Upload a file
```bash
echo "Hello IPFS!" > test.txt
curl -X POST -F "file=@test.txt" $API/upload
```

Response:
```json
[
  {
    "name": "test.txt",
    "cid": "bafybeifq2r...",
    "size": 12
  }
]
```

### Create an entity
```bash
curl -X POST $API/entities \
  -H "Content-Type: application/json" \
  -d '{
    "components": {
      "data": "bafybeifq2r..."
    },
    "note": "First entity"
  }'
```

Response:
```json
{
  "pi": "01JDABC123...",
  "ver": 1,
  "manifest_cid": "bafybeixyz...",
  "tip": "bafybeixyz..."
}
```

### Get the entity
```bash
curl $API/entities/01JDABC123...
```

### Append a version
```bash
# Upload new content
echo "Updated content" > test2.txt
curl -X POST -F "file=@test2.txt" $API/upload
# Returns: {"cid": "bafybeinew..."}

# Append version
curl -X POST $API/entities/01JDABC123.../versions \
  -H "Content-Type: application/json" \
  -d '{
    "expect_tip": "bafybeixyz...",
    "components": {
      "data": "bafybeinew..."
    },
    "note": "Updated content"
  }'
```

### List version history
```bash
curl $API/entities/01JDABC123.../versions
```

### Fast resolve
```bash
curl $API/resolve/01JDABC123...
```

## Common Issues

### "Cannot connect to IPFS"
- Check `ipfs daemon` is running
- Verify `.dev.vars` has correct `IPFS_API_URL`

### "IPFS_API_URL is required"
- Create `.dev.vars` file (see step 3)

### TypeScript errors in editor
- Run `npm install` to install dependencies
- Restart your editor/language server

## Next Steps

1. Read [API_SPEC.md](./API_SPEC.md) for full endpoint documentation
2. See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment
3. Review [IPFS_API_Complete_Guide.md](./IPFS_API_Complete_Guide.md) for IPFS details
4. Add authentication middleware (not included in MVP)
5. Configure CORS for your frontend

## Example: Complete Workflow

```bash
#!/bin/bash
# Set your API endpoint
API="https://api.arke.institute"  # Production
# API="http://localhost:8787"     # OR Local

# 1. Upload files
METADATA_CID=$(echo '{"title":"My Item"}' | curl -s -X POST -F "file=@-" "$API/upload" | jq -r '.[0].cid')
IMAGE_CID=$(curl -s -X POST -F "file=@image.jpg" "$API/upload" | jq -r '.[0].cid')

echo "Uploaded metadata: $METADATA_CID"
echo "Uploaded image: $IMAGE_CID"

# 2. Create entity
ENTITY=$(curl -s -X POST "$API/entities" \
  -H "Content-Type: application/json" \
  -d "{
    \"components\": {
      \"metadata\": \"$METADATA_CID\",
      \"image\": \"$IMAGE_CID\"
    },
    \"note\": \"Initial version\"
  }")

PI=$(echo $ENTITY | jq -r '.pi')
TIP=$(echo $ENTITY | jq -r '.tip')

echo "Created entity: $PI"
echo "Tip: $TIP"

# 3. Update metadata
NEW_METADATA_CID=$(echo '{"title":"Updated Item"}' | curl -s -X POST -F "file=@-" "$API/upload" | jq -r '.[0].cid')

UPDATED=$(curl -s -X POST "$API/entities/$PI/versions" \
  -H "Content-Type: application/json" \
  -d "{
    \"expect_tip\": \"$TIP\",
    \"components\": {
      \"metadata\": \"$NEW_METADATA_CID\"
    },
    \"note\": \"Updated title\"
  }")

NEW_TIP=$(echo $UPDATED | jq -r '.tip')
VER=$(echo $UPDATED | jq -r '.ver')

echo "Updated to v$VER"
echo "New tip: $NEW_TIP"

# 4. List history
echo "\nVersion history:"
curl -s "$API/entities/$PI/versions" | jq '.items[] | {ver, note, ts}'
```
