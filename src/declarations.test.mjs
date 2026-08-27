import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The convention `@daysprint/intake` uses, carried across with the code: a
// hand-written `.d.mts` drifts from the module silently, and a guard that
// reads the package's own `exports` map covers a new subpath the moment it is
// published rather than when somebody remembers to add it here.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const typed = Object.entries(pkg.exports)
  .filter(([, v]) => v && typeof v === 'object' && v.types)
  .map(([subpath, v]) => ({ subpath, types: v.types, module: v.default }))

test('every subpath ships types', () => {
  const untyped = Object.entries(pkg.exports).filter(([, v]) => typeof v === 'string')
  assert.deepEqual(untyped.map(([k]) => k), [], 'a bare-string export gets no types at all - a silent gap for a TypeScript consumer')
})

for (const { subpath, types, module } of typed) {
  test(`${subpath}: the hand-written declarations match what the module exports`, async () => {
    const dts = readFileSync(new URL(`../${types.replace('./', '')}`, import.meta.url), 'utf8')
    const declared = [...dts.matchAll(/export declare (?:function|const) (\w+)/g)].map((m) => m[1]).sort()
    const mod = await import(new URL(`../${module.replace('./', '')}`, import.meta.url))
    assert.deepEqual(Object.keys(mod).sort(), declared, `${subpath} declarations drifted from ${module}`)
  })
}

test('the harness has no dependencies - not even a schema library', async () => {
  // The `safeParse` contract is structural on purpose. A consumer brings its
  // own validator; this package brings none, which is what makes it cheap to
  // depend on from a second pipeline.
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  const sources = ['state.mjs', 'parse.mjs', 'ask.mjs', 'part.mjs', 'index.mjs']
  for (const f of sources) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    for (const [, spec] of src.matchAll(/^import .* from '([^']+)'/gm)) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./'), `${f} imports ${spec} - only node builtins and siblings are allowed here`)
    }
  }
})
