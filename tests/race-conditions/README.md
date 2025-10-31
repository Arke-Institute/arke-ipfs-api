# Race Condition Test Suite

Comprehensive distributed systems testing for atomic CAS (Compare-And-Swap) operations in the Arke IPFS API.

## Purpose

This test suite attempts to break the API's atomic CAS implementation by simulating concurrent operations that would cause data loss without proper race condition protection. It validates that:

1. **Concurrent component updates** don't overwrite each other
2. **Concurrent relation updates** preserve all children
3. **Concurrent entity creation** with same parent registers all children
4. **Mixed chaotic operations** maintain data integrity
5. **Extreme stress** scenarios don't cause data loss

## Quick Start

### Install Dependencies

```bash
npm install
```

### Run Tests Against Localhost

Start the dev server in one terminal:
```bash
npm run dev
```

Run the race condition tests in another terminal:
```bash
npm run test:race
```

### Run Tests Against Production

```bash
API_ENDPOINT=https://api.arke.institute npm run test:race
```

### Run Stress Tests (100+ concurrent operations)

```bash
npm run test:race:stress
```

## Test Scenarios

### Test 1: Concurrent Component Updates

**Scenario:** Multiple OCR operations updating different components simultaneously

**What it tests:**
- Create entity with N placeholder components
- Launch N concurrent `appendVersion` operations, each updating a different component
- All operations use the same `expect_tip` (simulating race condition)
- Verify ALL updates are preserved in final version

**Expected behavior:**
- First operation writes v2
- Subsequent operations detect race, retry, merge changes
- Final version has all N component updates

**Concurrency levels tested:** 2, 5, 10, 20

### Test 2: Concurrent Relation Adds

**Scenario:** Multiple `POST /relations` calls adding different children

**What it tests:**
- Create parent and N child entities
- Launch N concurrent `updateRelations` operations, each adding one child
- All operations use parent's initial tip
- Verify all children in parent's `children_pi` array

**Expected behavior:**
- Atomic CAS ensures all children are added
- No children lost due to overwrite races

**Concurrency levels tested:** 5, 10, 20

### Test 3: Concurrent Entity Creation with Parent

**Scenario:** Multiple `POST /entities` with same `parent_pi`

**What it tests:**
- Create parent entity
- Launch N concurrent entity creations, all with same `parent_pi`
- Parent auto-update logic must handle concurrent updates
- Verify all created entities in parent's `children_pi`

**Expected behavior:**
- Parent entity gets updated N times (or fewer with merging)
- All created children registered in parent

**Concurrency levels tested:** 5, 10, 20

### Test 4: Chaos Test (Mixed Operations)

**Scenario:** Random mix of component updates, relation adds, and relation removes

**What it tests:**
- Entity survives chaotic concurrent operations
- No data corruption
- Final state is valid

**Expected behavior:**
- Entity remains in valid state
- Version number increases appropriately

### Test 5: Extreme Stress Test

**Scenario:** 100 concurrent component updates in batches

**What it tests:**
- System stability under extreme load
- Rate limiting behavior
- Data integrity at scale

**Expected behavior:**
- At least 95% success rate
- No complete failures
- Entity remains queryable

## Understanding the Results

### Success Criteria

✅ **PASS**: All concurrent operations preserved, no data loss

Example:
```
✅ PASS: All 10 concurrent component updates preserved (final version: v11)
```

### Failure Scenarios

❌ **FAIL**: Missing updates indicate race condition bug

Example:
```
❌ FAIL: Missing updates for components: 3, 7 (final version: v9)
```

This would indicate that operations 3 and 7 were overwritten by concurrent operations.

### Interpreting Version Numbers

- **Ideal:** Final version = initial version + number of operations
- **Acceptable:** Final version ≥ number of operations (due to retries creating extra versions)
- **Warning:** Final version < number of operations (indicates some retries failed)

Example for 10 concurrent operations starting at v1:
- ✅ **Perfect:** v11 (all operations succeeded on first try)
- ✅ **Good:** v13 (some retries, but all data preserved)
- ⚠️ **Warning:** v9 (some operations may have failed)

## Common Issues

### Rate Limiting

If you see many failures with high concurrency:
- Reduce concurrency levels in the test
- Add delays between batches
- Check Cloudflare Workers rate limits

### Timeout Errors

If operations timeout:
- Check IPFS node performance
- Verify network connectivity
- Reduce batch sizes in extreme stress test

### CAS Failures

If you see 409 CAS_FAILURE errors:
- This is expected behavior for client-provided stale `expect_tip`
- Internal races should be handled by server-side retry
- Check server logs for `TipWriteRaceError` detection

## Environment Variables

- `API_ENDPOINT` - API base URL (default: `http://localhost:8787`)
- `RUN_STRESS` - Enable extreme stress test (default: `false`)

## Interpreting Server Logs

Look for these log messages indicating atomic CAS is working:

```
[CAS] Tip write race detected for <PI>, retrying in 52ms (attempt 2/3)
[TIP] Atomic write verified for <PI>: <old-cid> → <new-cid>
[RELATION] Parent update race detected for <PI>, retrying...
```

## What to Do if Tests Fail

1. **Check server logs** for `TipWriteRaceError` - should see retries
2. **Verify `writeTipAtomic`** is being used (not `writeTip`)
3. **Check retry wrappers** in handlers (appendVersionHandler, updateRelationsHandler)
4. **Increase retry attempts** if transient network issues
5. **File bug report** with test output and server logs

## Running Against Different Environments

### Local Development
```bash
npm run dev  # In one terminal
npm run test:race  # In another terminal
```

### Staging
```bash
API_ENDPOINT=https://staging-api.arke.institute npm run test:race
```

### Production (use with caution!)
```bash
API_ENDPOINT=https://api.arke.institute npm run test:race
```

⚠️ **Warning:** These tests create many entities. Use test environments when possible!

## Performance Benchmarks

Expected performance on typical setup:

- **10 concurrent operations**: ~500-1000ms
- **20 concurrent operations**: ~1000-2000ms
- **50 concurrent operations**: ~3000-5000ms
- **100 concurrent operations**: ~10000-20000ms (batched)

Actual times depend on:
- IPFS node performance
- Network latency
- Cloudflare Workers CPU limits
- Number of retries triggered

## Contributing

To add new test scenarios:

1. Create new test function following the pattern
2. Add to `runAllTests()` in main suite
3. Document expected behavior in this README
4. Update success criteria

## License

See main project LICENSE.
