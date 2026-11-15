# Similar tools (survey by a subagent, 2026-11-09)

Dates from the GitHub API or fetched pages on 2026-11-09. "Not documented" = no mention found, not proven absence (GitHub code search was rate-limited partway).

| Tool | Link | Data source | Live | Dynamic Workflow awareness | Provenance marks | Replay | Read-only | Install |
|---|---|---|---|---|---|---|---|---|
| **wfviz** | this repo | run files under ~/.claude/projects, fs.watch | yes (SSE, event log) | full: journal, transcripts, meta, final json, script, labels, phases | registered / final / inferred / unknown per value | yes, chosen speed | yes | node bin/wfviz.mjs |
| Workflows Conductor | github.com/michaelandrewgamble/workflows-conductor (commit 2026-08-17, 1.2.7, MIT) | same files + SubagentStart/Stop hook log + MCP server | yes (`live?`/`stalled?` labels) | run table, per-agent tokens/model/duration, transcript tail, phases from meta; cross-project history | only per-file compat tag | no (save + re-run) | no: saves workflows, re-runs, optional Haiku summaries | plugin |
| Built-in /workflows + Desktop Background tasks pane | code.claude.com/docs/en/workflows.md | runtime state | yes | native: phases, agents, tokens, elapsed, agent detail | n/a | resume from cache | no: pause/stop/restart/save | built in |
| claude-view | github.com/tombelieber/claude-view (v0.46.3, 2026-11-02, MIT) | JSONL watcher + SSE + hooks | yes | partly: reads journal.jsonl / workflowProgress; depth unverified | not documented | not documented | no (MCP tools, sharing, analytics on by default) | npx / plugin |
| subagents-plus | github.com/algonormative/subagents-plus (v0.2.3, 2026-10-14, MIT) | in-session mod hooks | yes | workflow run row, agents under meta.phases, phase timeline; no edges | not documented | no | observes only | plugin (mod), CC ≥ 2.1.295 |
| claude-code-log | github.com/daaain/claude-code-log (1.7.0, 2026-10-05, MIT) | JSONL incl. journal.jsonl | after the fact; `serve --watch` live | phases → agents → transcript | not documented | no | writes HTML/Markdown next to transcripts | uvx / pip |
| zoetrope | github.com/furkankly/zoetrope (v0.2.0, 2026-09-10, MIT) | JSONL incl. journal.jsonl | yes | reads the files; interpretation not documented | not documented | yes (sessions) | yes | brew / cargo |
| Langfuse Observability | github.com/langfuse/claude-observability-plugin (1.2.2, 2026-10-26, MIT) | Stop/SessionEnd hooks → Langfuse | per turn | subagents; no workflow handling found | no | Langfuse UI | sends data to an external service | plugin |
| Claude Code OTel + Dash0 | code.claude.com/docs/en/monitoring-usage.md; github.com/dash0hq/dash0-agent-plugin (v0.1.32) | OTel metrics/events (traces beta) | yes | attributes workflow.run_id, workflow.name, agent_id, parent_agent_id (≥ 2.1.310); no phases/labels | no | backend-dependent | export only | env vars / plugin |
| disler multi-agent observability | github.com/disler/claude-code-hooks-multi-agent-observability (push 2026-02-08) | hooks → Bun server, SQLite, Vue | yes | no (predates workflows) | no | no | observes | copy .claude folder |
| agent-timeline | github.com/Cerlancism/agent-timeline (v1.1.0, 2026-11-04, MIT) | ~/.claude/projects and ~/.codex in the browser | yes | not documented | not documented | yes (session replay) | yes | hosted / node server.mjs |

Also seen: claude-hud (status line with subagents), agents-observe (hooks + Docker), claude-code-trace, claude-code-history-viewer, Claude-agent-viewer (leaves workflow agents alone), Anthropic `session-report` plugin (static HTML token report), diolog `workflow-resume` (finds runs that lost agents).

What others have that wfviz lacks: cross-project run history and live per-agent token/cost (Conductor, claude-view); full-text search (claude-view, history viewers); save / re-run / pause / stop (built-in, Conductor; out of wfviz scope: read-only); in-session view (subagents-plus); retention and alerting (Langfuse, OTel); plugin install.

What only wfviz has (as far as verified): per-value provenance with inferred data-flow edges; role × unit matrix from labels with a phase fallback; recognised tests / findings / verdicts with a report card; replay of a saved Dynamic Workflow run at a chosen speed; demo strictly apart from real data.

Unverified: Conductor's presence in the official directory (not in anthropics/claude-plugins-official marketplace.json, push 2026-11-08); depth of claude-view and zoetrope; whether the Desktop pane covers only the current session (Conductor README's claim); /workflows progress view in IDE extensions (issue anthropics/claude-code#72292).
