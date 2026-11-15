// Reducer: RawEvent[] -> Run (docs/contract.md sections 1, 2, 5).
//
// Pure: reduceRun(events, { now, staleMs }) never reads the clock or the disk. The store keeps
// the events of each run and re-reduces on demand.
//
// Every value is a Fact { value, prov, from | method | reason }:
//   registered  read from journal / agent meta / transcript / script while the run is live
//   final       read from the end-of-run file workflows/<runId>.json
//   inferred    computed; `method` says how
//   unknown     the sources do not say; `reason` says why. value is null.
//
// Which source wins when several carry the same value:
//   descriptive values (label, phase, agentType, name, description): registered first, the
//     final file fills the gaps (older Claude Code versions have no label/phase until the end);
//   measured end state (state, times, tokens, tool calls, status, logs, model): the final file
//     wins, because it is the complete and exact record;
//   prompt and result: the registered full text wins; the final file only has a short preview.
//
// Time: journal.jsonl records carry no timestamp, so the RawEvent ts of a journal line is only
// a file time. It is used as the last resort and tagged method "journal-event-ts"; transcript
// record timestamps (agent.prompt / agent.activity / agent.structured) come first.
// The run's own start follows the same idea (docs/contract.md section 2): the final file's startTime; else the earliest agent
// start (a transcript or final start first, a journal file time only when no other agent start exists, and then the method
// says it is coarse); else the script file time, which can be hours before the run; else unknown.
//
// Additions to docs/contract.md (additive only, nothing removed or renamed):
//   - Run.error: Fact, the final file's `error` text of a failed run.
//   - Run.result: Fact, the final file's top-level `result` (prov final, from `<final file>#result`); unknown with a reason while
//     the run has no final file, when the final file has `"result": null` and when it has no `result` key. recognize() also
//     runs over it (scope "run"; docs/contract.md sections 2 and 3).
//   - RunSummary (store.listRuns) also carries `source`; name/status/startedAt are the run's Facts.
//   - Several agent.prompt events of one agent (every leading user record: the harness can relay the
//     user request before the computed task) are joined in line order into one prompt.
//   - ccVersion is read from `data.version` of run.launched / agent.prompt / agent.activity /
//     agent.structured events when the source copies it there; otherwise it is unknown.
//   - Run.source is "demo" when any event carries src "demo", else "replay" when any carries src "replay", else "real";
//     a run whose events carry several sources keeps the first of that order and gets a warning (docs/contract.md section 1).
//   - reduceDetailed(events, opts) -> { run, staleAt, lastTs } is what the store caches on; reduceRun is its pure face.
//     opts.memo (the store passes one per run) lets inferEdges reuse its edges while its inputs are unchanged.
//   - run.warnings: at most MAX_WARNINGS entries for what the sources and the event stream report and at most
//     MAX_WARNINGS for the reducer's own findings; a dropped entry is counted in a closing "N more ... suppressed"
//     line of its group, so a flood of one kind cannot hide the other and nothing disappears unnoticed.
//   - A journal/transcript line that is read again with different content (a file rewritten after it shrank)
//     replaces the earlier event of that line and is reported as a warning; identical re-reads change nothing.
//   - agent.failed (a journal "failed" line, sources/event-sources.md) makes the agent's state `failed`, registered at
//     that line. It has no result line, so its result stays unknown. The final file's own state still wins when it
//     is one of the documented ones (contract 2: done, error, progress, and queued/running/failed). A final state
//     outside those (a value this model does not document) does not erase a journal `failed` line: that line decides
//     and a warning says so. With a result line
//     as well, or with no journal line, the state stays unknown with the raw value in the reason (the sources
//     disagree, or say nothing). A result line wins over a failed line of the same agent (reported as a warning).
//   - store.onChange also fires when a run that was observed as running crosses its stale limit with no new event
//     (a session that closed or crashed mid-run never writes a final file): see createStore.
//
// Contract 2 (docs/contract.md, docs/c-rev-proposal.md), and what this file adds to it:
//   - Run.status: running | completed | failed | killed | unknown. Any other final status string is kept as it is
//     (prov "final"), never turned into unknown; "stopped" is no longer a known value, it is just such a string.
//   - Agent.state is normalised to queued | running | done | failed | unknown; Fact.raw is the source value:
//     final "done" -> done, "error" -> failed, "progress" -> running. Journal "failed" -> failed (registered).
//     Any other final state is unknown (raw kept) unless the journal says how the agent ended.
//   - INTERRUPTED. An agent that was still running when its run ended as killed or failed (the final file lists it as
//     "progress"/"running", or, with no final state for it, the journal has a "started" line and no result or failed
//     line) keeps state "running", prov as the source says, and carries `interrupted: true` and a `note` on the state
//     Fact. The model invents no end time: endedAt is unknown, with a reason that says it was interrupted. The UI
//     shows such an agent as interrupted. In a run that ended any other way (completed, another status text, no status
//     text) an agent with a "started" line, no result or failed line and no usable state in the final file keeps the
//     registered state "running" (not interrupted, nothing contradicts the journal). Additive consequences: totals.interrupted counts them and totals.running
//     does not (a finished run has nothing running); a phase whose agents include interrupted ones is "interrupted"
//     (inferred, agent-states) unless an agent is genuinely running. A "running" or "queued" final state in a run that
//     ended as completed (or anything else) is not believed: unknown, raw kept. If the journal has a result or failed
//     line for an agent the final file lists as "progress", the journal line decides and a warning says so.
//   - workflowProgress[] items of type "workflow_phase" are phases, never agents, and carry no state.
//     The journal decides which agents exist: an agent only the final file lists is NOT created (the journal, the agent
//     meta files and the transcripts name the agents; one warning counts what the final file lists beyond them), and an
//     agent the final file does not list keeps its registered values.
//   - Run.ccVersion is read from data.ccVersion (or data.version) of agent.prompt / agent.activity / agent.structured
//     events (and run.launched, where a source copies it), registered; several distinct values are joined with " + "
//     in version order, and `from` names the first event of each.
//   - Before the final file arrives, an agent whose Claude Code version (its own transcript, else the run's) is below
//     2.1.271 gets label and phase unknown with the reason "not recorded live before 2.1.271".
//   - Agent.tag: Fact (method label-pattern), the text after the last "#" of the label; see labels.mjs.
//   - Edges: inferEdges gets the script text (opts.scriptText) for rule 4 of the dependency inference. The text is the
//     final file's `script` (the text that ran; a string in every observed final file) and, only when that is missing
//     or empty, the script file the source read (it can have been edited after the run). When data-flow edges exist but
//     no script text was read, a warning says that those edges were not checked against the script.
//   - createStore gains onEvent(cb) and eventsSince(runId, seq): one UiEvent per applied RawEvent (not source.warning),
//     see createStore.
//
// P2 (agent tokens, user 2026-11-11), additive:
//   - Agent.usage: Fact { input, output, cacheRead, cacheWrite }, the transcript's message.usage summed over the API messages
//     of the agent, one record per message id: Claude Code writes one transcript record per content block of a message and
//     repeats the message's usage in each (measured on 39 local runs, 28,259 records, 12,690 ids: 15,569 repeats; summing every
//     record counts input 3.4 times and output 1.14 times). The key is message.id (the source copies it to data.messageId); of
//     the records of one id the one with the greatest transcript line wins (output_tokens never decreases along them, the last
//     is the final count), whatever order the events arrive in. A record with no message id counts once on its own and the method
//     says how many did. A key missing from a record adds nothing. Always `inferred`, even with a final file: the final file's
//     per-agent `tokens` is another quantity (it is not the sum of these, and Agent.tokens stays as it was).
//     Only records the source delivers are counted (assistant records with a tool call or text): a message whose records are all
//     thinking-only is billed and is in the transcript, but the source drops it, so it is not in the sum (measured: 26 messages in 11 of 801
//     agents, up to 27 % of one agent's cache write, 0.36 % of all cache-read tokens; evidence/tmp/agent-tokens-fixer-thinking.out.txt). The methods of Agent.usage and totals.usage say so.
//   - Agent.byModel: Fact { [model id as the transcript gives it]: usage }, the agent's usage split by the model of each counted message (the same
//     split as totals.byModel, method "sum by transcript model"; unknown with the reason of usage, or when no message names its model). The page
//     prices an agent by it: Agent.model is the final file's or the last record's model, not the model of the counted messages (it can be
//     "claude-opus-4-8[1m]" when the records say "claude-opus-4-8", or "<synthetic>" when the last record is a zero-usage placeholder).
//     Additive: docs/contract.md section 2 has no line for it yet (the orchestrator adds one).
//   - totals.usage: the agents' usage values added up (same four keys); totals.byModel: { [model id as the transcript gives it]:
//     usage } of the same messages, split by the model of the message (a message with no model id is in usage and not in
//     byModel; the method says so). Cost is never in the Run: the page computes it from usage and GET /api/prices.
//   - store.listRuns keeps one summary per run and builds it again only when that run changed (an event, or the clock
//     crossing its stale limit): it needs no edges, no recognition and no unknown list, so it is built from the reducer's first
//     part (reduceBase) and the summary equals summaryOf(getRun(id)) field for field. createStore({ onBuild }) is a test hook
//     that is told about every build: { runId, kind: 'run' | 'summary' }.

import { parseLabel } from './labels.mjs';
import { inferEdges } from './infer.mjs';
import { recognize } from './recognize.mjs';

export const DEFAULT_STALE_MS = 30 * 60e3;
// A run that ended with one of these statuses interrupted whatever was still running.
const INTERRUPTING_STATUSES = new Set(['killed', 'failed']);
// Final-file agent state -> normalised state (contract 2). Anything else is unknown, with the raw value kept.
const FINAL_AGENT_STATES = { queued: 'queued', running: 'running', progress: 'running', done: 'done', error: 'failed', failed: 'failed' };
// Claude Code versions before this one do not write label and phase to the journal while the run is live.
const LIVE_LABEL_FROM = '2.1.271';
const ACTIVITY_LIMIT = 50;
const MAX_WARNINGS = 200;
// Event kinds built from Claude Code transcript records; a source may copy the record's `version` into data.
const VERSION_KINDS = new Set(['run.launched', 'agent.prompt', 'agent.activity', 'agent.structured']);
const AGENT_VERSION_KINDS = new Set(['agent.prompt', 'agent.activity', 'agent.structured']);
const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
// transcript key -> key of Agent.usage (input_tokens does not include the cache read and write tokens)
const USAGE_FIELDS = [['input_tokens', 'input'], ['output_tokens', 'output'], ['cache_read_input_tokens', 'cacheRead'], ['cache_creation_input_tokens', 'cacheWrite']];

const registered = (value, from) => ({ value, prov: 'registered', from });
const finalFact = (value, from) => ({ value, prov: 'final', from });
const inferred = (value, method) => ({ value, prov: 'inferred', method });
const unknown = (reason) => ({ value: null, prov: 'unknown', reason });

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const tsOf = (ev) => (isNum(ev?.ts) ? ev.ts : null);

// "<file>:<line>" for line-based files; whole-file records (script, meta, final) get "<file>#<pointer>".
function where(prov, pointer) {
  const file = typeof prov?.file === 'string' ? prov.file : '(unknown file)';
  if (Number.isInteger(prov?.line)) return `${file}:${prov.line}`;
  return pointer ? `${file}#${pointer}` : file;
}

function agentIdFromFile(file) {
  const m = /agent-([^/\\]+?)\.(?:meta\.json|jsonl|prefix\.json)$/.exec(typeof file === 'string' ? file : '');
  return m ? m[1] : null;
}

function dedupeKey(ev) {
  const line = ev.prov?.line;
  if (!Number.isInteger(line)) return null;
  const base = `${ev.kind}|${ev.prov.file ?? ''}|${line}`;
  const d = isObj(ev.data) ? ev.data : {};
  if (ev.kind === 'agent.activity') return `${base}|${d.tool ?? ''}|${d.inputSummary ?? ''}|${String(d.text ?? '').slice(0, 80)}`;
  if (ev.kind === 'source.warning') return `${base}|${d.message ?? ''}`;
  return base;
}

// The kinds whose dedupe key (kind|file|line) does not say what the line contains. A re-read of such a
// line is a plain duplicate only when its data is the same; compare a digest of the data (computed once
// per event object).
const CONTENT_KINDS = new Set(['run.launched', 'agent.started', 'agent.result', 'agent.failed', 'agent.prompt', 'agent.structured']);
const sigCache = new WeakMap();
function contentSig(ev) {
  if (!CONTENT_KINDS.has(ev.kind)) return '';
  let sig = sigCache.get(ev);
  if (sig === undefined) {
    let text;
    try { text = JSON.stringify(ev.data); } catch { text = undefined; }
    if (typeof text !== 'string') text = String(ev.data);
    let a = 0x811c9dc5, b = 0x9747b28c; // two independent 32-bit hashes of the text
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b + c, 0x5bd1e995) ^ (b >>> 13);
    }
    sig = `${text.length}:${a >>> 0}:${b >>> 0}`;
    sigCache.set(ev, sig);
  }
  return sig;
}

// A capped list of distinct messages that remembers how many it had to drop.
function warningSink() {
  const list = [];
  const seen = new Set();
  const dropped = new Set();
  return {
    add(msg) {
      if (seen.has(msg) || dropped.has(msg)) return;
      if (list.length >= MAX_WARNINGS) { dropped.add(msg); return; }
      seen.add(msg);
      list.push(msg);
    },
    done() {
      return dropped.size
        ? [...list, `${dropped.size} more warning${dropped.size === 1 ? '' : 's'} of this kind suppressed (limit ${MAX_WARNINGS})`]
        : list;
    },
  };
}

function duration(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`;
}

// "2.1.271" -> [2, 1, 271]; null when the text does not start with three numbers.
function versionParts(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(x, y) {
  const a = versionParts(x), b = versionParts(y);
  if (a && b) return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (a) return -1; // readable versions first; unreadable ones keep the order they were seen in
  if (b) return 1;
  return 0;
}
const versionBefore = (v, limit) => {
  const a = versionParts(v), b = versionParts(limit);
  return a !== null && b !== null && compareVersions(v, limit) < 0;
};

// ---------------------------------------------------------------- 1. collect raw state

// One usage record of an agent. Records that carry the same message id are one API message: only the one with the greatest transcript
// line is kept (a later arrival wins when a line number is missing or equal), so the order the events come in does not matter.
function noteUsage(a, ev, data) {
  a.usageRecords++;
  if (!isStr(data.messageId)) { a.usageNoId.push(ev); return; }
  const line = Number.isInteger(ev.prov?.line) ? ev.prov.line : null;
  const cur = a.usageById.get(data.messageId);
  if (!cur) {
    a.usageById.set(data.messageId, { ev, line, records: 1, model: isStr(data.model) ? data.model : null, modelLine: line });
    return;
  }
  cur.records++;
  if (cur.line === null || line === null || line >= cur.line) { cur.ev = ev; cur.line = line; }
  if (isStr(data.model) && (cur.model === null || cur.modelLine === null || line === null || line >= cur.modelLine)) { cur.model = data.model; cur.modelLine = line; }
}

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function addUsage(into, usage) {
  for (const [from, to] of USAGE_FIELDS) if (isNum(usage[from])) into[to] += usage[from];
}

// What one agent's messages add up to: { total, byModel: Map(model id -> usage), messages, records, noId, noModel }, or null when no
// record of the agent carries usage. noModel counts the messages that name no model.
function sumUsage(a) {
  if (a.usageSum !== undefined) return a.usageSum;
  if (a.usageRecords === 0) return (a.usageSum = null);
  const total = zeroUsage();
  const byModel = new Map();
  let noModel = 0;
  const put = (model, usage) => {
    addUsage(total, usage);
    if (model === null) { noModel++; return; }
    let into = byModel.get(model);
    if (!into) byModel.set(model, (into = zeroUsage()));
    addUsage(into, usage);
  };
  for (const { ev, model } of a.usageById.values()) put(model, ev.data.usage);
  for (const ev of a.usageNoId) put(isStr(ev.data.model) ? ev.data.model : null, ev.data.usage);
  return (a.usageSum = { total, byModel, messages: a.usageById.size + a.usageNoId.length, records: a.usageRecords, noId: a.usageNoId.length, noModel });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The source delivers only the assistant records that carry a tool call or text; a message whose records have neither (thinking only) is
// billed and is in the transcript but never reaches the model. The usage methods say so: the sum is over delivered records.
const DELIVERED_LIMIT = 'a message whose records have no tool call and no text is not delivered, so it is not counted';

// { [model id as the transcript gives it]: usage } as a Fact, from a Map(model id -> usage), or unknown when no message names its model.
// Model ids come from transcript records: they are defined as own properties so that "__proto__" is a key, not a prototype. The values are
// copies: the Run shares nothing with the sums.
function modelSplit(models, noModel) {
  if (!models.size) return unknown('no transcript record with usage names its model');
  const value = {};
  for (const [model, u] of models) Object.defineProperty(value, model, { value: { ...u }, enumerable: true, writable: true, configurable: true });
  const note = noModel ? `; ${plural(noModel, 'message')} with no model id ${noModel === 1 ? 'is' : 'are'} in usage but not in byModel` : '';
  return inferred(value, `sum by transcript model${note}`);
}

function collect(events) {
  const S = {
    id: null, sessionId: null, project: null,
    srcs: new Set(), script: null, launched: null, final: null,
    versions: new Map(), // Claude Code version text -> the first event that carries it
    lastTs: null, journalSeen: false,
    agents: new Map(), sink: warningSink(),
  };
  const warn = S.sink.add;
  const agentOf = (id) => {
    let a = S.agents.get(id);
    if (!a) {
      a = { id, seq: S.agents.size, started: null, result: null, failed: null, meta: null, prompts: [], activity: [],
        tsFirst: null, tsLast: null, usageEv: null, modelEv: null, version: null,
        transcript: false, usageById: new Map(), usageNoId: [], usageRecords: 0, usageSum: undefined };
      S.agents.set(id, a);
    }
    return a;
  };
  const bump = (a, ev) => {
    const ts = tsOf(ev);
    if (ts === null) return;
    if (a.tsFirst === null || ts < a.tsFirst) a.tsFirst = ts;
    if (a.tsLast === null || ts > a.tsLast) a.tsLast = ts;
  };

  // pass 1: which events count. A line read twice with the same content counts once; read again with
  // different content (the source re-reads a shrunken file from its start) the newer event replaces the old.
  const accepted = [];
  const seen = new Map(); // dedupe key -> { sig, at: index in accepted }
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isObj(ev) || typeof ev.kind !== 'string') { warn('ignored a malformed event (not an object with a kind)'); continue; }
    if (!isStr(ev.runId)) { warn(`ignored ${ev.kind} event without runId`); continue; }
    if (S.id === null) S.id = ev.runId;
    if (ev.runId !== S.id) { warn(`ignored ${ev.kind} event of run ${ev.runId} while reducing ${S.id}`); continue; }

    const key = dedupeKey(ev);
    if (key !== null) {
      const sig = contentSig(ev);
      const prev = seen.get(key);
      if (prev) {
        if (prev.sig === sig) continue;
        warn(`${ev.kind} at ${where(ev.prov)} was read again with different content (the file was probably rewritten); the newer content replaces the earlier one`);
        accepted[prev.at] = null;
      }
      seen.set(key, { sig, at: accepted.length });
    }
    accepted.push(ev);
  }

  // pass 2: fold the accepted events into the raw state
  for (const ev of accepted) {
    if (ev === null) continue;
    if (isStr(ev.src)) S.srcs.add(ev.src);
    if (S.sessionId === null && isStr(ev.sessionId)) S.sessionId = ev.sessionId;
    if (S.project === null && isStr(ev.project)) S.project = ev.project;
    const ts = tsOf(ev);
    if (ts !== null && (S.lastTs === null || ts > S.lastTs)) S.lastTs = ts;
    const data = isObj(ev.data) ? ev.data : {};
    const version = VERSION_KINDS.has(ev.kind) ? (isStr(data.ccVersion) ? data.ccVersion : isStr(data.version) ? data.version : null) : null;
    if (version !== null && !S.versions.has(version)) S.versions.set(version, ev);

    switch (ev.kind) {
      case 'run.script':
        S.script = ev;
        if (!isObj(data.meta)) warn(`script meta could not be parsed (${data.scriptPath ?? ev.prov?.file ?? 'unknown script'})`);
        break;
      case 'run.launched':
        S.launched ??= ev;
        S.journalSeen = true;
        break;
      case 'run.final':
        if (isObj(ev.data)) S.final = ev;
        else warn('ignored run.final event whose data is not an object');
        break;
      case 'agent.started': {
        if (!isStr(data.agentId)) { warn('ignored agent.started without agentId'); break; }
        const a = agentOf(data.agentId);
        S.journalSeen = true;
        if (a.started) warn(`duplicate "started" for agent ${a.id} ignored`);
        else a.started = ev;
        break;
      }
      case 'agent.result': {
        if (!isStr(data.agentId)) { warn('ignored agent.result without agentId'); break; }
        agentOf(data.agentId).result = ev;
        S.journalSeen = true;
        break;
      }
      case 'agent.failed': {
        if (!isStr(data.agentId)) { warn('ignored agent.failed without agentId'); break; }
        agentOf(data.agentId).failed = ev; // a second line for the same agent: the later one is the one shown
        S.journalSeen = true;
        break;
      }
      case 'agent.meta': {
        const id = isStr(data.agentId) ? data.agentId : agentIdFromFile(ev.prov?.file);
        if (!id) { warn(`ignored agent.meta whose agent id is not in the data or the file name (${ev.prov?.file ?? 'no file'})`); break; }
        agentOf(id).meta = ev;
        break;
      }
      case 'agent.prompt':
      case 'agent.activity':
      case 'agent.structured': {
        const id = isStr(data.agentId) ? data.agentId : agentIdFromFile(ev.prov?.file);
        if (!id) { warn(`ignored ${ev.kind} without agentId`); break; }
        const a = agentOf(id);
        bump(a, ev);
        a.transcript = true;
        if (version !== null && a.version === null && AGENT_VERSION_KINDS.has(ev.kind)) a.version = version;
        if (ev.kind === 'agent.prompt') {
          // normally one record; a source may emit every leading user message (the harness can relay
          // the user request before the computed task), so keep them all and join them in line order
          if (!a.prompts.some((q) => q.prov?.file === ev.prov?.file && q.data?.text === data.text)) a.prompts.push(ev);
        } else if (ev.kind === 'agent.activity') {
          a.activity.push(ev);
          if (isObj(data.usage) && USAGE_KEYS.some((k) => isNum(data.usage[k]))) {
            a.usageEv = ev;
            noteUsage(a, ev, data);
          }
          if (isStr(data.model)) a.modelEv = ev;
        }
        break;
      }
      case 'source.warning':
        warn(`${isStr(data.message) ? data.message : 'source warning'}${ev.prov?.file ? ` [${where(ev.prov)}]` : ''}`);
        break;
      default:
        warn(`unknown event kind "${ev.kind}" ignored`);
    }
  }
  return S;
}

// ---------------------------------------------------------------- 2. run status

function resolveStatus(S, now, staleMs) {
  const F = S.final?.data;
  if (F) {
    const s = F.status;
    const from = where(S.final.prov, 'status');
    let fact;
    // contract 2: any status text passes through as a final value (running | completed | failed | killed are the
    // ones seen); only a missing or non-text status is unknown
    if (isStr(s)) fact = finalFact(s, from);
    else if (s === undefined) fact = unknown('final file has no status field');
    else fact = unknown(`final file status is not text (${s === null ? 'null' : typeof s})`);
    return { fact, ended: true, stale: false, staleAt: null, interrupting: isStr(s) && INTERRUPTING_STATUSES.has(s) };
  }
  if (!S.journalSeen) return { fact: unknown('no journal line and no final run file seen yet'), ended: false, stale: false, staleAt: null, interrupting: false };
  if (S.lastTs !== null) {
    const staleAt = S.lastTs + staleMs;
    if (now > staleAt) {
      const reason = `no file activity for ${duration(now - S.lastTs)} (limit ${duration(staleMs)}) and no final run file; the run may have been stopped or its session closed`;
      return { fact: unknown(reason), ended: false, stale: true, staleReason: reason, staleAt, interrupting: false };
    }
    return { fact: inferred('running', 'no-final-file'), ended: false, stale: false, staleAt, interrupting: false };
  }
  return { fact: inferred('running', 'no-final-file'), ended: false, stale: false, staleAt: null, interrupting: false };
}

// ---------------------------------------------------------------- 3. agents

function activityEntry(ev) {
  const d = isObj(ev.data) ? ev.data : {};
  const e = { ts: tsOf(ev) };
  if (isStr(d.tool)) e.tool = d.tool;
  if (typeof d.inputSummary === 'string') e.inputSummary = d.inputSummary;
  if (typeof d.text === 'string') e.text = d.text;
  return e;
}

function usageTotal(usage) {
  let sum = 0;
  for (const k of USAGE_KEYS) if (isNum(usage[k])) sum += usage[k];
  return sum;
}

function buildAgent(a, fe, ctx, warn) {
  const E = fe?.entry;
  const fin = (field, value) => finalFact(value, where(ctx.finalEv?.prov, `workflowProgress[${fe.i}].${field}`));
  const noFinalNote = ctx.finalEv ? '' : '; the final run file is not written yet';
  // Before 2.1.271 the journal "started" line has no label and no phase, and the agent meta no description and no
  // workflowPhase: nothing says them until the final file arrives. The agent's own version decides, else the run's.
  const oldVersion = a.version !== null ? versionBefore(a.version, LIVE_LABEL_FROM)
    : ctx.versions.length > 0 && ctx.versions.every((v) => versionBefore(v, LIVE_LABEL_FROM));
  const notLive = !ctx.finalEv && oldVersion ? `not recorded live before ${LIVE_LABEL_FROM}` : null;

  // -- label, phase, agentType: registered first, final fills the gap
  let label;
  if (isStr(a.started?.data?.label)) label = registered(a.started.data.label, where(a.started.prov));
  else if (isStr(a.meta?.data?.description)) label = registered(a.meta.data.description, where(a.meta.prov, 'description'));
  else if (isStr(E?.label)) label = fin('label', E.label);
  else label = unknown(ctx.finalEv
    ? 'not in the journal, the agent meta or the final run file'
    : notLive ?? 'journal "started" line and agent meta carry no label (older Claude Code); the final run file is not written yet');
  if (label.prov === 'registered' && isStr(E?.label) && E.label !== label.value) warn(`agent ${a.id}: label "${label.value}" differs from the final file's "${E.label}"`);

  let phase;
  if (isStr(a.started?.data?.phase)) phase = registered(a.started.data.phase, where(a.started.prov));
  else if (isStr(a.meta?.data?.workflowPhase)) phase = registered(a.meta.data.workflowPhase, where(a.meta.prov, 'workflowPhase'));
  else if (isStr(E?.phaseTitle)) phase = fin('phaseTitle', E.phaseTitle);
  else phase = unknown(ctx.finalEv
    ? 'not in the journal, the agent meta or the final run file'
    : notLive ?? 'journal "started" line and agent meta carry no phase (older Claude Code); the final run file is not written yet');

  let agentType;
  if (isStr(a.meta?.data?.agentType)) agentType = registered(a.meta.data.agentType, where(a.meta.prov, 'agentType'));
  else if (isStr(E?.agentType)) agentType = fin('agentType', E.agentType);
  else agentType = unknown('no agent meta file with agentType seen, and the final file has none');

  // -- model: final > latest transcript model > meta alias
  let model;
  if (isStr(E?.model)) model = fin('model', E.model);
  else if (a.modelEv) model = registered(a.modelEv.data.model, where(a.modelEv.prov));
  else if (isStr(a.meta?.data?.model)) model = registered(a.meta.data.model, where(a.meta.prov, 'model'));
  else model = unknown(`no model in the transcript, the agent meta or the final file${noFinalNote}`);

  // -- role / unit / round / tag from the label (role:unit#tag)
  let role, unit, round, tag;
  if (label.prov === 'unknown') {
    const r = 'label is unknown, so the label pattern cannot be read';
    role = unknown(r); unit = unknown(r); round = unknown(r); tag = unknown(r);
  } else {
    const p = parseLabel(label.value);
    role = p.role !== null ? inferred(p.role, 'label-pattern') : unknown('label has no role part');
    unit = p.unit !== null ? inferred(p.unit, 'label-pattern') : unknown('label has no ":unit" part');
    round = p.round !== null ? inferred(p.round, 'label-pattern') : unknown('label has no round suffix (#rN or "round N")');
    tag = p.tag !== null ? inferred(p.tag, 'label-pattern') : unknown('label has no "#tag" suffix');
  }

  // -- state (contract 2; "INTERRUPTED" in the header says what an interrupted agent looks like)
  const hasResult = a.result !== null;
  const hasFailed = a.failed !== null;
  if (hasResult && hasFailed) warn(`agent ${a.id} has both a "failed" and a "result" line in the journal; shown as done`);
  // what the journal says about how the agent ended; a result line wins over a failed line
  const journalEnd = () => (hasResult ? registered('done', where(a.result.prov))
    : hasFailed ? registered('failed', where(a.failed.prov)) : null);
  const interruptedNote = `interrupted: the run ${ctx.statusValue} while this agent was still running`;
  const asInterrupted = (fact) => ({ ...fact, interrupted: true, note: interruptedNote });
  let state;
  const fs = E?.state;
  const normalised = isStr(fs) && Object.hasOwn(FINAL_AGENT_STATES, fs) ? FINAL_AGENT_STATES[fs] : null;
  if (normalised !== null) {
    if ((normalised === 'running' || normalised === 'queued') && ctx.runEnded) {
      const ended = journalEnd();
      if (!ctx.interruptedRun) {
        state = { ...unknown(`final file lists this agent as "${fs}" although the run ended (${ctx.statusValue ?? 'status unknown'})`), raw: fs };
      } else if (ended) {
        warn(`agent ${a.id}: the final file lists it as "${fs}", but the journal records how it ended (${ended.from}); the journal line is used`);
        state = ended;
      } else if (normalised === 'running') {
        state = asInterrupted({ ...fin('state', normalised), raw: fs });
      } else state = { ...fin('state', normalised), raw: fs }; // queued: it never started, so nothing was interrupted
    } else state = { ...fin('state', normalised), raw: fs };
  } else if (isStr(fs)) {
    // A final state this model does not know. A journal "failed" line is documented evidence of how the agent
    // ended, so it is not thrown away; with a result line as well, or with no journal line at all, the
    // sources disagree or are silent, and the state stays unknown with the raw value kept.
    const note = `final file reports state "${fs}", which is not one of done/error/progress (or queued/running/failed)`;
    if (hasFailed && !hasResult) {
      warn(`agent ${a.id}: ${note}; the journal's "failed" line (${where(a.failed.prov)}) is used instead`);
      state = registered('failed', where(a.failed.prov));
    } else state = { ...unknown(note), raw: fs };
  } else if (hasResult || hasFailed) {
    state = journalEnd();
  } else if (a.started) {
    // Started, no result or failed line, and the final file (if there is one) says nothing about this agent's state:
    // it keeps what the journal registered. In a run that ended as killed or failed it is interrupted; in any other run
    // nothing contradicts the journal, so it stays plain "running" (the model does not guess an end it was not told).
    if (ctx.runEnded) {
      state = ctx.interruptedRun
        ? asInterrupted(registered('running', where(a.started.prov)))
        : registered('running', where(a.started.prov));
    } else if (ctx.stale) state = unknown(`started but no result, and ${ctx.staleReason}`);
    else state = registered('running', where(a.started.prov));
  } else {
    state = unknown('seen in agent meta or transcript only; no journal "started" line yet');
  }
  const finished = state.value === 'done' || state.value === 'failed';
  const wasInterrupted = state.interrupted === true;
  // no end time is invented for an agent that never ended
  const notEnded = wasInterrupted ? `${interruptedNote}; no end time is recorded`
    : state.value === 'running' ? 'agent is still running' : 'agent has no known end';

  // -- times
  let startedAt;
  if (isNum(E?.startedAt)) startedAt = fin('startedAt', E.startedAt);
  else if (a.tsFirst !== null) startedAt = inferred(a.tsFirst, 'first-transcript-record');
  else if (tsOf(a.started) !== null) startedAt = inferred(tsOf(a.started), 'journal-event-ts');
  else startedAt = unknown('no start time in the final file, transcript or journal');

  let endedAt;
  if (!finished) endedAt = unknown(notEnded);
  else if (isNum(E?.startedAt) && isNum(E?.durationMs)) endedAt = inferred(E.startedAt + E.durationMs, 'final-startedAt+durationMs');
  else if (a.tsLast !== null) endedAt = inferred(a.tsLast, 'last-transcript-record');
  else if ((a.result ?? a.failed) && tsOf(a.result ?? a.failed) !== null) endedAt = inferred(tsOf(a.result ?? a.failed), 'journal-event-ts');
  else endedAt = unknown('no end time in the final file, transcript or journal');

  let durationMs;
  if (isNum(E?.durationMs)) durationMs = fin('durationMs', E.durationMs);
  else if (!finished) durationMs = unknown(notEnded);
  else if (isNum(startedAt.value) && isNum(endedAt.value) && endedAt.value >= startedAt.value) {
    const coarse = startedAt.method === 'journal-event-ts' || endedAt.method === 'journal-event-ts';
    if (coarse && endedAt.value === startedAt.value) {
      durationMs = unknown('start and end are the same journal file time, which says nothing about how long the agent ran (journal lines carry no timestamp of their own)');
    } else {
      durationMs = inferred(endedAt.value - startedAt.value, coarse ? 'endedAt-startedAt (journal file times, coarse)' : 'endedAt-startedAt');
    }
  } else durationMs = unknown('start or end time missing or inconsistent');

  // -- prompt, result: registered full text first, final preview as fallback
  let prompt;
  const promptEvents = a.prompts
    .filter((q) => typeof q.data?.text === 'string')
    .sort((x, y) => (Number.isInteger(x.prov?.line) && Number.isInteger(y.prov?.line) ? x.prov.line - y.prov.line : 0));
  if (promptEvents.length) prompt = registered(promptEvents.map((q) => q.data.text).join('\n\n'), where(promptEvents[0].prov));
  else if (typeof E?.promptPreview === 'string') prompt = fin('promptPreview', E.promptPreview);
  else prompt = unknown(`no transcript prompt seen and no preview in the final file${noFinalNote}`);

  let result;
  if (hasResult && isObj(a.result.data) && 'result' in a.result.data) result = registered(a.result.data.result, where(a.result.prov));
  else if (typeof E?.resultPreview === 'string') result = fin('resultPreview', E.resultPreview);
  else if (wasInterrupted) result = unknown(`${interruptedNote}, before it produced a result`);
  else if (state.value === 'running') result = unknown('agent has not produced a result yet');
  else if (hasFailed && !hasResult) result = unknown(`the journal records this agent as failed and has no result line for it${noFinalNote}`);
  else result = unknown(`no result in the journal and no preview in the final file${noFinalNote}`);

  // -- activity, tool calls, tokens
  const entries = a.activity.map(activityEntry);
  const activity = entries.slice(-ACTIVITY_LIMIT);
  let lastActivity;
  if (a.activity.length) {
    lastActivity = registered(entries[entries.length - 1], where(a.activity[a.activity.length - 1].prov));
  } else if (isNum(E?.lastProgressAt)) {
    const v = { ts: E.lastProgressAt };
    if (isStr(E.lastToolName)) v.tool = E.lastToolName;
    if (typeof E.lastToolSummary === 'string') v.inputSummary = E.lastToolSummary;
    lastActivity = fin('lastProgressAt', v);
  } else lastActivity = unknown(`no transcript activity seen${noFinalNote}`);

  let toolCalls;
  if (isNum(E?.toolCalls)) toolCalls = fin('toolCalls', E.toolCalls);
  else if (a.activity.length || a.prompts.length) toolCalls = inferred(entries.filter((e) => e.tool !== undefined).length, 'count-of-tool-activity-events');
  else toolCalls = unknown(`no transcript seen${noFinalNote}`);

  let tokens;
  if (isNum(E?.tokens)) tokens = fin('tokens', E.tokens);
  else if (a.usageEv) tokens = inferred(usageTotal(a.usageEv.data.usage), 'latest-transcript-usage');
  else tokens = unknown(`no usage in the transcript seen${noFinalNote}`);

  // usage and byModel: summed over the unique API messages of the transcript (header, P2). Never final: the final file has no such split.
  // Only records the source delivers are counted (header): a message whose records all lack a tool call and text is not in the sum.
  let usage, byModel;
  const sum = sumUsage(a);
  if (sum) {
    const extra = sum.noId ? `; ${plural(sum.noId, 'record')} with no message id counted once each` : '';
    usage = inferred({ ...sum.total }, `sum-over-unique-message-id (${plural(sum.messages, 'message')} in ${plural(sum.records, 'record')} the source delivers${extra}; ${DELIVERED_LIMIT})`);
    byModel = modelSplit(sum.byModel, sum.noModel);
  } else {
    usage = unknown(a.transcript
      ? 'transcript seen, but none of its assistant records the source delivered carries usage'
      : 'no transcript seen for this agent; usage is read from transcript records only');
    byModel = unknown(usage.reason);
  }

  return {
    id: a.id, label, phase, agentType, model, role, unit, round, tag, state,
    startedAt, endedAt, durationMs, prompt, result, lastActivity, toolCalls, tokens, usage, byModel, activity,
  };
}

// ---------------------------------------------------------------- 4. run

function declaredFrom(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const p of list) {
    if (!isObj(p) || !isStr(p.title)) continue;
    out.push(isStr(p.detail) ? { title: p.title, detail: p.detail } : { title: p.title });
  }
  return out;
}

// totals.usage and totals.byModel (header, P2): the agents' sums added up; both unknown while no agent has a usage record. The sum of
// byModel is totals.usage, except for the messages that name no model (counted in usage only, and the method says how many).
function usageTotals(records, agentCount) {
  const sums = records.map(sumUsage).filter((x) => x !== null);
  if (!sums.length) {
    const reason = agentCount === 0 ? 'the run has no agents yet' : 'no agent has a transcript record with usage yet';
    return { usage: unknown(reason), byModel: unknown(reason) };
  }
  const total = zeroUsage();
  const models = new Map();
  let noModel = 0;
  for (const x of sums) {
    for (const k of Object.keys(total)) total[k] += x.total[k];
    noModel += x.noModel;
    for (const [model, u] of x.byModel) {
      let into = models.get(model);
      if (!into) models.set(model, (into = zeroUsage()));
      for (const k of Object.keys(into)) into[k] += u[k];
    }
  }
  const usage = inferred(total, `sum-of-agent-usage (${sums.length} of ${agentCount} agents; records the source delivers only: ${DELIVERED_LIMIT})`);
  return { usage, byModel: modelSplit(models, noModel) };
}

// The first part of the reducer: everything of a Run except what needs the whole Run first (edges, recognised results, the unknown list,
// the warnings). RunSummary (store.listRuns) is made of this part alone; reduceDetailed finishes it.
function reduceBase(events, { now = () => Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const S = collect(events);
  const tNow = typeof now === 'function' ? now() : now;
  const F = S.final?.data ?? null;
  const metaData = isObj(S.script?.data?.meta) ? S.script.data.meta : null;
  const own = warningSink(); // the reducer's own findings; separate from what collect() reports
  const warn = own.add;

  const status = resolveStatus(S, tNow, staleMs);
  const versions = [...S.versions.keys()].sort(compareVersions);
  const ctx = {
    finalEv: S.final, runEnded: status.ended, stale: status.stale, staleReason: status.staleReason,
    statusValue: status.fact.prov === 'unknown' ? null : status.fact.value,
    interruptedRun: status.interrupting, // the run ended as killed or failed
    versions,
  };

  // final-file agent entries
  const finalAgents = new Map();
  const finalPhases = [];
  if (F && Array.isArray(F.workflowProgress)) {
    F.workflowProgress.forEach((entry, i) => {
      if (!isObj(entry)) return;
      if (entry.type === 'workflow_phase') {
        if (isStr(entry.title)) finalPhases.push({ index: isNum(entry.index) ? entry.index : i + 1, title: entry.title });
      } else if (isStr(entry.agentId)) {
        finalAgents.set(entry.agentId, { entry, i });
      } else warn(`final file workflowProgress[${i}] has no agentId and was ignored`);
    });
  }

  // agents: the ones the journal, the agent meta files and the transcripts know. The final file does not create an
  // agent (contract 2: the journal decides which agents exist); it only adds measured values to the ones that exist.
  const records = [...S.agents.values()];
  const finalOnly = [...finalAgents.keys()].filter((id) => !S.agents.has(id));
  if (finalOnly.length) {
    const shown = finalOnly.slice(0, 3).join(', ');
    warn(`final file lists ${finalOnly.length} agent${finalOnly.length === 1 ? '' : 's'} (${shown}${finalOnly.length > 3 ? ', ...' : ''}) that no journal line, agent meta or transcript knows; `
      + 'the journal decides which agents exist, so they are not shown');
  }
  const built = records.map((a) => ({ a, fe: finalAgents.get(a.id) ?? null }))
    .map(({ a, fe }) => ({ a, fe, agent: buildAgent(a, fe, ctx, warn) }));

  const sortKey = ({ a, fe, agent }) => [
    isNum(agent.startedAt.value) ? agent.startedAt.value : Infinity,
    Number.isInteger(a.started?.prov?.line) ? a.started.prov.line : Infinity,
    fe ? fe.i : Infinity,
    a.seq,
  ];
  built.sort((x, y) => {
    const kx = sortKey(x), ky = sortKey(y);
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] < ky[i] ? -1 : 1;
    return 0;
  });
  // ids come from file names and journal data: define own properties so that "__proto__" is a key, not a prototype
  const agents = {};
  for (const { agent } of built) Object.defineProperty(agents, agent.id, { value: agent, enumerable: true, writable: true, configurable: true });
  const order = built.map(({ agent }) => agent.id);

  // phases
  const declared = declaredFrom(metaData?.phases) ?? declaredFrom(F?.phases) ?? [];
  const titles = declared.map((p) => p.title);
  for (const fp of [...finalPhases].sort((x, y) => x.index - y.index)) if (!titles.includes(fp.title)) titles.push(fp.title);
  for (const id of order) {
    const p = agents[id].phase;
    if (p.prov !== 'unknown' && !titles.includes(p.value)) titles.push(p.value);
  }
  const unplaced = order.filter((id) => agents[id].phase.prov === 'unknown').length;
  const phases = titles.map((title, i) => {
    const agentIds = order.filter((id) => agents[id].phase.value === title && agents[id].phase.prov !== 'unknown');
    const list = agentIds.map((id) => agents[id]);
    const starts = list.map((x) => x.startedAt.value).filter(isNum);
    const ends = list.map((x) => x.endedAt.value).filter(isNum);
    // unknown Facts hold null; an interrupted agent is "running" in the model but its phase is not running any more
    const states = list.map((x) => (x.state.prov === 'unknown' ? 'unknown' : x.state.interrupted === true ? 'interrupted' : x.state.value));
    const startedAt = starts.length ? inferred(Math.min(...starts), 'min-of-agent-startedAt') : unknown('no agent of this phase has a known start');
    const allEnded = list.length > 0 && list.every((x) => (x.state.value === 'done' || x.state.value === 'failed') && isNum(x.endedAt.value));
    const endedAt = allEnded ? inferred(Math.max(...ends), 'max-of-agent-endedAt')
      : unknown(list.length ? 'not every agent of this phase has ended' : 'no agent in this phase');
    let state;
    if (!list.length) {
      if (status.ended) state = unknown('no agent ran in this phase');
      else if (unplaced) state = unknown(`${unplaced} agent${unplaced === 1 ? '' : 's'} with an unknown phase exist${unplaced === 1 ? 's' : ''}, so it cannot be told whether this phase has started`);
      else state = inferred('pending', 'no-agents-yet');
    }
    else if (states.includes('running')) state = inferred('running', 'agent-states');
    else if (states.includes('interrupted')) state = inferred('interrupted', 'agent-states');
    else if (states.includes('failed')) state = inferred('failed', 'agent-states');
    else if (states.every((s) => s === 'done')) state = inferred('done', 'agent-states');
    else if (states.includes('unknown')) state = unknown('some agents of this phase have an unknown state');
    else state = inferred('pending', 'agent-states');
    return { title, index: i + 1, agentIds, startedAt, endedAt, state };
  });

  // run-level facts
  const finalFrom = (ptr) => where(S.final?.prov, ptr);
  let name;
  if (isStr(metaData?.name)) name = registered(metaData.name, where(S.script.prov, 'meta.name'));
  else if (isStr(F?.workflowName)) name = finalFact(F.workflowName, finalFrom('workflowName'));
  else name = unknown('no script meta (not seen or not parseable) and no final run file');
  if (name.prov === 'registered' && isStr(F?.workflowName) && F.workflowName !== name.value) warn(`script meta name "${name.value}" differs from the final file's "${F.workflowName}"`);

  let description;
  if (isStr(metaData?.description)) description = registered(metaData.description, where(S.script.prov, 'meta.description'));
  else if (isStr(F?.summary)) description = finalFact(F.summary, finalFrom('summary'));
  else description = unknown('no script meta description and no final run file summary');

  let ccVersion;
  if (versions.length) ccVersion = registered(versions.join(' + '), versions.map((v) => where(S.versions.get(v).prov, 'version')).join(', '));
  else ccVersion = unknown('no source event carries the Claude Code version');

  // Run start: the final file's startTime; else the earliest agent start; else the script file time; else unknown.
  // The script file time is only the last resort: a script file can be saved hours before the run (on 35 local runs, 2026-11-10:
  // within 60 s of the final startTime on 23 of 34 runs, against 33 of 34 for the earliest agent start). An agent start that is only a journal file time (method 'journal-event-ts', coarse) does
  // not win over a start taken from a transcript record (or the final file) of another agent; it counts only when it is
  // the only agent start there is, and the method then says so.
  const agentStartFacts = order.map((id) => agents[id].startedAt).filter((f) => isNum(f.value));
  const smallest = (facts) => facts.reduce((min, f) => (min === null || f.value < min ? f.value : min), null);
  const preciseStart = smallest(agentStartFacts.filter((f) => f.method !== 'journal-event-ts'));
  const coarseStart = smallest(agentStartFacts.filter((f) => f.method === 'journal-event-ts'));
  let startedAt;
  if (isNum(F?.startTime)) startedAt = finalFact(F.startTime, finalFrom('startTime'));
  else if (preciseStart !== null) startedAt = inferred(preciseStart, 'earliest-agent-start');
  else if (coarseStart !== null) startedAt = inferred(coarseStart, 'earliest-agent-start (journal file times, coarse)');
  else if (tsOf(S.script) !== null) startedAt = inferred(tsOf(S.script), 'script-file-time');
  else startedAt = unknown('no final file startTime, no agent start and no script file time');

  const endedParsed = isStr(F?.timestamp) ? Date.parse(F.timestamp) : NaN;
  let endedAt;
  if (Number.isFinite(endedParsed)) endedAt = finalFact(endedParsed, finalFrom('timestamp'));
  else if (F) endedAt = unknown('final file has no readable timestamp');
  else endedAt = unknown(status.fact.value === 'running' ? 'run has not ended' : 'no final run file, so the end time is not recorded');

  let durationMs;
  if (isNum(F?.durationMs)) durationMs = finalFact(F.durationMs, finalFrom('durationMs'));
  else if (F) durationMs = unknown('final file has no durationMs');
  else durationMs = unknown(status.fact.value === 'running' ? 'run is still running; elapsed time is not recorded' : 'no final run file, so the duration is not recorded');

  let logs;
  if (Array.isArray(F?.logs)) logs = finalFact(F.logs, finalFrom('logs'));
  else if (F) logs = unknown('final file has no logs field');
  else logs = unknown('log() lines are written only at the end');

  // The run's own result: the final file's top-level "result", as it is (any JSON, an array too). It is never taken from an agent
  // or from a preview. The final file is written only at the end, and a failed run can have "result": null.
  let result;
  if (F && Object.hasOwn(F, 'result') && F.result !== null) result = finalFact(F.result, finalFrom('result'));
  else if (F && Object.hasOwn(F, 'result')) result = unknown('final file has "result": null');
  else if (F) result = unknown('final file has no "result" field');
  else result = unknown(status.fact.value === 'running' ? 'the run result is written only at the end, in the final file' : 'no final run file, so the run result is not recorded');

  let error;
  if (isStr(F?.error)) error = finalFact(F.error, finalFrom('error'));
  else if (F) error = unknown('final file records no error');
  else error = unknown('run has not ended or has no final run file');

  // totals
  const list = order.map((id) => agents[id]);
  const sumOf = (field, finalValue, finalPtr, method) => {
    if (isNum(finalValue)) return finalFact(finalValue, finalFrom(finalPtr));
    const vals = list.map((x) => x[field].value).filter(isNum);
    if (!vals.length) return unknown(F ? `final file has no ${finalPtr}` : `no agent has reported ${field} yet; the final run file is not written yet`);
    return inferred(vals.reduce((x, y) => x + y, 0), `${method} (${vals.length} of ${list.length} agents)`);
  };
  const totals = {
    agents: list.length,
    running: list.filter((x) => x.state.value === 'running' && x.state.interrupted !== true).length,
    interrupted: list.filter((x) => x.state.interrupted === true).length,
    done: list.filter((x) => x.state.value === 'done').length,
    failed: list.filter((x) => x.state.value === 'failed').length,
    tokens: sumOf('tokens', F?.totalTokens, 'totalTokens', 'sum-of-agent-tokens'),
    toolCalls: sumOf('toolCalls', F?.totalToolCalls, 'totalToolCalls', 'sum-of-agent-toolCalls'),
    ...usageTotals(built.map(({ a }) => a), list.length),
  };

  const srcs = [...S.srcs];
  // Run.source: demo wins, then replay, else real. A run whose events come from several sources is reported, not
  // dropped; the source it gets is the first of that order.
  const demo = srcs.includes('demo');
  const replay = !demo && srcs.includes('replay');
  if ((demo || replay) && srcs.length > 1) warn(`events from several sources (${srcs.join(', ')}) in one run; demo and replay events must never mix with real ones`);

  const run = {
    id: S.id,
    source: demo ? 'demo' : replay ? 'replay' : 'real',
    sessionId: S.sessionId,
    project: S.project,
    ccVersion, name, description, status: status.fact,
    startedAt, endedAt, durationMs,
    declaredPhases: declared,
    phases,
    agents,
    order,
    edges: [],
    registeredEdges: { value: [], prov: 'unknown', reason: 'no source registers dependencies' },
    logs,
    error,
    result,
    recognized: { findings: [], verdicts: [], tests: [] },
    totals,
    unknowns: [],
    warnings: [],
  };
  return { run, S, F, own, warn, status };
}

export function reduceDetailed(events, { now = () => Date.now(), staleMs = DEFAULT_STALE_MS, memo = null } = {}) {
  const { run, S, F, own, warn, status } = reduceBase(events, { now, staleMs });
  // Rule 4 of the dependency inference reads "the run's script text": the final file's `script` is the text that ran
  // (a string in every observed final file); the script read from disk may have been edited after the run (2 of 17 local
  // runs), so it is the fallback for a run that has no final file yet, or whose final file has no script text.
  const scriptText = isStr(F?.script) ? F.script : typeof S.script?.data?.text === 'string' ? S.script.data.text : null;
  try {
    run.edges = inferEdges(run, { warn, memo, scriptText });
    if (scriptText === null && run.edges.some((e) => e.kind === 'data-flow')) {
      warn('edge inference: the script text was not read, so the data-flow edges were not checked against it (text quoted from the script may show as data flow)');
    }
  } catch (err) {
    run.edges = [];
    warn(`edge inference failed (${err?.message ?? err}); no edges are shown for this run`);
  }
  run.recognized = recognize(run);
  run.unknowns = collectUnknowns(run);
  run.warnings = [...S.sink.done(), ...own.done()];
  return { run, staleAt: status.staleAt, lastTs: S.lastTs };
}

export function reduceRun(events, opts = {}) {
  return reduceDetailed(events, opts).run;
}

// The RunSummary of a run and what the clock does to it, from the first part of the reducer alone (no edges, no recognition). It equals
// summaryOf(reduceRun(events, opts)) field for field; the store keeps it between changes of a run (store.listRuns).
export function reduceSummary(events, opts = {}) {
  const { run, S, status } = reduceBase(events, opts);
  return { summary: summaryOf(run), staleAt: status.staleAt, lastTs: S.lastTs };
}

function collectUnknowns(run) {
  const out = [];
  const add = (field, fact) => { if (fact && fact.prov === 'unknown') out.push({ field, reason: fact.reason }); };
  for (const f of ['ccVersion', 'name', 'description', 'status', 'startedAt', 'endedAt', 'durationMs', 'logs', 'result']) add(f, run[f]);
  // a missing error is only worth listing when the run did not end cleanly
  if (run.status.value !== 'completed' && run.status.value !== 'running') add('error', run.error);
  add('totals.tokens', run.totals.tokens);
  add('totals.toolCalls', run.totals.toolCalls);
  add('totals.usage', run.totals.usage);
  add('totals.byModel', run.totals.byModel);
  add('registeredEdges', run.registeredEdges);
  for (const p of run.phases) for (const f of ['startedAt', 'endedAt', 'state']) add(`phases[${p.title}].${f}`, p[f]);
  for (const id of run.order) {
    const a = run.agents[id];
    for (const f of ['label', 'phase', 'agentType', 'model', 'role', 'unit', 'round', 'tag', 'state', 'startedAt', 'endedAt',
      'durationMs', 'prompt', 'result', 'lastActivity', 'toolCalls', 'tokens', 'usage', 'byModel']) add(`agents.${id}.${f}`, a[f]);
  }
  return out;
}

// ---------------------------------------------------------------- 5. store

function summaryOf(run) {
  return {
    id: run.id, name: run.name, status: run.status, project: run.project, startedAt: run.startedAt,
    agents: run.totals.agents, running: run.totals.running, source: run.source,
  };
}

// The stale flip is a function of the clock alone, so nothing in the event stream announces it. While anyone
// listens (store.onChange), one unref'd timer watches the runs last seen as running and fires onChange for a run
// that has since crossed its stale limit, so that an open client gets the same answer as GET /api/runs/:id.
// The timer sleeps until the earliest staleAt but never longer than STALE_CHECK_MAX_MS: the wall clock is
// re-read on every wake-up, because a timer does not count time the machine slept and an injected clock may jump.
export const STALE_CHECK_MAX_MS = 500;

// The event stream (contract 2, sections 4 and 5). Every RawEvent the store applies (a re-emitted line with the same
// content is not applied again; source.warning is applied but is not an event) becomes one UiEvent
//   { runId, seq, ts, kind, agentId?, label?, role?, unit?, message, status?, prov }
// seq counts per run from 1 without gaps; ts is the RawEvent's ts (null when it has none: the store does not make up
// a time); message is one short line built only from the event's own data; status is what the event itself says
// (agent.started "running", agent.result "done", agent.failed "failed", run.final the final file's status text);
// prov is "final" for run.final and "registered" for everything else. The label of an agent is the one known so far
// (journal "started" line, else agent meta description, else the final file's), role and unit come from it by the
// label pattern. The last EVENT_BACKLOG events of a run are kept for eventsSince.
export const EVENT_BACKLOG = 2000;
const MESSAGE_CLIP = 100;

function clip(text, n = MESSAGE_CLIP) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function previewOf(value) {
  if (typeof value === 'string') return clip(value, 80);
  try {
    const t = JSON.stringify(value);
    return typeof t === 'string' ? clip(t, 80) : '';
  } catch { return ''; }
}

// -> { message, status? } for one RawEvent; `who` names the agent (its label, else its id).
function describeEvent(ev, who) {
  const d = isObj(ev.data) ? ev.data : {};
  switch (ev.kind) {
    case 'run.script': {
      const m = isObj(d.meta) ? d.meta : null;
      if (!m) return { message: 'script read (its meta could not be parsed)' };
      const n = Array.isArray(m.phases) ? m.phases.length : null;
      return { message: `script read${isStr(m.name) ? `: ${clip(m.name, 80)}` : ''}${n === null ? '' : ` (${n} phase${n === 1 ? '' : 's'})`}` };
    }
    case 'run.launched':
      return { message: 'run launched' };
    case 'agent.started':
      return { message: `${who} started${isStr(d.phase) ? ` in phase ${clip(d.phase, 60)}` : ''}`, status: 'running' };
    case 'agent.meta':
      return { message: `${who} meta read${isStr(d.agentType) ? ` (${clip(d.agentType, 60)})` : ''}` };
    case 'agent.prompt':
      return { message: `${who} prompt read${typeof d.text === 'string' ? ` (${d.text.length} chars)` : ''}` };
    case 'agent.activity':
      if (isStr(d.tool)) return { message: `${who} ${clip(d.tool, 60)}${isStr(d.inputSummary) ? `: ${clip(d.inputSummary)}` : ''}` };
      if (typeof d.text === 'string' && d.text.trim()) return { message: `${who} wrote: ${clip(d.text)}` };
      return { message: `${who} activity` };
    case 'agent.structured':
      return { message: `${who} structured output` };
    case 'agent.failed':
      return { message: `${who} failed`, status: 'failed' };
    case 'agent.result': {
      const preview = 'result' in d ? previewOf(d.result) : '';
      return { message: `${who} done${preview ? `: ${preview}` : ''}`, status: 'done' };
    }
    case 'run.final': {
      const status = isStr(d.status) ? d.status : undefined;
      const agents = isNum(d.agentCount) ? `, ${d.agentCount} agent${d.agentCount === 1 ? '' : 's'}` : '';
      const out = { message: `final file written${status ? `: run ${status}` : ''}${agents}` };
      if (status) out.status = status;
      return out;
    }
    default:
      return { message: `${clip(ev.kind, 60)} event` };
  }
}

// What names an agent in the events of its run: label from the journal "started" line (3), else the agent meta's
// description (2), else the final file's (1) - the same order the reducer uses.
function trackLabel(labels, ev, agentId) {
  const d = isObj(ev.data) ? ev.data : {};
  const put = (id, label, rank) => {
    if (!isStr(id) || !isStr(label)) return;
    const cur = labels.get(id);
    if (!cur || rank >= cur.rank) labels.set(id, { label, rank });
  };
  if (ev.kind === 'agent.started') put(agentId, d.label, 3);
  else if (ev.kind === 'agent.meta') put(agentId, d.description, 2);
  else if (ev.kind === 'run.final' && Array.isArray(d.workflowProgress)) {
    for (const e of d.workflowProgress) if (isObj(e) && e.type !== 'workflow_phase') put(e.agentId, e.label, 1);
  }
}

export function createStore({ now = () => Date.now(), staleMs = DEFAULT_STALE_MS, onBuild = null } = {}) {
  // onBuild({ runId, kind: 'run' | 'summary' }) is a test hook: told once per reduce, so a test can count the builds instead of timing them
  const built = (runId, kind) => { if (typeof onBuild === 'function') { try { onBuild({ runId, kind }); } catch { /* a hook must not break the store */ } } };
  const runs = new Map(); // runId -> { events, seen: Map(dedupe key -> content sig), version, cache, sum, memo, ui, seq, labels }
  const listeners = new Set();
  const eventListeners = new Set();
  let staleTimer = null;

  function notify(runId) {
    for (const cb of [...listeners]) {
      try { cb(runId); } catch { /* a failing listener must not break the others or the source */ }
    }
  }

  function emitUiEvent(rec, ev) {
    const d = isObj(ev.data) ? ev.data : {};
    const agentId = ev.kind.startsWith('agent.') ? (isStr(d.agentId) ? d.agentId : agentIdFromFile(ev.prov?.file)) : null;
    trackLabel(rec.labels, ev, agentId);
    const label = agentId !== null ? rec.labels.get(agentId)?.label : undefined;
    const { message, status } = describeEvent(ev, label ?? agentId ?? 'agent');
    const ui = { runId: ev.runId, seq: ++rec.seq, ts: tsOf(ev), kind: ev.kind };
    if (agentId !== null) ui.agentId = agentId;
    if (label !== undefined) {
      ui.label = label;
      const p = parseLabel(label);
      if (p.role !== null) ui.role = p.role;
      if (p.unit !== null) ui.unit = p.unit;
    }
    ui.message = message;
    if (status !== undefined) ui.status = status;
    ui.prov = ev.kind === 'run.final' ? 'final' : 'registered';
    Object.freeze(ui); // every field is a plain value, so the same object can go to every listener and stay in the backlog
    rec.ui.push(ui);
    if (rec.ui.length > EVENT_BACKLOG) rec.ui.shift();
    for (const cb of [...eventListeners]) {
      try { cb(ui); } catch { /* a failing listener must not break the others or the source */ }
    }
  }

  function apply(ev) {
    if (!isObj(ev) || !isStr(ev.runId)) return null;
    let rec = runs.get(ev.runId);
    if (!rec) {
      rec = { events: [], seen: new Map(), version: 0, cache: null, sum: null, memo: {}, ui: [], seq: 0, labels: new Map() };
      runs.set(ev.runId, rec);
    }
    const key = dedupeKey(ev);
    if (key !== null) {
      const sig = contentSig(ev);
      if (rec.seen.get(key) === sig) return ev.runId; // a re-emitted line with the same content changes nothing
      rec.seen.set(key, sig); // new, or the line was rewritten: reduceRun lets the newer content win
    }
    rec.events.push(ev);
    rec.version++;
    if (typeof ev.kind === 'string' && ev.kind !== 'source.warning') emitUiEvent(rec, ev);
    notify(ev.runId);
    return ev.runId;
  }

  function getRun(id) {
    const rec = runs.get(id);
    if (!rec) return null;
    const t = now();
    const c = rec.cache;
    if (c && c.version === rec.version && cacheHolds(c, t)) return c.run;
    built(id, 'run');
    const { run, staleAt, lastTs } = reduceDetailed(rec.events, { now: () => t, staleMs, memo: rec.memo });
    rec.cache = { version: rec.version, at: t, run, staleAt, lastTs };
    if (isWatched(rec.cache)) armStaleTimer();
    return run;
  }

  // The RunSummary of a run (listRuns). The Run cached by getRun answers it when that Run is still the current one; otherwise the summary
  // kept from the last time is used while the run has no new event and the clock has not changed what the summary says (the same
  // rule as for the Run: cacheHolds); otherwise it is built again, from the first part of the reducer only.
  function summaryFor(id) {
    const rec = runs.get(id);
    const t = now();
    const c = rec.cache;
    if (c && c.version === rec.version && cacheHolds(c, t)) return summaryOf(c.run);
    const s = rec.sum;
    if (s && s.version === rec.version && cacheHolds(s, t)) return s.summary;
    built(id, 'summary');
    const { summary, staleAt, lastTs } = reduceSummary(rec.events, { now: () => t, staleMs });
    rec.sum = { version: rec.version, at: t, summary, staleAt, lastTs };
    return summary;
  }

  // The only clock-dependent output is the stale flip at staleAt, and, once stale, the reasons that
  // quote how long the run has been silent. Keep the cached Run only while both are still true.
  function cacheHolds(c, t) {
    if (c.staleAt === null) return true;
    const wasStale = c.at > c.staleAt;
    const isStale = t > c.staleAt;
    if (wasStale !== isStale) return false;
    return !isStale || duration(t - c.lastTs) === duration(c.at - c.lastTs);
  }

  // A cached Run that was built before its stale limit: if the clock has passed the limit since, a client that
  // holds this Run still shows "running" and has to be told.
  const isWatched = (c) => c.staleAt !== null && c.at <= c.staleAt;

  function armStaleTimer() {
    if (staleTimer !== null || listeners.size === 0) return;
    let next = Infinity;
    for (const rec of runs.values()) if (rec.cache && isWatched(rec.cache)) next = Math.min(next, rec.cache.staleAt);
    if (next === Infinity) return;
    const delay = Math.min(STALE_CHECK_MAX_MS, Math.max(1, next - now() + 1));
    staleTimer = setTimeout(checkStale, delay);
    staleTimer.unref?.();
  }

  function disarmStaleTimer() {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
  }

  function checkStale() {
    staleTimer = null;
    if (listeners.size === 0) return;
    const t = now();
    const due = [];
    for (const [id, rec] of runs) if (rec.cache && isWatched(rec.cache) && t > rec.cache.staleAt) due.push(id);
    for (const id of due) {
      getRun(id); // reduce again with the clock as it is now
      const c = runs.get(id).cache;
      // still not stale after the re-reduce: a newer event had moved the limit, and apply() has told the listeners
      if (c.staleAt !== null && c.at > c.staleAt) notify(id);
    }
    armStaleTimer();
  }

  function listRuns() {
    const out = [];
    for (const id of runs.keys()) out.push(summaryFor(id));
    out.sort((x, y) => {
      const sx = isNum(x.startedAt.value) ? x.startedAt.value : -Infinity;
      const sy = isNum(y.startedAt.value) ? y.startedAt.value : -Infinity;
      if (sx !== sy) return sx > sy ? -1 : 1; // newest first, unknown start last
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    return out;
  }

  function onChange(cb) {
    listeners.add(cb);
    armStaleTimer(); // runs read before the first listener came may already be watched
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) disarmStaleTimer();
    };
  }

  function onEvent(cb) {
    eventListeners.add(cb);
    return () => { eventListeners.delete(cb); };
  }

  // The UiEvents of a run with seq greater than `seq` (0 or less: all kept), oldest first; at most the last
  // EVENT_BACKLOG of the run. An unknown run has none.
  function eventsSince(runId, seq) {
    const rec = runs.get(runId);
    if (!rec) return [];
    const after = Number.isFinite(Number(seq)) ? Number(seq) : 0;
    return rec.ui.filter((e) => e.seq > after);
  }

  return { apply, getRun, listRuns, onChange, onEvent, eventsSince };
}
