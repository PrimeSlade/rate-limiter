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
    const result = await tb.check(`test:fresh:${Date.now()}`)

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
    expect(result.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('blocks when bucket is exhausted', async () => {
    const tb = new TokenBucket({ capacity: 3, refillRate: 1 })
    const key = `test:exhaust:${Date.now()}`

    await tb.check(key)
    await tb.check(key)
    await tb.check(key)
    const result = await tb.check(key)

    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('refills tokens after waiting', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const key = `test:refill:${Date.now()}`

    for (let i = 0; i < 5; i++) await tb.check(key)

    await new Promise(r => setTimeout(r, 250))

    const after = await tb.check(key)
    expect(after.allowed).toBe(true)
  }, 10_000)

  it('handles concurrent requests — total allowed equals capacity', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const key = `test:concurrent:${Date.now()}`

    const results = await Promise.all(
      Array.from({ length: 8 }, () => tb.check(key))
    )

    const allowed = results.filter(r => r.allowed).length
    expect(allowed).toBe(5)
  })

  it('isolates keys — different clients have independent buckets', async () => {
    const tb = new TokenBucket({ capacity: 2, refillRate: 2 })
    const suffix = Date.now()

    await tb.check(`test:alice:${suffix}`)
    await tb.check(`test:alice:${suffix}`)
    const alice = await tb.check(`test:alice:${suffix}`)

    const bob = await tb.check(`test:bob:${suffix}`)

    expect(alice.allowed).toBe(false)
    expect(bob.allowed).toBe(true)
  })
})
