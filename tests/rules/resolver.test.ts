import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Socket } from 'node:net'
import { IncomingMessage } from 'node:http'
import { loadRules, clearRulesCache, extractIdentifier } from '../../src/rules'
import type { DomainRule } from '../../src/rules'

const TMP = resolve('/tmp/rate-limiter-test-rules')

function writeYaml(content: string): string {
  mkdirSync(TMP, { recursive: true })
  const path = resolve(TMP, 'rules.yaml')
  writeFileSync(path, content, 'utf8')
  return path
}

function makeRequest(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress })
  const req = new IncomingMessage(socket)
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  return req
}

beforeEach(() => clearRulesCache())
afterEach(() => { try { rmSync(TMP, { recursive: true }) } catch {} })

describe('loadRules', () => {
  it('loads a valid config with defaults applied', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 100
    refill_rate: 10
    identifier: ip
`)
    const config = loadRules(path)
    expect(config.domains.api).toMatchObject({
      algorithm: 'token_bucket',
      capacity: 100,
      refill_rate: 10,
      refill_interval_ms: 1000,
      identifier: 'ip',
    })
  })

  it('respects explicit refill_interval_ms', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 50
    refill_rate: 5
    refill_interval_ms: 500
    identifier: ip
`)
    const config = loadRules(path)
    expect(config.domains.api.refill_interval_ms).toBe(500)
  })

  it('caches after first load', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 10
    refill_rate: 1
    identifier: ip
`)
    const a = loadRules(path)
    const b = loadRules(path)
    expect(a).toBe(b)
  })

  it('throws on missing domains key', () => {
    const path = writeYaml('algorithm: token_bucket')
    expect(() => loadRules(path)).toThrow(/domains/)
  })

  it('throws on unknown algorithm', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: leaky_bucket
    capacity: 10
    refill_rate: 1
    identifier: ip
`)
    expect(() => loadRules(path)).toThrow(/unknown algorithm/)
  })

  it('throws on non-positive capacity', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 0
    refill_rate: 1
    identifier: ip
`)
    expect(() => loadRules(path)).toThrow(/capacity/)
  })

  it('throws on non-positive refill_rate', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 10
    refill_rate: -1
    identifier: ip
`)
    expect(() => loadRules(path)).toThrow(/refill_rate/)
  })

  it('throws on missing identifier', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 10
    refill_rate: 1
`)
    expect(() => loadRules(path)).toThrow(/identifier/)
  })

  it('loads multiple domains', () => {
    const path = writeYaml(`
domains:
  api:
    algorithm: token_bucket
    capacity: 100
    refill_rate: 10
    identifier: ip
  payments:
    algorithm: token_bucket
    capacity: 20
    refill_rate: 2
    identifier: ip
`)
    const config = loadRules(path)
    expect(Object.keys(config.domains)).toEqual(['api', 'payments'])
  })
})

describe('extractIdentifier', () => {
  const baseRule: DomainRule = {
    algorithm: 'token_bucket',
    capacity: 100,
    refill_rate: 10,
    refill_interval_ms: 1000,
    identifier: 'ip',
  }

  it('extracts remote IP address', () => {
    const req = makeRequest('203.0.113.42')
    expect(extractIdentifier(baseRule, req)).toBe('203.0.113.42')
  })

  it('falls back to 0.0.0.0 when remoteAddress is undefined', () => {
    const socket = new Socket()
    Object.defineProperty(socket, 'remoteAddress', { value: undefined })
    const req = new IncomingMessage(socket)
    expect(extractIdentifier(baseRule, req)).toBe('0.0.0.0')
  })

  it('extracts a named header', () => {
    const rule = { ...baseRule, identifier: 'header:X-User-Id' }
    const req = makeRequest('127.0.0.1', { 'x-user-id': 'user-42' })
    expect(extractIdentifier(rule, req)).toBe('user-42')
  })

  it('is case-insensitive for header names', () => {
    const rule = { ...baseRule, identifier: 'header:X-User-Id' }
    const req = makeRequest('127.0.0.1', { 'x-user-id': 'abc' })
    expect(extractIdentifier(rule, req)).toBe('abc')
  })

  it('returns "unknown" for missing header', () => {
    const rule = { ...baseRule, identifier: 'header:X-User-Id' }
    const req = makeRequest('127.0.0.1')
    expect(extractIdentifier(rule, req)).toBe('unknown')
  })

  it('throws on unrecognised identifier strategy', () => {
    const rule = { ...baseRule, identifier: 'cookie:session' }
    const req = makeRequest('127.0.0.1')
    expect(() => extractIdentifier(rule, req)).toThrow(/Unknown identifier strategy/)
  })
})
