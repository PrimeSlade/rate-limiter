---
proposal: PROP-0001
status: DRAFT
---

# Tech Spec 0001: Token Bucket Algorithm

## ADR-001: Token Bucket — Two-Field Hash Design
**Status**: accepted
**Context**: The library has no algorithm implementations. `src/store/redis.ts` provides `evalScript(sha, lua, keys, args)` which executes a Lua script via `EVALSHA`, handles `NOSCRIPT` reloads, and returns `[allowed, remaining, reset_at_ms]`. Token Bucket is the first algorithm and must establish the pattern all subsequent algorithms follow.
**Decision**: Implement Option A (Two-Field Hash) with fields `tokens` and `last_refill_ms`, sourcing elapsed-time from `redis.call('TIME')` exclusively.
**Consequences**: Correct burst semantics, accurate `X-RateLimit-Remaining`, zero clock-skew exposure in the refill math, O(1) Redis memory per key.

---

## 1. File Map

| File | Action | Description |
|------|--------|-------------|
| `src/algorithms/token-bucket.ts` | Create | `TokenBucket` class; embeds `LUA_SCRIPT` as a template-literal constant; exports both |
| `src/algorithms/index.ts` | Create | Re-exports all algorithm classes from `src/algorithms/` |
| `config/rules.yaml` | Create | Example domain rules including a Token Bucket stanza |
| `tests/algorithms/token-bucket.test.ts` | Create | Integration tests against real Redis via `@testcontainers/redis` |

No other existing files require modification to implement this algorithm. The middleware (`src/middleware/`) and rule resolver (`src/rules/`) will consume `TokenBucket` in separate work items.

---

## 2. TypeScript Interface

### `TokenBucketOpts`

```typescript
interface TokenBucketOpts {
  /**
   * Maximum number of tokens the bucket can hold.
   * Also the maximum burst size.
   * Must be a positive integer.
   */
  capacity: number

  /**
   * Tokens added per second.
   * The rule resolver converts this to tokens/ms before passing to the Lua script.
   * Must be a positive number.
   */
  refillRate: number

  /**
   * Refill tick period in milliseconds.
   * Optional — defaults to 1000 ms (i.e., refillRate is interpreted as tokens/second).
   * The resolver uses this only to derive refill_rate_per_ms = refillRate / refillIntervalMs.
   */
  refillIntervalMs?: number
}
```

### `TokenBucket` class

```typescript
class TokenBucket {
  constructor(opts: TokenBucketOpts)

  /**
   * Evaluate whether the request identified by `key` is allowed.
   *
   * Internally:
   *   1. Ensures the Lua script SHA is loaded via loadScript().
   *   2. Calls evalScript(sha, LUA_SCRIPT, [key], [capacity, refillRatePerMs, nowMs]).
   *   3. Maps the flat [allowed, remaining, reset_at_ms] tuple to the return object.
   *
   * `nowMs` is the application wall-clock time. It is passed as ARGV[3] for
   * observability only; the Lua script uses redis.call('TIME') for all elapsed-time
   * arithmetic and must never use ARGV[3] for the refill computation.
   */
  check(key: string, nowMs: number): Promise<{
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

The SHA of `LUA_SCRIPT` is obtained once via `loadScript('token-bucket', LUA_SCRIPT)` and cached in the store-layer `scriptCache` map. Subsequent calls use `evalScript` which handles `NOSCRIPT` reloads transparently.

---

## 3. ARGV Layout

The Lua script receives exactly three ARGV positions:

| Position | Value | Type | Unit | Notes |
|----------|-------|------|------|-------|
| `ARGV[1]` | `capacity` | integer | tokens | Maximum bucket size and burst ceiling. Passed as a whole number string. |
| `ARGV[2]` | `refill_rate_per_ms` | float | tokens / ms | Derived by the rule resolver: `refillRate / refillIntervalMs`. For a rule with `refill_rate: 10` tokens/sec and default `refill_interval_ms: 1000`, this value is `0.01`. Passed as a decimal string, e.g., `"0.01"`. |
| `ARGV[3]` | `now_ms` | integer | ms | Application wall-clock time (`Date.now()`). Carried through for observability and header correlation only. The Lua script must NOT use this value for elapsed-time computation. |

`KEYS[1]` is the full rate-limit Redis key (see Section 5).

---

## 4. Lua Script Pseudocode

The following pseudocode is authoritative for the implementation. Line-by-line comments explain every decision. The implementer must translate this directly into the `LUA_SCRIPT` template literal inside `src/algorithms/token-bucket.ts`.

```
-- Parse ARGV
local capacity           = tonumber(ARGV[1])
local refill_rate_per_ms = tonumber(ARGV[2])
-- ARGV[3] = app now_ms, not used for refill math, only for passthrough if needed

-- Step 1: Obtain authoritative time from Redis.
-- redis.call('TIME') returns {seconds, microseconds} as a two-element array.
-- Convert to milliseconds: seconds * 1000 + floor(microseconds / 1000).
-- This is the ONLY source of time used for elapsed-time arithmetic.
-- The app-provided ARGV[3] must never be used here.
local t              = redis.call('TIME')
local redis_now_ms   = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- Compute TTL for any write operation.
-- An empty bucket takes exactly (capacity / refill_rate_per_ms) ms to refill fully.
-- Use this as the key lifetime so idle keys auto-expire within one full cycle.
local ttl_ms = math.ceil(capacity / refill_rate_per_ms)

-- Step 2: Read existing bucket state.
local data = redis.call('HGETALL', KEYS[1])

-- HGETALL returns a flat array: {field1, val1, field2, val2, ...}.
-- An empty array means the key does not exist.

-- Step 3: Handle fresh key (key does not exist).
if #data == 0 then
    -- First request: consume one token immediately from a full bucket.
    local initial_tokens = capacity - 1

    -- Write the new bucket state.
    redis.call('HSET', KEYS[1],
        'tokens',         tostring(initial_tokens),
        'last_refill_ms', tostring(redis_now_ms))
    redis.call('PEXPIRE', KEYS[1], ttl_ms)

    -- reset_at_ms: time at which the bucket will be full again.
    -- When initial_tokens == capacity - 1, one token was consumed, so
    -- it takes ceil(1 / refill_rate_per_ms) ms to refill that token.
    local reset_at_ms = redis_now_ms + math.ceil(1 / refill_rate_per_ms)

    -- Return: allowed=1, remaining=initial_tokens (floor is a no-op for integer),
    -- reset_at_ms is when the bucket would be full again.
    return {1, initial_tokens, reset_at_ms}
end

-- Step 4: Parse existing hash fields into local variables.
-- HGETALL returns fields in an unspecified order; iterate the flat array.
local stored_tokens    = nil
local last_refill_ms   = nil
for i = 1, #data, 2 do
    if data[i] == 'tokens' then
        stored_tokens  = tonumber(data[i + 1])
    elseif data[i] == 'last_refill_ms' then
        last_refill_ms = tonumber(data[i + 1])
    end
end

-- Step 5: Compute elapsed time since the bucket was last seen.
local elapsed_ms = redis_now_ms - last_refill_ms

-- Step 6: Cap elapsed_ms to prevent token over-accumulation after long idle periods.
-- If the key somehow survived past its TTL (e.g. Redis maxmemory-policy=noeviction
-- and memory pressure prevented expiry), or the clock jumped forward, we must not
-- grant more tokens than the bucket can hold.
-- Maximum meaningful elapsed time is the time to fill an empty bucket: capacity / refill_rate_per_ms.
local max_elapsed_ms = capacity / refill_rate_per_ms
if elapsed_ms > max_elapsed_ms then
    elapsed_ms = max_elapsed_ms
end

-- Step 7: Compute the new token count after refill.
-- Tokens accrue continuously (fractional accumulation is intentional).
local new_tokens = math.min(capacity, stored_tokens + elapsed_ms * refill_rate_per_ms)

-- Step 8: Deny path — not enough tokens for one request.
-- Do NOT write to Redis on the deny path. Writing would reset last_refill_ms
-- and the TTL, which increases write volume under flood conditions without
-- providing any correctness benefit (elapsed_ms capping handles idle accumulation).
if new_tokens < 1 then
    -- reset_at_ms: earliest time the next token will be available.
    -- (1 - new_tokens) is the fractional deficit; dividing by rate gives ms to wait.
    local reset_at_ms = redis_now_ms + math.ceil((1 - new_tokens) / refill_rate_per_ms)

    -- Return: allowed=0, remaining=0, reset_at_ms.
    return {0, 0, reset_at_ms}
end

-- Step 9: Allow path — deduct one token.
local write_tokens = new_tokens - 1

-- Step 10: Write updated state to Redis.
-- Update both fields atomically and reset the TTL.
redis.call('HSET', KEYS[1],
    'tokens',         tostring(write_tokens),
    'last_refill_ms', tostring(redis_now_ms))
redis.call('PEXPIRE', KEYS[1], ttl_ms)

-- Step 11: Compute reset_at_ms for the allow path.
-- This represents the time at which the bucket would be fully refilled from its
-- current post-deduction state. Used for X-RateLimit-Reset header.
-- (capacity - write_tokens) is the number of tokens missing from a full bucket.
local reset_at_ms = redis_now_ms + math.ceil((capacity - write_tokens) / refill_rate_per_ms)

-- Return: allowed=1, remaining=floor(write_tokens), reset_at_ms.
-- floor() ensures the header value is a non-negative integer even when write_tokens
-- is a very small positive float like 0.003.
return {1, math.floor(write_tokens), reset_at_ms}
```

### Key invariants enforced by this script

- `redis.call('TIME')` is the single authoritative clock. `ARGV[3]` (app `now_ms`) is never used in any arithmetic.
- No write occurs on the deny path. TTL is not reset. `last_refill_ms` is not updated.
- `elapsed_ms` is always capped at `capacity / refill_rate_per_ms` before token accrual.
- The return tuple is always exactly three elements: `[allowed (0|1), remaining (integer), reset_at_ms (integer)]`.
- `HSET` + `PEXPIRE` on the write path are two commands inside one atomic Lua call — no round-trip between them.

---

## 5. Redis Key Pattern

### Pattern

```
ratelimit:{domain}:{identifier}
```

### Example

```
ratelimit:api:192.168.1.1
ratelimit:api:user-8472
ratelimit:payments:10.0.0.5
```

`{domain}` is the logical service or rule group (matches the top-level key in `rules.yaml`).
`{identifier}` is the per-client discriminator, typically the remote IP address or an authenticated user ID, resolved by the middleware before calling `TokenBucket.check()`.

### Hash fields stored at this key

| Field | Value type | Example |
|-------|-----------|---------|
| `tokens` | float string | `"9.73"` |
| `last_refill_ms` | integer string | `"1747123456789"` |

### TTL formula

```
TTL = ceil(capacity / refill_rate_per_ms)  [milliseconds]
     = ceil(capacity / (refillRate / refillIntervalMs))
```

Set via `PEXPIRE` on every write (allow path only).

**Why this value.** An empty bucket (`tokens = 0`) needs exactly `capacity / refill_rate_per_ms` milliseconds to reach full capacity. Setting the TTL to this value means a completely idle key — one that receives no traffic — will expire at the precise moment it would have become fully replenished. This is the tightest possible TTL that prevents stale keys from lingering beyond one full refill cycle while never expiring a key that a request could legitimately benefit from.

**No sub-prefix today.** The proposal noted that a `tb:` sub-prefix could be added if multiple algorithms need keys under the same `{domain}:{identifier}` scope. Because no other algorithm is implemented yet, no sub-prefix is added now. If a future algorithm shares this namespace, a key migration (flush of active keys) will be required. This is documented as a known consequence.

---

## 6. `rules.yaml` Schema

### Example stanza

```yaml
domains:
  api:
    algorithm: token_bucket
    capacity: 100          # maximum tokens (burst ceiling)
    refill_rate: 10        # tokens added per refill_interval_ms (default: per second)
    refill_interval_ms: 1000  # optional; default 1000 ms
    identifier: ip         # how to extract the client key: "ip" | "header:X-User-Id"
```

### Field reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `algorithm` | string | Yes | — | Must be `"token_bucket"` to select this algorithm. |
| `capacity` | positive integer | Yes | — | Maximum tokens the bucket holds. Equals the maximum burst size. Passed as `ARGV[1]`. |
| `refill_rate` | positive number | Yes | — | Tokens added per `refill_interval_ms`. Expressed in human-readable tokens/second when `refill_interval_ms` is omitted or 1000. The rule resolver computes `refill_rate_per_ms = refill_rate / refill_interval_ms` before passing to the algorithm. |
| `refill_interval_ms` | positive integer | No | `1000` | The denominator for `refill_rate`. Changing this to 100 with `refill_rate: 1` is equivalent to 10 tokens/second. |
| `identifier` | string | Yes | — | Strategy for extracting the per-client key from the request. `"ip"` uses the remote address. `"header:X-User-Id"` uses a named request header. |

### Rule resolver responsibility

The resolver reads `refill_rate` and `refill_interval_ms` from the YAML and computes:

```
refill_rate_per_ms = refill_rate / refill_interval_ms
```

This float is passed as `ARGV[2]`. The resolver must validate that `refill_rate_per_ms > 0` and that `capacity` is a positive integer before constructing `TokenBucketOpts`. A zero or negative value for either must be rejected with a descriptive error at startup.

### Redis override mechanism

A Redis override key at `ratelimit:rules:{domain}` (serialised as JSON or YAML) takes precedence over `config/rules.yaml` at lookup time. The override must conform to the same schema above. The resolver merges field-by-field: any field present in the Redis override replaces the YAML value; absent fields fall back to YAML.

---

## 7. Test Plan

All tests in `tests/algorithms/token-bucket.test.ts` use a real Redis instance via `@testcontainers/redis`. No mocks. Each test creates a fresh container or flushes the database between cases to ensure isolation.

| Test name | Setup | Action | Expected result |
|-----------|-------|--------|-----------------|
| **First request — fresh key** | Capacity=5, refill_rate_per_ms=0.005 (5 tokens/sec). Key does not exist. | Call `check(key, now)` once. | `allowed=true`, `remaining=4`, `resetAtMs > now`. Key exists in Redis with `tokens="4"`, TTL set to `ceil(5/0.005)=1000` ms. |
| **Sustained requests — capacity exhausted** | Capacity=3, refill_rate_per_ms=0.001. Key does not exist. | Call `check(key, now)` 4 times in rapid succession (no real-time sleep; calls happen within <1 ms of each other). | First 3 calls: `allowed=true` with `remaining` 2, 1, 0. Fourth call: `allowed=false`, `remaining=0`, `resetAtMs > now`. |
| **Refill after wait — tokens replenish** | Capacity=5, refill_rate_per_ms=0.005. Exhaust bucket to 0 tokens via 5 rapid calls. | Wait 200 ms (real sleep). Call `check(key, now)` again. | `allowed=true` (at least 1 token has accrued: 200 ms * 0.005 = 1 token). `remaining >= 0`. |
| **Flood (deny path) — no Redis writes on denied requests** | Capacity=2, refill_rate_per_ms=0.001. Exhaust bucket via 2 calls. | Record key TTL. Send 100 denied requests in rapid succession. Re-read key TTL. | All 100 calls: `allowed=false`. Key TTL after flood must not be greater than TTL after exhaustion (no TTL extension on deny path). `last_refill_ms` field must remain unchanged. |
| **Idle key expiry** | Capacity=5, refill_rate_per_ms=0.005. Make one allowed request to create the key. | Wait `ceil(5/0.005)+50 = 1050` ms (one full refill cycle + 50 ms margin). Check if key exists. | Key no longer exists in Redis (`EXISTS` returns 0). |
| **Burst then sustained — rate-limited to refill rate** | Capacity=10, refill_rate_per_ms=0.01 (10 tokens/sec). | Fire 10 immediate requests (burst). Then wait 100 ms intervals and fire one request per interval for 5 intervals. | Burst: first 10 allowed, 11th denied. Sustained: each request after a 100 ms wait (10 tokens/sec * 0.1 sec = 1 token) is allowed. |
| **Cap elapsed_ms — no over-accumulation after long idle** | Capacity=5, refill_rate_per_ms=0.005. Make one allowed request (tokens=4). Manually set `last_refill_ms` in Redis to `now - 9999999` (well beyond one full refill cycle). | Call `check(key, now)`. | `allowed=true`, `remaining=4` (not > capacity-1=4, i.e., not 5 or more). The elapsed_ms cap prevents refilling beyond capacity. |

### Helper notes for the test author

- Use `vitest`'s `vi.setSystemTime` only if testing application-side clock logic. All Redis-side timing depends on `redis.call('TIME')` and cannot be mocked at the Lua level; use real sleeps for timing-sensitive assertions.
- The "flood deny path" test must read the raw TTL from Redis (via `PTTL`) before and after the flood, not rely on application-level return values, to confirm no write occurred.
- The "cap elapsed_ms" test must set `last_refill_ms` directly with `HSET` after the initial request, bypassing the application layer.

---

## 8. Out of Scope

The following topics are explicitly not covered by this spec. They may be addressed in future specs or separate work items.

- **Multi-cost requests**: All requests consume exactly one token. Variable-cost requests (consuming N tokens per call) are a future extension.
- **Cluster topology**: This spec targets a single Redis instance. Consistent hashing, cluster-aware key routing, and cross-shard atomicity are not addressed.
- **Other algorithms**: Fixed Window, Sliding Window Log, Sliding Window Counter, and Leaky Bucket are separate implementations with their own specs.
- **Middleware wiring**: `createRateLimiter(opts, next): Handler` is a separate work item. This spec stops at the `TokenBucket.check()` contract.
- **Rule resolver implementation**: Loading `rules.yaml`, merging Redis overrides, and resolving the `identifier` field from a request are covered by the `src/rules/` module, not this spec.
- **Per-algorithm key sub-prefix**: The `tb:` sub-prefix question is deferred. If a future spec introduces key-namespace collision risk, that spec must include a migration plan.
- **Fractional token precision**: Tokens are stored as float strings. Sub-token drift from repeated floating-point operations is considered acceptable for the current scale. Integer micro-token representation is a future optimisation if precision issues are observed.
- **`Retry-After` header computation**: Computed in the middleware layer as `ceil((resetAtMs - Date.now()) / 1000)`. The `TokenBucket.check()` return value provides `resetAtMs`; the header derivation is the middleware's responsibility.
- **Script pre-loading at startup**: Whether `loadScript` is called eagerly at server start or lazily on the first request is a deployment concern outside this spec. The `evalScript` wrapper in `src/store/redis.ts` handles `NOSCRIPT` errors either way.
