# /pr-review

Orchestrated PR review — runs all reviewer agents in the correct order and collects sign-offs.

## Usage

```
/pr-review <PR number or branch name>
```

Example: `/pr-review 7` or `/pr-review feat/token-bucket`

## What this does

Fans out to three reviewer agents in parallel, waits for all reports, then produces a merged verdict. The engineer who wrote the code must NOT run this on their own PR.

## Steps

1. **Fetch the diff** — run `git diff main...<branch>` (or fetch the PR diff if a PR number is given). Summarise: files changed, lines added/removed, algorithms/modules touched.

2. **Fan out in parallel** — invoke all three reviewers with the diff as context:

   - `@security-reviewer` — bypass vectors, Lua injection, header leakage, Redis key spoofing, NOSCRIPT retry amplification
   - `@qa-engineer` — coverage gaps, missing test cases (concurrent requests, reset-after-window), flaky timing assertions
   - `@architect` — module boundary violations, Lua atomicity invariants, Lua script contract compliance, key schema consistency

3. **Wait for all three reports.** Each agent produces structured findings.

4. **Merge the verdicts**:

   | Agent | Verdict | Blocking findings |
   |-------|---------|-------------------|
   | security-reviewer | | |
   | qa-engineer | | |
   | architect | | |

5. **Overall verdict**:
   - **APPROVED** — all three passed, zero blocking findings
   - **CHANGES REQUESTED** — list every blocking finding with the owning agent and required fix
   - **BLOCKED** — any CRITICAL security finding or Lua atomicity violation

6. **Post the merged report** to the PR description (or print it for the human to paste).

## Blocking Rules

- Never approve a PR where `now_ms` can come from request input (clock manipulation vector)
- Never approve a PR with a multi-step Redis round-trip replacing a Lua call
- Never approve a PR missing tests for concurrent requests and post-window reset
- Never approve a PR where `X-RateLimit-Reset` leaks internal key paths or domain names
- Architecture violations (algorithm calling Redis outside of `evalScript`) are always blocking
