// Tests for workflow B (workflows/research-fanout.js) via tools/dry-run-workflow.mjs.
// No model is called: respond() plays the agents, so only the script's own control flow is tested.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dryRun, extractMeta } from '../../tools/dry-run-workflow.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = path.join(ROOT, 'workflows', 'research-fanout.js')
const TARGET_B = path.join(ROOT, 'demo', 'targets', 'target-b')
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, 'utf8')
const { meta: META } = extractMeta(SCRIPT_TEXT)

// What the stub readers extract. a.md and c.md state the same claim with different case and punctuation.
const FRANKFURT_A = 'Data is stored in Frankfurt.'
const FRANKFURT_C = 'data is stored in FRANKFURT'
const PRICE_8 = 'The Team plan costs $8 per user per month.'
const PRICE_10 = 'The Team plan costs $10 per user per month.'
const READ = {
  'a.md': [{ text: PRICE_8, quote: 'Team plan costs $8' }, { text: FRANKFURT_A, quote: 'stored in Frankfurt' }],
  'b.md': [{ text: PRICE_10, quote: '$10 per user' }, { text: 'Support replies within one business day.', quote: 'one business day' }],
  'c.md': [{ text: FRANKFURT_C, quote: 'Frankfurt region' }, { text: 'Up to 5 devices per user.', quote: 'Up to 5 devices' }],
}
const FILES = Object.keys(READ)

const SYNTH_SUMMARY = 'SUMMARY-FROM-THE-SYNTHESIS-AGENT: price and device limits differ between notes'
const SYNTH_OUT = { summary: SYNTH_SUMMARY, contradictions: [{ a: PRICE_8, b: PRICE_10 }] }
const GAPS_OUT = { gaps: ['nothing on refunds', 'device limit stated in only one note'] }

// Default stub agents. Options: supported(file, claim) -> bool, omit(file, claim) -> bool (checker skips the claim),
// synth / gaps override the synthesis and critic answers (undefined keeps the default).
function responder({ read = READ, supported = () => true, omit = () => false, synth = SYNTH_OUT, gaps = GAPS_OUT } = {}) {
  return (call) => {
    const sep = call.label.indexOf(':')
    const role = call.label.slice(0, sep), file = call.label.slice(sep + 1)
    if (role === 'read') return { claims: read[file] }
    if (role === 'check') {
      return { checked: read[file].filter((c) => !omit(file, c)).map((c) => ({ text: c.text, supported: supported(file, c), note: `note: ${c.text}` })) }
    }
    if (role === 'synthesize') return synth
    if (role === 'critic') return gaps
    throw new Error(`unexpected label ${call.label}`)
  }
}

const run = ({ args = {}, respond = responder() } = {}) =>
  dryRun(SCRIPT, { args: { targetDir: '/t', files: FILES, model: 'haiku', ...args }, respond })

// The one-line JSON array that follows "Claims (JSON): " in a prompt.
const claimsIn = (prompt) => {
  const line = prompt.split('\n').find((l) => l.startsWith('Claims (JSON): '))
  assert.ok(line, 'prompt has a "Claims (JSON): " line')
  return JSON.parse(line.slice('Claims (JSON): '.length))
}
// The one-line JSON array that follows "Dropped claims (JSON): " in the critic prompt.
const droppedIn = (prompt) => {
  const line = prompt.split('\n').find((l) => l.startsWith('Dropped claims (JSON): '))
  assert.ok(line, 'prompt has a "Dropped claims (JSON): " line')
  return JSON.parse(line.slice('Dropped claims (JSON): '.length))
}
const callOf = (r, label) => r.calls.find((c) => c.label === label)
const labelsOf = (r) => r.calls.map((c) => c.label)

// ---------------------------------------------------------------- script shape

test('meta is a pure literal and the script starts with it', () => {
  assert.ok(SCRIPT_TEXT.startsWith('export const meta = {'), 'meta is the first statement')
  assert.equal(META.name, 'wfviz-research-fanout')
  assert.equal(typeof META.description, 'string')
  assert.deepEqual(META.phases.map((p) => p.title), ['Read', 'Check', 'Synthesize'])
  const { start, end } = extractMeta(SCRIPT_TEXT)
  const literal = SCRIPT_TEXT.slice(SCRIPT_TEXT.indexOf('{', start), end)
  const noStrings = literal.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""')
  assert.ok(!/[`()]|\.\.\.|=>/.test(noStrings), 'no template, call, spread or arrow in meta')
  assert.ok(!/[A-Za-z_]/.test(noStrings.replace(/\b[A-Za-z_]\w*(?=\s*:)/g, '')), 'only literal keys, strings and punctuation')
})

test('script avoids the APIs the workflow runtime rejects', () => {
  assert.ok(!/Date\.now|Math\.random|new Date\(\s*\)/.test(SCRIPT_TEXT))
  assert.ok(!/\brequire\(|\bimport\(|node:fs|process\./.test(SCRIPT_TEXT))
})

// ---------------------------------------------------------------- fixtures

test('demo/targets/target-b: 5 short notes whose planted contradictions are really there', () => {
  const files = fs.readdirSync(TARGET_B).filter((f) => f.endsWith('.md')).sort()
  assert.equal(files.length, 5)
  const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(TARGET_B, f), 'utf8')]))
  for (const [f, t] of Object.entries(text)) {
    assert.ok(t.trim().length > 100, `${f} is not empty`)
    assert.ok(t.split('\n').length <= 20 && t.length <= 1500, `${f} is short`)
  }
  const planted = [
    ['price', [['01-overview.md', /\$8 per user per month/], ['02-pricing.md', /\$10 per user per month/]]],
    ['devices', [['01-overview.md', /no limit on the number of devices/i], ['05-support-faq.md', /up to 5 devices/i]]],
    ['end-to-end encryption', [['01-overview.md', /encrypted end to end on every plan/i], ['03-security.md', /end-to-end encryption is available on the enterprise plan only/i], ['04-roadmap.md', /version 3\.0.*adds end-to-end encryption/i]]],
    ['version history', [['01-overview.md', /for 30 days/], ['05-support-faq.md', /90 days on the team plan/i]]],
    ['first release', [['01-overview.md', /first shipped in March 2024/], ['04-roadmap.md', /1\.0 shipped in January 2025/]]],
  ]
  for (const [topic, sides] of planted) for (const [f, re] of sides) assert.match(text[f], re, `${topic}: ${f}`)
})

test('runs on the real fixture file names', async () => {
  const names = fs.readdirSync(TARGET_B).filter((f) => f.endsWith('.md')).sort()
  const read = Object.fromEntries(names.map((n) => [n, [{ text: `claim from ${n}`, quote: n }]]))
  const r = await run({ args: { targetDir: TARGET_B, files: names }, respond: responder({ read }) })
  assert.equal(r.error, null)
  assert.equal(r.calls.length, 5 * 2 + 2)
  assert.ok(callOf(r, 'read:01-overview.md').prompt.includes(`${TARGET_B}/01-overview.md`))
  assert.equal(r.result.counts.unique, 5)
})

// ---------------------------------------------------------------- happy path

test('happy path: read + check per file, one synthesis, one critic, report assembled', async () => {
  const r = await run()
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r).filter((l) => l.startsWith('read:')).sort(), FILES.map((f) => `read:${f}`))
  assert.deepEqual(labelsOf(r).filter((l) => l.startsWith('check:')).sort(), FILES.map((f) => `check:${f}`))
  assert.equal(r.calls.length, FILES.length * 2 + 2)
  assert.deepEqual(r.result.failed, [])
  assert.equal(r.result.summary, SYNTH_SUMMARY)
  assert.deepEqual(r.result.contradictions, SYNTH_OUT.contradictions)
  assert.equal(r.result.unmatchedContradictions, 0)
  assert.deepEqual(r.result.unmatchedPairs, [])
  assert.deepEqual(r.result.gaps, GAPS_OUT.gaps)
  assert.deepEqual(r.result.files.map((f) => [f.file, f.status, f.claims, f.supported]), FILES.map((f) => [f, 'ok', 2, 2]))
  assert.deepEqual(r.result.counts, { files: 3, failed: 0, claimsRead: 6, supported: 6, unsupported: 0, unchecked: 0, unique: 5, forSynthesis: 5 })
  assert.ok(r.logs.some((l) => /^read:a\.md: 2 claims$/.test(l)))
  assert.ok(r.logs.some((l) => /^check:a\.md: 2 supported, 0 unsupported, 0 unchecked$/.test(l)))
  assert.ok(r.logs.some((l) => /^critic: 2 gaps$/.test(l)))
})

test('no loop, no judge, no fixer: exactly one read and one check per file, even for unsupported claims', async () => {
  const r = await run({ respond: responder({ supported: () => false }) })
  const labels = labelsOf(r)
  assert.equal(labels.filter((l) => l.startsWith('read:')).length, 3)
  assert.equal(labels.filter((l) => l.startsWith('check:')).length, 3)
  assert.ok(labels.every((l) => !/#r\d|^(judge|fix|review|test|guide)/.test(l)), labels.join(','))
  assert.equal(new Set(labels).size, labels.length, 'no label repeats')
  assert.ok(!/\bwhile\s*\(/.test(SCRIPT_TEXT), 'no while loop in the script')
})

// ---------------------------------------------------------------- pipeline: stage order, no barrier

test('stage order per item: read -> check, and the check prompt carries that file\'s claims only', async () => {
  const ev = []
  const base = responder()
  const r = await run({
    respond: async (call) => {
      ev.push(`start ${call.label}`)
      await Promise.resolve()
      const out = base(call)
      ev.push(`end ${call.label}`)
      return out
    },
  })
  assert.equal(r.error, null)
  for (const f of FILES) {
    const [rs, re, cs, ce] = [`start read:${f}`, `end read:${f}`, `start check:${f}`, `end check:${f}`].map((e) => ev.indexOf(e))
    assert.ok(rs >= 0 && rs < re && re < cs && cs < ce, `${f}: ${ev.join(' | ')}`)
    const claims = claimsIn(callOf(r, `check:${f}`).prompt)
    assert.deepEqual(claims.map((c) => c.text), READ[f].map((c) => c.text), `check:${f} sees the claims read:${f} returned`)
    assert.deepEqual(claims.map((c) => c.quote), READ[f].map((c) => c.quote))
    assert.ok(callOf(r, `read:${f}`).prompt.includes(`/t/${f}`) && callOf(r, `check:${f}`).prompt.includes(`/t/${f}`))
  }
  const synth = ev.indexOf('start synthesize:all')
  assert.ok(FILES.every((f) => ev.indexOf(`end check:${f}`) < synth), 'barrier: synthesis starts after every check')
  assert.ok(ev.indexOf('end synthesize:all') < ev.indexOf('start critic:all'), 'critic after synthesis')
})

test('no barrier between read and check: a fast file is checked while a slow file is still being read', async () => {
  const ev = []
  let release
  const gate = new Promise((res) => { release = res })
  const timer = setTimeout(release, 1500) // safety net: with a barrier the slow read would only end by this timer
  const base = responder()
  try {
    const r = await run({
      respond: async (call) => {
        ev.push(`start ${call.label}`)
        if (call.label === 'read:b.md') await gate        // slow reader
        if (call.label === 'check:a.md' || call.label === 'check:c.md') release() // fast files got through to stage 2
        const out = base(call)
        ev.push(`end ${call.label}`)
        return out
      },
    })
    assert.equal(r.error, null)
    const at = (e) => ev.indexOf(e)
    assert.ok(at('start check:a.md') < at('end read:b.md'), ev.join(' | '))
    assert.ok(at('start check:c.md') < at('end read:b.md'), ev.join(' | '))
    assert.ok(at('start check:b.md') > at('end read:b.md'), 'the slow file still goes read -> check in order')
  } finally { clearTimeout(timer) }
})

// ---------------------------------------------------------------- failing items

test('a reader that throws drops only its file: others intact, failure logged, claims absent downstream', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label === 'read:b.md') throw new Error('boom in read'); return base(call) } })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('pipeline[1] failed: boom in read'), r.logs.join('\n'))
  assert.ok(r.logs.some((l) => l.startsWith('barrier: 2 of 3 files finished; failed: b.md')))
  assert.ok(!labelsOf(r).includes('check:b.md'), 'no check for the failed file')
  assert.ok(labelsOf(r).includes('check:a.md') && labelsOf(r).includes('check:c.md'))
  assert.deepEqual(r.result.failed, ['b.md'])
  assert.deepEqual(r.result.files.map((f) => [f.file, f.status]), [['a.md', 'ok'], ['b.md', 'failed'], ['c.md', 'ok']])
  const texts = claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text)
  assert.ok(!texts.includes(PRICE_10) && !texts.includes('Support replies within one business day.'), 'b.md claims never reach synthesis')
  assert.ok(texts.includes(PRICE_8))
  assert.ok(callOf(r, 'critic:all').prompt.includes('["b.md"]'), 'critic is told which file failed')
  assert.ok(r.result.summary && r.result.gaps)
})

test('a checker that throws drops only its file; its read happened, its claims do not reach synthesis', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label === 'check:c.md') throw new Error('boom in check'); return base(call) } })
  assert.equal(r.error, null)
  assert.ok(labelsOf(r).includes('read:c.md'))
  assert.ok(r.logs.includes('pipeline[2] failed: boom in check'), r.logs.join('\n'))
  assert.deepEqual(r.result.failed, ['c.md'])
  const texts = claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text)
  assert.ok(!texts.includes('Up to 5 devices per user.'))
  assert.equal(r.result.counts.claimsRead, 4)
  assert.ok(texts.includes(FRANKFURT_A) && texts.includes(PRICE_10))
})

test('an agent skipped by the user (null result) counts as a failure, not as an empty file', async () => {
  const base = responder()
  const r = await run({ respond: (call) => (call.label === 'read:a.md' ? null : base(call)) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('pipeline[0] failed: read:a.md returned no claims list'), r.logs.join('\n'))
  assert.deepEqual(r.result.failed, ['a.md'])
  const r2 = await run({ respond: (call) => (call.label === 'check:a.md' ? null : base(call)) })
  assert.ok(r2.logs.includes('pipeline[0] failed: check:a.md returned no checked list'), r2.logs.join('\n'))
  assert.deepEqual(r2.result.failed, ['a.md'])
})

test('a file with no claims is not checked and is not a failure', async () => {
  const read = { ...READ, 'b.md': [] }
  const r = await run({ respond: responder({ read }) })
  assert.equal(r.error, null)
  assert.ok(!labelsOf(r).includes('check:b.md'))
  assert.ok(r.logs.includes('check:b.md: skipped, no claims to check'))
  assert.deepEqual(r.result.failed, [])
  assert.deepEqual(r.result.files.find((f) => f.file === 'b.md'), { file: 'b.md', status: 'no-claims', claims: 0, supported: 0, unsupported: 0, unchecked: 0 })
  assert.equal(r.calls.length, 3 + 2 + 2)
})

test('every file failing: no synthesis, no critic, nothing invented', async () => {
  const r = await run({ respond: () => { throw new Error('down') } })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r), ['read:a.md', 'read:b.md', 'read:c.md'])
  assert.deepEqual(r.result.failed, FILES)
  assert.equal(r.result.summary, null)
  assert.equal(r.result.contradictions, null)
  assert.equal(r.result.gaps, null)
  assert.ok(r.logs.includes('synthesize: skipped, no supported claims'))
  assert.ok(r.logs.includes('critic: skipped, no claims were read'))
})

// ---------------------------------------------------------------- dedupe in code

test('dedupe happens in code: the same claim from two files reaches synthesis once, with both files', async () => {
  const r = await run()
  assert.ok(labelsOf(r).every((l) => /^(read|check|synthesize|critic):/.test(l)) && !labelsOf(r).some((l) => /dedup/i.test(l)), 'no agent does the dedupe')
  const claims = claimsIn(callOf(r, 'synthesize:all').prompt)
  assert.equal(claims.length, 5)
  const frankfurt = claims.filter((c) => /frankfurt/i.test(c.text))
  assert.equal(frankfurt.length, 1, 'one Frankfurt claim, not two')
  assert.equal(frankfurt[0].text, FRANKFURT_A, 'first occurrence wins')
  assert.deepEqual(frankfurt[0].files, ['a.md', 'c.md'])
  assert.deepEqual(claims.map((c) => c.id), [1, 2, 3, 4, 5])
  const kept = r.result.claims.find((c) => /frankfurt/i.test(c.text))
  assert.deepEqual(kept.files, ['a.md', 'c.md'])
  assert.deepEqual(kept.sources.map((s) => [s.file, s.quote]), [['a.md', 'stored in Frankfurt'], ['c.md', 'Frankfurt region']])
  assert.equal(r.result.counts.claimsRead, 6)
  assert.equal(r.result.counts.unique, 5)
  assert.ok(r.logs.includes('dedupe: 6 claims -> 5 unique; 5 supported go to synthesis; 0 dropped (unsupported or unchecked)'), r.logs.join('\n'))
})

test('dedupe is on normalised text only: case, punctuation and spacing differ, wording differences do not merge', async () => {
  const read = {
    'a.md': [{ text: 'Plan costs $8 / month!', quote: 'q' }, { text: 'Costs eight dollars', quote: 'q' }],
    'b.md': [{ text: '  PLAN costs   $8  month ', quote: 'q' }, { text: 'Plan costs 8 dollars', quote: 'q' }],
    'c.md': [{ text: '...', quote: 'q' }],
  }
  const r = await run({ respond: responder({ read }) })
  assert.equal(r.error, null)
  const texts = claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text)
  assert.deepEqual(texts, ['Plan costs $8 / month!', 'Costs eight dollars', 'Plan costs 8 dollars'])
  assert.ok(!labelsOf(r).includes('check:c.md'), 'a claim with no letters or digits is not a claim')
})

test('unsupported and unchecked claims are dropped with a log line and counted; unchecked stays null, never guessed', async () => {
  const r = await run({ respond: responder({
    supported: (f, c) => !(f === 'b.md' && c.text === PRICE_10) && !(f === 'c.md' && c.text === FRANKFURT_C),
    omit: (f, c) => f === 'c.md' && c.text === 'Up to 5 devices per user.',
  }) })
  assert.equal(r.error, null)
  assert.deepEqual(r.result.counts, { files: 3, failed: 0, claimsRead: 6, supported: 3, unsupported: 2, unchecked: 1, unique: 5, forSynthesis: 3 })
  const claims = claimsIn(callOf(r, 'synthesize:all').prompt)
  assert.deepEqual(claims.map((c) => c.text), [PRICE_8, FRANKFURT_A, 'Support replies within one business day.'])
  assert.deepEqual(claims.find((c) => c.text === FRANKFURT_A).files, ['a.md'], 'listed only where a checker supported it')
  const c = r.result.files.find((f) => f.file === 'c.md')
  assert.deepEqual([c.supported, c.unsupported, c.unchecked], [0, 1, 1])
  assert.ok(r.logs.includes('check:c.md: 0 supported, 1 unsupported, 1 unchecked'), r.logs.join('\n'))
  assert.ok(r.logs.includes('dedupe: 6 claims -> 5 unique; 3 supported go to synthesis; 2 dropped (unsupported or unchecked)'), r.logs.join('\n'))
  // PRICE_10 (only b.md, rejected) and the devices claim (only c.md, unanswered) are dropped; Frankfurt is kept although c.md rejected it.
  const criticPrompt = callOf(r, 'critic:all').prompt
  assert.ok(criticPrompt.includes('dropped before synthesis because no checker supported them: 2 (unsupported: 1; claims the checker did not answer: 1)'), criticPrompt)
  assert.deepEqual(droppedIn(criticPrompt), [
    { text: PRICE_10, unsupportedIn: ['b.md'], uncheckedIn: [] },
    { text: 'Up to 5 devices per user.', unsupportedIn: [], uncheckedIn: ['c.md'] },
  ])
  assert.ok(r.result.claims.every((k) => k.supportedFiles.length > 0), 'only claims supported somewhere are reported as claims')
  const frankfurt = r.result.claims.find((k) => k.text === FRANKFURT_A)
  assert.deepEqual(frankfurt.sources.map((s) => [s.file, s.supported]), [['a.md', true], ['c.md', false]], 'the dissenting checker verdict is kept, not erased')
})

test('check results that match no extracted claim are ignored and logged', async () => {
  const base = responder()
  const r = await run({ respond: (call) => {
    const out = base(call)
    if (call.label === 'check:a.md') out.checked.push({ text: 'A claim the reader never extracted', supported: true, note: 'invented' })
    return out
  } })
  assert.ok(r.logs.includes('check:a.md: 1 checked entries match no extracted claim and are ignored'), r.logs.join('\n'))
  assert.ok(!claimsIn(callOf(r, 'synthesize:all').prompt).some((c) => /never extracted/.test(c.text)))
  assert.equal(r.result.counts.claimsRead, 6)
})

// ---------------------------------------------------------------- synthesis and critic

test('critic runs after synthesis and receives its summary and contradictions (data flow)', async () => {
  const r = await run()
  const critic = callOf(r, 'critic:all')
  assert.ok(critic.n > callOf(r, 'synthesize:all').n)
  assert.ok(critic.prompt.includes(SYNTH_SUMMARY))
  assert.ok(critic.prompt.includes(JSON.stringify(SYNTH_OUT.contradictions)))
  assert.ok(critic.prompt.includes('["a.md","b.md","c.md"]'), 'critic sees the files read')
  assert.deepEqual(claimsIn(critic.prompt), claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text))
})

test('contradictions that cite text outside the claim list are counted as unmatched, not silently trusted', async () => {
  const synth = { summary: 's', contradictions: [{ a: PRICE_8, b: PRICE_10 }, { a: PRICE_8, b: 'Tessera is free forever.' }] }
  const r = await run({ respond: responder({ synth }) })
  assert.deepEqual(r.result.contradictions, synth.contradictions, 'model output is passed through unchanged')
  assert.equal(r.result.unmatchedContradictions, 1)
  assert.deepEqual(r.result.unmatchedPairs, [{ index: 1, a: PRICE_8, b: 'Tessera is free forever.', reason: 'not-in-claim-list' }], 'the failed pair is identified, not only counted')
  assert.ok(r.logs.includes('synthesize: 2 contradictions, 1 cite text that is not in the claim list'), r.logs.join('\n'))
})

test('a contradiction that pairs a claim with itself is unmatched, whatever its spelling', async () => {
  const synth = { summary: 's', contradictions: [
    { a: PRICE_8, b: PRICE_8 }, { a: PRICE_8, b: PRICE_8.toUpperCase() }, { a: PRICE_8, b: PRICE_10 }, null, { a: 5, b: PRICE_8 },
  ] }
  const r = await run({ respond: responder({ synth }) })
  assert.equal(r.error, null)
  assert.deepEqual(r.result.contradictions, synth.contradictions, 'model output is passed through unchanged')
  assert.equal(r.result.unmatchedContradictions, 4)
  assert.deepEqual(r.result.unmatchedPairs, [
    { index: 0, a: PRICE_8, b: PRICE_8, reason: 'same-claim' },
    { index: 1, a: PRICE_8, b: PRICE_8.toUpperCase(), reason: 'same-claim' },
    { index: 3, a: null, b: null, reason: 'not-in-claim-list' },
    { index: 4, a: null, b: PRICE_8, reason: 'not-in-claim-list' },
  ])
  assert.ok(r.logs.includes('synthesize: 5 contradictions, 2 cite text that is not in the claim list, 2 pair a claim with itself'), r.logs.join('\n'))
})

test('a synthesis agent that returns nothing leaves summary and contradictions missing; the critic is told', async () => {
  const r = await run({ respond: responder({ synth: null }) })
  assert.equal(r.error, null)
  assert.equal(r.result.summary, null)
  assert.equal(r.result.contradictions, null)
  assert.equal(r.result.unmatchedContradictions, null)
  assert.equal(r.result.unmatchedPairs, null)
  assert.ok(r.logs.includes('synthesize: no result from the synthesis agent'))
  assert.ok(callOf(r, 'critic:all').prompt.includes('NOT AVAILABLE, the synthesis agent returned nothing'))
  assert.deepEqual(r.result.gaps, GAPS_OUT.gaps)
})

test('an empty contradiction list is a result, not a missing one', async () => {
  const r = await run({ respond: responder({ synth: { summary: 'consistent', contradictions: [] }, gaps: { gaps: [] } }) })
  assert.deepEqual(r.result.contradictions, [])
  assert.equal(r.result.unmatchedContradictions, 0)
  assert.deepEqual(r.result.gaps, [])
})

// ---------------------------------------------------------------- normalisation keeps what changes a claim

// One claim per file; claims[i] comes from f<i>.md.
const oneEach = (texts) => {
  const read = Object.fromEntries(texts.map((t, i) => [`f${i}.md`, [{ text: t, quote: t }]]))
  return { read, files: Object.keys(read) }
}

test('dedupe never merges claims that differ in a currency, %, sign, + or # token, or in a number separator', async () => {
  const texts = [
    'The Team plan costs $8 per user per month.', 'The Team plan costs €8 per user per month.',
    'Client is written in C++', 'Client is written in C#',
    'Uptime is 99.9%', 'Uptime is 99.9',
    'Temperature limit is -5 degrees', 'Temperature limit is 5 degrees',
    'Limit is 1,000 requests', 'Limit is 1.000 requests', 'Limit is 1 000 requests',
  ]
  const { read, files } = oneEach(texts)
  const r = await run({ args: { files }, respond: responder({ read }) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('dedupe: 11 claims -> 11 unique; 11 supported go to synthesis; 0 dropped (unsupported or unchecked)'), r.logs.join('\n'))
  // Both wordings of every pair reach the synthesis agent, so it can see the contradiction.
  assert.deepEqual(claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text), texts)
  assert.equal(r.result.counts.unique, 11)
})

test('dedupe still merges spelling noise: Unicode form, minus sign glyph, full-width symbols, hyphens in words', async () => {
  const { read, files } = oneEach([
    'Café opens at 9', 'Café opens at 9',                       // NFC vs NFD
    'Temperature limit is −5 degrees', 'Temperature limit is -5 degrees', // U+2212 vs hyphen-minus
    'Price is ＄8', 'Price is $8',                                     // full-width dollar sign
    'Uses end-to-end encryption.', 'Uses END to END encryption',
  ])
  const r = await run({ args: { files }, respond: responder({ read }) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('dedupe: 8 claims -> 4 unique; 4 supported go to synthesis; 0 dropped (unsupported or unchecked)'), r.logs.join('\n'))
  const claims = claimsIn(callOf(r, 'synthesize:all').prompt)
  assert.deepEqual(claims.map((c) => c.files), [['f0.md', 'f1.md'], ['f2.md', 'f3.md'], ['f4.md', 'f5.md'], ['f6.md', 'f7.md']])
})

test('dedupe keeps combining marks: words that differ only in a vowel sign stay different', async () => {
  const { read, files } = oneEach(['Word कि is used', 'Word की is used']) // Devanagari ki / kii
  const r = await run({ args: { files }, respond: responder({ read }) })
  assert.ok(r.logs.includes('dedupe: 2 claims -> 2 unique; 2 supported go to synthesis; 0 dropped (unsupported or unchecked)'), r.logs.join('\n'))
})

test('a checker verdict is matched on the same normalisation: $8 and €8 in one file get their own verdicts', async () => {
  const read = { 'a.md': [{ text: 'Plan costs $8', quote: 'q' }, { text: 'Plan costs €8', quote: 'q' }] }
  const r = await run({ args: { files: ['a.md'] }, respond: responder({ read, supported: (f, c) => c.text.includes('$') }) })
  assert.equal(r.error, null)
  assert.deepEqual(r.result.files[0], { file: 'a.md', status: 'ok', claims: 2, supported: 1, unsupported: 1, unchecked: 0 })
})

// Pairs a loose normaliser would merge although they say different things. Each side must reach the synthesis agent.
const DIFFERENT = [
  ['en dash used as a minus', 'Temperature limit is –5 degrees', 'Temperature limit is 5 degrees'],
  ['leading-dot decimal', 'Limit is .5 GB', 'Limit is 5 GB'],
  ['leading-comma decimal', 'Limit is ,5 GB', 'Limit is 5 GB'],
  ['minus in front of a leading-dot decimal', 'Limit is -.5 GB', 'Limit is .5 GB'],
  ['superscript two', 'Quota is 10² requests', 'Quota is 102 requests'],
  ['superscript three', 'Quota is 10³ requests', 'Quota is 103 requests'],
  ['superscript minus', 'Rate is 10⁻³ per second', 'Rate is 10 3 per second'],
  ['subscript two', 'Quota is 10₂ requests', 'Quota is 102 requests'],
  ['megabyte and megabit', 'Limit is 5 MB', 'Limit is 5 Mb'],
  ['megabyte and megabit, no space', 'Limit is 5MB', 'Limit is 5Mb'],
  ['kilobyte and kilobit', 'Limit is 5 kB', 'Limit is 5 Kb'],
  ['megahertz and millihertz', 'Clock is 5 MHz', 'Clock is 5 mHz'],
  ['milliwatt and megawatt', 'Draw is 5 mW', 'Draw is 5 MW'],
  ['million and metre', 'Seats: 5 M', 'Seats: 5 m'],
  ['per mille', 'Discount is 5‰', 'Discount is 5'],
  ['inch, double prime', 'Screen is 6″', 'Screen is 6'],
  ['inch, ASCII quote', 'Screen is 6"', 'Screen is 6'],
  ['foot, prime', 'Height is 5′', 'Height is 5'],
  ['foot, ASCII apostrophe', "Height is 5'", 'Height is 5'],
  // Unit case behind a separator other than plain spaces.
  ['gigabyte and gigabit behind a slash', 'Storage costs $0.10/GB per month', 'Storage costs $0.10/Gb per month'],
  ['megabyte and megabit behind a hyphen', 'Upload limit is 5-MB per file', 'Upload limit is 5-Mb per file'],
  ['megabyte and megabit behind an en dash', 'Upload limit is 5\u2013MB per file', 'Upload limit is 5\u2013Mb per file'],
  ['Mbps and MBps behind a hyphen', 'Link speed is 100-Mbps', 'Link speed is 100-MBps'],
  ['milliwatt and megawatt behind a hyphen', 'Draw is 5-mW', 'Draw is 5-MW'],
  ['megabyte and megabit in brackets', 'Upload limit is 5 (MB) per file', 'Upload limit is 5 (Mb) per file'],
  ['megabyte and megabit after a closing bracket', 'Upload limit is (5) MB per file', 'Upload limit is (5) Mb per file'],
  ['megabyte and megabit after a line break', 'Upload limit is 5\nMB per file', 'Upload limit is 5\nMb per file'],
  ['megabyte and megabit after a hyphen and a space', 'Upload limit is 5 - MB per file', 'Upload limit is 5 - Mb per file'],
  // A sign in front of a currency symbol.
  ['minus in front of a dollar sign', 'The monthly balance is -$5', 'The monthly balance is $5'],
  ['U+2212 in front of a euro sign', 'The monthly balance is \u2212\u20ac5', 'The monthly balance is \u20ac5'],
  ['en dash in front of a pound sign', 'The monthly balance is \u2013\u00a35', 'The monthly balance is \u00a35'],
  ['minus in front of a currency symbol and a leading-dot decimal', 'The monthly balance is -$.5', 'The monthly balance is $.5'],
  ['negative and positive amount in the same claim shape', 'Refund of -$5 per month', 'Refund of $5 per month'],
  // A sign in front of a currency mark that is not a lone symbol glued to the number.
  ['minus, euro sign, space, comma decimal', 'The balance is -€ 5,00', 'The balance is € 5,00'],
  ['minus, dollar sign, space', 'The balance is -$ 5', 'The balance is $ 5'],
  ['U+2212, euro sign, space', 'The balance is −€ 5,00', 'The balance is € 5,00'],
  ['minus in front of US$', 'The balance is -US$5', 'The balance is US$5'],
  ['minus in front of C$', 'The balance is -C$5', 'The balance is C$5'],
  ['minus in front of HK$ and a space', 'The balance is -HK$ 5', 'The balance is HK$ 5'],
  ['minus in front of a currency code and a space', 'The balance is -CHF 5', 'The balance is CHF 5'],
  ['minus in front of a currency code, no space', 'The balance is -USD5', 'The balance is USD5'],
  ['minus in front of a no-break space and a number', 'The balance is -€ 5', 'The balance is € 5'],
  // Unit case behind a currency mark or the word per.
  ['gigabyte and gigabit, euro sign before the slash', 'Storage costs 5€/GB per month', 'Storage costs 5€/Gb per month'],
  ['gigabyte and gigabit, space and euro sign before the slash', 'Storage costs 5 €/GB per month', 'Storage costs 5 €/Gb per month'],
  ['gigabyte and gigabit, currency code before the slash', 'Storage costs 5 USD/GB per month', 'Storage costs 5 USD/Gb per month'],
  ['gigabyte and gigabit, lower-case currency code before the slash', 'Storage costs 5 usd/GB per month', 'Storage costs 5 usd/Gb per month'],
  ['gigabyte and gigabit, bare currency before the slash', 'Storage costs €/GB per month', 'Storage costs €/Gb per month'],
  ['gigabyte and gigabit, currency code and no number', 'Storage costs USD/GB per month', 'Storage costs USD/Gb per month'],
  ['gigabyte and gigabit, spaced slash after a dollar sign', 'Storage costs $ / GB per month', 'Storage costs $ / Gb per month'],
  ['gigabyte and gigabit after the word per', 'Storage costs $0.10 per GB', 'Storage costs $0.10 per Gb'],
  ['gigabyte and gigabit after per and a hyphen', 'Storage costs $0.10 per-GB', 'Storage costs $0.10 per-Gb'],
  ['gigabyte and gigabit after per, currency code in front', 'Storage costs 5 EUR per GB', 'Storage costs 5 EUR per Gb'],
  ['gigabyte and gigabit after per, another word in between', 'Storage costs $5 per user per GB', 'Storage costs $5 per user per Gb'],
  ['gigabyte and gigabit after per, no number at all', 'Storage is billed per GB', 'Storage is billed per Gb'],
  ['megabyte and megabit after per and a currency symbol', 'Transfer costs 5 € per MB', 'Transfer costs 5 € per Mb'],
]
// Pairs that differ only in spelling and must still merge.
const SAME = [
  ['leading-dot decimal is the same number as 0.5', 'Limit is .5 GB', 'Limit is 0.5 GB'],
  ['minus before a leading-dot decimal', 'Limit is -.5 GB', 'Limit is −0.5 GB'],
  ['en dash and hyphen-minus', 'Temperature limit is –5 degrees', 'Temperature limit is -5 degrees'],
  ['en dash and U+2212', 'Temperature limit is –5 degrees', 'Temperature limit is −5 degrees'],
  ['em dash and hyphen-minus', 'Temperature limit is —5 degrees', 'Temperature limit is -5 degrees'],
  ['superscript two is an exponent', 'Quota is 10² requests', 'Quota is 10^2 requests'],
  ['superscript minus is an exponent sign', 'Rate is 10⁻³ per second', 'Rate is 10^-3 per second'],
  ['case of an ordinary word after a number', 'Costs $8 PER user', 'costs $8 per user'],
  ['AM and PM', 'Open from 9 AM to 5 PM', 'open from 9 am to 5 pm'],
  ['full stop and case around a unit', 'Limit is 5 MB.', 'LIMIT IS 5 MB'],
  ['case of a long unit name', 'Limit is 5 Megabytes', 'limit is 5 megabytes'],
  ['inch mark spellings', 'Screen is 6"', 'Screen is 6″'],
  ['smart quote as inch mark', 'Screen is 6”', 'Screen is 6"'],
  ['a quoted number', 'The code "5" is used', 'The code 5 is used'],
  ['an ellipsis in front of a number', 'Limit is...5 GB', 'Limit is 5 GB'],
  ['an apostrophe after a number', "It is 5's", 'It is 5 s'],
  // Case noise stays noise behind a separator; only a unit symbol keeps its case.
  ['case of a unit behind a slash, rest of the text differs in case', 'Storage costs $0.10/GB per month', 'STORAGE COSTS $0.10/GB PER MONTH'],
  ['case of a unit behind a hyphen', 'Upload limit is 5-MB per file', 'UPLOAD LIMIT IS 5-MB PER FILE'],
  ['case of an ordinary word behind a hyphen', 'There is a 5-MINUTE wait', 'there is a 5-minute wait'],
  ['case of an ordinary word behind a slash', 'Support is open 24/7 SUPPORT', 'support is open 24/7 support'],
  ['case of an ordinary word after a line break', 'Limit is 5\nUSERS', 'limit is 5\nusers'],
  ['U+2212 and hyphen-minus in front of a currency symbol', 'The monthly balance is \u2212$5', 'The monthly balance is -$5'],
  ['en dash and hyphen-minus in front of a currency symbol', 'The monthly balance is \u2013\u20ac5', 'The monthly balance is -\u20ac5'],
  ['full-width dollar sign behind a minus', 'The monthly balance is -\uff045', 'The monthly balance is -$5'],
  ['minus, currency symbol and leading-dot decimal', 'The monthly balance is -$.5', 'The monthly balance is \u2212$0.5'],
  ['a range dash between two amounts is no sign', 'Fee is $5-$10', 'Fee is $5 $10'],
  // Signs in front of a currency mark: only the glyph and the case of the mark are noise.
  ['U+2212 and hyphen-minus in front of a euro sign and a space', 'The balance is −€ 5,00', 'The balance is -€ 5,00'],
  ['en dash and hyphen-minus in front of a currency code', 'The balance is –CHF 5', 'The balance is -chf 5'],
  ['U+2212 and hyphen-minus in front of US$', 'The balance is −US$5', 'The balance is -us$5'],
  ['a range dash between two amounts with letters in the mark', 'Fee is $5-US$10', 'Fee is $5 US$10'],
  // A slash or the word per does not turn every letter behind it into a unit.
  ['N/A in any case', 'Price is N/A', 'PRICE IS n/a'],
  ['A/B in any case', 'Run an A/B test', 'run an a/b test'],
  ['R/W in any case', 'Mode is R/W', 'mode is r/w'],
  ['and/or in any case', 'Use this and/or that', 'USE THIS AND/OR THAT'],
  ['I/O in any case', 'I/O is fast', 'i/o is fast'],
  ['case of ordinary words after per', 'Price per Team', 'price PER team'],
  // The unit case behind a currency mark or per is kept; the rest of the claim is still noise.
  ['case around a unit behind a euro sign and a slash', 'Storage costs 5€/GB per month', 'STORAGE COSTS 5€/GB PER MONTH'],
  ['case around a unit behind the word per', 'Storage costs $0.10 per GB', 'STORAGE COSTS $0.10 PER GB'],
  ['case of a currency code before a rate slash', 'Storage costs 5 USD/GB per month', 'Storage costs 5 usd/GB per month'],
]
const runPair = async (a, b) => {
  const { read, files } = oneEach([a, b])
  const r = await run({ args: { files }, respond: responder({ read }) })
  assert.equal(r.error, null)
  return r
}

test('dedupe keeps tokens that change a claim: minus glyphs, decimal points, super/subscripts, unit case, per mille, inch and foot marks', async () => {
  for (const [what, a, b] of DIFFERENT) {
    const r = await runPair(a, b)
    assert.equal(r.result.counts.unique, 2, `${what}: ${JSON.stringify([a, b])} merged into one claim`)
    assert.deepEqual(claimsIn(callOf(r, 'synthesize:all').prompt).map((c) => c.text), [a, b], `${what}: both sides reach the synthesis agent`)
    assert.ok(r.logs.some((l) => l.startsWith('dedupe: 2 claims -> 2 unique')), what)
  }
})

test('dedupe still merges spelling noise around those tokens', async () => {
  for (const [what, a, b] of SAME) {
    const r = await runPair(a, b)
    assert.equal(r.result.counts.unique, 1, `${what}: ${JSON.stringify([a, b])} stayed two claims`)
    assert.deepEqual(r.result.claims[0].files, ['f0.md', 'f1.md'], what)
  }
})

test('a contradiction pair is matched on the same normalisation: a claim with an en dash minus is found, its sign-less twin is another claim', async () => {
  const minus = 'Temperature limit is –5 degrees', plain = 'Temperature limit is 5 degrees'
  const { read, files } = oneEach([minus, plain])
  const synth = { summary: 's', contradictions: [{ a: minus, b: plain }, { a: 'Temperature limit is -5 degrees', b: plain }, { a: plain, b: plain }] }
  const r = await run({ args: { files }, respond: responder({ read, synth }) })
  assert.equal(r.error, null)
  assert.equal(r.result.counts.unique, 2)
  assert.deepEqual(r.result.unmatchedPairs, [{ index: 2, a: plain, b: plain, reason: 'same-claim' }])
})

// ---------------------------------------------------------------- critic counts, rejected claims

test('the critic hears about unique claims dropped, not claim instances: a claim another file supported is not dropped', async () => {
  const read = { 'a.md': [{ text: 'X is 1', quote: 'q' }], 'b.md': [{ text: 'X is 1', quote: 'q' }] }
  const r = await run({ args: { files: ['a.md', 'b.md'] }, respond: responder({ read, supported: (f) => f === 'a.md' }) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('dedupe: 2 claims -> 1 unique; 1 supported go to synthesis; 0 dropped (unsupported or unchecked)'), r.logs.join('\n'))
  const prompt = callOf(r, 'critic:all').prompt
  assert.ok(prompt.includes('dropped before synthesis because no checker supported them: 0 (unsupported: 0; claims the checker did not answer: 0)'), prompt)
  assert.deepEqual(droppedIn(prompt), [])
})

test('the critic still runs when every extracted claim was rejected; synthesis is skipped and the critic is told why', async () => {
  const read = { 'a.md': [{ text: 'X is 1', quote: 'X is 1' }] }
  const r = await run({ args: { files: ['a.md'] }, respond: responder({ read, supported: () => false }) })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r), ['read:a.md', 'check:a.md', 'critic:all'])
  assert.ok(r.logs.includes('synthesize: skipped, no supported claims'))
  const prompt = callOf(r, 'critic:all').prompt
  assert.ok(prompt.includes('NOT AVAILABLE, synthesis was skipped because no claim was supported by a checker'), prompt)
  assert.ok(prompt.includes('dropped before synthesis because no checker supported them: 1 (unsupported: 1; claims the checker did not answer: 0)'), prompt)
  assert.deepEqual(droppedIn(prompt), [{ text: 'X is 1', unsupportedIn: ['a.md'], uncheckedIn: [] }])
  assert.deepEqual(r.result.gaps, GAPS_OUT.gaps)
  assert.equal(r.result.summary, null)
  assert.equal(r.result.contradictions, null)
  assert.equal(r.result.unmatchedPairs, null)
})

// ---------------------------------------------------------------- a throwing synthesis or critic agent

test('a throw from the synthesis agent keeps everything the pipeline produced; the critic still runs and is told', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label === 'synthesize:all') throw new Error('budget'); return base(call) } })
  assert.equal(r.error, null)
  assert.ok(r.result, 'the workflow still returns its result')
  assert.deepEqual(r.result.counts, { files: 3, failed: 0, claimsRead: 6, supported: 6, unsupported: 0, unchecked: 0, unique: 5, forSynthesis: 5 })
  assert.deepEqual(r.result.files.map((f) => [f.file, f.status, f.claims]), FILES.map((f) => [f, 'ok', 2]))
  assert.equal(r.result.claims.length, 5)
  assert.equal(r.result.summary, null)
  assert.equal(r.result.contradictions, null)
  assert.equal(r.result.unmatchedContradictions, null)
  assert.ok(r.logs.includes('synthesize: agent failed: budget'), r.logs.join('\n'))
  assert.ok(!r.logs.includes('synthesize: no result from the synthesis agent'), 'a failure is not logged as an empty answer')
  assert.ok(callOf(r, 'critic:all').prompt.includes('NOT AVAILABLE, the synthesis agent failed'))
  assert.deepEqual(r.result.gaps, GAPS_OUT.gaps)
})

test('a throw from the critic agent keeps the finished synthesis', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label === 'critic:all') throw new Error('budget'); return base(call) } })
  assert.equal(r.error, null)
  assert.equal(r.result.summary, SYNTH_SUMMARY)
  assert.deepEqual(r.result.contradictions, SYNTH_OUT.contradictions)
  assert.equal(r.result.unmatchedContradictions, 0)
  assert.equal(r.result.gaps, null)
  assert.equal(r.result.counts.unique, 5)
  assert.ok(r.logs.includes('critic: agent failed: budget'), r.logs.join('\n'))
  assert.ok(!r.logs.includes('critic: no result from the critic agent'))
})

test('both last agents throwing still returns the read and check results', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (/^(synthesize|critic):/.test(call.label)) throw new Error('agent cap exceeded'); return base(call) } })
  assert.equal(r.error, null)
  assert.equal(r.result.counts.claimsRead, 6)
  assert.equal(r.result.claims.length, 5)
  assert.deepEqual([r.result.summary, r.result.contradictions, r.result.gaps], [null, null, null])
  assert.ok(r.logs.includes('synthesize: agent failed: agent cap exceeded') && r.logs.includes('critic: agent failed: agent cap exceeded'))
})

// ---------------------------------------------------------------- malformed reader entries, conflicting verdicts

test('malformed reader entries are counted in the log when discarded', async () => {
  const good = READ['a.md'][0]
  const read = { ...READ, 'a.md': [{ text: '', quote: 'q' }, { quote: 'z' }, { text: '   ', quote: 'y' }, good] }
  const base = responder({ read })
  const r = await run({ respond: (call) => (call.label === 'check:a.md' ? { checked: [{ text: good.text, supported: true, note: 'n' }] } : base(call)) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('read:a.md: 1 claims, 3 malformed entries discarded'), r.logs.join('\n'))
  assert.ok(r.logs.includes('read:b.md: 2 claims'), 'no suffix when nothing was discarded')
  assert.equal(r.result.files[0].status, 'ok')
})

test('a reader that returns only unusable entries failed to read: the file is a failure, not a note without claims', async () => {
  const read = { ...READ, 'a.md': [{ text: null, quote: 'q' }, { text: 7 }] }
  const r = await run({ respond: responder({ read }) })
  assert.equal(r.error, null)
  assert.ok(r.logs.includes('pipeline[0] failed: read:a.md returned 2 entries and none is a usable claim'), r.logs.join('\n'))
  assert.ok(!labelsOf(r).includes('check:a.md'))
  assert.deepEqual(r.result.failed, ['a.md'])
  assert.deepEqual(r.result.files[0], { file: 'a.md', status: 'failed' })
  const none = await run({ respond: responder({ read: { ...READ, 'a.md': [] } }) })
  assert.equal(none.result.files[0].status, 'no-claims', 'an empty list is still a legitimate answer')
  assert.deepEqual(none.result.failed, [])
})

test('conflicting verdicts for one claim leave it unchecked and are logged; entry order does not decide', async () => {
  const check = (verdicts) => (call) => {
    if (call.label === 'read:a.md') return { claims: [{ text: 'X is 1', quote: 'X is 1' }] }
    if (call.label === 'check:a.md') return { checked: verdicts.map((supported) => ({ text: 'X is 1', supported, note: `n ${supported}` })) }
    return call.label === 'critic:all' ? GAPS_OUT : null
  }
  for (const verdicts of [[false, true], [true, false], [true, false, true]]) {
    const r = await run({ args: { files: ['a.md'] }, respond: check(verdicts) })
    assert.equal(r.error, null)
    assert.deepEqual(r.result.files[0], { file: 'a.md', status: 'ok', claims: 1, supported: 0, unsupported: 0, unchecked: 1 }, JSON.stringify(verdicts))
    assert.ok(r.logs.includes('check:a.md: 1 claims got conflicting verdicts from the checker and are treated as unchecked'), r.logs.join('\n'))
    assert.equal(r.result.counts.forSynthesis, 0)
    assert.equal(r.result.claims.length, 0)
  }
  for (const verdict of [true, false]) {
    const r = await run({ args: { files: ['a.md'] }, respond: check([verdict, verdict]) })
    assert.equal(r.result.files[0][verdict ? 'supported' : 'unsupported'], 1, 'entries that agree are one verdict')
    assert.ok(!r.logs.some((l) => /conflicting/.test(l)))
  }
})

// ---------------------------------------------------------------- what the critic hears about empty and failed files

// The JSON array at the end of the critic-prompt line that starts with `start`.
const listIn = (prompt, start) => {
  const line = prompt.split('\n').find((l) => l.startsWith(start))
  assert.ok(line, `critic prompt has a line starting with "${start}"`)
  return JSON.parse(line.match(/\[.*\]$/)[0])
}

test('a file whose reader returned an empty list reaches the critic as unverified, not as a note that was read', async () => {
  const r = await run({ respond: responder({ read: { ...READ, 'b.md': [] } }) })
  assert.equal(r.error, null)
  const critic = callOf(r, 'critic:all').prompt
  assert.deepEqual(listIn(critic, 'Files read and checked'), ['a.md', 'c.md'])
  assert.deepEqual(listIn(critic, 'Files whose reader returned an empty list'), ['b.md'])
  assert.ok(critic.includes('the note has no factual claims, or the file could not be read; the run cannot tell which'), critic)
  assert.deepEqual(listIn(critic, 'Files that failed'), [])
  assert.ok(r.logs.includes('no claims from: b.md; the note has none or the file could not be read, the critic is told'), r.logs.join('\n'))
  assert.deepEqual(r.result.failed, [])
  assert.ok(callOf(r, 'read:a.md').prompt.includes('or you cannot read the file, return an empty list; never guess what the file says'))
  const happy = await run()
  assert.deepEqual(listIn(callOf(happy, 'critic:all').prompt, 'Files whose reader returned an empty list'), [])
  assert.ok(!happy.logs.some((l) => l.startsWith('no claims from')))
})

test('every reader returned an empty list: the critic still runs, synthesis is skipped, nothing is invented', async () => {
  const r = await run({ respond: responder({ read: { 'a.md': [], 'b.md': [], 'c.md': [] } }) })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r), ['read:a.md', 'read:b.md', 'read:c.md', 'critic:all'])
  assert.deepEqual(r.result.failed, [])
  assert.deepEqual(r.result.files.map((f) => f.status), ['no-claims', 'no-claims', 'no-claims'])
  assert.equal(r.result.summary, null)
  assert.equal(r.result.contradictions, null)
  assert.deepEqual(r.result.gaps, GAPS_OUT.gaps)
  const critic = callOf(r, 'critic:all').prompt
  assert.deepEqual(listIn(critic, 'Files whose reader returned an empty list'), FILES)
  assert.deepEqual(listIn(critic, 'Files read and checked'), [])
  assert.ok(critic.includes('NOT AVAILABLE, synthesis was skipped because no claim was read and checked'), critic)
  assert.ok(r.logs.includes('synthesize: skipped, no supported claims'))
  assert.ok(!r.logs.includes('critic: skipped, no claims were read'))
})

test('a check-stage failure is reported with its stage, reason and lost claims; the critic is told the file was read', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label === 'check:c.md') throw new Error('boom in check'); return base(call) } })
  assert.equal(r.error, null)
  assert.deepEqual(r.result.failed, ['c.md'])
  assert.deepEqual(r.result.failures, [{ file: 'c.md', stage: 'check', reason: 'boom in check', claimsLost: 2 }])
  assert.ok(r.logs.includes('failed: c.md at check: boom in check; 2 claims were read but are not checked and do not reach synthesis'), r.logs.join('\n'))
  assert.ok(r.logs.includes('pipeline[2] failed: boom in check'), 'the runtime still sees the throw and drops the item')
  const critic = callOf(r, 'critic:all').prompt
  assert.deepEqual(listIn(critic, 'Files read and checked'), ['a.md', 'b.md'])
  assert.deepEqual(listIn(critic, 'Files that failed'), ['c.md'])
  assert.deepEqual(listIn(critic, 'Failure details'), r.result.failures)
  assert.ok(!critic.includes('failed and were not read'), 'a file that was read is not described as unread')
  assert.ok(critic.includes('claims read from them, if any, are not checked and are not in the claims below'), critic)
  assert.equal(r.result.counts.claimsRead, 4)
  assert.deepEqual(r.result.files.find((f) => f.file === 'c.md'), { file: 'c.md', status: 'failed' })
})

test('a read-stage failure is reported as read with no claim count; a bad answer from the checker is a check failure with the claims it lost', async () => {
  const base = responder()
  const thrown = await run({ respond: (call) => { if (call.label === 'read:b.md') throw new Error('boom in read'); return base(call) } })
  assert.deepEqual(thrown.result.failures, [{ file: 'b.md', stage: 'read', reason: 'boom in read', claimsLost: null }])
  assert.ok(thrown.logs.includes('failed: b.md at read: boom in read'), thrown.logs.join('\n'))
  assert.deepEqual(listIn(callOf(thrown, 'critic:all').prompt, 'Files that failed'), ['b.md'])
  const nothing = await run({ respond: (call) => (call.label === 'read:a.md' ? null : base(call)) })
  assert.deepEqual(nothing.result.failures, [{ file: 'a.md', stage: 'read', reason: 'read:a.md returned no claims list', claimsLost: null }])
  const junk = await run({ respond: responder({ read: { ...READ, 'a.md': [{ text: null, quote: 'q' }] } }) })
  assert.deepEqual(junk.result.failures, [{ file: 'a.md', stage: 'read', reason: 'read:a.md returned 1 entries and none is a usable claim', claimsLost: null }])
  const noChecked = await run({ respond: (call) => (call.label === 'check:a.md' ? null : base(call)) })
  assert.deepEqual(noChecked.result.failures, [{ file: 'a.md', stage: 'check', reason: 'check:a.md returned no checked list', claimsLost: 2 }])
})

test('failures is an empty list when nothing failed', async () => {
  const r = await run()
  assert.deepEqual(r.result.failures, [])
  assert.deepEqual(listIn(callOf(r, 'critic:all').prompt, 'Failure details'), [])
  assert.ok(!r.logs.some((l) => l.startsWith('failed:')))
})

test('every check failing: the critic is skipped and the log says that claims were read and then lost', async () => {
  const base = responder()
  const r = await run({ respond: (call) => { if (call.label.startsWith('check:')) throw new Error('budget'); return base(call) } })
  assert.equal(r.error, null)
  assert.deepEqual(labelsOf(r).filter((l) => !/^(read|check):/.test(l)), [])
  assert.equal(r.result.counts.claimsRead, 0)
  assert.deepEqual(r.result.failures.map((f) => [f.file, f.stage, f.claimsLost]), FILES.map((f) => [f, 'check', 2]))
  assert.ok(r.logs.includes('critic: skipped, no claim was read and checked (6 claims were read but lost in failed checks)'), r.logs.join('\n'))
  assert.ok(!r.logs.includes('critic: skipped, no claims were read'))
})

test('an explicit undefined model means the default; a valid model name is passed through unchanged', async () => {
  const r = await run({ args: { model: undefined } })
  assert.equal(r.error, null)
  assert.ok(r.calls.every((c) => c.opts.model === 'haiku'))
  const r2 = await run({ args: { model: 'claude-sonnet-5-5' } })
  assert.ok(r2.calls.every((c) => c.opts.model === 'claude-sonnet-5-5'))
})

// ---------------------------------------------------------------- the agent cap

test('a file list that cannot fit the 1000-agent cap is rejected before any agent runs; the largest list fits exactly', async () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `f${i}.md`)
  const tooMany = await dryRun(SCRIPT, { args: { targetDir: '/t', files: names(500) }, respond: responder() })
  assert.match(tooMany.error?.message ?? '', /500 names; at most 499 fit the 1000-agent cap/)
  assert.equal(tooMany.calls.length, 0)
  const { read, files } = oneEach(names(499).map((n) => `claim from ${n}`))
  const fits = await dryRun(SCRIPT, { args: { targetDir: '/t', files }, respond: responder({ read }) })
  assert.equal(fits.error, null)
  assert.equal(fits.calls.length, 1000)
  assert.deepEqual(fits.result.failed, [])
  assert.equal(fits.result.counts.unique, 499)
  assert.ok(fits.result.summary && fits.result.gaps)
})

// ---------------------------------------------------------------- labels, phases, options

test('labels and phases match meta', async () => {
  const r = await run()
  const titles = META.phases.map((p) => p.title)
  const phaseOfRole = { read: 'Read', check: 'Check', synthesize: 'Synthesize', critic: 'Synthesize' }
  for (const c of r.calls) {
    assert.match(c.label, /^(read|check):[^:]+$|^(synthesize|critic):all$/)
    assert.equal(c.opts.phase, phaseOfRole[c.label.split(':')[0]], `${c.label} carries an explicit phase`)
    assert.ok(titles.includes(c.phase), `${c.label}: phase ${c.phase} is declared in meta`)
  }
  assert.deepEqual([...new Set(r.calls.map((c) => c.phase))].sort(), [...titles].sort(), 'every declared phase is used')
  assert.ok(r.phases.every((p) => titles.includes(p)), `phase() calls ${r.phases} are declared in meta`)
  assert.deepEqual(r.phases, ['Read', 'Synthesize'])
  assert.ok(r.calls.filter((c) => c.opts.phase === 'Check').length === FILES.length)
  assert.ok(r.calls.filter((c) => c.opts.phase === 'Synthesize').length === 2)
})

test('every agent has a schema; the model comes from args and defaults to haiku', async () => {
  const r = await run()
  assert.ok(r.calls.every((c) => c.opts.schema && c.opts.schema.type === 'object' && c.opts.model === 'haiku'))
  const props = (label) => Object.keys(callOf(r, label).opts.schema.properties)
  assert.deepEqual(props('read:a.md'), ['claims'])
  assert.deepEqual(props('check:a.md'), ['checked'])
  assert.deepEqual(props('synthesize:all'), ['summary', 'contradictions'])
  assert.deepEqual(props('critic:all'), ['gaps'])
  for (const c of r.calls) for (const s of [c.opts.schema]) assert.ok(s.required.every((k) => k in s.properties))
  const r2 = await run({ args: { model: 'sonnet' } })
  assert.ok(r2.calls.every((c) => c.opts.model === 'sonnet'))
  const r3 = await dryRun(SCRIPT, { args: { targetDir: '/t', files: FILES }, respond: responder() })
  assert.ok(r3.calls.every((c) => c.opts.model === 'haiku'), 'default model')
})

test('bad args throw before any agent runs', async () => {
  const bad = [
    [{ targetDir: undefined }, /targetDir is required/],
    [{ targetDir: '' }, /targetDir is required/],
    [{ files: [] }, /non-empty array/],
    [{ files: 'a.md' }, /non-empty array/],
    [{ files: ['a.md', '../secret.md'] }, /plain file names/],
    [{ files: ['sub/a.md'] }, /plain file names/],
    [{ files: ['a.md', 7] }, /plain file names/],
    [{ files: ['a.md', 'a.md'] }, /duplicates/],
    [{ targetDir: '   ' }, /targetDir is required/],
    [{ targetDir: '\t\n' }, /targetDir is required/],
    [{ model: 5 }, /args\.model must be a non-empty string/],
    [{ model: { x: 1 } }, /args\.model must be a non-empty string/],
    [{ model: ['haiku'] }, /args\.model must be a non-empty string/],
    [{ model: true }, /args\.model must be a non-empty string/],
    [{ model: null }, /args\.model must be a non-empty string/],
    [{ model: '' }, /args\.model must be a non-empty string/],
    [{ model: '   ' }, /args\.model must be a non-empty string/],
  ]
  for (const [over, re] of bad) {
    const r = await dryRun(SCRIPT, { args: { targetDir: '/t', files: FILES, ...over }, respond: responder() })
    assert.match(r.error?.message ?? '', re, JSON.stringify(over))
    assert.equal(r.calls.length, 0)
  }
  const none = await dryRun(SCRIPT, { respond: responder() })
  assert.match(none.error?.message ?? '', /targetDir is required/)
})

test('a trailing slash on targetDir does not double up in prompts', async () => {
  const r = await run({ args: { targetDir: '/t/' } })
  assert.ok(callOf(r, 'read:a.md').prompt.includes('/t/a.md') && !callOf(r, 'read:a.md').prompt.includes('/t//a.md'))
})
