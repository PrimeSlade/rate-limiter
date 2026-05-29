---
proposal: PROP-0002
status: APPROVED
---

# Tech Spec 0002: Leaky Bucket Algorithm

## ADR-002: Leaky Bucket — Fill-Level Hash Design
**Status**: accepted
**Context**: Token Bucket (ADR-001) is implemented and permits bursts up to `capacity` tokens. Idle clients can accumulate refill credit and spend it in a sudden burst, which is unacceptable for workloads — SMS gateways, payment pipelines, metered third-party APIs — that require a strictly constant outflow rate. A second algorithm is needed whose long-run throughput ceiling is absolute, not statistical. Two Redis representations were evaluated: Option A (GCRA virtual schedule, single string `next_allowed_ms`) and Option B (fill-level hash, `water` + `last_leak_ms`). Option A cannot produce an accurate `X-RateLimit-Remaining` count without adding a second field, at which point its simplicity advantage disappears and the `capacity` parameter becomes meaningless. Option B mirrors the Token Bucket hash structure exactly, produces an exact `remaining` count directly from `capacity - new_water`, and gives `capacity` a concrete physical meaning as bucket volume.
**Decision**: Implement Option B (fill-level hash) with fields `water` and `last_leak_ms`, sourcing elapsed time from `redis.call('TIME')` exclusively. No write occurs on the deny path. Key namespace uses the `lb:` sub-prefix to prevent collision with Token Bucket keys.
**Consequences**: Hard throughput ceiling enforced at the drain rate regardless of traffic pattern. Accurate `X-RateLimit-Remaining` on every code path. Zero clock-skew exposure because all elapsed-time arithmetic uses Redis-internal timestamps. O(1) Redis memory per key (~90–110 bytes), within 10% of Token Bucket. Structural consistency with ADR-001 minimises the algorithm-engineer review surface.

---

## 1. File Map

| File | Action | Description |
|------|--------|-------------|
| `src/algorithms/leaky-bucket.ts` | Create | `LeakyBucket` class; embeds `LUA_SCRIPT` as a template-literal constant; exports both |
| `src/algorithms/index.ts` | Modify | Add re-exports for `LeakyBucket` and `LeakyBucketOpts` alongside existing `TokenBucket` exports |
| `config/rules.yaml` | Modify | Add an example `leaky_bucket` domain stanza; existing `token_bucket` stanzas are unchanged |
| `tests/algorithms/leaky-bucket.test.ts` | Create | Integration tests against real Redis via `@testcontainers/redis` |

No other existing files require modification to implement this algorithm. The middleware (`src/middleware/`) and rule resolver (`src/rules/`) will consume `LeakyBucket` in separate work items.

---

## 2. TypeScript Interface

### `LeakyBucketOpts`

```typescript
interface LeakyBucketOpts {
  /**
   * Maximum fill level of the bucket in units (one unit = one request).
   * Also the burst ceiling on a cold start (an empty bucket absorbs up to
   * `capacity` requests before any are rejected).
   * Must be a positive integer.
   */
  capacity: number

  /**
   * Units drained per second.
   * The rule resolver converts this to units/ms before passing to the Lua script.
   * Must be a positive number.
   */
  drainRate: number

  /**
   * Drain tick period in milliseconds.
   * Optional — defaults to 1000 ms (i.e., drainRate is interpreted as units/second).
   * The resolver uses this only to derive drain_rate_per_ms = drainRate / drainIntervalMs.
   */
  drainIntervalMs?: number
}
```

### `LeakyBucket` class

```typescript
class LeakyBucket {
  constructor(opts: LeakyBucketOpts)

  /**
   * Evaluate whether the request identified by `key` is allowed.
   *
   * Internally:
   *   1. Ensures the Lua script SHA is loaded via loadScript().
   *   2. Calls evalScript(sha, LUA_SCRIPT, [key], [capacity, drainRatePerMs]).
   *   3. Maps the flat [allowed, remaining, reset_at_ms] tuple to the return object.
   *
   * Unlike TokenBucket.check(), no `nowMs` argument is accepted. The application
   * clock plays no role in Leaky Bucket arithmetic; redis.call('TIME') is the
   * sole clock source. ARGV carries only algorithm parameters, not timestamps.
   */
  check(key: string): Promise<{
    allowed: boolean
    remaining: number
    resetAtMs: number
  }>
}
```

### `LUA_SCRIPT` constant

```typescript
// Exported constant — the inline Lua script as a template literal string.
// Type: string
export const LUA_SCRIPT: string
```

The SHA of `LUA_SCRIPT` is obtained once via `loadScript('leaky-bucket', LUA_SCRIPT)` and cached in the store-layer `scriptCache` map. Subsequent calls use `evalScript` which handles `NOSCRIPT` reloads transparently.

---

## 3. ARGV Layout

The Lua script receives exactly two ARGV positions:

| Position | Value | Type | Unit | Notes |
|----------|-------|------|------|-------|
| `ARGV[1]` | `capacity` | integer | units | Maximum bucket volume and burst ceiling on cold start. Passed as a whole number string. |
| `ARGV[2]` | `drain_rate_per_ms` | float | units / ms | Derived by the rule resolver: `drainRate / drainIntervalMs`. For a rule with `drain_rate: 10` units/sec and default `drain_interval_ms: 1000`, this value is `0.01`. Passed as a decimal string, e.g., `"0.01"`. |

`now_ms` is **not** passed as an ARGV argument. The Leaky Bucket Lua script sources time exclusively from `redis.call('TIME')`. No application-side timestamp has any use in the drain arithmetic, so `ARGV` carries only algorithm parameters. This is a deliberate simplification relative to Token Bucket, which passed `now_ms` as `ARGV[3]` for observability. Leaky Bucket sets the precedent that ARGV carries only parameters needed for rate-enforcement computation.

`KEYS[1]` is the full rate-limit Redis key (see Section 5).

---

## 4. Lua Script Pseudocode

The following pseudocode is authoritative for the implementation. Line-by-line comments explain every decision. The implementer must translate this directly into the `LUA_SCRIPT` template literal inside `src/algorithms/leaky-bucket.ts`.

```
-- Parse ARGV
local capacity         = tonumber(ARGV[1])
local drain_rate_per_ms = tonumber(ARGV[2])

-- Step 1: Obtain authoritative time from Redis.
-- redis.call('TIME') returns {seconds, microseconds} as a two-element array.
-- Convert to milliseconds: seconds * 1000 + floor(microseconds / 1000).
-- This is the ONLY source of time used for all arithmetic.
-- No application clock is involved at any point in this script.
local t          = redis.call('TIME')
local now_ms     = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- Compute TTL for any write operation.
-- A full bucket (water = capacity) drains to zero in exactly
-- (capacity / drain_rate_per_ms) ms. This is the maximum time any key
-- can remain relevant; idle keys expire within one full drain cycle.
local ttl_ms = math.ceil(capacity / drain_rate_per_ms)

-- Step 2: Read existing bucket state.
local data = redis.call('HGETALL', KEYS[1])

-- HGETALL returns a flat array: {field1, val1, field2, val2, ...}.
-- An empty array means the key does not exist (first request from this client).

-- Step 3: Handle fresh key (key does not exist).
if #data == 0 then
    -- First request into an empty bucket: water goes from 0 to 1.
    -- An empty bucket is always below capacity, so the request is always allowed.
    -- Write initial state and start the drain clock at now_ms.
    redis.call('HSET', KEYS[1],
        'water',        '1',
        'last_leak_ms', tostring(now_ms))
    redis.call('PEXPIRE', KEYS[1], ttl_ms)

    -- reset_at_ms: time at which water level 1 will have drained to zero,
    -- i.e., when the client will next have full headroom.
    -- ceil(1 / drain_rate_per_ms) is the time for one unit to drain out.
    local reset_at_ms = now_ms + math.ceil(1 / drain_rate_per_ms)

    -- Return: allowed=1, remaining=capacity-1 (bucket absorbed one unit),
    -- reset_at_ms is when the bucket will be fully empty again.
    return {1, capacity - 1, reset_at_ms}
end

-- Step 4: Parse existing hash fields into local variables.
-- HGETALL returns fields in an unspecified order; iterate the flat array.
local stored_water   = nil
local last_leak_ms   = nil
for i = 1, #data, 2 do
    if data[i] == 'water' then
        stored_water  = tonumber(data[i + 1])
    elseif data[i] == 'last_leak_ms' then
        last_leak_ms  = tonumber(data[i + 1])
    end
end

-- Step 5: Compute elapsed time since the bucket state was last written.
local elapsed_ms = now_ms - last_leak_ms

-- Step 6: Guard against clock rollback.
-- If Redis's TIME returns a value earlier than the stored last_leak_ms
-- (which should not happen on a healthy Redis but is theoretically possible
-- after a restoration from snapshot or NTP correction), elapsed_ms would be
-- negative, which would increase the water level rather than drain it.
-- Clamp to zero: a negative elapsed time is treated as no time passing.
if elapsed_ms < 0 then
    elapsed_ms = 0
end

-- Step 7: Compute how much water has drained since the last write.
-- Water drains continuously at drain_rate_per_ms units per millisecond.
-- Floor the result at zero: the bucket cannot drain below empty.
local leaked         = elapsed_ms * drain_rate_per_ms
local current_water  = math.max(0, stored_water - leaked)

-- Step 8: Deny path — adding one unit would overflow the bucket.
-- current_water + 1 > capacity means the bucket is too full.
-- Do NOT write to Redis on the deny path. Writing would reset last_leak_ms
-- and the TTL, increasing write volume under flood conditions without any
-- correctness benefit. The bucket state is unchanged by a rejected request.
if current_water + 1 > capacity then
    -- reset_at_ms: earliest time at which the water level will have drained
    -- enough to accept one more unit.
    -- (current_water + 1 - capacity) is the excess water that must drain first.
    -- Dividing by drain_rate_per_ms gives the wait in ms.
    local reset_at_ms = now_ms + math.ceil((current_water + 1 - capacity) / drain_rate_per_ms)

    -- Return: allowed=0, remaining=0, reset_at_ms.
    return {0, 0, reset_at_ms}
end

-- Step 9: Allow path — add one unit of water.
local new_water = current_water + 1

-- Step 10: Write updated state to Redis.
-- Store the new fill level and the current Redis time as the new drain baseline.
-- Reset the TTL so the key stays alive for at least one more full drain cycle.
redis.call('HSET', KEYS[1],
    'water',        tostring(new_water),
    'last_leak_ms', tostring(now_ms))
redis.call('PEXPIRE', KEYS[1], ttl_ms)

-- Step 11: Compute reset_at_ms for the allow path.
-- This is the time at which the current new_water level will have fully drained
-- to zero — i.e., when the client will next have maximum headroom.
-- This is the conservative interpretation: "when is the rate limit fully reset"
-- rather than "when can the client make exactly one more request".
local reset_at_ms = now_ms + math.ceil(new_water / drain_rate_per_ms)

-- Return: allowed=1, remaining=floor(capacity - new_water),
-- floor() ensures the header value is a non-negative integer even when new_water
-- is a fractional float like 1.003 due to float string round-trip.
return {1, math.floor(capacity - new_water), reset_at_ms}
```

### Key invariants enforced by this script

- `redis.call('TIME')` is the single authoritative clock. No application timestamp enters the script at any point.
- No write occurs on the deny path. TTL is not reset. `last_leak_ms` and `water` are not updated when a request is rejected.
- `elapsed_ms` is clamped to zero if negative, preventing clock-rollback from artificially inflating the water level.
- `current_water` is floored at zero, preventing the bucket from draining to a negative level after long idle periods.
- `HSET` + `PEXPIRE` on the write path are two commands inside one atomic Lua call — no round-trip between them.
- The return tuple is always exactly three elements: `[allowed (0|1), remaining (integer), reset_at_ms (integer)]`.

---

## 5. Redis Key Pattern

### Pattern

```
ratelimit:lb:{domain}:{identifier}
```

### Examples

```
ratelimit:lb:sms_gateway:192.168.1.1
ratelimit:lb:sms_gateway:user-8472
ratelimit:lb:payments:10.0.0.5
```

`{domain}` is the logical service or rule group (matches the top-level key in `rules.yaml`).
`{identifier}` is the per-client discriminator, typically the remote IP address or an authenticated user ID, resolved by the middleware before calling `LeakyBucket.check()`.
The `lb:` sub-prefix prevents namespace collision with Token Bucket keys that share the same `{domain}` and `{identifier}`. This establishes the sub-prefix discriminator pattern for all algorithms going forward.

### Hash fields stored at this key

| Field | Value type | Example |
|-------|-----------|---------|
| `water` | float string | `"7.42"` |
| `last_leak_ms` | integer string | `"1747123456789"` |

### TTL formula

```
TTL = ceil(capacity / drain_rate_per_ms)  [milliseconds]
     = ceil(capacity / (drainRate / drainIntervalMs))
```

Set via `PEXPIRE` on every write (allow path only).

**Why this value.** A completely full bucket (`water = capacity`) takes exactly `capacity / drain_rate_per_ms` milliseconds to drain to empty. Setting the TTL to this ceiling means a key that receives no further traffic will expire at the precise moment it would have emptied. This is the tightest TTL that prevents stale keys from lingering beyond one full drain cycle while never expiring a key before it has returned to its neutral (empty) state.

**No TTL extension on denial.** Denied requests do not write, so the TTL is not reset during a flood. A key under sustained denial retains whatever TTL was set by the last allowed request and then expires. This is correct behaviour: a client being blocked has their bucket expire, giving them a cold-start reset, rather than being held in a permanently-denied state by endless TTL renewals on denied requests.

---

## 6. `rules.yaml` Schema

### Example stanza

```yaml
domains:
  sms_gateway:
    algorithm: leaky_bucket
    capacity: 10           # maximum bucket volume (units = requests)
    drain_rate: 2          # units drained per drain_interval_ms (default: per second)
    drain_interval_ms: 1000  # optional; default 1000 ms
    identifier: ip         # how to extract the client key: "ip" | "header:X-User-Id"
```

### Field reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `algorithm` | string | Yes | — | Must be `"leaky_bucket"` to select this algorithm. |
| `capacity` | positive integer | Yes | — | Maximum bucket volume in units. Equals the burst ceiling on a cold start. Passed as `ARGV[1]`. |
| `drain_rate` | positive number | Yes | — | Units drained per `drain_interval_ms`. Expressed in human-readable units/second when `drain_interval_ms` is omitted or 1000. The rule resolver computes `drain_rate_per_ms = drain_rate / drain_interval_ms` before passing to the algorithm. |
| `drain_interval_ms` | positive integer | No | `1000` | The denominator for `drain_rate`. Setting this to 500 with `drain_rate: 1` is equivalent to 2 units/second. |
| `identifier` | string | Yes | — | Strategy for extracting the per-client key from the request. `"ip"` uses the remote address. `"header:X-User-Id"` uses a named request header. |

### Rule resolver responsibility

The resolver reads `drain_rate` and `drain_interval_ms` from the YAML and computes:

```
drain_rate_per_ms = drain_rate / drain_interval_ms
```

This float is passed as `ARGV[2]`. The resolver must validate that `drain_rate_per_ms > 0` and that `capacity` is a positive integer before constructing `LeakyBucketOpts`. A zero or negative value for either must be rejected with a descriptive error at startup. The resolver is also responsible for prepending the `lb:` sub-prefix when constructing the Redis key passed to `LeakyBucket.check()`.

### Redis override mechanism

A Redis override key at `ratelimit:rules:{domain}` (serialised as JSON or YAML) takes precedence over `config/rules.yaml` at lookup time. The override must conform to the same schema above. The resolver merges field-by-field: any field present in the Redis override replaces the YAML value; absent fields fall back to YAML. The `algorithm` field in the override must match `"leaky_bucket"`; a mismatch between the YAML algorithm and the Redis override algorithm must be rejected with a descriptive error.

---

## 7. Test Plan

All tests in `tests/algorithms/leaky-bucket.test.ts` use a real Redis instance via `@testcontainers/redis`. No mocks. Each test creates a fresh container or flushes the database between cases to ensure isolation.

| Test name | Setup | Action | Expected result |
|-----------|-------|--------|-----------------|
| **First request — fresh key** | `capacity=5`, `drain_rate_per_ms=0.005` (5 units/sec). Key does not exist. | Call `check(key)` once. | `allowed=true`, `remaining=4`, `resetAtMs > now`. Key exists in Redis with `water="1"`, `last_leak_ms` set, TTL set to `ceil(5/0.005)=1000` ms. |
| **Sustained requests — capacity exhausted** | `capacity=3`, `drain_rate_per_ms=0.001`. Key does not exist. | Call `check(key)` 4 times in rapid succession (calls happen within <1 ms of each other, negligible drain). | First 3 calls: `allowed=true` with `remaining` 2, 1, 0. Fourth call: `allowed=false`, `remaining=0`, `resetAtMs > now`. |
| **Drain after wait — requests trickle through at drain rate** | `capacity=3`, `drain_rate_per_ms=0.005` (5 units/sec). Exhaust bucket to 0 remaining via 3 rapid calls. | Wait 200 ms (real sleep). Call `check(key)` again. | `allowed=true` (200 ms * 0.005 = 1 unit drained; bucket has room again). `remaining >= 0`. |
| **Flood deny path — no Redis writes on denied requests** | `capacity=2`, `drain_rate_per_ms=0.001`. Exhaust bucket via 2 calls. | Record PTTL and `last_leak_ms` from Redis. Send 100 denied requests in rapid succession. Re-read PTTL and `last_leak_ms`. | All 100 calls: `allowed=false`. PTTL after flood must not be greater than PTTL after exhaustion (no TTL extension on deny). `last_leak_ms` field must remain unchanged. `water` field must remain unchanged. |
| **Idle key expiry** | `capacity=5`, `drain_rate_per_ms=0.005`. Make one allowed request to create the key. | Wait `ceil(5/0.005)+50 = 1050` ms (one full drain cycle + 50 ms margin). Check if key exists. | Key no longer exists in Redis (`EXISTS` returns 0). |
| **Sustained overload — throughput never exceeds drain_rate** | `capacity=10`, `drain_rate_per_ms=0.01` (10 units/sec). | Fire 10 immediate requests (burst). Then fire 1 request per 100 ms for 5 intervals (each interval drains exactly 1 unit). | Burst: first 10 allowed, 11th denied. Sustained: each request after a 100 ms wait is allowed exactly once per interval. Total allowed in 500 ms sustained phase: 5. |
| **Clock rollback guard — negative elapsed time does not add water** | `capacity=5`, `drain_rate_per_ms=0.005`. Make one allowed request (`water=1`). Manually set `last_leak_ms` in Redis via `HSET` to `now_ms + 9999999` (a future timestamp, simulating clock rollback on the next call). | Call `check(key)` immediately. | `allowed=true` (elapsed_ms is clamped to 0; no leaked water computed; `current_water=1`; bucket not considered fuller than it was). `remaining=3` (capacity 5 minus new_water 2). |

### Helper notes for the test author

- Use real sleeps for all timing-sensitive assertions. `redis.call('TIME')` inside Lua cannot be mocked at the application level; `vi.setSystemTime` has no effect on the Redis clock.
- The "flood deny path" test must read raw TTL via `PTTL` and raw field values via `HGET` directly from Redis before and after the flood, not rely on application-level return values, to confirm no write occurred.
- The "clock rollback guard" test must set `last_leak_ms` directly with `HSET` after the initial `check()` call, bypassing the application layer, to inject a future timestamp.
- The "sustained overload" test must use real sleeps of exactly 100 ms between the sustained-phase requests; millisecond-level jitter from the test runner is acceptable because 100 ms * 0.01 units/ms = exactly 1 unit drained, and the assertion only checks `allowed=true` (not the exact `remaining` value) for each interval.

---

## 8. Out of Scope

The following topics are explicitly not covered by this spec. They may be addressed in future specs or separate work items.

- **Queuing / delaying requests**: The library rejects requests that exceed the drain rate. It does not delay or enqueue them until a slot opens. Queuing semantics are a fundamentally different deployment concern.
- **Variable drain rates per request**: All requests add exactly one unit of water. Consuming N units per call (weighted requests) is a future extension.
- **Other algorithms**: Fixed Window, Sliding Window Log, and Sliding Window Counter are separate implementations with their own specs.
- **Redis Cluster topology**: This spec targets a single Redis instance. Consistent hashing, cluster-aware key routing, and cross-shard atomicity are not addressed.
- **`tb:` key migration for Token Bucket**: Introducing `lb:` here creates an inconsistency — Token Bucket keys currently use no sub-prefix. Backfilling a `tb:` sub-prefix to Token Bucket is a separate work item and is acknowledged as a known gap until that migration is executed.
- **Integer micro-units for `water`**: `water` is stored as a float string and round-tripped through Lua's `tonumber()`. Sub-unit drift from repeated floating-point operations is acceptable at current scale. Representing water as integer micro-units (scaling capacity and rates by 1000) is a future optimisation if precision issues are observed in production.
- **`Retry-After` header computation**: Computed in the middleware layer as `ceil((resetAtMs - Date.now()) / 1000)`. The `LeakyBucket.check()` return value provides `resetAtMs`; the header derivation is the middleware's responsibility and is outside this spec.
