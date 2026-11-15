export const meta = {
  name: 'wfviz-dev-graph-4',
  description: 'Workflow 3 fan-out: one node (S1 source or U1 server+web, args.node) through the gate proven on M1: implement, test, two reviewers, judge (codex cli), fixer, diff-only verification',
  phases: [
    { title: 'Implement', detail: 'one node of contract 2 (args.node)' },
    { title: 'Test', detail: 'runs the node test command; counts parsed in code' },
    { title: 'Review', detail: 'two reviewers, full review once, then diff-only verification (max 2)' },
    { title: 'Judge', detail: 'codex cli, always after the full review' },
    { title: 'Fix', detail: 'only judge-approved high/medium findings and failing tests' },
  ],
}
// args: { node: 'S1' | 'U1', judgeCmd, base: '<git commit the run starts from>' }
// Same gate as workflows/dev-graph-3.js (trial on M1, pass). One node per run keeps each run
// under 10 agents and lets the orchestrator commit between S1 and U1 (U1 depends on S1).
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

const NODES = {
S1: {
  name: 'source-contract-2',
  test: 'node --test test/source/',
  owns: ['src/source/', 'test/source/'],
  spec: `Bring src/source/claude-fs.mjs to contract 2 (docs/contract.md §1 and the createClaudeFsSource signature in §5). Items, each with tests in test/source/:
1. Watching: createClaudeFsSource({ ..., pollMs = 2000, watch = true }). fs.watch(root, { recursive: true }) triggers an immediate poll of the run whose files changed (map the changed path to its run directory; a change outside any run directory triggers a rescan of new runs). Stat polling stays as the fallback at pollMs and is the only mechanism when watch is false, when fs.watch throws, or when the watcher emits 'error' (then close it and keep polling). stop() closes the watcher and every timer. Keep the existing header note about external volumes. Test with a temp root: a new journal line is emitted well before pollMs when watch is true (use a large pollMs in that test), and still emitted with watch false.
2. Full edit input: agent.activity carries input (the full tool_use input object, as is, field names not assumed) only for tools Edit, Write, MultiEdit, NotebookEdit; other tools keep only inputSummary <= 200. An input whose JSON serialisation exceeds 256 KB (262144 bytes) is cut: keep the object shape but cut the longest string fields so the serialisation fits, and set inputTruncated: true. Write was observed both as { file_path, content } and as { path, file_text }: both must pass through unchanged.
3. Script read after the run: when the script is read through the final file's scriptPath and that file's mtime is later than the run's end (final file startedAt/endedAt or startTime + durationMs, whichever the final file carries; if neither, no warning), emit a source.warning { message: "script modified after the run" } with prov.file = the script path, in addition to run.script.
readRunDir must produce the same events as live for the same files. Keep every existing test in test/ green (run node --test test/ once before finishing). If an existing test outside test/source/ depends on the old pollMs default or on truncated Edit inputs, update the minimum and say which in your note. src/model/, src/server/ and web/ are not yours: list needed changes there in your note.`,
  lensA: 'contract fit: §1 RawEvent table and Watching/Script rules, §5 createClaudeFsSource signature and defaults; fallback really engages when fs.watch throws or errors; no leaked watchers or timers after stop(); readRunDir and live emit the same events; truncation keeps shape and sets inputTruncated; nothing invented.',
  lensB: 'data and tests: run readRunDir read-only over the real runs of this project (run directories under ~/.claude/projects/-Volumes-MacMiniExt-Documents-work-incubator-adversarial-review-loop/*/subagents/workflows/) and count agent.activity events carrying input per tool; confirm Edit/Write inputs match the transcript records byte for byte for 5 samples; check the new tests are real (no stubs, no fixed sleeps that only pass by luck, no weakened assertions) and measure the suite time. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
},
U1: {
  name: 'live-ui-contract-2',
  test: 'node --test test/server/',
  owns: ['src/server/', 'test/server/', 'web/', 'bin/wfviz.mjs'],
  spec: `Server and web to contract 2 (docs/contract.md §4) and the live-UI decisions in docs/c-rev-proposal.md §7 and "Not in contract 2". The model (src/model/) already provides store.onEvent(cb) and store.eventsSince(runId, seq) with UiEvent { runId, seq, ts, kind, agentId?, label?, role?, unit?, message, status?, prov }, Agent.tag, and interrupted agents (state Fact with interrupted: true and a note); the source provides full Edit/Write/MultiEdit/NotebookEdit inputs in agent.activity (input, inputTruncated). Read src/model/reduce.mjs to see the exact shapes; do not change src/model/ or src/source/.
Required items:
1. Server: SSE event "event" for every UiEvent from store.onEvent, in order, to every client (in demo mode the same, from the demo store). SSE "run" snapshots: on connect and at most once per second per run (throttle; the last change inside the window is always sent at the window end, never dropped).
2. Server: GET /api/runs/:id/events?since=<seq> returns JSON array store.eventsSince(id, since) (since default 0; bad since -> 400; unknown run -> 404). Read-only: no endpoint writes, stops or starts anything.
3. Server: the transcript endpoint (GET /api/agents/:runId/:agentId/transcript?tail=200) includes the full input and inputTruncated of edit tools.
4. Web: on selecting a run, fetch /api/runs/:id/events?since=0 to fill the log, then apply live "event" messages with seq > last seen (ignore duplicates; on a gap, refetch since the last seen seq). Remove the snapshot-diff feed (diffFeed) and the 2 s setInterval re-render; the timeline re-renders only when data changes (run snapshot or event).
5. Web: bottom event log, one line per event: time · actor (label, else agentId) · message · status; newest at the bottom, auto-scroll unless the user scrolled up; cap 2000 lines.
6. Web: the matrix cell / timeline bar of the event's agent is highlighted briefly (CSS class for ~1.5 s) when its event arrives live (not for backlog).
7. Web: interrupted agents (state Fact interrupted: true) are shown as interrupted, not busy: no growing bar, distinct style, tooltip with the note. Agent.tag is shown next to the unit where the matrix shows the agent.
8. Web: diff panel in the agent drawer: for each edit activity with input, show the file (file_path or path or notebook_path, whichever exists) and old/new text (old_string/new_string, content, file_text, edits[] for MultiEdit, new_source for NotebookEdit; render whatever string fields exist, never assume), marked "truncated" when inputTruncated.
9. Web: report card when the run status is final (completed, failed, killed, or another final string): status, duration, agents by state, tests (from recognize tests), findings and verdict counts from the run's recognised data; every number from the Run, missing ones shown as unknown with the reason, nothing invented.
10. Web: the matrix renders as soon as at least one agent label parses as role:unit (a run starts with one role; today it needs two and shows "Labels in this run do not parse as role:unit", which is false for "implement:S1"). That message appears only when no label parses. While no test counts are recognised in a running run, the tests panel says no test agent has reported yet rather than implying none exist.
Out of scope for this node (later node U2): hover activity, edge evidence highlight, row round history.
Tests in test/server/ for items 1-3 (SSE order, throttle, backlog endpoint, 400/404, transcript input). Web has no test runner: keep web logic small and pure where possible. Keep every existing test in test/ green (run node --test test/ once before finishing). Files outside your owned paths are not yours: list needed changes in your note.`,
  lensA: 'contract fit: §4 HTTP/SSE (event shape and order, run throttle <= 1/s with the trailing change kept, backlog endpoint status codes, read-only), web uses events not snapshot diffs, the 2 s setInterval is gone, interrupted and tag rendered, diff panel assumes no field names, report card shows only Run data (unknown with reason otherwise); nothing invented; roles/phases/labels never hard-coded.',
  lensB: 'data and tests: start the server read-only over a temporary copy of fixtures (or the real project runs) on 127.0.0.1 port 0 inside a node -e script, connect to /api/stream, check that event seq is gapless and ordered, that run snapshots for one run arrive at most once per second while events stream, and that /api/runs/:id/events?since=N returns exactly the events after N; read web/app.js for event handling bugs (duplicate/gap handling, highlight only for live events, log cap, timer leaks, XSS: every data string escaped); check the new tests are real and the suite time. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
},
}
const id = args && args.node
const n = NODES[id]
if (!n) throw new Error('args.node must be S1 or U1')

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
1) Write the text between <<<PROMPT and PROMPT>>> to evidence/tmp/judge4-${id}.md and this JSON schema to evidence/tmp/judge4-schema.json:
${JSON.stringify(strict(JUDGE))}
2) Run: ${JUDGE_CMD} exec --ephemeral -s read-only -m gpt-6.1-sol -C . --output-schema evidence/tmp/judge4-schema.json -o evidence/tmp/judge4-${id}.out.json - < evidence/tmp/judge4-${id}.md
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
  () => reviewFull('a', n.lensA),
  () => reviewFull('b', n.lensB),
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
