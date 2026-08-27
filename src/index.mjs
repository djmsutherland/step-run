// The harness: ask a model for one part of a decision, validate it, land
// nothing.
//
// Extracted from `@daysprint/intake/src/run.mjs`, which is now an adapter over
// this. Nothing here knows what a "step" decides, what doctrine it reads, or
// where its state lives - those arrive as `buildPrompt`, `addDirs` and
// `createRunState({ dir, kinds })`. What stays here is the part that took
// several rounds of production defects to get right, and that a second
// pipeline would otherwise re-learn by re-experiencing.
export { RUN_TIMEOUT_MS, createRunState } from './state.mjs'
export { issuesText, partJson, readStreamLine } from './parse.mjs'
export { PROPOSAL_TOOLS, askClaude, narrowTools } from './ask.mjs'
export { MAX_ATTEMPTS, runPart, runPartsInParallel } from './part.mjs'
