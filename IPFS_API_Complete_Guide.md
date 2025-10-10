# IPFS HTTP API Complete Guide

**Complete HTTP RPC API Reference for IPFS with S3 Datastore**

This guide provides comprehensive documentation for the IPFS HTTP RPC API, mirroring the functionality described in the CLI guide. All examples are tested against Kubo 0.39.0-dev with S3 backend.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [File Management](#file-management)
3. [Directory and Folder Operations](#directory-and-folder-operations)
4. [MFS (Mutable File System)](#mfs-mutable-file-system)
5. [DAG Structure and Navigation](#dag-structure-and-navigation)
6. [Parent-Child Relationships](#parent-child-relationships)
7. [CID Operations](#cid-operations)
8. [Pin Management](#pin-management)
9. [S3 Integration](#s3-integration)
10. [Repository Management](#repository-management)
11. [Common Workflows](#common-workflows)
12. [Quick Reference](#quick-reference)
13. [Security & Best Practices](#security--best-practices)
14. [Language-Specific Examples](#language-specific-examples)

---

## Getting Started

### API Basics

**Base URL:** `http://127.0.0.1:5001/api/v0`

**Method:** All API calls use `POST` (even for reads)

**Content Types:**
- Query parameters: `application/x-www-form-urlencoded`
- File uploads: `multipart/form-data`
- JSON responses: `application/json`

### Testing API Connectivity

```bash
# Check API is accessible
curl -X POST "http://127.0.0.1:5001/api/v0/version"
```

**Response:**
```json
{
  "Version": "0.39.0-dev",
  "Commit": "1e9b6fb27-dirty",
  "Repo": "18",
  "System": "arm64/darwin",
  "Golang": "go1.25.0"
}
```

### Check Repository Status

```bash
curl -X POST "http://127.0.0.1:5001/api/v0/repo/stat" | jq .
```

**Response:**
```json
{
  "RepoSize": 75064,
  "StorageMax": 10000000000,
  "NumObjects": 409,
  "RepoPath": "/Users/chim/.ipfs",
  "Version": "fs-repo@18"
}
```

### Gateway Test

**HTTP Gateway:** `http://127.0.0.1:8080/ipfs/<CID>`

```bash
# Read file via gateway (GET request)
curl "http://127.0.0.1:8080/ipfs/QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8D2GhfbSXc/readme"
```

---

## File Management

### Adding Files

**Endpoint:** `POST /api/v0/add`

**Single File Upload:**

```bash
# Add from file
curl -X POST -F "file=@test.txt" "http://127.0.0.1:5001/api/v0/add"

# Add from stdin
echo "Hello IPFS API!" | curl -X POST -F "file=@-" "http://127.0.0.1:5001/api/v0/add"
```

**Response:**
```json
{
  "Name": "test.txt",
  "Hash": "QmXXXXX...",
  "Size": "42"
}
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `quieter` | bool | false | Only return final hash |
| `progress` | bool | false | Stream progress updates |
| `pin` | bool | true | Pin added content |
| `only-hash` | bool | false | Only compute hash, don't store |
| `cid-version` | int | 0 | CID version (0 or 1) |
| `chunker` | string | size-262144 | Chunking algorithm |
| `wrap-with-directory` | bool | false | Wrap files in directory |

**Examples:**

```bash
# Add without pinning
curl -X POST -F "file=@test.txt" \
  "http://127.0.0.1:5001/api/v0/add?pin=false"

# Add with CIDv1
curl -X POST -F "file=@test.txt" \
  "http://127.0.0.1:5001/api/v0/add?cid-version=1"

# Only compute hash
curl -X POST -F "file=@test.txt" \
  "http://127.0.0.1:5001/api/v0/add?only-hash=true"

# Custom chunking
curl -X POST -F "file=@largefile.bin" \
  "http://127.0.0.1:5001/api/v0/add?chunker=size-1048576"

# Get only final hash
curl -X POST -F "file=@test.txt" \
  "http://127.0.0.1:5001/api/v0/add?quieter=true"
```

**Quieter Response:**
```json
{
  "Name": "-",
  "Hash": "QmaSBj3DPHHr7Uwhxu7p3ZhzH2C6MUWfyGoLqYa2dMLZkh",
  "Size": "32"
}
```

### Retrieving Files

**Endpoint:** `POST /api/v0/cat`

**Display Content:**

```bash
# Cat file content
curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmXXXXX..."

# With output redirection
curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmXXXXX..." > output.txt
```

**Response:** Raw file content (not JSON)

```
Test file for API guide
```

**Endpoint:** `POST /api/v0/get`

**Download Files:**

```bash
# Download file
curl -X POST "http://127.0.0.1:5001/api/v0/get?arg=QmXXXXX..." -o output.tar

# The get endpoint returns a tar archive
```

### File Information

**Endpoint:** `POST /api/v0/block/stat`

```bash
curl -X POST "http://127.0.0.1:5001/api/v0/block/stat?arg=QmXXXXX..." | jq .
```

**Response:**
```json
{
  "Key": "QmaSBj3DPHHr7Uwhxu7p3ZhzH2C6MUWfyGoLqYa2dMLZkh",
  "Size": 32
}
```

**Check if Block Exists:**

```bash
# Returns 200 if exists, error if not
curl -X POST -w "%{http_code}" \
  "http://127.0.0.1:5001/api/v0/block/stat?arg=QmXXXXX..." \
  -o /dev/null -s
```

---

## Directory and Folder Operations

### Adding Directories

**Upload Multiple Files:**

```bash
# Upload multiple files as directory
curl -X POST \
  -F "file=@file1.txt" \
  -F "file=@file2.txt" \
  "http://127.0.0.1:5001/api/v0/add?wrap-with-directory=true"
```

**Response:**
```json
[
  {
    "Name": "file1.txt",
    "Hash": "QmAAA...",
    "Size": "22"
  },
  {
    "Name": "file2.txt",
    "Hash": "QmBBB...",
    "Size": "22"
  },
  {
    "Name": "",
    "Hash": "QmDirCID...",
    "Size": "150"
  }
]
```

The last entry (with empty `Name`) is the directory CID.

### Recursive Directory Upload

**Using tar:**

```bash
# Create tar archive
tar -cf myproject.tar myproject/

# Upload tar
curl -X POST -F "file=@myproject.tar" \
  "http://127.0.0.1:5001/api/v0/tar/add" | jq .
```

### Listing Directory Contents

**Endpoint:** `POST /api/v0/ls`

```bash
# Basic list
curl -X POST "http://127.0.0.1:5001/api/v0/ls?arg=QmDirCID..." | jq .
```

**Response:**
```json
{
  "Objects": [
    {
      "Hash": "QmDirCID...",
      "Links": [
        {
          "Name": "file1.txt",
          "Hash": "QmFileHash1...",
          "Size": 54,
          "Type": 2
        },
        {
          "Name": "subdir",
          "Hash": "QmSubdirHash...",
          "Size": 191,
          "Type": 1
        }
      ]
    }
  ]
}
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `arg` | string | CID to list |
| `headers` | bool | Include column headers |
| `resolve-type` | bool | Resolve link types |

### Accessing Files in Directories

**Path-based access:**

```bash
# Access file by path
curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmDirCID/file1.txt"

# Access nested file
curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmDirCID/subdir/nested.txt"
```

---

## MFS (Mutable File System)

MFS provides a POSIX-like interface over IPFS. All operations update the MFS root CID.

### Basic MFS Operations

**Endpoint:** `POST /api/v0/files/stat`

```bash
# Check MFS root
curl -X POST "http://127.0.0.1:5001/api/v0/files/stat?arg=/" | jq .
```

**Response:**
```json
{
  "Hash": "QmdbFxWpGJR3kKJAunNZbBgiLyuhCgb8B5jZn4bf1eTGXc",
  "Size": 0,
  "CumulativeSize": 691,
  "Blocks": 2,
  "Type": "directory"
}
```

**Endpoint:** `POST /api/v0/files/ls`

```bash
# List MFS root
curl -X POST "http://127.0.0.1:5001/api/v0/files/ls?arg=/" | jq .

# List with details
curl -X POST "http://127.0.0.1:5001/api/v0/files/ls?arg=/&long=true" | jq .
```

**Response:**
```json
{
  "Entries": [
    {
      "Name": "test-mfs-dir",
      "Type": 1,
      "Size": 0,
      "Hash": "QmR7MmcwaRogQFBxv1LcCFh17st7cTGTQoeFzKu8YEMSR5"
    },
    {
      "Name": "v2-build",
      "Type": 1,
      "Size": 0,
      "Hash": "QmY26J1vr3ncypDSNw6KVLHtbeDyjDogVVNhMs2krBNJJd"
    }
  ]
}
```

**Types:** `0` = file, `1` = directory

### Creating Directories

**Endpoint:** `POST /api/v0/files/mkdir`

```bash
# Create directory
curl -X POST "http://127.0.0.1:5001/api/v0/files/mkdir?arg=/myproject"

# Create nested directories
curl -X POST "http://127.0.0.1:5001/api/v0/files/mkdir?arg=/myproject/src/components&parents=true"
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `arg` | string | required | Path to create |
| `parents` | bool | false | Create parent directories |
| `cid-version` | int | 0 | CID version for directory |
| `hash` | string | sha2-256 | Hash function |

### Copying Content into MFS

**Endpoint:** `POST /api/v0/files/cp`

```bash
# Copy from IPFS to MFS
curl -X POST "http://127.0.0.1:5001/api/v0/files/cp?arg=/ipfs/QmXXX...&arg=/myproject/file.txt"

# Copy directory
curl -X POST "http://127.0.0.1:5001/api/v0/files/cp?arg=/ipfs/QmDirCID&arg=/myproject/imported-dir"

# Copy within MFS
curl -X POST "http://127.0.0.1:5001/api/v0/files/cp?arg=/myproject/file.txt&arg=/backup/file.txt"
```

### Moving and Renaming

**Endpoint:** `POST /api/v0/files/mv`

```bash
# Rename file
curl -X POST "http://127.0.0.1:5001/api/v0/files/mv?arg=/myproject/old.txt&arg=/myproject/new.txt"

# Move to different directory
curl -X POST "http://127.0.0.1:5001/api/v0/files/mv?arg=/myproject/file.txt&arg=/archive/file.txt"
```

### Reading from MFS

**Endpoint:** `POST /api/v0/files/read`

```bash
# Read file content
curl -X POST "http://127.0.0.1:5001/api/v0/files/read?arg=/myproject/file.txt"

# Read with offset and count
curl -X POST "http://127.0.0.1:5001/api/v0/files/read?arg=/file.txt&offset=10&count=100"
```

**Response:** Raw file content

### Writing to MFS

**Endpoint:** `POST /api/v0/files/write`

```bash
# Create new file
echo "content" | curl -X POST \
  -F "file=@-" \
  "http://127.0.0.1:5001/api/v0/files/write?arg=/myproject/new.txt&create=true"

# Append to file
echo "more content" | curl -X POST \
  -F "file=@-" \
  "http://127.0.0.1:5001/api/v0/files/write?arg=/myproject/file.txt&truncate=false"

# Overwrite file
echo "new content" | curl -X POST \
  -F "file=@-" \
  "http://127.0.0.1:5001/api/v0/files/write?arg=/myproject/file.txt&truncate=true"
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `arg` | string | required | MFS path |
| `create` | bool | false | Create file if doesn't exist |
| `truncate` | bool | false | Truncate before writing |
| `offset` | int | 0 | Byte offset to write at |
| `count` | int | 0 | Maximum bytes to write |
| `parents` | bool | false | Create parent directories |

### Deleting from MFS

**Endpoint:** `POST /api/v0/files/rm`

```bash
# Remove file
curl -X POST "http://127.0.0.1:5001/api/v0/files/rm?arg=/myproject/file.txt"

# Remove directory recursively
curl -X POST "http://127.0.0.1:5001/api/v0/files/rm?arg=/myproject/old-dir&recursive=true"

# Remove multiple items
curl -X POST "http://127.0.0.1:5001/api/v0/files/rm?arg=/file1.txt&arg=/file2.txt"
```

### Flushing MFS Changes

**Endpoint:** `POST /api/v0/files/flush`

```bash
# Flush specific path
curl -X POST "http://127.0.0.1:5001/api/v0/files/flush?arg=/myproject"

# Flush root (update root CID)
curl -X POST "http://127.0.0.1:5001/api/v0/files/flush?arg=/"
```

**Note:** Most MFS commands have `flush=true` by default.

---

## DAG Structure and Navigation

### Viewing DAG Structure

**Endpoint:** `POST /api/v0/dag/get`

```bash
# Get DAG node
curl -X POST "http://127.0.0.1:5001/api/v0/dag/get?arg=QmCID..." | jq .
```

**Example Directory Response:**
```json
{
  "Data": {"/": {"bytes": "CAE"}},
  "Links": [
    {
      "Hash": {"/": "QmFileHash..."},
      "Name": "file.txt",
      "Tsize": 62
    },
    {
      "Hash": {"/": "QmDirHash..."},
      "Name": "subdir",
      "Tsize": 191
    }
  ]
}
```

**Navigate DAG by path:**

```bash
# Get node at specific path
curl -X POST "http://127.0.0.1:5001/api/v0/dag/get?arg=QmRootCID/subdir/file.txt" | jq .
```

### DAG Statistics

**Endpoint:** `POST /api/v0/dag/stat`

```bash
curl -X POST "http://127.0.0.1:5001/api/v0/dag/stat?arg=QmCID..." | jq .
```

**Response:**
```json
{
  "UniqueBlocks": 1,
  "TotalSize": 32,
  "Ratio": 1,
  "DagStats": [
    {
      "Cid": "QmaSBj3DPHHr7Uwhxu7p3ZhzH2C6MUWfyGoLqYa2dMLZkh",
      "Size": 32,
      "NumBlocks": 1
    }
  ]
}
```

### Navigating Down the DAG (Children)

**Endpoint:** `POST /api/v0/refs`

```bash
# List immediate children
curl -X POST "http://127.0.0.1:5001/api/v0/ls?arg=QmDirectoryCID" | jq .

# List all references (children CIDs only)
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmDirectoryCID"

# List recursively (all descendants)
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmDirectoryCID&recursive=true"

# Show unique refs only
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmDirectoryCID&unique=true"

# Show edges (format: <src> -> <dst>)
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmCID&edges=true"
```

**Response format:**
```
{"Ref":"QmChildCID1..."}
{"Ref":"QmChildCID2..."}
{"Ref":"QmChildCID3..."}
```

### Path Resolution

**Endpoint:** `POST /api/v0/dag/resolve`

```bash
# Resolve path to final CID
curl -X POST "http://127.0.0.1:5001/api/v0/dag/resolve?arg=/ipfs/QmRoot/path/to/file.txt" | jq .
```

**Response:**
```json
{
  "Cid": {
    "/": "QmFileCID..."
  },
  "RemPath": ""
}
```

### Finding All Descendants

```bash
# Get all CIDs in DAG recursively
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmRootCID&recursive=true"

# Count descendants
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmRootCID&recursive=true" | wc -l

# Get unique blocks only
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmRootCID&recursive=true&unique=true"
```

---

## Parent-Child Relationships

IPFS DAGs don't have native parent tracking. Use these strategies:

### Finding Children (Direct Links)

```bash
# Direct children from CID
curl -X POST "http://127.0.0.1:5001/api/v0/ls?arg=QmParentCID" | jq '.Objects[0].Links'

# All children recursively
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmParentCID&recursive=true"
```

### Finding Parents

**Strategy: Search MFS**

```bash
# List MFS root
curl -X POST "http://127.0.0.1:5001/api/v0/files/ls?arg=/&long=true" | jq '.Entries[] | select(.Hash == "QmTargetCID")'
```

**Strategy: Search Pinned Content**

```bash
# Check if CID is pinned
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?arg=QmTargetCID" | jq .

# List all recursive pins
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?type=recursive" | jq .
```

### Checking Relationships

```bash
# Check if CID2 is descendant of CID1
curl -X POST "http://127.0.0.1:5001/api/v0/refs?arg=QmCID1&recursive=true" | grep "QmCID2"
```

---

## CID Operations

### CID Format Conversion

**Endpoint:** `POST /api/v0/cid/format`

```bash
# Convert CIDv0 to CIDv1
curl -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=QmXXX...&v=1" | jq .

# Convert to base32
curl -X POST "http://127.0.0.1:5001/api/v0/cid/base32?arg=QmXXX..."
```

**Response:**
```json
{
  "CidStr": "QmXXX...",
  "Formatted": "bafybei...",
  "ErrorMsg": ""
}
```

### Extracting CID Components

```bash
# Get multihash from CID
curl -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=QmXXX...&f=%25M"

# Get multihash as base32 uppercase (S3 format)
curl -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=QmXXX...&f=%25M&b=base32upper" | jq -r .Formatted
```

**Response:**
```json
{
  "CidStr": "QmaSBj3DPHHr7Uwhxu7p3ZhzH2C6MUWfyGoLqYa2dMLZkh",
  "Formatted": "CIQLHNZXS4LWC74GS3QMSQIUKD3XZIFPTHR5USTQP6CCPXON2S6BVXQ",
  "ErrorMsg": ""
}
```

**Format Specifiers:**

| Specifier | Description |
|-----------|-------------|
| `%s` | CID string |
| `%S` | CID string without multibase prefix |
| `%b` | Multibase name |
| `%B` | Multibase code |
| `%v` | Version |
| `%c` | Codec name |
| `%C` | Codec code |
| `%h` | Multihash name |
| `%H` | Multihash code |
| `%L` | Multihash length |
| `%m` | Multihash encoded in multibase |
| `%M` | Multihash hex string |
| `%d` | Multihash digest hex string |
| `%D` | Multihash digest bytes |
| `%P` | Prefix (version, codec, multihash info) |

### CID Information

```bash
# List available bases
curl -X POST "http://127.0.0.1:5001/api/v0/cid/bases" | jq .

# List codecs
curl -X POST "http://127.0.0.1:5001/api/v0/cid/codecs" | jq .

# List hash functions
curl -X POST "http://127.0.0.1:5001/api/v0/cid/hashes" | jq .
```

---

## Pin Management

### Pinning Content

**Endpoint:** `POST /api/v0/pin/add`

```bash
# Pin content recursively (default)
curl -X POST "http://127.0.0.1:5001/api/v0/pin/add?arg=QmCID..."

# Pin without recursion (direct pin)
curl -X POST "http://127.0.0.1:5001/api/v0/pin/add?arg=QmCID...&recursive=false"

# Pin with progress
curl -X POST "http://127.0.0.1:5001/api/v0/pin/add?arg=QmCID...&progress=true"
```

**Response:**
```json
{
  "Pins": ["QmCID..."]
}
```

### Listing Pins

**Endpoint:** `POST /api/v0/pin/ls`

```bash
# List all recursive pins
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?type=recursive" | jq .

# List all direct pins
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?type=direct" | jq .

# List all pins
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?type=all" | jq .

# Check specific CID
curl -X POST "http://127.0.0.1:5001/api/v0/pin/ls?arg=QmCID..." | jq .
```

**Response:**
```json
{
  "Keys": {
    "QmCID1...": {"Type": "recursive", "Name": ""},
    "QmCID2...": {"Type": "direct", "Name": "my-pin"},
    "QmCID3...": {"Type": "indirect", "Name": ""}
  }
}
```

### Unpinning Content

**Endpoint:** `POST /api/v0/pin/rm`

```bash
# Unpin content
curl -X POST "http://127.0.0.1:5001/api/v0/pin/rm?arg=QmCID..."

# Unpin direct pin
curl -X POST "http://127.0.0.1:5001/api/v0/pin/rm?arg=QmCID...&recursive=false"
```

**Response:**
```json
{
  "Pins": ["QmCID..."]
}
```

### Updating Pins

**Endpoint:** `POST /api/v0/pin/update`

```bash
# Efficiently replace old pin with new
curl -X POST "http://127.0.0.1:5001/api/v0/pin/update?arg=QmOldCID&arg=QmNewCID" | jq .
```

**Response:**
```json
{
  "Pins": ["QmNewCID..."]
}
```

### Pin Verification

**Endpoint:** `POST /api/v0/pin/verify`

```bash
# Verify all pins
curl -X POST "http://127.0.0.1:5001/api/v0/pin/verify" | jq .

# Verify with verbose output
curl -X POST "http://127.0.0.1:5001/api/v0/pin/verify?verbose=true" | jq .
```

---

## S3 Integration

### Converting CID to S3 Object Name

```bash
# Get S3 object name from CID
S3_NAME=$(curl -s -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=QmCID...&f=%25M&b=base32upper" | jq -r .Formatted)
echo $S3_NAME
```

**Example:**
```bash
curl -s -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=QmQMmrmh3sUn2zvtPUqrLqSmPkT5LDJJqCaARn34UbRemV&f=%25M&b=base32upper" | jq -r .Formatted
# Output: CIQB4AIJ3NWQ5G2Y4GHBRMUBMZBMW7CN44UV3MC2NYGRXFQPJZV6RSA
```

### Verifying S3 Storage

**After adding content:**

```bash
# 1. Add file
RESPONSE=$(echo "test content" | curl -s -X POST -F "file=@-" "http://127.0.0.1:5001/api/v0/add?quieter=true")
CID=$(echo $RESPONSE | jq -r .Hash)

# 2. Convert to S3 name
S3_NAME=$(curl -s -X POST "http://127.0.0.1:5001/api/v0/cid/format?arg=$CID&f=%25M&b=base32upper" | jq -r .Formatted)

# 3. Verify in S3
aws s3 ls s3://your-bucket-name/$S3_NAME
```

### Workflow: Add and Verify

**Complete workflow:**

```bash
#!/bin/bash

API_URL="http://127.0.0.1:5001/api/v0"
BUCKET="your-bucket-name"

# 1. Add file
echo "API test content" > test.txt
ADD_RESPONSE=$(curl -s -X POST -F "file=@test.txt" "$API_URL/add?quieter=true")
CID=$(echo $ADD_RESPONSE | jq -r .Hash)
echo "Added with CID: $CID"

# 2. Get S3 object name
S3_NAME=$(curl -s -X POST "$API_URL/cid/format?arg=$CID&f=%25M&b=base32upper" | jq -r .Formatted)
echo "S3 object name: $S3_NAME"

# 3. Verify in S3
if aws s3 ls "s3://$BUCKET/$S3_NAME" > /dev/null 2>&1; then
    echo "✓ Object found in S3"
    aws s3 ls "s3://$BUCKET/$S3_NAME"
else
    echo "✗ Object not found in S3"
fi

# 4. Verify via IPFS
CONTENT=$(curl -s -X POST "$API_URL/cat?arg=$CID")
echo "Retrieved content: $CONTENT"
```

---

## Repository Management

### Repository Statistics

**Endpoint:** `POST /api/v0/repo/stat`

```bash
curl -X POST "http://127.0.0.1:5001/api/v0/repo/stat" | jq .
```

**Response:**
```json
{
  "RepoSize": 75064,
  "StorageMax": 10000000000,
  "NumObjects": 409,
  "RepoPath": "/Users/chim/.ipfs",
  "Version": "fs-repo@18"
}
```

### Garbage Collection

**Endpoint:** `POST /api/v0/repo/gc`

```bash
# Run garbage collection
curl -X POST "http://127.0.0.1:5001/api/v0/repo/gc"

# With streaming errors
curl -X POST "http://127.0.0.1:5001/api/v0/repo/gc?stream-errors=true"
```

**Response:**
```json
{"Key":{"/":"QmUnpinnedCID..."},"Error":""}
```

### List Local References

**Endpoint:** `POST /api/v0/refs/local`

```bash
# List all local blocks
curl -X POST "http://127.0.0.1:5001/api/v0/refs/local"

# Count local blocks
curl -X POST "http://127.0.0.1:5001/api/v0/refs/local" | wc -l
```

### Repository Version

**Endpoint:** `POST /api/v0/repo/version`

```bash
curl -X POST "http://127.0.0.1:5001/api/v0/repo/version" | jq .
```

**Response:**
```json
{
  "Version": "18"
}
```

---

## Common Workflows

### Workflow 1: Upload and Organize in MFS

```bash
API_URL="http://127.0.0.1:5001/api/v0"

# 1. Create project structure in MFS
curl -X POST "$API_URL/files/mkdir?arg=/myproject&parents=true"
curl -X POST "$API_URL/files/mkdir?arg=/myproject/src&parents=true"
curl -X POST "$API_URL/files/mkdir?arg=/myproject/docs&parents=true"

# 2. Upload files
echo "main code" | curl -X POST -F "file=@-" "$API_URL/add?quieter=true" | \
  jq -r .Hash | \
  xargs -I {} curl -X POST "$API_URL/files/cp?arg=/ipfs/{}&arg=/myproject/src/main.py"

echo "documentation" | curl -X POST -F "file=@-" "$API_URL/add?quieter=true" | \
  jq -r .Hash | \
  xargs -I {} curl -X POST "$API_URL/files/cp?arg=/ipfs/{}&arg=/myproject/docs/README.md"

# 3. Get MFS root CID
PROJECT_CID=$(curl -s -X POST "$API_URL/files/stat?arg=/myproject" | jq -r .Hash)
echo "Project CID: $PROJECT_CID"

# 4. Pin the snapshot
curl -X POST "$API_URL/pin/add?arg=$PROJECT_CID"
```

### Workflow 2: Versioning with API

```bash
API_URL="http://127.0.0.1:5001/api/v0"

# Version 1
echo "shared content" > shared.txt
echo "v1 specific" > version.txt

# Upload v1
V1_RESPONSE=$(curl -s -X POST \
  -F "file=@shared.txt" \
  -F "file=@version.txt" \
  "$API_URL/add?wrap-with-directory=true")
V1_CID=$(echo $V1_RESPONSE | jq -r '.[-1].Hash')

# Version 2 (reuses shared.txt)
echo "v2 specific" > version.txt
echo "new file" > new.txt

V2_RESPONSE=$(curl -s -X POST \
  -F "file=@shared.txt" \
  -F "file=@version.txt" \
  -F "file=@new.txt" \
  "$API_URL/add?wrap-with-directory=true")
V2_CID=$(echo $V2_RESPONSE | jq -r '.[-1].Hash')

# Organize in MFS
curl -X POST "$API_URL/files/mkdir?arg=/versions&parents=true"
curl -X POST "$API_URL/files/cp?arg=/ipfs/$V1_CID&arg=/versions/v1"
curl -X POST "$API_URL/files/cp?arg=/ipfs/$V2_CID&arg=/versions/v2"

# Pin both versions
curl -X POST "$API_URL/pin/add?arg=$V1_CID"
curl -X POST "$API_URL/pin/add?arg=$V2_CID"
```

### Workflow 3: Batch Upload with Metadata Tracking

```bash
#!/bin/bash

API_URL="http://127.0.0.1:5001/api/v0"
MANIFEST_FILE="upload_manifest.json"

# Initialize manifest
echo "[]" > $MANIFEST_FILE

# Upload multiple files
for file in *.txt; do
  # Upload file
  RESPONSE=$(curl -s -X POST -F "file=@$file" "$API_URL/add?quieter=true")
  CID=$(echo $RESPONSE | jq -r .Hash)
  SIZE=$(echo $RESPONSE | jq -r .Size)

  # Get S3 name
  S3_NAME=$(curl -s -X POST "$API_URL/cid/format?arg=$CID&f=%25M&b=base32upper" | jq -r .Formatted)

  # Add to manifest
  jq --arg file "$file" --arg cid "$CID" --arg size "$SIZE" --arg s3 "$S3_NAME" \
    '. += [{"filename": $file, "cid": $cid, "size": $size, "s3_object": $s3}]' \
    $MANIFEST_FILE > tmp.$$ && mv tmp.$$ $MANIFEST_FILE

  echo "Uploaded: $file -> $CID"
done

# Upload manifest itself
MANIFEST_CID=$(curl -s -X POST -F "file=@$MANIFEST_FILE" "$API_URL/add?quieter=true" | jq -r .Hash)
echo "Manifest CID: $MANIFEST_CID"

# Pin manifest
curl -X POST "$API_URL/pin/add?arg=$MANIFEST_CID"
```

---

## Quick Reference

### Essential API Endpoints

```bash
# Base URL
API="http://127.0.0.1:5001/api/v0"

# VERSION & STATUS
curl -X POST "$API/version"
curl -X POST "$API/repo/stat"

# ADD CONTENT
curl -X POST -F "file=@file.txt" "$API/add"
curl -X POST -F "file=@file.txt" "$API/add?pin=false"
curl -X POST -F "file=@file.txt" "$API/add?cid-version=1"

# RETRIEVE CONTENT
curl -X POST "$API/cat?arg=QmCID..."
curl -X POST "$API/get?arg=QmCID..."

# DIRECTORIES
curl -X POST "$API/ls?arg=QmCID..."
curl -X POST -F "file=@f1.txt" -F "file=@f2.txt" "$API/add?wrap-with-directory=true"

# MFS
curl -X POST "$API/files/ls?arg=/"
curl -X POST "$API/files/mkdir?arg=/dir&parents=true"
curl -X POST "$API/files/cp?arg=/ipfs/QmCID...&arg=/path"
curl -X POST "$API/files/mv?arg=/old&arg=/new"
curl -X POST "$API/files/rm?arg=/path&recursive=true"
curl -X POST "$API/files/read?arg=/path"
curl -X POST -F "file=@-" "$API/files/write?arg=/path&create=true"
curl -X POST "$API/files/stat?arg=/"
curl -X POST "$API/files/flush?arg=/"

# DAG OPERATIONS
curl -X POST "$API/dag/get?arg=QmCID..."
curl -X POST "$API/dag/stat?arg=QmCID..."
curl -X POST "$API/dag/resolve?arg=/ipfs/QmCID/path"

# NAVIGATION
curl -X POST "$API/refs?arg=QmCID..."
curl -X POST "$API/refs?arg=QmCID...&recursive=true"
curl -X POST "$API/refs/local"

# CID OPERATIONS
curl -X POST "$API/cid/base32?arg=QmCID..."
curl -X POST "$API/cid/format?arg=QmCID...&v=1"
curl -X POST "$API/cid/format?arg=QmCID...&f=%25M&b=base32upper"

# PINNING
curl -X POST "$API/pin/add?arg=QmCID..."
curl -X POST "$API/pin/rm?arg=QmCID..."
curl -X POST "$API/pin/ls?type=recursive"
curl -X POST "$API/pin/update?arg=QmOld&arg=QmNew"
curl -X POST "$API/pin/verify"

# REPOSITORY
curl -X POST "$API/repo/stat"
curl -X POST "$API/repo/gc"
curl -X POST "$API/repo/version"

# BLOCK OPERATIONS
curl -X POST "$API/block/stat?arg=QmCID..."
curl -X POST "$API/block/get?arg=QmCID..."
```

### Common Query Parameters

| Parameter | Endpoints | Description |
|-----------|-----------|-------------|
| `arg` | Most | Primary argument (CID, path, etc.) |
| `quieter` | add | Only show final output |
| `progress` | add, pin | Show progress |
| `recursive` | refs, pin, files/rm | Recursive operation |
| `pin` | add | Pin added content |
| `cid-version` | add, files | CID version (0 or 1) |
| `only-hash` | add | Only compute hash |
| `wrap-with-directory` | add | Wrap files in directory |
| `chunker` | add | Chunking algorithm |
| `long` | files/ls | Show detailed info |
| `parents` | files/mkdir, files/write | Create parents |
| `create` | files/write | Create if missing |
| `truncate` | files/write | Truncate before write |
| `flush` | files/* | Flush after operation |

---

## Security & Best Practices

### Security Warnings

**⚠️ CRITICAL: NEVER EXPOSE THE RPC API TO THE PUBLIC INTERNET**

The IPFS RPC API provides **administrative access** to your node:
- Can add/remove content
- Can modify MFS
- Can change pins
- Can execute arbitrary operations

### Access Control

**1. Bind to Localhost Only (Default)**

Check your config:
```bash
cat ~/.ipfs/config | jq '.Addresses.API'
# Should be: "/ip4/127.0.0.1/tcp/5001"
```

**2. API Access Control**

Configure allowed origins in `~/.ipfs/config`:

```json
{
  "API": {
    "HTTPHeaders": {
      "Access-Control-Allow-Origin": ["http://localhost:3000"],
      "Access-Control-Allow-Methods": ["POST"],
      "Access-Control-Allow-Headers": ["X-Requested-With"]
    }
  }
}
```

**3. Authentication**

Kubo doesn't have built-in authentication. Options:

**Option A: Reverse Proxy with Auth**
```nginx
location /api/v0/ {
    auth_basic "IPFS API";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://127.0.0.1:5001;
}
```

**Option B: API Gateway**
```javascript
// Express.js example
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Auth middleware
app.use('/ipfs-api', (req, res, next) => {
  const token = req.headers.authorization;
  if (token !== `Bearer ${process.env.API_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Proxy to IPFS
app.use('/ipfs-api', createProxyMiddleware({
  target: 'http://127.0.0.1:5001',
  pathRewrite: { '^/ipfs-api': '/api/v0' }
}));

app.listen(3000);
```

### Rate Limiting

**Nginx example:**
```nginx
limit_req_zone $binary_remote_addr zone=ipfs_api:10m rate=10r/s;

location /api/v0/ {
    limit_req zone=ipfs_api burst=20;
    proxy_pass http://127.0.0.1:5001;
}
```

### CORS Configuration

For web applications, configure CORS in `~/.ipfs/config`:

```json
{
  "API": {
    "HTTPHeaders": {
      "Access-Control-Allow-Origin": [
        "http://localhost:3000",
        "https://yourdomain.com"
      ],
      "Access-Control-Allow-Methods": ["POST", "GET"],
      "Access-Control-Allow-Headers": [
        "X-Requested-With",
        "Content-Type",
        "Authorization"
      ],
      "Access-Control-Expose-Headers": ["Location"],
      "Access-Control-Allow-Credentials": ["true"]
    }
  }
}
```

### Best Practices

**1. Use HTTPS in Production**
```bash
# Behind reverse proxy with SSL
https://yourdomain.com/ipfs-api -> http://127.0.0.1:5001
```

**2. Validate Input**
```javascript
// Validate CIDs before passing to API
const CID = require('cids');

function isValidCID(cidString) {
  try {
    new CID(cidString);
    return true;
  } catch (e) {
    return false;
  }
}
```

**3. Handle Large Files**
```bash
# Stream large files instead of loading into memory
curl -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmLargeCID..." --output large.bin
```

**4. Error Handling**
```javascript
async function ipfsAdd(file) {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('http://127.0.0.1:5001/api/v0/add', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.Message || 'Upload failed');
    }

    return await response.json();
  } catch (error) {
    console.error('IPFS add failed:', error);
    throw error;
  }
}
```

**5. Timeout Configuration**
```javascript
// Set reasonable timeouts for large operations
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60000); // 60s

try {
  const response = await fetch('http://127.0.0.1:5001/api/v0/add', {
    method: 'POST',
    body: formData,
    signal: controller.signal
  });
} finally {
  clearTimeout(timeout);
}
```

---

## Language-Specific Examples

### JavaScript/Node.js

**Using fetch:**

```javascript
const FormData = require('form-data');
const fetch = require('node-fetch');
const fs = require('fs');

const IPFS_API = 'http://127.0.0.1:5001/api/v0';

// Add file
async function addFile(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));

  const response = await fetch(`${IPFS_API}/add`, {
    method: 'POST',
    body: formData
  });

  const data = await response.json();
  return data.Hash;
}

// Cat file
async function catFile(cid) {
  const response = await fetch(`${IPFS_API}/cat?arg=${cid}`, {
    method: 'POST'
  });

  return await response.text();
}

// List MFS directory
async function listMFS(path = '/') {
  const response = await fetch(`${IPFS_API}/files/ls?arg=${path}&long=true`, {
    method: 'POST'
  });

  const data = await response.json();
  return data.Entries;
}

// Pin CID
async function pinAdd(cid) {
  const response = await fetch(`${IPFS_API}/pin/add?arg=${cid}`, {
    method: 'POST'
  });

  const data = await response.json();
  return data.Pins;
}

// Usage
(async () => {
  const cid = await addFile('./test.txt');
  console.log('Added:', cid);

  const content = await catFile(cid);
  console.log('Content:', content);

  await pinAdd(cid);
  console.log('Pinned:', cid);
})();
```

**Using ipfs-http-client:**

```javascript
const { create } = require('ipfs-http-client');

const client = create({ url: 'http://127.0.0.1:5001' });

async function example() {
  // Add file
  const { cid } = await client.add('Hello World!');
  console.log('CID:', cid.toString());

  // Cat file
  const stream = client.cat(cid);
  let content = '';
  for await (const chunk of stream) {
    content += chunk.toString();
  }
  console.log('Content:', content);

  // List pins
  for await (const pin of client.pin.ls()) {
    console.log(pin);
  }
}

example();
```

### Python

**Using requests:**

```python
import requests
import json

IPFS_API = "http://127.0.0.1:5001/api/v0"

def add_file(file_path):
    """Add file to IPFS"""
    with open(file_path, 'rb') as f:
        files = {'file': f}
        response = requests.post(f"{IPFS_API}/add", files=files)
        return response.json()['Hash']

def cat_file(cid):
    """Retrieve file content"""
    response = requests.post(f"{IPFS_API}/cat", params={'arg': cid})
    return response.text

def list_mfs(path='/'):
    """List MFS directory"""
    params = {'arg': path, 'long': 'true'}
    response = requests.post(f"{IPFS_API}/files/ls", params=params)
    return response.json()['Entries']

def pin_add(cid):
    """Pin CID"""
    response = requests.post(f"{IPFS_API}/pin/add", params={'arg': cid})
    return response.json()['Pins']

def dag_get(cid):
    """Get DAG node"""
    response = requests.post(f"{IPFS_API}/dag/get", params={'arg': cid})
    return response.json()

# Usage
if __name__ == '__main__':
    # Add file
    cid = add_file('test.txt')
    print(f"Added: {cid}")

    # Retrieve content
    content = cat_file(cid)
    print(f"Content: {content}")

    # Pin
    pins = pin_add(cid)
    print(f"Pinned: {pins}")

    # List MFS
    entries = list_mfs('/')
    for entry in entries:
        print(f"{entry['Name']}: {entry['Hash']}")
```

### Go

**Using go-ipfs-http-client:**

```go
package main

import (
    "context"
    "fmt"
    "io"
    "strings"

    ipfs "github.com/ipfs/go-ipfs-api"
)

func main() {
    // Connect to local node
    sh := ipfs.NewShell("http://127.0.0.1:5001")

    // Add string
    cid, err := sh.Add(strings.NewReader("Hello World!"))
    if err != nil {
        panic(err)
    }
    fmt.Printf("Added: %s\n", cid)

    // Cat file
    reader, err := sh.Cat(cid)
    if err != nil {
        panic(err)
    }
    content, _ := io.ReadAll(reader)
    fmt.Printf("Content: %s\n", content)

    // Pin
    err = sh.Pin(cid)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Pinned: %s\n", cid)

    // List pins
    pins, err := sh.Pins()
    if err != nil {
        panic(err)
    }
    for pin := range pins {
        fmt.Printf("Pin: %s\n", pin)
    }
}
```

### cURL Wrapper (Bash)

**Complete helper script:**

```bash
#!/bin/bash

IPFS_API="http://127.0.0.1:5001/api/v0"

# Add file
ipfs_add() {
    local file=$1
    curl -s -X POST -F "file=@$file" "$IPFS_API/add?quieter=true" | jq -r .Hash
}

# Cat file
ipfs_cat() {
    local cid=$1
    curl -s -X POST "$IPFS_API/cat?arg=$cid"
}

# Pin add
ipfs_pin() {
    local cid=$1
    curl -s -X POST "$IPFS_API/pin/add?arg=$cid" | jq -r .Pins[0]
}

# MFS ls
ipfs_mfs_ls() {
    local path=${1:-"/"}
    curl -s -X POST "$IPFS_API/files/ls?arg=$path&long=true" | jq -r '.Entries[] | "\(.Name)\t\(.Hash)"'
}

# Get S3 object name
ipfs_to_s3() {
    local cid=$1
    curl -s -X POST "$IPFS_API/cid/format?arg=$cid&f=%25M&b=base32upper" | jq -r .Formatted
}

# Usage
CID=$(ipfs_add "test.txt")
echo "Added: $CID"

CONTENT=$(ipfs_cat "$CID")
echo "Content: $CONTENT"

PIN=$(ipfs_pin "$CID")
echo "Pinned: $PIN"

S3_NAME=$(ipfs_to_s3 "$CID")
echo "S3 object: $S3_NAME"
```

---

## Appendix: Error Responses

**Common Error Format:**

```json
{
  "Message": "error message here",
  "Code": 0,
  "Type": "error"
}
```

**Common Errors:**

| HTTP Status | Message | Cause |
|-------------|---------|-------|
| 400 | `invalid path` | Malformed CID or path |
| 404 | `block not found` | CID doesn't exist locally |
| 500 | `context deadline exceeded` | Operation timeout |
| 500 | `merkledag: not found` | Missing DAG node |

**Error Handling Example:**

```bash
# Check HTTP status
HTTP_STATUS=$(curl -s -w "%{http_code}" -o /tmp/response.json \
  -X POST "http://127.0.0.1:5001/api/v0/cat?arg=QmInvalidCID...")

if [ "$HTTP_STATUS" -eq 200 ]; then
    cat /tmp/response.json
else
    echo "Error (HTTP $HTTP_STATUS):"
    jq . /tmp/response.json
fi
```

---

## Additional Resources

**Official Documentation:**
- IPFS HTTP API Reference: https://docs.ipfs.tech/reference/kubo/rpc/
- Kubo GitHub: https://github.com/ipfs/kubo
- go-ipfs-http-client: https://github.com/ipfs/go-ipfs-http-client

**S3 Datastore:**
- go-ds-s3: https://github.com/ipfs/go-ds-s3

**Community:**
- IPFS Forum: https://discuss.ipfs.tech/
- Discord: https://discord.gg/ipfs

---

**Last Updated:** 2025-10-07
**Tested Against:** Kubo 0.39.0-dev with S3 datastore
