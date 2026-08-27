import { test } from 'node:test'
import assert from 'node:assert/strict'

import { issuesText, partJson, readStreamLine } from './parse.mjs'

test('JSON is read from a fence, or from the object in the prose', () => {
  assert.deepEqual(partJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(partJson('Here you go: {"a":1} — hope that helps'), { a: 1 })
})

test('an answer with no object, or an unparseable one, is null and not a guess', () => {
  // A parser that repairs is a parser that invents. Null means the part
  // failed, and the caller retries with that as the reason.
  assert.equal(partJson('I would suggest Archivo.'), null)
  assert.equal(partJson('{"a": }'), null)
  assert.equal(partJson('[1,2,3]'), null, 'an array is not a part answer')
})

test('validation issues are phrased so the model can fix them', () => {
  const err = { issues: [{ path: ['palette', 'muted'], message: 'contrast 2.04:1 - AA needs 4.5:1' }, { path: [], message: 'root problem' }] }
  const text = issuesText(err)
  assert.match(text, /palette\.muted: contrast 2\.04:1/)
  assert.match(text, /\(root\): root problem/)
})

test('a content_block_delta text_delta line is read as a token', () => {
  const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } })
  assert.deepEqual(readStreamLine(line), { token: 'hi' })
})

test('the result line is read whole, result and is_error included', () => {
  const line = JSON.stringify({ type: 'result', result: '{"a":1}', is_error: false })
  assert.deepEqual(readStreamLine(line), { result: { type: 'result', result: '{"a":1}', is_error: false } })
})

test('every other stream-json line is ignored, not shown as garbage', () => {
  // An ignorable line is not a malformed one. These are the shapes the CLI
  // really emits alongside the two that matter.
  for (const evt of [
    { type: 'system', subtype: 'init' },
    { type: 'rate_limit_event' },
    { type: 'assistant', message: {} },
    { type: 'stream_event', event: { type: 'content_block_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } },
  ]) {
    assert.equal(readStreamLine(JSON.stringify(evt)), null, `${JSON.stringify(evt)} must be ignored`)
  }
})

test('a line that fails to parse is null, not a crash', () => {
  assert.equal(readStreamLine('not json at all'), null)
  assert.equal(readStreamLine('{"broken":'), null)
})
