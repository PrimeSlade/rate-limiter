# /new-spec

Write a Tech Spec from an approved Tech Proposal. Run this after `/new-proposal` is approved.

## Usage

```
/new-spec <NNNN-slug>
```

Example: `/new-spec 0001-gcra-algorithm`

## When to use

After the corresponding Tech Proposal has status `ACCEPTED`. Never write a spec without an approved proposal.

## Steps

1. **Read the approved proposal** at `tech-proposals/<NNNN-slug>.md` to extract the chosen option, goals, and non-goals.

2. **Ask the user these questions** using `AskUserQuestion` before writing anything — collect all answers in one call:
   - Are there existing Redis key patterns or TTL conventions that must be reused?
   - What are the exact `opts` the algorithm class should accept (limit, window, burst, etc.)?
   - Are there edge cases you want explicitly handled (e.g. zero remaining, clock rollback, Redis restart)?
   - Are there open questions from the proposal that have since been resolved?

3. **Invoke the `architect` subagent** with the proposal content and user answers to write the spec at `tech-specs/<NNNN-slug>.md`. The architect must:
   - Reference the proposal in the frontmatter (`proposal: PROP-NNNN`)
   - Provide the complete file map (every file to create or modify)
   - Define the full TypeScript interface: `Opts`, class constructor, `check()` signature
   - Write the Lua script pseudocode or actual implementation with line-by-line commentary
   - Define the Redis key pattern and TTL strategy
   - Write a complete test plan (one row per test case, covering the 5 required cases)
   - Set `status: DRAFT` initially

4. **After the architect writes the draft**, ask the user: "Does the interface design and Lua pseudocode look right, or are there edge cases missing?" Apply any corrections before finalizing.

5. **Print a review checklist** before the spec moves to `APPROVED`:

   - [ ] References the approved proposal
   - [ ] File map is complete — algorithm file, test file, index.ts export
   - [ ] TypeScript interface fully defined (Opts, class, check() return type)
   - [ ] Lua script pseudocode covers: read state, compute, write state, set TTL, return result
   - [ ] Redis key pattern documented with example
   - [ ] Test plan has one entry per required test case
   - [ ] Out of scope section filled in
   - [ ] All Lua atomicity invariants preserved

6. **Remind**: once approved, run `/new-algorithm <name>` to scaffold the files, then hand the spec to the `algorithm-engineer` subagent to implement.
