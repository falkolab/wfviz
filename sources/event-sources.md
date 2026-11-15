# What Claude Code exposes about a running Dynamic Workflow

Checked 2026-11-08 (macOS). **Correction:** the runs observed today were written by Claude Code **2.1.317** (desktop app; `version` field in agent transcripts). 2.1.306 is the terminal CLI (`claude --version`), which did not run them. Read every "2.1.306" below as 2.1.317. Two kinds of evidence:
**[doc]** — official docs at code.claude.com; **[obs]** — observed on disk in a real run
(probe `wf_6509ce25-20a`, files in `probe-run-1/`) and in an older real run made with 2.1.206.

Official docs say the session transcript format "is internal to Claude Code and changes
between versions" [doc: /docs/en/sessions.md]. No workflow run-log format is documented.
Everything below marked [obs] is therefore an undocumented, version-dependent format: the
adapter must tolerate missing and unknown fields and say which version it saw.

## Files of one run

Root: `~/.claude/projects/<project-slug>/<session-id>/`

| Path | When written | Content | Evidence |
|---|---|---|---|
| `workflows/scripts/<name>-<runId>.js` | at launch | full script incl. `meta` (name, description, declared phases) | [obs] t=0; [doc] "writes the run's script to a file under your session's directory" |
| `subagents/workflows/<runId>/journal.jsonl` | live, appended | `{"type":"launched"}`; `started` {key, agentId, label, phase}; `result` {key, agentId, result, toolsUsed} | [obs] grew at each agent start/finish |
| `subagents/workflows/<runId>/agent-<id>.meta.json` | at agent start | agentType `workflow-subagent`, `description` (= label), `workflowPhase`, `model`, effort model | [obs] |
| `subagents/workflows/<runId>/agent-<id>.jsonl` | live | full agent transcript: prompt (first `user` msg), tool calls, `structured_output` attachment, timestamps, model | [obs] |
| `subagents/workflows/<runId>/agent-<id>.prefix.json` | after first API call | cache/tool hashes — not useful for UI | [obs] |
| `workflows/<runId>.json` | **only at completion** | status, durationMs, `logs[]`, `phases[]`, `workflowProgress[]` (per agent: label, phase, state, attempt, queuedAt/startedAt, tokens, toolCalls, promptPreview, resultPreview), totals, result | [obs] appeared 13.4 s after launch = end of run |
| task output file (`/private/tmp/claude-<uid>/<slug>/<session>/tasks/<taskId>.output`) | seen after completion; liveness **not yet checked** | same JSON as the final run file | [obs] |

## Version differences seen

- 2.1.306 `journal.jsonl` `started` lines carry `label` and `phase`. 2.1.206 lines carried only `key` and `agentId` (no label, no phase, no `launched`).
- 2.1.206 `agent-*.meta.json`: only `agentType`, `spawnDepth`.
- So for older runs live labels/phases are **unknown** until the final run file appears.

## Not available (must be shown as unknown, not invented)

- `log()` messages: only in the final run file / task output — not live. [obs]
- Dependencies between agents: **no source registers them.** No parent/child or data edges in journal, meta, transcript or final file. [obs + doc: nothing found]
- Phase start/end times: not recorded; only derivable from agent times.
- Agent queued-but-not-started: only in the final file (`queuedAt`); live, an agent appears at `started`.
- Workflow status while running (running / paused / stopped): no live status file; "running" is inferred from journal without a final file.

## Dependencies that can be reconstructed (must be marked "inferred")

1. **Data flow** — agent B's prompt contains a distinctive part of agent A's result (in the probe the judge prompt contained both reviewers' JSON verbatim). Strong evidence, deterministic substring check.
2. **Order** — B started after A finished, in a later declared phase. Weak; shown only as a hint.
3. **Script reading** — declared phases order from `meta.phases`. Declared, not an agent-level dependency.

## Other channels (checked, not used as primary)

- Hooks [doc: /docs/en/hooks.md]: `SubagentStart` / `SubagentStop` (agent_id, agent_type, agent_transcript_path), `PreToolUse` matcher `Workflow`. Not documented whether workflow agents fire Subagent* hooks; installing hooks would change config → out of scope for this stage.
- OpenTelemetry [doc: /docs/en/monitoring-usage.md]: `claude_code.subagent_completed`; `workflow.run_id`, `workflow.name` on spans; `agent_id`/`parent_agent_id` need ≥ 2.1.310 (installed 2.1.306). Needs env config → out of scope now; possible later source.
- Agent SDK [doc: /docs/en/agent-sdk/typescript.md]: `SDKTaskNotificationMessage` on completion; no documented per-agent progress events for workflows.
- `claude -p`: workflows run headless with an allow rule; `ultracode` keyword does not work in `-p` [doc: /docs/en/workflows.md, /docs/en/headless.md].

## Probe 2 (`wf_26eb8d70-5c4`, 2.1.306) — edge cases [obs]

- **Task output file**: created empty (0 bytes) at launch. For a completed run (probe 1) it held the final JSON after the end; for this failed run it **stayed empty**. Not a live source.
- **Pipeline overlap is visible live**: `started stage2:gamma` came before `result stage1:alpha` in the journal.
- **Live activity**: the slow agent's transcript grew at each Bash call (3 writes in ~6 s), so tool activity can be shown while the agent runs.
- **Script-level failures are not in the journal**: a pipeline stage that threw and a parallel thunk that threw left no journal line. They appear only in the final file: `logs` (`pipeline[1] failed: …`, `parallel[1] failed: …`), `status: "failed"`, `error` (stack text).
- **Agent `state`** in the final file was `done` for all 6 agents; no per-agent error field appeared (no agent died).
- `result: null` in the final file for a failed run.
- Not observed yet: agent killed by API error, user-skipped agent, resume replay (`attempt` > 1), stopped run.

## Found later by a reviewer, confirmed (2026-11-08) [obs]

- Journals can contain `{"type":"failed","key":…,"agentId":…}` — an agent that failed. Not seen in our probes; confirmed in 2 of 16 real journals on this machine (24 lines). The agent then has no `result` line.
- First `user` record of an agent transcript is not always the task: when a run is launched in a turn, the harness first relays the user's message (`[Workflow harness — user request] …`), and the computed task comes in the next `user` record (`[Workflow harness — computed task] …`), with every line indented. The prompt must be taken from the computed-task record and unframed.
- A run started from `scriptPath` gets no copy under `workflows/scripts/`; the final file's `scriptPath` points to the script.

Conclusion: the primary live source is the session directory (script + journal + meta + transcripts),
with the final run file merged in when it appears. All of it is undocumented and versioned.

## V0 version survey (2026-11-08) [obs]

All 17 local runs, 8 Claude Code versions (2.1.187 … 2.1.317). Generated tables: `sources/format-survey.md`
(`node tools/format-survey.mjs --out sources/format-survey.md`; counts, field names and types only).

| what | 2.1.187–2.1.260 (5 runs) | 2.1.271–2.1.280 (8 runs) | 2.1.317 (4 runs) |
|---|---|---|---|
| journal `launched` | absent | present | present |
| journal `started` | `key, agentId` | `+ label, phase` | `+ label, phase` |
| journal `result` | `key, agentId, result` | same | `+ toolsUsed` |
| journal `failed` | not seen | 2.1.280 only: `key, agentId` (24 lines) | not seen |
| agent meta | `agentType, spawnDepth` | `+ description, workflowPhase, requestShape, requestNonInteractive` | `+ model, pickedEffortModel, isBuiltIn` |
| first `user` record | unframed task (60 of 60) | relayed request, then computed task (332 of 332) | computed task 110 of 110; relayed request before it in 105 |
| transcript record types | `user, assistant, attachment` | same | `+ api-request, api-request-shape, api-request-blob` |
| `prefix.json` files | none | none | 109 |
| final file | 18 fields | same | `+ args, error` |
| final status | `completed` | `completed` | `completed, failed, killed` |
| `workflowProgress[]` | `type` = `workflow_agent` or `workflow_phase`; phase items carry no `state` | `+ promptFramed`; 2.1.280 `+ cached, error`, state `error` 13 | state `progress` 7 (the killed run) |
| script copy under `workflows/scripts/` | 5 of 5 | 6 of 8 | 2 of 4 |

Consequences for the contract (C-rev):
- Live label/phase exist only from 2.1.271; older runs get them from the final file or stay unknown.
- Agent `state` values seen: `done`, `error`, `progress`; run `status`: `completed`, `failed`, `killed`. All pass through as final values.
- `workflowProgress[]` mixes agent and phase items; phase items have no `state` (not an unknown agent state).
- 2.1.280: 318 `started` but 278 `workflow_agent` items in the final files: the final file does not list every started agent (failed attempts). The journal stays the source of agent existence.
- Edit input fields: `file_path, old_string, new_string, replace_all`. Write: `file_path, content`; in 2.1.317 also `path, file_text` (an agent's wrong call, still recorded). Full inputs are in the transcript, so a live diff is possible.
- Tool calls exist in agent transcripts for every version; Edit/Write were seen only in 2.1.275 and 2.1.317 runs.
