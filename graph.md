# graph.md — development graph for `wfviz`

Status: **approved 2026-11-08** (with git init). **Checkpoint 2026-11-08 ~15:00** — see §10 for current node state and graph changes.

This file describes how the *visualizer is built*. It is not the observed workflow:
the workflows that `wfviz` displays (test workflow A and B, and any user run) live in
`workflows/` and are described by their own run data.

## 1. Task and definition of done

Build `wfviz`: a local, read-only visualizer of real Claude Code Dynamic Workflow runs.
One command starts a temporary HTTP server on a free port, opens the browser, shows live
runs from the Claude Code session directories, and shuts down cleanly.

Done = every row of the closure checklist (§6) is `pass` in `checks.md` with evidence
taken from saved files, or is `unresolved` with a recorded blocker.

Principle (user, 2026-11-09): **wfviz is universal.** It visualizes any Dynamic Workflow run of any user, and knows nothing about
how this project is developed. Our development method (graph of nodes, gate, reviewers, judge,
fixer, node guides, `role:unit#tag` labels, `dev-graph-*` scripts, node codes like U2) is one user
of wfviz, never its assumption. In `src/`, `web/`, `bin/`: no role, phase, label, node code, file
name or result shape of our method may be required or hard-coded; a run without them must still
show everything the source gives (timeline, phases, log, fallback matrix). Our runs are test data,
not the spec. Checked by `test/integration/universal.test.mjs` and by every reviewer of a wfviz node.

## 2. Facts the design rests on (see `sources/event-sources.md`)

- Live data: `workflows/scripts/*.js` (at launch), `subagents/workflows/<runId>/journal.jsonl`
  (started/result, live), `agent-<id>.meta.json` (label, phase, model), `agent-<id>.jsonl`
  (transcript, live). Final `workflows/<runId>.json` appears only at the end.
- Format is undocumented and differs between 2.1.206 and 2.1.306.
- No source registers dependencies. `log()` lines are not live.
- Reference look: `sources/video-notes.md`. Reference scenario: `sources/author-prompt.md`.

## 3. Architecture (three separate layers + launcher)

```
bin/wfviz.mjs            launcher: free port, open browser, SIGINT/SIGTERM/idle shutdown
src/source/              event SOURCES → raw events with provenance {file, line, version}
   claude-fs.mjs           watches ~/.claude/projects/**/subagents/workflows/wf_*/ (+ scripts, final file)
   demo.mjs                synthetic events, always tagged source:"demo"; never mixed with real
src/model/               NORMALIZATION: pure reducer raw events → Run model
   reduce.mjs              runs, phases, agents, rounds, results, unknowns
   infer.mjs               reconstructed dependencies (data-flow, order) with method + strength
   recognize.mjs           findings / verdicts / test results recognised from result fields
src/server/              HTTP: static UI, GET /api/runs, GET /api/runs/:id, SSE /api/stream
web/                     INTERFACE: plain HTML/JS/CSS, no build step, no hard-coded roles
```

Node.js ≥ 20 (installed 26), zero npm dependencies. Every model field carries provenance:
`registered` (read from a file), `final` (from the end-of-run file), `inferred` (with method),
or `unknown` (with reason). The UI renders the four differently. The future plugin stage only
wraps `bin/wfviz.mjs` as a command; no layer depends on being a plugin.

## 4. Nodes

`code` = deterministic, implemented in code and checked by tests; `judge` = needs model judgment.

| id | node | input | output | check | kind |
|---|---|---|---|---|---|
| N0 | Research event formats | docs, installed CC, probe run | `sources/event-sources.md`, `sources/probe-run-1/` | every claim tagged [doc]/[obs] | done |
| N1 | Probe 2: edge cases | N0 | `sources/probe-run-2/`, appended section in event-sources.md | watcher timeline shows: task-output liveness, failed agent, skipped/null agent, pipeline overlap, resume replay | code+real run |
| N2 | Contract | N0, N1 | `docs/contract.md`, `fixtures/*.jsonl` (copied real runs, incl. 2.1.206 run) | JSON schemas for raw event and Run model validate all fixtures | code |
| N3 | Source adapter `claude-fs` | N2 | `src/source/claude-fs.mjs`, tests | replaying fixtures emits expected raw events; tail of a growing file emits only new lines; unknown fields kept | code |
| N4 | Normalizer + inference + recognition | N2 | `src/model/*`, tests | golden-file tests per fixture; 2.1.206 fixture yields `unknown` labels until final; inferred edges carry method; no edge without evidence | code |
| N5 | Server + launcher | N2 | `bin/wfviz.mjs`, `src/server/*`, tests | test script: binds port 0, `open` called, SSE delivers an event within 1 s of a file append, SIGINT exits 0 and the port is free | code |
| N6 | Interface | N2 (fixtures), N4, N5 | `web/*` | browser check on fixture replay: run list, phase groups, agent states, parallel lanes, agent detail with prompt/result, findings/verdicts/tests panel, provenance legend; motion from `sources/video-notes.md` (ripple on running agents, row/cell lifecycle, feed push, self-drawing connectors for inferred edges, spotlight on the current phase) fires only on real events; screenshots saved | judge+code |
| N7 | Demo source | N2, N4 | `src/source/demo.mjs`, `--demo` flag | demo only with `--demo`; DEMO banner on every view; real mode code path never imports demo (grep test) | code |
| N8 | Test workflow A — adversarial loop | `sources/author-prompt.md` | `workflows/adversarial-review-loop.js`, `fixtures/target-a/` (tiny JS lib with `node --test` tests and a seeded bug) | script parses; roles and phases come from labels; loop: implement → 2 reviewers ∥ → judge (if disagree or both empty) → fixer → tests → repeat ≤ 3, then `blocked` | judge |
| N9 | Test workflow B — other structure | — | `workflows/research-fanout.js`, `fixtures/target-b/` | different shape: N-way pipeline per item + barrier + synthesis, no judge/fixer, different labels | judge |
| N10 | Live acceptance | N3–N9 | `checks.md`, `evidence/` (screenshots, captured event logs) | CHECKS 1–8 verified while A and B run for real (§6) | judge+code |
| N11 | Handoff | N10 | `README.md`, `AGENTS.md`, `progress.md`, graph template | files exist; README command works from a clean shell | code |

## 5. Edges and parallelism

```
N0 → N1 → N2 ─┬→ N3 ─┐
              ├→ N4 ─┼→ N6 ─┐
              ├→ N5 ─┘      │
              └→ N7         ├→ N10 → N11
N8 ───────────────────────── ┤
N9 ──────────────────────────┘
```

Ready together after N2: N3, N4, N5, N7, N8, N9 (N8 and N9 can start now).
N6 needs N4 and N5. N10 needs everything.

## 6. Closure checklist (from CHECKS) — evidence required

| # | requirement | evidence |
|---|---|---|
| C1 | Connects to a real Dynamic Workflow run | screenshot + captured SSE log showing runId of a live run of A |
| C2 | Phases, agents, states, rounds update during the run | ≥3 timed screenshots of one run; SSE log with ordered started/result events |
| C3 | Parallel work and available dependencies visible | screenshot: two reviewers active at once; inferred edges drawn |
| C4 | Agent detail and results open | screenshot of detail panel: prompt, transcript summary, result JSON |
| C5 | Findings, verdicts, test results for A when the source has them | screenshot of findings/verdicts/tests panel; each value traceable to a journal line |
| C6 | Works with workflow B of another structure | screenshot of B, no code changes between A and B |
| C7 | Unknowns explicit; inferred deps distinct from registered | screenshot of legend + an `unknown` field; unit test asserting provenance tags |
| C8 | Demo separated from real runs | `--demo` screenshot with banner; grep test; real mode shows no demo runs |
| C9 | Command, free port, auto-open, clean shutdown | N5 test output |

## 7. Execution plan

- Code nodes N3, N4, N5, N7 and judge nodes N8, N9 run through a real Dynamic Workflow
  shaped like the author's loop: implementer (Sonnet 5.5) → two independent reviewers
  (Sonnet 5.5, see only the diff + contract) → judge (codex cli, called from a workflow
  agent via Bash; Opus 5.5 if codex cli is unavailable) → fixer → deterministic tests
  run by code. Each node writes only its own directory; no two agents edit the same file.
  That run's own data becomes a third real fixture for the visualizer.
- N1, N2, N6, N10, N11 I do myself (integration and judgment over the whole).
- Test workflows A and B use Haiku 5.5 agents on tiny targets to keep live runs cheap.
- Gates: tests first, then reviewer/judge reports, model confidence last. Results go to `checks.md`.
- Correction: a failed gate returns only that node, with the reason; max 3 attempts per node,
  then `blocked` in progress.md. If real data is unavailable, dependent nodes stop; no demo substitute.

## 8. Permissions and scope

- All writes inside this folder. No global config, no hooks, no plugins, no publishing.
- Workflow runs need the `Workflow` tool (allowed in this session). Live runs for N10 start
  from this session.
- Proposed: `git init` in this folder to keep recoverable versions before merges
  (local only, no remote, no push).

## 9. Learned rules (filled after accepted results)

- Run every gate once on one real node before fanning out (gate parsers and judge schemas broke in run 1).
- Survey all local runs, grouped by Claude Code version, before freezing a format contract.
- Claude Code version of a run = `version` field in its agent transcripts; the desktop app (2.1.317 today) differs from `claude --version` in the terminal (2.1.306).
- Only high/medium findings send work back; low go to the report. After one full review, verify only the diff (≤2 rounds).
- Judge-on-disagreement is meaningless when reviewers have different lenses by design: pick same lens or always-judge.
- A judge that upholds a wrong contract is right; contract defects must be escalated to the orchestrator.
- node --test on Node 22+: a directory argument needs an index.js shim (test/, test/workflows/).
- codex cli `--output-schema` is strict: every object needs `additionalProperties:false`.
- Commit after every implement/fix step to keep a baseline.
- The judge runs codex with `-s read-only`: it cannot run the full suite (EPERM on temp files, no server start). The orchestrator re-runs `npm test` itself after a run; the judge's test claims are not a gate.
- Run independent nodes together in one Workflow run (parallel); only dependent nodes in separate runs.
- A node's gate can block on a test outside its owned paths that asserts the old contract; the fixer cannot touch it. Give the node the shared tests it invalidates, or the orchestrator fixes them right after (U1: `test/integration/stale.test.mjs`).
- Always-judge after the full review worked on the trial (M1): the judge reproduced findings, dropped 5 of 10, added 2 missed, and escalated a contract limitation instead of sending it to the fixer.
- A node whose spec changes behaviour that another node's tests assert must own those test files (list them in `owns`); the guide agent finds them but the fixer cannot touch them otherwise (U4 blocked on three U3 tests, 2026-11-09).
- Workflow agents must stop only the processes they started, by PID (a `pkill -f` in workflow 8 killed the user's wfviz servers).
- Readable labels: node codes (U2, S1) are opaque to the user; workflow labels use a readable unit slug (`implement:web-log-hover`), the code stays in this file (user, 2026-11-09).
- From workflow 6 the gate has the review method's prep and process-fix steps: node guide in `docs/guides/`, repeated approved category → rule in `docs/guides/common.md` (user, 2026-11-09).
- A fix that changes the approach leaves the node guide stale; the fixer does not own docs/guides, so diff-only re-checks keep flagging the guide and the node ends blocked (U5, workflow 9). Gate changed (user, 2026-11-09): the fixer owns its node's guide and brings it in line with the fix; diff-only verification reads the guide (test in test/workflows/gate-template.test.mjs).
- Two modes of tracking (user, 2026-11-10): an ordinary run is shown from what its files give, by generic rules (findings by shape kept, no narrowing); better tracking comes only as an optional hint from the plugin hook (`additionalContext`, advisory), which must not block or change the agent's work.

## 10. Checkpoint — state and graph changes (2026-11-08)

Changes to the graph since approval:
- **I1 integration** added (after N3/N4/N5): integration tests over all fixtures, live growth, bin as a process, real/demo separation. Accepted in run 2.
- Dev run 1 `wf_9eae66f4-69f` stopped by user decision (gate bug made every verdict `blocked`). Run 2 `wf_e2c4ea40-b0b` with revised gate (`workflows/dev-graph-2.js`).
- Judge = codex cli (command passed at run time), Opus fallback marked `fallback-claude`.

| node | state | evidence |
|---|---|---|
| N0, N1, N2 | done; N2 contract needs revision (C-rev below) | `sources/`, `docs/contract.md` |
| N3 source | blocked: 1 medium after 2 verifications | run 2 result; tests green |
| N4 model | no gate verdict (run 1 stopped in round 2); covered by I1 | `test/model/`, `test/integration/` |
| N5 server | no gate verdict (run 1 stopped in round 2); covered by I1 | `test/server/`, `test/integration/` |
| N6 interface | written by orchestrator, not gated; checked live in browser | `web/`, progress.md |
| N7 demo | **pass** (run 2) | journal `wf_e2c4ea40-b0b` |
| N8 workflow A | no gate verdict (run 1 stopped in round 3); tests green | `test/workflows/adversarial.test.mjs` |
| N9 workflow B | blocked: 2 medium (unit-case normalisation) | run 2 result |
| I1 integration | **pass** (run 2), 554 tests | `test/integration/` |
| N10 live A/B | **done 2026-11-09**: CHECKS 1–8 pass (checks.md); live A `wf_3e37ce7f-482` (1,668,767 Claude tokens, 24 agents), B `wf_1298c060-c7e` (745,490, 12); two C5 gaps closed by R1 (run total 28 from the run result; judge `missed` recognised by shape) | `evidence/n10/`, commit add8db8 |
| N11 handoff | **done** (orchestrator, 2026-11-15): `README.md` written (run, options, views, cost, optional tracking, tests, layout); `AGENTS.md` updated (README first, eight learned rules from workflows 12–21); `progress.md` compacted to the current state, history moved to `docs/progress-history.md`. Checked from a clean shell (`env -i`): `--help` prints, `node bin/wfviz.mjs --no-open --idle 0` serves the page (200) and lists 43 real runs, `--demo` lists 1. Graph template deferred until a second project needs it (user agreed) | this commit |
| L1 ui lows (`ui-lows`) | **pass** (workflow 22 `wf_e7b48737-b8f`, risk low, ui-check; first launch blocked by HTTP 403 from the network, resumed; on resume the first implementer dropped (ECONNRESET), the retry finished it): search status line keeps its space (rows no longer move); a run-level search hit closes the tracking hint without storing it, so the notice is usable at 375 px; run cost says "for k of n agents" when some agents have no usage; `agentNeedsPrices` without its Run is false. Review 0 blocking, ui-check 0, judge skipped. Lows: the 375 px geometry is pinned only by a fake-page check (no headless test); "0 of 1 agents" plural; reopening the hint by hand covers the notice. npm test 1441/0/0/0. Cost: Claude 792,319 tokens (6 agents, 78 min) | commit (this step) |
| L2 agents plural (`agents-plural`) | **pass** (workflow 23 `wf_dccaa087-565`, risk low): run cost text says "of 1 agent" / "of 2 agents"; tests pin the whole text. Review 0 blocking. Lows: the matrix unit count cell reads "1 agents" (web/app.js:807) and the model's usage method "1 of 1 agents" (reduce.mjs:863); comment wording. npm test 1443/0/0/0. Cost: Claude 382,581 tokens (4 agents, 14 min) | commit (this step) |
| M1 model (contract 2) | **pass** (workflow 3 trial `wf_6e60e86e-2eb`): judge codex-cli approved 4 of 10 findings, fixed, 2 diff-only verifications, 627 tests | journal `wf_6e60e86e-2eb`; data-flow: 3 false of 77 strong edges on dev runs 1+2 (3.9 %), sample of 30: 1 false |
| S1 source (contract 2) | **pass** (workflow 4 `wf_f9e4e148-265`): judge codex-cli approved 1 of 10, fixed, 1 diff-only verification, 670 tests | journal `wf_f9e4e148-265` |
| U1 server + web (contract 2) | **blocked → accepted by orchestrator** (workflow 4 `wf_9c0b3cb3-2eb`): judge approved 2 of 10; only remaining failure was `test/integration/stale.test.mjs` (outside U1 paths, asserted contract 1); orchestrator fixed the test and contract §2 matrix rule; 728 tests | journal `wf_9c0b3cb3-2eb`, commit f7a88fa |
| U2 web: log, hover, edges, rounds | **pass** (workflow 5 `wf_295edfee-cb2`, nested live A): judge approved 1 high/medium, 1 diff-only verification, 765 tests; cost: Claude 1,242,733 tokens (8 agents), Codex judge 85,392 total (from its log evidence/tmp/judge5-U2.log, no input/output split) | commit aa69ca0 |
| U3 steady UI (`web-steady`) | **pass** (workflow 6 `wf_d0e22fed-88e`, first gate-template run): judge approved 5, fixed, 1 diff-only verification; first repeat-category rule ([stale-state] in docs/guides/common.md); 916 tests; cost: Claude 1,863,968 tokens (10 agents), Codex judge 98,990 total (from its log, no input/output split) | commit 680b582 |
| D1 demo scenarios (`demo-scenarios`) | **pass** (workflow 7 `wf_c5f84b4e-864`): judge approved 1, fixed, verification found 0; 907 tests; cost: Claude 1,351,394 tokens (9 agents), Codex judge 69,669 total (from its log, no input/output split) | commit e252da5 |
| U4 web polish (`web-polish`) | **blocked → accepted by orchestrator** (workflow 8 `wf_5eb8ed36-03f`, risk low + ui-check): ui-check found 2 flicker findings (high, medium), judge approved 4, fixed; blocked only by three U3 tests outside U4's paths asserting the old elapsed/innerHTML behaviour and by guide defects in docs/guides/web-polish.md. Orchestrator updated the three tests to U4's spec and contract §4; 984 tests; cost: Claude 2,317,729 tokens (15 agents), Codex judge input 558,400 (cached 476,416), output 1,822 | commits 86b3fb2, d36b233 |
| U5 matrix cells (`matrix-cells`) | **blocked → accepted by orchestrator** (workflow 9 `wf_02b7af94-436`, risk low + ui-check): one reviewer, ui-check 0 findings; judge approved 2 (a long tag ran under the next cell; the guide recommended the rejected shapes), fixed; two diff-only re-checks found only that docs/guides/matrix-cells.md was not updated (the fixer does not own it). Orchestrator updated the guide to the shipped CSS. Replay of `wf_5eb8ed36-03f` at 1440×900: all 8 cells and the label of the row 102.6 px, `web-polish` one line, no tag split; 990 tests; cost: Claude 1,374,020 tokens (14 agents), Codex judge input 163,651 (cached 111,104), output 567 | commit 19c7ee1 |
| N10a target-a seeded bug (`target-a-seeded-bug`) | **pass** (workflow 10 `wf_702b856a-f75`, risk low, first run with gate change 66c8aab): seed = slugify, TASK.md rule 3 (NFKD): the NFKD test removed from the visible tests, starting code uses NFD, TASK.md example `"x\u00b2"` → `"x2"`; the shortest test-driven fix passes 9/9 visible tests and returns `x`. One reviewer (sonnet): 3 high/medium; judge codex-cli approved 2 (both guide-defect: the guide misdescribed the diff and the escape forms), dropped 1 (hypothetical hint guard). **Gate change check:** the fixer changed only docs/guides/target-a-seeded-bug.md, diff-only verification v1 found 0 → pass; the same situation (findings only about the guide) blocked U5 before the change. Repeat category guide-defect → rule sharpened in docs/guides/common.md. Lows: survival of the seed is unmeasured (only a live run of A shows it); a test assertion accepts the removed `-` line (test/workflows/adversarial.test.mjs:1246, use `^\+`); guide has harmless non-ASCII. 995 tests; cost: Claude 901,373 tokens (9 agents, 34.2 min), Codex judge input 202,987 (cached 155,520), output 1,669 (reasoning 207) | commit (this step) |
| R1 result recognition (`result-recognition`) | **blocked → accepted by orchestrator** (workflow 11 `wf_6b384083-f43`, risk high, reviewers a=opus b=sonnet): Run.result from the final file, recognition with scope agent/run, findings by shape, report card run total only from one run-scope tests item (contract §2/§3 approved by user, c34d4f8). Judge codex-cli approved 2 of 4: (1) two tests in test/model/reduce.test.mjs outside owns asserted the old verdict list (my spec omitted them); (2) contract issue escalated: the shape rule also matches 'all-clear' items in arrays such as `low`/`confirmed` while the spec demanded 0 false positives — measured over 32 runs: shape-only arrays 33 (95 items: low 21/74, missed 11/12, confirmed 1/9). Two diff-only verifications found only the stale test → blocked. Orchestrator changed the two tests to agent scope (same intent); npm test 1033/0/0/0. Check on run A `wf_3e37ce7f-482`: run total 28 pass (final), the judge's missed finding recognised (shape:file+line+severity+description+input), agent findings 9. New common rule [stale-test]. Opus/sonnet trial: each reviewer 2 blocking; judge approved one finding of each (a: stale test; b: false positive). Cost: Claude 1,671,467 tokens (13 agents, 69.1 min), Codex judge input 827,677 (cached 745,472), output 4,367 (reasoning 1,312) | commit (this step) |
| H1 tracking hint (`tracking-hint`) | **blocked → accepted by orchestrator** (workflow 12 `wf_79e69fee-dc8`, risk low, one reviewer + ui-check): corner notice "Better tracking (optional)" with the prompt text and a Copy prompt button, closable, reopened from the header (user, 2026-11-10). Judge codex-cli approved 2 of 4: (1) two shared tests outside owns (web-lib.test.mjs:1056, web-u4.test.mjs:1900) counted 2 setTimeout calls; the spec's 2 s reset of the copy label is a third — my spec again did not list them; (2) guide out of step with the fix (fixed by the fixer). Orchestrator changed both tests to 3 with the reset asserted; npm test 1064/0/0/0. Lows: notice max-height reads the saved log height while the log is collapsed; header button wraps the header 3 px taller below ~1050 px; at 375 px the notice covers header controls. Cost: Claude 1,432,826 tokens (14 agents, 54.9 min); Codex input 933,835 (cached 840,832), output 6,543 (reasoning 4,175) | commit (this step) |
| RP1 replay in app (`replay-in-app`) | **pass** (workflow 13 `wf_254d959d-362`, risk high, reviewers a=opus b=sonnet, ui-check): `GET /api/runs/:id/replay` in the real server with a separate store per replay, Replay / speed / Pause / Resume / Stop on a finished run (user, 2026-11-10; contract §1/§4, 25e30db). Judge codex-cli approved 3 of 7: per-event re-reduce (19.7 s vs 73 ms on 2,138 events) → Run built only when a snapshot goes out; failure reason lost after `hello` → lookup and read before the stream (contract §4 extended: 404/500/503 JSON); stale REPLAY view on Replay again. One diff-only verification: 0 findings. Shared tests were listed in owns up front: no block. npm test 1143/0/0/0. Check on run A through a temporary server: hello → 228 events (seq 1..228) → end; replayed Run equals the real one (24 agents, completed, findings 9, verdicts 4, tests 9); run list stays real only; 404 and 400 as in the contract. Opus/sonnet: a 2 blocking (1 approved, 1 duplicate of b), b 4 blocking (2 approved). Lows: bare run id resolved against cwd before root (fix belongs in replay.mjs); failure while paused drops the buffer; Resume applies the buffer in one burst (as the contract says); one flash class removed 1.4 s after Pause; elapsed reads ~178 min at the start of a replay of a 4m 48s run (run.launched carries the end ts; source/model, outside the node). Cost: Claude 1,753,177 tokens (10 agents, 103.8 min); Codex input 2,011,094 (cached 1,890,048), output 9,662 (reasoning 5,937) | commit (this step) |
| RP2 replay pause pace and hint icon (`replay-pause-pace`) | **pass** (workflow 14 `wf_b3a14882-c65`, risk low, ui-check): Resume plays kept frames with their arrival gaps (one timer at a time), snapshots and `end` at their place in the queue, a failure while frames are kept loses none (reason after the last frame), stale real Run after a never-shown replay fixed, flashes held on Pause; yellow triangle with "!" on the "Tracking hint" button and the notice title (user, 2026-11-10). Judge codex-cli approved 5 (test gaps, guide checks, sign layout at 800 px); verify 0. Judge contract issue: a Pause before any frame arrives (while connecting) still delays the whole replay by the paused time — the contract sentence "behind the stream by the paused time" says so; open question for the user. Lows: `state.replay.real = null` in selectRun can lose "Replay again" on a reconnect race (web/app.js:207); flash test checks end time loosely; the sign sits on the button's top-left corner, not inside before the text (header height unchanged 320–1300 px); a fired flash handle stays in a map. Cost: Claude 1,452,257 tokens (10 agents, 122.5 min); Codex input 1,592,015 (cached 1,469,056), output 8,878 (reasoning 4,543) | commit (this step) |
| RT1 run start and replay lookup (`run-start-and-lookup`) | **pass** (workflow 14 `wf_b3a14882-c65`, risk high): run start = final start, else earliest agent start, else script file time; measured on 34 local runs with a final file: script time within 60 s on 23, earliest agent start on 33. Replay sends run.script / run.launched first; endpoint lookup by id under the root only (`idOnly`), CLI `--replay` unchanged. Judge codex-cli approved 1 of 2: the first snapshot of a replay showed the script-time start and no agents for about 1 s → initial batch notification coalesced. Verify 0. Lows: guide wording of the measurement; duplicate-run error still says "pass one of the run directories" under idOnly; tie order of heads vs contract wording; a listener throwing inside the new microtask is outside the store's try/catch (bin/wfviz.mjs:175, would end the process). Cost: Claude 1,414,159 tokens (10 agents, 93.9 min); Codex input 1,021,226 (cached 911,744), output 7,097 (reasoning 3,789) | commit (this step) |
| RP3 replay pause start (`replay-pause-start`) | **pass** (workflow 15 `wf_c9430266-7e5`, risk low, ui-check): a pause delays the replay only by what it held back (contract §1, user 2026-11-11, af04575): Pause before any frame delays nothing, a frame that arrived during the pause shows at Resume, a waiting frame keeps its remaining wait. Also: a throwing change listener in the launcher is caught and warned (the process stays up); the last real Run is kept on a run reconnect so "Replay again" is not lost; with idOnly the duplicate-run error no longer suggests a run directory. Review a: 0 blocking; ui-check: 0; judge not needed (risk low). npm test 1204/0/0/0. Lows: two comments and one test remark still state the old rule; after a failed never-shown replay, a run the server no longer lists can still offer Replay (a click gives the same 404 line). Cost: Claude 760,210 tokens (5 agents, 52.5 min); Codex none (no judge) | commit (this step) |
| P1 run history (`run-history`) | **blocked → accepted by orchestrator** (workflow 16 `wf_223566e3-cd6`, risk high): every run under the root is listed (journal, final file, script only), runs within `--since` loaded and watched, older ones loaded on first open (`loadRun`, idempotent); picker: last 24 h by default, switch "all", filters project / status / date / name in the URL hash. The implementer died (ECONNRESET); the full review found the tree unchanged (12 findings, judge approved all), the fixer then built the node; two diff-only verifications left two items outside the node's paths: the `--since` help line in `src/server/args.mjs` (moved to P2, which owns args.mjs) and the gate passing a node whose implementer returned nothing (template fixed by the orchestrator: one retry, then blocked; test added). Judge: fallback-claude (Codex workspace out of credits). Measured: 38 runs listed, 3 loaded at start, start 511 ms; loadRun of a 91-agent run 225 ms; store.listRuns 306 ms with every run listed (was 31 ms; the store builds a whole Run per listed run — summary path moved to P2). Lows: replay mode's picker hides its one run under the 24 h default; a loaded running run with no known start is hidden by the 24 h default; guide wording. npm test 1265/0/0/0. Cost: Claude 2,034,561 tokens (16 agents, 154.1 min); Codex none (fallback) | commit (this step) |
| P4 tracking hints (`tracking-hints`) | **blocked → accepted by orchestrator** (workflow 16): plugin under `plugin/` (manifest, SessionStart hook with matcher `startup`, script printing only `hookSpecificOutput.additionalContext`, exit 0 always, option `trackingHint` via userConfig); 24 tests in `test/plugin/`. Blocked only by `test/index.js` not loading `test/plugin/` (outside owns): the orchestrator added it (+24 tests). Judge (fallback-claude) contract issue: the hooks docs say "Write the text as factual statements rather than imperative system instructions" and warn that imperative text can be surfaced to the user instead of used; the approved hint is imperative — rewording proposed to the user. Cost: Claude 1,492,176 tokens (14 agents, 102.4 min); Codex none (fallback) | commit (this step) |
| P2 agent tokens (`agent-tokens`) | **pass** (workflow 17 `wf_d1caceb6-c86`, risk high): Agent.usage / byModel and totals.usage / byModel summed over unique API messages (key `message.id`: 28,650 records, 12,889 ids, 15,761 repeats; output grows within an id, the last record counts); GET /api/prices from OpenRouter's public list (5 s timeout, 1 h cache, one fetch, `--offline`); cost computed in the page, id rule `claude-<family>-<a>[-<b>]` → `anthropic/claude-<family>-<a>[.<b>]` (all 5 local model ids match). `--since` help line fixed; run list cached per run (cold 203 ms, warm 0.1 ms). Judge fallback-claude (Codex out of credits) approved 2 of 4 (thinking-only records not disclosed in the method; agent cost priced by Agent.model → per-agent byModel); verify 0. Contract gap → Agent.byModel added to §2 by the orchestrator. Lows: demo mode fetches real prices for made-up tokens (→ P3: no cost in demo, `/api/prices` 404 in demo); tokens with no model id left out of a cost shown as total (→ P3); dead `.report .cost` CSS; the source skips thinking-only records (26 of 12,889 messages); prices fetch that ignores abort can overlap. npm test 1349/0/0/0. Cost: Claude 1,969,649 tokens (9 agents, 106 min); Codex none (fallback) | commit (this step) |
| P3a cost leftovers (`cost-leftovers`) | **pass** (workflow 19 `wf_79ba62fe-942`, risk low): the three P2 leftovers were already right in the partial tree of workflow 18; the implementer checked them and added 14 tests (demo: `/api/prices` 404 before any fetch, no cost line and no price request for a demo Run; "without N tokens of messages with no model" in cost text and method; `.report .cost .v` applies, 13px/600). Review a: 0 blocking, judge skipped. Lows: a run cost covering only agents with usage does not say "k of n agents"; `agentNeedsPrices(agent)` without the Run fails open. Commit also carries the partial, not yet reviewed search code of workflow 18 (reviewed in P3, base before it). npm test 1365/0/0/0. Cost: Claude 601,047 tokens (4 agents, 27 min) |  commit (this step) |
| P3 run search (`run-search`) | **pass** (workflow 21 `wf_4b4e8664-6ba`, risk low, ui-check; workflows 18 and 20 lost their implementers to dropped connections and the session restart): GET /api/search over loaded runs (name, description, prompts, results, activity, log lines; one result per field; per-code-point folding incl. U+1E9E; limit 50/200; 500 ms budget; `more`), header search box with debounce and abort, highlight as a mark element between text nodes (the spec said DOM ranges; the fake page has no createRange), click opens the run and the agent drawer at the field. Judge fallback-claude (Codex out of credits) approved 3 of 4: "no results" when cut by the time budget; drawer scroll not reapplied after the transcript renders; log / name / description hits did nothing on click → a notice. Verify 1 found 1, verify 2 found 0. Lows: the status line moves the result rows on each keystroke; at 375 px the open tracking hint covers the hit notice; guide wording. Cost: Claude 2,011,466 tokens (14 agents, 112 min) | commit (this step) |
| P4b hint text (`hint-text`) | **pass** (workflow 21, risk low): the plugin hint is now factual statements (user, 2026-11-12), README and tests updated, a test that no line starts with an imperative verb; output shape, matcher, off switch unchanged. Review 0 blocking; fixer rounds only for shared flaky tests. Cost: Claude 1,081,003 tokens (10 agents, 49.6 min) | commit (this step) |
| C-rev contract 2 | **done** (approved by user 2026-11-08) | `docs/contract.md`, `docs/c-rev-proposal.md` |
| V0 version survey | **done** (code; 17 runs, 8 versions) | `sources/format-survey.md`, `tools/format-survey.mjs`, event-sources.md "V0 version survey" |

Planned next nodes (not yet approved):
- **V0 version survey** (code node): all local runs (17, Claude Code 2.1.187…2.1.317), record types, fields, states, statuses per version → `sources/format-survey.md`.
- **C-rev contract revision** (orchestrator): distinctive data-flow rule (533 of 810 edges false on run 1), pass-through of `error`/`killed`, any `#tag` = pass tag, full Edit/Write input for live diff, version-aware expectations.
- **Workflow 3** (done): M1 model per C-rev, S1 source (full edit inputs, script mtime guard), U1 interface (tests from `node --test` summary, final report card, agent diff, hover activity, edge evidence highlight, row history); reviewers: video storyboard and checks 1–8; trial gate run on one node first.
- Stage goal (user, 2026-11-09): live UI ready for acceptance and video — U3, D1, U4 pass and committed; on a replay of `wf_295edfee-cb2` no region rewrite per event, log visible, columns resizable and remembered, themed scrollbars, REPLAY badge; free-labels run shows the fallback matrix; every demo/README command works once; cost per node with Claude and Codex tokens apart.
- After N10: plugin stage P1 run history across projects, P2 live tokens and cost per agent, P3 full-text search, P4 plugin packaging and auto-open hook (details and the publication points in progress.md). Run control (stop/re-run) is out of scope by decision.
- Then N10 acceptance; before it the seeded bug in `fixtures/target-a` must survive implementation so run A shows the whole loop (finding → judge → fix → next round). Then N11.
