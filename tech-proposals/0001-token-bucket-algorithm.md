# Tech Proposal 0001: Token Bucket Algorithm

**Status**: DRAFT
**Author**: Architect
**Date**: 2026-05-14
**Relates to**: `src/algorithms/token-bucket.ts`

---

## ADR-001: Token Bucket Algorithm Selection and Design

**Status**: proposed

**Context**: The library currently has no algorithm implementations. `src/store/redis.ts` provides an `evalScript` wrapper that executes a Lua script via `EVALSHA`, handles `NOSCRIPT` cache misses by reloading, and returns a flat `[allowed, remaining, reset_at_ms]` tuple. The first algorithm to be added must establish the pattern every subsequent algorithm will follow.

---

## 1. Problem

API consumers have no rate-limiting protection. Every inbound request passes through `createRateLimiter()` (not yet implemented) without any enforcement, which means:

- A single abusive client can exhaust backend resources unboundedly.
- There is no mechanism to emit `X-RateLimit-*` headers, so clients have no signal to back off.
- Without a reference implementation, the team has no proven template for the Lua-script-per-algorithm pattern that the other four algorithms must follow.

The Token Bucket algorithm is the appropriate first implementation because it natively handles both sustained rate (tokens/second) and short bursts (bucket capacity), which covers the most common API protection use case without the storage cost of a log-based approach.

Success is measurable: after implementation, a sustained flood from a single IP at 10x the configured rate must result in HTTP 429 for all requests beyond the configured capacity, with correct `X-RateLimit-Remaining` decrements and a valid `Retry-After` header on every rejected response.

---

## 2. Goals

- Implement a Token Bucket algorithm class at `src/algorithms/token-bucket.ts` that satisfies the existing `evalScript` contract: receives `KEYS[1]` and `ARGV`, returns `[allowed, remaining, reset_at_ms]`.
- All state transitions (refill computation, token deduction, key write) execute inside a single atomic Lua call via `EVALSHA` — no multi-step round-trips.
- Redis memory footprint is O(1) per tracked key, independent of request volume.
- The authoritative timestamp comes from `redis.call('TIME')` inside the Lua script, not from the calling application, eliminating clock-skew as a source of correctness bugs.
- The implementation must not touch or redefine the key namespace used by any future algorithm. Token Bucket keys will live under `ratelimit:{domain}:{identifier}` with a `tb:` sub-prefix distinguishing them from other algorithm keys.
- `config/rules.yaml` and the Redis override mechanism at `ratelimit:rules:{domain}` must be able to express Token Bucket parameters (`capacity`, `refill_rate`, `refill_interval_ms`) without schema changes that break other rule types.

---

## 3. Non-Goals

- This proposal does not cover the other four algorithms (Fixed Window, Sliding Window Log, Sliding Window Counter, Leaky Bucket). They will follow in separate proposals.
- This proposal does not define the `createRateLimiter()` middleware signature. That is fixed by the architecture: `createRateLimiter(opts, next): Handler`.
- This proposal does not design the `rules.yaml` schema beyond the fields needed for Token Bucket.
- Distributed token sharing across multiple Redis nodes (Cluster topology) is out of scope. The current store layer targets a single Redis instance.
- Token cost per request (consuming N tokens per call) is not in scope for this initial implementation. All requests cost exactly one token.

---

## 4. Options

Both options below satisfy atomicity (single Lua call), O(1) memory, and the `[allowed, remaining, reset_at_ms]` return contract. They differ in how bucket state is represented in Redis and how the refill is computed.

---

### Option A: Two-Field Hash — `tokens` + `last_refill_ms`

#### Representation

Each rate-limit key is a Redis Hash with exactly two fields:

| Field            | Type          | Meaning                                        |
|------------------|---------------|------------------------------------------------|
| `tokens`         | float string  | Current token count (may be fractional)        |
| `last_refill_ms` | integer string| Redis TIME (ms) when the bucket was last seen  |

The key has a TTL equal to the time it would take for an empty bucket to refill to full capacity: `ceil(capacity / refill_rate_per_ms)`. This bounds memory for idle keys automatically.

#### Lua logic (prose, not code)

1. Call `redis.call('TIME')` to obtain the authoritative Redis wall-clock time in microseconds; convert to milliseconds.
2. If the key does not exist, initialise to `{tokens: capacity - 1, last_refill_ms: now_ms}` and return `[1, capacity-1, now_ms + refill_interval_ms]`.
3. Otherwise `HGETALL` the hash in one call.
4. Compute `elapsed_ms = now_ms - last_refill_ms`.
5. Compute `new_tokens = min(capacity, stored_tokens + elapsed_ms * refill_rate_per_ms)`.
6. If `new_tokens < 1`, the bucket is dry — return `[0, 0, now_ms + ceil((1 - new_tokens) / refill_rate_per_ms)]` without writing.
7. Otherwise deduct one token: `write_tokens = new_tokens - 1`. Update both fields and reset TTL. Return `[1, floor(write_tokens), now_ms + ceil((capacity - write_tokens) / refill_rate_per_ms)]`.

#### Time complexity (Lua ops per request)

- 1x `TIME`
- 1x `EXISTS` or `HGETALL` (combined)
- 1x `HMSET` + `PEXPIRE` on write path

Total: 3–4 Redis commands, all inside one atomic Lua call. O(1) per request.

#### Redis memory usage

- 1 Hash key per tracked identifier
- 2 fields per key: `tokens` (float, ~8 bytes) + `last_refill_ms` (integer, ~13 bytes)
- Redis Hash overhead at small field count: approximately 70–90 bytes with ziplist encoding
- Total per key: ~100–120 bytes regardless of request volume

#### Clock-skew sensitivity

If `redis.call('TIME')` is used for `now_ms` inside the Lua script, the application clock is never consulted for the refill computation. `last_refill_ms` is also written as a Redis-side timestamp. The only app-side timestamp that reaches the script is through `ARGV` as a fallback candidate, but under this option it is explicitly not used for elapsed-time math. Skew between app and Redis has zero effect on token accrual correctness.

The remaining exposure is that `reset_at_ms` returned to the application (used to populate `X-RateLimit-Reset`) is a Redis-side ms value; the app reports it as-is in the header, so the client sees a consistent view.

#### Burst behaviour

Supports genuine bursts up to `capacity` tokens. A client that is idle for a full refill cycle and then fires a burst gets up to `capacity` requests through immediately. The refill is continuous (fractional tokens accumulate between requests), so clients that space their calls evenly experience near-zero rejection even at rates close to the refill rate. This is the defining property that distinguishes Token Bucket from Fixed Window.

#### Trade-offs summary

| Dimension            | Assessment                                                             |
|----------------------|------------------------------------------------------------------------|
| Lua complexity       | Low — simple arithmetic, two Hash fields, one conditional branch       |
| Memory per key       | ~100–120 bytes, O(1), bounded by TTL                                   |
| Clock-skew           | Zero impact when `redis.call('TIME')` is used for elapsed-time math    |
| Burst                | Controlled burst up to `capacity`; fractional accrual for smooth rates |
| Fit with return contract | Natural — `remaining = floor(tokens - 1)`, `reset_at_ms` derivable |

---

### Option B: Virtual Schedule — Single Field `next_allowed_ms`

This is a leaky-bucket style variant included for contrast. It models the bucket not as a token count but as a schedule: the next timestamp at which a request is permitted.

#### Representation

Each rate-limit key is a single Redis String:

| Key value        | Type          | Meaning                                               |
|------------------|---------------|-------------------------------------------------------|
| `next_allowed_ms`| integer string| Earliest Redis-time ms at which the next request is allowed |

TTL is set to `interval_ms` (the inter-request gap at the configured rate).

#### Lua logic (prose, not code)

1. Call `redis.call('TIME')` for `now_ms`.
2. Read `next_allowed_ms = redis.call('GET', KEYS[1])`. If nil, set to `now_ms`.
3. If `now_ms >= next_allowed_ms`, allow: advance schedule by `interval_ms = 1000 / rate_per_second`. Write `max(now_ms, next_allowed_ms) + interval_ms` as the new value. Return `[1, remaining_approx, next_allowed_ms + interval_ms]`.
4. If `now_ms < next_allowed_ms`, deny: return `[0, 0, next_allowed_ms]`.

`remaining` cannot be computed precisely in O(1) without knowing capacity; an approximation requires storing a separate counter or accepting that `X-RateLimit-Remaining` is always 0 when denying.

#### Time complexity (Lua ops per request)

- 1x `TIME`
- 1x `GET`
- 1x `SET` + `PEXPIRE` on allow path

Total: 3 Redis commands inside one Lua call. O(1) per request.

#### Redis memory usage

- 1 String key per tracked identifier
- Single integer value: ~8 bytes
- Redis String overhead: ~50–60 bytes
- Total per key: ~70 bytes — slightly smaller than Option A

#### Clock-skew sensitivity

Same as Option A when `redis.call('TIME')` is used: zero impact on the scheduling arithmetic. The schedule value is a Redis-side timestamp throughout its lifecycle.

#### Burst behaviour

This is the critical weakness. A virtual-schedule model enforces strict inter-request spacing — it is a leaky bucket, not a token bucket. Bursts are absorbed at most one request ahead of schedule (depending on implementation variant). A client that is idle for an hour and then fires 100 requests will have only 1 or 2 requests allowed, then be queued at strict rate. This is appropriate for FIFO queue/smoothing use cases but does not provide the burst headroom that makes Token Bucket valuable for API protection. Because the feature request explicitly asks for Token Bucket semantics, Option B is an architectural mismatch despite its simplicity.

#### Computing `remaining` for response headers

Option B cannot naturally derive a meaningful `remaining` count without additional state. The best it can do is return `0` when denying and an approximation when allowing. This makes it non-compliant with the `X-RateLimit-Remaining` header requirement if callers expect a count of tokens available, and produces misleading values for monitoring dashboards. Patching this requires either a second Redis field (collapsing the memory advantage) or accepting inaccurate headers.

#### Trade-offs summary

| Dimension            | Assessment                                                                    |
|----------------------|-------------------------------------------------------------------------------|
| Lua complexity       | Very low — single arithmetic step, one GET/SET                                |
| Memory per key       | ~70 bytes, O(1)                                                               |
| Clock-skew           | Zero impact with `redis.call('TIME')`                                         |
| Burst                | No burst capacity — strict leaky-bucket pacing, wrong semantics for this feature |
| Fit with return contract | Weak — `remaining` cannot be computed accurately without extra state      |

---

## 5. Recommendation

**Implement Option A: Two-Field Hash.**

The decision is grounded in three factors:

**Semantic correctness.** Option B implements a leaky bucket, not a token bucket. The user explicitly requested token bucket semantics, which includes burst allowance up to a configured capacity. Option A is the only design that correctly models a bucket that fills continuously and drains on each request.

**Header contract compliance.** The architecture mandates `X-RateLimit-Remaining` on every response. Option A computes `remaining = floor(tokens - 1)` trivially from the stored token count. Option B cannot produce this value accurately without additional state, which eliminates its memory advantage and increases Lua complexity.

**Clock-skew elimination.** Both options are made clock-skew-safe by sourcing `now_ms` from `redis.call('TIME')` inside the Lua script. The application-provided `now_ms` in `ARGV` is carried through only for the `reset_at_ms` response value so that callers can correlate it with their own clock if needed, but it must never be used for the elapsed-time refill arithmetic inside the script.

**Concrete parameters the algorithm class must accept:**

| Parameter            | Type    | Meaning                                         |
|----------------------|---------|-------------------------------------------------|
| `capacity`           | integer | Maximum token count (burst ceiling)             |
| `refill_rate`        | float   | Tokens added per `refill_interval_ms`           |
| `refill_interval_ms` | integer | Refill tick period in milliseconds              |

These map naturally to `rules.yaml` fields and to `ARGV` positions: `ARGV[1]=capacity`, `ARGV[2]=refill_rate`, `ARGV[3]=refill_interval_ms`, `ARGV[4]=now_ms` (app clock, for reference only — not for elapsed-time math).

**Redis key for Token Bucket:**

```
ratelimit:{domain}:{identifier}
```

No sub-prefix collision risk exists today since no other algorithms are implemented. If a future algorithm must share the same `{domain}:{identifier}` scope, a `tb:` sub-prefix can be introduced at that point. This decision is noted as an open question below.

**TTL strategy:**

Set `PEXPIRE` on every write (both allow and deny paths — deny paths should update `last_refill_ms` without decrementing to keep the refill window accurate). TTL = `ceil(capacity / refill_rate_per_ms)` milliseconds, which is the time for an empty bucket to refill to full. This guarantees that keys for inactive identifiers expire within one full refill cycle, bounding Redis memory without manual eviction.

---

## 6. Open Questions

1. **Key namespace collision.** The current key pattern `ratelimit:{domain}:{identifier}` does not include an algorithm discriminator. If two algorithms are configured for the same domain (e.g., a fallback chain), their keys would collide. Should a per-algorithm sub-prefix (e.g., `ratelimit:tb:{domain}:{identifier}`) be adopted from the start, or deferred until a second algorithm is implemented? The cost of changing the key schema later is a cache flush for all active keys, which is a brief rate-limit enforcement gap.

2. **Fractional token representation.** Redis Hashes store strings. Fractional tokens (e.g., `4.73`) must be serialised as floats and re-parsed in each Lua call. Lua's `tonumber()` handles this correctly, but floating-point rounding across repeated refills may cause sub-token drift over time. Should the implementation store tokens as integer micro-tokens (multiply by 1000) to stay in integer arithmetic throughout?

3. **Deny-path write behaviour.** The recommendation above says the deny path should update `last_refill_ms` to prevent stale refill windows accumulating for a hot-rejecting key. However, writing on every denied request doubles write volume under flood conditions. An alternative is to update `last_refill_ms` only on the allow path and cap `elapsed_ms` at the time-to-fill-capacity to prevent unbounded token accumulation from very long idle periods. Which behaviour is preferred?

4. **`rules.yaml` schema for Token Bucket.** The proposed fields are `capacity`, `refill_rate`, and `refill_interval_ms`. Should `refill_rate` be expressed as tokens-per-second (more human-readable) and converted to per-millisecond inside the resolver, or stored as-is in millisecond units? The resolver is the natural place for unit conversion, but it adds a transformation step that must be documented and tested.

5. **`reset_at_ms` semantics on deny.** On a denied request, `reset_at_ms` is returned as the earliest time the next token will be available. This is used to populate both `X-RateLimit-Reset` and `Retry-After`. Should `Retry-After` be derived as `ceil((reset_at_ms - app_now_ms) / 1000)` seconds, or should it use the Redis-side `now_ms` from `redis.call('TIME')` for the subtraction? Using Redis time for the subtraction is more consistent but requires surfacing it in the return tuple, which currently has no slot for it (the contract is a flat 3-element array).
