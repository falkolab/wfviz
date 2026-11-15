# C-rev — proposed changes to `docs/contract.md` (contract 1 → contract 2)

Status: **approved by the user 2026-11-08, merged into `docs/contract.md` as contract 2.** Kept as the change log with evidence.
Evidence: `sources/event-sources.md` (section "V0 version survey"),
`sources/format-survey.md`, progress.md "Known defects", the user's live-UI decisions of 2026-11-08.

Each item: what changes → why (evidence) → which node implements it.

## 1. Run status and agent state: pass final values through

- `Run.status` values: `running | completed | failed | killed | unknown`. `stopped` is removed
  (never observed). A final-file `status` string not in this list is kept as is with `prov: "final"`,
  never turned into `unknown`.
- `Agent.state` stays normalised (`queued | running | done | failed | unknown`), and the Fact
  gets `raw` with the source value: final `done` → `done`, `error` → `failed`, `progress` →
  `running`. Journal `failed` → `failed` (registered).
- An agent still `running` when the run status is `killed` or `failed` is shown as interrupted
  by the UI; the model does not invent an end time.
- Why: V0 saw run status `killed` (2.1.317) and agent states `error` (2.1.280), `progress`
  (2.1.317); today they show as unknown.
- Node: M1.

## 2. Final file: phase items and missing agents

- `workflowProgress[]` items with `type: "workflow_phase"` are phases, not agents; they carry no
  `state` and must not produce an "unknown state" agent.
- The final file does not list every started agent (2.1.280: 318 started, 278 agent items). The
  journal decides which agents exist; an agent absent from the final file keeps its registered
  values and gets no final values.
- Node: M1.

## 3. Version-aware expectations

- `Run.ccVersion` = the `version` field of agent transcript records (registered); several
  values → all of them, joined.
- Live `label`/`phase` exist only from 2.1.271. Before the final file arrives, older runs get
  `unknown` with reason `not recorded live before 2.1.271`, not a generic reason.
- First user record: unframed before 2.1.271, relay + computed task from 2.1.271 (already
  handled; recorded here as a contract fact).
- Node: M1 (reasons), S1 (no change needed).

## 4. Label pattern: any `#tag` is a pass tag

- `role:unit#tag`: everything after the last `#` is `tag` (new Agent field, `Fact`,
  method `label-pattern`). `round` comes only from `#r<n>` or `round <n>`. `unit` never
  contains the `#…` suffix.
- Why: `#carried`, `#v1` ended up in `unit` (progress.md defects).
- Node: M1.

## 5. Data-flow edges: distinctive evidence only

Current rule (≥ 24 shared normalised chars) gave 533 false edges out of 810 on dev run 1.
Proposed rule — an edge A → B is `data-flow` / strong only when all hold:
1. A ended before B started;
2. B's prompt contains a normalised substring of A's result of **≥ 64 chars**;
3. that substring occurs in the result of **no other** agent that ended before B started
   (unique source);
4. it does not occur in the run's script text, and not in the prompts of **≥ 2 other agents**
   (shared boilerplate: GUIDE text, schemas, the contract).
- `evidence` = first 80 chars of the substring + its length.
- Acceptance check (M1 gate): on dev run 1 and run 2, a sample of 30 edges checked by hand by a
  reviewer; false edges ≤ 10 %. If the rule fails, the threshold is not tuned by the implementer;
  it comes back to the orchestrator.
- Node: M1.

## 6. Full Edit/Write input for a live diff

- `agent.activity` gets `input` (full object) for tools `Edit`, `Write`, `MultiEdit`,
  `NotebookEdit`; other tools keep `inputSummary ≤ 200`. One input above 256 KB is cut to
  256 KB with `inputTruncated: true`.
- Field names are not assumed: V0 saw Edit `file_path, old_string, new_string, replace_all`;
  Write `file_path, content`, and in 2.1.317 also `path, file_text`. The UI renders what is there.
- `Agent.activity` keeps the last 50 items; edit inputs live only in the transcript endpoint
  (`GET /api/agents/:runId/:agentId/transcript`), not in every `run` snapshot.
- Node: S1 (source), M1 (store), U1 (diff panel).

## 7. Event stream instead of snapshot diffing (user decision 2026-11-08)

- SSE gets a new event `event`: one per RawEvent the store applied, in order:
  ```js
  { runId, seq,              // seq: per run, from 1, no gaps
    ts, kind,                // RawEvent kind
    agentId?, label?, role?, unit?,
    message,                 // short line built from data, no invented values
    status?,                 // e.g. done / failed / killed when the event carries one
    prov: "registered" | "final" }
  ```
- `run` snapshots stay, but are sent on connect, on run selection and at most once per second
  per run (now 200 ms) — the UI animates from `event`, not from snapshot differences.
- New endpoint `GET /api/runs/:id/events?since=<seq>` → the backlog (last 2000), so a page opened
  mid-run fills its log without gaps.
- `source.warning` is not sent as `event`.
- Node: M1 (seq, message), S1 —, server change goes with U1 (server owner to be assigned).

## 8. Source: file watching with polling as fallback (user decision 2026-11-08)

- `createClaudeFsSource({ …, watch = true })`: `fs.watch(root, { recursive: true })` triggers an
  immediate poll of the run whose files changed. Stat polling stays as the fallback at
  `pollMs = 2000` (now 500) and takes over when `watch` throws or the root is not watchable.
- The current header note "fs.watch is unreliable on external volumes" is kept: the default
  root `~/.claude/projects` is on the internal disk; a root on an external volume falls back to
  polling only if watching fails, which is detectable.
- Node: S1.

## 9. Tests from `node --test` summaries

- Recognised `tests` also from a string result (or string field ≤ depth 3) carrying a
  `node --test` summary: `ℹ pass N` / `# pass N`, same for `fail`, `skipped`, `todo`.
  `prov: "inferred"`, method `node-test-summary`.
- Why: the tests panel was empty — results carried raw output, not numeric fields.
- Node: M1.

## 10. Script read after the run (low)

- A script read through the final file's `scriptPath` whose mtime is later than the run's end
  gets a warning `script modified after the run` and `declaredPhases` keep `prov: "final"` with
  that note.
- Node: S1.

## Not in contract 2 (decided later, recorded here)

- Auto-open on run start, in this order: `PreToolUse` hook (matcher `Workflow`), resident
  `wfviz --watch`, the desktop app's browser pane. The hook needs the user's approval because it
  changes Claude Code config.
- UI-only items (no contract change): drop the 2 s re-render timer, cell highlight per `event`,
  bottom log `time · actor · message · status`, final report card, hover activity, edge evidence
  highlight, row round history. Node: U1.

## Workflow 3 shape (for the same approval)

- Nodes: M1 (model: items 1–5, 7 model part, 9), S1 (source: 6, 8, 10), U1 (server + web:
  7 server part, UI items). M1 and S1 in parallel; U1 after both.
- Gates as in AGENTS.md; trial of all gates on M1 first, then fan out. Judge: codex cli,
  command from the user at run start.
