// Plain in-memory Token Bucket — no Redis, no Lua.
// Run with: npx tsx demo/token-bucket.ts

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

const capacity = 5; // max tokens the bucket can hold
const refillRatePerMs = 0.005; // 5 tokens per second = 0.005 per ms

// One bucket per client key (in Redis this would be a Hash per key)
const store = new Map<string, Bucket>();

function check(key: string, nowMs: number): CheckResult {
  const ttlMs = Math.ceil(capacity / refillRatePerMs); // 1000ms

  // Step 1: read existing bucket (or treat as fresh)
  const existing = store.get(key);

  // Step 2: fresh key — first request ever
  if (!existing) {
    store.set(key, { tokens: capacity - 1, lastRefillMs: nowMs });
    return {
      allowed: true,
      remaining: capacity - 1,
      resetAtMs: nowMs + Math.ceil(1 / refillRatePerMs),
    };
  }

  // Step 3: compute how much time has passed
  let elapsedMs = nowMs - existing.lastRefillMs;

  // Step 4: cap elapsed so we never accumulate more than capacity tokens
  const maxElapsedMs = capacity / refillRatePerMs;
  if (elapsedMs > maxElapsedMs) {
    elapsedMs = maxElapsedMs;
  }

  // Step 5: refill — add tokens proportional to elapsed time
  const newTokens = Math.min(
    capacity,
    existing.tokens + elapsedMs * refillRatePerMs,
  );

  // Step 6: deny — not enough tokens
  if (newTokens < 1) {
    // no write to store on deny
    return {
      allowed: false,
      remaining: 0,
      resetAtMs: nowMs + Math.ceil((1 - newTokens) / refillRatePerMs),
    };
  }

  // Step 7: allow — deduct one token and save
  const writeTokens = newTokens - 1;
  store.set(key, { tokens: writeTokens, lastRefillMs: nowMs });

  return {
    allowed: true,
    remaining: Math.floor(writeTokens),
    resetAtMs: nowMs + Math.ceil((capacity - writeTokens) / refillRatePerMs),
  };
}

// ── Demo ──────────────────────────────────────────────────────────────────────

const key = "user:alice";

console.log("--- Burst: 7 rapid requests (capacity=5) ---");
let now = Date.now();
for (let i = 1; i <= 7; i++) {
  const result = check(key, now + i); // +i to simulate tiny time gaps
  console.log(
    `Request ${i}: allowed=${result.allowed} remaining=${result.remaining}`,
  );
}

console.log("\n--- Wait 600ms (should refill ~3 tokens) ---");
now = now + 600;
const result = check(key, now);
console.log(
  `After 600ms: allowed=${result.allowed} remaining=${result.remaining}`,
);

console.log(
  "\n--- Wait 2000ms (longer than full TTL, bucket fully refilled) ---",
);
now = now + 2000;
const result2 = check(key, now);
console.log(
  `After 2000ms: allowed=${result2.allowed} remaining=${result2.remaining}`,
);
