import Redis from 'ioredis'

let client: Redis | null = null
const scriptCache = new Map<string, string>()

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    })

    client.on('error', (err) => {
      console.error('[redis] error:', err.message)
    })
  }
  return client
}

export async function loadScript(name: string, lua: string): Promise<string> {
  if (scriptCache.has(name)) {
    return scriptCache.get(name)!
  }
  const sha = await getRedis().call('SCRIPT', 'LOAD', lua) as string
  scriptCache.set(name, sha)
  return sha
}

export async function evalScript(
  sha: string,
  lua: string,
  keys: string[],
  args: (string | number)[]
): Promise<[number, number, number]> {
  const redis = getRedis()
  try {
    const result = await redis.evalsha(sha, keys.length, ...keys, ...args.map(String))
    return result as [number, number, number]
  } catch (err: any) {
    if (err.message?.includes('NOSCRIPT')) {
      // Script was flushed from Redis — reload and retry
      const newSha = await redis.call('SCRIPT', 'LOAD', lua) as string
      scriptCache.set(sha, newSha)
      const result = await redis.evalsha(newSha, keys.length, ...keys, ...args.map(String))
      return result as [number, number, number]
    }
    throw err
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
