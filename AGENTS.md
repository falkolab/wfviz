# AGENTS.md — wfviz

Rules for every agent working in this folder: the orchestrating session, Dynamic Workflow
agents, reviewers, judges. Learned rules are added after each accepted result.

## What this project is

`wfviz`: a local, **read-only** visualizer of real Claude Code Dynamic Workflow runs.
`node bin/wfviz.mjs` starts a temporary server on 127.0.0.1 (free port), opens the browser,
shows runs from `~/.claude/projects`, exits on Ctrl+C or when the browser leaves.
Layers: `src/source/` (events from files) → `src/model/` (normalised Run with provenance) →
`src/server/` + `web/` (interface). Demo mode (`--demo`) is separate from real runs.

## Files to read first

0. `README.md` — what wfviz does and how to run it (user-facing).
1. `graph.md` — development graph, node state (§10), learned rules (§9).
2. `progress.md` — current state, open items, next action (the full history is in `docs/progress-history.md`; read it only when a decision's background is needed).
3. `checks.md` — one row per requirement with evidence.
4. `docs/contract.md` — binding contract between layers.
5. `sources/event-sources.md` — observed run file formats (and corrections at the end).
6. `docs/postmortem-dev-management.md` — what went wrong in managing development.
7. `docs/cost-report.md` — measured token use and its causes; `docs/initial-prompt.md` — the starting prompt; `docs/prompt-revisions.md` — proposed edits to it.

`graph.md` is the development graph. The workflows wfviz *observes* (`workflows/adversarial-review-loop.js` = A,
`workflows/research-fanout.js` = B, any user run) are separate things.

## Hard rules

- **wfviz is universal.** It visualizes any Dynamic Workflow run of any user, and knows nothing about
  how this project is developed. Our development method (graph of nodes, gate, reviewers, judge,
  fixer, node guides, `role:unit#tag` labels, `dev-graph-*` scripts, node codes like U2) is one user
  of wfviz, never its assumption. In `src/`, `web/`, `bin/`: no role, phase, label, node code, file
  name or result shape of our method may be required or hard-coded; a run without them must still
  show everything the source gives (timeline, phases, log, fallback matrix). Our runs are test data,
  not the spec. Checked by `test/integration/universal.test.mjs` and by every reviewer of a wfviz node.

- Never invent data. A value the source does not provide stays `unknown` with a reason.
  Inferred values carry `prov: "inferred"` and a `method`. Do not add handling for formats
  not observed in `sources/event-sources.md`.
- Do not use API, hooks or log formats that are not documented or observed. Check first.
- Roles, phases and labels come from run data, never hard-coded.
- The visualizer only observes: no endpoint writes, stops or starts anything.
- Demo data never mixes with real data. If real data is unavailable, stop the dependent work
  and record the blocker; never substitute demo.
- Write only the files your node owns. Two agents never edit the same file at once.
- Never run `git stash`, `git reset` or destructive commands. Workflow agents do not commit;
  the orchestrator commits after every implement/fix step (keeps a baseline).
- No global config changes, no plugin installs, no publishing in this stage.
- ES modules, Node ≥ 20, zero npm dependencies.

## Development method (graph of bounded nodes)

- One node = one input, one output, one check. Deterministic steps (parsing, counting,
  merging, comparing) are code, not model work.
- Each node goes through gates, in this order: tests (deterministic) → reviewer reports →
  judge → model confidence last. Never weaken a gate to pass.
- **Trial first:** run every gate once on one real node before fanning out.
- Loop: implement → two independent reviewers (see only the diff and the contract; must give
  file, line and a failing input; ≤ 5 findings) → code drops findings without evidence →
  judge → fixer → tests. Only **high/medium** findings send work back; **low** go to the report.
  After one full review, verification looks only at the diff, at most 2 rounds; then `blocked`.
- Node guide (from the review method, `sources/author-prompt.md` `<prep>`, kept locally, not published): before implementing, a
  guide agent writes `docs/guides/<node-slug>.md` — the node's rules drawn from the contract, this file
  and `graph.md` §9, plus traps specific to the node. Implementer, reviewers, judge and fixer read it;
  the full review also reports defects in the guide. Shared rules live in `docs/guides/common.md`.
- Repeated error → rule (`<fix_the_process>`): when two approved findings share a category, in one run
  or across runs (the orchestrator passes earlier approved categories in the run args), a guide agent
  adds one rule per such category to `docs/guides/common.md`. The orchestrator copies rules that hold
  beyond one node into the learned rules below.
- Review depth by risk (user, 2026-11-09, after advice from the prompt project): a node file sets
  `risk: 'low' | 'high'` (default high). Low: one reviewer; the judge runs only when there is a
  high/medium finding to settle. High: two reviewers and the judge always. Reviewers return at most
  5 high/medium findings and, separately, at most 2 low ones. A node may add `ui: { scenario }`: a
  ui-check agent walks the scenario in its own background browser tab and reports wrong steps.
  The judge keeps Codex usage records apart from Claude tokens.
  Model trial (user, 2026-11-09): on high-risk nodes reviewer a runs on opus, reviewer b on sonnet;
  compare judge-approved share, unique findings and tokens per reviewer before choosing one model.
  The judge wrapper runs on haiku (it only runs codex).
- The gate lives in code: `workflows/gate/gate-template.js` (tested by `test/workflows/gate-template.test.mjs`).
  Node specs live in `workflows/nodes/<slug>.mjs`. A run script is generated:
  `node tools/make-dev-graph.mjs --n <N> --description "..." <slug> [<slug> ...]`. Never hand-write or
  hand-edit a `dev-graph-*.js` from 6 on; change the template or the node file and regenerate.
- Registry of starting-prompt improvements: `docs/prompt-revisions.md`. Add an entry whenever work
  shows the prompt could have prevented a problem.
- Judge: **codex cli**; the exact command is given by the user when a run starts and is never
  written into project files. If codex fails, the judge agent judges itself and marks
  `engine: "fallback-claude"`. A judge that finds the contract itself wrong escalates it to the
  orchestrator instead of silently upholding or dropping it.
- Test gate accepts only `exit 0`, `fail 0`, `skipped 0`, `todo 0`, `pass > 0`, parsed from the
  real output (`# pass N` or `ℹ pass N`).
- Workflow agent labels follow `role:unit#tag` (tag: `r1`, `v2`, …) so wfviz can build its matrix.
- After every phase update `progress.md`; record graph changes and learned rules in `graph.md`.

## Images and video: analyse in a subagent

Do not open video frames, screenshots or the video itself in the orchestrating session: an image
read there stays in its context and is re-read on every later turn (this cost ~$10–15 in the first
session). Start from text: `sources/video-notes.md` and `sources/video-frames/README.md` (local only, not in the public repository; index by
question + visual spec). If a picture is really needed, give a subagent the exact frame paths and
the question; the image enters only the subagent's context, and the orchestrator receives its text
answer. Same for checking the wfviz UI in the browser: a subagent takes and reads the screenshots and
returns findings as text; the orchestrator saves the screenshot files to `evidence/screens/` by path.

## Learned rules (keep adding)

- Survey all local runs per Claude Code version before freezing a format contract.
  Version of a run = `version` field in its agent transcripts. The desktop app (2.1.317 on
  2026-11-08) is not the terminal CLI (`claude --version` = 2.1.306).
- The first `user` record of an agent transcript can be the relayed user request; the task is
  the `[Workflow harness — computed task]` record.
- Journals can contain `failed` records; final files can report agent state `error` and run
  status `killed`.
- The final run file `workflows/<runId>.json` appears only at the end; `log()` lines are not live.
- A run started from `scriptPath` leaves no copy under `workflows/scripts/`.
- No source registers dependencies; data-flow edges are inferred and need distinctive evidence
  (24 shared chars gave 533 false edges out of 810 on a real run).
- `node --test <dir>` on Node 22+ needs an `index.js` shim in that directory.
- codex cli `--output-schema` is strict: every object needs `additionalProperties: false`.
- Judge-on-disagreement is meaningless when reviewers have different lenses by design.
- Independent nodes run together in one Workflow run; separate runs only for dependent nodes.
- A node blocked only by a shared test outside its paths that asserts the old contract: the orchestrator fixes that test (same assertions) and records it; the node spec should list such tests up front.

- `fixtures/` holds only data wfviz's own tests read (recorded runs, synthetic runs). Inputs of the demo workflows (target-a, target-b) are demo data and live in `demo/targets/`; never mix the two (user, 2026-11-09). They are not product code, but a change that acceptance evidence depends on goes through a node.

- The orchestrator writes no product code (`src/`, `web/`, `bin/`): every product change, however small, is a node through the gate. The orchestrator writes docs, node files, the gate template, tools and test infrastructure only (user, 2026-11-09).

- Before writing a node, grep `test/` for assertions on what the node will change (timer counts, verdict lists, help lines, exact call lines) and put those test files in `owns`; three nodes were blocked by shared tests the spec did not list (H1, R1, P4).
- An implementer can die mid-response (dropped connection, session restart): the gate retries it once, then blocks the node before review. Keep node specs small — a big node (search plus leftovers) lost both implementers twice; split it and tell the implementer to run only its suite while working and `npm test` once at the end.
- Partial work of a failed implementer stays uncommitted in the tree. Give the next run a `base` from before that work, so reviewers see all of it, and say in the spec what is already there.
- When a run ends with the session (no completion record), check the run's journal for how far it got and look for orphaned processes started by its agents (`ps`, cwd under the scratchpad) before relaunching.
- Codex can fail for reasons outside the project (workspace out of credits, 2026-11-12): the judge then runs as `fallback-claude` and says so; tell the user, since the second opinion from another model is lost.
- A test that checks a state in the same tick as an event races the code under load: wait for the state (`waitFor`), with a limit far below any fallback timer the test excludes. Reproduce a flaky test under self-ending CPU load (`node -e` busy loops with a deadline) before and after the fix.
- Text a hook gives the model (`additionalContext`) is written as facts, not commands: the hooks page warns that imperative text can be surfaced to the user instead of used (P4b, user 2026-11-12).
- Prices and other changing outside data are never hard-coded: fetch them from a public source on demand, show source and time, and allow `--offline` (user, 2026-11-11).

## How to resume in a new session

Read the files above in order, run `npm test` (expect all pass, 0 skipped), then take the
"Next action" from `progress.md`. Ask the user for the judge command before any workflow run.
