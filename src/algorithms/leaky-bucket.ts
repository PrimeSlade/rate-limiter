import { loadScript, evalScript } from "../store/redis";

// KEYS[1]: rate-limit key (e.g. ratelimit:lb:sms_gateway:192.168.1.1)
// ARGV[1]: capacity          — integer, max bucket volume in units
// ARGV[2]: drain_rate_per_ms — float, units/ms (converted from units/sec by resolver)
// Returns: [allowed (0|1), remaining, reset_at_ms]
export const LUA_SCRIPT = `
local capacity          = tonumber(ARGV[1])
local drain_rate_per_ms = tonumber(ARGV[2])

local t      = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local ttl_ms = math.ceil(capacity / drain_rate_per_ms)

local data = redis.call('HGETALL', KEYS[1])

if #data == 0 then
  redis.call('HSET', KEYS[1],
    'water',        '1',
    'last_leak_ms', tostring(now_ms))
  redis.call('PEXPIRE', KEYS[1], ttl_ms)
  local reset_at_ms = now_ms + math.ceil(1 / drain_rate_per_ms)
  return {1, capacity - 1, reset_at_ms}
end

local stored_water = nil
local last_leak_ms = nil
for i = 1, #data, 2 do
  if data[i] == 'water' then
    stored_water = tonumber(data[i + 1])
  elseif data[i] == 'last_leak_ms' then
    last_leak_ms = tonumber(data[i + 1])
  end
end

local elapsed_ms = now_ms - last_leak_ms
if elapsed_ms < 0 then
  elapsed_ms = 0
end

local leaked        = elapsed_ms * drain_rate_per_ms
local current_water = math.max(0, stored_water - leaked)

if current_water + 1 > capacity then
  local reset_at_ms = now_ms + math.ceil((current_water + 1 - capacity) / drain_rate_per_ms)
  return {0, 0, reset_at_ms}
end

local new_water = current_water + 1
redis.call('HSET', KEYS[1],
  'water',        tostring(new_water),
  'last_leak_ms', tostring(now_ms))
redis.call('PEXPIRE', KEYS[1], ttl_ms)

local reset_at_ms = now_ms + math.ceil(new_water / drain_rate_per_ms)
return {1, math.floor(capacity - new_water), reset_at_ms}
`;

export interface LeakyBucketOpts {
  /** Maximum fill level of the bucket in units (one unit = one request). Burst ceiling on cold start. */
  capacity: number;

  /** Units drained per second. Resolver converts to units/ms before passing to Lua. */
  drainRate: number;

  /** Drain tick period in ms. Defaults to 1000 (drainRate is units/sec). */
  drainIntervalMs?: number;
}

export class LeakyBucket {
  private sha: string | null = null;
  private readonly drainRatePerMs: number;

  constructor(private opts: LeakyBucketOpts) {
    const interval = opts.drainIntervalMs ?? 1000;
    this.drainRatePerMs = opts.drainRate / interval;
  }

  async check(
    key: string,
  ): Promise<{ allowed: boolean; remaining: number; resetAtMs: number }> {
    if (!this.sha) {
      this.sha = await loadScript("leaky-bucket", LUA_SCRIPT);
    }
    const [allowed, remaining, resetAtMs] = await evalScript(
      this.sha,
      LUA_SCRIPT,
      [key],
      [this.opts.capacity, this.drainRatePerMs],
    );
    return { allowed: allowed === 1, remaining, resetAtMs };
  }
}
