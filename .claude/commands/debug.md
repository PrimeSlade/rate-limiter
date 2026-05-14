# /debug

Scientific debugging workflow — hypothesis, reproduce, fix, regression test. Never skip steps.

## Usage

```
/debug <description of the bug>
```

Example: `/debug sliding window counter allows 2x the limit under concurrent load`

## Steps

### 1. Understand before touching code

- Restate the bug in your own words: what the caller observes vs. what should happen
- Identify the affected layer: algorithm Lua script, Redis store, rule resolver, or middleware
- Check recent commits (`git log --oneline -20`) for related changes
- Check `src/store/redis.ts` — NOSCRIPT recovery bugs are a common source of double-execution

### 2. Reproduce

- Write the exact steps to reproduce: algorithm, limit, window, request count, timing
- For concurrency bugs, write a Vitest test that fires N parallel requests and asserts on `remaining`
- Confirm the bug is reproducible before proceeding — if not, say so and stop
- For Lua bugs, reproduce with `redis-cli EVAL` directly before touching TypeScript

### 3. Hypotheses (list at least 2)

For each hypothesis:
- State what you think is wrong
- Cite the specific file and line range (Lua line numbers matter too)
- Describe the test that would confirm or refute it

Work through hypotheses cheapest-first: read Lua before running Redis before running testcontainers.

Common culprits:
| Symptom | Likely cause |
|---------|-------------|
| Limit exceeded under concurrency | Non-atomic read-modify-write (multi-step instead of single Lua call) |
| Counter never resets | TTL not set inside Lua, or set with wrong unit (seconds vs ms) |
| `remaining` goes negative | `math.max` missing in Lua after decrement |
| NOSCRIPT errors in prod | Script flushed — `evalScript` retry path has a bug (`scriptCache.set(sha, newSha)` wrong key) |
| Rules not applying | Redis override key format wrong, or JSON parse failing silently |

### 4. Fix

- Make the minimal change that fixes the root cause — no opportunistic cleanup
- If the fix is in Lua, update the `LUA_SCRIPT` constant in the algorithm file
- If the fix is in the store, verify `evalScript` NOSCRIPT recovery still works after the change
- If the fix touches key construction, audit all callers for injection risk

### 5. Regression test

- Write a Vitest test that fails on the unfixed code and passes on the fixed code
- Use real Redis via `@testcontainers/redis` — never mock
- For timing bugs, control `nowMs` explicitly rather than relying on `Date.now()`
- Add the test before marking the bug fixed

### 6. Handoff

- If the root cause reveals a systemic issue (e.g. all algorithms share the same Lua pattern flaw), flag it — do not silently fix one instance

## Rules

- Never delete a failing test to make CI green
- Never catch and suppress a Redis error to make a crash go away
- If you cannot reproduce the bug, say so — do not guess-fix
- Always run `pnpm test` after the fix to confirm no regressions
