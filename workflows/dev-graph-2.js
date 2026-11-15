export const meta = {
  name: 'wfviz-dev-graph-2',
  description: 'Close open findings of N3 N7 N9, then integrate source+model+server (node I1); revised gate: high/medium only, diff-only verification, judge only on real disagreement',
  phases: [
    { title: 'Fix', detail: 'apply open high/medium findings carried over from run 1' },
    { title: 'Implement', detail: 'integration node I1' },
    { title: 'Review', detail: 'full review once, then diff-only verification' },
    { title: 'Judge', detail: 'codex cli; only on non-overlapping high/medium findings or when both reviewers found nothing in the full round' },
    { title: 'Test', detail: 'runs the node test command; counts parsed in code' },
  ],
}
// args: { judgeCmd, base: '<git commit the run starts from>', open: { N3: [finding], N7: [...], N9: [...] } }
// Gate (lessons of run 1, see progress.md):
//  - only high/medium findings send work back; low ones go to the report;
//  - each reviewer reports at most 5 findings, most important first;
//  - reviewers agree when findings overlap (same file, lines within 3);
//  - after the first full review a node gets at most 2 diff-only verification rounds;
//  - test counts accept both "# pass N" (TAP) and "ℹ pass N" (spec reporter); skipped and todo must be 0.
const JUDGE_CMD = args && args.judgeCmd
const BASE = args && args.base
if (!JUDGE_CMD || !BASE) throw new Error('args.judgeCmd and args.base are required')
const COMMON = `Project: wfviz, a local read-only visualizer of Claude Code Dynamic Workflow runs, in the current directory.
Binding: docs/contract.md. Observed formats: sources/event-sources.md (read its last sections: they were corrected today). Fixtures: fixtures/README.md.
Rules: ES modules, Node >= 20, zero npm dependencies, no network. Write ONLY the files you own. Never run git commit, git stash, git reset or any destructive command. No command longer than 2 minutes. Never invent data: a missing value stays missing; do not add handling for formats that are not documented in sources/event-sources.md.`

const NODES = {
  N3: { name: 'source-claude-fs', test: 'node --test test/source/', owns: ['src/source/claude-fs.mjs', 'src/source/script-meta.mjs', 'test/source/'],
    extra: `Also: (1) emit agent.failed for journal {"type":"failed"} records (contract §1); (2) agent.prompt from the "[Workflow harness — computed task]" record, frame line removed and indentation stripped, framed:true; fall back to the first user record with framed:false; (3) when a final file names a scriptPath and no copy exists under workflows/scripts/, read that script once and emit run.script; (4) copy the transcript "version" field into agent.prompt data as ccVersion; (5) the optional legacy test must not count as skipped when WFVIZ_LEGACY_RUN_DIR is unset: use a synthetic legacy fixture assertion instead and keep the env-based test in a separate file test/source/optional-legacy.mjs that node --test test/source/ does not pick up (no .test. in the name).` },
  N7: { name: 'demo-source', test: 'node --test test/demo/', owns: ['src/source/demo.mjs', 'test/demo/'], extra: '' },
  N9: { name: 'workflow-b-fanout', test: 'node --test test/workflows/research-fanout.test.mjs', owns: ['workflows/research-fanout.js', 'fixtures/target-b/', 'test/workflows/research-fanout.test.mjs'], extra: '' },
  I1: { name: 'integration', test: 'node --test test/',
    owns: ['test/integration/', 'src/source/', 'src/model/', 'src/server/', 'bin/wfviz.mjs'],
    spec: `Integrate the layers and prove they fit. Write test/integration/*.test.mjs that:
- replays every run under fixtures/claude-projects and fixtures/synthetic with readRunDir -> createStore().apply -> getRun, and checks contract §2 for each: status and its prov (completed/failed from final file; running inferred when the final file is removed in a temp copy), phases from script meta, agents with labels, agent.failed -> state failed, data-flow edge from both reviewers to the judge in probe 1 (wf_6509ce25-20a), no edge without evidence, logs unknown without final file, registeredEdges unknown;
- grows a temp copy of probe 1 file by file (journal lines appended one at a time) under a temp root, runs createClaudeFsSource with that root and a store, and asserts agent states move started -> done and the run status ends as completed after the final file is copied last;
- starts bin/wfviz.mjs --no-open --root <temp root> --idle 0 --port 0 as a child process, reads the printed URL, checks GET /api/runs, GET /api/runs/:id, the SSE hello event (mode real) and one run event, GET / serves web/index.html, then SIGINT -> exit 0;
- checks that real mode never loads demo: bin source has demo only behind a dynamic import under --demo, and /api/runs in real mode lists no run whose id starts with demo-.
Fix mismatches you find in src/ or bin/ (you own them for this node), keeping every existing test green. web/ is not yours; if the UI needs a field the model does not provide, say so in your note.` },
}

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', maxItems: 5, items: { type: 'object', properties: {
  file: { type: 'string' }, line: { type: 'number' }, input: { type: 'string' }, description: { type: 'string' },
  severity: { type: 'string', enum: ['high', 'medium', 'low'] }, category: { type: 'string' } },
  required: ['file', 'line', 'input', 'description', 'severity', 'category'] } } }, required: ['findings'] }
const JUDGE = { type: 'object', properties: { verdict: { type: 'string', enum: ['fix', 'accept'] },
  approved: { type: 'array', items: { type: 'number' } },
  dropped: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, reason: { type: 'string' } }, required: ['index', 'reason'] } },
  missed: FINDINGS.properties.findings, engine: { type: 'string' }, note: { type: 'string' } },
  required: ['verdict', 'approved', 'dropped', 'missed', 'engine', 'note'] }
// codex cli --output-schema runs in strict mode: every object needs additionalProperties:false
const strict = (s) => (s && typeof s === 'object' ? (Array.isArray(s) ? s.map(strict) : Object.fromEntries(Object.entries({ ...s, ...(s.type === 'object' ? { additionalProperties: false } : {}) }).map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strict(pv)])) : strict(v)]))) : s)
const TEST = { type: 'object', properties: { exitCode: { type: 'number' }, outputTail: { type: 'string' } }, required: ['exitCode', 'outputTail'] }
const DONE = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['files', 'note'] }

const num = (re, s) => { const m = re.exec(s || ''); return m ? Number(m[1]) : null }
const parseTests = (t) => { const o = (t && t.outputTail) || ''; return { exitCode: t ? t.exitCode : null,
  pass: num(/^(?:#|ℹ) pass (\d+)/m, o), fail: num(/^(?:#|ℹ) fail (\d+)/m, o), skipped: num(/^(?:#|ℹ) skipped (\d+)/m, o),
  todo: num(/^(?:#|ℹ) todo (\d+)/m, o), tail: o.slice(-1500) } }
const testsOk = (r) => r.exitCode === 0 && r.fail === 0 && r.skipped === 0 && (r.todo === 0 || r.todo === null) && r.pass > 0
const valid = (f) => f && f.file && Number.isFinite(f.line) && f.line > 0 && f.input && String(f.input).trim()
const serious = (f) => f.severity === 'high' || f.severity === 'medium'
const base = (p) => String(p).split('/').pop()
const overlaps = (f, g) => base(f.file) === base(g.file) && Math.abs(f.line - g.line) <= 3

const runTests = (id, n, tag) => agent(`Run exactly this command in the project root and nothing else: ${n.test}
Return its exit code and the last 3000 characters of combined stdout+stderr as outputTail. Do not fix anything.`,
  { label: `test:${id}#${tag}`, phase: 'Test', schema: TEST, model: 'haiku', effort: 'low' }).then(parseTests)

const reviewFull = (id, n, who, lens) => agent(`${COMMON}
You are reviewer ${who} for node ${id} (${n.name}). You did not write this code. Assume it is wrong and prove it.
Owned paths: ${n.owns.join(', ')}. Change since the run started: git diff ${BASE} -- ${n.owns.join(' ')} ; new files: git status --short -- ${n.owns.join(' ')}.
Spec:\n${n.spec || n.extra}
Lens: ${lens}. Report at most 5 concrete breaks, most important first; each with file, line and a failing input or situation. Severity: high = wrong result or crash in normal use; medium = wrong in a realistic edge case; low = style, wording, unlikely edge. Reject stubs, workaround comments, weakened/skipped/deleted tests, edits outside owned paths. Do not edit files.`,
  { label: `review-${who}:${id}#full`, phase: 'Review', schema: FINDINGS, model: 'sonnet' })

const reviewDiff = (id, n, round, items) => agent(`${COMMON}
Verification reviewer for node ${id} (${n.name}). Check ONLY whether these findings are now fixed and whether the fix broke something it touched:
${JSON.stringify(items)}
Look at: git diff ${BASE} -- ${n.owns.join(' ')} (and new files in git status). Do not search the rest of the node for new issues. Report remaining or newly introduced breaks only (max 5), same format and severity scale. Do not edit files.`,
  { label: `verify:${id}#v${round}`, phase: 'Review', schema: FINDINGS, model: 'sonnet' })

const judge = (id, n, all, why) => agent(`You coordinate a judge run for node ${id}. Do not judge yourself unless the external judge fails.
1) Write the text between <<<PROMPT and PROMPT>>> to evidence/tmp/judge2-${id}.md and this JSON schema to evidence/tmp/judge-schema.json:
${JSON.stringify(strict(JUDGE))}
2) Run: ${JUDGE_CMD} exec --ephemeral -s read-only -m gpt-6.1-sol -C . --output-schema evidence/tmp/judge-schema.json -o evidence/tmp/judge2-${id}.out.json - < evidence/tmp/judge2-${id}.md
3) Return that JSON unchanged with engine "codex-cli". If the command fails, put its exit code and the last stderr lines in note, judge yourself with the same prompt, engine "fallback-claude".
<<<PROMPT
You are the judge for node ${id} (${n.name}). You check the checkers; you never write code. Why you were called: ${why}.
Spec:\n${n.spec || n.extra}
Owned paths: ${n.owns.join(', ')}. Contract: docs/contract.md. Observed formats: sources/event-sources.md.
Findings: ${JSON.stringify(all.map((f, i) => ({ i, ...f })))}
Drop findings that are not real, have no failing input, or ask for handling of formats not documented in sources/event-sources.md. Add what both missed (high/medium only) to missed. approved = indexes for the fixer. verdict "accept" if nothing high/medium must be fixed.
PROMPT>>>`, { label: `judge:${id}`, phase: 'Judge', schema: JUDGE, model: 'opus' })

const fix = (id, n, items, tests, tag) => agent(`${COMMON}
You are the fixer for node ${id} (${n.name}). Files you own: ${n.owns.join(', ')}.
${n.spec ? 'Spec:\n' + n.spec + '\n' : ''}${n.extra ? n.extra + '\n' : ''}Fix exactly these findings and failing tests; nothing else. Do not weaken, skip or delete tests.
Findings: ${JSON.stringify(items)}
${tests ? `Last test run (${n.test}): exit ${tests.exitCode}, pass ${tests.pass}, fail ${tests.fail}, skipped ${tests.skipped}, todo ${tests.todo}\n${tests.tail}` : ''}
Run ${n.test} before finishing. Return the files you changed.`,
  { label: `fix:${id}#${tag}`, phase: 'Fix', schema: DONE, model: 'sonnet' })

// verification loop shared by both stages: at most 2 diff-only rounds
async function verifyLoop(id, n, approved, report) {
  let tests = await runTests(id, n, 'after-fix')
  let pending = approved
  for (let v = 1; v <= 2; v++) {
    const r = await reviewDiff(id, n, v, pending)
    const found = ((r && r.findings) || []).filter(valid)
    report.low.push(...found.filter((f) => !serious(f)))
    const must = found.filter(serious)
    report.rounds.push({ verify: v, found: found.length, serious: must.length, tests })
    if (!must.length && testsOk(tests)) return { status: 'pass', tests }
    if (v === 2) break
    await fix(id, n, must, tests, `v${v}`)
    tests = await runTests(id, n, `v${v + 1}`)
    pending = must.length ? must : pending
  }
  return { status: 'blocked', tests }
}

phase('Fix')
const carried = ['N3', 'N7', 'N9'].map((id) => ({ id, items: ((args.open || {})[id] || []).filter(serious) }))
log(`stage 1: carried findings ${carried.map((c) => `${c.id}=${c.items.length}`).join(' ')}`)
const stage1 = await parallel(carried.map((c) => async () => {
  const n = NODES[c.id], report = { node: c.id, rounds: [], low: [] }
  if (!c.items.length && !n.extra) return { ...report, status: 'pass', note: 'nothing carried' }
  await fix(c.id, n, c.items, null, 'carried')
  const r = await verifyLoop(c.id, n, c.items.length ? c.items : [{ file: n.owns[0], line: 1, input: 'extra spec items', description: n.extra, severity: 'medium', category: 'spec' }], report)
  return { ...report, ...r }
}))

phase('Implement')
const n = NODES.I1, report = { node: 'I1', rounds: [], low: [] }
await agent(`${COMMON}\nYou implement node I1 (integration). Files you own: ${n.owns.join(', ')}.\nSpec:\n${n.spec}\nRun ${n.test} and make everything pass honestly. Return the files you wrote or changed.`,
  { label: 'implement:I1', phase: 'Implement', schema: DONE, model: 'sonnet' })
let tests = await runTests('I1', n, 'impl')
const [a, b] = await parallel([
  () => reviewFull('I1', n, 'a', 'do the layers really fit: event kinds, field names, provenance, run status, edges, API shapes'),
  () => reviewFull('I1', n, 'b', 'test honesty and lifecycle: are the integration tests real, process shutdown, ports, temp dirs, real/demo separation'),
])
const fa = ((a && a.findings) || []).filter(valid), fb = ((b && b.findings) || []).filter(valid)
report.low.push(...[...fa, ...fb].filter((f) => !serious(f)))
const sa = fa.filter(serious), sb = fb.filter(serious)
const agreed = sa.filter((f) => sb.some((g) => overlaps(f, g)))
const lone = [...sa.filter((f) => !agreed.includes(f)), ...sb.filter((g) => !sa.some((f) => overlaps(f, g)))]
let approved = agreed
if (lone.length || (!fa.length && !fb.length)) {
  const j = await judge('I1', n, [...agreed, ...lone], lone.length ? 'reviewers disagree on high/medium findings' : 'both reviewers found nothing')
  approved = j ? [...(j.approved || []).map((i) => [...agreed, ...lone][i]).filter(Boolean), ...((j.missed || []).filter(valid).filter(serious))] : [...agreed, ...lone]
  report.rounds.push({ full: true, agreed: agreed.length, lone: lone.length, judge: j ? { engine: j.engine, verdict: j.verdict, note: j.note } : null, approved: approved.length, tests })
} else report.rounds.push({ full: true, agreed: agreed.length, lone: 0, judge: 'skipped (agreement)', approved: approved.length, tests })
let i1
if (!approved.length && testsOk(tests)) i1 = { status: 'pass', tests }
else { await fix('I1', n, approved, tests, 'full'); i1 = await verifyLoop('I1', n, approved, report) }

return { stage1, integration: { ...report, ...i1 } }
