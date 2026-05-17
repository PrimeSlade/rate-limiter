import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { TokenBucket } from '../../src/algorithms/token-bucket'
import { closeRedis } from '../../src/store/redis'

afterAll(async () => {
  await closeRedis()
})

describe('TokenBucket', () => {
  it('allows first request on a fresh key', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const result = await tb.check(`test:fresh:${Date.now()}`, Date.now())

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
    expect(result.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('blocks when bucket is exhausted', async () => {
    const tb = new TokenBucket({ capacity: 3, refillRate: 1 })
    const key = `test:exhaust:${Date.now()}`
    const now = Date.now()

    await tb.check(key, now)
    await tb.check(key, now + 1)
    await tb.check(key, now + 2)
    const result = await tb.check(key, now + 3)

    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('refills tokens after waiting', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const key = `test:refill:${Date.now()}`
    const now = Date.now()

    for (let i = 0; i < 5; i++) await tb.check(key, now + i)

    await new Promise(r => setTimeout(r, 250))

    const after = await tb.check(key, Date.now())
    expect(after.allowed).toBe(true)
  }, 10_000)

  it('handles concurrent requests — total allowed equals capacity', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const key = `test:concurrent:${Date.now()}`
    const now = Date.now()

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => tb.check(key, now + i))
    )

    const allowed = results.filter(r => r.allowed).length
    expect(allowed).toBe(5)
  })

  it('isolates keys — different clients have independent buckets', async () => {
    const tb = new TokenBucket({ capacity: 2, refillRate: 2 })
    const now = Date.now()
    const suffix = Date.now()

    await tb.check(`test:alice:${suffix}`, now)
    await tb.check(`test:alice:${suffix}`, now + 1)
    const alice = await tb.check(`test:alice:${suffix}`, now + 2)

    const bob = await tb.check(`test:bob:${suffix}`, now + 3)

    expect(alice.allowed).toBe(false)
    expect(bob.allowed).toBe(true)
  })
})
