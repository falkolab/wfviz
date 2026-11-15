# Contract between layers

Three layers talk only through the two shapes below. Version: `contract 2` (2026-11-08; changes
from contract 1 and their evidence: `docs/c-rev-proposal.md`, approved by the user).

```
source (src/source/*)  --RawEvent-->  model (src/model/*)  --Run-->  server  --JSON/SSE-->  web/
```

**wfviz is universal.** It visualizes any Dynamic Workflow run of any user, and knows nothing about
how this project is developed. Our development method (graph of nodes, gate, reviewers, judge,
fixer, node guides, `role:unit#tag` labels, `dev-graph-*` scripts, node codes like U2) is one user
of wfviz, never its assumption. In `src/`, `web/`, `bin/`: no role, phase, label, node code, file
name or result shape of our method may be required or hard-coded; a run without them must still
show everything the source gives (timeline, phases, log, fallback matrix). Our runs are test data,
not the spec. Checked by `test/integration/universal.test.mjs` and by every reviewer of a wfviz node.

Ground truth for formats: `sources/event-sources.md`. Fixtures: `fixtures/claude-projects/<slug>/<session>/subagents/workflows/<runId>/` are
copies of real run directories (see `fixtures/README.md`).

## 1. RawEvent (emitted by a source)

```js
{
  src: "claude-fs" | "demo" | "replay", // which source; demo events never come from claude-fs
  kind: "<see table>",
  runId: "wf_…",
  sessionId: "<uuid>" | null,
  project: "<project slug>" | null,
  ts: 1794126711299,              // ms; record timestamp if the record has one, else file mtime
  prov: { file: "<abs path>", line: 3 | null },
  data: { … }                     // kind-specific, raw values, unknown fields kept as-is
}
```

| kind | from | data |
|---|---|---|
| `run.script` | `workflows/scripts/<name>-<runId>.js` | `{ scriptPath, text, meta: {name, description, phases:[{title, detail?}]} \| null }` — `meta` parsed from the literal; `null` if parsing failed |
| `run.launched` | journal `{"type":"launched"}` | `{}` |
| `agent.started` | journal `started` | `{ agentId, key, label?, phase? }` (label/phase absent on old versions) |
| `agent.meta` | `agent-<id>.meta.json` | the parsed object as-is (`agentType`, `description`, `workflowPhase`, `model`, …) |
| `agent.prompt` | the `[Workflow harness — computed task]` user record of `agent-<id>.jsonl` (else the first user record) | `{ agentId, text, framed: bool }` — text with the harness frame line removed and the indentation stripped |
| `agent.activity` | each `assistant` record with `tool_use` or `text` | `{ agentId, tool?: name, inputSummary?: string ≤200, input?: object, inputTruncated?: true, text?: string ≤500, model?, usage? }` — `input` (full) only for `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; an input above 256 KB is cut to 256 KB with `inputTruncated: true`; field names are not assumed (Write seen with `file_path, content` and with `path, file_text`) |
| `agent.structured` | `attachment.type == "structured_output"` | `{ agentId, data }` |
| `agent.failed` | journal `failed` | `{ agentId, key }` |
| `agent.result` | journal `result` | `{ agentId, key, result, toolsUsed? }` |
| `run.final` | `workflows/<runId>.json` | the parsed object as-is |
| `source.warning` | any | `{ message }` — unreadable line, unknown record type, etc. |

Rules: a source never invents values; a missing field stays missing. Tail reading: only new
complete lines of a growing file are emitted; a partial last line waits.

Watching: the source watches `root` with `fs.watch(root, { recursive: true })` and polls the
run whose files changed at once. Stat polling (`pollMs`, default 2000) stays as the fallback and
takes over when watching throws or the root cannot be watched.

Script read after the run: a script read through the final file's `scriptPath` whose mtime is
later than the run's end yields a `source.warning` `script modified after the run`.


### Replay (user decision 2026-11-09: demo scenarios for showing and recording)

`wfviz --replay <run directory | runId> [--speed <n>]` replays one saved **real** run: the replay
source reads it with `readRunDir` and emits the same RawEvents with `src: "replay"`, every value
unchanged (ts included, so shown times are the run's own). Only the emission schedule is computed:
events are emitted in order of a schedule key = the event ts, except that a journal `agent.started`
/ `agent.result` (whose ts is only a file time) is keyed by that agent's first / last transcript
record ts when known, and `run.script` / `run.launched` (file times too: a script file can be saved
hours before the run, the journal's time is its last write) are keyed by the smallest key of the
run's other events, so a replay begins with them (user decision 2026-11-10); ties keep reader order. The delay between two emissions is
`(key₂ − key₁) / speed`, capped at 2000 ms (default speed 4, `--speed` 0.25..100). The Run gets
`source: "replay"`; the server runs in mode `replay`, `hello` carries it, and the UI shows a REPLAY
banner (never REAL, never DEMO). Replay never mixes with real or demo events; at the end the run
stays as read (its final file included). A run id is looked up under `--root`. The replay endpoint
(§4) looks its run id up under the root only, never as a path relative to the process directory.

Replay inside the real server (user decision 2026-11-10): a server in mode `real` can also replay one
finished run of its own list on request, through `GET /api/runs/:id/replay` (§4). The replay uses the
same source and schedule as `--replay` and a **separate** store of its own: its events and its Run
(`source: "replay"`) never enter the server's real store, its run list or `/api/stream`. Only a run whose
status is final (not running) can be replayed; the replay ends when its events are emitted or when the
client closes the stream, and closing stops its timers. Pause is the client's: it stops applying the
stream's frames (`run`, `event`, `end`) and keeps them, in order. Resume plays the kept frames with the
gaps they arrived with, never in one burst, and frames that arrive meanwhile queue behind the kept ones
(user decision 2026-11-10). The view falls behind the stream only by what the pause held back (user
decision 2026-11-11): a frame that was waiting when Pause was pressed keeps the wait it had left; when
nothing was waiting at Pause, the first frame that arrived during the pause is shown at Resume (or at
its own time, if that is later), so a pause during which no frame arrived delays nothing. A stream
that fails or closes while frames are kept loses none of them: they are played (or stay kept while
paused), and the failure line is shown after the last of them. The UI marks the replayed view REPLAY; the real view is unchanged.

## 2. Run (produced by the model, served to the UI)

Every value the UI shows is a **Fact**:

```js
{ value: any, prov: "registered" | "final" | "inferred" | "unknown",
  from?: "<file>:<line>",        // registered/final
  method?: "<how inferred>",     // inferred
  reason?: "<why unknown>" }     // unknown
```

- `registered` — read during the run from journal/meta/transcript/script.
- `final` — read from the end-of-run file `workflows/<runId>.json`.
- `inferred` — computed; `method` says how (e.g. `label-prefix`, `data-flow`, `time-order`, `no-final-file`).
- `unknown` — the source does not provide it; `reason` says why.

```js
Run {
  id, source: "real" | "demo" | "replay", sessionId, project,
  ccVersion: Fact,              // `version` of agent transcript records (registered); several → joined with " + "
  name: Fact, description: Fact,
  status: Fact,                 // running | completed | failed | killed | unknown; any other final string kept as is (prov final)
  startedAt: Fact, endedAt: Fact, durationMs: Fact,
                                // run startedAt: the final file's start; without it the earliest agent start (inferred);
                                // only when no agent has a start, the script file time (inferred; it can be hours
                                // before the run: measured 15:22 vs 18:16 on wf_3e37ce7f-482); else unknown
  declaredPhases: [{ title, detail? }],        // from meta (registered) or final
  phases: [{ title, index, agentIds: [], startedAt, endedAt, state }],   // state inferred from agents
  agents: { [agentId]: Agent },
  order: [agentId…],            // by start time
  edges: [{ from, to, kind: "data-flow" | "time-order", strength: "strong" | "weak",
            evidence: "<short text>", prov: "inferred" }],
  registeredEdges: { value: [], prov: "unknown", reason: "no source registers dependencies" },
  logs: Fact,                   // final only; unknown while running
  result: Fact,                 // final file's top-level "result" (prov final, from); unknown with reason while running, or when null/absent (say which) — R1, user 2026-11-09
  recognized: { findings: [], verdicts: [], tests: [] },   // see §3
  totals: { agents, running, done, failed, tokens: Fact, toolCalls: Fact,
            usage: Fact,        // P2: sum of the agents' usage values (same four keys); unknown if no agent has one
            byModel: Fact },    // P2: { [model id as the transcript gives it]: usage } (inferred, method "sum by transcript model")
  unknowns: [{ field, reason }],
  warnings: [string]
}

Agent {
  id, label: Fact, phase: Fact, agentType: Fact, model: Fact,
  role: Fact,  unit: Fact,  round: Fact,  tag: Fact,   // inferred from label, method "label-pattern"
  state: Fact,                 // queued | running | done | failed | unknown; Fact.raw = source value
  startedAt: Fact, endedAt: Fact, durationMs: Fact,
  prompt: Fact, result: Fact,  lastActivity: Fact, toolCalls: Fact, tokens: Fact,
  usage: Fact,                 // P2 (user 2026-11-11): { input, output, cacheRead, cacheWrite } summed over the agent's
                               // transcript usage records, one per API message (a message repeated in several records
                               // counts once); method names the dedup key; unknown with reason when no record has usage.
                               // Cost is never in the Run: it is computed in the UI from usage and §4 prices.
  byModel: Fact,               // P2 (judge's contract gap, workflow 17): the agent's usage split by the model of each
                               // counted message, as totals.byModel; the cost of an agent is priced from this split.
                               // Tokens of a message with no model id are in usage, not in byModel: a cost shown as a
                               // total must then say what it leaves out, or be unknown.
  activity: [{ ts, tool?, inputSummary?, text? }]   // last 50; full edit inputs only via the transcript endpoint
}
```

Fact may carry `raw` (the source value before normalisation).

### Status, state and the final file

- Agent state from the final file: `done` → `done`, `error` → `failed`, `progress` → `running`,
  with `raw` set. Journal `failed` → `failed` (registered).
- An agent still `running` when the run status is `killed` or `failed` is interrupted; the model
  does not invent an end time, the UI shows it as interrupted.
- `workflowProgress[]` items with `type: "workflow_phase"` are phases, not agents; they carry no
  `state`.
- The journal decides which agents exist. The final file does not list every started agent
  (2.1.280: 318 started, 278 listed); an agent absent from it keeps its registered values.

### Version-aware reasons

- Live `label`/`phase` exist only from Claude Code 2.1.271. Before the final file arrives, older
  runs get `unknown` with reason `not recorded live before 2.1.271`.
- First user record: unframed before 2.1.271; relayed request then computed task from 2.1.271.

### Label pattern (inferred, never required)

`role:unit#tag`. Everything after the last `#` is `tag` (any text: `r2`, `v1`, `carried`); `unit`
never contains it. `round` comes only from `#r<n>` or `round <n>`. Examples: `reviewer:A` → role
`reviewer`, unit `A`; `fix:sum.js#r2` → role `fix`, unit `sum.js`, tag `r2`, round 2;
`impl:x#carried` → unit `x`, tag `carried`, round unknown. A label without `:` gives
role = label, unit unknown. The UI groups by phase (registered) first; the role × unit matrix
is shown as soon as one agent label parses as `role:unit` (a run starts with one agent).

Fallback matrix (user decision 2026-11-09): when no label parses as `role:unit`, the matrix is
phase × agents: one row per phase (registered `phase`, in order of first appearance; agents with no
phase in one row "phase unknown"), cells are that phase's agents in start order, captioned with
the label as is (else the agentId). Nothing is parsed or invented, so the cells carry the label's
own prov. A run where only some labels parse shows the role × unit matrix for those and the
fallback rows for the rest, under a note that says how many labels did not parse.

### Dependency inference

- `data-flow` / strong: all of
  1. A ended before B started;
  2. B's prompt contains a normalised substring of A's result serialisation (JSON.stringify for
     objects) of ≥ 64 chars;
  3. that substring occurs in the result of no other agent that ended before B started;
  4. it occurs neither in the run's script text nor in the prompts of ≥ 2 other agents.
  `evidence` = first 80 chars of the substring and its length. (Contract 1 used ≥ 24 chars and
  gave 533 false edges out of 810 on dev run 1.) Acceptance: ≤ 10 % false edges on a hand-checked
  sample of 30 from dev runs 1 and 2; a failing rule goes back to the orchestrator, not tuned.
- `time-order` / weak: B started ≤ 1500 ms after A ended, in a later phase, and no data-flow
  edge exists into B. Shown only when the user enables "weak hints".

## 3. Recognised result fields

Applied to every `agent.result.result` that is an object (deep, max depth 3). Recognition is
by field names only; each recognised item keeps `agentId` and `from`.

| kind | fields recognised |
|---|---|
| verdict | `verdict` (string) — optional `reason`/`note`/`summary` |
| finding | array named `findings` / `issues` / `problems`, items with any of `file`, `line`, `title`, `description`, `severity`, `input`; or (R1) an array under any other key whose every item is an object with `file` and at least one of `line`, `severity`, `description`, `input` → method `shape:file+<keys>`; empty or mixed arrays are not findings |
| tests | object `tests` or top-level with numeric `passed` / `failed` / `skipped` (`total` optional); or a string (result or string field ≤ depth 3) with a `node --test` summary `ℹ pass N` / `# pass N` (and `fail`, `skipped`, `todo`) → `prov: "inferred"`, method `node-test-summary` |

Scope (R1, user 2026-11-09): recognition runs over every agent result (`scope: "agent"`, `agentId`) and over `Run.result` (`scope: "run"`, `agentId: null`, `from` the final file), with the same rules and limits. The report card takes the run's test total only from exactly one run-scope tests item; otherwise the total is unknown with the reason (it never shows the last agent report as a total). Findings and verdict counts on the card are agent-scope; run-scope items are listed apart.

Anything else is shown as raw JSON in agent detail.

## 4. HTTP API (server)

- `GET /api/runs` → `[{ id, source, name, status, project, startedAt, agents, running, loaded }]` (the runs of the server's mode only: real, demo or replay; `source` as in Run).
  P1 (user 2026-11-11): in mode `real` the list holds **every** run under the root, of any age and any project. Only runs
  whose files changed within `--since` (default 24 h) are loaded at start (`loaded: true`: transcripts read, watched live);
  an older run is listed from its journal, final file and script only (`loaded: false`; the summary's Facts keep their
  provenance, unknown where those files do not say) and is loaded in full on its first `GET /api/runs/:id`. The UI shows the
  last 24 h by default with a switch to all, and filters by project, status, date and name; filter state lives in the URL
  hash, nothing is written to disk.
- `GET /api/runs/:id` → `Run`
- `GET /api/stream` → SSE; events:
  - `hello` `{ mode: "real" | "demo" | "replay", version }`;
  - `run` — full Run snapshot on connect and at most once per second per run;
  - `event` — one per RawEvent the store applied, in order (not `source.warning`):
    `{ runId, seq /* per run, from 1, no gaps */, ts, kind, agentId?, label?, role?, unit?,
       message /* short line built from data */, status?, prov: "registered" | "final" }`.
    The UI animates and logs from `event`, not from snapshot differences.
- `GET /api/runs/:id/events?since=<seq>` → backlog of `event` objects (last 2000)
- `GET /api/runs/:id/replay?speed=<n>` → SSE, mode `real` only (other modes: 404): `hello` `{ mode: "replay", version, runId }`, then `run` snapshots of the replayed Run (`source: "replay"`, same throttle) and `event` objects as in `/api/stream`, then `end` `{ runId, events }` when all events are emitted. `speed` as `--speed` (default 4, clamped 0.25..100; not a number → 400). Unknown run → 404; run still running → 409 with the reason; more than 3 replays open on the server → 429. The run's files are looked up and read before the stream starts (judge's contract issue, RP1): files not found or no events → 404, read failure → 500, server closing meanwhile → 503, each a JSON `{ error }` with the reason and no `hello`. After `hello` there is no frame for a failure: a stream that ends without `end` is shown by the UI as lost. Read-only: it reads the run's files and writes nothing.
- `GET /api/agents/:runId/:agentId/transcript?tail=200` → normalised activity list
- `GET /api/prices` (P2, user 2026-11-11: prices are not hard-coded) → `{ source: "openrouter", url, fetchedAt, models: { [openrouter id]: { input, output, cacheRead?, cacheWrite? } } }`
  in USD per token as OpenRouter's public model list gives them; fetched by the server on the first request, kept in memory
  for one hour, timeout 5 s, sends no user data (a plain GET of the public list). Failure or `--offline` → 503 `{ error }`
  with the reason; the UI then shows cost unknown with that reason. Mode `demo` → 404 and the UI shows no cost for a
  `source: "demo"` Run (its tokens are made up; a demo never needs the network). Matching a transcript model id to an OpenRouter id is
  inferred (method names the rule); no match → cost unknown for that model. Codex and other engines: unknown (no source).
- `GET /api/search?q=<text>&limit=<n>` (P3) → `{ results: [{ runId, agentId?, field, excerpt, start, end }], more: boolean }`
  over the loaded runs' models only (run name and description, agent prompts, results, activity summaries and texts, log
  lines); one result per field, around its first match; case-insensitive with Unicode case folding (per code point; dotless
  i folds to i, a known limit); at most `limit` results (default 50, max 200) and a time budget of 500 ms; over either, `more: true`. Read-only.
- `GET /` static `web/`

Server binds `127.0.0.1` on port 0 (OS chooses a free port).

## 5. Module interfaces (ES modules, Node ≥ 20, no npm dependencies)

```js
// src/source/claude-fs.mjs                                   (node N3)
export function createClaudeFsSource({
  root = path.join(os.homedir(), '.claude', 'projects'),
  pollMs = 2000,              // fallback polling; watching is primary
  watch = true,
  sinceMs = 24 * 3600e3,      // only runs whose files changed within this window; Infinity = all
  onEvent,                     // (RawEvent) => void
  now = () => Date.now(),
}) → { start(): Promise<void>, stop(): void, rescan(): Promise<void> }
export async function readRunDir(sessionDir, runId) → RawEvent[]   // one-shot replay, same events as live
export function parseScriptMeta(text) → { name, description, phases } | null

// src/source/demo.mjs                                        (node N7)
export function createDemoSource({ onEvent, speed = 1, loop = true })
  → { start(): Promise<void>, stop(): void }        // every event: src "demo", runId "demo-…"

// src/model/reduce.mjs                                       (node N4)
export function createStore({ now = () => Date.now(), staleMs = 30 * 60e3 } = {})
  → { apply(ev: RawEvent): string /* runId */, getRun(id): Run | null,
      listRuns(): RunSummary[], onChange(cb: (runId) => void): () => void,
      onEvent(cb: (UiEvent) => void): () => void, eventsSince(runId, seq): UiEvent[] }
export function reduceRun(events: RawEvent[], opts?) → Run        // pure; store uses it
// src/model/infer.mjs     export function inferEdges(run) → Edge[]
// src/model/recognize.mjs export function recognize(run) → { findings, verdicts, tests }
// src/model/labels.mjs    export function parseLabel(label) → { role, unit, round } (nulls allowed)

// src/server/server.mjs                                      (node N5)
export function createServer({ store, webDir, mode /* 'real'|'demo' */, version,
                               onClientCountChange }) → http.Server   // not yet listening
// bin/wfviz.mjs: parses flags, wires source → store → server, listens on 127.0.0.1:0,
// prints the URL, opens the browser, shuts down on SIGINT/SIGTERM and after --idle seconds
// with no SSE client (default 120 s after the last client leaves; 0 = never).
```

`demo.mjs` is imported only by `bin/wfviz.mjs`, only under `--demo`, via dynamic `import()`.
In demo mode the store receives only demo events; in real mode only claude-fs events.
