// Tests for workflows/adversarial-review-loop.js (node N8).
// The workflow is run with tools/dry-run-workflow.mjs: agent() is a local stub driven by the
// handlers below, so only the script's control flow is tested, never a model.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dryRun, extractMeta } from '../../tools/dry-run-workflow.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'workflows', 'adversarial-review-loop.js')
const TARGET = path.join(ROOT, 'demo', 'targets', 'target-a')
const UNITS = ['slugify', 'chunk', 'duration']
const ROLES = ['guide', 'review-a', 'review-b', 'implement', 'judge', 'fix', 'test']

const PASS = '# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
const FAIL = '# tests 3\n# suites 0\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n'
const ACCEPT = { verdict: 'accept', approved: [], dropped: [], missed: [] }
// Files the guide writer must have under .wf/orig for these units.
const baselineList = (units) => ['TASK.md', 'GUIDE.md', ...units.flatMap((u) => [`src/${u}.mjs`, `test/${u}.test.mjs`])]
const summary = (o) => `# tests ${o.tests}\n# suites 0\n# pass ${o.pass ?? o.tests}\n# fail ${o.fail ?? 0}\n# cancelled 0\n# skipped 0\n# todo ${o.todo ?? 0}\n`

// ---------- dry-run harness ----------
const parseLabel = (label) => {
  const m = /^([a-z-]+):([A-Za-z0-9_-]+)(?:#r(\d+))?$/.exec(label || '')
  return m ? { role: m[1], unit: m[2], round: m[3] ? Number(m[3]) : null } : null
}

const F = (over = {}) => ({ file: 'src/x.mjs', line: 3, input: 'f("")', description: 'desc', severity: 'high', category: 'cat', ...over })

const DEFAULTS = {
  'prep-guide': () => ({ files: ['GUIDE.md'], note: 'guide written' }),
  'prep-review-a': () => ({ issues: [] }),
  'prep-review-b': () => ({ issues: [] }),
  implement: ({ unit }) => ({ files: [`src/${unit}.mjs`], note: 'implemented' }),
  'review-a': () => ({ findings: [] }),
  'review-b': () => ({ findings: [] }),
  judge: () => ACCEPT,
  fix: ({ unit }) => ({ files: [`src/${unit}.mjs`], note: 'fixed' }),
  test: () => ({ exitCode: 0, outputTail: PASS }),
  rule: () => ({ files: ['GUIDE.md'], note: 'RULE-TEXT' }),
}

function makeRespond(handlers = {}) {
  return (call) => {
    const p = parseLabel(call.label)
    assert.ok(p, `label does not parse: ${call.label}`)
    const key = p.unit === 'prep' ? `prep-${p.role}` : p.role === 'guide' ? 'rule' : p.role
    const fn = handlers[key] ?? DEFAULTS[key]
    assert.ok(fn, `no handler for ${key} (${call.label})`)
    return fn({ ...p, call })
  }
}

const run = (handlers, argsOver = {}) => dryRun(SCRIPT, {
  args: { targetDir: '/work/target-a', units: UNITS, ...argsOver },
  respond: makeRespond(handlers),
})

const labelsOf = (r, unit) => r.calls.filter((c) => parseLabel(c.label).unit === unit).map((c) => c.label)
const callsOf = (r, role, unit, round) => r.calls.filter((c) => {
  const p = parseLabel(c.label)
  return p.role === role && (unit === undefined || p.unit === unit) && (round === undefined || p.round === round)
})
const ruleCalls = (r) => r.calls.filter((c) => { const p = parseLabel(c.label); return p.role === 'guide' && p.unit !== 'prep' })
const unitReport = (r, unit) => r.result.units.find((u) => u.unit === unit)

// ---------- script shape ----------
test('meta is a pure literal and the file starts with it', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  assert.ok(text.startsWith('export const meta = {'), 'meta must be the first statement')
  const { meta, start, end } = extractMeta(text)
  const literal = text.slice(text.indexOf('{', start), end)

  assert.ok(!literal.includes('`'), 'no template literals in meta')
  const withoutStrings = literal.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
  assert.match(withoutStrings, /^[\s{}[\]:,\w"]*$/, 'only braces, brackets, keys, commas and string literals')
  assert.ok(!withoutStrings.includes('...'), 'no spread')

  // evaluated with no globals at all: any variable or call would throw
  const evaluated = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`, Object.create(null))))
  assert.deepEqual(evaluated, meta)

  assert.equal(meta.name, 'adversarial-review-loop')
  assert.equal(typeof meta.description, 'string')
  assert.deepEqual(meta.phases.map((p) => p.title), ['Prep', 'Implement', 'Review', 'Judge', 'Fix', 'Test'])
  for (const p of meta.phases) assert.equal(typeof p.detail, 'string')
})

test('script is a plain workflow body: no imports, no nondeterminism, no host APIs', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8')
  assert.equal((text.match(/^export /gm) || []).length, 1, 'only `export const meta`')
  for (const re of [/Date\.now/, /Math\.random/, /new Date\(/, /\bimport\b/, /\brequire\(/, /\bprocess\./, /\bfs\./, /\bfetch\(/]) {
    assert.doesNotMatch(text, re)
  }
  for (const word of ['agent(', 'parallel(', 'pipeline(', 'phase(', 'log(', 'args']) assert.ok(text.includes(word), `uses ${word}`)
})

test('the same args give the same calls, prompts and report', async () => {
  const h = { 'review-a': (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs` })] : [] }) }
  const a = await run(h), b = await run(h)
  assert.deepEqual(a.calls.map((c) => [c.label, c.phase, c.prompt]), b.calls.map((c) => [c.label, c.phase, c.prompt]))
  assert.deepEqual(a.result, b.result)
})

// ---------- args ----------
test('args are validated before any agent runs', async () => {
  const good = { targetDir: '/t', units: ['a'] }
  const cases = [
    [undefined, /args required/], [[], /args required/], ['x', /args required/],
    [{ units: ['a'] }, /targetDir/], [{ targetDir: ' ', units: ['a'] }, /targetDir/],
    [{ targetDir: '/t' }, /units/], [{ targetDir: '/t', units: [] }, /units/], [{ targetDir: '/t', units: 'a' }, /units/],
    [{ ...good, units: ['a b'] }, /invalid unit name/], [{ ...good, units: ['a:b'] }, /invalid unit name/],
    [{ ...good, units: ['a#r1'] }, /invalid unit name/], [{ ...good, units: [''] }, /invalid unit name/], [{ ...good, units: [3] }, /invalid unit name/],
    [{ ...good, units: ['a', 'a'] }, /duplicates/],
    [{ ...good, maxRounds: 0 }, /maxRounds/], [{ ...good, maxRounds: 1.5 }, /maxRounds/], [{ ...good, maxRounds: '3' }, /maxRounds/],
    [{ ...good, testCmd: '' }, /testCmd/], [{ ...good, model: '' }, /model/],
    // targetDir is placed inside cd "..." in shell commands: quotes, $, backticks, backslashes, newlines are refused
    [{ ...good, targetDir: '/work/my "dir"' }, /targetDir/], [{ ...good, targetDir: '/work/$HOME' }, /targetDir/],
    [{ ...good, targetDir: '/work/`id`' }, /targetDir/], [{ ...good, targetDir: '/work/a\\b' }, /targetDir/],
    [{ ...good, targetDir: '/work/a\nb' }, /targetDir/],
    // a leading ~ is not expanded inside double quotes, a leading - is an option for cd, edge whitespace breaks cd
    [{ ...good, targetDir: '~/work/target-a' }, /targetDir/], [{ ...good, targetDir: ' /work/target-a' }, /targetDir/],
    [{ ...good, targetDir: '/work/target-a ' }, /targetDir/], [{ ...good, targetDir: '-work/target-a' }, /targetDir/],
    [{ ...good, targetDir: '/work/target-a\u00a0' }, /targetDir/],
    // "prep" is the unit name of the Prep agents; names that differ only by case are one file on macOS
    [{ ...good, units: ['prep'] }, /prep/], [{ ...good, units: ['Prep'] }, /prep/], [{ ...good, units: ['a', 'PREP'] }, /prep/],
    [{ ...good, units: ['chunk', 'Chunk'] }, /duplicates/], [{ ...good, units: ['a', 'b', 'A'] }, /duplicates/],
  ]
  for (const [args, re] of cases) {
    const r = await dryRun(SCRIPT, { args, respond: makeRespond() })
    assert.match(r.error?.message ?? '', re, JSON.stringify(args))
    assert.equal(r.calls.length, 0, `no agent for ${JSON.stringify(args)}`)
  }
})

test('targetDir with spaces, dots and non-ASCII letters is accepted and appears quoted in the shell commands', async () => {
  const dir = '/work/my target-a v1.2/\u00e4\u043f'
  const r = await run({}, { targetDir: dir, units: ['slugify'] })
  assert.equal(r.error, null)
  assert.ok(callsOf(r, 'review-a', 'slugify', 1)[0].prompt.includes(`cd "${dir}" && diff -u`))
  assert.ok(callsOf(r, 'test', 'slugify', 1)[0].prompt.includes(`in "${dir}"`))
})

test('a ~ inside the path and unit names that merely contain "prep" are accepted', async () => {
  const r = await run({}, { targetDir: '/work/a~b-c', units: ['preparation', 'prep2', 'x-prep'] })
  assert.equal(r.error, null)
  assert.deepEqual(r.result.units.map((u) => u.status), ['pass', 'pass', 'pass'])
})

test('defaults: test command with {unit} replaced, model haiku on every agent, three rounds', async () => {
  const r = await run({ test: () => ({ exitCode: 1, outputTail: FAIL }) }, { units: ['slugify'] })
  assert.equal(r.error, null)
  assert.ok(callsOf(r, 'test', 'slugify', 1)[0].prompt.includes('node --test test/slugify.test.mjs'))
  assert.ok(callsOf(r, 'implement', 'slugify', 1)[0].prompt.includes('node --test test/slugify.test.mjs'))
  assert.ok(r.calls.every((c) => c.opts.model === 'haiku'))
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'blocked', rounds: 3 })
})

test('custom testCmd, model and maxRounds are used', async () => {
  const r = await run({ test: () => ({ exitCode: 1, outputTail: FAIL }) },
    { units: ['chunk'], testCmd: 'node --test --test-reporter=tap test/{unit}.test.mjs', model: 'sonnet', maxRounds: 2 })
  assert.ok(callsOf(r, 'test', 'chunk', 1)[0].prompt.includes('node --test --test-reporter=tap test/chunk.test.mjs'))
  assert.ok(r.calls.every((c) => c.opts.model === 'sonnet'))
  assert.deepEqual(unitReport(r, 'chunk'), { unit: 'chunk', status: 'blocked', rounds: 2 })
})

// ---------- Prep ----------
test('Prep: guide writer first, then both guide reviewers in parallel, then the units', async () => {
  const r = await run({})
  assert.deepEqual(r.calls.slice(0, 3).map((c) => c.label), ['guide:prep#r1', 'review-a:prep#r1', 'review-b:prep#r1'])
  assert.ok(r.calls.slice(0, 3).every((c) => c.phase === 'Prep'))
  assert.equal(callsOf(r, 'guide', 'prep', 2).length, 0, 'no revision without issues')
  const firstImplement = r.calls.findIndex((c) => c.label.startsWith('implement:'))
  assert.equal(firstImplement, 3)
  for (const u of UNITS) {
    assert.ok(r.calls[0].prompt.includes(`src/${u}.mjs -> .wf/orig/src/${u}.mjs`), `writer snapshots src of ${u}`)
    assert.ok(r.calls[0].prompt.includes(`test/${u}.test.mjs -> .wf/orig/test/${u}.test.mjs`), `writer snapshots tests of ${u}`)
  }
  assert.ok(callsOf(r, 'review-a', 'slugify', 1)[0].prompt.includes('diff -u .wf/orig/src/slugify.mjs src/slugify.mjs'))
})

test('Prep: reported guide issues are applied once, before any implementer', async () => {
  const issue = (d) => ({ section: 'chunk', description: d, suggestion: 'add it' })
  const r = await run({
    'prep-review-a': () => ({ issues: [issue('ISSUE-FROM-A')] }),
    'prep-review-b': () => ({ issues: [issue('ISSUE-FROM-B')] }),
  })
  const revise = callsOf(r, 'guide', 'prep', 2)
  assert.equal(revise.length, 1)
  assert.equal(revise[0].phase, 'Prep')
  assert.ok(revise[0].prompt.includes('ISSUE-FROM-A') && revise[0].prompt.includes('ISSUE-FROM-B'))
  assert.ok(revise[0].n < r.calls.find((c) => c.label.startsWith('implement:')).n)
})

test('Prep: a dead guide writer stops the run; dead guide reviewers only log', async () => {
  const dead = await run({ 'prep-guide': () => null })
  assert.match(dead.error?.message ?? '', /guide writer/)
  assert.equal(dead.calls.length, 1)

  const r = await run({ 'prep-review-a': () => null, 'prep-review-b': () => null }, { units: ['slugify'] })
  assert.equal(r.error, null)
  assert.ok(r.logs.some((l) => /guide check incomplete/.test(l)))
  assert.equal(unitReport(r, 'slugify').status, 'pass')
})

// The baseline snapshot in .wf/orig is what every review diffs against.
test('Prep: the writer snapshots TASK.md and GUIDE.md too, locks the baseline, counts the starting tests', async () => {
  const r = await run({}, { units: ['slugify', 'chunk'] })
  const w = r.calls[0].prompt
  assert.ok(w.includes('TASK.md -> .wf/orig/TASK.md'))
  assert.ok(w.includes('.wf/orig/GUIDE.md'))
  assert.ok(w.includes('chmod a-w'), 'the baseline files are made read-only')
  assert.ok(w.includes('chunk: node --test test/chunk.test.mjs') && w.includes('slugify: node --test test/slugify.test.mjs'), 'starting test counts')
  assert.match(w, /summary block/)
  assert.match(w, /\.wf directory already exists/)
  for (const who of ['a', 'b']) {
    const c = callsOf(r, `review-${who}`, 'prep', 1)[0].prompt
    assert.ok(c.includes(baselineList(['slugify', 'chunk']).join(', ')), 'reviewers check the full baseline list')
    assert.ok(c.includes('find .wf -type f -perm -200'))
    assert.match(c, /snapshotProblems/)
  }
  assert.ok(r.logs.some((l) => /did not report the baseline snapshot/.test(l)), 'an unreported snapshot is logged, not invented')
})

test('Prep: a .wf directory left by an earlier run stops the run before anything else', async () => {
  const r = await run({ 'prep-guide': () => ({ files: [], note: 'exists', snapshot: [], alreadyExisted: true, baseline: [] }) })
  assert.match(r.error?.message ?? '', /already has a \.wf directory/)
  assert.equal(r.calls.length, 1, 'no reviewers, no implementer')
})

test('Prep: a snapshot the writer reports as incomplete is repaired once and confirmed, else the run stops', async () => {
  const all = baselineList(UNITS)
  const partial = all.filter((p) => p !== 'test/chunk.test.mjs')
  const write = (c) => ({ files: ['GUIDE.md'], note: 'w', snapshot: partial, alreadyExisted: false, baseline: [], ...c })

  const repaired = await run({
    'prep-guide': (c) => (c.round === 1 ? write() : { files: ['GUIDE.md'], note: 'r', snapshot: all.map((p) => `.wf/orig/${p}`) }),
  })
  assert.equal(repaired.error, null)
  const revise = callsOf(repaired, 'guide', 'prep', 2)
  assert.equal(revise.length, 1)
  assert.ok(revise[0].prompt.includes('test/chunk.test.mjs'), 'the problem names the missing file')
  assert.match(revise[0].prompt, /identical to the file at the same path/)
  assert.ok(!/Edit GUIDE\.md only/.test(revise[0].prompt), 'the revision may recreate the baseline')
  assert.ok(revise[0].n < repaired.calls.find((c) => c.label.startsWith('implement:')).n)
  assert.deepEqual(repaired.result.units.map((u) => u.status), ['pass', 'pass', 'pass'])

  for (const [name, reviser] of [['still incomplete', () => ({ files: [], note: 'r', snapshot: partial })], ['no report', () => ({ files: [], note: 'r' })], ['dead', () => null]]) {
    const r = await run({ 'prep-guide': (c) => (c.round === 1 ? write() : reviser()) })
    assert.match(r.error?.message ?? '', /baseline snapshot .* is not confirmed/, name)
    assert.ok(!r.calls.some((c) => c.label.startsWith('implement:')), `${name}: no implementer runs without a baseline`)
  }
})

test('Prep: a missing baseline reported as a plain guide issue is treated as a baseline problem too', async () => {
  const issue = { section: '.wf/orig', description: '.wf/orig is missing', suggestion: 'create the snapshot' }
  const all = baselineList(['slugify'])
  const reviewers = { 'prep-review-a': () => ({ issues: [issue], snapshotProblems: [] }) }

  const stop = await run(reviewers, { units: ['slugify'] })
  assert.match(stop.error?.message ?? '', /not confirmed/)
  assert.ok(!stop.calls.some((c) => c.label.startsWith('implement:')))
  assert.equal(callsOf(stop, 'guide', 'prep', 2).length, 1)

  const ok = await run({ ...reviewers, 'prep-guide': (c) => (c.round === 1 ? { files: ['GUIDE.md'], note: 'w' } : { files: [], note: 'r', snapshot: all }) }, { units: ['slugify'] })
  assert.equal(ok.error, null)
  assert.ok(callsOf(ok, 'guide', 'prep', 2)[0].prompt.includes('.wf/orig is missing'))
  assert.equal(unitReport(ok, 'slugify').status, 'pass')
})

test('Prep: a baseline problem reported by a prep reviewer is repaired once and confirmed, else the run stops', async () => {
  const problem = '.wf/orig/src/slugify.mjs differs from src/slugify.mjs'
  const reviewers = { 'prep-review-a': () => ({ issues: [], snapshotProblems: [] }), 'prep-review-b': () => ({ issues: [], snapshotProblems: [problem, ' '] }) }
  const all = baselineList(['slugify'])

  const ok = await run({ ...reviewers, 'prep-guide': (c) => (c.round === 1 ? { files: ['GUIDE.md'], note: 'w', snapshot: all, alreadyExisted: false, baseline: [] } : { files: [], note: 'r', snapshot: all }) }, { units: ['slugify'] })
  assert.equal(ok.error, null)
  const revise = callsOf(ok, 'guide', 'prep', 2)
  assert.equal(revise.length, 1)
  assert.ok(revise[0].prompt.includes(problem))
  assert.ok(!revise[0].prompt.includes('" "'), 'blank problems are not passed on')
  assert.equal(unitReport(ok, 'slugify').status, 'pass')

  const stop = await run(reviewers, { units: ['slugify'] })   // the default reviser reports no snapshot
  assert.match(stop.error?.message ?? '', /not confirmed/)
  assert.ok(stop.error.message.includes(problem))
  assert.ok(!stop.calls.some((c) => c.label.startsWith('implement:')))
})

// ---------- loop ----------
test('happy path: reviewers agree, fixer, tests pass, judge only for the empty second round', async () => {
  const find = (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs`, line: 5, category: `cat-${c.unit}` })] : [] })
  const r = await run({ 'review-a': find, 'review-b': find })
  assert.equal(r.error, null)
  for (const u of UNITS) {
    assert.deepEqual(labelsOf(r, u), [
      `implement:${u}#r1`, `review-a:${u}#r1`, `review-b:${u}#r1`, `fix:${u}#r1`, `test:${u}#r1`,
      `review-a:${u}#r2`, `review-b:${u}#r2`, `judge:${u}#r2`, `test:${u}#r2`,
    ])
  }
  assert.equal(r.calls.length, 3 + 3 * 9)
  assert.deepEqual(r.result.units, UNITS.map((unit) => ({ unit, status: 'pass', rounds: 2 })))
  assert.equal(r.result.bugsCaught, 3)
  assert.equal(r.result.droppedByJudge, 0)
  assert.deepEqual(r.result.rulesAdded, [])
  assert.deepEqual([r.result.tests.passed, r.result.tests.failed, r.result.tests.skipped, r.result.tests.total], [9, 0, 0, 9])
})

test('a unit that is clean in round 1 takes one test agent call and no fixer', async () => {
  const r = await run({}, { units: ['chunk'] })
  assert.deepEqual(labelsOf(r, 'chunk'), ['implement:chunk#r1', 'review-a:chunk#r1', 'review-b:chunk#r1', 'judge:chunk#r1', 'test:chunk#r1'])
  assert.deepEqual(unitReport(r, 'chunk'), { unit: 'chunk', status: 'pass', rounds: 1 })
})

test('reviewers disagree: judge is called, only approved findings reach the fixer', async () => {
  const X = F({ line: 3, description: 'DESC-X', input: 'f("x")' })
  const Y = F({ line: 9, description: 'DESC-Y', input: 'f("y")', category: 'other' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [Y] : [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [{ index: 1, reason: 'cannot reproduce' }], missed: [] } : ACCEPT,
  }, { units: ['slugify'] })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r, 'slugify'), [
    'implement:slugify#r1', 'review-a:slugify#r1', 'review-b:slugify#r1', 'judge:slugify#r1', 'fix:slugify#r1', 'test:slugify#r1',
    'review-a:slugify#r2', 'review-b:slugify#r2', 'judge:slugify#r2', 'test:slugify#r2',
  ])
  const judge = callsOf(r, 'judge', 'slugify', 1)[0]
  assert.equal(judge.phase, 'Judge')
  assert.match(judge.prompt, /reviewers disagree/)
  assert.ok(judge.prompt.includes('DESC-X') && judge.prompt.includes('DESC-Y'))
  const fixer = callsOf(r, 'fix', 'slugify', 1)[0]
  assert.ok(fixer.prompt.includes('DESC-X') && !fixer.prompt.includes('DESC-Y'))
  assert.equal(r.result.droppedByJudge, 1)
  assert.equal(r.result.bugsCaught, 1)
})

test('one reviewer finding a subset of the other is still a disagreement', async () => {
  const X = F({ line: 3, description: 'DESC-X' }), Y = F({ line: 9, description: 'DESC-Y' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X, Y] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0, 1], dropped: [], missed: [] } : ACCEPT,
  }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'judge', 'slugify', 1).length, 1)
  assert.equal(r.result.bugsCaught, 2)
})

test('both reviewers find nothing: judge is called and no fixer runs when it accepts', async () => {
  const r = await run({}, { units: ['slugify'] })
  assert.deepEqual(labelsOf(r, 'slugify'), ['implement:slugify#r1', 'review-a:slugify#r1', 'review-b:slugify#r1', 'judge:slugify#r1', 'test:slugify#r1'])
  const judge = callsOf(r, 'judge', 'slugify', 1)[0]
  assert.match(judge.prompt, /both reviewers found nothing/)
  assert.equal(judge.phase, 'Judge')
  assert.equal(r.result.bugsCaught, 0)
})

test('both-empty judge that finds a missed bug sends it to the fixer', async () => {
  const Z = F({ line: 7, description: 'DESC-MISSED', input: 'f(null)', category: 'stub' })
  const r = await run({
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [], dropped: [], missed: [Z] } : ACCEPT,
  }, { units: ['slugify'] })
  assert.ok(callsOf(r, 'fix', 'slugify', 1)[0].prompt.includes('DESC-MISSED'))
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 2 })
  assert.equal(r.result.bugsCaught, 1)
})

test('reviewers agree on the same file:line: judge is skipped for that round', async () => {
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [F({ line: 4, description: 'A-WORDING', severity: 'high' })] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [F({ line: 4, description: 'B-WORDING', severity: 'low' })] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'judge', 'slugify', 1).length, 0)
  assert.equal(callsOf(r, 'fix', 'slugify', 1).length, 1)
  assert.equal(callsOf(r, 'judge', 'slugify').length, 1, 'judge only in the empty round 2')
  assert.equal(r.result.bugsCaught, 1, 'one bug, reported twice')
})

test('findings without file, line or input are dropped by code before the judge and the fixer', async () => {
  const X = F({ line: 4, description: 'REAL' })
  const { line: _l, ...noLine } = F({ description: 'INVALID-NO-LINE' })
  const { input: _i, ...noInput } = F({ description: 'INVALID-NO-INPUT', line: 5 })
  const invalid = [
    F({ file: '', description: 'INVALID-NO-FILE' }), noLine, F({ line: 0, description: 'INVALID-LINE-0' }),
    F({ line: null, description: 'INVALID-LINE-NULL' }), F({ line: 2.5, description: 'INVALID-LINE-FRACTION' }),
    noInput, F({ input: '   ', line: 6, description: 'INVALID-BLANK-INPUT' }),
  ]

  // an invalid extra finding does not turn agreement into disagreement
  const agree = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X, ...invalid] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [X] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(agree, 'judge', 'slugify', 1).length, 0)
  assert.ok(!callsOf(agree, 'fix', 'slugify', 1)[0].prompt.includes('INVALID'))
  assert.equal(agree.result.droppedByCode, invalid.length)
  assert.equal(agree.result.bugsCaught, 1)

  // only invalid findings count as "found nothing": judge is called, but never sees them
  const empty = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? invalid : [] }),
  }, { units: ['slugify'] })
  const judge = callsOf(empty, 'judge', 'slugify', 1)[0]
  assert.match(judge.prompt, /both reviewers found nothing/)
  assert.ok(!judge.prompt.includes('INVALID'))
  assert.equal(empty.result.droppedByCode, invalid.length)
  assert.equal(empty.result.bugsCaught, 0)
})

test('an invalid finding in the judge missed list is dropped by code', async () => {
  const r = await run({
    judge: () => ({ verdict: 'accept', approved: [], dropped: [], missed: [F({ file: '', description: 'INVALID-MISSED' })] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'fix', 'slugify').length, 0)
  assert.equal(r.result.droppedByCode, 1)
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 1 })
})

test('judge indexes out of range or both approved and dropped are not counted twice', async () => {
  const X = F({ line: 3, description: 'DESC-X' }), Y = F({ line: 9, description: 'DESC-Y' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [Y] : [] }),
    judge: (c) => c.round === 1
      ? { verdict: 'fix', approved: [0, 0, 7, -1], dropped: [{ index: 0, reason: 'x' }, { index: 1, reason: 'y' }, { index: 1, reason: 'y again' }, { index: 9, reason: 'z' }], missed: [] }
      : ACCEPT,
  }, { units: ['slugify'] })
  assert.equal(r.result.bugsCaught, 1)
  assert.equal(r.result.droppedByJudge, 1, 'only index 1, once')
})

test('two different bugs on one file:line are two findings; reviewers match them by category or input, not by line', async () => {
  const P = F({ line: 4, input: 'slugify("a  b")', category: 'no-collapse', description: 'DESC-P' })
  const Q = F({ line: 4, input: 'slugify("-a-")', category: 'no-trim', description: 'DESC-Q' })

  // both reviewers report both, reordered and worded differently: agreement, one fixer call with both
  const agree = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P, Q] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [{ ...Q, description: 'B-Q' }, { ...P, input: 'slugify("x   y")', description: 'B-P' }] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(agree, 'judge', 'slugify', 1).length, 0)
  const fixer = callsOf(agree, 'fix', 'slugify', 1)[0]
  assert.ok(fixer.prompt.includes('DESC-P') && fixer.prompt.includes('DESC-Q'), 'neither bug is lost')
  assert.equal(agree.result.bugsCaught, 2)

  // reviewer b sees only one of them: disagreement, the judge gets both as separate entries
  const subset = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P, Q] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [P] : [] }),
    judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0, 1], dropped: [], missed: [] } : ACCEPT),
  }, { units: ['slugify'] })
  const judge = callsOf(subset, 'judge', 'slugify', 1)[0]
  assert.match(judge.prompt, /reviewers disagree/)
  assert.ok(judge.prompt.includes('DESC-P') && judge.prompt.includes('DESC-Q'))
  assert.match(judge.prompt, /"index":1,"reportedBy":\["a"\]/)
  assert.equal(subset.result.bugsCaught, 2)

  // the same input under two category names is still one bug; a reviewer repeating itself is one finding
  const same = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P, P] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [{ ...P, category: 'whitespace' }] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(same, 'judge', 'slugify', 1).length, 0)
  assert.equal(same.result.bugsCaught, 1)
})

test('a finding the judge neither approves nor drops counts as dropped and is logged', async () => {
  const X = F({ line: 3, description: 'DESC-X' }), Y = F({ line: 9, description: 'DESC-Y', category: 'other' })
  const reviewers = {
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [Y] : [] }),
  }
  const silent = await run({ ...reviewers, judge: () => ACCEPT }, { units: ['slugify'] })
  assert.equal(silent.result.droppedByJudge, 2)
  assert.equal(silent.result.bugsCaught, 0)
  assert.ok(silent.logs.some((l) => /judge left 2 finding\(s\) without a decision/.test(l)))
  assert.equal(callsOf(silent, 'fix', 'slugify').length, 0)

  const partial = await run({ ...reviewers, judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [], missed: [] } : ACCEPT) }, { units: ['slugify'] })
  assert.equal(partial.result.droppedByJudge, 1)
  assert.equal(partial.result.bugsCaught, 1)
  assert.ok(partial.logs.some((l) => /judge left 1 finding\(s\) without a decision/.test(l)))

  const listed = await run({ ...reviewers, judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [{ index: 1, reason: 'no' }], missed: [] } : ACCEPT) }, { units: ['slugify'] })
  assert.equal(listed.result.droppedByJudge, 1, 'listed once, counted once')
  assert.ok(!listed.logs.some((l) => /without a decision/.test(l)))
})

// Two findings on one file:line with the same category but another failing input are two bugs.
const VAL = (input, description, over = {}) => F({ file: 'src/slugify.mjs', line: 1, input, category: 'missing-validation', description, ...over })

test('a bug the judge reports as missed is kept when an approved finding has the same file:line and category but another input', async () => {
  const P = VAL('slugify(null)', 'DESC-P'), M = VAL('slugify(undefined)', 'DESC-M')
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P] : [] }),
    judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [], missed: [M] } : ACCEPT),
  }, { units: ['slugify'] })
  const fixer = callsOf(r, 'fix', 'slugify', 1)[0]
  assert.ok(fixer.prompt.includes('DESC-P') && fixer.prompt.includes('DESC-M'), 'the missed bug reaches the fixer')
  assert.equal(r.result.bugsCaught, 2)
})

test('a missed finding that repeats an approved one is not sent twice, whatever its wording or path spelling', async () => {
  const P = VAL('slugify(null)', 'DESC-P')
  const again = { ...P, file: './src/slugify.mjs', description: 'DESC-P-AGAIN', severity: 'low' }
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P] : [] }),
    judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [], missed: [again] } : ACCEPT),
  }, { units: ['slugify'] })
  const fixer = callsOf(r, 'fix', 'slugify', 1)[0]
  assert.ok(fixer.prompt.includes('DESC-P') && !fixer.prompt.includes('DESC-P-AGAIN'))
  assert.equal(r.result.bugsCaught, 1)
  assert.equal(r.result.droppedByJudge, 0)
})

test('a finding the judge explicitly drops counts as dropped even when an approved one shares its file:line and category', async () => {
  const P = VAL('slugify(null)', 'DESC-P'), Q = VAL('slugify(undefined)', 'DESC-Q')
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [P, Q] : [] }),
    judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [{ index: 1, reason: 'cannot reproduce' }], missed: [] } : ACCEPT),
  }, { units: ['slugify'] })
  assert.equal(r.result.droppedByJudge, 1)
  assert.equal(r.result.bugsCaught, 1)
  const fixer = callsOf(r, 'fix', 'slugify', 1)[0]
  assert.ok(fixer.prompt.includes('DESC-P') && !fixer.prompt.includes('DESC-Q'))
  assert.ok(!r.logs.some((l) => /without a decision/.test(l)), 'the judge did decide')
})

test('a judge that says accept but approves something: the fixer still gets it and the round is not accepted', async () => {
  const X = F({ line: 3, description: 'DESC-X' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    judge: () => ({ verdict: 'accept', approved: [0], dropped: [], missed: [] }),
  }, { units: ['slugify'] })
  assert.ok(callsOf(r, 'fix', 'slugify', 1)[0].prompt.includes('DESC-X'))
  assert.ok(r.logs.some((l) => /judge said accept but approved 1 finding/.test(l)))
  assert.equal(r.result.bugsCaught, 1)
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 2 })
})

test('the same bug reported as ./src/x.mjs by one reviewer and src/x.mjs by the other is one finding: agreement', async () => {
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [F({ file: './src/x.mjs', line: 4 })] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [F({ file: 'src/x.mjs', line: 4 })] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'judge', 'slugify', 1).length, 0)
  assert.equal(callsOf(r, 'fix', 'slugify', 1).length, 1)
  assert.equal(r.result.bugsCaught, 1)
})

test('within one reviewer a finding is the same bug only when category and input both match; both reviewers agreeing keeps all of them', async () => {
  const P = VAL('chunk([1], 0)', 'DESC-P')
  const sameCategory = VAL('chunk([1], 1.5)', 'DESC-SAME-CATEGORY')                                   // same line, same category, other input
  const sameInput = VAL('chunk([1], 0)', 'DESC-SAME-INPUT', { category: 'wrong-error-type' })        // same line, same input, other category
  const find = (c) => ({ findings: c.round === 1 ? [P, sameCategory, sameInput] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'judge', 'slugify', 1).length, 0, 'full agreement')
  const fixer = callsOf(r, 'fix', 'slugify', 1)[0]
  for (const d of ['DESC-P', 'DESC-SAME-CATEGORY', 'DESC-SAME-INPUT']) assert.ok(fixer.prompt.includes(d), `${d} reaches the fixer`)
  assert.equal(r.result.bugsCaught, 3, 'three bugs on one line, none merged')
})

test('bugsCaught counts two inputs that fail on one line as two bugs, also when both reviewers report both', async () => {
  const P = VAL('slugify(null)', 'DESC-P'), Q = VAL('slugify(undefined)', 'DESC-Q')
  const find = (c) => ({ findings: c.round === 1 ? [P, Q] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.equal(callsOf(r, 'judge', 'slugify', 1).length, 0)
  assert.equal(r.result.bugsCaught, 2)
  // the same finding approved again after a failed fix is still one bug
  const again = (c) => ({ findings: c.round <= 2 ? [P] : [] })
  const twice = await run({ 'review-a': again, 'review-b': again }, { units: ['slugify'] })
  assert.equal(twice.result.bugsCaught, 1)
})

test('two findings with no category on one line are not the same bug unless their input matches', async () => {
  const a = F({ line: 4, category: '', input: 'f("a")', description: 'DESC-A' })
  const b = F({ line: 4, category: '', input: 'f("b")', description: 'DESC-B' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [a] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [b] : [] }),
    judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [0, 1], dropped: [], missed: [] } : ACCEPT),
  }, { units: ['slugify'] })
  const judge = callsOf(r, 'judge', 'slugify', 1)[0]
  assert.match(judge.prompt, /reviewers disagree/)
  assert.ok(judge.prompt.includes('DESC-A') && judge.prompt.includes('DESC-B'), 'two entries, not one')
  assert.equal(r.result.bugsCaught, 2)

  const same = F({ line: 4, category: '', input: 'f("a")', description: 'DESC-A' })
  const agree = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [same] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [{ ...same, description: 'DESC-B' }] : [] }),
  }, { units: ['slugify'] })
  assert.equal(callsOf(agree, 'judge', 'slugify', 1).length, 0, 'the same input is the same bug without a category')
})

test('the fixer sees the last 1500 characters of a failing test output, not all of it', async () => {
  const long = `HEAD-MARK\n${'x'.repeat(2500)}\n${FAIL}`
  const r = await run({ test: (c) => (c.round === 1 ? { exitCode: 1, outputTail: long } : { exitCode: 0, outputTail: PASS }) }, { units: ['slugify'] })
  const p = callsOf(r, 'fix', 'slugify', 2)[0].prompt
  assert.ok(p.includes('# fail 1'), 'the summary is at the end of the tail')
  assert.ok(p.includes('x'.repeat(1400)) && !p.includes('x'.repeat(1500)) && !p.includes('HEAD-MARK'))
  assert.match(p, /Fix what it shows/)
})

test('reviewers and the judge also see TASK.md, GUIDE.md, the other units\' tests, the file list and any writable baseline file', async () => {
  const r = await run({}, { units: ['slugify', 'chunk'] })   // both reviewers empty: the judge is called too
  const prompts = [
    callsOf(r, 'review-a', 'slugify', 1)[0].prompt, callsOf(r, 'review-b', 'slugify', 1)[0].prompt, callsOf(r, 'judge', 'slugify', 1)[0].prompt,
  ]
  for (const p of prompts) {
    for (const part of [
      'diff -u .wf/orig/src/slugify.mjs src/slugify.mjs', 'diff -u .wf/orig/test/slugify.test.mjs test/slugify.test.mjs',
      'diff -u .wf/orig/TASK.md TASK.md', 'diff -u .wf/orig/GUIDE.md GUIDE.md', 'diff -u .wf/orig/test/chunk.test.mjs test/chunk.test.mjs',
      'find . -path ./.wf -prune -o -type f -print', 'find .wf -type f -perm -200',
      './TASK.md ./GUIDE.md ./src/slugify.mjs ./test/slugify.test.mjs ./src/chunk.mjs ./test/chunk.test.mjs',
    ]) assert.ok(p.includes(part), part)
    assert.ok(!p.includes('.wf/orig/src/chunk.mjs'), 'another unit\'s src is not diffed: it changes legitimately')
    assert.match(p, /edit outside the unit/)
  }
  // the diff of a unit starts with its own source, so its own tests are not listed twice
  assert.equal(prompts[0].split('diff -u .wf/orig/test/slugify.test.mjs').length, 2)
})

test('the fixer may restore a changed test, TASK.md or an extra file from the baseline, and may not write into .wf', async () => {
  const F1 = F({ file: 'test/slugify.test.mjs', line: 3, input: 'diff -u .wf/orig/test/slugify.test.mjs test/slugify.test.mjs', category: 'weakened-test' })
  const find = (c) => ({ findings: c.round === 1 ? [F1] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  const p = callsOf(r, 'fix', 'slugify', 1)[0].prompt
  assert.ok(p.includes(JSON.stringify(F1)))
  assert.ok(p.includes('cp .wf/orig/test/<name>.test.mjs test/<name>.test.mjs') && p.includes('cp .wf/orig/TASK.md TASK.md'))
  assert.match(p, /delete a file that was added/)
  assert.match(p, /Never write into \.wf\//)
  assert.match(p, /Do not weaken, skip or delete tests/)
})

test('unit that never passes stops after maxRounds as blocked; others are unaffected', async () => {
  const r = await run({ test: (c) => c.unit === 'chunk' ? { exitCode: 1, outputTail: `# a diagnostic\n${FAIL}` } : { exitCode: 0, outputTail: PASS } })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r, 'chunk'), [
    'implement:chunk#r1',
    'review-a:chunk#r1', 'review-b:chunk#r1', 'judge:chunk#r1', 'test:chunk#r1',
    'review-a:chunk#r2', 'review-b:chunk#r2', 'judge:chunk#r2', 'fix:chunk#r2', 'test:chunk#r2',
    'review-a:chunk#r3', 'review-b:chunk#r3', 'judge:chunk#r3', 'fix:chunk#r3', 'test:chunk#r3',
  ])
  assert.ok(!r.calls.some((c) => /#r4$/.test(c.label)), 'no fourth round')
  assert.ok(callsOf(r, 'fix', 'chunk', 2)[0].prompt.includes('# fail 1'), 'fixer sees the failing test output')
  assert.deepEqual(unitReport(r, 'chunk'), { unit: 'chunk', status: 'blocked', rounds: 3 })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 1 })
  assert.deepEqual(unitReport(r, 'duration'), { unit: 'duration', status: 'pass', rounds: 1 })
  // the report shows each unit's last test run: slugify 3, duration 3, chunk 2 passed and 1 failed
  assert.deepEqual([r.result.tests.passed, r.result.tests.failed], [8, 1])
  assert.ok(r.logs.some((l) => /chunk: blocked after 3 round/.test(l)))
})

test('maxRounds bounds the loop', async () => {
  for (const maxRounds of [1, 2, 4]) {
    const r = await run({ test: () => ({ exitCode: 1, outputTail: FAIL }) }, { units: ['chunk'], maxRounds })
    assert.deepEqual(unitReport(r, 'chunk'), { unit: 'chunk', status: 'blocked', rounds: maxRounds })
    assert.equal(callsOf(r, 'test', 'chunk').length, maxRounds)
    assert.ok(!r.calls.some((c) => parseLabel(c.label).round > maxRounds))
  }
})

test('a unit whose reviewers keep finding bugs is blocked even though tests pass', async () => {
  const find = (c) => ({ findings: [F({ line: 10 * c.round, category: `cat-r${c.round}` })] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'blocked', rounds: 3 })
  assert.deepEqual(callsOf(r, 'fix', 'slugify').map((c) => parseLabel(c.label).round), [1, 2, 3])
  assert.equal(callsOf(r, 'judge', 'slugify').length, 0)
  assert.equal(r.result.tests.failed, 0)
  assert.equal(r.result.bugsCaught, 3)
})

test('a round whose fixer only repaired failing tests is not accepted until re-reviewed', async () => {
  // r1: tests fail. r2: reviewers find nothing but the fixer must repair the tests, so r2 is not clean.
  // r3: nothing to fix, tests pass -> pass in round 3.
  const r = await run({ test: (c) => c.round === 1 ? { exitCode: 1, outputTail: FAIL } : { exitCode: 0, outputTail: PASS } }, { units: ['slugify'] })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 3 })
  assert.deepEqual(callsOf(r, 'fix', 'slugify').map((c) => parseLabel(c.label).round), [2])
})

// ---------- test output parsing ----------
test('test counts are parsed in code from "# pass N", "# fail N", "# skipped N"', async (t) => {
  const tap = (o) => `# tests ${o.tests ?? o.pass + o.fail + o.skipped}\n# suites 0\n# pass ${o.pass}\n# fail ${o.fail}\n# cancelled ${o.cancelled ?? 0}\n# skipped ${o.skipped}\n# todo 0\n# duration_ms 5\n`
  const cases = [
    { name: 'clean tap output', exit: 0, out: tap({ pass: 3, fail: 0, skipped: 0 }), status: 'pass', counts: [3, 0, 0] },
    { name: 'clean spec-reporter output (info sign)', exit: 0, out: 'ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n', status: 'pass', counts: [3, 0, 0] },
    { name: 'colored spec-reporter output', exit: 0, out: '\u001b[34mℹ\u001b[39m tests 3\n\u001b[34mℹ\u001b[39m pass 3\n\u001b[34mℹ\u001b[39m fail 0\n\u001b[34mℹ\u001b[39m cancelled 0\n\u001b[34mℹ\u001b[39m skipped 0\n', status: 'pass', counts: [3, 0, 0] },
    { name: 'last summary wins over earlier diagnostics', exit: 0, out: `# pass 99\n${tap({ pass: 3, fail: 0, skipped: 0 })}`, status: 'pass', counts: [3, 0, 0] },
    { name: 'a skipped test is not a pass', exit: 0, out: tap({ pass: 2, fail: 0, skipped: 1 }), status: 'blocked', counts: [2, 0, 1] },
    { name: 'a failed test with exit code 0 is not a pass', exit: 0, out: tap({ pass: 2, fail: 1, skipped: 0 }), status: 'blocked', counts: [2, 1, 0] },
    { name: 'a non-zero exit code is not a pass', exit: 1, out: tap({ pass: 3, fail: 0, skipped: 0 }), status: 'blocked', counts: [3, 0, 0] },
    { name: 'zero tests is not a pass', exit: 0, out: tap({ pass: 0, fail: 0, skipped: 0 }), status: 'blocked', counts: [0, 0, 0] },
    { name: 'a todo test is skipped in effect: not a pass (node 26: exit 0, pass 2, fail 0, skipped 0, todo 1, tests 3)', exit: 0, out: '# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n', status: 'blocked', counts: [2, 0, 0] },
    { name: 'a todo test in spec-reporter output is not a pass either', exit: 0, out: 'ℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 1\n', status: 'blocked', counts: [2, 0, 0] },
    { name: 'a cancelled test is not a pass', exit: 0, out: tap({ pass: 3, fail: 0, skipped: 0, cancelled: 1, tests: 4 }), status: 'blocked', counts: [3, 0, 0] },
    { name: 'unparsable output is not a pass and stays null in the report', exit: 0, out: 'all good, trust me', status: 'blocked', counts: [null, null, null] },
  ]
  for (const c of cases) {
    await t.test(c.name, async () => {
      const r = await run({ test: () => ({ exitCode: c.exit, outputTail: c.out }) }, { units: ['slugify'] })
      assert.equal(r.error, null)
      assert.equal(unitReport(r, 'slugify').status, c.status)
      if (c.status === 'pass') assert.equal(unitReport(r, 'slugify').rounds, 1)
      assert.deepEqual([r.result.tests.passed, r.result.tests.failed, r.result.tests.skipped], c.counts)
    })
  }
  await t.test('a dead test agent is not a pass', async () => {
    const r = await run({ test: () => null }, { units: ['slugify'] })
    assert.equal(unitReport(r, 'slugify').status, 'blocked')
    assert.equal(r.result.tests.passed, null)
  })
})

test('a smaller test count than seen before means tests were removed: not a pass', async () => {
  const shrink = { 'review-a': (c) => ({ findings: c.round === 1 ? [F()] : [] }), 'review-b': (c) => ({ findings: c.round === 1 ? [F()] : [] }) }
  const r = await run({
    ...shrink,
    test: (c) => c.round === 1
      ? { exitCode: 0, outputTail: '# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n' }
      : { exitCode: 0, outputTail: '# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n' },
  }, { units: ['slugify'] })
  assert.equal(unitReport(r, 'slugify').status, 'blocked')
  assert.ok(r.logs.some((l) => /test count dropped from 5 to 4/.test(l)))
})

test('tests removed before the first test run are caught: the starting code seeds the test count', async () => {
  const start = (unit) => ({ unit, exitCode: 1, outputTail: summary({ tests: 8, pass: 5, fail: 3 }) })
  const writer = (baseline) => () => ({ files: ['GUIDE.md'], note: 'w', snapshot: baselineList(['slugify', 'chunk']), alreadyExisted: false, baseline })
  // the implementer deleted tests: slugify now runs 5 tests where the starting code had 8
  const test5 = (c) => ({ exitCode: 0, outputTail: summary({ tests: c.unit === 'slugify' ? 5 : 8 }) })
  const units = ['slugify', 'chunk']

  const seeded = await run({ 'prep-guide': writer([start('slugify'), start('chunk'), { unit: 'ghost', exitCode: 1, outputTail: summary({ tests: 99 }) }]), test: test5 }, { units })
  assert.equal(seeded.error, null)
  assert.equal(unitReport(seeded, 'slugify').status, 'blocked')
  assert.ok(seeded.logs.some((l) => /slugify r1: test count dropped from 8 to 5/.test(l)), 'caught in the very first test run')
  assert.deepEqual(unitReport(seeded, 'chunk'), { unit: 'chunk', status: 'pass', rounds: 1 })

  // control: with no starting counts nothing in code knows that tests were removed
  const unseeded = await run({ test: test5 }, { units })
  assert.equal(unitReport(unseeded, 'slugify').status, 'pass')

  // an unparsable or zero starting count seeds nothing, and a count that grew is fine
  const odd = await run({ 'prep-guide': writer([{ unit: 'slugify', exitCode: 1, outputTail: 'SyntaxError' }, { unit: 'chunk', exitCode: 1, outputTail: summary({ tests: 0, pass: 0 }) }]), test: test5 }, { units })
  assert.deepEqual(odd.result.units.map((u) => u.status), ['pass', 'pass'])
})

test('a dropped test count is a repair job: the fixer is told about the drop and how to restore the tests', async () => {
  const start = { unit: 'slugify', exitCode: 1, outputTail: summary({ tests: 8, pass: 5, fail: 3 }) }
  const writer = () => ({ files: ['GUIDE.md'], note: 'w', snapshot: baselineList(['slugify']), alreadyExisted: false, baseline: [start] })

  // the implementer deleted 3 tests and nothing fails: every run is green with 5 tests
  const never = await run({ 'prep-guide': writer, test: () => ({ exitCode: 0, outputTail: `# MARK-GREEN\n${summary({ tests: 5 })}` }) }, { units: ['slugify'] })
  assert.deepEqual(unitReport(never, 'slugify'), { unit: 'slugify', status: 'blocked', rounds: 3 })
  const fixes = callsOf(never, 'fix', 'slugify')
  assert.deepEqual(fixes.map((c) => parseLabel(c.label).round), [2, 3], 'a fixer is asked to repair it in every later round')
  for (const f of fixes) {
    assert.match(f.prompt, /test count dropped from 8 to 5/)
    assert.ok(f.prompt.includes('diff -u .wf/orig/test/slugify.test.mjs test/slugify.test.mjs'))
    assert.ok(f.prompt.includes('cp .wf/orig/test/slugify.test.mjs test/slugify.test.mjs'))
    assert.match(f.prompt, /drop in the test count/, 'the fixer rules allow restoring a test for this')
    assert.doesNotMatch(f.prompt, /That run was clean/)
    assert.doesNotMatch(f.prompt, /Fix what it shows/)
  }

  // the fixer restores the tests in round 2: round 3 is the first one that can pass
  const restored = await run({
    'prep-guide': writer,
    test: (c) => ({ exitCode: 0, outputTail: summary({ tests: c.round === 1 ? 5 : 8 }) }),
  }, { units: ['slugify'] })
  assert.deepEqual(unitReport(restored, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 3 })
  assert.deepEqual(callsOf(restored, 'fix', 'slugify').map((c) => parseLabel(c.label).round), [2])
})

test('a wrong high test count reported once does not make every later honest run look shrunk', async () => {
  const start = { unit: 'slugify', exitCode: 1, outputTail: summary({ tests: 8, pass: 5, fail: 3 }) }
  const writer = () => ({ files: ['GUIDE.md'], note: 'w', snapshot: baselineList(['slugify']), alreadyExisted: false, baseline: [start] })
  const find = (c) => ({ findings: c.round === 1 ? [F()] : [] })
  // r1: the test agent says 12 (the starting code had 8); from r2 on it says 8
  const r = await run({ 'prep-guide': writer, 'review-a': find, 'review-b': find, test: (c) => ({ exitCode: 0, outputTail: summary({ tests: c.round === 1 ? 12 : 8 }) }) }, { units: ['slugify'] })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 2 })
  assert.ok(!r.logs.some((l) => /test count dropped/.test(l)))

  // without a starting count the first run is the reference; a later higher number does not raise it
  const noBase = (c) => ({ findings: c.round <= 2 ? [F({ line: c.round, category: `cat-${c.round}` })] : [] })
  const counts = { 1: 5, 2: 8, 3: 5 }
  const later = await run({ 'review-a': noBase, 'review-b': noBase, test: (c) => ({ exitCode: 0, outputTail: summary({ tests: counts[c.round] }) }) }, { units: ['slugify'] })
  assert.deepEqual(unitReport(later, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 3 })
})

test('the fixer is told what the last test run showed: a clean run is nothing to repair, a failing one is', async () => {
  const find = (c) => ({ findings: c.round <= 2 ? [F({ line: c.round, category: `cat-${c.round}` })] : [] })
  const clean = await run({ 'review-a': find, 'review-b': find, test: () => ({ exitCode: 0, outputTail: `# MARK-GREEN\n${PASS}` }) }, { units: ['slugify'] })
  assert.match(callsOf(clean, 'fix', 'slugify', 1)[0].prompt, /No test run yet/)
  const second = callsOf(clean, 'fix', 'slugify', 2)[0].prompt
  assert.match(second, /That run was clean, so there is nothing to repair in it/)
  assert.doesNotMatch(second, /Fix what it shows/)
  assert.ok(!second.includes('MARK-GREEN'), 'no green output to "fix"')

  const failing = await run({ 'review-a': find, 'review-b': find, test: () => ({ exitCode: 1, outputTail: `# MARK-RED\n${FAIL}` }) }, { units: ['slugify'] })
  const p = callsOf(failing, 'fix', 'slugify', 2)[0].prompt
  assert.match(p, /Fix what it shows/)
  assert.ok(p.includes('MARK-RED'))
  assert.doesNotMatch(p, /That run was clean/)
})

// ---------- rules ----------
test('same category on two distinct approved bugs: a guide agent adds one rule, not more', async () => {
  // three spellings of one category: only normalisation lets them add up to a repeat
  const spelling = { slugify: 'off-by-one', chunk: ' Off-By-One ', duration: 'OFF-BY-ONE\n' }
  const find = (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs`, line: 3, category: spelling[c.unit] })] : [] })
  const r = await run({ 'review-a': find, 'review-b': find })
  const rules = ruleCalls(r)
  assert.equal(rules.length, 1, 'three bugs, one rule')
  assert.equal(rules[0].phase, 'Fix')
  assert.ok(rules[0].prompt.includes('off-by-one'))
  assert.equal(r.result.rulesAdded.length, 1)
  assert.equal(r.result.rulesAdded[0].category, 'off-by-one')
  assert.equal(r.result.rulesAdded[0].rule, 'RULE-TEXT')
  assert.equal(r.result.rulesAdded[0].unit, parseLabel(rules[0].label).unit)
  assert.equal(r.result.bugsCaught, 3)
  assert.ok(r.logs.some((l) => /rule added for category "off-by-one"/.test(l)))
})

test('the same bug approved again is one bug, but its category came back: that earns one rule', async () => {
  // the first fix failed, so both reviewers report the same finding in rounds 1 and 2 ("same bug twice -> rule")
  const find = (c) => ({ findings: c.round <= 2 ? [F({ line: 3, category: 'off-by-one' })] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.deepEqual(ruleCalls(r).map((c) => c.label), ['guide:slugify#r2'])
  assert.equal(r.result.bugsCaught, 1, 'still one bug')
  assert.equal(r.result.rulesAdded.length, 1)
  assert.equal(r.result.rulesAdded[0].category, 'off-by-one')
  assert.equal(r.result.rulesAdded[0].round, 2)
  assert.equal([...ruleCalls(r)[0].prompt.matchAll(/"round":/g)].length, 2, 'the rule agent is told both occurrences')
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 3 })
})

test('a bug that keeps coming back adds one rule, not one per round; one occurrence adds none', async () => {
  const again = (c) => ({ findings: [F({ line: 3, category: 'recurring' })] })
  const r = await run({ 'review-a': again, 'review-b': again }, { units: ['slugify'] })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'blocked', rounds: 3 })
  assert.deepEqual(ruleCalls(r).map((c) => c.label), ['guide:slugify#r2'])
  assert.equal(r.result.rulesAdded.length, 1)
  assert.equal(r.result.bugsCaught, 1)

  const once = (c) => ({ findings: c.round === 1 ? [F({ line: 3, category: 'recurring' })] : [] })
  const single = await run({ 'review-a': once, 'review-b': once }, { units: ['slugify'] })
  assert.equal(ruleCalls(single).length, 0)
  assert.deepEqual(single.result.rulesAdded, [])
})

test('a second distinct bug of the same category in a later round adds a rule from that round', async () => {
  const find = (c) => ({ findings: c.round <= 2 ? [F({ line: c.round === 1 ? 3 : 9, category: 'missing-validation' })] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.deepEqual(ruleCalls(r).map((c) => c.label), ['guide:slugify#r2'])
  assert.equal(r.result.rulesAdded[0].round, 2)
})

test('two categories due in one round get one guide agent with one label and one rule each', async () => {
  const mk = (line, category) => F({ line, category, input: `f(${line})`, description: `D-${category}-${line}` })
  const find = (c) => ({ findings: c.round === 1 ? [mk(1, 'cat-a'), mk(2, 'cat-a'), mk(3, 'cat-b'), mk(4, 'cat-b')] : [] })
  const rules = [{ category: 'cat-a', rule: 'RULE-A' }, { category: ' CAT-B ', rule: 'RULE-B' }]
  const r = await run({ 'review-a': find, 'review-b': find, rule: () => ({ files: ['GUIDE.md'], note: 'NOTE-BOTH', rules }) }, { units: ['slugify'] })
  assert.deepEqual(ruleCalls(r).map((c) => c.label), ['guide:slugify#r1'])
  assert.ok(ruleCalls(r)[0].prompt.includes('cat-a') && ruleCalls(r)[0].prompt.includes('cat-b'))
  assert.deepEqual(r.result.rulesAdded, [
    { category: 'cat-a', unit: 'slugify', round: 1, rule: 'RULE-A' },
    { category: 'cat-b', unit: 'slugify', round: 1, rule: 'RULE-B' },
  ])
  const labels = r.calls.map((c) => c.label)
  assert.equal(new Set(labels).size, labels.length, 'every label is unique')
  assert.equal(r.result.bugsCaught, 4)

  // an agent that reports no per-category rules leaves the rule text missing: the note is not split or invented
  const bare = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })   // default stub: note only
  assert.deepEqual(bare.result.rulesAdded.map((x) => [x.category, x.rule]), [['cat-a', null], ['cat-b', null]])
  const partial = await run({ 'review-a': find, 'review-b': find, rule: () => ({ files: [], note: 'n', rules: [{ category: 'cat-b', rule: 'ONLY-B' }, { category: 'cat-a' }] }) }, { units: ['slugify'] })
  assert.deepEqual(partial.result.rulesAdded.map((x) => [x.category, x.rule]), [['cat-a', null], ['cat-b', 'ONLY-B']])

  // a dead guide agent: neither category got a rule, both can earn one later
  let calls = 0
  const later = (c) => ({ findings: c.round <= 2 ? [mk(10 * c.round + 1, 'cat-a'), mk(10 * c.round + 2, 'cat-a'), mk(10 * c.round + 3, 'cat-b'), mk(10 * c.round + 4, 'cat-b')] : [] })
  const dead = await run({ 'review-a': later, 'review-b': later, rule: () => (++calls === 1 ? null : { files: [], note: 'n', rules }) }, { units: ['slugify'] })
  assert.deepEqual(ruleCalls(dead).map((c) => c.label), ['guide:slugify#r1', 'guide:slugify#r2'])
  assert.deepEqual(dead.result.rulesAdded.map((x) => [x.category, x.round]), [['cat-a', 2], ['cat-b', 2]])
})

test('findings without a category never earn a rule', async () => {
  const find = (c) => ({ findings: c.round === 1 ? [F({ line: 3, category: '' }), F({ line: 4, category: '  ' })] : [] })
  const r = await run({ 'review-a': find, 'review-b': find }, { units: ['slugify'] })
  assert.equal(ruleCalls(r).length, 0)
  assert.equal(r.result.bugsCaught, 2)
})

test('a dead guide agent adds no rule and the category can earn one later', async () => {
  const find = (c) => ({ findings: c.round <= 2 ? [F({ line: 3 + c.round, category: 'cat' }), F({ line: 20 + c.round, category: 'cat' })] : [] })
  let calls = 0
  const r = await run({ 'review-a': find, 'review-b': find, rule: () => (++calls === 1 ? null : { files: ['GUIDE.md'], note: 'SECOND-TRY' }) }, { units: ['slugify'] })
  assert.equal(ruleCalls(r).length, 2, 'retried in the next round')
  assert.deepEqual(r.result.rulesAdded.map((x) => [x.round, x.rule]), [[2, 'SECOND-TRY']])
})

test('guide edits are serialized: two rule agents never run at the same time', async () => {
  const cat = { a1: 'c1', b1: 'c1', a2: 'c2', b2: 'c2' }
  const find = (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs`, category: cat[c.unit] })] : [] })
  let active = 0, maxActive = 0
  const r = await run({
    'review-a': find, 'review-b': find,
    rule: async () => {
      active++; maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active--
      return { files: ['GUIDE.md'], note: 'rule' }
    },
  }, { units: ['a1', 'b1', 'a2', 'b2'] })
  assert.equal(r.error, null)
  assert.equal(r.result.rulesAdded.length, 2)
  assert.equal(maxActive, 1)
})

// ---------- degraded agents ----------
test('a dead reviewer sends the round to the judge', async () => {
  const X = F({ description: 'DESC-X' })
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    'review-b': (c) => (c.round === 1 ? null : { findings: [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [], missed: [] } : ACCEPT,
  }, { units: ['slugify'] })
  const judge = callsOf(r, 'judge', 'slugify', 1)[0]
  assert.match(judge.prompt, /reviewer b returned no result/)
  assert.ok(callsOf(r, 'fix', 'slugify', 1)[0].prompt.includes('DESC-X'))
  assert.equal(unitReport(r, 'slugify').status, 'pass')
})

test('a dead judge: all valid findings go to the fixer, and an empty round is not accepted', async () => {
  const X = F({ description: 'DESC-X' })
  const disagree = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [X] : [] }),
    judge: (c) => (c.round === 1 ? null : ACCEPT),
  }, { units: ['slugify'] })
  assert.ok(callsOf(disagree, 'fix', 'slugify', 1)[0].prompt.includes('DESC-X'))
  assert.ok(disagree.logs.some((l) => /judge returned no result/.test(l)))

  const empty = await run({ judge: (c) => (c.round === 1 ? null : ACCEPT) }, { units: ['slugify'] })
  assert.deepEqual(unitReport(empty, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 2 }, 'round 1 was not accepted without a judge')
})

test('a judge that says fix but approves nothing does not accept the round', async () => {
  const r = await run({ judge: (c) => (c.round === 1 ? { verdict: 'fix', approved: [], dropped: [], missed: [] } : ACCEPT) }, { units: ['slugify'] })
  assert.deepEqual(unitReport(r, 'slugify'), { unit: 'slugify', status: 'pass', rounds: 2 })
})

test('a dead implementer makes that unit error; the others continue', async () => {
  const r = await run({ implement: (c) => (c.unit === 'chunk' ? null : { files: ['x'], note: 'ok' }) })
  assert.equal(r.error, null)
  assert.deepEqual(unitReport(r, 'chunk'), { unit: 'chunk', status: 'error', rounds: null })
  assert.equal(unitReport(r, 'slugify').status, 'pass')
  assert.equal(unitReport(r, 'duration').status, 'pass')
  assert.equal(callsOf(r, 'review-a', 'chunk').length, 0)
  assert.equal(r.result.tests.passed, null, 'a unit that was never tested leaves the total missing')
  assert.equal(r.result.tests.byUnit.find((u) => u.unit === 'chunk').passed, null)
})

// ---------- isolation, structure, labels ----------
test('reviewers are blind: no implementer notes, no test output, no other reviewer, no earlier round', async () => {
  const r = await run({
    implement: ({ unit }) => ({ files: [`src/${unit}.mjs`], note: 'IMPLEMENTER-NOTE' }),
    'review-a': (c) => ({ findings: c.round === 1 ? [F({ line: 3, description: 'A-ONLY-DESC' })] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [F({ line: 8, description: 'B-ONLY-DESC' })] : [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0, 1], dropped: [], missed: [] } : ACCEPT,
    test: () => ({ exitCode: 0, outputTail: `# TESTMARK\n${PASS}` }),
  }, { units: ['slugify'] })
  const reviewers = r.calls.filter((c) => /^review-[ab]:slugify#/.test(c.label))
  assert.equal(reviewers.length, 4)
  for (const c of reviewers) {
    assert.ok(c.prompt.includes('GUIDE.md'))
    assert.ok(c.prompt.includes('diff -u .wf/orig/src/slugify.mjs src/slugify.mjs'))
    for (const secret of ['IMPLEMENTER-NOTE', 'TESTMARK', 'A-ONLY-DESC', 'B-ONLY-DESC']) assert.ok(!c.prompt.includes(secret), `${c.label} leaks ${secret}`)
    assert.equal(c.phase, 'Review')
  }
  const judge = callsOf(r, 'judge', 'slugify', 1)[0]
  assert.ok(judge.prompt.includes('A-ONLY-DESC') && judge.prompt.includes('B-ONLY-DESC'), 'the judge sees both reviews')
  assert.ok(!judge.prompt.includes('IMPLEMENTER-NOTE') && !judge.prompt.includes('TESTMARK'))
})

test('structured outputs: schemas for reviewers, judge, test agent', async () => {
  const r = await run({
    'review-a': (c) => ({ findings: c.round === 1 ? [F({ category: 'x' })] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [F({ category: 'y', line: 9 })] : [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0], dropped: [{ index: 1, reason: 'r' }], missed: [] } : ACCEPT,
  }, { units: ['slugify'] })
  for (const c of r.calls) {
    const s = c.opts.schema
    assert.equal(s.type, 'object', c.label)
    assert.ok(s.required.every((k) => k in s.properties), `${c.label}: required within properties`)
  }
  const review = callsOf(r, 'review-a', 'slugify', 1)[0].opts.schema
  assert.deepEqual(Object.keys(review.properties), ['findings'])
  assert.deepEqual(Object.keys(review.properties.findings.items.properties), ['file', 'line', 'input', 'description', 'severity', 'category'])
  assert.deepEqual(review.properties.findings.items.required, ['file', 'line', 'input', 'description', 'severity', 'category'])
  assert.deepEqual(callsOf(r, 'review-b', 'slugify', 1)[0].opts.schema, review)
  const judge = callsOf(r, 'judge', 'slugify', 1)[0].opts.schema
  assert.deepEqual(judge.required, ['verdict', 'approved', 'dropped', 'missed'])
  assert.deepEqual(judge.properties.dropped.items.required, ['index', 'reason'])
  assert.deepEqual(judge.properties.missed.items, review.properties.findings.items)
  const testSchema = callsOf(r, 'test', 'slugify', 1)[0].opts.schema
  assert.deepEqual(testSchema.required, ['exitCode', 'outputTail'])
})

test('labels are role:unit#rN, phases come from meta, every phase is used', async () => {
  const issue = { section: 'slugify', description: 'ISSUE', suggestion: 's' }
  const r = await run({
    'prep-review-a': () => ({ issues: [issue] }),
    'review-a': (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs`, line: 3, category: 'same' })] : [] }),
    'review-b': (c) => ({ findings: c.round === 1 ? [F({ file: `src/${c.unit}.mjs`, line: 9, category: 'same' })] : [] }),
    judge: (c) => c.round === 1 ? { verdict: 'fix', approved: [0, 1], dropped: [], missed: [] } : ACCEPT,
  }, { units: ['slugify', 'chunk'] })
  assert.equal(r.error, null)
  const titles = r.meta.phases.map((p) => p.title)
  const phaseOfRole = { implement: 'Implement', 'review-a': 'Review', 'review-b': 'Review', judge: 'Judge', fix: 'Fix', test: 'Test', guide: 'Fix' }
  const rolesSeen = new Set()
  for (const c of r.calls) {
    const p = parseLabel(c.label)
    assert.ok(p, `label ${c.label}`)
    assert.ok(p.round >= 1 && p.round <= 3, `round suffix on ${c.label}`)
    rolesSeen.add(p.role)
    assert.ok(titles.includes(c.phase), `${c.label} phase ${c.phase} is in meta`)
    assert.equal(c.phase, p.unit === 'prep' ? 'Prep' : phaseOfRole[p.role], c.label)
  }
  assert.equal(new Set(r.calls.map((c) => c.label)).size, r.calls.length, 'every label is unique')
  assert.deepEqual([...rolesSeen].sort(), [...ROLES].sort())
  assert.deepEqual([...new Set(r.calls.map((c) => c.phase))].sort(), [...titles].sort(), 'every meta phase has an agent')
  assert.ok(r.phases.every((t) => titles.includes(t)), 'phase() calls use meta titles')
  assert.equal(r.phases[0], 'Prep')
})

test('the report has the agreed shape', async () => {
  const r = await run({})
  assert.deepEqual(Object.keys(r.result).sort(), ['bugsCaught', 'droppedByCode', 'droppedByJudge', 'rulesAdded', 'tests', 'units'])
  for (const u of r.result.units) assert.deepEqual(Object.keys(u), ['unit', 'status', 'rounds'])
  assert.deepEqual(r.result.units.map((u) => u.unit), UNITS, 'report keeps the order of args.units')
  const t = r.result.tests
  for (const k of ['passed', 'failed', 'skipped', 'total']) assert.equal(typeof t[k], 'number', `tests.${k} is numeric (contract section 3)`)
  assert.deepEqual(t.byUnit.map((u) => u.unit), UNITS)
  assert.equal(JSON.parse(JSON.stringify(r.result)).units.length, 3, 'serialisable')
})

// ---------- fixture target-a ----------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-target-a-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const REFERENCE = {
  slugify: `export function slugify(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string')
  return input.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
`,
  chunk: `export function chunk(array, size) {
  if (!Array.isArray(array)) throw new TypeError('array expected')
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be an integer >= 1')
  const pieces = []
  for (let i = 0; i < array.length; i += size) pieces.push(array.slice(i, i + size))
  return pieces
}
`,
  duration: `const SECONDS = { d: 86400, h: 3600, m: 60, s: 1 }
const ORDER = ['d', 'h', 'm', 's']
const PART = /(\\d+)([dhms])/y
export function parseDuration(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string')
  let i = 0, last = -1, total = 0
  while (i < input.length) {
    if (i > 0 && input[i] === ' ') i++
    PART.lastIndex = i
    const m = PART.exec(input)
    if (!m) throw new RangeError('malformed duration')
    const rank = ORDER.indexOf(m[2])
    if (rank <= last) throw new RangeError('unit order')
    last = rank
    total += Number(m[1]) * SECONDS[m[2]]
    i = PART.lastIndex
  }
  if (last < 0) throw new RangeError('empty duration')
  return total
}
`,
}
const refDir = path.join(scratch, 'reference')
before(() => {
  fs.cpSync(TARGET, refDir, { recursive: true })
  for (const [u, code] of Object.entries(REFERENCE)) fs.writeFileSync(path.join(refDir, 'src', `${u}.mjs`), code)
})

// Runs `node --test` the way the test agent would (output piped, so the default reporter
// is whatever this Node version picks for a non-terminal), or with an explicit reporter.
function nodeTest(cwd, unit, reporter) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT   // else the child would think it runs inside this test run
  const args = ['--test', ...(reporter ? [`--test-reporter=${reporter}`] : []), `test/${unit}.test.mjs`]
  const res = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60_000 })
  const out = `${res.stdout}${res.stderr}`
  const n = (name) => { const m = [...out.matchAll(new RegExp(`^(?:#|\\u2139) ${name} (\\d+)$`, 'gm'))].at(-1); return m ? Number(m[1]) : null }
  return { status: res.status, out, pass: n('pass'), fail: n('fail'), skipped: n('skipped') }
}

test('fixture target-a: three units with TASK.md, tests, starting code and no package.json', () => {
  assert.ok(!fs.existsSync(path.join(TARGET, 'package.json')))
  const task = fs.readFileSync(path.join(TARGET, 'TASK.md'), 'utf8')
  for (const u of UNITS) {
    assert.ok(fs.existsSync(path.join(TARGET, 'src', `${u}.mjs`)), `src/${u}.mjs`)
    const src = fs.readFileSync(path.join(TARGET, 'test', `${u}.test.mjs`), 'utf8')
    assert.ok(/^## /m.test(task) && task.includes(`## ${u}`), `TASK.md has a section for ${u}`)
    assert.doesNotMatch(src, /\.(skip|todo|only)\b|\{\s*skip|\bxit\b/, `${u} tests are not skipped`)
  }
})

test('fixture target-a: starting code has work to do (some tests fail, some pass) in every unit', () => {
  for (const u of UNITS) {
    const res = nodeTest(TARGET, u, 'tap')
    assert.notEqual(res.status, 0, `${u} must fail at the start`)
    assert.ok(res.fail > 0, `${u}: failing tests`)
    assert.ok(res.pass > 0, `${u}: passing tests too`)
    assert.equal(res.skipped, 0)
  }
})

test('fixture target-a: the tests are satisfiable (a correct implementation passes all, none skipped)', () => {
  for (const u of UNITS) {
    const res = nodeTest(refDir, u, 'tap')
    assert.equal(res.status, 0, `${u}\n${res.out}`)
    assert.equal(res.fail, 0)
    assert.equal(res.skipped, 0)
    assert.ok(res.pass >= 8, `${u}: ${res.pass} tests`)
  }
})

test('fixture target-a: duration tests catch an implementation that accepts any whitespace between parts', () => {
  // TASK.md rule 4: one single space or nothing, no other whitespace. /\s/ instead of ' ' returns 5400 for "1h\t30m".
  const mutantDir = path.join(scratch, 'mutant')
  fs.cpSync(refDir, mutantDir, { recursive: true })
  const mutant = REFERENCE.duration.replace("input[i] === ' '", '/\\s/.test(input[i])')
  assert.notEqual(mutant, REFERENCE.duration, 'the mutation applied')
  fs.writeFileSync(path.join(mutantDir, 'src', 'duration.mjs'), mutant)
  const res = nodeTest(mutantDir, 'duration', 'tap')
  assert.notEqual(res.status, 0, res.out)
  assert.ok(res.fail > 0)
  const src = fs.readFileSync(path.join(TARGET, 'test', 'duration.test.mjs'), 'utf8')
  for (const input of ['1h\\t30m', '1h\\n30m']) assert.ok(src.includes(`'${input}'`), `${input} is in the malformed list`)
})

test('fixture target-a: the tests catch implementations that break the spec rules they used to miss', () => {
  const mutate = (unit, from, to) => {
    const code = REFERENCE[unit].replace(from, to)
    assert.notEqual(code, REFERENCE[unit], `the mutation applied: ${from}`)
    return code
  }
  // No slugify mutant for rule 3 (NFD instead of NFKD): the visible tests no longer check it on purpose,
  // so that mutant passes them. The seeded-bug tests below pin that down.
  const mutants = [
    ['chunk: returns the input array itself when everything fits in one piece (rules 3 and 5)', 'chunk',
      mutate('chunk', '  const pieces = []', '  if (array.length > 0 && size >= array.length) return [array]\n  const pieces = []')],
    ['duration: accepts a plus sign (rule 5)', 'duration', mutate('duration', '/(\\d+)([dhms])/y', '/\\+?(\\d+)([dhms])/y')],
    ['duration: rejects leading zeros, which are digits (rule 2)', 'duration', mutate('duration', 'if (!m) throw', "if (!m || (m[1].length > 1 && m[1][0] === '0')) throw")],
    ['duration: accepts digits of any script (rule 2)', 'duration', mutate('duration', '/(\\d+)([dhms])/y', '/(\\p{Nd}+)([dhms])/yu')],
  ]
  for (const [name, unit, code] of mutants) {
    const dir = path.join(scratch, `mutant-${unit}-${mutants.findIndex((m) => m[0] === name)}`)
    fs.cpSync(refDir, dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', `${unit}.mjs`), code)
    const res = nodeTest(dir, unit, 'tap')
    assert.notEqual(res.status, 0, `${name} passes the tests`)
    assert.ok(res.fail > 0, name)
  }
})

// ---------- the seeded bug of target-a ----------
// Unit: slugify. Rule: TASK.md rule 3 of slugify, "decompose with Unicode NFKD and drop the combining marks".
// The visible slugify tests do not check it: accented letters decompose under NFD too, so an implementation
// with NFD passes them all. The starting code uses NFD on the very line the implementer has to change to
// collapse separators, so the line is in the reviewers' diff; the shortest fix of the failing tests keeps it.
// Only TASK.md carries the example that tells NFKD from NFD. A live run of A shows whether a reviewer finds it.
const loadSlugify = async (dir) => (await import(pathToFileURL(path.join(dir, 'src', 'slugify.mjs')).href)).slugify

// The example of rule 3 that needs NFKD: read from TASK.md, so a changed or dropped example fails the tests.
function slugifyRule3Example() {
  const task = fs.readFileSync(path.join(TARGET, 'TASK.md'), 'utf8')
  const section = task.split(/^## /m).find((s) => s.startsWith('slugify'))
  const rule = /^3\. [\s\S]*?(?=^4\. )/m.exec(section ?? '')?.[0]
  assert.ok(rule, 'TASK.md has rule 3 in the slugify section')
  assert.match(rule, /NFKD/)
  // Every `"input"` ... becomes `"result"` pair of the rule, both written as JSON strings.
  const pairs = [...rule.matchAll(/`("[^`]*")`[^`]*?\bbecomes\s+`("[^`]*")`/g)].map((m) => [JSON.parse(m[1]), JSON.parse(m[2])])
  const needNfkd = pairs.filter(([input]) => input.normalize('NFKD') !== input.normalize('NFD'))
  assert.equal(needNfkd.length, 1, `rule 3 holds exactly one example only NFKD handles (pairs: ${JSON.stringify(pairs)})`)
  return { input: needNfkd[0][0], expected: needNfkd[0][1] }
}

// The shortest change a reader of the failing visible tests makes to the starting file: a typeof guard
// (TypeError test), "+" on the separator regex (collapse tests), a trim (leading and trailing hyphen test).
function slugifyMinimalFix(start) {
  const guard = "if (typeof input !== 'string') throw new TypeError('input must be a string')\n  return input"
  const fixed = start.replace('return String(input)', guard).replace("[^a-z0-9]/g, '-')", "[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')")
  assert.ok(fixed.includes(guard), 'the guard was added')
  assert.ok(fixed.includes("[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')"), 'the separator regex and the trim were fixed')
  return fixed
}

test('seeded bug (slugify rule 3): the reference passes every visible test and is right on the TASK.md example', async () => {
  const { input, expected } = slugifyRule3Example()
  const res = nodeTest(refDir, 'slugify', 'tap')
  assert.equal(res.status, 0, res.out)
  assert.equal(res.fail, 0)
  assert.equal(res.skipped, 0)
  assert.ok(res.pass >= 8, `${res.pass} tests`)
  assert.equal((await loadSlugify(refDir))(input), expected)
})

test('seeded bug (slugify rule 3): the minimal fix of the failing tests passes all visible tests and is wrong on the TASK.md example', async () => {
  const { input, expected } = slugifyRule3Example()
  const startPath = path.join(TARGET, 'src', 'slugify.mjs')
  const start = fs.readFileSync(startPath, 'utf8')
  const fixed = slugifyMinimalFix(start)
  assert.ok(start.includes("normalize('NFD')") && fixed.includes("normalize('NFD')"), 'the starting code and its minimal fix both use NFD')
  assert.equal(fixed, REFERENCE.slugify.replace("'NFKD'", "'NFD'"), 'the minimal fix is the reference with the violation put back')
  const dir = path.join(scratch, 'seed-slugify-minimal-fix')
  fs.cpSync(TARGET, dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'slugify.mjs'), fixed)
  const ref = nodeTest(refDir, 'slugify', 'tap')
  const res = nodeTest(dir, 'slugify', 'tap')
  assert.equal(res.status, 0, res.out)
  assert.equal(res.fail, 0)
  assert.equal(res.skipped, 0)
  assert.ok(res.pass > 0)
  assert.equal(res.pass, ref.pass, 'the minimal fix passes as many visible tests as the reference')
  const got = (await loadSlugify(dir))(input)
  assert.notEqual(got, expected, 'wrong on the TASK.md example')
  // The violating line is a changed line of the diff the reviewers get (diff -u start fix).
  const diff = spawnSync('diff', ['-u', startPath, path.join(dir, 'src', 'slugify.mjs')], { encoding: 'utf8' })
  assert.equal(diff.status, 1, diff.stderr)
  assert.match(diff.stdout, /^[-+].*normalize\('NFD'\)/m)
})

test('seeded bug (slugify rule 3): the starting code is wrong on the TASK.md example and still fails visible tests', async () => {
  const { input, expected } = slugifyRule3Example()
  const res = nodeTest(TARGET, 'slugify', 'tap')
  assert.notEqual(res.status, 0, 'the starting code must fail at the start')
  assert.ok(res.fail > 0, 'failing tests')
  assert.ok(res.pass > 0, 'passing tests too')
  assert.match(res.out, /^ok \d+ - removes diacritics$/m, 'the mark removal of the starting code works')
  assert.notEqual((await loadSlugify(TARGET))(input), expected)
})

test('seeded bug (slugify rule 3): the target neither tests the rule nor hints at it', () => {
  const files = []
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p) } }
  walk(TARGET)
  assert.ok(files.length >= 7, `${files.length} files`)
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /hidden|seeded|not tested|untested|mutant/i, path.relative(TARGET, f))
  const visible = fs.readFileSync(path.join(TARGET, 'test', 'slugify.test.mjs'), 'utf8')
  assert.doesNotMatch(visible, /NFK?D/)
  assert.doesNotMatch(visible, /\\[ux][0-9a-f]/i, 'no escaped characters in the visible slugify tests')
  const compatibility = [...visible].filter((ch) => ch.normalize('NFKD') !== ch.normalize('NFD'))
  assert.deepEqual(compatibility, [], 'no character in the visible slugify tests needs NFKD')
})

// ---------- the shell commands of the baseline mechanism, run for real ----------
// Everything a reviewer or the judge learns about edits outside the unit comes from one shell command
// line in their prompt. The dry-run stubs never execute it, so it is run here on a real copy of the
// fixture, laid out the way the guide writer lays it out (.wf/orig with read-only copies).
function baselineCopy(units) {
  const dir = fs.mkdtempSync(path.join(scratch, 'baseline-'))
  fs.cpSync(TARGET, dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'GUIDE.md'), '# Guide\n\n## Rules added during the run\n')
  for (const rel of baselineList(units)) {
    const to = path.join(dir, '.wf', 'orig', rel)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(dir, rel), to)
    fs.chmodSync(to, 0o444)
  }
  return dir
}

// The output of the command the reviewers and the judge are given for `unit`, run in `dir`.
async function diffOutput(dir, units, unit) {
  const r = await run({}, { targetDir: dir, units })   // both reviewers empty: the judge is called too
  assert.equal(r.error, null)
  const commands = ['review-a', 'review-b', 'judge'].map((role) => /^ {2}(cd ".*)$/m.exec(callsOf(r, role, unit, 1)[0].prompt)?.[1])
  assert.ok(commands[0], 'the prompt carries the diff command')
  assert.deepEqual(commands, [commands[0], commands[0], commands[0]], 'reviewers and judge run the same command')
  const res = spawnSync('sh', ['-c', commands[0]], { encoding: 'utf8', timeout: 30_000 })
  return `${res.stdout}${res.stderr}`
}

test('the diff command: silent on an untouched tree, exact about every edit outside the unit', async () => {
  const units = UNITS
  const edit = (dir, rel, f) => fs.writeFileSync(path.join(dir, rel), f(fs.readFileSync(path.join(dir, rel), 'utf8')))
  const out = (dir) => diffOutput(dir, units, 'slugify')
  const headers = (text) => [...text.matchAll(/^--- (\S+)/gm)].map((m) => m[1])
  const fresh = () => baselineCopy(units)

  // Nothing touched: no output at all. The prompt says every later command prints nothing, so this must hold.
  assert.equal(await out(fresh()), '')

  // The unit's own source is the diff under review. Another unit's source is not diffed: it changes
  // legitimately while that unit is implemented.
  let dir = fresh()
  edit(dir, 'src/slugify.mjs', (t) => `${t}// edited\n`)
  edit(dir, 'src/chunk.mjs', (t) => `${t}// edited\n`)
  assert.deepEqual(headers(await out(dir)), ['.wf/orig/src/slugify.mjs'])

  // Each of these shows up, and only as itself.
  const cases = [
    ['a weakened test of the unit', (d) => edit(d, 'test/slugify.test.mjs', (t) => t.replace("'hello-world')", "'hello world')")), (o) => assert.deepEqual(headers(o), ['.wf/orig/test/slugify.test.mjs'])],
    ['a changed TASK.md', (d) => edit(d, 'TASK.md', (t) => t.replace('NFKD', 'NFD')), (o) => assert.deepEqual(headers(o), ['.wf/orig/TASK.md'])],
    ['a changed test of another unit', (d) => edit(d, 'test/chunk.test.mjs', (t) => `${t}\n// edited\n`), (o) => assert.deepEqual(headers(o), ['.wf/orig/test/chunk.test.mjs'])],
    ['a rule added to GUIDE.md', (d) => edit(d, 'GUIDE.md', (t) => `${t}\n- Validate every input.\n`), (o) => { assert.deepEqual(headers(o), ['.wf/orig/GUIDE.md']); assert.match(o, /^\+- Validate every input\.$/m) }],
    ['a file added next to the sources', (d) => fs.writeFileSync(path.join(d, 'src', 'extra.mjs'), 'export {}\n'), (o) => assert.equal(o, './src/extra.mjs\n')],
    ['a file added to the test directory', (d) => fs.writeFileSync(path.join(d, 'test', 'extra.test.mjs'), ''), (o) => assert.equal(o, './test/extra.test.mjs\n')],
    ['another unit\'s source deleted', (d) => fs.rmSync(path.join(d, 'src', 'chunk.mjs')), (o) => assert.equal(o, 'missing: ./src/chunk.mjs\n')],
    ['the unit\'s own test deleted', (d) => fs.rmSync(path.join(d, 'test', 'slugify.test.mjs')), (o) => assert.ok(o.includes('missing: ./test/slugify.test.mjs'), o)],
    ['a baseline file rewritten with the same content (it is writable again)', (d) => { const f = path.join(d, '.wf', 'orig', 'TASK.md'); fs.chmodSync(f, 0o644); fs.writeFileSync(f, fs.readFileSync(f)) }, (o) => assert.equal(o, '.wf/orig/TASK.md\n')],
    ['a file written into .wf', (d) => fs.writeFileSync(path.join(d, '.wf', 'stray.txt'), 'x'), (o) => assert.equal(o, '.wf/stray.txt\n')],
  ]
  for (const [name, change, check] of cases) {
    dir = fresh()
    change(dir)
    const o = await out(dir)
    try { check(o) } catch (e) { e.message = `${name}: ${e.message}\n--- output:\n${o}`; throw e }
  }
})

test('the diff note matches the command: only the GUIDE.md diff may show output on a clean tree, and nothing demands a sorted list', async () => {
  const r = await run({}, { units: ['slugify', 'chunk'] })
  for (const p of [callsOf(r, 'review-a', 'slugify', 1)[0].prompt, callsOf(r, 'judge', 'slugify', 1)[0].prompt]) {
    assert.match(p, /every command prints nothing when nothing outside the unit was touched, except the GUIDE\.md diff/)
    assert.doesNotMatch(p, /must be exactly|output of every later command must be empty/)
    assert.match(p, /"missing:" line/)
  }
})

// What the test agent is told to return: the last 3000 characters, with the summary lines in front
// when they are not inside that tail (the default reporter prints failure details after the summary).
function agentTail(out) {
  const tail = out.slice(-3000)
  if (/^(?:#|ℹ) pass \d+$/m.test(tail)) return tail
  const summary = out.split('\n').filter((l) => /^(?:#|ℹ) (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l))
  return `${summary.join('\n')}\n...\n${out.slice(-2500)}`
}

test('the workflow reads the real output of node --test (default and tap reporter) on this machine', async (t) => {
  for (const reporter of [undefined, 'tap']) {
    await t.test(`reporter ${reporter ?? 'default (piped)'}`, async () => {
      const good = nodeTest(refDir, 'chunk', reporter)
      const bad = nodeTest(TARGET, 'chunk', reporter)
      assert.ok(good.pass > 0 && bad.fail > 0, 'the node run itself produced a summary')
      const feed = (res, tail) => ({ test: () => ({ exitCode: res.status, outputTail: tail(res.out) }) })

      const passing = await run(feed(good, agentTail), { units: ['chunk'] })
      assert.deepEqual(unitReport(passing, 'chunk'), { unit: 'chunk', status: 'pass', rounds: 1 }, good.out)
      assert.equal(passing.result.tests.passed, good.pass)
      assert.equal(passing.result.tests.failed, 0)

      const failing = await run(feed(bad, agentTail), { units: ['chunk'] })
      assert.equal(unitReport(failing, 'chunk').status, 'blocked')
      assert.equal(failing.result.tests.passed, bad.pass)
      assert.equal(failing.result.tests.failed, bad.fail)

      // even a plain 3000-character tail that lost the summary can never produce a pass
      const lossy = await run(feed(bad, (out) => out.slice(-3000)), { units: ['chunk'] })
      assert.equal(unitReport(lossy, 'chunk').status, 'blocked')
    })
  }
})

test('the test agent is told to keep the summary block inside outputTail', async () => {
  const r = await run({}, { units: ['chunk'] })
  const prompt = callsOf(r, 'test', 'chunk', 1)[0].prompt
  assert.match(prompt, /summary block/)
  assert.match(prompt, /# pass/)
  assert.match(prompt, /failure details after that block/)
})
