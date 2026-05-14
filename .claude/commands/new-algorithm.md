# /new-algorithm

Scaffold a new rate-limiting algorithm following the project's algorithm contract. Run this before writing any code.

## Prerequisite

Only run after a Tech Spec (`tech-specs/<NNNN-slug>.md`) has status `APPROVED`. If no approved spec exists, run `/new-proposal` first, then `/new-spec`.

## Usage

```
/new-algorithm <algorithm-name>
```

Example: `/new-algorithm gcra`

## What this does

Creates the algorithm file with the correct structure, stubs, and Lua template, then prints a checklist for the engineer.

## Steps

1. **Confirm the algorithm name** — convert to kebab-case (e.g. `GCRA` → `gcra`, `Token Bucket` → `token-bucket`)

2. **Create `src/algorithms/<name>.ts`** with this structure:

```typescript
import { loadScript, evalScript } from '../store/redis.js'

export const LUA_SCRIPT = `
-- KEYS[1]: rate-limit key
-- ARGV[*]: algorithm params, ARGV[last] = now_ms
-- Returns: [allowed (0|1), remaining, reset_at_ms]

-- TODO: implement
`

export interface <Name>Opts {
  // TODO: define options
}

export class <Name> {
  private sha: string | null = null

  constructor(private opts: <Name>Opts) {}

  async check(key: string, nowMs: number): Promise<{ allowed: boolean; remaining: number; resetAtMs: number }> {
    if (!this.sha) {
      this.sha = await loadScript('<name>', LUA_SCRIPT)
    }
    const [allowed, remaining, resetAtMs] = await evalScript(
      this.sha,
      LUA_SCRIPT,
      [key],
      [/* TODO: ARGV params */, nowMs],
    )
    return { allowed: allowed === 1, remaining, resetAtMs }
  }
}
```

3. **Create `tests/algorithms/<name>.test.ts`** with stubs for the 5 required test cases:
   - Allow under limit
   - Block at limit
   - Reset after window
   - Concurrent requests (parallel, total allowed = limit)
   - Key isolation

4. **Export the class from `src/index.ts`**

5. **Print a checklist** the engineer must complete before submitting for review:

   - [ ] `LUA_SCRIPT` implements the algorithm atomically (single Lua call)
   - [ ] `KEYS[1]` is the rate-limit key; `ARGV` ends with `now_ms`
   - [ ] Lua returns `[allowed (0|1), remaining, reset_at_ms]`
   - [ ] Key TTL is set inside Lua with `redis.call('PEXPIRE', KEYS[1], ttl_ms)`
   - [ ] `tonumber()` called on every `ARGV` value before arithmetic
   - [ ] `<Name>Opts` interface defined and documented
   - [ ] All 5 test cases written and passing (`pnpm test`)
   - [ ] `pnpm build` passes with no TypeScript errors
   - [ ] Algorithm exported from `src/index.ts`
   - [ ] Architect reviewed the Lua script for correctness

## Lua Rules (required for every algorithm)

- Use `redis.call` not `pcall` — let errors propagate
- All reads and writes in a single atomic Lua call — no multi-step round-trips
- Return exactly 3 numbers: `return {allowed, remaining, reset_at_ms}`
- `now_ms` is always the last `ARGV` argument
