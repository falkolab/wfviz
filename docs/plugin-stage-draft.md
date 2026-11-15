# Plugin stage — P1–P4

Approved by the user 2026-11-11: P1 default 24 h with a switch to all; P2 prices fetched from OpenRouter's public model list, never hard-coded; P4 hint text as in `workflows/nodes/tracking-hints.mjs`; order P1 + P4 (one run), then P2, then P3. Node files: `workflows/nodes/run-history.mjs`, `tracking-hints.mjs`, `agent-tokens.mjs`, `run-search.mjs`.

## Original draft (2026-11-09)

Draft by the orchestrator, 2026-11-09, written while N10 acceptance runs. Nothing here runs before
N10 closes and the user approves the scope. Each item becomes `workflows/nodes/<slug>.mjs` only then.
P4 below covers tracking hints only; plugin packaging and the auto-open hook change Claude Code config
and need the user's approval of the hook first (progress.md, "Auto-open on run start").

Shared constraints (AGENTS.md hard rules): read-only, universal (no role, label, phase or file name
of our method assumed), no invented values (unknown with a reason), no format not observed in
`sources/event-sources.md`, zero dependencies. P1–P3 touch different layers but all touch `web/`,
so they cannot run as parallel nodes in one workflow run unless `web/` is split by file
(owned paths must not overlap; `tools/make-dev-graph.mjs` refuses overlaps).

## P1 run history across projects (`run-history`)

Why: today wfviz lists runs changed within `--since` hours (default 24) under one root. Similar
tools (Conductor, claude-view) show history across projects (`sources/similar-tools.md`).

Spec outline:
1. Every run under `~/.claude/projects/*/…/subagents/workflows/wf_*/` regardless of age, without
   reading each run's transcripts up front: the list is built from journal and final-file stats;
   a run's full model is built only when it is opened.
2. Per run in the list: project (the decoded project directory name as it is on disk; no guessing
   of a "nice" name), start time, status, agent count, workflow name — each a Fact with
   provenance; unknown where the source has none.
3. Filter by project, status, date range; text filter on workflow name. Filter state in the URL
   hash (survives reload), not on disk. wfviz persists nothing of its own.
4. Live: a new run in any project appears without reload (existing watch; check the watcher cost
   on the whole tree — measure the number of watched dirs on this machine first).
5. `--since` keeps working; default becomes "all" only if the list stays under 1 s on this machine
   (measure: number of runs, time to first paint).

Checks: integration test over fixtures with two project dirs; timing on the real tree recorded in
evidence; universality test stays green.
Open question for the user: should the default stay 24 h with a "show all" switch?

## P2 tokens and cost per agent (`agent-tokens`)

Why: the user wants live tokens per agent, Claude and Codex apart.

Facts already observed: `agent.activity` carries `usage?` (contract §1) from assistant records;
the final run file has per-agent `tokens` (event-sources.md). Codex usage is not in any Claude
Code file: it exists only where a workflow agent saved it (our judge's `events.jsonl`), which wfviz
must not assume (universality).

Spec outline:
1. Per agent live: input, output, cache-read, cache-write tokens summed from transcript usage
   records (provenance registered, method "sum of usage records"); after the end, the final file's
   `tokens` shown next to it (final). A mismatch is shown, not hidden.
2. Run totals the same way. Per model where the transcript names the model.
3. Cost: only as an estimate from a tariff table with its source and date, marked inferred;
   a model without a verified tariff → cost unknown with the reason. The tariff table is data in
   one file, never in code paths, and is not fetched from the network.
4. Codex/other engines: not shown unless a documented source exists (none today) — say so in the
   UI as unknown, not zero.

Checks: model tests summing usage on fixtures; equality with the final file on completed fixture
runs (or a recorded difference); no network access (grep test).
Open question: which tariff source and date to trust (the claude-api skill cache vs the pricing
page); the user's subscription makes API prices an equivalent only.

## P3 full-text search (`run-search`)

Why: similar tools offer search over prompts and results.

Spec outline:
1. Search box over the runs on screen: prompts, results, tool inputs summaries, log lines.
2. Server-side scan of the run's already-loaded model (no index service, no files written); case-
   insensitive, Unicode case folding (open low from U4: sigma folding in the picker).
3. Results list: run, agent label, field, a short excerpt with the match highlighted (escaped);
   clicking opens the agent detail at that field.
4. Limits: max results per query, time budget per query; over the limit → "more results not
   shown" with the count unknown if not counted.

Checks: server tests for matching and escaping; a browser scenario (ui-check) on a replay.
Depends on P1 only if search should cover runs not on screen — draft says no.

## P4 tracking recommendations from the hook (`tracking-hints`) — user direction 2026-11-10

Why: on an ordinary run wfviz shows what the run files give and assumes nothing (shape rule, contract §3).
When wfviz is started by a hook, the hook may also give the model a short, optional recommendation on
how to make a workflow easier to track. The user's rule: it must not break the agent working on the
workflow and must read as a recommendation, never a requirement.

Documented hook facts (https://code.claude.com/docs/en/hooks, checked 2026-11-10 through a summarising
fetch; re-read verbatim before the node):
- `hookSpecificOutput.additionalContext` is accepted by SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, SubagentStart and others; it is advisory and does not block or change a call. Blocking or
  changing uses other fields (`permissionDecision`, `updatedInput`, exit code 2): P4 must use none of them.
- PreToolUse context arrives "alongside the tool result", i.e. after the Workflow call: the script is
  already written, so a hint there helps only the next run.
- `Workflow` is a tool name PreToolUse matches (hooks page). Whether SubagentStart fires for agents a
  workflow spawns: not documented — check on a real run before relying on it.

Spec outline:
1. The hint goes in SessionStart or UserPromptSubmit context (before a script is written) and, once per
   session, in the context of the hook that opens wfviz on a Workflow call (for the next run).
2. Text: short, worded as optional ("if convenient"), generic for any workflow: results with arrays named
   `findings` / `issues` whose items carry file, line, severity, description; stable agent labels;
   `log()` lines at phase changes. Nothing of our development method.
3. A workflow that ignores the hint is shown exactly as today; wfviz never checks compliance.
4. Off by a plugin setting; no hint when wfviz is not installed through the plugin.

Checks: hook output contains only `additionalContext` (no permission or input fields) — test on the
hook's JSON; text contains no role, label or file name of this project (grep); a run without the hint
fixtures unchanged.
Depends on: approval of the auto-open hook (config change).

## Order

P1 first (the list is the entry point and the watcher cost must be measured), then P2, then P3.
P2 and P3 could share one run if their `web/` changes are split into separate files.
