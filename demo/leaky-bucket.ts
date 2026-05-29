// Plain in-memory Leaky Bucket (fill-level hash design) — no Redis, no Lua.
// Run with: npx tsx demo/leaky-bucket.ts

interface Bucket {
  water: number;
  lastLeakMs: number;
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

const capacity = 5; // max bucket volume in units (one unit = one request)
const drainRatePerMs = 0.005; // 5 units per second = 0.005 per ms

// One bucket per client key (in Redis this would be a Hash per key)
const store = new Map<string, Bucket>();

function check(key: string, nowMs: number): CheckResult {
  // Step 1: fresh key — first request into an empty bucket
  const existing = store.get(key);
  if (!existing) {
    store.set(key, { water: 1, lastLeakMs: nowMs });
    return {
      allowed: true,
      remaining: capacity - 1,
      resetAtMs: nowMs + Math.ceil(1 / drainRatePerMs),
    };
  }

  // Step 2: compute elapsed time; clamp to 0 to guard against clock rollback
  let elapsedMs = nowMs - existing.lastLeakMs;
  if (elapsedMs < 0) elapsedMs = 0;

  // Step 3: drain — water level drops proportional to elapsed time, floor at 0
  const leaked = elapsedMs * drainRatePerMs;
  const currentWater = Math.max(0, existing.water - leaked);

  // Step 4: deny — adding one unit would overflow the bucket; no write on deny
  if (currentWater + 1 > capacity) {
    return {
      allowed: false,
      remaining: 0,
      resetAtMs:
        nowMs + Math.ceil((currentWater + 1 - capacity) / drainRatePerMs),
    };
  }

  // Step 5: allow — add one unit of water and save
  const newWater = currentWater + 1;
  store.set(key, { water: newWater, lastLeakMs: nowMs });

  return {
    allowed: true,
    remaining: Math.floor(capacity - newWater),
    resetAtMs: nowMs + Math.ceil(newWater / drainRatePerMs),
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

console.log("\n--- Wait 600ms (should drain ~3 units) ---");
now = now + 600;
const result = check(key, now);
console.log(
  `After 600ms: allowed=${result.allowed} remaining=${result.remaining}`,
);

console.log(
  "\n--- Wait 2000ms (longer than full TTL, bucket fully drained) ---",
);
now = now + 2000;
const result2 = check(key, now);
console.log(
  `After 2000ms: allowed=${result2.allowed} remaining=${result2.remaining}`,
);
