import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runPart, runPartsInParallel } from './part.mjs'

// A HAND-ROLLED SCHEMA, not zod. Two reasons: it proves the duck-typed
// `safeParse` contract this package documents (and so that the package really
// does have no dependencies), and it keeps these tests about the LOOP rather
// than about someone else's validator.
const schemaOf = (validate) => ({
  safeParse(value) {
    const issues = validate(value)
    return issues.length ? { success: false, error: { issues } } : { success: true, data: value }
  },
})

const needsFamily = schemaOf((v) =>
  typeof v?.family === 'string' && v.family.length ? [] : [{ path: ['family'], message: 'a real family, not a placeholder' }],
)

const PART = { key: 'typography', title: 'Typography', schema: needsFamily, asks: '', shape: '', why: '' }
const GOOD = { family: 'Archivo' }

/** Replies in order; each is what `ask` resolves to for that attempt. */
const asker = (...replies) => {
  const seen = []
  const ask = async ({ prompt, onToken }) => {
    seen.push(prompt)
    const next = replies.shift()
    return typeof next === 'function' ? next({ prompt, onToken }) : next
  }
  ask.prompts = seen
  return ask
}

const prompt = ({ priorError }) => ['ASK', priorError ?? ''].join('\n')
const base = { part: PART, buildPrompt: prompt }

// ---- the two-attempt budget ------------------------------------------------

test('a valid first answer is taken as is', async () => {
  const ask = asker({ ok: true, text: '```json\n' + JSON.stringify(GOOD) + '\n```' })
  const r = await runPart({ ...base, ask })
  assert.equal(r.ok, true)
  assert.equal(r.value.family, 'Archivo')
  assert.equal(ask.prompts.length, 1, 'a valid answer must not be re-asked')
})

test('a rejected answer is retried ONCE, with the reason', async () => {
  // Handed "your answer was wrong" a model learns nothing. Handed the failing
  // field and why, it can fix the actual thing.
  const ask = asker({ ok: true, text: JSON.stringify({ family: '' }) }, { ok: true, text: JSON.stringify(GOOD) })
  const r = await runPart({ ...base, ask })
  assert.equal(r.ok, true)
  assert.equal(ask.prompts.length, 2)
  assert.match(ask.prompts[1], /family: a real family/)
})

test('two failures is a failure, not a third attempt', async () => {
  const ask = asker(
    { ok: true, text: JSON.stringify({ family: '' }) },
    { ok: true, text: JSON.stringify({ family: '' }) },
    { ok: true, text: JSON.stringify(GOOD) },
  )
  const r = await runPart({ ...base, ask })
  assert.equal(r.ok, false)
  assert.equal(r.value, null)
  assert.equal(ask.prompts.length, 2, 'a loop that keeps asking eventually accepts noise')
  assert.match(r.why, /two attempts failed validation/)
})

test('an answer with no JSON is retried, and the retry says so', async () => {
  const ask = asker({ ok: true, text: 'I would suggest Archivo.' }, { ok: true, text: JSON.stringify(GOOD) })
  const r = await runPart({ ...base, ask })
  assert.equal(r.ok, true)
  assert.match(ask.prompts[1], /contained no JSON object/)
})

test('a dead run is reported as dead, not retried', async () => {
  // A missing binary or a killed process is not a formatting problem, and
  // retrying it spends minutes finding out the same thing. This was a live
  // defect: the studio blamed the model's formatting for a process that never
  // wrote a line.
  const ask = asker({ ok: false, text: '', error: 'spawn claude ENOENT' })
  const r = await runPart({ ...base, ask })
  assert.equal(r.ok, false)
  assert.match(r.why, /did not complete/)
  assert.match(r.why, /ENOENT/)
  assert.equal(ask.prompts.length, 1)
})

// ---- the retry REASON ------------------------------------------------------

test('progress names which of the three things went wrong, never "schema" for all of them', async () => {
  const reasons = async (...replies) => {
    const seen = []
    await runPart({ ...base, ask: asker(...replies), check: (v) => (v.family === 'Archivo' ? [] : ['gate: wrong family']), onProgress: (p) => seen.push(p.reason) })
    return seen
  }
  assert.deepEqual(await reasons({ ok: true, text: 'no json here' }, { ok: true, text: JSON.stringify(GOOD) }), [null, 'json'])
  assert.deepEqual(await reasons({ ok: true, text: JSON.stringify({ family: '' }) }, { ok: true, text: JSON.stringify(GOOD) }), [null, 'schema'])
  assert.deepEqual(await reasons({ ok: true, text: JSON.stringify({ family: 'Other' }) }, { ok: true, text: JSON.stringify(GOOD) }), [null, 'gate'])
})

// ---- the green gate --------------------------------------------------------

test('a check failure after a valid schema is retried through the SAME channel a schema failure uses', async () => {
  // No separate counter, no new failure-handling path - it spends the same
  // retry budget.
  const ask = asker({ ok: true, text: JSON.stringify({ family: 'Other' }) }, { ok: true, text: JSON.stringify(GOOD) })
  const r = await runPart({ ...base, ask, check: (v) => (v.family === 'Archivo' ? [] : ['gate: wrong family']) })
  assert.equal(r.ok, true)
  assert.equal(r.notYetGreen, undefined, 'a check that clears on retry lands clean, with no flag')
  assert.match(ask.prompts[1], /VALIDATED BUT FAILED A CHECK/)
})

test('still red after both attempts, the part lands anyway, flagged - never dropped, never silently passed', async () => {
  const ask = asker({ ok: true, text: JSON.stringify({ family: 'Other' }) }, { ok: true, text: JSON.stringify({ family: 'Other' }) })
  const r = await runPart({ ...base, ask, check: () => ['gate: wrong family'] })
  assert.equal(r.ok, true)
  assert.equal(r.value.family, 'Other')
  assert.deepEqual(r.notYetGreen, ['gate: wrong family'])
})

// ---- the last-good fallback ------------------------------------------------

for (const [name, second] of [
  ['a transport failure', { ok: false, text: '', error: 'boom' }],
  ['an unparsable answer', { ok: true, text: 'no json at all' }],
  ['a schema-invalid answer', { ok: true, text: JSON.stringify({ family: '' }) }],
]) {
  test(`attempt 1 good-but-flagged + attempt 2 ${name} -> lands attempt 1, flagged, not discarded`, async () => {
    // Three doors into the same defect. Two prior rounds each closed only one
    // of them; losing the good draft to a parse failure is the same bug as
    // losing it to a transport failure.
    const ask = asker({ ok: true, text: JSON.stringify({ family: 'Other' }) }, second)
    const r = await runPart({ ...base, ask, check: () => ['gate: wrong family'] })
    assert.equal(r.ok, true, 'the schema-valid draft in hand must survive')
    assert.equal(r.value.family, 'Other')
    assert.deepEqual(r.notYetGreen, ['gate: wrong family'])
  })
}

// ---- streaming and concurrency ---------------------------------------------

test('runPart threads onToken through to ask', async () => {
  const seen = []
  const ask = async ({ onToken }) => {
    onToken('h')
    onToken('i')
    return { ok: true, text: JSON.stringify(GOOD) }
  }
  await runPart({ ...base, ask, onToken: (t) => seen.push(t) })
  assert.deepEqual(seen, ['h', 'i'])
})

test('runPartsInParallel tags onToken with the task, the same way onProgress already is', { timeout: 5_000 }, async () => {
  // PROVEN WITH A GATE, NOT A STOPWATCH. The obvious way to show these run
  // concurrently is to give each task a different sleep and assert on the
  // order the chunks land in - which is what the version of this test in
  // `@daysprint/intake` does, and it fails about three runs in ten when the
  // whole suite is running and timer jitter closes the 20ms margin it needs.
  //
  // A deferred is exact instead. Task 0 cannot emit until task 1 has finished
  // emitting and opened the gate, so:
  //   - the interleave is deterministic (F, F, S, S), not raced, and
  //   - a regression to sequential dispatch DEADLOCKS rather than passing,
  //     because task 1 would never get to run to open it. The timeout turns
  //     that into a fast failure instead of a hang.
  let open
  const gate = new Promise((r) => (open = r))
  const tasks = [{ label: 'slow' }, { label: 'fast' }]
  const seenTokens = []
  const seenProgress = []
  let dispatched = 0
  const ask = async ({ onToken }) => {
    const mine = dispatched++
    if (mine === 0) {
      await gate
      onToken('S')
      onToken('S')
    } else {
      onToken('F')
      onToken('F')
      open()
    }
    return { ok: true, text: JSON.stringify(GOOD) }
  }
  const r = await runPartsInParallel({
    tasks,
    perTask: () => PART,
    merge: (values) => ({ values }),
    buildPrompt: prompt,
    ask,
    onProgress: (p) => seenProgress.push(p),
    onToken: (p) => seenTokens.push(p),
  })
  assert.equal(r.ok, true)
  assert.equal(seenTokens.length, 4)
  // Every chunk names the REAL task it came from, and its text matches that
  // task - never mixed up between the two concurrent callers. Passed through
  // unwrapped, as this used to be, a caller would have no way to tell them
  // apart at all.
  for (const { text, task } of seenTokens) {
    assert.ok(task === tasks[0] || task === tasks[1], 'every chunk names one of the real task objects')
    assert.equal(text, task === tasks[0] ? 'S' : 'F')
  }
  assert.deepEqual(seenTokens.map((t) => t.task), [tasks[1], tasks[1], tasks[0], tasks[0]])
  assert.ok(seenProgress.every((p) => p.task === tasks[0] || p.task === tasks[1]))
})

test('one task failing fails the whole part - a page nobody could draft is not a page silently dropped', async () => {
  let call = 0
  const ask = async () => (call++ === 0 ? { ok: true, text: JSON.stringify(GOOD) } : { ok: false, text: '', error: 'boom' })
  const r = await runPartsInParallel({ tasks: [1, 2], perTask: () => PART, merge: (v) => ({ v }), buildPrompt: prompt, ask })
  assert.equal(r.ok, false)
  assert.equal(r.value, null)
  assert.match(r.why, /did not complete/)
})

test('gate flags survive the merge - one task landing red must not vanish into a value that reads all-clean', async () => {
  const ask = async () => ({ ok: true, text: JSON.stringify({ family: 'Other' }) })
  const r = await runPartsInParallel({
    tasks: [1, 2],
    perTask: () => PART,
    merge: (values) => ({ values }),
    buildPrompt: prompt,
    ask,
    check: () => ['gate: wrong family'],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.notYetGreen, ['gate: wrong family', 'gate: wrong family'])
})
