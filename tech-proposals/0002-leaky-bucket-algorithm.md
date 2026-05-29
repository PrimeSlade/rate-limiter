---
id: "0002"
slug: leaky-bucket-algorithm
title: Leaky Bucket Algorithm
status: DRAFT
created: 2026-05-17
---

## ADR-002: Leaky Bucket Algorithm Selection and Design

**Status**: accepted

**Context**: Token Bucket (ADR-001) is now implemented. It permits bursts up to `capacity` tokens, which is desirable for general API protection but undesirable for workloads that require a strictly constant outflow rate — payment processing pipelines, SMS gateway calls, or any downstream that has no burst tolerance. The Leaky Bucket algorithm enforces a fixed inter-request gap, preventing any burst regardless of idle accumulation. This proposal evaluates two concrete Redis representations and recommends one.

---

## Problem

Token Bucket allows a client that has been idle to consume up to `capacity` tokens in an immediate burst. For certain workloads — rate-controlled webhooks, metered third-party API calls, or smoothing pipelines — that burst is itself the problem. The downstream system expects requests to arrive no faster than `rate` per second regardless of prior idle time. There is currently no algorithm in this library that provides that guarantee.

The Leaky Bucket algorithm models a bucket that drains at a fixed rate. Requests that arrive faster than the drain rate are rejected (or conceptually queued — this library rejects, it does not queue). The outflow is constant; input bursts are absorbed only to the extent the bucket has remaining capacity, and requests beyond that are rejected immediately.

Success criterion: under a flood of N simultaneous requests against a domain configured with `rate=10/s` and `capacity=20`, exactly the requests that fall within the filled bucket are allowed, and the per-second throughput from that point forward never exceeds 10, even if the client sends 1000/s.

---

## Goals

- Implement a Leaky Bucket algorithm class at `src/algorithms/leaky-bucket.ts` that follows the same structural contract as `token-bucket.ts`: a `LUA_SCRIPT` constant (inline template literal) and a class with a `check(key: string): Promise<{ allowed, remaining, resetAtMs }>` method.
- All state transitions execute inside a single atomic Lua call via `EVALSHA`. No multi-step round-trips.
- The authoritative clock comes from `redis.call('TIME')` inside the Lua script. The application clock is never used for rate-enforcement arithmetic.
- Redis memory footprint is O(1) per tracked key, independent of request volume or traffic pattern.
- The return tuple `[allowed (0|1), remaining, reset_at_ms]` must be populated accurately on every code path, satisfying the `X-RateLimit-Remaining` and `X-RateLimit-Reset` header requirements.
- Key namespace must not collide with Token Bucket keys. A `lb:` discriminator sub-prefix is introduced to the key pattern.
- The `rules.yaml` `Algorithm` union and the loader validation must be extended to accept `leaky_bucket` without breaking existing `token_bucket` rules.

---

## Non-Goals

- This proposal does not cover queuing (holding requests until a slot opens). The library rejects requests that exceed the rate; it does not delay them.
- Variable drain rates per request (consuming N slots per call) are out of scope.
- This proposal does not cover the Fixed Window, Sliding Window Log, or Sliding Window Counter algorithms.
- Redis Cluster / multi-shard topology is out of scope. The store layer targets a single Redis instance.
- Migration or conversion of existing Token Bucket keys to Leaky Bucket keys is out of scope.

---

## Options

Both options below are O(1) in Redis memory, use `redis.call('TIME')` for the clock, are fully atomic in a single Lua call, and return the correct 3-element flat array. They differ in how they model the bucket state and how accurately they compute `remaining`.

---

### Option A: Virtual Schedule — Single String `next_allowed_ms`

#### Model

The bucket is represented not as a fill level but as a schedule: a single value recording the earliest Redis-time millisecond at which the next request will be permitted. Between requests the schedule advances by `interval_ms = 1000 / rate_per_second`. If a new request arrives before the schedule allows it, it is rejected. If it arrives at or after the scheduled slot, it is allowed and the schedule is advanced.

This is the GCRA (Generic Cell Rate Algorithm) formulation of Leaky Bucket. It is mathematically equivalent to a leaky bucket with no burst capacity.

#### Redis representation

| Key type | Value | Meaning |
|----------|-------|---------|
| String   | `next_allowed_ms` (integer, ms) | Earliest Redis-time ms at which the next request is accepted |

TTL is set to `interval_ms` on every allowed write. A key that has not been touched for one full inter-request interval will expire, making the next request from that client appear as a fresh start.

#### Lua logic (prose)

1. Call `redis.call('TIME')` to obtain `now_ms`.
2. `GET KEYS[1]`. If nil, treat `next_allowed_ms` as `now_ms` (first request, no history).
3. If `now_ms >= next_allowed_ms`, allow: write `next_allowed_ms + interval_ms` as the new value, set `PEXPIRE` to `interval_ms`. Return `[1, remaining_approx, next_allowed_ms + interval_ms]`.
4. If `now_ms < next_allowed_ms`, deny: return `[0, 0, next_allowed_ms]`.

#### Computing `remaining`

This is the critical weakness of the pure GCRA model. The schedule tracks only the next allowed slot; it has no notion of how many slots remain before a capacity ceiling. Without a second field storing either a counter or a burst start timestamp, `remaining` cannot be computed. The best approximation is `0` on deny and `1` on allow (meaning "one more slot is reserved"). This is misleading for monitoring dashboards and violates the spirit of `X-RateLimit-Remaining`, which callers expect to reflect a meaningful headroom count. Patching it requires adding a second field, which eliminates the memory advantage and increases Lua complexity — collapsing this option into a variant of Option B.

For a pure GCRA implementation without burst capacity, `capacity` has no role, which means the `capacity` parameter required by the architecture (and already present in `rules.yaml`) would be ignored or fabricated into an artificial headroom estimate. That is architecturally unsound.

#### Time complexity

- 1x `TIME`
- 1x `GET`
- 1x `SET` + `PEXPIRE` on allow path (denied requests do not write)

Total: 3 Redis commands inside one atomic Lua call. O(1).

#### Redis memory usage

- 1 String key per tracked identifier
- Single integer value: ~8 bytes stored
- Redis String overhead: ~56 bytes (with raw encoding for small integers, closer to ~40 bytes)
- Total per key: ~60–70 bytes

Compared to Token Bucket's Hash at ~100–120 bytes, this is ~40% smaller. However, the saving is irrelevant if a second field must be added to compute `remaining` accurately (see above), which brings the footprint to approximately the same range as Option B.

#### Clock-skew sensitivity

Zero. `next_allowed_ms` is written as a Redis-side timestamp derived from `redis.call('TIME')`. The schedule arithmetic never touches the application clock.

#### Burst behaviour

No burst capacity at all. A client idle for an hour that fires 100 requests simultaneously will have at most 1 allowed (the current slot), then all remaining 99 denied until their scheduled slot arrives. This is the intended semantic: strictly constant outflow.

#### Trade-offs vs Token Bucket

| Dimension | Token Bucket (ADR-001) | Option A (GCRA) |
|-----------|----------------------|-----------------|
| Burst | Up to `capacity` tokens | None — strictly 1 slot per `interval_ms` |
| `remaining` accuracy | Exact (floor of token count) | Cannot be computed without extra state |
| Memory per key | ~100–120 bytes | ~60–70 bytes (pure); ~90–110 bytes if patched |
| Lua complexity | Low | Very low (pure); Low (patched) |
| `capacity` parameter | Directly meaningful | Unused or approximated |

#### Verdict on Option A

Acceptable only in a no-burst, no-`remaining` scenario. As proposed, it cannot satisfy `X-RateLimit-Remaining` accurately without adding state, at which point its simplicity advantage disappears. It also renders the `capacity` parameter meaningless. **Rejected as the primary recommendation** but retained as the basis for a degenerate "strict mode" future extension if callers explicitly opt out of `remaining` tracking.

---

### Option B: Fill-Level Hash — `water` + `last_leak_ms`

#### Model

The bucket is modelled as a physical leaky bucket: it has a finite capacity (`capacity` units), and water drips out at `drain_rate` units per millisecond. Incoming requests add 1 unit of water. If adding 1 unit would overflow the bucket (i.e., `water + 1 > capacity`), the request is rejected. Otherwise the request is allowed and the bucket level is updated.

This is the direct, fill-level formulation of Leaky Bucket. It supports a burst up to `capacity` on first use (the bucket starts empty; all `capacity` slots can be filled immediately before any are rejected), but the drain enforces that the long-run throughput cannot exceed `drain_rate` regardless of traffic pattern.

Note on burst semantics: Token Bucket and Leaky Bucket (fill-level) both allow an initial burst up to `capacity`. The distinction is in what happens after sustained overload. Token Bucket refills tokens continuously, so a client alternating between bursts and idle periods can keep harvesting burst credit. Leaky Bucket drains continuously, so a client that sustained a burst must wait for the water level to drain before any new requests are accepted — the drain rate is the hard ceiling on long-run throughput. The user's stated goal ("prevent any burst") is more accurately "prevent the output rate from ever exceeding drain_rate", which fill-level Leaky Bucket enforces.

#### Redis representation

| Field | Type | Meaning |
|-------|------|---------|
| `water` | float string | Current fill level (0 to `capacity`) |
| `last_leak_ms` | integer string | Redis-time ms when the fill level was last computed |

The key is a Redis Hash. TTL is set to `ceil(capacity / drain_rate_per_ms)` milliseconds — the time for a full bucket to drain to empty. A key for an idle identifier expires within one full drain cycle.

#### Lua logic (prose)

1. Call `redis.call('TIME')` to obtain `now_ms`.
2. `HGETALL KEYS[1]`. If the key does not exist, initialise: `water = 1`, `last_leak_ms = now_ms`, persist, set TTL, return `[1, capacity - 1, now_ms + ceil(1 / drain_rate_per_ms)]` (first request always allowed into an empty bucket).
3. Parse `water` and `last_leak_ms` from the flat HGETALL result.
4. Compute `elapsed_ms = now_ms - last_leak_ms`.
5. Compute `leaked = elapsed_ms * drain_rate_per_ms`. Cap `leaked` so the water level cannot go below 0: `current_water = max(0, water - leaked)`.
6. If `current_water + 1 > capacity`, the bucket is full — deny: return `[0, 0, now_ms + ceil((current_water + 1 - capacity) / drain_rate_per_ms)]`. Do not write (no state change on denial).
7. Otherwise allow: `new_water = current_water + 1`. Write `{water: new_water, last_leak_ms: now_ms}`, reset TTL. Return `[1, capacity - new_water, now_ms + ceil(new_water / drain_rate_per_ms)]`.

`remaining = capacity - new_water` is the number of additional requests the bucket can absorb before it overflows. This is the exact, accurate headroom count.

`reset_at_ms` on deny is the earliest time at which the water level will have drained enough to accept 1 more unit: `now_ms + ceil((current_water + 1 - capacity) / drain_rate_per_ms)`. On allow, it is when the current water level will have fully drained (a conservative indicator of when the client will have maximum headroom again).

#### Time complexity

- 1x `TIME`
- 1x `HGETALL` (or implicit existence check via empty result)
- 1x `HSET` + `PEXPIRE` on allow path

Total: 3–4 Redis commands inside one atomic Lua call. O(1). Identical to Token Bucket.

#### Redis memory usage

- 1 Hash key per tracked identifier
- 2 fields: `water` (float, ~8 bytes) + `last_leak_ms` (integer, ~13 bytes)
- Redis Hash overhead at 2 fields with listpack encoding: ~70–90 bytes
- Total per key: ~90–110 bytes

This is within 10% of Token Bucket's ~100–120 bytes. The architecture requirement of "no extra Redis memory vs Token Bucket" is satisfied.

#### Clock-skew sensitivity

Zero. Both `now_ms` (from `redis.call('TIME')`) and `last_leak_ms` (written as a Redis-side timestamp) never involve the application clock. Elapsed-time arithmetic (`now_ms - last_leak_ms`) is computed entirely within Lua on Redis-internal values.

#### Burst behaviour

Initial burst up to `capacity` on a cold start. After that, the maximum sustained throughput is `drain_rate` per second. A client that fills the bucket and then continues flooding will receive consistent denials; the drain is continuous, so requests trickle through at exactly the drain rate as capacity is freed.

This is subtly different from Token Bucket under sustained overload: Token Bucket refills tokens even while requests continue (and thus a bursty client can occasionally "cash in" accumulated tokens during a brief lull), whereas Leaky Bucket's water never goes below 0, meaning the bucket must drain before any new credit exists. The drain rate is the hard upper bound on throughput, not just a long-run average.

#### Trade-offs vs Token Bucket

| Dimension | Token Bucket (ADR-001) | Option B (Fill-Level) |
|-----------|----------------------|----------------------|
| Burst | Up to `capacity` (refill credit accumulates during idle) | Up to `capacity` on cold start only; no credit accumulates |
| `remaining` accuracy | Exact | Exact (`capacity - water`) |
| Memory per key | ~100–120 bytes | ~90–110 bytes |
| Lua complexity | Low | Low (identical structure) |
| `capacity` parameter | Directly meaningful (burst ceiling) | Directly meaningful (bucket capacity) |
| Long-run throughput guarantee | Soft — bursty clients can exceed rate momentarily after idle | Hard — drain rate is an absolute ceiling |
| Key namespace | `ratelimit:{domain}:{identifier}` (no sub-prefix today) | `ratelimit:lb:{domain}:{identifier}` |

---

## Recommendation

**Implement Option B: Fill-Level Hash (`water` + `last_leak_ms`).**

The decision rests on four factors:

**Accurate `remaining` without extra state.** `remaining = capacity - new_water` falls directly out of the fill-level model. Option A cannot provide this without a second field, at which point it becomes structurally equivalent to Option B with less clarity. The `X-RateLimit-Remaining` header contract requires an accurate count; approximations are not acceptable.

**`capacity` is meaningful.** The parameter already exists in `rules.yaml` and is passed through the resolver. Option B uses `capacity` directly as the bucket volume, so no new YAML fields are required and no existing fields are repurposed or ignored.

**Memory parity with Token Bucket.** The fill-level Hash costs ~90–110 bytes per key vs Token Bucket's ~100–120 bytes. The "no extra Redis memory" constraint is met.

**Structural consistency.** Option B is a precise mirror of the Token Bucket implementation: a two-field Hash, a `redis.call('TIME')` clock, elapsed-time arithmetic, and TTL bounded by the time for the bucket to reach its neutral state. The algorithm engineer who implemented Token Bucket can implement Option B by substituting drain-down arithmetic for refill-up arithmetic. Tests follow the same pattern. The code review surface is minimal.

**Concrete parameters the algorithm class must accept:**

| Parameter | Type | Meaning |
|-----------|------|---------|
| `capacity` | integer | Maximum bucket volume (also the burst ceiling on cold start) |
| `drain_rate` | float | Units drained per second (analogous to `refill_rate` in Token Bucket) |
| `drain_interval_ms` | integer | Drain tick period in ms. Defaults to 1000. Resolver converts to `drain_rate_per_ms = drain_rate / drain_interval_ms`. |

**Redis key namespace:**

```
ratelimit:lb:{domain}:{identifier}
```

The `lb:` sub-prefix prevents collision with Token Bucket keys under the same domain and identifier. This also resolves Open Question 1 from ADR-001 proactively: Leaky Bucket is the first second algorithm, so the namespace discriminator pattern is established here. A follow-up should backfill a `tb:` prefix to Token Bucket keys in the same release to make the pattern consistent, accepting a brief enforcement gap during key migration (or simply allowing old Token Bucket keys to expire naturally within one refill cycle TTL).

**TTL strategy:**

`PEXPIRE` is set to `ceil(capacity / drain_rate_per_ms)` milliseconds on every allowed write — the time for a full bucket to drain to empty. Denied requests do not write (no state change when water overflows), which means the TTL is only refreshed when a request is actually admitted. A bucket under sustained denial will retain whatever TTL was set on the last allowed request and then expire, resetting the client to a cold-start state. This is the correct behaviour: a client that is being blocked has their bucket expire and get a fresh start, rather than being permanently locked out.

**`rules.yaml` schema extension:**

The `Algorithm` union in `src/rules/loader.ts` must be extended to include `"leaky_bucket"`. The loader must validate `drain_rate` (positive float) and `drain_interval_ms` (positive integer, default 1000), and compute `drain_rate_per_ms` for passing to the Lua script as `ARGV`. Fields `capacity` and `identifier` are shared with Token Bucket and require no change. Existing `token_bucket` rules are unaffected.

Example `rules.yaml` entry for a Leaky Bucket domain:

```yaml
domains:
  sms_gateway:
    algorithm: leaky_bucket
    capacity: 10
    drain_rate: 2
    drain_interval_ms: 1000
    identifier: ip
```

**ARGV layout for the Lua script:**

| Position | Value |
|----------|-------|
| `ARGV[1]` | `capacity` (integer) |
| `ARGV[2]` | `drain_rate_per_ms` (float, computed by resolver) |

`now_ms` is sourced entirely from `redis.call('TIME')` inside Lua. No application-side timestamp is passed as an ARGV argument, because no part of the Leaky Bucket Lua logic has any use for the app clock. This is a deliberate simplification relative to Token Bucket, which passed `now_ms` as `ARGV[3]` (for reference only, per ADR-001 Open Question 5). Leaky Bucket sets the precedent that `ARGV` carries only algorithm parameters, not clock values.

---

## Open Questions

1. **Token Bucket key namespace migration.** Introducing `lb:` as a sub-prefix for Leaky Bucket creates an inconsistency: Token Bucket keys currently use no sub-prefix. Should a `tb:` sub-prefix be added to Token Bucket in the same release? The cost is a brief enforcement gap as old keys expire (one full refill-cycle TTL). The benefit is a consistent, collision-free namespace across all future algorithms. Recommendation: yes, do it in the same release while the number of deployed keys is still small.

2. **Deny-path write decision.** The proposed design does not write on denial (the water would overflow and no state changes). This means a key under sustained flood retains whatever TTL was set by the last allowed request. If the last allowed request was, say, 60 seconds ago and the TTL for a `capacity=10, drain_rate=1/s` bucket is 10 seconds, the key may expire while the flood is in progress, resetting the bucket. Is the "natural expiry resets the client" behaviour acceptable, or should denial paths extend the TTL explicitly? Extending TTL on denial doubles write volume under flood conditions and requires a `PEXPIRE`-only call, adding one extra Redis command to the deny path.

3. **Float precision for `water`.** Like Token Bucket's `tokens` field, `water` is stored as a float string and re-parsed via Lua's `tonumber()` on every call. Repeated drain-and-fill cycles may accumulate floating-point rounding error over millions of requests. Should `water` be stored as integer micro-units (multiply `capacity` and all rates by 1000, store as integers)? This eliminates floating-point entirely from the Lua arithmetic at the cost of requiring callers to configure rates as integers or the resolver to perform the scaling.

4. **`reset_at_ms` semantics on allow.** The proposed value for `reset_at_ms` on allow is the time at which the current water level (`new_water`) will have fully drained to zero — i.e., when the client will next have maximum headroom. An alternative is to return the time at which the next single unit will drain (i.e., when `remaining` increments by 1). The former is more conservative and maps naturally to "when is the rate limit fully reset"; the latter is more useful for clients that want to know when they can make their next request. Which semantic should `X-RateLimit-Reset` convey?

5. **`drain_rate` vs `rate` naming in `rules.yaml`.** Token Bucket uses `refill_rate`. For symmetry, the new field could be called `drain_rate`. However, from an end-user perspective, both algorithms ultimately express "requests per second". A unified field name `rate` (with the algorithm determining whether it is a refill or drain rate) would reduce cognitive overhead in `rules.yaml`. This is a loader/schema concern but affects the parameter API surface of the class. Should the two algorithms share a `rate` field name, or keep algorithm-specific names?
