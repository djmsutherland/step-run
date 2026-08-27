// Is a run for this step alive, and who is allowed to start one?
//
// Lifted verbatim out of `@daysprint/intake/src/run.mjs`. Every branch below
// is a defect that actually happened in the studio, which is the whole reason
// this file is SHARED rather than copied into each pipeline that wants it:
// forking bug-fix-dense code is how you re-live the bugs.
//
// WHAT WAS PARAMETERISED, AND WHY ONLY THIS. The original hardcoded
// `~/.daysprint/runs` and the three run kinds daysprint happens to have.
// Neither is a property of the mechanism - a pipeline for books has different
// kinds and no business putting its state in a directory named after someone
// else's company. Nothing else about the lifecycle is configurable, because
// nothing else about it is a preference.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Past this, a marker is not believed. Pids are recycled, so one that
 *  outlived a reboot can match an unrelated process and wedge a step forever
 *  with no way out but deleting a dotfile nothing mentions. */
export const RUN_TIMEOUT_MS = 45 * 60_000

/** A marker still reading `starting` after this long is from a process that
 *  died between the atomic create and the pid write. */
const STARTING_GRACE_MS = 30_000

/** The run-state lifecycle for one pipeline.
 *
 *  `dir` is a string OR a thunk returning one. A THUNK IS NOT A STYLE CHOICE:
 *  the original read `process.env.HOME` at call time, and its tests set `HOME`
 *  to a temp directory around each case. Resolving the path once at
 *  construction would silently ignore that and write into the real home
 *  directory during a test run.
 *
 *  `kinds` are the independent runs one step can have in flight at once -
 *  daysprint has 'draft', 'approach' and 'directions', because a step can be
 *  drafting its decision while its Approach panel proposes tasks. THE FIRST
 *  KIND IS THE DEFAULT and gets no filename suffix, so markers already on disk
 *  keep meaning what they always meant. */
export function createRunState({ dir, kinds }) {
  if (!Array.isArray(kinds) || kinds.length === 0) throw new Error('createRunState needs at least one kind')
  const stateDir = () => (typeof dir === 'function' ? dir() : dir)
  const DEFAULT = kinds[0]
  // Sharing one marker+log file across kinds meant each panel read the OTHER's
  // state as its own - a failed Approach proposal's log line rendered under
  // the drafting panel's "did not produce a decision" message.
  const suffix = (kind) => (kind === DEFAULT ? '' : `--${kind}`)

  const markerFile = (client, slug, kind = DEFAULT) => join(stateDir(), `${client}--${slug}${suffix(kind)}.running`)
  const logFile = (client, slug, kind = DEFAULT) => join(stateDir(), `${client}--${slug}${suffix(kind)}.log`)

  /** Is a run for this step, of this `kind`, alive?
   *
   *  Guarded reads because the file is deleted by the run chain while a page
   *  re-renders every fifteen seconds. A `starting` claim expires because the
   *  process can die between the atomic create and the pid write. A non-pid
   *  marker is cleared because `Number('')` is 0 and `process.kill(0, 0)`
   *  signals our OWN group, which always succeeds - an empty marker wedged a
   *  step at "Running" with no run behind it. */
  function isRunningKind(client, slug, kind) {
    const m = markerFile(client, slug, kind)
    if (!existsSync(m)) return false
    let raw
    let age
    try {
      raw = readFileSync(m, 'utf8').trim()
      age = Date.now() - statSync(m).mtimeMs
    } catch {
      return false
    }
    if (raw === 'starting') {
      if (age < STARTING_GRACE_MS) return true
      rmSync(m, { force: true })
      return false
    }
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0) {
      rmSync(m, { force: true })
      return false
    }
    try {
      process.kill(pid, 0)
    } catch {
      rmSync(m, { force: true })
      return false
    }
    if (age > RUN_TIMEOUT_MS) {
      rmSync(m, { force: true })
      return false
    }
    return true
  }

  /** Pass `kind` to ask about one specific kind of run; omit it to ask whether
   *  ANY is going - what a generic caller (a queue view, which has no notion
   *  of kind) means by "is this step busy". */
  const isRunning = (client, slug, kind) =>
    kind ? isRunningKind(client, slug, kind) : kinds.some((k) => isRunningKind(client, slug, k))

  /** Seconds a run has been going, or null. "Running" alone is
   *  indistinguishable from wedged, and a `-p` run emits its whole answer at
   *  the end. Same `kind`-or-any rule as `isRunning`. */
  function runningFor(client, slug, kind) {
    for (const k of kind ? [kind] : kinds) {
      if (isRunningKind(client, slug, k)) {
        return Math.max(0, Math.round((Date.now() - statSync(markerFile(client, slug, k)).mtimeMs) / 1000))
      }
    }
    return null
  }

  /** Claim the step atomically. `wx` fails if the file exists, so a second
   *  submit loses HERE rather than halfway through - a check followed by a
   *  write is a race, and two submits both passed it once. */
  function claimRun(client, slug, kind = DEFAULT) {
    mkdirSync(stateDir(), { recursive: true })
    try {
      writeFileSync(markerFile(client, slug, kind), 'starting', { flag: 'wx' })
    } catch {
      throw new Error(`a run for ${slug} is already going`)
    }
    // A FRESH LOG FOR THIS RUN. Callers append one JSON line per event, and
    // nothing else ever reset the file between runs - so a retry of the same
    // client/slug/kind kept appending onto whatever the previous attempt left
    // behind. That corrupted two readers at once: a stream connecting
    // mid-retry replayed the prior attempt's lines as live, and a scan of the
    // whole reconstructed text reported a genuine success as a failure because
    // run 1's "NOT WRITTEN" line survived into run 2's log.
    //
    // Cleared HERE, when the run is claimed, not at exit - an attempt that
    // crashes before writing a line must not leave the next one reading its
    // predecessor's stale content.
    rmSync(logFile(client, slug, kind), { force: true })
  }

  const releaseRun = (client, slug, kind = DEFAULT) => rmSync(markerFile(client, slug, kind), { force: true })
  const notePid = (client, slug, pid, kind = DEFAULT) => writeFileSync(markerFile(client, slug, kind), String(pid))

  return { markerFile, logFile, isRunning, runningFor, claimRun, releaseRun, notePid }
}
