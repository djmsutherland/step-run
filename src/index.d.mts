/** A schema this harness can validate against. Structural on purpose: zod
 *  satisfies it, and so does anything else that returns the same shape. The
 *  harness never imports a schema library, which is why this package has no
 *  dependencies at all. */
export type Schema<T = unknown> = { safeParse(value: unknown): { success: true; data: T } | { success: false; error: ValidationError } }
export type ValidationError = { issues: { path: (string | number)[]; message: string }[] }

/** One part of a decision: small enough to be answered properly, and shaped so
 *  the answer can be checked before it reaches a repo. */
export type Part<T = unknown> = { key: string; title: string; schema: Schema<T>; asks: string; shape: string; why: string }
export type AskResult = { ok: boolean; text: string; error?: string | null }
export type Attempt = { attempt: number; why: string; text?: string }

/** Why the PRIOR attempt is being retried - null on the first attempt, then
 *  one of these depending on what that attempt actually did: no JSON in the
 *  answer, the schema rejected it, or the green gate was still red. Carried on
 *  `onProgress` so a caller reports the real cause instead of guessing
 *  "rejected by the schema" for all three. */
export type RetryReason = 'json' | 'schema' | 'gate' | null

export type RunState<K extends string = string> = {
  markerFile(client: string, slug: string, kind?: K): string
  logFile(client: string, slug: string, kind?: K): string
  /** Omit `kind` to ask whether ANY kind of run is going (a queue view's
   *  question); pass it to ask about one specific kind. */
  isRunning(client: string, slug: string, kind?: K): boolean
  runningFor(client: string, slug: string, kind?: K): number | null
  /** Atomic: a second submit loses here rather than halfway through. */
  claimRun(client: string, slug: string, kind?: K): void
  releaseRun(client: string, slug: string, kind?: K): void
  notePid(client: string, slug: string, pid: number, kind?: K): void
}

/** Past this a marker is not believed - pids are recycled. */
export declare const RUN_TIMEOUT_MS: number
/** Two. A loop that keeps asking is a loop that eventually accepts noise. */
export declare const MAX_ATTEMPTS: number

/** The run-state lifecycle for one pipeline. `dir` may be a thunk, and should
 *  be whenever it derives from the environment - resolving it once at
 *  construction ignores a test that redirects `HOME`. The FIRST kind is the
 *  default and gets no filename suffix. */
export declare function createRunState<K extends string>(opts: { dir: string | (() => string); kinds: readonly K[] }): RunState<K>

/** Read-only. The run returns data; deterministic code writes files. */
export declare const PROPOSAL_TOOLS: { allowed: string[]; denied: string[] }
/** Narrowing only. Throws if `allow` contains anything `PROPOSAL_TOOLS.allowed`
 *  does not - the no-writer property is not a knob. */
export declare function narrowTools(allow: string[] | null): { allowed: string[]; denied: string[] }

/** Ask `claude -p` once, streaming live text through `onToken`. Injected in
 *  tests; nothing else should call it directly. */
export declare function askClaude(args: {
  prompt: string
  cwd: string
  /** Directories outside `cwd` the run may read - where a pipeline's doctrine
   *  lives. */
  addDirs?: string[]
  allow?: string[] | null
  model?: string | null
  onToken?: (text: string) => void
}): Promise<AskResult>

/** The first parseable object, or null. Nothing here repairs a broken answer. */
export declare function partJson(text: string): Record<string, unknown> | null
/** Why a schema said no, in the words the model needs to fix it. */
export declare function issuesText(error: ValidationError): string
/** One line of `claude -p --output-format stream-json`'s stdout, interpreted.
 *  A live text chunk, the final `result` line, or `null` for every other line
 *  (including one that fails to parse) - dropped silently, not shown as
 *  garbage. */
export declare function readStreamLine(line: string): { token: string } | { result: { result?: string; is_error?: boolean } } | null

/** Generate one part, validate, retry ONCE against the error. `check`, when
 *  given, runs against the schema-valid value on the same retry budget a
 *  schema failure spends. If still red on the last attempt the part is
 *  accepted anyway, flagged via `notYetGreen` rather than silently clean or
 *  silently blocked. Writes nothing. */
export declare function runPart<T>(args: {
  part: Part<T>
  buildPrompt: (ctx: { part: Part<T>; priorError: string | null }) => string
  ask: (args: { prompt: string; onToken?: (text: string) => void }) => Promise<AskResult>
  check?: ((value: T) => string[]) | null
  onProgress?: (p: { attempt: number; part: string; reason: RetryReason }) => void
  onToken?: (text: string) => void
}): Promise<{ ok: boolean; value: T | null; attempts: Attempt[]; why: string | null; notYetGreen?: string[] | null }>

/** Draft N independent tasks concurrently (`Promise.all`, one `runPart` per
 *  task) and fold the ok results into one part's slice, via `merge`. Fails on
 *  the first task that fails validation. A task landing with gate issues keeps
 *  them on the merged result rather than losing them in the fold. */
export declare function runPartsInParallel<Task, T = unknown>(args: {
  tasks: Task[]
  perTask: (task: Task) => Part<T>
  merge: (values: (T | null)[]) => Record<string, unknown>
  buildPrompt: (ctx: { part: Part<T>; priorError: string | null }) => string
  ask: (args: { prompt: string; onToken?: (text: string) => void }) => Promise<AskResult>
  check?: ((value: T) => string[]) | null
  onProgress?: (p: { attempt: number; part: string; reason: RetryReason; task: Task }) => void
  /** Tagged with the task - N tasks run genuinely concurrently, so a bare
   *  `(text: string) => void` gives a caller no way to tell whose text
   *  just arrived. */
  onToken?: (p: { text: string; task: Task }) => void
}): Promise<{ ok: boolean; value: Record<string, unknown> | null; why: string | null; notYetGreen?: string[] | null }>
