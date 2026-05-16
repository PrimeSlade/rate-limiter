import { loadScript, evalScript } from "../store/redis";

// KEYS[1]: rate-limit key (e.g. ratelimit:api:192.168.1.1)
// ARGV[1]: capacity          — integer, max tokens
// ARGV[2]: refill_rate_per_ms — float, tokens/ms (converted from tokens/sec by resolver)
// ARGV[3]: now_ms            — app clock, for observability only; NOT used for refill math
// Returns: [allowed (0|1), remaining, reset_at_ms]
export const LUA_SCRIPT = `
local capacity           = tonumber(ARGV[1])
local refill_rate_per_ms = tonumber(ARGV[2])

-- Authoritative clock from Redis — never use ARGV[3] for refill math
local t            = redis.call('TIME')
local redis_now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local ttl_ms = math.ceil(capacity / refill_rate_per_ms)

-- Read existing bucket
local data = redis.call('HGETALL', KEYS[1])

-- Fresh key — first request ever
if #data == 0 then
  local initial_tokens = capacity - 1
  redis.call('HSET', KEYS[1],
    'tokens',         tostring(initial_tokens),
    'last_refill_ms', tostring(redis_now_ms))
  redis.call('PEXPIRE', KEYS[1], ttl_ms)
  local reset_at_ms = redis_now_ms + math.ceil(1 / refill_rate_per_ms)
  return {1, initial_tokens, reset_at_ms}
end

-- Parse flat HGETALL array (field order is not guaranteed)
local stored_tokens  = nil
local last_refill_ms = nil
for i = 1, #data, 2 do
  if data[i] == 'tokens' then
    stored_tokens  = tonumber(data[i + 1])
  elseif data[i] == 'last_refill_ms' then
    last_refill_ms = tonumber(data[i + 1])
  end
end

-- Compute elapsed, capped to prevent accumulation beyond capacity
local elapsed_ms     = redis_now_ms - last_refill_ms
local max_elapsed_ms = capacity / refill_rate_per_ms
if elapsed_ms > max_elapsed_ms then
  elapsed_ms = max_elapsed_ms
end

local new_tokens = math.min(capacity, stored_tokens + elapsed_ms * refill_rate_per_ms)

-- Deny — no write, no TTL reset
if new_tokens < 1 then
  local reset_at_ms = redis_now_ms + math.ceil((1 - new_tokens) / refill_rate_per_ms)
  return {0, 0, reset_at_ms}
end

-- Allow — deduct one token and persist
local write_tokens = new_tokens - 1
redis.call('HSET', KEYS[1],
  'tokens',         tostring(write_tokens),
  'last_refill_ms', tostring(redis_now_ms))
redis.call('PEXPIRE', KEYS[1], ttl_ms)

local reset_at_ms = redis_now_ms + math.ceil((capacity - write_tokens) / refill_rate_per_ms)
return {1, math.floor(write_tokens), reset_at_ms}
`;

export interface TokenBucketOpts {
  /** Maximum tokens the bucket can hold. Also the burst ceiling. */
  capacity: number;

  /** Tokens added per second. Resolver converts to tokens/ms before passing to Lua. */
  refillRate: number;

  /** Refill tick period in ms. Defaults to 1000 (i.e. refillRate = tokens/sec). */
  refillIntervalMs?: number;
}

export class TokenBucket {
  private sha: string | null = null;
  private readonly refillRatePerMs: number;

  constructor(private opts: TokenBucketOpts) {
    const interval = opts.refillIntervalMs ?? 1000;
    this.refillRatePerMs = opts.refillRate / interval;
  }

  async check(
    key: string,
    nowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAtMs: number }> {
    if (!this.sha) {
      this.sha = await loadScript("token-bucket", LUA_SCRIPT);
    }
    const [allowed, remaining, resetAtMs] = await evalScript(
      this.sha,
      LUA_SCRIPT,
      [key],
      [this.opts.capacity, this.refillRatePerMs, nowMs],
    );
    return { allowed: allowed === 1, remaining, resetAtMs };
  }
}
