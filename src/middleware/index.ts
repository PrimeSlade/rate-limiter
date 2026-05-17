import type { IncomingMessage, ServerResponse } from "node:http";
import { TokenBucket } from "../algorithms";
import { getRule, extractIdentifier } from "../rules";
import type { DomainRule } from "../rules";

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface RateLimiterOpts {
  domain: string;
}

interface CachedBucket {
  bucket: TokenBucket;
  capacity: number;
  refillRate: number;
  refillIntervalMs: number;
}

// Cache instances by domain — recreated automatically if rule params change via Redis override
const bucketCache = new Map<string, CachedBucket>();

function getBucket(domain: string, rule: DomainRule): TokenBucket {
  const cached = bucketCache.get(domain);
  if (
    cached &&
    cached.capacity === rule.capacity &&
    cached.refillRate === rule.refill_rate &&
    cached.refillIntervalMs === rule.refill_interval_ms
  ) {
    return cached.bucket;
  }

  const bucket = new TokenBucket({
    capacity: rule.capacity,
    refillRate: rule.refill_rate,
    refillIntervalMs: rule.refill_interval_ms,
  });

  bucketCache.set(domain, {
    bucket,
    capacity: rule.capacity,
    refillRate: rule.refill_rate,
    refillIntervalMs: rule.refill_interval_ms,
  });
  return bucket;
}

export function createRateLimiter(
  opts: RateLimiterOpts,
  next: Handler,
): Handler {
  return async (req, res) => {
    let rule: DomainRule;
    try {
      rule = await getRule(opts.domain);
    } catch {
      return next(req, res);
    }

    const identifier = extractIdentifier(rule, req);
    const key = `ratelimit:${opts.domain}:${identifier}`;
    const nowMs = Date.now();

    let result: { allowed: boolean; remaining: number; resetAtMs: number };
    try {
      result = await getBucket(opts.domain, rule).check(key);
    } catch (err) {
      // Redis unavailable — fail open
      console.error(
        "[rate-limiter] Redis error, failing open:",
        (err as Error).message,
      );
      return next(req, res);
    }

    const { allowed, remaining, resetAtMs } = result;

    res.setHeader("X-RateLimit-Limit", rule.capacity);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetAtMs);

    if (!allowed) {
      //calc durations and convert into seconds
      const retryAfter = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      res.setHeader("Retry-After", retryAfter);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too Many Requests", retryAfter }));
      return;
    }

    return next(req, res);
  };
}
