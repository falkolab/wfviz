export const meta = {
  name: 'wfviz-dev-graph',
  description: 'Build wfviz nodes N3 N4 N5 N7 N8 N9 with an adversarial loop: implement, two blind reviewers, judge, fixer, tests; max 3 rounds per node',
  phases: [
    { title: 'Implement', detail: 'one implementer per node, writes only its own files' },
    { title: 'Review', detail: 'two independent reviewers per node and round' },
    { title: 'Judge', detail: 'codex cli; only when reviewers disagree or both found nothing' },
    { title: 'Fix', detail: 'applies judge-approved findings and test failures' },
    { title: 'Test', detail: 'runs the node test command; counts parsed in code' },
  ],
}
// args: { judgeCmd: string (codex cli invocation, passed at run time, never stored),
//         nodes?: string[] (subset of node ids), maxRounds?: number }
const MAX_ROUNDS = (args && args.maxRounds) || 3
const JUDGE_CMD = args && args.judgeCmd
const COMMON = `Project: wfviz, a local read-only visualizer of Claude Code Dynamic Workflow runs, in the current directory.
Read first: docs/contract.md (the contract between layers, binding), sources/event-sources.md (observed file formats), fixtures/README.md.
Rules: ES modules, Node >= 20, zero npm dependencies, no network. Write ONLY the files you own (listed below). Do not edit package.json, docs/, sources/, tools/, or other nodes' files. Never run git commit, git stash, git reset or any destructive command. No commands that run longer than 2 minutes. Never invent data: a missing value stays missing.`

const NODES = [
  { id: 'N3', name: 'source-claude-fs', test: 'node --test test/source/',
    owns: ['src/source/claude-fs.mjs', 'src/source/script-meta.mjs', 'test/source/'],
    spec: `Implement createClaudeFsSource, readRunDir and parseScriptMeta exactly as in docs/contract.md section 5, emitting RawEvents of section 1.
- Discover runs under root/<slug>/<session>/subagents/workflows/wf_*/ and root/<slug>/<session>/workflows/(wf_*.json|scripts/*-wf_*.js). Polling with fs.stat (fs.watch is unreliable on external volumes).
- Tail files by byte offset; emit only complete new lines; a partial last line waits for its newline. Parse agent-<id>.jsonl into agent.prompt (first user record), agent.activity (assistant tool_use/text), agent.structured.
- Unknown record types or bad JSON -> source.warning, never a crash. Keep unknown fields in data.
- Tests (node:test): replay of every run under fixtures/claude-projects and fixtures/synthetic/legacy-2.1.206 gives the expected count per kind (count journal lines/meta files yourself in the test from the fixture files); growing-file test in a temp dir (append lines in steps, include a partial line); sinceMs filter; optional test that reads process.env.WFVIZ_LEGACY_RUN_DIR read-only and is skipped when unset.` },
  { id: 'N4', name: 'model', test: 'node --test test/model/',
    owns: ['src/model/', 'test/model/'],
    spec: `Implement src/model/reduce.mjs (createStore, reduceRun), infer.mjs, recognize.mjs, labels.mjs per docs/contract.md sections 2, 3, 5.
- Every shown value is a Fact {value, prov: registered|final|inferred|unknown, from|method|reason}.
- Run status: final file -> its status (final); journal without final file -> running (inferred, method no-final-file); no file activity for staleMs -> unknown (reason). Inject now() for determinism.
- Agent state: started -> running; result -> done; final file overrides with prov final. Run failed and agent without result -> unknown with reason.
- logs: unknown while running (reason "log() lines are written only at the end"), final after.
- registeredEdges is always {value: [], prov: "unknown", reason: "no source registers dependencies"}.
- Edges: data-flow (strong) and time-order (weak) exactly as contract section 2; never an edge without evidence text.
- Label pattern role:unit with optional #rN or "round N"; prov inferred, method label-pattern.
- Tests: build RawEvent arrays by hand in the tests, mirroring the real journals in fixtures (probe 1: two reviewers -> judge whose prompt contains both results -> two loop rounds; probe 2: pipeline overlap and failed run with logs; legacy: started without label/phase, labels unknown until final). Assert provenance tags, states, edges, recognised verdicts/findings/tests.` },
  { id: 'N5', name: 'server-launcher', test: 'node --test test/server/',
    owns: ['bin/wfviz.mjs', 'src/server/', 'test/server/'],
    spec: `Implement src/server/server.mjs (createServer) and bin/wfviz.mjs per docs/contract.md sections 4 and 5.
- Server: static files from webDir (path traversal blocked), GET /api/runs, /api/runs/:id, /api/agents/:runId/:agentId/transcript, SSE /api/stream (hello event with mode, then run snapshots debounced 200 ms per run; heartbeat comment every 15 s). Binds 127.0.0.1 only.
- bin: flags --demo, --port (default 0), --no-open, --root, --since <hours>, --idle <seconds> (default 120). Real mode imports src/source/claude-fs.mjs and src/model/reduce.mjs; demo mode imports src/source/demo.mjs via dynamic import() only under --demo, and never the claude-fs source. Prints "wfviz listening on http://127.0.0.1:<port> (real|demo)". Opens the browser (open / xdg-open / cmd start) unless --no-open. Exits 0 on SIGINT/SIGTERM after closing SSE clients and the server; exits after --idle seconds without SSE clients once one has connected.
- Those modules may not exist yet: server tests must inject a fake store; bin tests may stub modules by running bin with an env var WFVIZ_TEST_FAKE=1 that makes bin use an in-file fake store and source.
- Tests: port 0 gives a free port; SSE delivers an event within 1 s after store change; SIGINT -> exit code 0 and port free afterwards; idle shutdown; --no-open respected (spy via env WFVIZ_OPEN_CMD=echo).` },
  { id: 'N7', name: 'demo-source', test: 'node --test test/demo/',
    owns: ['src/source/demo.mjs', 'test/demo/'],
    spec: `Implement createDemoSource per docs/contract.md section 5: a scripted synthetic run that emits RawEvents (section 1) over time: run.script, run.launched, agent.started/meta/prompt/activity/result, run.final; shape: implement -> two reviewers in parallel -> judge -> fixer -> tests, 3 units, one unit blocked after 3 rounds. Every event has src "demo", runId starting "demo-", data.demo = true. speed scales timers; loop restarts with a new runId.
- Tests: all events are demo-tagged; event order is valid (started before result for each agent); stop() stops timers; the file never imports src/source/claude-fs.mjs.` },
  { id: 'N8', name: 'workflow-a-adversarial', test: 'node --test test/workflows/adversarial.test.mjs',
    owns: ['workflows/adversarial-review-loop.js', 'fixtures/target-a/', 'test/workflows/adversarial.test.mjs'],
    spec: `Write test workflow A, a real Dynamic Workflow script (plain JS, starts with a pure-literal export const meta, uses agent/parallel/pipeline/phase/log/args; no Date.now/Math.random), implementing the author's loop from sources/author-prompt.md on a tiny target.
- fixtures/target-a/: package.json-free tiny JS library with 3 units (src/<unit>.mjs), each with a spec in TASK.md, pre-written tests test/<unit>.test.mjs (node --test), and starting code that is incomplete or has a seeded bug, so the loop has work.
- args: { targetDir, units: [names], testCmd: "node --test test/{unit}.test.mjs", model: "haiku", maxRounds: 3 }.
- Flow: Prep phase: guide writer writes GUIDE.md in targetDir, two guide reviewers check it in parallel. Then pipeline over units: implement -> reviewers A and B in parallel (each sees only the diff and GUIDE.md; must give file, line, failing input) -> code drops findings without file:line or input -> judge only if reviewers disagree or both found nothing -> fixer applies approved findings -> test agent runs testCmd and returns exit code and output tail; code parses "# pass N", "# fail N", "# skipped N" -> repeat up to maxRounds, then status blocked. Same finding category twice -> a guide agent adds a rule to GUIDE.md.
- Labels "role:unit#rN" (implement, review-a, review-b, judge, fix, test, guide), phases Prep, Implement, Review, Judge, Fix, Test. Structured outputs (schema) for reviewers {findings:[{file,line,input,description,severity,category}]}, judge {verdict, approved:[index], dropped:[{index,reason}], missed:[finding]}, test agent {exitCode, outputTail}. Return a report {units:[{unit,status,rounds}], bugsCaught, droppedByJudge, rulesAdded, tests}.
- Tests with tools/dry-run-workflow.mjs: happy path; disagreement calls judge; both-empty calls judge; agreement skips judge; finding without file:line is dropped before judge; never-passing unit stops after maxRounds as blocked; labels and phases match meta; meta is a pure literal.` },
  { id: 'N9', name: 'workflow-b-fanout', test: 'node --test test/workflows/research-fanout.test.mjs',
    owns: ['workflows/research-fanout.js', 'fixtures/target-b/', 'test/workflows/research-fanout.test.mjs'],
    spec: `Write test workflow B, a real Dynamic Workflow script with a structure different from workflow A: no loop, no judge, no fixer.
- fixtures/target-b/: 5 short markdown notes about a fictional product, with a few contradictions between them.
- args: { targetDir, files: [names], model: "haiku" }.
- Flow: pipeline over files (no barrier between stages): read:<file> extracts claims {claims:[{text, quote}]} -> check:<file> verifies each claim against the file text {checked:[{text, supported, note}]}; then a barrier; code deduplicates claims across files (normalised text); synthesis agent writes a summary listing contradictions {summary, contradictions:[{a, b}]}; critic agent lists what is missing {gaps:[string]}. Phases Read, Check, Synthesize. log() progress lines.
- Tests with tools/dry-run-workflow.mjs: pipeline stage order per item; one failing item (stage throws) leaves others intact and is logged; dedupe happens in code; labels and phases match meta.` },
]

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
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
// node --test summary: TAP reporter prints "# pass N", the spec reporter (default on a TTY-less
// Node 26 run) prints "ℹ pass N". Accept both.
const parseTests = (t) => ({ exitCode: t ? t.exitCode : null, pass: num(/^(?:#|ℹ) pass (\d+)/m, t && t.outputTail),
  fail: num(/^(?:#|ℹ) fail (\d+)/m, t && t.outputTail), skipped: num(/^(?:#|ℹ) skipped (\d+)/m, t && t.outputTail),
  todo: num(/^(?:#|ℹ) todo (\d+)/m, t && t.outputTail), tail: t ? t.outputTail.slice(-1500) : '' })
const testsOk = (r) => r.exitCode === 0 && r.fail === 0 && r.skipped === 0 && (r.todo === 0 || r.todo === null) && r.pass > 0
const valid = (f) => f && f.file && Number.isFinite(f.line) && f.line > 0 && f.input && f.input.trim()
const key = (f) => `${f.file}:${f.line}`

const runTests = (n, round) => agent(`Run exactly this command in the project root and nothing else: ${n.test}
Return its exit code and the last 3000 characters of combined stdout+stderr as outputTail. Do not fix anything.`,
  { label: `test:${n.id}#r${round}`, phase: 'Test', schema: TEST, model: 'haiku', effort: 'low' }).then(parseTests)

const review = (n, round, who, lens) => agent(`${COMMON}
You are reviewer ${who} for node ${n.id} (${n.name}). You did not write this code. Assume it is wrong and prove it.
Look only at these paths: ${n.owns.join(', ')} (plus docs/contract.md and fixtures for reference). See the change with: git status --short -- ${n.owns.join(' ')} and git diff -- ${n.owns.join(' ')} (new files: read them).
Node spec:\n${n.spec}
Lens: ${lens}.
Report concrete breaks only. Each finding needs file, line, and a concrete input or situation that fails. Reject: stubs or skipped logic, workaround comments instead of fixes, weakened/skipped/deleted tests, edits outside the owned paths, contract violations. Do not edit any file. Empty list if you cannot break it.`,
  { label: `review-${who}:${n.id}#r${round}`, phase: 'Review', schema: FINDINGS, model: 'sonnet' })

const judge = (n, round, all, why) => agent(`You coordinate a judge run for node ${n.id}. Do not judge yourself unless the external judge fails.
1) Write the text between <<<PROMPT and PROMPT>>> to evidence/tmp/judge-${n.id}-r${round}.md and this JSON schema to evidence/tmp/judge-schema.json:
${JSON.stringify(strict(JUDGE))}
2) Run: ${JUDGE_CMD} exec --ephemeral -s read-only -m gpt-6.1-sol -C . --output-schema evidence/tmp/judge-schema.json -o evidence/tmp/judge-${n.id}-r${round}.out.json - < evidence/tmp/judge-${n.id}-r${round}.md
3) Return the JSON from the .out.json file unchanged, with engine "codex-cli". If the command fails or times out, judge yourself with the same prompt and set engine "fallback-claude" and say why in note.
<<<PROMPT
You are the judge for node ${n.id} (${n.name}) of a code project in the current directory. You check the checkers; you never write code.
Why you were called: ${why}.
Spec:\n${n.spec}
Owned paths: ${n.owns.join(', ')}. Contract: docs/contract.md.
Findings (index: finding): ${JSON.stringify(all.map((f, i) => ({ i, ...f })))}
Drop findings that are not real or have no failing input. Look for what both reviewers missed (stubs, weakened tests, out-of-scope edits, contract violations) and put them in missed with file, line, input. approved = indexes to send to the fixer. verdict "accept" only if nothing must be fixed.
PROMPT>>>`, { label: `judge:${n.id}#r${round}`, phase: 'Judge', schema: JUDGE, model: 'opus' })

const fix = (n, round, items, tests) => agent(`${COMMON}
You are the fixer for node ${n.id} (${n.name}). Files you own: ${n.owns.join(', ')}.
Spec:\n${n.spec}
Fix exactly these approved findings and the failing tests; nothing else. Do not weaken, skip or delete tests.
Findings: ${JSON.stringify(items)}
Last test run (${n.test}): exit ${tests.exitCode}, pass ${tests.pass}, fail ${tests.fail}, skipped ${tests.skipped}\n${tests.tail}
Run ${n.test} yourself before finishing. Return the files you changed.`,
  { label: `fix:${n.id}#r${round}`, phase: 'Fix', schema: DONE, model: 'sonnet' })

const selected = NODES.filter((n) => !(args && args.nodes) || args.nodes.includes(n.id))
log(`nodes: ${selected.map((n) => n.id).join(', ')}; max rounds ${MAX_ROUNDS}; judge ${JUDGE_CMD ? 'codex cli' : 'MISSING'}`)
if (!JUDGE_CMD) throw new Error('args.judgeCmd is required')

const results = await pipeline(selected,
  (n) => agent(`${COMMON}
You implement node ${n.id} (${n.name}). Files you own: ${n.owns.join(', ')}.
Spec:\n${n.spec}
Write the code and its tests, run ${n.test}, and make them pass honestly. Return the files you wrote.`,
    { label: `implement:${n.id}#r1`, phase: 'Implement', schema: DONE, model: 'sonnet' }),
  async (impl, n) => {
    const history = []
    let tests = await runTests(n, 1)
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const [a, b] = await parallel([
        () => review(n, round, 'a', 'correctness against the spec and contract; edge cases'),
        () => review(n, round, 'b', 'robustness: bad input, partial files, timing, resource cleanup; test honesty'),
      ])
      const fa = ((a && a.findings) || []).filter(valid), fb = ((b && b.findings) || []).filter(valid)
      const droppedNoEvidence = ((a && a.findings) || []).length + ((b && b.findings) || []).length - fa.length - fb.length
      const all = [...fa, ...fb]
      const ka = new Set(fa.map(key)), kb = new Set(fb.map(key))
      const agree = fa.length > 0 && ka.size === kb.size && [...ka].every((k) => kb.has(k))
      let approved = agree ? fa : [], judged = null
      if (!agree) {
        const why = all.length === 0 ? 'both reviewers found nothing' : 'reviewers disagree'
        judged = await judge(n, round, all, why)
        approved = judged ? [...(judged.approved || []).map((i) => all[i]).filter(Boolean), ...((judged.missed || []).filter(valid))] : all
      }
      history.push({ round, reviewA: fa.length, reviewB: fb.length, droppedNoEvidence, judge: judged ? { engine: judged.engine, verdict: judged.verdict, dropped: (judged.dropped || []).length, missed: (judged.missed || []).length } : 'skipped (agreement)', approved: approved.length, testsBefore: tests })
      if (approved.length === 0 && testsOk(tests)) { log(`${n.id}: accepted in round ${round}`); return { node: n.id, status: 'pass', rounds: round, tests, history } }
      if (round === MAX_ROUNDS) break
      await fix(n, round, approved, tests)
      tests = await runTests(n, round + 1)
    }
    log(`${n.id}: blocked after ${MAX_ROUNDS} rounds`)
    return { node: n.id, status: 'blocked', rounds: MAX_ROUNDS, tests, history }
  })

return { nodes: results.map((r, i) => r || { node: selected[i].id, status: 'error', note: 'pipeline item failed; see logs' }) }
