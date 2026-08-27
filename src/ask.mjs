// One `claude -p` call, streamed.
//
// Lifted from `@daysprint/intake/src/run.mjs`. The only parameterisation is
// `addDirs` - the original hardcoded a single `daysprintRoot` because that is
// where its doctrine lives, and a pipeline reading different playbooks needs
// to point somewhere else.
import { spawn } from 'node:child_process'

import { readStreamLine } from './parse.mjs'

/** THE SAFETY PROPERTY, and the reason a proposal can be trusted at all: the
 *  run returns data, deterministic code writes files. Verified by an
 *  adversarial pass that tried Write, Edit, Bash, NotebookEdit, a subagent
 *  with nominally full tools, and a shell escape - all denied, no file
 *  appeared. */
export const PROPOSAL_TOOLS = {
  allowed: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  denied: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
}

/** NARROWING ONLY, NEVER WIDENING. A consumer may drop tools it does not want
 *  (a pipeline with no reason to reach the network can hand `['Read','Grep',
 *  'Glob']`), but the denied list is a floor and the allowed list may not gain
 *  anything PROPOSAL_TOOLS does not already have.
 *
 *  Configurability in one direction is the point. The no-writer property is
 *  the whole reason this harness is safe to hand a repo, and a knob that can
 *  turn it off is a knob that eventually will be. */
export function narrowTools(allow) {
  if (!allow) return PROPOSAL_TOOLS
  const widened = allow.filter((t) => !PROPOSAL_TOOLS.allowed.includes(t))
  if (widened.length) throw new Error(`askClaude cannot widen its tools: ${widened.join(', ')} is not in PROPOSAL_TOOLS.allowed`)
  return { allowed: allow, denied: PROPOSAL_TOOLS.denied }
}

/** Ask `claude -p` once, streaming live text through `onToken` as it arrives.
 *  Injected in tests; nothing else should call it directly.
 *
 *  `text` in the returned `{ok, text, error}` is the `result` line's own
 *  `result` field, NOT a manual accumulation of every stdout chunk - that
 *  buffer used to include every stream-json event, tool call and system line as
 *  raw text, which `partJson` then had to fish a JSON object back out of.
 *  `is_error` is the CLI's own success/failure signal, checked alongside the
 *  exit code so a process that exits 0 but reports its own failure inside the
 *  final line is still treated as one. */
export function askClaude({ prompt, cwd, addDirs = [], allow = null, model = null, onToken = () => {} }) {
  const tools = narrowTools(allow)
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--allowedTools', ...tools.allowed,
      '--disallowedTools', ...tools.denied,
      '--permission-mode', 'dontAsk',
      ...addDirs.flatMap((d) => ['--add-dir', d]),
      ...(model ? ['--model', model] : []),
    ]
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    let result = null
    child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop() // an incomplete final line waits for the next chunk
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = readStreamLine(line)
        if (parsed?.token !== undefined) onToken(parsed.token)
        else if (parsed?.result) result = parsed.result
      }
    })
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ ok: false, text: '', error: e.message }))
    child.on('close', (code) => {
      if (!result) {
        // No `result` line ever arrived - a crash mid-stream, or a process
        // killed before it could finish. Nothing to fall back to.
        resolve({ ok: false, text: '', error: err.trim() || `claude exited ${code} with no result line` })
        return
      }
      const ok = code === 0 && result.is_error !== true
      resolve({ ok, text: result.result ?? '', error: ok ? null : err.trim() || `claude reported an error: ${result.result ?? 'unknown'}` })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
