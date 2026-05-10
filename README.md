# rate-limiter

A production-grade rate limiter library + demo server built with Node.js and TypeScript. No frameworks — raw `node:http` only.

## Features

- **5 algorithms**: Token Bucket, Leaking Bucket, Fixed Window, Sliding Window Log, Sliding Window Counter
- **Atomic operations**: all algorithms use Lua scripts executed inside Redis — no race conditions
- **Rules system**: domain-based rules loaded from YAML (inspired by Lyft's ratelimit), with Redis overrides for dynamic updates
- **Standard headers**: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`

## Architecture

```
Client → Rate Limiter → Server (upstream)
              ↕
            Redis (state + rules override)
              ↑
           rules.yaml (static config)
```

## Prerequisites

- Node.js 20+
- pnpm
- Docker (for Redis)

## Quick Start

```bash
# Start Redis
docker compose up -d

# Install dependencies
pnpm install

# Build
pnpm build

# Start demo server (proxies to upstream)
UPSTREAM_URL=https://httpbin.org pnpm start
```

## Configuration

Rules are defined in `config/rules.yaml`:

```yaml
- domain: global
  descriptors:
    - key: remote_address
      rate_limit:
        unit: minute
        requests_per_unit: 100
        algorithm: sliding_window_counter

- domain: auth
  descriptors:
    - key: auth_type
      value: login
      rate_limit:
        unit: minute
        requests_per_unit: 5
        algorithm: sliding_window_log
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Demo server port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `UPSTREAM_URL` | — | URL to proxy allowed requests to |
| `RULES_PATH` | `config/rules.yaml` | Path to rules config |

## Algorithms

| Algorithm | Best For | Memory |
|---|---|---|
| Token Bucket | Bursty traffic with sustained limit | O(1) per key |
| Leaking Bucket | Smooth output rate | O(1) per key |
| Fixed Window Counter | Simple per-window limits | O(1) per key |
| Sliding Window Log | Precise per-request tracking | O(n) per key |
| Sliding Window Counter | Balance of precision + memory | O(1) per key |

## Dynamic Rule Overrides

Push a rule override into Redis at runtime (no restart needed):

```bash
curl -X POST http://localhost:3000/rules/auth \
  -H 'Content-Type: application/json' \
  -d '{"domain":"auth","descriptors":[{"key":"auth_type","value":"login","rate_limit":{"unit":"minute","requests_per_unit":3,"algorithm":"sliding_window_log"}}]}'
```

## Testing

```bash
pnpm test
```

Tests use real Redis via testcontainers — no mocks.

## Health Check

```bash
curl http://localhost:3000/health
```
