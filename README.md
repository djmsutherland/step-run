# step-run

Ask a model for **one part of a decision**, validate it against a schema, retry
once against the error, and **write nothing**.

Extracted from `@daysprint/intake/src/run.mjs`, which is now a 226-line adapter
over this. Dependency-free — not even a schema library.

## Why it is a package

Every branch in `state.mjs` and `part.mjs` is a defect that actually happened in
production: pids recycled across a reboot wedging a step forever, `Number('')`
being `0` so `process.kill(0, 0)` signals your own process group and always
succeeds, a retry appending onto the previous attempt's log so a success got
reported as a failure, a good draft discarded because the *forced retry* failed
for an unrelated reason.

A second pipeline that copied this file would re-live every one of them. That is
the whole argument for sharing it and nothing else.

## What is injected, and what is not

| Injected | Why it is not ours |
| --- | --- |
| `buildPrompt({ part, priorError })` | The prompt names a pipeline's own doctrine — which playbooks to read, what was already decided. |
| `ask({ prompt, onToken })` | So a test can hand a double, and a caller can add its own transport concerns. |
| `createRunState({ dir, kinds })` | A pipeline for books has different run kinds and no business putting state in a directory named after someone else's company. |
| `part.schema` | Structural `safeParse`. zod satisfies it; so does anything else. |

Everything else is the mechanism and is **not** configurable, because none of it
is a preference:

- **Two attempts.** A loop that keeps asking eventually accepts noise.
- **The retry carries the error**, not "your answer was wrong". A model handed
  `palette.muted: contrast 2.04:1 — AA needs 4.5:1` can fix the actual thing.
- **Three distinct retry reasons** (`json` / `schema` / `gate`) on `onProgress`,
  because reporting all three as "rejected by the schema" is a false diagnosis
  for two of them.
- **A schema-valid draft is never lost.** Once one exists it survives a
  transport failure, an unparsable answer *and* a schema rejection on the forced
  retry — three doors into one bug, all closed.
- **Still red on the last attempt lands anyway, flagged** via `notYetGreen`.
  Never silently dropped, never silently passed.

## The one knob that only turns one way

`PROPOSAL_TOOLS` is `Read/Grep/Glob/WebSearch/WebFetch` and denies
`Write/Edit/NotebookEdit/Bash`. A consumer may **narrow** that (`narrowTools`),
never widen it — `narrowTools(['Read','Write'])` throws.

The no-writer property is the whole reason this harness is safe to point at a
repo. A knob that can turn it off is a knob that eventually will be.

## Using it

```js
import { createRunState, runPart } from 'step-run'

const state = createRunState({
  dir: () => join(process.env.HOME, '.storyforge/runs'),  // a thunk: see below
  kinds: ['draft'],
})

const r = await runPart({
  part: { key: 'spreads', title: 'Pagination', schema: spreadsSchema, asks: '…', shape: '…', why: '…' },
  buildPrompt: ({ part, priorError }) => myPrompt(part, priorError),
  ask: ({ prompt, onToken }) => askClaude({ prompt, cwd: bookDir, addDirs: [playbooks], onToken }),
  check: (v) => continuityIssues(v),   // the green gate, on the same retry budget
})
// r: { ok, value, attempts, why, notYetGreen }
```

**`dir` should be a thunk whenever it derives from the environment.** Resolving
it once at construction ignores a test that redirects `HOME`, and writes into
the real home directory during a test run.

**The first kind is the default** and gets no filename suffix, so markers
already on disk keep meaning what they always meant.

## Tests

`pnpm test` — 41 cases. No install needed: the package has no dependencies. `part.test.mjs` deliberately uses a hand-rolled
`safeParse` rather than zod: it proves the duck-typed contract, and keeps the
tests about the loop rather than someone else's validator.
