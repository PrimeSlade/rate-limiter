# /new-proposal

Write a new Tech Proposal before any design or implementation begins.

## Usage

```
/new-proposal <feature-or-change-name>
```

Example: `/new-proposal gcra-algorithm`

## When to use

Any change that introduces a new algorithm, modifies the Redis key schema, changes the middleware API, introduces a new dependency, or where multiple valid approaches exist. Skip only if the change touches ≤ 2 files with zero architectural impact.

## Steps

1. **Determine the next proposal number** — check `tech-proposals/` and increment the highest NNNN by 1. Create the directory if it doesn't exist.

2. **Convert the feature name** to kebab-case (e.g. `GCRA Algorithm` → `gcra-algorithm`).

3. **Ask the user these questions** using `AskUserQuestion` before writing anything — collect all answers in one call:
   - What problem does this change solve, and who is affected?
   - Are there constraints the solution must meet (atomicity, Redis memory, clock accuracy, backwards compatibility)?
   - Do you have a preferred approach in mind, or should the architect explore options freely?
   - Are there any approaches you want to explicitly rule out?

4. **Invoke the `architect` subagent** with the user's answers as context to write the proposal file at `tech-proposals/NNNN-<slug>.md`. The architect must:
   - Fill every section: Problem, Goals, Non-goals, Options (at least 2), Recommendation, Open questions
   - Set `status: DRAFT` initially
   - For algorithm proposals: compare time complexity, Redis memory usage, and sensitivity to clock skew for each option
   - For schema proposals: show the key pattern, TTL strategy, and eviction implications for each option
   - If the user ruled out any approaches, document them as rejected options with the reason
   - Include a clear recommendation with justification

5. **After the architect writes the draft**, ask the user: "Does this capture the problem correctly, or should anything be adjusted before it goes to review?" Apply any corrections before moving on.

6. **Print a review checklist** before the proposal moves to `PROPOSED`:

   - [ ] Problem statement is specific and includes measurable impact
   - [ ] At least 2 options with Redis memory, latency, and clock-skew analysis
   - [ ] Recommendation justified in terms of trade-offs
   - [ ] Lua atomicity constraints respected in all options
   - [ ] Open questions listed
   - [ ] No implementation code or file-level details (those belong in the spec)

7. **Remind**: once approved, run `/new-spec <NNNN-slug>` to write the Tech Spec. Do not begin implementation until the spec is also approved.
