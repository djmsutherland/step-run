// Generate one part, validate it, retry ONCE against the error.
//
// Lifted from `@daysprint/intake/src/run.mjs`. THE SEAM IS THE PROMPT: the
// original built its own, naming daysprint's playbooks and the package a
// client bought. That is doctrine, not mechanism, so it stays with the
// pipeline that owns it and arrives here as `buildPrompt`. Everything else -
// the two-attempt budget, the three retry reasons, the last-good fallback -
// is the mechanism, and is identical to what the studio has been running.
import { partJson, issuesText } from './parse.mjs'

/** ONE RETRY, WITH THE ERROR. A model handed "your answer was wrong" learns
 *  nothing; handed "palette.muted: contrast muted on bg is 2.04:1 - WCAG AA
 *  needs 4.5:1" it can fix the actual thing. Two failures is a failure,
 *  because a loop that keeps asking is a loop that eventually accepts noise. */
export const MAX_ATTEMPTS = 2

/** Generate one part, validate it, and retry once against the error.
 *
 *  `buildPrompt({ part, priorError })` returns the prompt for one attempt.
 *  `ask({ prompt, onToken })` returns `{ ok, text, error }`.
 *
 *  `check(value)` is THE GREEN GATE, moved earlier: after the schema passes,
 *  it runs too, and returns an array of issue strings - empty means clean. A
 *  non-empty result on attempt 1 is fed back through the SAME `priorError`
 *  channel a schema failure uses, spending the same retry budget - no separate
 *  counter, no new failure-handling path. Still red on the last attempt, it is
 *  not a failure: the value is returned `ok: true` with `notYetGreen` set, so
 *  the caller lands it anyway, FLAGGED rather than silently dropped or
 *  silently passed.
 *
 *  THE FORCED RETRY CAN FAIL FOR A REASON THAT HAS NOTHING TO DO WITH THE
 *  DRAFT ALREADY IN HAND - a transport failure, an unparsable answer, or a
 *  schema rejection. `lastGood` remembers the most recent schema-valid draft
 *  (gated or not), and EVERY path this function would otherwise return
 *  `ok: false` on checks it first. Two prior rounds on this each closed only
 *  one of those doors; losing the good draft to a parse failure is the same
 *  defect as losing it to a transport failure, just a different door into it.
 *
 *  Returns `{ ok, value, attempts, why, notYetGreen }`. NEVER WRITES ANYTHING -
 *  the caller decides, which keeps the run read-only all the way through. */
export async function runPart({ part, buildPrompt, ask, check = null, onProgress = () => {}, onToken = () => {} }) {
  let priorError = null
  // WHY the prior attempt is being retried, not just THAT it is. `onProgress`
  // fires at the START of an attempt, before that attempt's own outcome
  // exists - but by then the PREVIOUS attempt's outcome is known, and this is
  // what tells the caller which of three different things happened: no JSON
  // came back, the schema rejected the shape, or the gate was still red.
  // Before this, every retry announced itself as "rejected by the schema"
  // regardless of which - a false diagnosis for the other two.
  let priorKind = null
  const attempts = []
  // Set the moment an attempt is schema-valid but gate-flagged, and never
  // cleared - the fallback of last resort for every failure mode a later
  // attempt can hit.
  let lastGood = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onProgress({ attempt, part: part.key, reason: priorKind })
    const prompt = buildPrompt({ part, priorError })
    const res = await ask({ prompt, onToken })
    if (!res.ok) {
      attempts.push({ attempt, why: res.error ?? 'the run failed' })
      if (lastGood) return { ok: true, value: lastGood.value, attempts, why: null, notYetGreen: lastGood.issues }
      // A dead run with nothing already in hand is not a formatting problem,
      // and retrying a missing binary just spends another few minutes finding
      // out the same thing.
      return { ok: false, value: null, attempts, why: `the run did not complete: ${res.error ?? 'unknown'}` }
    }
    const json = partJson(res.text)
    if (!json) {
      priorError = 'Your answer contained no JSON object. Return one JSON object and nothing else.'
      priorKind = 'json'
      attempts.push({ attempt, why: 'no JSON in the answer', text: res.text })
      continue
    }
    const parsed = part.schema.safeParse(json)
    if (!parsed.success) {
      priorError = issuesText(parsed.error)
      priorKind = 'schema'
      attempts.push({ attempt, why: priorError, text: res.text })
      continue
    }
    const gate = check ? check(parsed.data) : []
    if (!gate.length) return { ok: true, value: parsed.data, attempts, why: null }
    // Schema-valid, gate-flagged - remembered even on attempt 1, so a
    // transport/parse/schema failure on the forced retry below still has this
    // to fall back to instead of discarding it.
    lastGood = { value: parsed.data, issues: gate }
    if (attempt < MAX_ATTEMPTS) {
      priorError = `THIS ANSWER VALIDATED BUT FAILED A CHECK THAT RUNS BEFORE APPROVAL. Fix these before returning:\n${gate.join('\n')}`
      priorKind = 'gate'
      attempts.push({ attempt, why: priorError, text: res.text })
      continue
    }
    // The last attempt, still red: land it rather than lose it, but flagged.
    return { ok: true, value: parsed.data, attempts, why: null, notYetGreen: gate }
  }
  // The loop exhausted on an unparsable or schema-invalid final attempt - the
  // two remaining doors into the same discard bug. A schema-valid draft
  // sitting in `lastGood` is landed flagged rather than lost here too.
  if (lastGood) return { ok: true, value: lastGood.value, attempts, why: null, notYetGreen: lastGood.issues }
  return { ok: false, value: null, attempts, why: `two attempts failed validation:\n${priorError}` }
}

/** Draft N independent tasks concurrently and fold their results into one
 *  part's slice of the record - unlike the rest of a step's parts, which fold
 *  through what earlier parts settled and so must run one after the other,
 *  nothing here is decided until every task returns, so nothing stops them
 *  running at once. Dispatched together with `Promise.all` over one `runPart`
 *  per task - not a `for` loop awaiting each in turn, which would be
 *  sequential work wearing a parallel name.
 *
 *  Fails the whole part on the first task that fails, same as a single-call
 *  part failing - a page nobody could draft is not a page silently dropped
 *  from the record. */
export async function runPartsInParallel({ tasks, perTask, merge, buildPrompt, ask, check = null, onProgress = () => {}, onToken = () => {} }) {
  const results = await Promise.all(
    tasks.map((task) =>
      runPart({
        part: perTask(task),
        buildPrompt,
        ask,
        check,
        onProgress: (p) => onProgress({ ...p, task }),
        // TAGGED WITH THE TASK, THE SAME WAY `onProgress` ABOVE IS. N tasks
        // run genuinely concurrently, so their child processes' token streams
        // arrive interleaved in real time. A bare `onToken(text)` passed
        // through unwrapped, as this used to be, gives a caller no way to tell
        // whose text just arrived; a single shared accumulator downstream then
        // had no choice but to splice simultaneous streams together
        // character-by-character. `runPart`'s own single-task `onToken` stays
        // a bare string - it has no task to attach.
        onToken: (text) => onToken({ text, task }),
      }),
    ),
  )
  const failed = results.find((r) => !r.ok)
  if (failed) return { ok: false, value: null, why: failed.why }
  // GATE FLAGS SURVIVE THE MERGE: one task landing red must not vanish inside
  // a merged value that reads all-clean - the same "loud, cheap failure" rule
  // `runPart`'s own gate check follows.
  const flagged = results.flatMap((r) => r.notYetGreen ?? [])
  return { ok: true, value: merge(results.map((r) => r.value)), why: null, notYetGreen: flagged.length ? flagged : null }
}
