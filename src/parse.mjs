// Reading what came back. Pure, and deliberately unhelpful about repairs.
//
// Lifted verbatim from `@daysprint/intake/src/run.mjs`. Nothing here is
// configurable because nothing here is a preference.

/** The JSON a part returned, or null.
 *
 *  Tolerant of a fence because models add one, and of leading prose because
 *  they sometimes ignore the instruction - but NOT of ambiguity: the first
 *  balanced object is taken, and if it does not parse the answer is null and
 *  the part failed. NOTHING HERE GUESSES AT A REPAIR. A parser that repairs is
 *  a parser that invents, and this pipeline has lost content to that twice. */
export function partJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const candidates = fenced ? [fenced[1]] : []
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim())
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Why a schema said no, in the words the model needs to fix it.
 *
 *  Shaped for a retry prompt, not a log: "palette.muted: contrast muted on bg
 *  is 2.04:1 - WCAG AA needs 4.5:1" is fixable; "validation failed" is not. */
export function issuesText(error) {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

/** Interpret ONE line of `claude -p --output-format stream-json`'s stdout.
 *
 *  Verified against the real CLI, not assumed: `--output-format stream-json`
 *  requires `--verbose` too, or the CLI hard-errors before producing anything.
 *  Every line is one JSON object. Only two shapes matter:
 *   - a `content_block_delta`/`text_delta` `stream_event` - a live chunk of the
 *     model's own output, returned as `{ token }`
 *   - the final `result` line - the complete assembled answer plus a real
 *     success/failure signal (`is_error`), returned as `{ result: line }`
 *
 *  Everything else (`system` init/status, `rate_limit_event`, the intermediate
 *  `assistant` line, every other `stream_event` subtype, a tool-use block) is
 *  data this has no use for, and returns `null` - same for a line that fails to
 *  parse at all. A caller drops `null` silently rather than treating it as
 *  garbage: AN IGNORABLE LINE IS NOT A MALFORMED ONE. */
export function readStreamLine(line) {
  let evt
  try {
    evt = JSON.parse(line)
  } catch {
    return null
  }
  if (evt?.type === 'stream_event' && evt.event?.type === 'content_block_delta' && evt.event?.delta?.type === 'text_delta') {
    return { token: evt.event.delta.text }
  }
  if (evt?.type === 'result') return { result: evt }
  return null
}
