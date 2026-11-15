export const meta = {
  name: 'wfviz-dev-graph-3-trial',
  description: 'Workflow 3 trial: node M1 (model, contract 2) through every gate once: implement, test, two reviewers, judge (codex cli), fixer, diff-only verification',
  phases: [
    { title: 'Implement', detail: 'node M1: model changes of contract 2' },
    { title: 'Test', detail: 'runs the node test command; counts parsed in code' },
    { title: 'Review', detail: 'two reviewers, full review once, then diff-only verification (max 2)' },
    { title: 'Judge', detail: 'codex cli, always after the full review' },
    { title: 'Fix', detail: 'only judge-approved high/medium findings and failing tests' },
  ],
}
// args: { judgeCmd, base: '<git commit the run starts from>' }
// Gate (AGENTS.md, graph.md §9):
//  - only high/medium findings send work back; low go to the report;
//  - each reviewer reports at most 5 findings with file, line and a failing input;
//  - the judge always runs after the full review (reviewers have different lenses by design,
//    so "judge on disagreement" is meaningless);
//  - after the full review: at most 2 diff-only verification rounds, then blocked;
//  - tests: exit 0, fail 0, skipped 0, todo 0, pass > 0, parsed from "# pass N" or "ℹ pass N".
const JUDGE_CMD = args && args.judgeCmd
const BASE = args && args.base
if (!JUDGE_CMD || !BASE) throw new Error('args.judgeCmd and args.base are required')

const COMMON = `Project: wfviz, a local read-only visualizer of Claude Code Dynamic Workflow runs, in the current directory.
Binding: docs/contract.md (contract 2; the change log with evidence is docs/c-rev-proposal.md). Observed formats: sources/event-sources.md, especially its last section "V0 version survey"; per-version tables: sources/format-survey.md.
Rules: ES modules, Node >= 20, zero npm dependencies, no network. Write ONLY the files you own. Never run git commit, git stash, git reset or any destructive command. No command longer than 2 minutes. Never invent data: a missing value stays missing; do not add handling for formats not observed in sources/event-sources.md.`

const M1 = {
  name: 'model-contract-2',
  test: 'node --test test/model/',
  owns: ['src/model/', 'test/model/'],
  spec: `Bring src/model/ to contract 2 (docs/contract.md §2, §3 and the store interface in §5). Items, each with tests in test/model/:
1. Run.status: running | completed | failed | killed | unknown; any other final status string kept as is with prov "final" (never turned into unknown). "stopped" is gone.
2. Agent.state normalised (queued | running | done | failed | unknown) with Fact.raw = source value: final "done"->done, "error"->failed, "progress"->running; journal agent.failed -> failed (registered). An agent still running when the run is killed or failed: no invented end time; expose it so the UI can show "interrupted" (e.g. Fact.raw or a note), documented in a code comment.
3. Final file: workflowProgress[] items with type "workflow_phase" are phases, never agents, and carry no state. The journal decides which agents exist; an agent absent from the final file keeps its registered values.
4. Run.ccVersion from the version field of agent transcript records (agent.prompt data carries ccVersion), prov registered; several distinct values joined with " + ".
5. Version-aware reason: before the final file arrives, a run whose ccVersion is below 2.1.271 gets label/phase unknown with reason "not recorded live before 2.1.271".
6. Label pattern: role:unit#tag; everything after the last "#" is tag (new Agent field tag: Fact, method label-pattern); unit never contains the suffix; round only from "#r<n>" or "round <n>". Example: "impl:x#carried" -> unit x, tag carried, round unknown.
7. Data-flow edges (contract §2 "Dependency inference"): strong only when A ended before B started; B's prompt contains a normalised substring of A's result serialisation of >= 64 chars; that substring occurs in no other agent's result that ended before B started; and it occurs neither in the run's script text nor in the prompts of >= 2 other agents. evidence = first 80 chars + length. Keep it fast enough for a run with 300 agents (the current test suite must stay well under 2 minutes).
8. Recognised tests also from a node --test summary inside a string result or a string field (depth <= 3): "ℹ pass N" or "# pass N", plus fail, skipped, todo -> prov inferred, method node-test-summary.
9. Store event stream (contract §4/§5): createStore() gains onEvent(cb) and eventsSince(runId, seq). For every RawEvent applied (except source.warning) emit a UiEvent { runId, seq (per run, from 1, no gaps), ts, kind, agentId?, label?, role?, unit?, message, status?, prov: "registered" | "final" }; message is a short line built only from event data; keep the last 2000 per run.
Keep every existing test in test/ green (run node --test test/ once before finishing, not only test/model/). If an existing test asserts contract-1 behaviour that contract 2 changed, update that test and say which in your note. Files outside src/model/ and test/model/ are not yours: if web/ or src/server/ needs a change, list it in your note.`,
}

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', maxItems: 5, items: { type: 'object', properties: {
  file: { type: 'string' }, line: { type: 'number' }, input: { type: 'string' }, description: { type: 'string' },
  severity: { type: 'string', enum: ['high', 'medium', 'low'] }, category: { type: 'string' } },
  required: ['file', 'line', 'input', 'description', 'severity', 'category'] } } }, required: ['findings'] }
const JUDGE = { type: 'object', properties: { verdict: { type: 'string', enum: ['fix', 'accept'] },
  approved: { type: 'array', items: { type: 'number' } },
  dropped: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, reason: { type: 'string' } }, required: ['index', 'reason'] } },
  missed: FINDINGS.properties.findings, contractIssue: { type: 'string' }, engine: { type: 'string' }, note: { type: 'string' } },
  required: ['verdict', 'approved', 'dropped', 'missed', 'contractIssue', 'engine', 'note'] }
// codex cli --output-schema is strict: every object needs additionalProperties:false
const strict = (s) => (s && typeof s === 'object' ? (Array.isArray(s) ? s.map(strict) : Object.fromEntries(Object.entries({ ...s, ...(s.type === 'object' ? { additionalProperties: false } : {}) }).map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strict(pv)])) : strict(v)]))) : s)
const TEST = { type: 'object', properties: { exitCode: { type: 'number' }, outputTail: { type: 'string' } }, required: ['exitCode', 'outputTail'] }
const DONE = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['files', 'note'] }

const num = (re, s) => { const m = re.exec(s || ''); return m ? Number(m[1]) : null }
const parseTests = (t) => { const o = (t && t.outputTail) || ''; return { exitCode: t ? t.exitCode : null,
  pass: num(/^(?:#|ℹ) pass (\d+)/m, o), fail: num(/^(?:#|ℹ) fail (\d+)/m, o), skipped: num(/^(?:#|ℹ) skipped (\d+)/m, o),
  todo: num(/^(?:#|ℹ) todo (\d+)/m, o), tail: o.slice(-1500) } }
const testsOk = (r) => r.exitCode === 0 && r.fail === 0 && r.skipped === 0 && r.todo === 0 && r.pass > 0
const valid = (f) => f && f.file && Number.isFinite(f.line) && f.line > 0 && f.input && String(f.input).trim()
const serious = (f) => f.severity === 'high' || f.severity === 'medium'

const n = M1
const id = 'M1'
const runTests = (tag, cmd = n.test) => agent(`Run exactly this command in the project root and nothing else: ${cmd}
Return its exit code and the last 3000 characters of combined stdout+stderr as outputTail. Do not fix anything.`,
  { label: `test:${id}#${tag}`, phase: 'Test', schema: TEST, model: 'haiku', effort: 'low' }).then(parseTests)

const reviewFull = (who, lens) => agent(`${COMMON}
You are reviewer ${who} for node ${id} (${n.name}). You did not write this code. Assume it is wrong and prove it.
Owned paths: ${n.owns.join(', ')}. Change since the run started: git diff ${BASE} -- ${n.owns.join(' ')} ; new files: git status --short -- ${n.owns.join(' ')}.
Spec:\n${n.spec}
Lens: ${lens}
Report at most 5 concrete breaks, most important first; each with file, line and a failing input or situation. Severity: high = wrong result or crash in normal use; medium = wrong in a realistic edge case; low = style, wording, unlikely edge. Reject stubs, workaround comments, weakened/skipped/deleted tests, edits outside owned paths. Do not edit files.`,
  { label: `review-${who}:${id}#full`, phase: 'Review', schema: FINDINGS, model: 'sonnet' })

const reviewDiff = (round, items) => agent(`${COMMON}
Verification reviewer for node ${id} (${n.name}). Check ONLY whether these findings are now fixed and whether the fix broke something it touched:
${JSON.stringify(items)}
Look at: git diff ${BASE} -- ${n.owns.join(' ')} (and new files in git status). Do not search the rest of the node for new issues. Report remaining or newly introduced breaks only (max 5), same format and severity scale. Do not edit files.`,
  { label: `verify:${id}#v${round}`, phase: 'Review', schema: FINDINGS, model: 'sonnet' })

const judge = (all) => agent(`You coordinate a judge run for node ${id}. Do not judge yourself unless the external judge fails.
1) Write the text between <<<PROMPT and PROMPT>>> to evidence/tmp/judge3-${id}.md and this JSON schema to evidence/tmp/judge3-schema.json:
${JSON.stringify(strict(JUDGE))}
2) Run: ${JUDGE_CMD} exec --ephemeral -s read-only -m gpt-6.1-sol -C . --output-schema evidence/tmp/judge3-schema.json -o evidence/tmp/judge3-${id}.out.json - < evidence/tmp/judge3-${id}.md
3) Return that JSON unchanged with engine "codex-cli". If the command fails, put its exit code and the last stderr lines in note, judge yourself with the same prompt, engine "fallback-claude".
Never write the command text into any file other than running it.
<<<PROMPT
You are the judge for node ${id} (${n.name}). You check the checkers; you never write code.
Spec:\n${n.spec}
Owned paths: ${n.owns.join(', ')}. Change: git diff ${BASE} -- ${n.owns.join(' ')}. Contract: docs/contract.md. Observed formats: sources/event-sources.md.
Findings from two reviewers: ${JSON.stringify(all.map((f, i) => ({ i, ...f })))}
Drop findings that are not real, have no failing input, or ask for handling of formats not observed in sources/event-sources.md. Add what both missed (high/medium only, max 3) to missed. approved = indexes for the fixer. verdict "accept" if nothing high/medium must be fixed. If the contract itself is wrong, say so in contractIssue (else empty string) instead of upholding or dropping silently.
PROMPT>>>`, { label: `judge:${id}`, phase: 'Judge', schema: JUDGE, model: 'sonnet' })

const fix = (items, tests, tag) => agent(`${COMMON}
You are the fixer for node ${id} (${n.name}). Files you own: ${n.owns.join(', ')}.
Spec:\n${n.spec}
Fix exactly these findings and failing tests; nothing else. Do not weaken, skip or delete tests.
Findings: ${JSON.stringify(items)}
${tests ? `Last test run (${n.test}): exit ${tests.exitCode}, pass ${tests.pass}, fail ${tests.fail}, skipped ${tests.skipped}, todo ${tests.todo}\n${tests.tail}` : ''}
Run node --test test/ before finishing. Return the files you changed.`,
  { label: `fix:${id}#${tag}`, phase: 'Fix', schema: DONE, model: 'sonnet' })

const report = { node: id, rounds: [], low: [] }

phase('Implement')
const impl = await agent(`${COMMON}\nYou implement node ${id} (${n.name}). Files you own: ${n.owns.join(', ')}.\nSpec:\n${n.spec}\nRun node --test test/ and make everything pass honestly. Return the files you wrote or changed.`,
  { label: `implement:${id}`, phase: 'Implement', schema: DONE, model: 'sonnet' })
report.implement = impl ? impl.note : 'implementer returned nothing'

phase('Test')
let tests = await runTests('impl', 'node --test test/')

phase('Review')
const [a, b] = await parallel([
  () => reviewFull('a', 'contract fit: every item of the spec against docs/contract.md §2-§5; Fact provenance (registered/final/inferred/unknown and reasons); status/state mapping with raw; UiEvent seq without gaps; nothing invented.'),
  () => reviewFull('b', 'data and tests: run the model read-only over the real runs of this project (node -e with readRunDir from src/source/claude-fs.mjs and createStore from src/model/reduce.mjs over the run directories under ~/.claude/projects/-Volumes-MacMiniExt-Documents-work-incubator-adversarial-review-loop/*/subagents/workflows/); sample up to 30 data-flow edges from runs wf_9eae66f4-69f and wf_e2c4ea40-b0b and check each by reading both agents: report the false-edge share (contract acceptance: <= 10%); check the new tests are real (no stubs, no weakened assertions) and the suite time. Write nothing to disk except under evidence/tmp/.'),
])
const fa = ((a && a.findings) || []).filter(valid), fb = ((b && b.findings) || []).filter(valid)
const all = [...fa, ...fb]
report.low.push(...all.filter((f) => !serious(f)))
log(`full review: reviewer a ${fa.length} findings, reviewer b ${fb.length}; high/medium ${all.filter(serious).length}`)

phase('Judge')
const j = await judge(all)
const approved = j
  ? [...(j.approved || []).map((i) => all[i]).filter(Boolean).filter(serious), ...((j.missed || []).filter(valid).filter(serious))]
  : all.filter(serious)
report.judge = j ? { engine: j.engine, verdict: j.verdict, approved: approved.length, dropped: (j.dropped || []).length, contractIssue: j.contractIssue, note: j.note } : null
report.rounds.push({ full: true, findings: all.length, approved: approved.length, tests })
if (j && j.contractIssue) log(`judge reports a contract issue: ${j.contractIssue}`)

if (!approved.length && testsOk(tests)) return { ...report, status: 'pass', tests }

phase('Fix')
await fix(approved, testsOk(tests) ? null : tests, 'full')
tests = await runTests('after-fix', 'node --test test/')
let pending = approved.length ? approved : [{ file: 'test/', line: 1, input: 'failing tests', description: 'tests failed', severity: 'high', category: 'tests' }]
for (let v = 1; v <= 2; v++) {
  const r = await reviewDiff(v, pending)
  const found = ((r && r.findings) || []).filter(valid)
  report.low.push(...found.filter((f) => !serious(f)))
  const must = found.filter(serious)
  report.rounds.push({ verify: v, found: found.length, serious: must.length, tests })
  if (!must.length && testsOk(tests)) return { ...report, status: 'pass', tests }
  if (v === 2) break
  await fix(must, testsOk(tests) ? null : tests, `v${v}`)
  tests = await runTests(`v${v + 1}`, 'node --test test/')
  pending = must.length ? must : pending
}
return { ...report, status: 'blocked', tests }
