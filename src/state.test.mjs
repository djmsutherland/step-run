import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { RUN_TIMEOUT_MS, createRunState } from './state.mjs'

const KINDS = ['draft', 'approach', 'directions']
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-run-state-'))
  return { dir, state: createRunState({ dir, kinds: KINDS }) }
}

test('a pipeline must declare at least one kind', () => {
  assert.throws(() => createRunState({ dir: '/tmp', kinds: [] }), /at least one kind/)
  assert.throws(() => createRunState({ dir: '/tmp' }), /at least one kind/)
})

test('the FIRST kind gets no suffix, so markers already on disk keep meaning what they meant', () => {
  // The back-compat contract of the extraction. Before kinds existed every
  // marker was `client--slug.running`; the default kind must still produce
  // exactly that name or every in-flight run on disk is orphaned.
  const { state } = fresh()
  assert.match(state.markerFile('acme', 'research'), /acme--research\.running$/)
  assert.equal(state.markerFile('acme', 'research'), state.markerFile('acme', 'research', 'draft'))
  assert.match(state.markerFile('acme', 'research', 'approach'), /acme--research--approach\.running$/)
})

test('runs of different kinds for the same step have independent markers and logs', () => {
  // Before this was fixed, `claimRun`/`isRunning`/`logFile` were keyed by
  // (client, slug) alone - one marker, one log, for both kinds of run. That is
  // what let a failed Approach proposal's log text render under the unrelated
  // drafting panel's message, and let one panel's "running" state go blank
  // while the other ran.
  const { state } = fresh()
  assert.notEqual(state.markerFile('acme', 'research', 'draft'), state.markerFile('acme', 'research', 'approach'))
  assert.notEqual(state.logFile('acme', 'research', 'draft'), state.logFile('acme', 'research', 'approach'))

  state.claimRun('acme', 'research', 'draft')
  state.notePid('acme', 'research', process.pid, 'draft')
  assert.equal(state.isRunning('acme', 'research', 'draft'), true)
  assert.equal(state.isRunning('acme', 'research', 'approach'), false, 'a draft run must not read as an Approach run')
  assert.equal(state.isRunning('acme', 'research'), true, 'omitting kind means "any" - a generic caller must still see the step as busy')
  assert.equal(state.runningFor('acme', 'research', 'approach'), null)
  assert.ok(state.runningFor('acme', 'research', 'draft') !== null)

  state.claimRun('acme', 'research', 'approach')
  state.notePid('acme', 'research', process.pid, 'approach')
  assert.equal(state.isRunning('acme', 'research', 'draft'), true, 'the draft marker must be untouched by the approach claim')

  state.releaseRun('acme', 'research', 'draft')
  assert.equal(state.isRunning('acme', 'research', 'draft'), false)
  assert.equal(state.isRunning('acme', 'research', 'approach'), true, 'releasing one marker must not touch the other')

  state.releaseRun('acme', 'research', 'approach')
  assert.equal(state.isRunning('acme', 'research'), false)
})

test('claiming a run is atomic - a second submit loses here, not halfway through', () => {
  const { state } = fresh()
  state.claimRun('acme', 'research')
  assert.throws(() => state.claimRun('acme', 'research'), /already going/)
})

test('claiming a run truncates a stale log left by a previous attempt', () => {
  // Nothing else ever reset the file between runs, so "Ask again" after a
  // failure kept appending onto the failed attempt's log - and a scan of the
  // whole text then reported a genuine success as a failure.
  const { state } = fresh()
  const log = state.logFile('acme', 'research')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, '{"line":"NOT WRITTEN"}\n')
  state.claimRun('acme', 'research')
  assert.equal(existsSync(log), false, 'the previous attempt\'s log must not survive into this one')
})

test('claiming a run with no prior log at all does not throw', () => {
  const { state } = fresh()
  assert.doesNotThrow(() => state.claimRun('acme', 'plan'))
})

test('an empty marker is cleared, not believed', () => {
  // `Number('')` is 0 and `process.kill(0, 0)` signals our OWN group, which
  // always succeeds - an empty marker wedged a step at "Running" with no run
  // behind it and no way out but deleting a dotfile nothing mentions.
  const { state } = fresh()
  state.claimRun('acme', 'research')
  writeFileSync(state.markerFile('acme', 'research'), '')
  assert.equal(state.isRunning('acme', 'research'), false)
  assert.equal(existsSync(state.markerFile('acme', 'research')), false, 'and it is cleaned up, not just disbelieved')
})

test('a "starting" claim expires, because a process can die between the claim and the pid write', () => {
  const { state } = fresh()
  state.claimRun('acme', 'research')
  const m = state.markerFile('acme', 'research')
  assert.equal(readFileSync(m, 'utf8'), 'starting')
  assert.equal(state.isRunning('acme', 'research'), true, 'inside the grace window it is believed')
  const old = new Date(Date.now() - 60_000)
  utimesSync(m, old, old)
  assert.equal(state.isRunning('acme', 'research'), false, 'past it, it is not')
  assert.equal(existsSync(m), false)
})

test('a marker older than the timeout is cleared - pids are recycled', () => {
  // One that outlived a reboot can match an unrelated process and wedge a step
  // forever.
  const { state } = fresh()
  state.claimRun('acme', 'research')
  state.notePid('acme', 'research', process.pid)
  const m = state.markerFile('acme', 'research')
  const old = new Date(Date.now() - RUN_TIMEOUT_MS - 60_000)
  utimesSync(m, old, old)
  assert.equal(state.isRunning('acme', 'research'), false, 'a live pid is not enough on its own')
})

test('a marker naming a dead process is cleared', () => {
  const { state } = fresh()
  state.claimRun('acme', 'research')
  state.notePid('acme', 'research', 999_999_999)
  assert.equal(state.isRunning('acme', 'research'), false)
})

test('`dir` may be a thunk, and is resolved at CALL time, not construction', () => {
  // Not a style choice. The original read `process.env.HOME` on every call and
  // its tests redirected HOME to a temp directory around each case; resolving
  // the path once at construction would silently ignore that and write into
  // the real home directory during a test run.
  let base = mkdtempSync(join(tmpdir(), 'step-run-a-'))
  const state = createRunState({ dir: () => base, kinds: KINDS })
  const first = state.markerFile('acme', 'research')
  base = mkdtempSync(join(tmpdir(), 'step-run-b-'))
  assert.notEqual(state.markerFile('acme', 'research'), first, 'the thunk is re-read, not captured')
  state.claimRun('acme', 'research')
  assert.ok(existsSync(state.markerFile('acme', 'research')), 'and the claim lands in the CURRENT directory')
  assert.equal(existsSync(first), false, 'never in the one captured at construction')
})

test('a pipeline with one kind never produces a suffix', () => {
  // A book pipeline has no Approach panel. One kind must not force it to think
  // about kinds at all.
  const { dir } = fresh()
  const solo = createRunState({ dir, kinds: ['draft'] })
  assert.match(solo.markerFile('bear', 'structure'), /bear--structure\.running$/)
  solo.claimRun('bear', 'structure')
  solo.notePid('bear', 'structure', process.pid)
  assert.equal(solo.isRunning('bear', 'structure'), true)
})
