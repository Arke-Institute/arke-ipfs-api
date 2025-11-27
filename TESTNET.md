# Testnet Guide

The Arke IPFS API supports separate test and production (main) networks. This allows you to develop and test without polluting production data, with strong guarantees that test and production data can never be mixed.

## Quick Start

Add the `X-Arke-Network: test` header to any request to use the testnet:

```bash
# Create a test entity
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{"components": {"data": "bafkreidnnvaana7rclvb3s4vpjnonoa2tlditvjxfq3l2jerenzbdt4ree"}}'

# Response: PI starts with "II"
# {"pi": "IIKB357AKBQZEVHSGPZT36ADZ8", "ver": 1, ...}
```

## How It Works

### Three-Layer Isolation

1. **API Layer**: The `X-Arke-Network` header determines which network to use
2. **PI Layer**: Test PIs are prefixed with `II` making them visually distinct
3. **Storage Layer**: Test data is stored in a separate MFS directory

### Network Header

| Header Value | Network | Default |
|--------------|---------|---------|
| `X-Arke-Network: main` | Production | Yes |
| `X-Arke-Network: test` | Testnet | No |
| (no header) | Production | Yes |

Invalid header values return a 400 error.

### PI (Persistent Identifier) Format

| Network | Format | Example |
|---------|--------|---------|
| Main | Standard ULID (26 chars) | `01KB357AKBQZEVHSGPZT36ADZ8` |
| Test | `II` + 24 chars | `IIKB357AKBQZEVHSGPZT36ADZ8` |

**Why `II`?** The letter 'I' is excluded from Crockford's Base32 alphabet (used by ULIDs) to avoid confusion with '1'. This makes it **impossible** for a real ULID to ever start with `II`, guaranteeing that test PIs can never collide with production PIs.

### Storage Paths

| Network | MFS Path |
|---------|----------|
| Main | `/arke/index/{shard1}/{shard2}/{pi}.tip` |
| Test | `/arke/test/index/{shard1}/{shard2}/{pi}.tip` |

The same IPFS node stores both networks, but in completely separate directory trees.

## Cross-Network Prevention

The API enforces strict network isolation. You **cannot**:

- Access a test entity without the `X-Arke-Network: test` header
- Create a main entity with a test parent
- Add test children to a main entity
- Create relationships between test and main entities

### Error Example

```bash
# Try to access test entity without header
curl https://api.arke.institute/entities/IIKB357AKBQZEVHSGPZT36ADZ8

# Returns 400 error:
{
  "error": "VALIDATION_ERROR",
  "message": "PI IIKB357AKBQZEVHSGPZT36ADZ8 belongs to test network but request is for main network",
  "details": {
    "pi": "IIKB357AKBQZEVHSGPZT36ADZ8",
    "expected_network": "main",
    "actual_network": "test"
  }
}
```

## API Usage Examples

### Creating Entities

```bash
# Create test entity (PI auto-generated with II prefix)
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{
    "components": {"metadata": "bafyrei..."},
    "note": "Test entity"
  }'

# Create test entity with specific PI (must start with II)
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{
    "pi": "IIAAAAAAAAAAAAAAAAAAAAAAA1",
    "components": {"metadata": "bafyrei..."}
  }'
```

### Reading Entities

```bash
# Get test entity
curl https://api.arke.institute/entities/IIKB357AKBQZEVHSGPZT36ADZ8 \
  -H "X-Arke-Network: test"

# List all test entities
curl "https://api.arke.institute/entities?limit=100" \
  -H "X-Arke-Network: test"

# Resolve test PI to tip CID
curl https://api.arke.institute/resolve/IIKB357AKBQZEVHSGPZT36ADZ8 \
  -H "X-Arke-Network: test"
```

### Updating Entities

```bash
# Append version to test entity
curl -X POST https://api.arke.institute/entities/IIKB357AKBQZEVHSGPZT36ADZ8/versions \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{
    "expect_tip": "bafyrei...",
    "components": {"metadata": "bafyrei_new..."},
    "note": "Updated metadata"
  }'
```

### Parent-Child Relationships

```bash
# Create test parent
PARENT=$(curl -s -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{"components": {"data": "bafyrei..."}}')

PARENT_PI=$(echo $PARENT | jq -r '.pi')
PARENT_TIP=$(echo $PARENT | jq -r '.tip')

# Create test child with parent (auto-updates parent's children_pi)
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d "{
    \"components\": {\"data\": \"bafyrei...\"},
    \"parent_pi\": \"$PARENT_PI\"
  }"

# Bulk add children via relations endpoint
curl -X POST https://api.arke.institute/relations \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d "{
    \"parent_pi\": \"$PARENT_PI\",
    \"expect_tip\": \"$PARENT_TIP\",
    \"add_children\": [\"IICHILD1...\", \"IICHILD2...\"]
  }"
```

## Uploads and Downloads

File uploads (`POST /upload`) and downloads (`GET /cat/{cid}`) are **network-agnostic**. CIDs don't belong to a specific network - only entity manifests do.

```bash
# Upload works the same for both networks
curl -X POST https://api.arke.institute/upload \
  -F "file=@myfile.json"
# Returns: {"cid": "bafyrei...", ...}

# Use the CID in either network
curl -X POST https://api.arke.institute/entities \
  -H "X-Arke-Network: test" \
  -H "Content-Type: application/json" \
  -d '{"components": {"data": "bafyrei..."}}'
```

## Best Practices

### Development Workflow

1. **Always use testnet during development**
   ```bash
   export ARKE_NETWORK="test"
   alias arke-curl='curl -H "X-Arke-Network: $ARKE_NETWORK"'
   ```

2. **Use a wrapper function**
   ```bash
   arke() {
     curl -H "X-Arke-Network: test" "$@"
   }
   ```

3. **Set header in your HTTP client**
   ```javascript
   // JavaScript/fetch
   const headers = {
     'Content-Type': 'application/json',
     'X-Arke-Network': process.env.NODE_ENV === 'production' ? 'main' : 'test'
   };
   ```

### Client Library Pattern

```typescript
class ArkeClient {
  constructor(
    private baseUrl: string,
    private network: 'main' | 'test' = 'main'
  ) {}

  private async fetch(path: string, options: RequestInit = {}) {
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'X-Arke-Network': this.network,
        ...options.headers,
      },
    });
  }

  async createEntity(components: Record<string, string>) {
    return this.fetch('/entities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ components }),
    });
  }
}

// Usage
const testClient = new ArkeClient('https://api.arke.institute', 'test');
const prodClient = new ArkeClient('https://api.arke.institute', 'main');
```

### Identifying Test Data

Test PIs are easy to identify by their `II` prefix:

```typescript
function isTestPi(pi: string): boolean {
  return pi.startsWith('II');
}

function getNetwork(pi: string): 'main' | 'test' {
  return isTestPi(pi) ? 'test' : 'main';
}
```

## FAQ

**Q: Can I delete test data?**
A: Currently there's no delete endpoint. Test data persists in MFS but is completely isolated from production.

**Q: Do test entities count toward any limits?**
A: Test and main networks share the same IPFS node storage, so they share the same storage limits.

**Q: Can I migrate test entities to production?**
A: Not directly. You would need to recreate the entity on the main network with new PI(s).

**Q: What happens if I forget the header?**
A: Requests default to main network. If you try to access a test entity (II-prefixed PI) without the header, you'll get a 400 error.

**Q: Is the testnet data backed up?**
A: Test data follows the same backup procedures as production data on the IPFS node.

## Technical Details

### Validation Flow

1. Middleware parses `X-Arke-Network` header (defaults to 'main')
2. TipService is instantiated with network-specific base path
3. All PI parameters are validated against the request's network
4. Cross-network relationships are blocked before any writes occur

### Implementation Files

| File | Purpose |
|------|---------|
| `src/types/network.ts` | Network type, validation helpers, PI prefix constants |
| `src/utils/ulid.ts` | `generatePi(network)` function |
| `src/services/tip.ts` | Network-aware MFS paths |
| `src/types/manifest.ts` | PI regex accepts both formats |
