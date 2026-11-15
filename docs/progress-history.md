# progress history (until 2026-11-15; the current state is in ../progress.md)

Checkpoint 2026-11-09 evening (N10 acceptance in progress: N10a target-a seeded bug pass, run B evidence in, live run A not started by user decision "later"). On resumption read graph.md (§10 has the node table), this file, checks.md, docs/postmortem-dev-management.md.

**Graph:** done N0–N2 (contract needs revision), N7, I1. Blocked N3 (1 medium), N9 (2 medium). No gate verdict N4, N5, N8 (run 1 stopped). N6 not gated. Not started N10, N11. **V0 done** (code node, orchestrator; not gated by reviewers). **M1 pass** (workflow 3 trial). **S1 pass**, **U1 blocked → accepted by the orchestrator** (workflow 4, 2026-11-08). **C-rev done** (contract 2). Next: U2 ∥ live run of A, then N10 acceptance, then N11.

**Outputs (all committed):**
- `src/source/claude-fs.mjs`, `src/source/script-meta.mjs`, `src/source/demo.mjs`, `src/model/*`, `src/server/*`, `bin/wfviz.mjs`, `web/*`
- `workflows/adversarial-review-loop.js` (A), `workflows/research-fanout.js` (B), `fixtures/target-a/`, `fixtures/target-b/`
- `workflows/dev-graph.js` (run 1), `workflows/dev-graph-2.js` (run 2), `tools/make-fixture.mjs`, `tools/dry-run-workflow.mjs`
- `tools/format-survey.mjs`, `sources/format-survey.md` (V0)
- `workflows/dev-graph-3.js` (workflow 3 trial, M1), run `wf_6e60e86e-2eb` (11 agents, 1.81 M subagent tokens, 78 min)
- `workflows/dev-graph-4.js` (one node per run, args.node): S1 run `wf_f9e4e148-265` (8 agents, 1.06 M subagent tokens, 51 min, pass); U1 run `wf_9c0b3cb3-2eb` (11 agents, 1.46 M, 57 min, blocked on a test outside its paths)
- `test/**` — `npm test` 728 pass, 0 fail, 0 skipped
- `docs/contract.md`, `docs/postmortem-dev-management.md`, `sources/*`, `evidence/open-findings.md`
- Runs: probe 1 `wf_6509ce25-20a`, probe 2 `wf_26eb8d70-5c4`, dev run 1 `wf_9eae66f4-69f` (stopped, 10.5 M tokens), dev run 2 `wf_e2c4ea40-b0b` (3.1 M tokens)

**Decisions:**
- git initialised; commit per phase.
- Judge = codex cli, command passed via workflow args only (no trace in project files; see memory). Opus fallback marked `fallback-claude`.
- Run 1 stopped by user (gate bug: `# pass` vs `ℹ pass`). Run 2 gate: high/medium only, ≤5 findings per reviewer, overlap agreement, diff-only verification ≤2.
- Real runs of other projects are not copied into fixtures (classifier refused; other projects' data). Survey may read them in place, read-only, writing only counts/shapes.
- Versions: today's runs are Claude Code 2.1.317 (desktop app), not 2.1.306 (CLI). Local runs span 2.1.187…2.1.317 (17 runs); survey must be per version.
- User order: finish flow → post-mortem (done) → V0 → C-rev → workflow 3 (approved 2026-11-08).
- Live UI (user, 2026-11-08): server sends events, not whole snapshots; cells highlight per event; bottom event log (`time · actor · message · status`); `fs.watch` on `~/.claude/projects` (internal disk) with stat polling as fallback; drop the 2 s browser re-render timer. Goes into C-rev and S1/U1.
- Auto-open on run start (user, 2026-11-08): all three ways, in this order, later: (1) `PreToolUse` hook with matcher `Workflow` (config change, needs user approval and a check that it fires in 2.1.317); (2) resident `wfviz --watch` that opens a tab on a new run; (3) the desktop app's built-in browser pane for runs started from the orchestrating session.
- Independent nodes run in one Workflow run in parallel (user, 2026-11-08); only dependent nodes go in separate runs.
- `.claude/launch.json` config `wfviz` (port 4317, `--no-open --idle 0`) opens wfviz in the desktop app's browser pane.

**Open after S1/U1 (low, in the report):**
- Contract question (judge, S1): an Edit/MultiEdit input above 256 KB even with every string cut loses `input` entirely, only `inputTruncated: true` stays. Not observed in real data. Proposed contract wording: then `input` is absent and the flag is set — awaiting user approval.
- `data.moreTools[i].input` (edit tool not first in a record) is not in contract §1 and the server's transcript endpoint ignores it; 0 of 10858 local tool_use records had more than one block.
- S1 `runEndMs` also reads `endedAt` / root `startedAt`, never seen at the root of a final file (only `startTime` + `durationMs`).
- `test/integration/grow.test.mjs:86` uses the new default `watch: true` with a stale "rescan only" comment.
- Events backlog of a run read after the fact is in reader order (journal before transcripts), not time order; live order is fine.
- Web: elapsed tooltip names the wrong method; a failed backlog fetch leaves an empty log until a live event; `interruptNote` fallback text looks like a model reason.
- U1 gate ended `blocked` only because `test/integration/stale.test.mjs` (not U1's path) asserted no snapshot on connect; orchestrator changed it to count after the connect snapshot (same assertions) and changed contract §2: the matrix shows from one parsed `role:unit` label.

**Open after M1 (low, in the report):**
- Data-flow: a unique JSON skeleton plus a few content chars can pass all four rules (judge's contract issue); measured 3 false of 77 strong edges (3.9 %), within the 10 % limit. Candidate rule 5 for a later contract: the region must contain ≥ N chars outside JSON keys/punctuation.
- Final status `""` becomes unknown; final `progress` in a run that is not killed/failed becomes unknown, not running.
- M1 touched tests outside its paths (allowed for contract-1 assertions): `test/demo/index.js` threshold `> 50` → `> 20` data-flow edges; `test/integration/*` oracle rewritten for contract 2. Accepted by the orchestrator.

**Known defects fixed in workflow 3:** data-flow rule (3.9 % false), `error`/`killed` pass through, `#tag` out of unit, tests from `node --test` summary, report card, live diff, script mtime guard, event stream instead of the 2 s timer.

**Next-flow candidates (UI, read-only):** U2 = hover live activity, edge evidence highlight, row round history; later: replay scrubber, focus/filter. Not in scope: stop/skip/rerun.

**Outstanding:**
- Prompt revisions proposed in docs/prompt-revisions.md; the user updates the prompt separately.

**Cost so far:** `docs/cost-report.md` — ~300 M cache-read + 11.8 M input + 4.1 M output tokens, ~$143 API-equivalent (estimate), weekly subscription 12 %. Initial prompt saved verbatim: `docs/initial-prompt.md`.

**Saved visual evidence:** `sources/video-frames/` (25 frames + index + visual spec + re-watch steps), `evidence/screens/` (3 wfviz screenshots: run 2 live, probe 1 timeline with edges, run 1 matrix).

**Start prompt for the next session:**
> Continue the development graph in this folder. Read AGENTS.md and the files it lists, run `npm test`, then report the state and propose the next ready node from progress.md. Do not start a workflow before I approve the scope.

**Live-UI stage result (2026-11-09):**
- Nodes: U3 steady UI pass (680b582); D1 demo scenarios pass (e252da5); U4 web polish blocked → accepted (86b3fb2, d36b233; cause: three U3 tests asserting the old behaviour, outside U4's paths, and guide defects; the orchestrator updated the tests to U4's spec).
- Tests: `npm test` 984 pass, 0 fail, 0 skipped, 0 todo; universality test green; no trace of the codex account in project files.
- UI on a replay of `wf_295edfee-cb2` (speed 10, checked by the orchestrator with DOM inspection, 1440×900): REPLAY badge, banner and title; in 20 s of streaming no element removed and re-added with the same content, outside the columns only the log-count text changes (no flicker); page height = viewport, log at 738–894 px of 900; dragging left 240→340, right 300→360, log 156→236 px, stored in localStorage and the same after reload; scrollbars thin, `color-mix(var(--muted), var(--panel))` on a transparent track (the page has one dark theme; light scheme keeps it).
- Live-UI stage closed (user, 2026-11-09): the gate change of 66c8aab (fixer owns its node guide) is checked on the first N10 node, not by re-running matrix cells. npm test on 66c8aab: 991 pass, 0 fail, 0 skipped, 0 todo.
- Rechecked on 19c7ee1 (after U5): replay of `wf_295edfee-cb2` (1165 DOM mutations in 20 s, 0 re-added with the same content; log 738–894 of 900; drags 240→340, 300→360, 156→236 kept after reload; themed thin scrollbars; REPLAY), free labels (7 unparsed, Read 5 / Summarise 1 / Check 1), demo commands (--demo 71 events in 10 s, two replays 37 and 41, unknown id exit 2), npm test 990/0/0/0.
- Free labels: run `wf_d2775a16-2b5` shows "7 labels do not parse as role:unit" and the fallback rows Read 5 / Summarise 1 / Check 1.
- Demo: every command of demo/README.md ran once: --demo, two replays (31 and 35 events), unknown id exit 2, live A (`wf_b37354dd-6c9`), B (`wf_a9452304-f18`, 38 claims), free labels (`wf_d2775a16-2b5`).
- Cost per node (tools/node-cost.mjs; Claude tokens of all agents of the node; Codex judge apart):
  | node | agents | Claude tokens | minutes (agent time) | Codex judge usage |
  |---|---|---|---|---|
  | U3 web-steady | 10 | 1,863,968 | 106.7 | 98,990 tokens total, as codex printed it ("tokens used") at the end of the judge stderr, evidence/tmp/judge-web-steady.stderr.txt; no input/output split (run without --json) |
  | D1 demo-scenarios | 9 | 1,351,394 | 62.4 | 69,669 tokens total, as codex printed it ("tokens used") at the end of evidence/tmp/judge-demo-scenarios.log; no input/output split (run without --json) |
  | U4 web-polish | 15 | 2,317,729 | 135.9 | input 558,400 (cached 476,416), output 1,822 (reasoning 554) |
  | U2 (workflow 5) | 8 | 1,242,733 | 63.1 | 85,392 tokens total, as codex printed it ("tokens used") at the end of evidence/tmp/judge5-U2.log (judge 10:30–10:33); no input/output split (run without --json) |
  | U5 matrix-cells (workflow 9) | 14 | 1,374,020 | 47.5 | input 163,651 (cached 111,104), output 567 (reasoning 76) |
  Live runs: A 1,332,559 (19 agents), B 751,065 (12), free labels 433,009 (7).
- Open low (in the report, not blocking): replay meta/script arrive after the final file (name unknown for ~2 s); empty replay run exits 1 after "listening"; demo header elapsed does not tick (clock only for source real, U4 item 15); picker search sigma case-folding; error box key flip; guide defects in docs/guides/web-polish.md; U3 lows (focus fixed in U4 per spec, verify).

**Stage goal (user, 2026-11-09), DoD:** U3 steady UI (workflow 6), D1 demo scenarios (workflow 7), U4 web polish (workflow 8) pass the gate and are committed (a blocked node: cause analysed and recorded); `npm test` exit 0, fail 0, skipped 0, todo 0, universality test green, no trace of the codex account; on a replay of `wf_295edfee-cb2`: an event rewrites no whole region (DOM mutation count), log visible without page scroll, column widths and log height draggable and remembered after reload, themed scrollbars, REPLAY badge; a `demo-free-labels` run shows the fallback matrix; every command in demo/README.md run once and works; progress.md and graph.md §10 updated, cost per node with Claude and Codex tokens apart. Not in this stage: N10 acceptance (and the target-a seeded bug rework before it).

**Later stage (user, 2026-11-09): wfviz as a Claude Code plugin.** Survey of similar tools: `sources/similar-tools.md`; launch in the reference video: `sources/video-notes.md` (opens by itself as a tab when a workflow starts). Planned nodes, all read-only:
- P1 run history across projects: every run under ~/.claude/projects, not only the last 24 h; filter by project, status, date; persists nothing of its own (reads the files each time).
- P2 live tokens and cost per agent: tokens from transcript usage records (registered), Claude and Codex apart; cost only as an estimate from verified tariffs with their date, marked inferred; unknown when the tariff is not verified.
- P3 full-text search over prompts, results and tool inputs of the runs on screen (local, no index service).
- P4 plugin packaging and auto-open: plugin manifest, `PreToolUse` hook on `Workflow` that starts wfviz if not running, prints one line ("Opening wfviz…") and opens a tab (desktop browser pane or the system browser). Changes Claude Code config: needs the user's approval when it starts.
- Not planned: stop / pause / re-run. No documented way to control a run from outside, the built-in /workflows already does it, and it would break the read-only rule. At most a copyable resume hint as text.

**For the plugin's publication (what only wfviz has, as far as the survey verified):** per-value provenance (registered / final / inferred / unknown with source); inferred data-flow edges; role × unit matrix from labels with a phase fallback; recognised tests, findings and verdicts with a report card; replay of a saved Dynamic Workflow run at a chosen speed; demo kept strictly apart from real data; zero dependencies, no hooks needed to view.

**Gate (from workflow 6):** generated from `workflows/gate/gate-template.js` + `workflows/nodes/<slug>.mjs` by `tools/make-dev-graph.mjs`; node guide, repeat-category rule, risk-based depth, separate low list, optional ui-check, codex usage kept. Orchestrator writes no product code.

**Next action (2026-11-09, after the live-UI stage):** N10 acceptance (CHECKS 1–8 in graph.md §6, evidence in checks.md and evidence/). First, as a node through the gate: rework the seeded bug in `fixtures/target-a` so a standalone run of workflow A (`workflows/adversarial-review-loop.js`) always shows the full cycle finding → judge → fix → second round (the last standalone run `wf_b37354dd-6c9` passed all units in round 1, bugsCaught 0). That node is the first check of gate change 66c8aab (the fixer updates its node guide): record whether it ends pass or blocked and why. Then N11 handoff; then the plugin stage P1–P4. Open: the opus/sonnet reviewer trial on the first high-risk node; the open lows above.

**N10 acceptance, state 2026-11-09 evening:**
- Demo inputs moved: `fixtures/target-a|b` → `demo/targets/target-a|b` (user: demo data apart from wfviz fixtures; rule in AGENTS.md), b48ce34.
- N10a target-a seeded bug **pass** (workflow 10 `wf_702b856a-f75`, 1c04fc5): slugify rule 3, NFD in the starting code, NFKD test removed, example `x\u00b2` → `x2`. Gate change 66c8aab confirmed: fixer updated its guide, verification 0. Cost: Claude 901,373 (9 agents, 34.2 min); Codex input 202,987 (cached 155,520), output 1,669.
- Live run B `wf_1298c060-c7e` (12 agents, 45 s, 745,490 Claude tokens) watched in wfviz: C3, C4, C6, C7 pass; C2 partial (seen live on dev run 10, rounds not yet); evidence in `evidence/n10/`, checks.md (5b29f92). Low: inferred edge shows "method ?" (contract §2 edge has no method field).
- Judge: codex cli; the exact command is given by the user per run and passed in workflow args only.
- wfviz for the user runs in the terminal tab with `--idle 0` (a pane-started server dies with its session).
- Plugin-stage drafts P1–P3: `docs/plugin-stage-draft.md` (not approved; open: default 24 h vs all runs; tariff source).

- Live run A `wf_3e37ce7f-482` (24 agents, 4.8 min, 1,668,767 Claude tokens, haiku): 3/3 units pass, duration in 2 rounds (judge r1 reported a missed bug → fix → round 2 → judge accept), bugsCaught 1, droppedByJudge 5, 28 tests pass. The seeded slugify bug did not survive: the implementer wrote NFKD from TASK.md (risk named by the N10a guide). Lesson: a bug stated in the task text is not missed by a model; a full cycle on a model run is probable, not certain.
- C8 pass (separation tests 124/124, demo banner on every view, no overlap of run ids).
- **N10 result: CHECKS 1–8 all pass** (checks.md). Gaps in C5 for a later node (contract §3 change, needs the user): a judge's `missed` list is not recognised as findings; the TESTS card / run report mixes a guide agent's baseline test runs with test agents and the report shows the last report (10 pass) instead of the run total (28). Lows: edge "method ?", drawer covers the demo banner, `script read` event time is the file mtime, phase tab order changes at the end, only the last 3 log() lines visible.
- Evidence agents: B screenshots 220,612, A screenshots 176,448, C8 115,619 Claude tokens.

- R1 result recognition (workflow 11 `wf_6b384083-f43`): blocked only by two shared tests in test/model/reduce.test.mjs (my spec did not list them) → accepted by the orchestrator after changing them to agent scope; npm test 1033/0/0/0; on run A: run total 28 pass, judge `missed` finding recognised. Cost Claude 1,671,467 (13 agents, 69.1 min), Codex input 827,677 (cached 745,472), output 4,367. Open for the user: the shape rule also lists 'all-clear' notes from arrays like `low` (the producer calls them findings; wfviz cannot judge content) — keep, or narrow.

- Shape rule decision (user, 2026-11-10): keep. On an ordinary run wfviz shows what the run files give; the meaning of a producer's arrays is the producer's. Checked on 32 local runs: no matched item is an 'all-clear' note, every one describes a problem. Better tracking comes only as an optional hint from the plugin hook (P4 `tracking-hints` in `docs/plugin-stage-draft.md`), never a requirement.

- H1 tracking hint (workflow 12 `wf_79e69fee-dc8`): accepted after the orchestrator updated two shared timer-count tests; npm test 1064/0/0/0. Second node in a row blocked by shared tests my spec did not list: before writing a node, grep test/ for assertions on what the node will change (timer counts, verdict lists) and put those files in owns.
- RP1 replay in app: contract §1/§4 approved by the user (25e30db), node `workflows/nodes/replay-in-app.mjs`.

- RP1 replay in app (workflow 13 `wf_254d959d-362`): pass, no block (shared tests were in owns). npm test 1143/0/0/0; checked on run A through a temporary server (228 events, replayed Run equals the real one). Contract §4 extended after the judge's issue: lookup/read failures answer JSON before the stream. Open lows in graph.md §10 (elapsed at the start of a replay; burst on Resume; bare id vs cwd).

- RP2 replay pause pace and hint icon + RT1 run start and replay lookup (workflow 14 `wf_b3a14882-c65`, one run, both pass; user: "not small, do them"). Contract §1/§2 changed before the run (9eb6f0e). Open question for the user (judge contract issue): Pause before any frame arrives delays the whole replay by the paused time.

- RP3 replay pause start (workflow 15 `wf_c9430266-7e5`): pass; the pause-before-frames question settled by the user (2026-11-11: a pause delays only by what it held back).

- Plugin stage run 1 (workflow 16 `wf_223566e3-cd6`): P1 run history and P4 tracking hints, both blocked only by orchestrator items, accepted after: gate template retries a failed implementer once, then blocks (test added); `test/index.js` loads `test/plugin/`. Codex workspace out of credits (2026-11-12): judges ran as fallback-claude. npm test 1265/0/0/0.

- P2 agent tokens (workflow 17 `wf_d1caceb6-c86`): pass; contract §2 gets Agent.byModel, §4 `/api/prices` 404 in demo.

- P3a cost leftovers (workflow 19) and P3 search + P4b hint text (workflow 21): pass. Plugin stage P1–P4 done. npm test 1429/0/0/0 (two runs of four: `test/source/claude-fs-watch.test.mjs` real fs.watch test and `claude-fs-live` "sinceMs still applies…" fail now and then under load average ~11; source untouched by these nodes — flaky, to fix). Codex workspace still out of credits: judges ran as fallback-claude since workflow 16.

**Next action:** N11 handoff (README, AGENTS.md, progress.md; README command from a clean shell); then the flaky watch tests; then open lows (graph.md §10).
