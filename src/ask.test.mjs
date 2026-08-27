import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROPOSAL_TOOLS, narrowTools } from './ask.mjs'

test('the run is given no writer', () => {
  // The whole safety property: it returns data, deterministic code writes
  // files. Verified originally by an adversarial pass that tried Write, Edit,
  // Bash, NotebookEdit, a subagent, and a shell escape - all denied.
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
    assert.ok(PROPOSAL_TOOLS.denied.includes(t), `${t} must be denied`)
    assert.ok(!PROPOSAL_TOOLS.allowed.includes(t), `${t} must not be allowed`)
  }
})

test('a consumer may narrow the allowed tools', () => {
  // A pipeline with no reason to reach the network should not have to.
  const t = narrowTools(['Read', 'Grep', 'Glob'])
  assert.deepEqual(t.allowed, ['Read', 'Grep', 'Glob'])
  assert.deepEqual(t.denied, PROPOSAL_TOOLS.denied, 'the denied floor is not narrowable either way')
})

test('a consumer may NOT widen them - the no-writer property is not a knob', () => {
  // Configurability in one direction is the point. A knob that can turn the
  // safety property off is a knob that eventually will be.
  assert.throws(() => narrowTools(['Read', 'Write']), /cannot widen/)
  assert.throws(() => narrowTools(['Bash']), /Bash/)
})

test('no argument means the full read-only set', () => {
  assert.equal(narrowTools(null), PROPOSAL_TOOLS)
})
