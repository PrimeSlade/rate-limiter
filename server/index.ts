import 'dotenv/config'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRateLimiter, loadRules } from '../src'
import type { Handler } from '../src'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://localhost:8080'

function proxy(req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(req.url ?? '/', UPSTREAM)
  const isHttps = target.protocol === 'https:'
  const requestFn = isHttps ? httpsRequest : httpRequest

  const proxyReq = requestFn(
    {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...req.headers, host: target.hostname },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )

  proxyReq.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad Gateway' }))
    }
  })

  req.pipe(proxyReq)
}

// Pre-build one rate-limited handler per domain at startup
const config = loadRules()
const domainHandlers = new Map<string, Handler>()
for (const domain of Object.keys(config.domains)) {
  domainHandlers.set(domain, createRateLimiter({ domain }, proxy))
}

const server = createServer((req, res) => {
  // Route by first path segment: /api/foo → domain "api"
  const segment = (req.url ?? '/').split('/')[1]
  const handler = domainHandlers.get(segment) ?? proxy
  handler(req, res)
})

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
  console.log(`[server] upstream: ${UPSTREAM}`)
  console.log(`[server] rate-limited domains: ${[...domainHandlers.keys()].join(', ')}`)
})
