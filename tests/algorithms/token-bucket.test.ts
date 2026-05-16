import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import { TokenBucket } from '../../src/algorithms/token-bucket'

let container: StartedTestContainer

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start()

  process.env.REDIS_URL = `redis://localhost:${container.getMappedPort(6379)}`
}, 30_000)

afterAll(async () => {
  await container.stop()
})

describe('TokenBucket', () => {
  it('allows first request on a fresh key', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const result = await tb.check('test:fresh', Date.now())

    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
    expect(result.resetAtMs).toBeGreaterThan(Date.now())
  })

  it('blocks when bucket is exhausted', async () => {
    const tb = new TokenBucket({ capacity: 3, refillRate: 1 })
    const key = 'test:exhaust'
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
    const key = 'test:refill'
    const now = Date.now()

    // exhaust the bucket
    for (let i = 0; i < 5; i++) await tb.check(key, now + i)

    // wait 200ms — should refill 1 token (200ms * 0.005 tokens/ms = 1)
    const after = await tb.check(key, now + 200)
    expect(after.allowed).toBe(true)
  })

  it('handles concurrent requests — total allowed equals capacity', async () => {
    const tb = new TokenBucket({ capacity: 5, refillRate: 5 })
    const key = 'test:concurrent'
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

    // exhaust alice
    await tb.check('test:alice', now)
    await tb.check('test:alice', now + 1)
    const alice = await tb.check('test:alice', now + 2)

    // bob is unaffected
    const bob = await tb.check('test:bob', now + 3)

    expect(alice.allowed).toBe(false)
    expect(bob.allowed).toBe(true)
  })
})
