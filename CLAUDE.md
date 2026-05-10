# CLAUDE.md

## Project

Rate limiter library + demo server in Node.js/TypeScript. No HTTP frameworks — raw `node:http` / `node:https` only.

## Package Manager

Always use `pnpm`. Never use `npm`.

## Tech Stack

- **Runtime**: Node.js 20 + TypeScript 5
- **Redis client**: ioredis
- **YAML**: js-yaml
- **Tests**: Vitest + @testcontainers/redis (real Redis, no mocks)
- **Build**: tsc → `dist/`

## Key Architecture Decisions

- **Lua scripts** run inside Redis for atomicity — all algorithm state transitions (read → compute → write) happen in a single atomic Lua call via `EVALSHA`
- **Rules** are loaded from `config/rules.yaml` at startup; Redis overrides at key `ratelimit:rules:{domain}` take precedence
- **Middleware** wraps a raw `(req, res)` handler — signature is `createRateLimiter(opts, next): Handler`
- **Inline Lua** — Lua scripts are template literal strings inside each algorithm's `.ts` file, not separate files

## Directory Structure

```
src/
  algorithms/     # 5 algorithm classes (each embeds its own Lua script)
  rules/          # YAML loader, Redis override loader, rule resolver
  store/          # ioredis singleton + EVALSHA wrapper
  middleware/     # createRateLimiter() handler wrapper
  index.ts        # library entry point
server/
  index.ts        # demo http.createServer reverse proxy
config/
  rules.yaml      # example domain rules
tests/
  algorithms/     # one test file per algorithm (real Redis via testcontainers)
  rules/          # resolver unit tests (no Redis)
```

## Scripts

```bash
pnpm build    # tsc
pnpm start    # node dist/server/index.js
pnpm dev      # ts-node server/index.ts (or tsx)
pnpm test     # vitest
```

## Response Headers

All rate-limited responses must set:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset` (Unix ms)
- `Retry-After` (seconds, on 429 only)

## Lua Script Convention

Each algorithm file exports a `LUA_SCRIPT` constant and a class.  
Scripts always receive:
- `KEYS[1]` — the rate-limit Redis key
- `ARGV` — algorithm-specific numeric parameters + `now_ms` as last arg

Scripts always return `{allowed: 0|1, remaining: number, reset_at_ms: number}` as a flat array `[allowed, remaining, reset_at_ms]`.
