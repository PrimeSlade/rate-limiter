import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { LeakyBucket } from '../../src/algorithms/leaky-bucket'
import { closeRedis, getRedis } from '../../src/store/redis'

afterAll(async () => {
  await closeRedis()
})

describe('LeakyBucket', () => {
  it('first request — fresh key', async () => {
    const lb = new LeakyBucket({ capacity: 5, drainRate: 5 })
    const key = `test:lb:fresh:${Date.now()}`
    const before = Date.now()

    const result = await lb.check(key)

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
    expect(result.resetAtMs).toBeGreaterThan(before)

    const redis = getRedis()
    const water = await redis.hget(key, 'water')
    const lastLeak = await redis.hget(key, 'last_leak_ms')
    const ttl = await redis.pttl(key)
    expect(water).toBe('1')
    expect(Number(lastLeak)).toBeGreaterThan(0)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(1000)
  })

  it('sustained requests — capacity exhausted', async () => {
    const lb = new LeakyBucket({ capacity: 3, drainRate: 1 })
    const key = `test:lb:exhaust:${Date.now()}`

    const r1 = await lb.check(key)
    const r2 = await lb.check(key)
    const r3 = await lb.check(key)
    const r4 = await lb.check(key)

    expect(r1.allowed).toBe(true)
    expect(r1.remaining).toBe(2)
    expect(r2.allowed).toBe(true)
    expect(r2.remaining).toBe(1)
    expect(r3.allowed).toBe(true)
    expect(r3.remaining).toBe(0)
    expect(r4.allowed).toBe(false)
    expect(r4.remaining).toBe(0)
    expect(r4.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('drain after wait — requests trickle through at drain rate', async () => {
    // drain_rate_per_ms = 5/1000 = 0.005; 200 ms drains 1 unit
    const lb = new LeakyBucket({ capacity: 3, drainRate: 5 })
    const key = `test:lb:drain:${Date.now()}`

    await lb.check(key)
    await lb.check(key)
    await lb.check(key)
    const denied = await lb.check(key)
    expect(denied.allowed).toBe(false)

    await new Promise(r => setTimeout(r, 250))

    const after = await lb.check(key)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBeGreaterThanOrEqual(0)
  }, 10_000)

  it('flood deny path — no Redis writes on denied requests', async () => {
    const lb = new LeakyBucket({ capacity: 2, drainRate: 1 })
    const key = `test:lb:flood:${Date.now()}`
    const redis = getRedis()

    await lb.check(key)
    await lb.check(key)
    const denied = await lb.check(key)
    expect(denied.allowed).toBe(false)

    const pttlBefore = await redis.pttl(key)
    const waterBefore = await redis.hget(key, 'water')
    const lastLeakBefore = await redis.hget(key, 'last_leak_ms')

    const floods = await Promise.all(Array.from({ length: 100 }, () => lb.check(key)))
    expect(floods.every(r => !r.allowed)).toBe(true)

    const pttlAfter = await redis.pttl(key)
    const waterAfter = await redis.hget(key, 'water')
    const lastLeakAfter = await redis.hget(key, 'last_leak_ms')

    expect(pttlAfter).toBeLessThanOrEqual(pttlBefore)
    expect(waterAfter).toBe(waterBefore)
    expect(lastLeakAfter).toBe(lastLeakBefore)
  })

  it('idle key expiry', async () => {
    // capacity=5, drain_rate_per_ms=0.005 → TTL = ceil(5/0.005) = 1000 ms
    const lb = new LeakyBucket({ capacity: 5, drainRate: 5 })
    const key = `test:lb:expiry:${Date.now()}`
    const redis = getRedis()

    await lb.check(key)

    await new Promise(r => setTimeout(r, 1100))

    const exists = await redis.exists(key)
    expect(exists).toBe(0)
  }, 15_000)

  it('sustained overload — throughput never exceeds drain rate', async () => {
    // drain_rate_per_ms = 0.01 → 1 unit per 100 ms
    const lb = new LeakyBucket({ capacity: 10, drainRate: 10 })
    const key = `test:lb:overload:${Date.now()}`

    const burst = await Promise.all(Array.from({ length: 11 }, () => lb.check(key)))
    const burstAllowed = burst.filter(r => r.allowed).length
    expect(burstAllowed).toBe(10)
    expect(burst[10].allowed).toBe(false)

    let sustainedAllowed = 0
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 100))
      const r = await lb.check(key)
      if (r.allowed) sustainedAllowed++
    }
    expect(sustainedAllowed).toBe(5)
  }, 15_000)

  it('clock rollback guard — negative elapsed time does not add water', async () => {
    const lb = new LeakyBucket({ capacity: 5, drainRate: 5 })
    const key = `test:lb:clockrollback:${Date.now()}`
    const redis = getRedis()

    await lb.check(key)

    // Inject a far-future last_leak_ms to simulate clock rollback on next call
    const futureMs = Date.now() + 9_999_999
    await redis.hset(key, 'last_leak_ms', String(futureMs))

    const result = await lb.check(key)

    // elapsed_ms clamped to 0 → current_water stays 1 → new_water = 2 → remaining = 3
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(3)
  })
})
