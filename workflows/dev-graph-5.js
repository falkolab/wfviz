export const meta = {
  name: 'wfviz-dev-graph-5',
  description: 'Workflow 5: node U2 (web: log times and layout, hover activity, edge evidence, round history) through the full gate, in parallel with a live run of test workflow A observed in wfviz',
  phases: [
    { title: 'Implement', detail: 'node U2 of the live UI' },
    { title: 'Test', detail: 'runs the test command; counts parsed in code' },
    { title: 'Review', detail: 'two reviewers, full review once, then diff-only verification (max 2)' },
    { title: 'Judge', detail: 'codex cli, always after the full review' },
    { title: 'Fix', detail: 'only judge-approved high/medium findings and failing tests' },
    { title: 'Live A', detail: 'workflows/adversarial-review-loop.js on a copy of fixtures/target-a, nested in this run' },
  ],
}
// args: { judgeCmd, base: '<git commit the run starts from>', liveA: { targetDir, units } }
// U2 and the live run of A are independent (A writes only under liveA.targetDir), so they run in
// one Workflow run in parallel (graph.md §9). A is nested with workflow(): its agents land in this
// run's journal, so wfviz shows U2 and A's units in one matrix, live.
// Gate as in workflows/dev-graph-4.js (AGENTS.md, graph.md §9).
const JUDGE_CMD = args && args.judgeCmd
const BASE = args && args.base
if (!JUDGE_CMD || !BASE) throw new Error('args.judgeCmd and args.base are required')

const COMMON = `Project: wfviz, a local read-only visualizer of Claude Code Dynamic Workflow runs, in the current directory.
Binding: docs/contract.md (contract 2; the change log with evidence is docs/c-rev-proposal.md). Observed formats: sources/event-sources.md, especially its last section "V0 version survey"; per-version tables: sources/format-survey.md.
Rules: ES modules, Node >= 20, zero npm dependencies, no network. Write ONLY the files you own. Never run git commit, git stash, git reset or any destructive command. No command longer than 2 minutes. Never invent data: a missing value stays missing; do not add handling for formats not observed in sources/event-sources.md.`

const NODES = {
U2: {
  name: 'live-ui-2',
  test: 'node --test test/server/',
  owns: ['web/', 'test/server/web-lib.test.mjs', 'test/server/web-u2.test.mjs'],
  spec: `Web only (web/app.js, web/lib.js, web/index.html, web/style.css), on top of the U1 live UI. The server, model and source are not yours (src/, bin/): read src/model/reduce.mjs for the Run and UiEvent shapes and docs/contract.md §2 and §4; list needed changes outside web/ in your note. Every value shown comes from the Run or a UiEvent; missing ones are shown as unknown with the reason; roles, phases and labels are never hard-coded; every data string is escaped.
Required items (put the logic in pure functions in web/lib.js and test them in test/server/web-lib.test.mjs or a new test/server/web-u2.test.mjs):
1. Log time. A journal line has no timestamp, so the UiEvent ts of a journal event is the journal file time; for a finished run read after the fact that is the run's end (implement:S1 of run wf_f9e4e148-265 shows 21:57:30, it started 21:06:06). In the log, an event of an agent whose Run agent has startedAt (for the agent's start event) or endedAt (for its result/done/failed event) with prov not "unknown" shows that time; otherwise the event ts. The line's tooltip says which: "agent start/end time (<prov>, <method>)" or "event time (may be a file time)".
2. Log order. The backlog is shown sorted by the displayed time (stable; seq breaks ties); live events are appended in arrival order.
3. Log layout. The event log is a pane fixed at the bottom of the viewport (collapsible, at most ~35% of the height, scrolls inside); the page content is never hidden behind it (bottom padding equal to its height). Auto-scroll unless the user scrolled up, as in U1.
4. Log cap note. When the log holds its cap (2000), its header says "showing the last 2000 of N events" (N = highest seq seen).
5. Matrix tags. A cell holding several agents (shown "×2" today) still shows every agent's #tag (e.g. "impl, full"), not only the count.
6. Status card. A long error text (stack trace) in the status/report card shows its first line; the rest is behind a details/summary toggle.
7. Run selector. The run selector shows the whole run name (wider, and a title attribute with the full name and run id).
8. Hover activity. Hovering a matrix cell or a timeline bar shows a small panel with the agent's label, state and its last activity items (tool + inputSummary, newest first, at most 5) from the Run; while hovered it updates when a run snapshot or event for that agent arrives.
9. Edge evidence. Selecting an agent (click) highlights its incoming and outgoing edges in the timeline and lists them in the drawer with kind, prov, method and evidence text exactly as in the Run; edges of other agents are dimmed.
10. Round history. Each matrix row (unit) can be expanded to show its agents in order of start time, grouped by round (Agent.round when known, else by #tag), with role, tag, state and duration; nothing invented (unknown round stays "round unknown").
11. Small fixes: the elapsed-time tooltip names the method the Run gives (not a fixed one); a failed backlog fetch shows a visible line in the log ("backlog not loaded: <error>") and is retried on the next live event; the interrupted-agent tooltip shows the model's note, and when there is none says "interrupted (no note)" rather than a reason-like text.
No timers that re-render on an interval (a one-shot timeout for the 1.5 s highlight is fine). Keep every existing test in test/ green (run node --test test/ once before finishing).`,
  lensA: 'contract fit and UI rules: every shown value comes from the Run/UiEvent (log time from agent startedAt/endedAt only when prov is not unknown, else event ts, tooltip says which); backlog order by displayed time with seq tie-break; cap note uses the highest seq; edge list shows Run fields verbatim; round history never invents a round; no interval timers; every data string escaped (XSS); nothing hard-coded about roles/phases/labels.',
  lensB: 'data and tests: start the server read-only (node bin/wfviz.mjs --no-open --idle 0 --port 0, or the server module on 127.0.0.1 port 0 inside a node -e script) over the real project runs, fetch /api/runs/wf_f9e4e148-265 and its /events?since=0, and run the web/lib.js functions over them in node: the displayed time of implement:S1 start must equal its Run startedAt (21:06:06 local), the order must be non-decreasing in displayed time, the cap note correct for a synthetic 2500-event list; check hover/edge/round-history helpers on real data (wf_9c0b3cb3-2eb has fix and verify rounds); check the new tests are real and the suite time. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
},
}
const id = 'U2'
const n = NODES[id]
const LIVE_A = args && args.liveA
if (!LIVE_A || !LIVE_A.targetDir || !Array.isArray(LIVE_A.units)) throw new Error('args.liveA { targetDir, units } is required')
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
1) Write the text between <<<PROMPT and PROMPT>>> to evidence/tmp/judge5-${id}.md and this JSON schema to evidence/tmp/judge5-schema.json:
${JSON.stringify(strict(JUDGE))}
2) Run: ${JUDGE_CMD} exec --ephemeral -s read-only -m gpt-6.1-sol -C . --output-schema evidence/tmp/judge5-schema.json -o evidence/tmp/judge5-${id}.out.json - < evidence/tmp/judge5-${id}.md
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

async function gate() {
  const report = { node: id, rounds: [], low: [] }

    const impl = await agent(`${COMMON}\nYou implement node ${id} (${n.name}). Files you own: ${n.owns.join(', ')}.\nSpec:\n${n.spec}\nRun node --test test/ and make everything pass honestly. Return the files you wrote or changed.`,
    { label: `implement:${id}`, phase: 'Implement', schema: DONE, model: 'sonnet' })
  report.implement = impl ? impl.note : 'implementer returned nothing'

    let tests = await runTests('impl', 'node --test test/')

    const [a, b] = await parallel([
    () => reviewFull('a', n.lensA),
    () => reviewFull('b', n.lensB),
  ])
  const fa = ((a && a.findings) || []).filter(valid), fb = ((b && b.findings) || []).filter(valid)
  const all = [...fa, ...fb]
  report.low.push(...all.filter((f) => !serious(f)))
  log(`full review: reviewer a ${fa.length} findings, reviewer b ${fb.length}; high/medium ${all.filter(serious).length}`)

    const j = await judge(all)
  const approved = j
    ? [...(j.approved || []).map((i) => all[i]).filter(Boolean).filter(serious), ...((j.missed || []).filter(valid).filter(serious))]
    : all.filter(serious)
  report.judge = j ? { engine: j.engine, verdict: j.verdict, approved: approved.length, dropped: (j.dropped || []).length, contractIssue: j.contractIssue, note: j.note } : null
  report.rounds.push({ full: true, findings: all.length, approved: approved.length, tests })
  if (j && j.contractIssue) log(`judge reports a contract issue: ${j.contractIssue}`)

  if (!approved.length && testsOk(tests)) return { ...report, status: 'pass', tests }

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
}

const liveA = () => workflow({ scriptPath: 'workflows/adversarial-review-loop.js' }, { targetDir: LIVE_A.targetDir, units: LIVE_A.units })
  .catch((e) => ({ status: 'error', error: String(e && e.message || e) }))

const [u2, a] = await parallel([gate, liveA])
return { u2, liveA: a }
