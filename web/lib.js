// wfviz interface, pure part (no DOM, no fetch): everything the page decides from run data. The page (app.js) only
// draws what these functions return, so the logic can be tested with plain node (test/server/web-lib.test.mjs).
// Nothing here knows a workflow: roles, units, tags, states and labels all come from the Run and the events.

export const val = (f) => (f && typeof f === 'object' && 'prov' in f ? f.value : f);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;

export function agentsOf(run) {
  if (!run || !run.agents) return [];
  return (run.order || Object.keys(run.agents)).map((id) => run.agents[id]).filter(Boolean);
}

// ---------- agent state ----------

// The model keeps an agent that was still running when its run ended as killed or failed in state "running" and marks
// the state Fact `interrupted: true` with a `note`. It is not busy: no growing bar, its own style.
export const isInterrupted = (a) => a?.state?.interrupted === true;
export const agentState = (a) => val(a?.state) || 'unknown';
export const visualState = (a) => (isInterrupted(a) ? 'interrupted' : agentState(a));
// The model's own note; when it gives none the page does not word a reason of its own.
export const interruptNote = (a) => (isStr(a?.state?.note) ? a.state.note : 'interrupted (no note)');
// running and not interrupted: the agents that are busy now
export const isBusy = (a) => agentState(a) === 'running' && !isInterrupted(a);

// The tag of an agent (text after the last "#" of its label), or null: most agents have none, and that is not worth a "?".
export function tagOf(a) {
  const f = a?.tag;
  if (!f || f.prov === 'unknown') return null;
  const v = val(f);
  return isStr(v) ? v : null;
}

// Where an interrupted agent's bar ends: its last recorded activity if that is known and not before its start, else its
// start. Never "now" (the bar must not grow) and never an invented end time.
export function interruptedEnd(a) {
  const s = val(a?.startedAt);
  const last = val(a?.lastActivity)?.ts;
  if (typeof s !== 'number') return null;
  return typeof last === 'number' && last >= s ? last : s;
}

// The latest time the Run itself records: the largest start, end or last-activity time of its agents, or null. For a run whose
// times are not on the clock now (a replay) this is where "now" stands in the run.
export function latestRecorded(run) {
  let max = null;
  for (const a of agentsOf(run)) {
    for (const t of [val(a.startedAt), val(a.endedAt), val(a.lastActivity)?.ts]) {
      if (typeof t === 'number' && Number.isFinite(t) && (max === null || t > max)) max = t;
    }
  }
  return max;
}

// Where the timeline bar of an agent with a known start ends (null without a start): its end time; for an interrupted agent its last
// recorded activity; for a running agent now, or, in a run whose times are not on the clock now (a replay), the latest time the
// Run records (never the wall clock); for any other agent its start. No end time is made up.
export function barEnd(a, run, now) {
  const s = val(a?.startedAt);
  if (typeof s !== 'number') return null;
  if (isInterrupted(a)) return interruptedEnd(a) ?? s;
  const e = val(a.endedAt);
  if (e) return e;
  if (agentState(a) !== 'running') return s;
  if (countsFromNow(run)) return now;
  const last = latestRecorded(run);
  return typeof last === 'number' && last >= s ? last : s;
}

// ---------- matrix ----------

// Agents whose label parsed as role:unit (both known). One such agent is enough for the matrix.
export function parsedAgents(run) {
  return agentsOf(run).filter((a) => val(a.role) && val(a.unit));
}
export function matrixRoles(parsed) {
  const roles = [];
  for (const a of parsed) {
    const r = val(a.role);
    if (!roles.includes(r)) roles.push(r);
  }
  return roles;
}
export function matrixUnits(parsed) {
  const units = [];
  for (const a of parsed) {
    const u = val(a.unit);
    if (!units.includes(u)) units.push(u);
  }
  return units;
}

// ---------- run status ----------

// A run is final when its status is a text read from the final file (completed, failed, killed or any other text),
// except "running": a final file that says the run is running does not end it.
export function isFinalStatus(status) {
  return !!status && status.prov === 'final' && isStr(status.value) && status.value !== 'running';
}

// ---------- where a recognised item comes from ----------

// The model gives every recognised item a scope: "agent" (found in the result of an agent) or "run" (found in the Run's own result, the
// final file's "result"; no agent owns it, its agentId is null). Only the text "run" is run scope: a missing or any other scope is an
// agent item, so one function decides it for every list and count on the page.
export const isRunScope = (item) => item?.scope === 'run';
const RUN_RESULT_LABEL = 'run result';
// The name under which an item of the run result is listed (where an agent's label would stand): the place of the item in the result tells
// two of them apart.
export const runItemLabel = (item) => (isStr(item?.path) ? `${RUN_RESULT_LABEL} · ${item.path}` : RUN_RESULT_LABEL);

// The recognised items of a Run split by scope, each list in the model's order. A Run without `recognized` has none.
export function scopeSplit(run) {
  const rec = run?.recognized;
  const list = (x) => (Array.isArray(x) ? x : []);
  const out = { agent: { findings: [], verdicts: [], tests: [] }, run: { findings: [], verdicts: [], tests: [] } };
  for (const kind of ['findings', 'verdicts', 'tests']) for (const item of list(rec?.[kind])) out[isRunScope(item) ? 'run' : 'agent'][kind].push(item);
  return out;
}

// What the run-result drawer shows: the Run's own result as text with its provenance, or why the Run has none. A text result is shown as it
// is, any other value as indented JSON.
export function runResultView(run) {
  const f = run?.result;
  if (!f || f.prov === 'unknown' || f.value === null || f.value === undefined) {
    return { known: false, prov: 'unknown', from: null, text: null, reason: isStr(f?.reason) ? f.reason : 'the Run has no run result' };
  }
  return { known: true, prov: f.prov, from: isStr(f.from) ? f.from : null, text: typeof f.value === 'string' ? f.value : JSON.stringify(f.value, null, 2), reason: null };
}

export function testsEmptyMessage(run) {
  return val(run?.status) === 'running'
    ? 'no test agent has reported yet'
    : 'no test counts recognised in agent results or in the run result';
}

// ---------- report card ----------

const STATE_ORDER = ['done', 'failed', 'interrupted', 'running', 'queued', 'unknown'];

// Every number comes from the Run. What the Run does not have is a Fact with prov "unknown" and its reason.
export function reportCard(run) {
  const agents = agentsOf(run);
  const counts = {};
  for (const a of agents) counts[visualState(a)] = (counts[visualState(a)] || 0) + 1;
  const states = STATE_ORDER.filter((s) => counts[s]).map((s) => ({ state: s, count: counts[s] }));
  for (const s of Object.keys(counts)) if (!STATE_ORDER.includes(s)) states.push({ state: s, count: counts[s] });

  const by = scopeSplit(run);
  const byVerdict = {};
  for (const v of by.agent.verdicts) {
    const k = String(v.verdict ?? v.value);
    byVerdict[k] = (byVerdict[k] || 0) + 1;
  }
  const unknown = (reason) => ({ value: null, prov: 'unknown', reason });
  // The run's test total is the run result's one tests item, and nothing else: no agent report stands in for it, and several items
  // in the run result do not add up (which of them is the total is not for the page to guess).
  const runTests = by.run.tests;
  let total = null;
  let reason = null;
  if (runTests.length === 1) {
    const t = runTests[0];
    total = { passed: t.passed, failed: t.failed, skipped: t.skipped, ...('todo' in t ? { todo: t.todo } : {}), method: t.method, from: t.from, prov: 'inferred' };
  } else if (runTests.length > 1) reason = `the run result has ${runTests.length} test results; a run total needs exactly one`;
  else if (!run?.result) reason = 'the Run has no run result';
  else if (run.result.prov === 'unknown') reason = isStr(run.result.reason) ? run.result.reason : 'the run result is unknown';
  else reason = 'no test counts recognised in the run result (a "tests" object, passed/failed/skipped numbers or a node --test summary)';
  const inRun = { findings: by.run.findings.length, verdicts: by.run.verdicts.length, tests: runTests.length };
  return {
    status: run?.status ?? unknown('the run has no status'),
    durationMs: run?.durationMs ?? unknown('the run has no duration'),
    error: run?.error && run.error.prov !== 'unknown' ? run.error : null,
    agents: { total: agents.length, states },
    // `reports`: the test results the agents reported; `total`: the run total (or null, and then `reason` says why there is none)
    tests: { reports: by.agent.tests.length, total, reason },
    // findings and verdicts: those of the agents; what the run result holds is counted apart (null when it holds none)
    findings: by.agent.findings.length,
    verdicts: { total: by.agent.verdicts.length, byValue: byVerdict },
    inRunResult: inRun.findings || inRun.verdicts || inRun.tests ? inRun : null,
  };
}

// ---------- usage and cost (P2) ----------

// What the page says once about every engine whose calls are not in Claude Code's files. It names no engine: the page does not know which
// ones an agent called.
export const ENGINES_NOTE = 'Tokens and cost cover Claude Code agents only; other engines called from an agent are not in Claude Code files and are not counted.';

// The four counters of Agent.usage and totals.usage, in the order the page shows them, with the key of the price each is multiplied by in
// GET /api/prices (USD per token).
export const USAGE_PARTS = [
  { key: 'input', label: 'input tokens', price: 'input' },
  { key: 'output', label: 'output tokens', price: 'output' },
  { key: 'cacheRead', label: 'cache read tokens', price: 'cacheRead' },
  { key: 'cacheWrite', label: 'cache write tokens', price: 'cacheWrite' },
];

const isCount = (x) => typeof x === 'number' && Number.isFinite(x);

// A usage value of the Run, or null when the Fact is unknown or has no counter.
export function usageValue(factOrValue) {
  const v = val(factOrValue);
  return isObj(v) && USAGE_PARTS.some((p) => isCount(v[p.key])) ? v : null;
}

const allZero = (u) => USAGE_PARTS.every((p) => !(u[p.key] > 0));

// The OpenRouter id of a transcript model id, by one rule and no other: claude-<family>-<major>[-<minor>] is anthropic/claude-<family>-<major>[.<minor>]
// (claude-sonnet-5-5 is anthropic/claude-sonnet-5.5, claude-opus-5 is anthropic/claude-opus-5). Anything else (an alias, <synthetic>, a dated id) has
// none: no fuzzy match. Observed on 2026-11-11: every Claude model id in the local transcripts matches an entry of OpenRouter's list this way.
const OPENROUTER_RULE = /^(claude-[a-z]+)-(\d+)(?:-(\d+))?$/;
export function openRouterId(modelId) {
  const m = typeof modelId === 'string' ? OPENROUTER_RULE.exec(modelId) : null;
  if (!m) return null;
  return `anthropic/${m[1]}-${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
}

const RULE_TEXT = 'anthropic/ + the transcript id with the minor number after a dot';

// The price entry of GET /api/prices for a transcript model id: { id, price, from } or { reason }.
export function priceFor(prices, modelId) {
  const id = openRouterId(modelId);
  if (id === null) return { reason: `${modelId} has no OpenRouter id (the rule matches ids like claude-<family>-<major>[-<minor>] only)` };
  const models = isObj(prices?.models) ? prices.models : null;
  if (models === null) return { reason: 'the price list has no models' };
  if (!Object.hasOwn(models, id) || !isObj(models[id])) return { reason: `${id} is not in the price list` };
  return { id, price: models[id], from: modelId };
}

// tokens x price per token, for one model's usage. A part with 0 tokens costs 0 whatever its price; a part with tokens and no price makes the
// cost unknown and names the part. Never adds the cache read to the input: they are separate counters with separate prices.
export function costOf(usage, price) {
  let usd = 0;
  const missing = [];
  for (const part of USAGE_PARTS) {
    const tokens = usage?.[part.key];
    if (!(tokens > 0)) continue;
    const per = price?.[part.price];
    if (!isCount(per)) { missing.push(part.label.replace(' tokens', '')); continue; }
    usd += tokens * per;
  }
  return missing.length ? { usd: null, reason: `no price for ${missing.join(' and ')}`, missing } : { usd };
}

// The tokens are those of the records the source delivers: a message with no tool call and no text is billed but not counted (the usage methods say so).
const PRICE_BASIS = 'cache write at the 5-minute rate, base prices (overrides are not applied); tokens of the records the source delivers only (a message with no tool call and no text is not counted)';

// The cost of a run: its totals.byModel priced model by model. Known only when every model that has tokens has an OpenRouter price for each
// of its parts; otherwise { reason } names the models, and no partial sum is given as the total. Tokens of messages that name no model are
// in totals.usage and not in totals.byModel (contract section 2): they are not priced, and the result says how many were left out (`leftOut`,
// absent when none); a usage that is not a usage value cannot say, so then the cost is unknown with the usage's reason. When only some of the
// Run's agents have a usage, the result also says how many (`agents: { known, all }`, absent when every agent has one), so that the cost is not read
// as the cost of the whole Run, and its method says the others have no usage in the run files.
// -> { usd, method, leftOut?, agents? } | { reason }
export function runCost(run, prices) {
  const by = run?.totals?.byModel;
  const models = isObj(val(by)) ? val(by) : null;
  if (models === null) return { reason: isStr(by?.reason) ? by.reason : 'the Run has no usage by model' };
  return costOfModels(Object.entries(models), prices, run?.totals?.usage, agentCount(run));
}

// How many of the Run's agents have a known usage and how many there are: counted from Run.agents (every own key of it, an id such as `__proto__`
// too), never from the text of totals.usage. An agent has a known usage when its usage is a usage value (an all-zero one is known; an unknown Fact,
// no usage and {} are not). -> { known, all } when they differ, else null: every agent has one, or the Run has no agents object (nothing to say).
function agentCount(run) {
  if (!isObj(run?.agents)) return null;
  let all = 0;
  let known = 0;
  for (const [, agent] of Object.entries(run.agents)) {
    if (!isObj(agent)) continue;
    all++;
    if (usageValue(agent.usage) !== null) known++;
  }
  return known === all ? null : { known, all };
}

// what a cost says when only some agents have a usage (the others are not in totals.byModel): the amount is that of `known` of the `all`
// (the noun follows `all`, with the same test as agentsNote: "agent" for exactly 1, "agents" for every other number)
const agentsText = ({ known, all }) => `for ${String(known)} of ${String(all)} ${all === 1 ? 'agent' : 'agents'}`;
const agentsNote = ({ known, all }) => (all - known === 1
  ? 'the other agent has no usage in the run files, so it is not priced'
  : `the other ${String(all - known)} agents have no usage in the run files, so they are not priced`);

// The cost of one agent: its Agent.byModel priced model by model, exactly as the run's cost is (with the same note for the tokens of messages
// with no model). The agent's usage is priced by the models of the messages that were counted, never by Agent.model: that one is the final
// file's or the last record's model (it can carry a suffix such as "[1m]" that no transcript record has, or be <synthetic>, a zero-usage
// placeholder), so it is not the model of the tokens.
export function agentCost(agent, prices) {
  const by = agent?.byModel;
  const models = isObj(val(by)) ? val(by) : null;
  if (models === null) return { reason: isStr(by?.reason) ? by.reason : 'the agent has no usage by model' };
  return costOfModels(Object.entries(models), prices, agent?.usage);
}

// The tokens that are in the usage and in no model of the split: for each of the four counters the usage less the sum over the split, never
// below 0 (a split that adds up to more than the usage leaves nothing out). A whole number.
function tokensWithNoModel(usage, entries) {
  let left = 0;
  for (const p of USAGE_PARTS) {
    let split = 0;
    for (const [, u] of entries) if (isObj(u) && isCount(u[p.key])) split += u[p.key];
    left += Math.max(0, (isCount(usage[p.key]) ? usage[p.key] : 0) - split);
  }
  return Math.round(left);
}

// what a cost says it leaves out: N is written as a plain integer (a locale would put separators in it)
const withoutText = (n) => `without ${String(n)} tokens of messages with no model`;

function costOfModels(entries, prices, usageFact, agents = null) {
  const usage = usageValue(usageFact);
  if (usage === null) return { reason: isStr(usageFact?.reason) ? usageFact.reason : 'the usage is not a usage value, so the tokens the split by model leaves out cannot be told' };
  let usd = 0;
  const used = [];
  const problems = [];
  for (const [model, u] of entries) {
    if (!isObj(u)) continue;
    if (allZero(u)) continue; // no tokens, nothing to price (<synthetic> records carry all-zero usage)
    const hit = priceFor(prices, model);
    if (hit.reason) { problems.push(`${model}: ${hit.reason}`); continue; }
    const c = costOf(u, hit.price);
    if (c.reason) { problems.push(`${model} (${hit.id}): ${c.reason}`); continue; }
    usd += c.usd;
    used.push(`${hit.from} -> ${hit.id}`);
  }
  if (problems.length) return { reason: `no OpenRouter price for ${problems.join('; ')}` };
  const named = used.length ? used.join(', ') : 'no model has tokens';
  const method = `tokens x OpenRouter prices per token of ${named} (${RULE_TEXT}); ${PRICE_BASIS}${agents === null ? '' : `; ${agentsNote(agents)}`}`;
  const leftOut = tokensWithNoModel(usage, entries);
  const priced = leftOut > 0
    ? { usd, method: `${method}; ${withoutText(leftOut)} (they are in the usage and not in the split by model, so they are not priced)`, leftOut }
    : { usd, method };
  return agents === null ? priced : { ...priced, agents };
}

// local HH:MM of a time in ms; '' for anything that is not a time
export function clockText(ms) {
  if (!isCount(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function usdText(usd) {
  if (usd === 0) return '0.00';
  if (usd >= 1) return usd.toFixed(2);
  return usd >= 0.00005 ? usd.toFixed(4) : '<0.0001';
}

// The text of a failure to get the price list: why it is not there (the server's reason, else the request's own).
export const pricesFailText = (reason) => `OpenRouter prices not available: ${isStr(reason) ? reason : 'no reason given'}`;

// The cost line of one thing (a run or an agent) as a view the page draws: { kind: 'loading' } while the list is out,
// { kind: 'unknown', reason }, or { kind: 'known', text, fact } with the Fact the cost is: inferred, method naming the OpenRouter ids.
// `priceState` is what the page knows about the list: { phase: 'idle' | 'loading' | 'ok' | 'failed', data, reason }. `has` says whether there
// is any usage to price (without it the answer is unknown with `reason`, and no list is needed); `compute(prices)` is runCost or agentCost.
export function costView({ has, reason, compute }, priceState) {
  if (!has) return { kind: 'unknown', reason };
  if (priceState?.phase === 'failed') return { kind: 'unknown', reason: pricesFailText(priceState.reason) };
  if (priceState?.phase !== 'ok') return { kind: 'loading' };
  const c = compute(priceState.data);
  if (c.reason) return { kind: 'unknown', reason: c.reason };
  const clock = clockText(priceState.data?.fetchedAt);
  return {
    kind: 'known',
    text: `~ $${usdText(c.usd)}${c.agents ? ` ${agentsText(c.agents)}` : ''}${c.leftOut > 0 ? `, ${withoutText(c.leftOut)}` : ''} (OpenRouter prices, fetched ${clock !== '' ? clock : 'at an unknown time'})`,
    fact: { value: c.usd, prov: 'inferred', method: c.method },
  };
}

export const runCostView = (run, priceState) => costView({
  has: isObj(val(run?.totals?.byModel)),
  reason: isStr(run?.totals?.byModel?.reason) ? run.totals.byModel.reason : 'the Run has no usage by model',
  compute: (prices) => runCost(run, prices),
}, priceState);

export const agentCostView = (agent, priceState) => costView({
  has: isObj(val(agent?.byModel)),
  reason: isStr(agent?.byModel?.reason) ? agent.byModel.reason : isStr(agent?.usage?.reason) ? agent.usage.reason : 'the agent has no usage by model',
  compute: (prices) => agentCost(agent, prices),
}, priceState);

// A Run of source "demo": its tokens are made up, so the page shows no cost for it and never asks for prices on its account (contract section 4,
// GET /api/prices). A Run with no `source` is not a demo Run.
export const isDemoRun = (run) => run?.source === 'demo';

// Whether a cost may be shown for something of this Run at all: the Run is an object and is no demo Run (a Run with no `source` is no demo Run;
// `{}` is a Run). Nothing is known of a Run that is not given, so for it no cost is shown and no price list is asked for.
export const showsCost = (run) => isObj(run) && !isDemoRun(run);

// Whether showing the cost of this thing needs the price list at all: it does when the thing has usage and its Run shows a cost. A run or an agent
// without usage never makes the page ask for prices. An agent does not know the source of its Run, so the Run is the second argument and it is
// required: without one (undefined, null, not an object) the answer is false, never "not a demo".
export const runNeedsPrices = (run) => showsCost(run) && isObj(val(run?.totals?.byModel));
export const agentNeedsPrices = (agent, run) => showsCost(run) && isObj(val(agent?.byModel));

// The four counters of a usage Fact, each as a Fact of its own that keeps the provenance and the method of the usage Fact, in the order the
// page shows them: [{ key, label, fact }]. null when the usage Fact is unknown (the page then shows that Fact, with its reason). A counter the
// value does not have is an unknown Fact of its own, never 0.
export function usageParts(usageFact) {
  const u = usageValue(usageFact);
  if (u === null) return null;
  const { prov, method, from } = usageFact;
  return USAGE_PARTS.map((p) => ({
    key: p.key,
    label: p.label,
    fact: isCount(u[p.key])
      ? { value: u[p.key], prov, ...(method !== undefined ? { method } : {}), ...(from !== undefined ? { from } : {}) }
      : { value: null, prov: 'unknown', reason: `the usage value has no ${p.key} counter` },
  }));
}

// What GET /api/prices answered, as the page keeps it: { ok: true } for a list with a models map, else { ok: false, reason }.
export function pricesAnswer(data) {
  if (!isObj(data) || !isObj(data.models)) return { ok: false, reason: 'the answer is not a price list' };
  return { ok: true };
}

// ---------- edit diffs ----------

const FILE_KEYS = ['file_path', 'path', 'notebook_path'];
const OLD_KEYS = new Set(['old_string']);
const NEW_KEYS = new Set(['new_string', 'content', 'file_text', 'new_source']);

// The fields of one input object as blocks. Known names say old or new text; every other string field is shown too, under
// its own name (field names are not assumed); numbers and booleans are shown as flags. The file field is not a block.
function blocksOf(obj, skip) {
  const blocks = [];
  for (const [name, v] of Object.entries(obj)) {
    if (skip.has(name)) continue;
    if (typeof v === 'string') blocks.push({ kind: OLD_KEYS.has(name) ? 'old' : NEW_KEYS.has(name) ? 'new' : 'other', name, text: v });
    else if (typeof v === 'number' || typeof v === 'boolean') blocks.push({ kind: 'flag', name, text: String(v) });
  }
  return blocks;
}

// One activity entry with an input -> what the diff panel shows. `file` is the first of file_path, path, notebook_path
// that is a string (null when there is none). `edits` are the items of an `edits` array (MultiEdit), each with its own blocks.
export function editDiff(entry) {
  const input = isObj(entry?.input) ? entry.input : null;
  const out = {
    tool: isStr(entry?.tool) ? entry.tool : null,
    ts: typeof entry?.ts === 'number' ? entry.ts : null,
    summary: typeof entry?.inputSummary === 'string' ? entry.inputSummary : null,
    file: null,
    blocks: [],
    edits: [],
    truncated: entry?.inputTruncated === true,
    hasInput: input !== null,
  };
  if (!input) return out;
  const fileKey = FILE_KEYS.find((k) => isStr(input[k]));
  out.file = fileKey ? input[fileKey] : null;
  out.blocks = blocksOf(input, new Set(fileKey ? [fileKey] : []));
  if (Array.isArray(input.edits)) {
    out.edits = input.edits.filter(isObj).map((e) => ({ blocks: blocksOf(e, new Set()) }));
  }
  return out;
}

export const hasEditInput = (entry) => isObj(entry) && (isObj(entry.input) || entry.inputTruncated === true);

// ---------- event log lines ----------

// One line of the bottom log: time, actor (the label, else the agent id), message, status. A run-level event (no agent)
// is attributed to "run" because its kind says so (run.script, run.launched, run.final); any other has no actor.
export function eventLine(ev) {
  const actor = isStr(ev?.label) ? ev.label : isStr(ev?.agentId) ? ev.agentId : String(ev?.kind || '').startsWith('run.') ? 'run' : '';
  return {
    ts: typeof ev?.ts === 'number' ? ev.ts : null,
    actor,
    message: typeof ev?.message === 'string' ? ev.message : '',
    status: isStr(ev?.status) ? ev.status : null,
  };
}

// ---------- the event log of the selected run ----------

// A line of the log is an event or a `{ missing, from, to }` marker that says how many events the server no longer has. Only
// events are counted, for the cap and for the header: a marker is not an event.
export const isMarker = (x) => x?.missing !== undefined;
export const countEvents = (lines) => {
  let n = 0;
  for (const x of Array.isArray(lines) ? lines : []) if (!isMarker(x)) n++;
  return n;
};

// Holds the events of one run in seq order (at most `cap` events), fed by the backlog (GET .../events) and by live events.
//   reset(runId)  start over for another run
//   push(ev)      one live event -> { status: 'added' | 'duplicate' | 'held' | 'gap' | 'ignored', lines }
//   load(events)  a backlog -> { added, gap }: the events that were new, and whether a gap is still open
//   maxSeen       the highest seq seen for this run (the log itself keeps the last `cap` events)
//   eventCount    the event lines held (the markers are not counted)
// When the cap drops the oldest events, a marker that is left with no event before it goes too: its gap is older than every event shown.
// A live event that arrives before the backlog is held and applied after it. A live event whose seq is not last + 1 means
// events were missed: it is held, push answers 'gap', and the page re-reads the backlog since `last`. If the backlog does
// not close the gap (those events are gone), the held events are accepted and a `{ missing, from, to }` line says so.
export function createEventLog({ cap = 2000 } = {}) {
  let runId = null;
  let lines = [];
  let last = 0;
  let ready = false;
  let gapOpen = false;
  let gapTries = 0;
  let held = [];
  let maxSeen = 0; // the highest seq of this run that reached the log, held events included
  let eventN = 0; // the event lines in `lines`

  const addLine = (x) => {
    lines.push(x);
    if (!isMarker(x)) eventN++;
  };
  const trim = () => {
    if (eventN <= cap) return;
    let drop = 0;
    while (eventN > cap) {
      if (!isMarker(lines[drop])) eventN--;
      drop++;
    }
    while (drop < lines.length && isMarker(lines[drop])) drop++;
    lines = lines.slice(drop);
  };

  function drain(force) {
    held.sort((x, y) => x.seq - y.seq);
    const added = [];
    while (held.length) {
      const ev = held[0];
      if (ev.seq <= last) {
        held.shift();
        continue;
      }
      if (ev.seq !== last + 1) {
        if (!force) return { added, gap: true };
        const marker = { missing: ev.seq - last - 1, from: last + 1, to: ev.seq - 1 };
        addLine(marker);
        added.push(marker);
      }
      held.shift();
      addLine(ev);
      added.push(ev);
      last = ev.seq;
    }
    return { added, gap: false };
  }

  return {
    reset(id) {
      runId = id;
      lines = [];
      eventN = 0;
      last = 0;
      ready = false;
      gapOpen = false;
      gapTries = 0;
      held = [];
      maxSeen = 0;
    },
    get runId() { return runId; },
    get maxSeen() { return maxSeen; },
    get lines() { return lines; },
    get eventCount() { return eventN; },
    get last() { return last; },
    get ready() { return ready; },
    push(ev) {
      if (!ev || ev.runId !== runId || !Number.isInteger(ev.seq)) return { status: 'ignored', added: [] };
      if (ev.seq > maxSeen) maxSeen = ev.seq;
      if (!ready && !gapOpen) {
        held.push(ev);
        return { status: 'held', added: [] };
      }
      if (gapOpen) {
        held.push(ev);
        return { status: 'gap', added: [] };
      }
      if (ev.seq <= last) return { status: 'duplicate', added: [] };
      if (ev.seq === last + 1) {
        addLine(ev);
        last = ev.seq;
        trim();
        return { status: 'added', added: [ev] };
      }
      held.push(ev);
      gapOpen = true;
      gapTries = 0;
      return { status: 'gap', added: [] };
    },
    load(events) {
      const added = [];
      const list = (Array.isArray(events) ? events : []).filter((e) => e && e.runId === runId && Number.isInteger(e.seq)).sort((x, y) => x.seq - y.seq);
      for (const ev of list) {
        if (ev.seq > maxSeen) maxSeen = ev.seq;
        if (ev.seq <= last) continue;
        addLine(ev);
        added.push(ev);
        last = ev.seq;
      }
      ready = true;
      const wasGap = gapOpen;
      const r = drain(wasGap && gapTries >= 1);
      added.push(...r.added);
      if (r.gap) {
        gapOpen = true;
        gapTries += 1;
      } else {
        gapOpen = false;
        gapTries = 0;
      }
      trim();
      return { added, gap: r.gap };
    },
  };
}

// =====================================================================================================================
// Everything below is decided here and only drawn by app.js.
// =====================================================================================================================

// Where a Fact came from, for a tooltip: "<prov>, <method>" (inferred) or "<prov>, <file#field>" (registered, final).
// Nothing is made up: a Fact with neither method nor from gives just its prov.
export function factSource(f) {
  const how = isStr(f?.method) ? f.method : isStr(f?.from) ? String(f.from).split('/').pop() : null;
  return `${isStr(f?.prov) ? f.prov : 'unknown'}${how ? `, ${how}` : ''}`;
}

// Start order for lists: the agents with a known start time first, by that time; the others last, in the order they came.
function byStart(agents) {
  return agents
    .map((a, i) => ({ a, i, t: typeof val(a?.startedAt) === 'number' ? val(a.startedAt) : null }))
    .sort((x, y) => (x.t === null ? 1 : 0) - (y.t === null ? 1 : 0) || (x.t ?? 0) - (y.t ?? 0) || x.i - y.i)
    .map((x) => x.a);
}

// ---------- the displayed time of a log line ----------

// A journal line has no timestamp, so the UiEvent ts of a journal event is the journal file time: for a run read after the
// fact that is the end of the run. The Run has better times for the two events that say when an agent began and ended.
// agent.started -> the agent's startedAt, agent.result / agent.failed -> its endedAt, when that Fact is not unknown;
// any other event, and an agent whose Fact is unknown, keeps the event ts. The tooltip says which one is shown.
const START_KINDS = new Set(['agent.started']);
const END_KINDS = new Set(['agent.result', 'agent.failed']);
export function eventTime(ev, run) {
  const own = typeof ev?.ts === 'number' ? ev.ts : null;
  const which = START_KINDS.has(ev?.kind) ? 'start' : END_KINDS.has(ev?.kind) ? 'end' : null;
  const a = which && isStr(ev?.agentId) ? run?.agents?.[ev.agentId] : null;
  const f = a ? (which === 'start' ? a.startedAt : a.endedAt) : null;
  if (f && f.prov !== 'unknown' && typeof f.value === 'number') {
    return { ts: f.value, source: 'agent', tip: `agent ${which} time (${factSource(f)})` };
  }
  return { ts: own, source: 'event', tip: own === null ? 'the event has no timestamp' : 'event time (may be a file time)' };
}

// What a drawn time is made of (the time, where it comes from, its tooltip): two lines with the same key look the same.
export const timeKey = (t) => `${t.source}|${t.ts ?? ''}|${t.tip}`;

// One line of the log as drawn: eventLine() with the displayed time and the tooltip that names its source. `timeKey` is kept on
// the drawn line, so a later snapshot can tell whether the line would now be timed differently (see retimedLines).
export function logLine(item, run) {
  const t = eventTime(item, run);
  return { ...eventLine(item), ts: t.ts, timeSource: t.source, timeTip: t.tip, timeKey: timeKey(t) };
}

// The seq a line of the log stands at (the marker of missing events stands where its first missing event would be).
export const lineSeq = (x) => (x.missing !== undefined ? x.from : x.seq);

// A live line is timed from the Run on hand when it arrives, and the server tells the event (agent.started, agent.result) before
// it sends the snapshot that holds the agent's new startedAt / endedAt. So the line is first drawn with the event ts and is timed
// again when that snapshot arrives; no interval is needed. `shownKey(item)` says the timeKey a line is drawn with now (undefined:
// the line is not on the page). Returns { seq, line } for each line whose displayed time or tooltip is now different.
export function retimedLines(items, run, shownKey) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.missing !== undefined) continue;
    const shown = shownKey(item);
    if (shown === undefined) continue;
    const line = logLine(item, run);
    if (line.timeKey !== shown) out.push({ seq: item.seq, line });
  }
  return out;
}

// The backlog in the order of the displayed time (stable; seq breaks ties). A line that shows no time (an event without a
// ts, or the marker of events the server no longer has) stays next to the line before it in seq order, so it is not thrown
// to an end; leading ones take the first known time. Live events are not sorted: the page appends them as they arrive.
export function sortByShownTime(items, run) {
  const inSeq = items.slice().sort((x, y) => lineSeq(x) - lineSeq(y));
  const times = inSeq.map((x) => (x.missing !== undefined ? null : eventTime(x, run).ts));
  const firstKnown = times.find((t) => t !== null) ?? 0;
  let carry = firstKnown;
  const keyed = inSeq.map((item, i) => {
    if (times[i] !== null) carry = times[i];
    return { item, key: times[i] ?? carry, seq: lineSeq(item) };
  });
  keyed.sort((x, y) => x.key - y.key || x.seq - y.seq);
  return keyed.map((k) => k.item);
}

// The order the page draws: the backlog (every line up to `backlogSeq`) sorted by the displayed time, and the lines that came
// live after it in the order they arrived (which is seq order). Without `backlogSeq` the whole log is a backlog.
export function logOrder(items, run, backlogSeq = Infinity) {
  const inSeq = items.slice().sort((x, y) => lineSeq(x) - lineSeq(y));
  return [...sortByShownTime(inSeq.filter((x) => lineSeq(x) <= backlogSeq), run), ...inSeq.filter((x) => lineSeq(x) > backlogSeq)];
}

// ---------- the log header ----------

// The log keeps the last `cap` events. `shown` is the number of event lines (not the markers of missing events). When it holds
// that many, the header says how many came in all (the highest seq seen).
export function logHeader({ shown, cap, maxSeq }) {
  if (cap > 0 && shown >= cap) return `showing the last ${cap} of ${Math.max(maxSeq ?? 0, shown)} events`;
  return shown ? String(shown) : '';
}

// Whether a scrolled box is at (or within `slack` px of) its bottom: then a new line scrolls into view, else the user is reading.
export function isNearBottom(box, slack = 30) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < slack;
}

// ---------- matrix ----------

// The agents of one unit in one role = one matrix cell. `shown` is the latest round, then the latest start; `count` all of
// them; `tags` the #tag of every one of them that has one, in start order (an agent with no tag adds nothing).
// `members` lists every agent of the cell in start order with its tag (null when it has none) and its visual state, so a cell
// with several agents can show each one; `tags` stays the list of the tags that exist.
export function matrixCell(cands) {
  if (!Array.isArray(cands) || !cands.length) return null;
  const shown = cands.slice().sort((x, y) => (val(y.round) ?? 0) - (val(x.round) ?? 0) || (val(y.startedAt) ?? 0) - (val(x.startedAt) ?? 0))[0];
  const ordered = byStart(cands);
  return {
    shown, count: cands.length, tags: ordered.map(tagOf).filter(Boolean),
    members: ordered.map((a) => ({ id: a.id, tag: tagOf(a), state: visualState(a) })),
    agents: ordered,
  };
}

// The agents of one unit, in start order, grouped by round: Agent.round when the Run knows it, else by #tag; an agent with
// neither is in "round unknown". A group is placed where its first agent starts. Nothing is made up: a tag group has
// roundKnown false and the page says "round unknown" next to it.
export function roundHistory(agents) {
  const groups = [];
  const byKey = new Map();
  for (const a of byStart(Array.isArray(agents) ? agents : [])) {
    const r = val(a.round);
    const roundKnown = typeof r === 'number' && Number.isFinite(r);
    const tag = tagOf(a);
    const key = roundKnown ? `round:${r}` : tag ? `tag:${tag}` : 'unknown';
    let g = byKey.get(key);
    if (!g) {
      g = { key, round: roundKnown ? r : null, tag: roundKnown ? null : tag, roundKnown, title: roundKnown ? `round ${r}` : tag ? `#${tag}` : 'round unknown', agents: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.agents.push({
      id: a.id, agent: a, label: isStr(val(a.label)) ? val(a.label) : a.id, role: isStr(val(a.role)) ? val(a.role) : null,
      tag, state: visualState(a), note: isInterrupted(a) ? interruptNote(a) : null,
    });
  }
  return groups;
}

// ---------- edges of the selected agent ----------

export const edgeKey = (e) => `${e.from}>${e.to}`;

// 'hl' for an edge of the selected agent (incoming or outgoing), 'dim' for every other edge while one is selected.
export function edgeEmphasis(e, selectedId) {
  if (!isStr(selectedId)) return '';
  return e.from === selectedId || e.to === selectedId ? 'hl' : 'dim';
}

// The edges into and out of one agent, with the fields exactly as the Run has them. The edge has no `method` field in
// contract 2 (its kind and `prov` say how it was found), so method is null unless the Run provides one.
export function edgesOf(run, id) {
  const shape = (e, dir) => {
    const other = dir === 'in' ? e.from : e.to;
    return {
      key: edgeKey(e), dir, other, otherLabel: isStr(val(run?.agents?.[other]?.label)) ? val(run.agents[other].label) : other,
      kind: e.kind, strength: e.strength ?? null, prov: e.prov, method: isStr(e.method) ? e.method : null, evidence: e.evidence,
    };
  };
  const edges = Array.isArray(run?.edges) ? run.edges : [];
  return {
    incoming: edges.filter((e) => e.to === id).map((e) => shape(e, 'in')),
    outgoing: edges.filter((e) => e.from === id).map((e) => shape(e, 'out')),
  };
}

// The agents on the other end of the selected agent's edges; `keep(edge)` leaves out the edges the page does not draw.
export function relatedIds(run, id, keep = () => true) {
  const { incoming, outgoing } = edgesOf(run, id);
  return new Set([...incoming, ...outgoing].filter(keep).map((e) => e.other));
}

// ---------- hover panel ----------

export const HOVER_ITEMS = 5;

// What the hover panel shows for one agent, from the Run: label, state, and the last `max` activity entries, newest first.
// An agent with no activity list but a lastActivity Fact (the final file's last tool) shows that one entry; with neither,
// `items` is empty and `reason` says why (the Run's own reason).
export function hoverInfo(run, agentId, { max = HOVER_ITEMS } = {}) {
  const a = run?.agents?.[agentId];
  if (!a) return null;
  const entry = (x) => ({
    ts: typeof x?.ts === 'number' ? x.ts : null,
    tool: isStr(x?.tool) ? x.tool : null,
    inputSummary: typeof x?.inputSummary === 'string' ? x.inputSummary : null,
    text: typeof x?.text === 'string' ? x.text : null,
  });
  let items = (Array.isArray(a.activity) ? a.activity : []).filter(isObj).slice(-max).reverse().map(entry);
  const la = a.lastActivity;
  if (!items.length && la && la.prov !== 'unknown' && isObj(la.value)) items = [entry(la.value)];
  return {
    id: a.id,
    label: isStr(val(a.label)) ? val(a.label) : a.id,
    state: visualState(a),
    interrupted: isInterrupted(a),
    note: isInterrupted(a) ? interruptNote(a) : null,
    lastTs: typeof val(la)?.ts === 'number' ? val(la).ts : null,
    items,
    reason: items.length ? null : (isStr(la?.reason) ? la.reason : 'no activity recorded'),
  };
}

// The newest event of one agent in the log lines (kept in seq order), or null.
export function lastEventOf(lines, agentId) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].agentId === agentId && lines[i].missing === undefined) return lines[i];
  return null;
}

// ---------- status card ----------

// A long error text (a stack trace): its first line (the first one with text) and the rest, which the page puts behind a toggle.
export function splitError(text) {
  const lines = (typeof text === 'string' ? text : text == null ? '' : String(text)).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return { first: '', rest: '', restLines: 0 };
  const rest = lines.slice(i + 1).join('\n').trimEnd();
  return { first: lines[i].trimEnd(), rest: rest.trim() === '' ? '' : rest, restLines: rest.trim() === '' ? 0 : rest.split('\n').length };
}

// ---------- run selector ----------

// The text of one option (the whole name, the status, the id) and the title with the full name and the run id.
export function runOption(r) {
  const id = String(r?.id ?? '');
  const name = val(r?.name);
  const status = val(r?.status);
  const nameText = isStr(name) ? name : null;
  const st = isStr(status) ? status : '?';
  return {
    // a run with a name: "name · status · id"; without one the id is shown once: "id (no name) · status"
    text: nameText ? `${nameText} · ${st} · ${id}` : `${id} (no name) · ${st}`,
    title: nameText ? `${nameText}\nrun id: ${id}` : `run id: ${id}\nrun name unknown: ${isStr(r?.name?.reason) ? r.name.reason : 'not provided'}`,
  };
}

// ---------- small fixes ----------

// Whether the times of a run are on the wall clock of now, so "now minus a time of the run" means something. A replayed run shows
// the run's own, past times (docs/contract.md section 1, Replay), so counting from now would show a day, and a bar to now would be
// stretched. A Run that carries no source at all (not in the contract: a Run always has one) is read as live, as before.
export const countsFromNow = (run) => run?.source === undefined || run.source === 'real' || run.source === 'demo';

// Where a run that is not on the clock of now ends, in its own times: the Run's end time when it is known, else the latest time the
// Run records (latestRecorded: the largest start, end or last-activity time of its agents). The time of an event is not used: a
// journal line carries the time of its file, which is not when the event happened (on a saved run it is the end of the file, long
// after the run). Null when the Run records neither.
function ownEnd(run) {
  const e = run?.endedAt;
  if (e && e.prov !== 'unknown' && typeof e.value === 'number') return { ts: e.value, from: `the run end (${factSource(e)})` };
  const last = latestRecorded(run);
  return typeof last === 'number' ? { ts: last, from: 'the latest time the run records' } : null;
}

// The elapsed time of a run. The Run's own duration when it has one. Otherwise a computed (inferred) Fact whose method names
// where its two times come from:
//   a replay or a final run: the run's own time, its end (ownEnd) minus its start. The wall clock is not used, so the value does not
//   change while the run does not;
//   a running run on the clock of now (countsFromNow): now minus the run's start.
// When the Run does not give what is needed (no start, no end, a start in the future) the Run's duration Fact, unknown with its reason.
export function elapsedFact(run, now) {
  const d = run?.durationMs;
  if (val(d) != null) return d;
  const unknown = () => d ?? { value: null, prov: 'unknown', reason: 'the run has no duration' };
  const s = run?.startedAt;
  if (!s || s.prov === 'unknown' || typeof s.value !== 'number') return unknown();
  if (run.source === 'replay' || isFinalStatus(run.status)) {
    const end = ownEnd(run);
    if (!end || end.ts < s.value) return unknown();
    return { value: end.ts - s.value, prov: 'inferred', method: `${end.from} minus the run start (${factSource(s)})` };
  }
  if (val(run.status) === 'running' && countsFromNow(run) && typeof now === 'number' && now >= s.value) {
    return { value: now - s.value, prov: 'inferred', method: `now minus the run start (${factSource(s)})` };
  }
  return unknown();
}

// What a failed request says: the HTTP status, else the error's own message.
export function fetchErrorText({ status, error } = {}) {
  if (Number.isInteger(status)) return `HTTP ${status}`;
  const m = typeof error === 'string' ? error : error?.message;
  return isStr(m) ? m : 'the request failed, no error text';
}

export const backlogNotice = (error) => `backlog not loaded: ${isStr(error) ? error : 'no error text'}`;

// ---------- the mode of the server ----------

// What the header, the banner and the document title say for the mode the server reports in `hello`. Only the modes of the contract
// are known; any other value is shown as unknown ("?"), never as REAL, and its text is not put into a class name.
const MODES = {
  real: { text: 'REAL', cls: 'real', banner: null, title: 'wfviz' },
  demo: { text: 'DEMO', cls: 'demo', banner: 'demo', title: 'wfviz — DEMO' },
  replay: { text: 'REPLAY', cls: 'replay', banner: 'replay', title: 'wfviz — REPLAY' },
};
export function modeInfo(mode) {
  if (typeof mode === 'string' && Object.hasOwn(MODES, mode)) return { ...MODES[mode], known: true };
  return { text: '?', cls: 'unknown', banner: null, title: 'wfviz', known: false };
}

// ---------- colour slots ----------

// The page has nine neutral colour slots, --c1 .. --c9. What takes a slot (a role, a value of a recognised field) is given them in
// order of first appearance in the run, so no name decides a colour. Past the ninth slot the colours are used again. A value that
// is not in the order (a run with no role) is --other.
const SLOT_COUNT = 9;
export const orderOfAppearance = (values) => [...new Set((Array.isArray(values) ? values : []).filter((v) => v !== null && v !== undefined))];
export function slotVar(order, value) {
  const i = Array.isArray(order) ? order.indexOf(value) : -1;
  return i < 0 ? '--other' : `--c${(i % SLOT_COUNT) + 1}`;
}

// The heading of a group of the round history: its title and, for a group that is not a known round, a note that says so. A group with
// neither round nor tag is titled "round unknown" already, so it has no note (the heading would say it twice); a group of a tag
// keeps it ("#r1 round unknown").
export function groupHeading(g) {
  return { title: g.title, note: g.roundKnown || g.key === 'unknown' ? null : 'round unknown' };
}

// ---------- the run picker ----------

const RUN_STATUS_CLASS = new Map([['running', 'running'], ['completed', 'pass'], ['failed', 'fail'], ['killed', 'killed']]);
// The class of a run status badge: a fixed class for the statuses the page styles, none for any other text.
export const runStatusClass = (status) => RUN_STATUS_CLASS.get(status) ?? '';

// One row of the run picker, from one item of the run list (and nothing else). A value the item does not have is null with the
// reason the list gives for it, never 0 and never the mode of the page: the agent count and the source are not in every item.
export function pickerRow(r) {
  const id = String(r?.id ?? '');
  const name = val(r?.name);
  const status = val(r?.status);
  const started = val(r?.startedAt);
  const reason = (f, fallback) => (isStr(f?.reason) ? f.reason : fallback);
  return {
    id,
    name: isStr(name) ? name : null,
    nameReason: reason(r?.name, 'the run list has no name for this run'),
    status: isStr(status) ? status : null,
    statusReason: reason(r?.status, 'the run list has no status for this run'),
    startedAt: typeof started === 'number' && Number.isFinite(started) ? started : null,
    startedReason: reason(r?.startedAt, 'the run list has no start time for this run'),
    agents: Number.isInteger(r?.agents) && r.agents >= 0 ? r.agents : null,
    source: isStr(r?.source) ? r.source : null,
    // the project exactly as the list gives it (the directory name on disk), never prettified
    project: isStr(r?.project) && r.project !== '' ? r.project : null,
    // a list item without `loaded` (demo, replay, an older server) is a run that is loaded; only an explicit false is a run that is only listed
    loaded: r?.loaded !== false,
  };
}

// The text cut in pieces, those that match the query (case-insensitive substring, never a pattern) marked: [{ text, hit }].
// A letter can change its length when it is lowered ('İ' becomes two units), so the text is lowered one character at a time and
// every unit of the lowered text remembers the character it came from: a match is cut out of the original at those characters.
export function markSegments(text, query) {
  const t = String(text ?? '');
  const q = String(query ?? '').trim();
  if (!q) return t ? [{ text: t, hit: false }] : [];
  const needle = q.toLowerCase();
  let lowered = '';
  const from = [];
  const to = [];
  let at = 0;
  for (const ch of t) {
    const l = ch.toLowerCase();
    for (let k = 0; k < l.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    lowered += l;
    at += ch.length;
  }
  const spans = [];
  for (let j = lowered.indexOf(needle); j >= 0; j = lowered.indexOf(needle, j + needle.length)) {
    const a = from[j];
    const b = to[j + needle.length - 1];
    const prev = spans.at(-1);
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b); // touching or overlapping marks are one
    else spans.push([a, b]);
  }
  const out = [];
  let pos = 0;
  for (const [a, b] of spans) {
    if (a > pos) out.push({ text: t.slice(pos, a), hit: false });
    out.push({ text: t.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < t.length) out.push({ text: t.slice(pos), hit: false });
  return out.length ? out : (t ? [{ text: t, hit: false }] : []);
}

// The rows that match a query, each with the pieces of its name (null when the run has no name: "(no name)" is a placeholder, not
// the run's name, so a search never matches it) and of its id. An empty query matches every row.
export function filterRunRows(rows, query) {
  const empty = !String(query ?? '').trim();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const nameSegs = row.name !== null ? markSegments(row.name, query) : null;
    const idSegs = markSegments(row.id, query);
    const hit = (segs) => !!segs && segs.some((x) => x.hit);
    if (empty || hit(nameSegs) || hit(idSegs)) out.push({ row, nameSegs, idSegs });
  }
  return out;
}

// The scrollTop that brings a row into view inside a scrolled box with the least movement: the one the box has when the row is in
// view already, the top of the row when it is above the view (or taller than it), else the one that puts the bottom of the row at the
// bottom of the view. `top` is the row's offset from the top of the scrolled content. A number that is not one (a box with no layout)
// leaves the scroll as it is.
export function scrollToShow({ top, height, scrollTop, viewHeight }) {
  if (![top, height, scrollTop, viewHeight].every(Number.isFinite)) return scrollTop;
  if (top < scrollTop || height > viewHeight) return Math.max(top, 0);
  if (top + height > scrollTop + viewHeight) return top + height - viewHeight;
  return scrollTop;
}

// ---------- the run list while the page is open ----------

// The run list item for a run snapshot: the fields of a list item, only those the snapshot has (the agent count and the number
// running come from its totals), so that merging it into an older row keeps what the row knew.
export function summaryOfRun(run) {
  const out = { id: run?.id };
  for (const k of ['name', 'status', 'project', 'startedAt', 'source']) if (run?.[k] !== undefined) out[k] = run[k];
  if (Number.isInteger(run?.totals?.agents)) out.agents = run.totals.agents;
  if (Number.isInteger(run?.totals?.running)) out.running = run.totals.running;
  out.loaded = true; // the stream sends a snapshot only of a run that is loaded
  return out;
}

// A run that is in the list keeps its place and takes the new fields (a change of status does not reorder the rows); a run that is
// not in it is put first (it is the newest one). Returns a new list.
export function mergeRun(list, summary) {
  const runs = Array.isArray(list) ? list : [];
  const i = runs.findIndex((r) => r.id === summary.id);
  if (i < 0) return [summary, ...runs];
  return runs.map((r, k) => (k === i ? { ...r, ...summary } : r));
}

// The list the server gave, together with the runs the page heard of while that request was out (state.runs by then): a run only
// the stream knew is kept, first; a run of both takes the fields of the stream for the ids in `touched`, which are newer than the answer.
export function mergeRunList(fetched, current, touched = new Set()) {
  const got = Array.isArray(fetched) ? fetched : [];
  const mine = Array.isArray(current) ? current : [];
  const have = new Set(got.map((r) => r.id));
  const extras = mine.filter((r) => !have.has(r.id));
  const merged = got.map((r) => (touched.has(r.id) ? { ...r, ...(mine.find((c) => c.id === r.id) || {}) } : r));
  return [...extras, ...merged];
}

// ---------- run history: the filters of the run picker, kept in location.hash ----------

// The filters of the picker: range ('24h' by default, or 'all'), project, status, from and to (YYYY-MM-DD, local days, both ends
// included), q (the text typed in the search field: name and id). The state is the URL hash and nothing else (nothing is stored).
//   #range=all&project=<dir name>&status=<text>&from=2026-11-01&to=2026-11-10&q=<text>
// Defaults are left out; an empty hash is "the last 24 h, nothing else set". Anything that does not parse is the default.
export const HASH_VALUE_MAX = 200;
export const DAY_MS = 24 * 3600e3;
export const defaultPickerFilter = () => ({ range: '24h', project: null, status: null, from: null, to: null, q: '' });

// A real calendar day written YYYY-MM-DD (2026-02-30 is not one).
export function isCalendarDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof text === 'string' ? text : '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// The filter a hash holds. URLSearchParams never throws on a malformed percent sequence (it keeps the text); a repeated key gives its
// first value; a value over HASH_VALUE_MAX characters, an unknown range and a date that is not a calendar day are the default; keys that
// are not the picker's are dropped.
export function parsePickerHash(hash) {
  const out = defaultPickerFilter();
  const text = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  let params;
  try { params = new URLSearchParams(text); } catch { return out; }
  const first = (key) => {
    const v = params.getAll(key)[0];
    return typeof v === 'string' && v.length <= HASH_VALUE_MAX ? v : undefined;
  };
  if (first('range') === 'all') out.range = 'all';
  for (const key of ['project', 'status']) {
    const v = first(key);
    if (v !== undefined && v !== '') out[key] = v;
  }
  for (const key of ['from', 'to']) {
    const v = first(key);
    if (v !== undefined && isCalendarDate(v)) out[key] = v;
  }
  const q = first('q');
  if (q !== undefined) out.q = q;
  return out;
}

// The hash for a filter: '' when it is the default, else '#key=value&...' in a fixed order (what parsePickerHash reads back).
export function formatPickerHash(filter) {
  const f = { ...defaultPickerFilter(), ...(filter ?? {}) };
  const params = new URLSearchParams();
  if (f.range === 'all') params.set('range', 'all');
  for (const key of ['project', 'status', 'from', 'to']) if (isStr(f[key]) && f[key] !== '') params.set(key, f[key].slice(0, HASH_VALUE_MAX));
  if (isStr(f.q) && f.q.trim() !== '') params.set('q', f.q.slice(0, HASH_VALUE_MAX));
  const text = params.toString();
  return text === '' ? '' : `#${text}`;
}

// The start of a local calendar day (plus `days` days) in ms.
function localDay(text, days = 0) {
  const [y, mo, d] = text.split('-').map(Number);
  return new Date(y, mo - 1, d + days).getTime();
}

// Whether a run of the list passes the filters other than the text (that one is the search of the picker, name and id). The last 24 h
// count when neither from nor to is set and the range is not 'all': an explicit date range replaces them. A run whose start is unknown
// is outside the last 24 h and outside any date range; it shows only under 'all' with no date set.
export function runPassesFilter(item, filter, now) {
  const f = { ...defaultPickerFilter(), ...(filter ?? {}) };
  if (f.project !== null && item?.project !== f.project) return false;
  if (f.status !== null && val(item?.status) !== f.status) return false;
  const s = val(item?.startedAt);
  const started = typeof s === 'number' && Number.isFinite(s) ? s : null;
  if (f.from !== null || f.to !== null) {
    if (started === null) return false;
    if (f.from !== null && started < localDay(f.from)) return false;
    if (f.to !== null && started >= localDay(f.to, 1)) return false;
    return true;
  }
  if (f.range === 'all') return true;
  return started !== null && started >= now - DAY_MS;
}

// The values the project and status controls offer: the list's own, sorted, as the list gives them (a status this page does not know
// stays filterable; a project is the directory name as on disk).
export function pickerFilterOptions(items) {
  const projects = new Set();
  const statuses = new Set();
  for (const r of Array.isArray(items) ? items : []) {
    if (isStr(r?.project) && r.project !== '') projects.add(r.project);
    const st = val(r?.status);
    if (isStr(st) && st !== '') statuses.add(st);
  }
  const sorted = (set) => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { projects: sorted(projects), statuses: sorted(statuses) };
}

// A filter whose project or status is not in the list is reset to "all" (checked once the list has arrived). Returns the filter and
// whether it changed, so the caller rewrites the hash only then.
export function sanitizePickerFilter(filter, options) {
  const f = { ...defaultPickerFilter(), ...(filter ?? {}) };
  let changed = false;
  if (f.project !== null && !(options?.projects ?? []).includes(f.project)) { f.project = null; changed = true; }
  if (f.status !== null && !(options?.statuses ?? []).includes(f.status)) { f.status = null; changed = true; }
  return { filter: f, changed };
}

// What the picker says about a run that is only listed, while its load is out, and when it failed.
export const NOT_LOADED_TEXT = 'not loaded - opens on click';
export const LOADING_TEXT = 'loading...';
export const loadFailedText = (id, reason) => `could not load ${id}: ${isStr(reason) && reason !== '' ? reason : 'no reason given'}`;

// =====================================================================================================================
// Steady UI. Everything below is decided here and only drawn by app.js: what changed between two drawings (keyed
// patches), the sizes of the columns and the log, the matrix rows (with the fallback rows), the clock, the tests rows.
// Nothing here touches a document: the patch functions call methods on the elements the page hands them.
// =====================================================================================================================

// ---------- keys and patches ----------

// A key is a string. Parts are joined as JSON, never with a separator character that a name could contain.
export const keyOf = (...parts) => JSON.stringify(parts);

// Two values are the same when they show the same: a deep comparison of plain data (a spec, a tuple, a string).
export const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// A list that may hold the same key twice gets a second and later occurrence a suffix, so no key is lost or repeated.
export function dedupeKeys(items) {
  const seen = new Map();
  return (Array.isArray(items) ? items : []).map((item) => {
    const n = (seen.get(item.key) ?? 0) + 1;
    seen.set(item.key, n);
    return n === 1 ? item : { ...item, key: keyOf(item.key, 'dup', n) };
  });
}

function keyChecked(keyFn, item, where) {
  const k = keyFn(item);
  if (typeof k !== 'string') throw new TypeError(`the key of an item in ${where} is not a string`);
  return k;
}

// Longest run of the sequence that is already in increasing order: the positions that need not move.
function inOrder(seq) {
  const tails = [];
  const before = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) before[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set();
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = before[k]) keep.add(k);
  return keep;
}

// What changed between two lists of items:
//   add     [{ key, item, index }]        items whose key is new (index in nextItems)
//   update  [{ key, prev, item, index }]  keys in both whose items are not `equal`
//   remove  [{ key, item }]               keys that are gone
//   order   [key]                         the final order
//   moves   [key]                         keys in both that must change place (the others keep their relative order)
// A key twice in either list is a bug of the caller: it throws, it does not guess. Neither input is changed.
export function planPatch(prevItems, nextItems, keyFn, equal = sameJson) {
  const prev = Array.isArray(prevItems) ? prevItems : [];
  const next = Array.isArray(nextItems) ? nextItems : [];
  const prevAt = new Map();
  prev.forEach((item, i) => {
    const k = keyChecked(keyFn, item, 'prevItems');
    if (prevAt.has(k)) throw new Error(`duplicate key in prevItems: ${k}`);
    prevAt.set(k, i);
  });
  const seen = new Set();
  const add = [];
  const update = [];
  const kept = [];
  const order = [];
  next.forEach((item, index) => {
    const k = keyChecked(keyFn, item, 'nextItems');
    if (seen.has(k)) throw new Error(`duplicate key in nextItems: ${k}`);
    seen.add(k);
    order.push(k);
    const at = prevAt.get(k);
    if (at === undefined) {
      add.push({ key: k, item, index });
      return;
    }
    kept.push({ key: k, at });
    if (!equal(prev[at], item)) update.push({ key: k, prev: prev[at], item, index });
  });
  const remove = [];
  prev.forEach((item) => {
    const k = keyFn(item);
    if (!seen.has(k)) remove.push({ key: k, item });
  });
  const stay = inOrder(kept.map((x) => x.at));
  return { add, update, remove, order, moves: kept.filter((_, i) => !stay.has(i)).map((x) => x.key) };
}

// ---------- an element described as data ----------

// { key, tag, ns?, attrs, html }: attrs hold raw values (setAttribute does not parse them), html is built by the page with
// every data string through esc(). An attribute that is null, undefined or false is left out.
export function specOf(key, attrs = {}, html = '', tag = 'div') {
  const a = {};
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) a[k] = v === true ? '' : String(v);
  return { key, tag, attrs: a, html };
}

const tokens = (s) => String(s ?? '').split(/\s+/).filter(Boolean);

// The attribute writes that turn prev into next. `class` is a token list: only the tokens that differ are added or removed, so
// a class the page put there itself (a live highlight) is not undone by a data update.
export function attrDiff(prev, next) {
  const p = prev || {};
  const n = next || {};
  const set = {};
  const remove = [];
  for (const [k, v] of Object.entries(n)) if (k !== 'class' && k !== 'style' && p[k] !== v) set[k] = v;
  for (const k of Object.keys(p)) if (k !== 'class' && k !== 'style' && !(k in n)) remove.push(k);
  const was = tokens(p.class);
  const now = tokens(n.class);
  const styleWas = parseStyle(p.style);
  const styleNow = parseStyle(n.style);
  const styleSet = {};
  for (const [k, v] of styleNow) if (styleWas.get(k) !== v) styleSet[k] = v;
  return {
    set, remove,
    classAdd: now.filter((t) => !was.includes(t)), classRemove: was.filter((t) => !now.includes(t)),
    styleSet, styleRemove: [...styleWas.keys()].filter((k) => !styleNow.has(k)),
  };
}

// "a:1;b:2" -> Map(a -> 1, b -> 2). The styles the page writes are plain declarations (custom properties, positions, colours).
function parseStyle(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0 && part.slice(0, i).trim()) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function createSpecEl(doc, spec) {
  const el = spec.ns ? doc.createElementNS(spec.ns, spec.tag) : doc.createElement(spec.tag);
  for (const [k, v] of Object.entries(spec.attrs || {})) el.setAttribute(k, v);
  if (spec.html) el.innerHTML = spec.html;
  return el;
}

// Writes only what differs; an element whose spec did not change is not passed here at all. A changed inner html is patched
// (morphHtml): the unchanged parts of it keep their nodes and only the text or the attribute that differs is written.
export function updateSpecEl(el, prev, next) {
  const d = attrDiff(prev.attrs, next.attrs);
  for (const [k, v] of Object.entries(d.set)) el.setAttribute(k, v);
  for (const k of d.remove) el.removeAttribute(k);
  for (const t of d.classRemove) el.classList.remove(t);
  for (const t of d.classAdd) el.classList.add(t);
  // a style is written property by property, so a property the page set itself (the live highlight delay) stays
  for (const k of d.styleRemove) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(d.styleSet)) el.style.setProperty(k, v);
  if (prev.html !== next.html && !morphHtml(el, prev.html, next.html)) el.innerHTML = next.html;
}

// ---------- the inner html of an element, patched in place ----------

// The html the page builds (every data string through esc()) read as data: a text is a string, an element is
// { tag, attrs, kids }. Only what the page writes is known: tags, quoted attributes, the five entities of esc() and numbers,
// void tags, comments. Anything else stays as text.
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'wbr']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = (s) => (s.indexOf('&') < 0 ? s : s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, dec, hex, name) => {
  if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
  const n = dec !== undefined ? Number(dec) : parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
}));

export function parseHtml(html) {
  const root = { kids: [] };
  const stack = [root];
  const tag = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  const text = String(html ?? '').replace(/\r\n?/g, '\n'); // a browser reads a line end as a line feed
  let at = 0;
  let afterPre = false; // the browser drops one line feed that comes right after <pre>
  const addText = (raw) => {
    let t = raw;
    if (afterPre && t.startsWith('\n')) t = t.slice(1);
    afterPre = false;
    if (!t) return;
    const kids = stack.at(-1).kids;
    const s = decodeEntities(t);
    if (typeof kids.at(-1) === 'string') kids[kids.length - 1] += s; else kids.push(s);
  };
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    addText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[0].startsWith('<!--')) continue;
    if (m[1] !== undefined) { // a closing tag: up to the open element of that name (none open: ignored)
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === name) { stack.length = i; break; }
      continue;
    }
    const el = { tag: m[2].toLowerCase(), attrs: {}, kids: [] };
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      if (!Object.hasOwn(el.attrs, a[1])) el.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    stack.at(-1).kids.push(el);
    afterPre = false;
    if (!m[4] && !VOID_TAGS.has(el.tag)) { stack.push(el); afterPre = el.tag === 'pre'; }
  }
  addText(text.slice(at));
  return root.kids;
}

function buildNode(node, doc) {
  if (typeof node === 'string') return doc.createTextNode(node);
  const el = doc.createElement(node.tag);
  for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, v);
  for (const kid of node.kids) el.insertBefore(buildNode(kid, doc), null);
  return el;
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const sigOf = (n) => (typeof n === 'string' ? `t${n}` : `e${JSON.stringify(n)}`);

// The pairs [i, j] of a longest common subsequence of two signature lists (ascending in both): the children that stay as they are.
function samePairs(a, b) {
  if (a.length * b.length > 40000) return []; // a very long list is paired by place only
  const w = b.length + 1;
  const len = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) len[i * w + j] = a[i] === b[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
  }
  const out = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++; else j++;
  }
  return out;
}

// the live children are what `prev` says they are: the same number, texts where it has texts, elements of its tags
function shapeIs(live, prev) {
  if (live.length !== prev.length) return false;
  return prev.every((p, i) => (typeof p === 'string' ? live[i].nodeType === 3 : live[i].nodeType === 1 && String(live[i].nodeName).toLowerCase() === p.tag));
}

function patchKids(parent, prev, next, doc) {
  const live = Array.from(parent.childNodes);
  if (!shapeIs(live, prev)) { // not what was drawn: draw it again, node by node
    for (const n of live) parent.removeChild(n);
    for (const n of next) parent.insertBefore(buildNode(n, doc), null);
    return;
  }
  const pairs = samePairs(prev.map(sigOf), next.map(sigOf));
  pairs.push([prev.length, next.length]); // the end of both lists closes the last gap
  let i = 0;
  let j = 0;
  for (const [mi, mj] of pairs) {
    // Between two children that stay, the old ones and the new ones share no child: the first of each are the same element
    // changed (patched in place, or replaced when they are not of one kind), the rest are removed or inserted before the next
    // child that stays.
    const common = Math.min(mi - i, mj - j);
    for (let k = 0; k < common; k++) {
      const p = prev[i + k];
      const q = next[j + k];
      const node = live[i + k];
      if (typeof p === 'string' && typeof q === 'string') { if (p !== q) node.data = q; }
      else if (typeof p === 'object' && typeof q === 'object' && p.tag === q.tag) {
        for (const [a, v] of Object.entries(q.attrs)) if (p.attrs[a] !== v) node.setAttribute(a, v);
        for (const a of Object.keys(p.attrs)) if (!Object.hasOwn(q.attrs, a)) node.removeAttribute(a);
        patchKids(node, p.kids, q.kids, doc);
      } else {
        parent.insertBefore(buildNode(q, doc), node);
        parent.removeChild(node);
      }
    }
    for (let k = common; k < mi - i; k++) parent.removeChild(live[i + k]);
    const anchor = mi < prev.length ? live[mi] : null;
    for (let k = common; k < mj - j; k++) parent.insertBefore(buildNode(next[j + k], doc), anchor);
    i = mi + 1;
    j = mj + 1;
  }
}

// Brings the inner html of `el` from `prevHtml` (what it holds) to `nextHtml`, writing only what differs: a text that changed is
// written to its own text node, an attribute that changed to its own element, a child that is new is inserted, one that is gone
// is removed, and every other node stays (not removed and put back). False when it cannot be done here (no document that makes text
// nodes, an element of SVG, no html drawn before): the caller writes innerHTML then.
export function morphHtml(el, prevHtml, nextHtml) {
  const doc = el?.ownerDocument;
  if (!doc || typeof doc.createTextNode !== 'function' || typeof prevHtml !== 'string') return false;
  if (el.namespaceURI && el.namespaceURI !== XHTML_NS) return false;
  patchKids(el, parseHtml(prevHtml), parseHtml(nextHtml), doc);
  return true;
}

// ---------- a keyed list of elements ----------

export const createListState = () => ({ items: [], els: new Map() });

// Brings the children of `parent` (which holds only this list) from st.items to `next`: gone ones are removed, new ones are
// created and placed, changed ones are updated in place (the same element), unchanged ones are not touched, and only the
// elements that must change place are moved. `create(item)` makes an element, `update(el, prev, item)` changes it.
export function patchList(parent, st, next, { create, update, keyFn = (x) => x.key, equal = sameJson }) {
  const plan = planPatch(st.items, next, keyFn, equal);
  for (const r of plan.remove) {
    parent.removeChild(st.els.get(r.key));
    st.els.delete(r.key);
  }
  for (const u of plan.update) update(st.els.get(u.key), u.prev, u.item);
  const placed = new Set(plan.add.map((a) => a.key));
  for (const a of plan.add) st.els.set(a.key, create(a.item));
  for (const k of plan.moves) placed.add(k);
  let follower = null;
  for (let i = plan.order.length - 1; i >= 0; i--) {
    const el = st.els.get(plan.order[i]);
    if (placed.has(plan.order[i])) parent.insertBefore(el, follower);
    follower = el;
  }
  st.items = next.slice();
  return plan;
}

// New items at the end, without comparing the rest (a log gets lines at the bottom).
export function appendItems(parent, st, items, { create, keyFn = (x) => x.key }) {
  for (const item of items) {
    const k = keyChecked(keyFn, item, 'items');
    if (st.els.has(k)) throw new Error(`duplicate key in the list: ${k}`);
    const el = create(item);
    parent.insertBefore(el, null);
    st.els.set(k, el);
    st.items.push(item);
  }
}

// New items before the first one, in the order given, without comparing the rest (the notice of a log comes before every line).
export function prependItems(parent, st, items, { create, keyFn = (x) => x.key }) {
  const ref = st.items.length ? st.els.get(keyFn(st.items[0])) : null;
  const added = [];
  for (const item of items) {
    const k = keyChecked(keyFn, item, 'items');
    if (st.els.has(k)) throw new Error(`duplicate key in the list: ${k}`);
    const el = create(item);
    parent.insertBefore(el, ref);
    st.els.set(k, el);
    added.push(item);
  }
  st.items = [...added, ...st.items];
}

// Removes the items for which `gone(item)` is true.
export function dropItems(parent, st, gone, keyFn = (x) => x.key) {
  const keep = [];
  for (const item of st.items) {
    if (!gone(item)) {
      keep.push(item);
      continue;
    }
    const k = keyFn(item);
    parent.removeChild(st.els.get(k));
    st.els.delete(k);
  }
  st.items = keep;
}

export function clearList(parent, st) {
  for (const el of st.els.values()) parent.removeChild(el);
  st.items = [];
  st.els.clear();
}

// ---------- groups: an element that holds a keyed list of its own ----------

// { key, tag, attrs, html: '', children: [item] }: an element whose children are items too (specs or groups). Two drawings of it
// are compared child by child, so a child that did not change is not touched, however deep it lies.
export function groupOf(key, attrs, children, tag = 'div') {
  return { ...specOf(key, attrs, '', tag), children };
}

const groupLists = new WeakMap();

// Makes the element of an item: a spec as createSpecEl does, a group with its children drawn inside it.
export function createNode(doc, item) {
  if (!Array.isArray(item.children)) return createSpecEl(doc, item);
  const el = createSpecEl(doc, { tag: item.tag, ns: item.ns, attrs: item.attrs, html: '' });
  const st = createListState();
  groupLists.set(el, { st, doc });
  patchList(el, st, dedupeKeys(item.children), { create: (c) => createNode(doc, c), update: updateNode });
  return el;
}

// Brings the element of an item from `prev` to `next`: a spec as updateSpecEl does; for a group, its own attributes and then its
// children by key. A scrolled block inside an unchanged child keeps its element and its scroll position.
export function updateNode(el, prev, next) {
  if (!Array.isArray(next.children)) return updateSpecEl(el, prev, next);
  const g = groupLists.get(el);
  updateSpecEl(el, { attrs: prev.attrs, html: '' }, { attrs: next.attrs, html: '' });
  patchList(el, g.st, dedupeKeys(next.children), { create: (c) => createNode(g.doc, c), update: updateNode });
}

// Keys for the entries of a list that is read again and again (the activity of an agent, oldest first): the time and the tool, and
// the place among entries that share both, so an entry keeps its key when the list grows at the end or loses its first ones.
export function entryKeys(list, prefix) {
  const seen = new Map();
  return (Array.isArray(list) ? list : []).map((x) => {
    const base = keyOf(prefix, typeof x?.ts === 'number' ? x.ts : null, isStr(x?.tool) ? x.tool : null);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return keyOf(base, n);
  });
}

// ---------- sizes of the columns and the log ----------

const COLUMN_MIN = 160;
const COLUMN_MAX_RATIO = 0.5;
const LOG_MIN = 80;
const LOG_MAX_RATIO = 0.6;
// The centre column keeps at least this much, so two columns at half the width each cannot leave no centre.
export const CENTER_MIN = 240;
export const HANDLE_WIDTH = 8;
export const LAYOUT_DEFAULTS = { left: 240, right: 300, log: 190 };

const isSize = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
// a stored text -> a size, or null for anything that is not a positive finite number
export function parseStoredSize(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const n = Number(text);
  return isSize(n) ? n : null;
}

// min wins over max when the room is smaller than the minimum
const between = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The sizes to show for the wanted ones in a window of { width, height }: a column is 160 px .. half the width, the log is
// 80 px .. 60% of the height, and the two columns together leave the centre CENTER_MIN. A missing or bad wanted size is the
// default. When both columns do not fit, the column named by `prefer` (the one being dragged) gives way first; without
// `prefer` both shrink in proportion.
export function clampLayout(wanted, viewport, prefer = null) {
  const w = isSize(viewport?.width) ? viewport.width : 0;
  const h = isSize(viewport?.height) ? viewport.height : 0;
  // a number that is not finite (NaN, Infinity) or not a number is no wish: the default. A finite one, even negative, is clamped.
  const pick = (k) => (typeof wanted?.[k] === 'number' && Number.isFinite(wanted[k]) ? wanted[k] : LAYOUT_DEFAULTS[k]);
  const colMax = Math.floor(w * COLUMN_MAX_RATIO);
  let left = between(pick('left'), COLUMN_MIN, colMax);
  let right = between(pick('right'), COLUMN_MIN, colMax);
  const room = w - CENTER_MIN - 2 * HANDLE_WIDTH;
  if (left + right > room) {
    if (prefer === 'left') {
      left = between(left, COLUMN_MIN, room - right);
      right = between(right, COLUMN_MIN, room - left);
    } else if (prefer === 'right') {
      right = between(right, COLUMN_MIN, room - left);
      left = between(left, COLUMN_MIN, room - right);
    } else {
      const f = room / (left + right);
      left = between(Math.floor(left * f), COLUMN_MIN, colMax);
      right = between(Math.floor(right * f), COLUMN_MIN, colMax);
    }
  }
  return { left: Math.round(left), right: Math.round(right), log: Math.round(between(pick('log'), LOG_MIN, Math.floor(h * LOG_MAX_RATIO))) };
}

// A handle was dragged from (x, y) by (dx, dy), the size being `start` when the drag began: the left column grows with dx, the
// right column and the log grow when the pointer moves left / up. Returns all three sizes, clamped.
export function dragLayout(wanted, kind, start, delta, viewport) {
  const raw = { ...wanted };
  if (kind === 'left') raw.left = start + delta.dx;
  else if (kind === 'right') raw.right = start - delta.dx;
  else if (kind === 'log') raw.log = start - delta.dy;
  else return clampLayout(wanted, viewport);
  return clampLayout(raw, viewport, kind);
}

// ---------- the matrix: role x unit, and the fallback rows (docs/contract.md section 2) ----------

// The state of a unit's row from its agents.
export function unitState(agents) {
  if (agents.some(isBusy)) return 'running';
  if (agents.some(isInterrupted)) return 'interrupted';
  if (agents.some((a) => agentState(a) === 'failed')) return 'failed';
  return agents.every((a) => agentState(a) === 'done') ? 'done' : 'unknown';
}

// The tags next to a unit: the tags of every agent of the row, in the order those agents started (a tag once). The items are the
// row's cells (each holds all its agents, not only the one it shows) or plain agents.
export function rowTags(items) {
  const agents = [];
  for (const x of Array.isArray(items) ? items : []) {
    if (!x) continue;
    if (Array.isArray(x.members) && Array.isArray(x.agents)) agents.push(...x.agents);
    else agents.push(x);
  }
  return [...new Set(byStart(agents).map(tagOf).filter(Boolean))];
}

// One row per unit (units in order of first appearance), one cell per role (null when no agent has that unit and role).
export function matrixRows(parsed, roles = matrixRoles(parsed)) {
  return matrixUnits(parsed).map((unit) => {
    const mine = parsed.filter((a) => val(a.unit) === unit);
    const rounds = mine.map((a) => val(a.round)).filter((x) => typeof x === 'number');
    const cells = roles.map((role) => {
      const c = matrixCell(mine.filter((a) => val(a.role) === role));
      return c && { role, ...c };
    });
    return { unit, agents: mine, maxRound: rounds.length ? Math.max(...rounds) : null, state: unitState(mine), cells, tags: rowTags(mine) };
  });
}

// What a fallback cell says about an agent: the label as the Run has it, with its own prov and source; without a label the
// agentId, marked as such, with the reason the Run gives for the missing label. Nothing is parsed or split.
export function captionOf(a) {
  const f = a?.label;
  const v = val(f);
  if (f && f.prov !== 'unknown' && isStr(v)) return { text: v, known: true, prov: isStr(f.prov) ? f.prov : 'unknown', tip: factSource(f) };
  return { text: String(a?.id ?? ''), known: false, prov: 'unknown', tip: `label unknown: ${isStr(f?.reason) ? f.reason : 'not provided by the source'}` };
}

// Rows for agents outside the role x unit matrix: one row per phase in order of first appearance in `agents`, the agents with
// no phase in one row "phase unknown" (placed where its first agent appears). Cells are that row's agents in start order.
// The row key keeps a phase that is titled like the unknown row apart from it.
export function fallbackRows(agents) {
  const rows = [];
  const at = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    const phase = isStr(val(a.phase)) ? val(a.phase) : null;
    const key = phase === null ? keyOf('phase-unknown') : keyOf('phase', phase);
    let row = at.get(key);
    if (!row) {
      row = { key, phase, title: phase ?? 'phase unknown', reason: phase === null ? (isStr(a.phase?.reason) ? a.phase.reason : 'no phase recorded') : null, agents: [] };
      at.set(key, row);
      rows.push(row);
    }
    row.agents.push(a);
  }
  return rows.map((row) => ({
    ...row,
    cells: byStart(row.agents).map((agent) => ({ id: agent.id, agent, caption: captionOf(agent), state: visualState(agent) })),
  }));
}

// The note over the fallback rows. Every agent that is not in the role x unit matrix counts, an agent with no label included.
export const notParsedNote = (n) => `${n} ${n === 1 ? 'label does' : 'labels do'} not parse as role:unit`;

// What the matrix view draws: mode 'empty' (no agent), 'matrix' (every agent parses), 'mixed' (some do) or 'fallback' (none).
export function matrixModel(run) {
  const all = agentsOf(run);
  const parsed = parsedAgents(run);
  const inMatrix = new Set(parsed.map((a) => a.id));
  const rest = all.filter((a) => !inMatrix.has(a.id));
  const roles = matrixRoles(parsed);
  return {
    mode: !all.length ? 'empty' : !parsed.length ? 'fallback' : rest.length ? 'mixed' : 'matrix',
    roles,
    rows: matrixRows(parsed, roles),
    fallback: fallbackRows(rest),
    unparsed: rest.length,
    note: rest.length ? notParsedNote(rest.length) : null,
  };
}

// agentId -> how many recognised findings it has (one pass over the findings; those of the run result are no agent's)
export function findingCounts(run) {
  const out = new Map();
  for (const f of Array.isArray(run?.recognized?.findings) ? run.recognized.findings : []) {
    if (!isRunScope(f)) out.set(f.agentId, (out.get(f.agentId) ?? 0) + 1); // an item of the run result belongs to no agent
  }
  return out;
}

// ---------- the elapsed clock ----------

// The milliseconds to show on a clock tick, or null when the clock must stop. Only a run that is running now counts up: its times
// are on the clock of now and it has no duration of its own yet. A final run, a replay (its times are the run's own, past times)
// and a demo run (synthetic: its elapsed time is drawn with each snapshot, no timer) do not tick. A Run that carries no source at
// all (not in the contract: a Run always has one) is read as live, as it always was.
export function clockTick(run, now) {
  if (!run || isFinalStatus(run.status) || !(run.source === undefined || run.source === 'real')) return null;
  const f = elapsedFact(run, now);
  return f && f !== run.durationMs && f.prov === 'inferred' && typeof f.value === 'number' ? f.value : null;
}

// ---------- the tests card ----------

// What the tests card shows: the rows (testRows) and how many of the run's rows they are. `total` is every recognised test result of
// the run, `shown` the rows drawn, so a card that draws fewer than the run has can say "showing N of M" and offer the rest
// (`expanded`: all of them, `canCollapse`: there are more than the card shows by default).
export function testsView(run, { max = 8, expanded = false } = {}) {
  const total = Array.isArray(run?.recognized?.tests) ? run.recognized.tests.length : 0;
  const rows = testRows(run, { max: expanded ? Math.max(total, max) : max });
  return { rows, shown: rows.length, total, hidden: total - rows.length, canCollapse: expanded && total > max };
}

// The last `max` rows of recognised test results, newest first. Rows of one agent are told apart: "label · summary k of n",
// k counting from the first row of that agent in the Run, n all rows of that agent (not only the shown ones). The rows of the run
// result (scope run: no agent) are one owner of their own, labelled RUN_RESULT_LABEL, with their own k of n, a key in a space of
// its own and their path, so they open the run result and never an agent. The key adds the ordinal inside (owner, path),
// because several summaries of one string share both. Role and unit are given only when the Run has both for the agent; a missing
// count stays missing.
const RUN_OWNER = Symbol('run result');
export function testRows(run, { max = 8 } = {}) {
  const tests = Array.isArray(run?.recognized?.tests) ? run.recognized.tests : [];
  const ownerOf = (t) => (isRunScope(t) ? RUN_OWNER : t.agentId);
  const total = new Map();
  for (const t of tests) total.set(ownerOf(t), (total.get(ownerOf(t)) ?? 0) + 1);
  const seenOf = new Map();
  const seenAt = new Map();
  const rows = tests.map((t) => {
    const owner = ownerOf(t);
    const k = (seenOf.get(owner) ?? 0) + 1;
    seenOf.set(owner, k);
    const pathKey = keyOf(isRunScope(t) ? 'run' : 'agent', t.agentId ?? null, t.path ?? null);
    const ord = (seenAt.get(pathKey) ?? 0) + 1;
    seenAt.set(pathKey, ord);
    const n = total.get(owner);
    const count = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const counts = { passed: count(t.passed), failed: count(t.failed), skipped: count(t.skipped), method: isStr(t.method) ? t.method : null };
    if (owner === RUN_OWNER) {
      return {
        key: keyOf('run-test', t.path ?? null, ord), scope: 'run', agentId: null, label: RUN_RESULT_LABEL, path: t.path ?? null,
        caption: n > 1 ? `${RUN_RESULT_LABEL} · summary ${k} of ${n}` : RUN_RESULT_LABEL,
        k, n, role: null, unit: null, ...counts,
      };
    }
    const a = run?.agents?.[t.agentId];
    const label = isStr(val(a?.label)) ? val(a.label) : String(t.agentId);
    const hasBoth = isStr(val(a?.role)) && isStr(val(a?.unit));
    return {
      key: keyOf('test', t.agentId, t.path ?? null, ord),
      scope: 'agent',
      agentId: t.agentId,
      label,
      caption: n > 1 ? `${label} · summary ${k} of ${n}` : label,
      k, n,
      role: hasBoth ? val(a.role) : null,
      unit: hasBoth ? val(a.unit) : null,
      ...counts,
    };
  });
  return rows.slice(-max).reverse();
}

// ---------- the tracking notice: advice for whoever writes a workflow ----------
// The text of the notice, as it is copied. It names only the label pattern and the result fields the page recognises (docs/contract.md
// sections 2 and 3), and says in its first lines that none of it is required. One string, with no HTML in it: the page puts it in a
// read-only text box with `.value`, and copies this constant, never the text of an element.
export const TRACKING_PROMPT = [
  `Optional conventions so wfviz (a local viewer of Dynamic Workflow runs) can show this workflow in more detail. Use what fits; skip what does not. None of this is required: the workflow must work the same without it.`,
  `- Agent labels: "<role>:<unit>", with "#r<n>" for a repeat round, e.g. "writer:intro", "writer:intro#r2". wfviz then draws a role x unit matrix.`,
  `- Phases: pass a phase to each agent, so agents group by stage.`,
  `- Results as JSON objects:`,
  `  - problems found: an array "findings", each item { "file", "line", "severity", "description", "input" } (any subset; "file" helps most);`,
  `  - a decision: a string field "verdict", with an optional "reason";`,
  `  - test counts: an object "tests" with numeric "passed", "failed", "skipped".`,
  `- The workflow's own return value: put the run totals there, e.g. one "tests" object, so wfviz shows them as the run total.`,
  `- log() a short line when a phase starts or ends.`,
].join('\n');

// The notice is open unless the stored value says it was closed. Only the exact "1" the page writes on closing counts: a missing value, a
// storage that gave nothing (null) and any other text open it.
export const hintInitiallyOpen = (storedValue) => storedValue !== '1';

// How the prompt is copied: 'clipboard' (navigator.clipboard.writeText) only when that function is there, else 'select' (select the text
// in the box and ask the document to copy it). `nav` is the page's navigator, or undefined where there is none.
export const copyPath = (nav) => (typeof nav?.clipboard?.writeText === 'function' ? 'clipboard' : 'select');

// The text of the copy button for what happened last: 'idle' (nothing yet, or the 2 s are over), 'copied', 'failed'. Anything else is 'idle'.
const COPY_LABELS = { idle: 'Copy prompt', copied: 'Copied', failed: 'Copy failed — select the text' };
export const copyLabel = (status) => (Object.hasOwn(COPY_LABELS, status) ? COPY_LABELS[status] : COPY_LABELS.idle);

// Focus an element without scrolling anything to it (the page and its boxes stay where they are); an element with no focus() is left alone.
export const focusQuietly = (el) => { if (typeof el?.focus === 'function') el.focus({ preventScroll: true }); };
// The whole text of a box selected, with the focus on it, so that a copy (the command, or Ctrl+C by hand) takes all of it.
export const selectAll = (el) => { focusQuietly(el); if (typeof el?.select === 'function') el.select(); };

// =====================================================================================================================
// Replay of a finished run inside the real server (contract sections 1 and 4). The page asks GET /api/runs/:id/replay, reads the stream
// with fetch (so a refusal's status and reason can be read, and a finished stream is not opened again by itself) and shows the replayed
// Run from empty to final. Decided here, drawn by app.js: which controls show, how the stream is cut into frames, how Pause and Resume queue them.
// =====================================================================================================================

// The speeds of the control, and the one used when a stored value is none of them.
export const REPLAY_SPEEDS = [1, 4, 20];
export const DEFAULT_REPLAY_SPEED = 4;

// The speed the control takes from storage (a text) or from its own value: one of REPLAY_SPEEDS written exactly as the control writes it
// ("20", not "020" or "20.0"), else the default (a missing value, an empty text, any other text, 0, 0.5 and 100 are not control values).
export function parseReplaySpeed(value) {
  const n = REPLAY_SPEEDS.find((speed) => speed === value || String(speed) === value);
  return n === undefined ? DEFAULT_REPLAY_SPEED : n;
}

// The address of a replay: the run id is encoded, the speed is a number made here from REPLAY_SPEEDS, never the text that was given.
export const replayUrl = (runId, speed) => `/api/runs/${encodeURIComponent(runId)}/replay?speed=${parseReplaySpeed(speed)}`;

// A run is running when its status Fact has the value "running". Any other value counts as not running, an unknown status (no value)
// too: the server answers 409 for the first only, and the page offers a replay for the rest. The prov of the Fact is not read.
export const isRunningStatus = (status) => status?.value === 'running';

// Only a Run of source "real" that is not running can be replayed. A Run with no source (not in the contract) and a Run of another source
// (demo, replay) cannot.
export const canReplay = (run) => run?.source === 'real' && !isRunningStatus(run.status);

export const REPLAY_FINISHED = 'replay finished';
export const REPLAY_WAITING = 'Replay starting: no event of the run has been played yet.';

// What the replay control shows. `run` is the Run on show; `replay` is null, or the state of the replay: its phase ('connecting',
// 'playing', 'paused', 'ended' or 'failed'), `shown` (the replayed view has taken the place of the real one), `line` (the reason of a
// failure) and `real` (the real Run the replay was started from: while it is on show the Run on show is the replayed one).
// Answers: speed (the speed choice shows), go (the label of the button that starts a replay, or null), pause (the label of the pause
// button: 'Pause' or 'Resume', or null), stop (the button that goes back to the real view shows), note (a line of text, or null).
export function replayControl(run, replay) {
  const none = { speed: false, go: null, pause: null, stop: false, note: null };
  const real = replay ? replay.real : run;
  if (!replay) return canReplay(run) ? { ...none, speed: true, go: 'Replay' } : none;
  switch (replay.phase) {
    case 'connecting':
    case 'playing':
      return { ...none, pause: 'Pause', stop: true };
    case 'paused':
      return { ...none, pause: 'Resume', stop: true };
    case 'ended':
      return { ...none, speed: canReplay(real), go: canReplay(real) ? 'Replay again' : null, stop: true, note: REPLAY_FINISHED };
    case 'failed': {
      // a replay that never began leaves the real view as it is; one that was cut off leaves what it had shown, and a way back
      const go = canReplay(real) ? (replay.shown ? 'Replay again' : 'Replay') : null;
      return { ...none, speed: go !== null, go, stop: replay.shown === true, note: isStr(replay.line) ? replay.line : 'the replay failed, no reason given' };
    }
    default:
      return canReplay(run) ? { ...none, speed: true, go: 'Replay' } : none;
  }
}

// The reason a refused request shows: the `error` text of the JSON body when it has one, else the HTTP status or the error's own message.
export function replayFailure({ status, body, error } = {}) {
  if (isStr(body?.error) && body.error !== '') return body.error;
  return fetchErrorText({ status, error });
}

// What the replay stream must say first: its mode is "replay" and its run is the one asked for. Returns the problem as a text, or null.
export function replayHelloProblem(hello, runId) {
  if (hello?.mode === 'replay' && hello.runId === runId) return null;
  return `unexpected hello from the replay stream (mode ${JSON.stringify(hello?.mode ?? null)}, run ${JSON.stringify(hello?.runId ?? null)})`;
}

// A snapshot of the replay must be a Run of source "replay" and of the run asked for: a real Run is never shown as the replay.
export function replayRunProblem(run, runId) {
  if (run?.source === 'replay' && run.id === runId) return null;
  return `the replay stream sent a Run that is not the replay of ${JSON.stringify(runId)} (source ${JSON.stringify(run?.source ?? null)})`;
}

export const replayCutText = (count) => `stream ended before the end (${count} event${count === 1 ? '' : 's'} played)`;

// Text chunks -> SSE frames. feed(chunk) returns the frames that the chunk completed, as { event, data } with `data` still the text (the
// page parses it inside a try). A frame cut over two chunks waits for the rest; a comment line (": heartbeat") and the fields `id` and
// `retry` are skipped; several `data` lines are joined with a line feed; a frame with no data is not a frame. A line ends with \n, \r\n
// or \r, and a chunk that ends with \r waits for the next one (it may be half of \r\n). A frame that never gets its blank line is lost.
export function createSseParser() {
  let rest = '';
  let event = null;
  let data = [];
  return {
    feed(chunk) {
      rest += String(chunk);
      const frames = [];
      if (rest.endsWith('\r')) return frames;
      const lines = rest.split(/\r\n|\n|\r/);
      rest = lines.pop();
      for (const line of lines) {
        if (line === '') {
          if (data.length) frames.push({ event: event ?? 'message', data: data.join('\n') });
          event = null;
          data = [];
        } else if (line.startsWith(':')) {
          continue;
        } else {
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          let value = i < 0 ? '' : line.slice(i + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
      }
      return frames;
    },
  };
}

// One frame as { name, value } with the JSON read; a frame whose data is not JSON is { name, bad: true } (the page ends the replay with a line).
export function readReplayFrame(frame) {
  try {
    return { name: frame.event, value: JSON.parse(frame.data) };
  } catch {
    return { name: frame?.event ?? null, bad: true };
  }
}

// The queue between the replay stream and the page (contract section 1: Pause keeps the frames, Resume plays them with the gaps they
// arrived with). Every frame of the stream (`run`, `event`, `end`, and the page's own failure markers) goes in with the time the page
// read it. Nothing is read from the frame: its ts is not a pace, and no delay, minimum gap or cap is made up. The clock and the timer are
// given, so the queue is testable with a fake one: now() is a number of ms, setTimer(fn, ms) returns a handle, clearTimer(handle) cancels
// it, apply(name, value) draws one frame.
//   playing, nothing kept, nothing paused so far: a frame is applied on arrival (no delay, no timer).
//   pause(): frames are kept in order, none is applied, the timer is cancelled; whether a frame was kept at that moment is remembered.
//   resume(): `offset` is how far the view runs behind the stream, and a kept frame is applied at its arrival time plus `offset`, so the
//     gaps between frames are the gaps they arrived with. The view falls behind only by what the pause held back:
//       a frame was kept when the pause began: it waited, and keeps the wait it had left, so `offset` grows by the time paused;
//       nothing was kept and no frame came during the pause: nothing was held back, `offset` does not grow;
//       nothing was kept and a frame came during the pause: the first kept frame is shown at the resume (or at its own due time, when
//         that is later), so `offset` grows by how long that frame was due before the resume, never by less than 0 (it never shrinks).
//     Every frame that is already due is applied in order, in one pass, and one timer waits for the next. A frame that arrives later is
//     due at its arrival time plus the same offset, so it goes behind the kept ones, and a second pause that comes while the queue
//     catches up adds to the offset and so moves every kept frame at once.
//   One timer at a time, none when nothing is kept or while paused. clear() drops every kept frame and the timer.
//   A snapshot (`run`) directly followed by a newer snapshot, with nothing between them, is dropped: the newer one says all it says.
// A frame that is applied may call pause() or clear() (a failure): the pass stops at once.
export function createReplayQueue({ now, setTimer, clearTimer, apply }) {
  let items = [];
  let offset = 0;
  let pausedAt = null;
  let keptAtPause = false; // whether a frame was kept when the current pause began
  let timer = null;
  const due = (item) => item.at + offset;
  const disarm = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const arm = () => {
    disarm();
    if (pausedAt !== null || items.length === 0) return;
    timer = setTimer(() => { timer = null; drain(); }, Math.max(0, due(items[0]) - now()));
  };
  function drain() {
    try {
      while (pausedAt === null && items.length > 0 && due(items[0]) <= now()) {
        const item = items.shift();
        apply(item.name, item.value);
      }
    } finally {
      arm();
    }
  }
  return {
    push(name, value) {
      const item = { at: now(), name, value };
      if (pausedAt === null && items.length === 0 && due(item) <= item.at) {
        apply(name, value);
        return;
      }
      if (name === 'run' && items.length > 0 && items[items.length - 1].name === 'run') {
        if (items.length === 1) disarm(); // the one the timer waited for is gone
        items.pop();
      }
      items.push(item);
      if (pausedAt === null && timer === null) arm();
    },
    pause() {
      if (pausedAt !== null) return;
      pausedAt = now();
      keptAtPause = items.length > 0;
      disarm();
    },
    resume() {
      if (pausedAt === null) return;
      if (keptAtPause) offset += Math.max(0, now() - pausedAt);
      else if (items.length > 0) offset += Math.max(0, now() - due(items[0]));
      pausedAt = null;
      drain();
    },
    clear() {
      items = [];
      disarm();
    },
    // how many frames are kept, whether the queue is paused, whether a timer waits, and how far the view runs behind the stream (ms)
    get size() { return items.length; },
    get paused() { return pausedAt !== null; },
    get waiting() { return timer !== null; },
    get offset() { return offset; },
  };
}

// =====================================================================================================================
// search of the loaded runs (GET /api/search, contract section 4)
//
// The server answers { results: [{ runId, agentId?, field, excerpt, start, end }], more }: one result per field of a loaded run (its first match),
// `start` / `end` UTF-16 offsets into `excerpt`. Everything here is pure: the query logic gets its fetch, timer and controller from the page.
// =====================================================================================================================

export const SEARCH_DELAY_MS = 250;
export const SEARCH_BUSY_TEXT = 'searching...';
export const SEARCH_NONE_TEXT = 'no results';
export const SEARCH_MORE_TEXT = 'more results not shown'; // no number: the server does not count what it did not look at
// No result and `more: true`: the page asks with no limit (the server's default is 50, so no result cannot be a full list), so the scan was cut by its
// time budget before it found a match. That is not "no results": the runs were not all looked at (a first search reads each run once, a second is faster).
export const SEARCH_CUT_TEXT = 'search stopped at the time limit, no result yet: try again';
export const searchFailedText = (reason) => `search failed: ${isStr(reason) ? reason : 'no reason given'}`;
export const searchUrl = (text) => `/api/search?q=${encodeURIComponent(text)}`; // the text as typed: not trimmed

// The fields the server names, in words for a row; one it does not know is shown as the server wrote it.
const SEARCH_FIELD_TEXT = new Map([
  ['name', 'run name'], ['description', 'run description'], ['log', 'log line'], ['prompt', 'prompt'], ['result', 'result'],
  ['activity-summary', 'activity: tool input'], ['activity-text', 'activity: text'],
]);
export const searchFieldText = (field) => SEARCH_FIELD_TEXT.get(field) ?? String(field);

// The section of the agent drawer (its data-sec) that shows a field; null for the fields of a run, which have no section of an agent.
const SEARCH_SECTION = new Map([['prompt', 'prompt'], ['result', 'result'], ['activity-summary', 'activity'], ['activity-text', 'activity']]);
export const searchSection = (field) => SEARCH_SECTION.get(field) ?? null;

// The line that says what a search does not cover: the runs of the list that are only listed, not loaded (they have no text to search).
export function notSearchedLine(runs) {
  const n = (Array.isArray(runs) ? runs : []).filter((r) => r?.loaded === false).length;
  return n === 0 ? '' : `${n} run${n === 1 ? ' is' : 's are'} not loaded and not searched: open one in the run picker to load it`;
}

// The answer of the server as the page keeps it: { ok: true, results, more } or { ok: false, reason }. A result that lacks a run id, a field or
// an excerpt (or has an agent id that is not text) cannot be shown and is left out; its offsets are checked where it is drawn.
export function searchAnswer(data) {
  if (!isObj(data) || !Array.isArray(data.results)) return { ok: false, reason: 'the answer is not a search result' };
  const results = [];
  for (const h of data.results) {
    if (!isObj(h) || !isStr(h.runId) || typeof h.field !== 'string' || typeof h.excerpt !== 'string') continue;
    if (h.agentId !== undefined && typeof h.agentId !== 'string') continue;
    results.push({ runId: h.runId, ...(h.agentId === undefined ? {} : { agentId: h.agentId }), field: h.field, excerpt: h.excerpt, start: h.start, end: h.end });
  }
  return { ok: true, results, more: data.more === true };
}

// An excerpt cut at its match: { before, match, after } of the same text. Offsets that are not whole numbers, are negative, reversed, empty,
// past the end or inside a surrogate pair mark nothing: the whole excerpt is `before`. Never a throw.
export function highlightParts(excerpt, start, end) {
  const text = typeof excerpt === 'string' ? excerpt : '';
  const pair = (i) => i > 0 && i < text.length && text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end || pair(start) || pair(end)) return { before: text, match: '', after: '' };
  return { before: text.slice(0, start), match: text.slice(start, end), after: text.slice(end) };
}

// The rows of the results list: one item per result, keyed by run, agent, field and the place among equal ones (so a row keeps its element
// when the list changes at the end), with the words the row shows. The page knows the label of an agent only for the run on show; for any
// other run the row shows the agent id. The run's name is the list's Fact, or the run id when the list does not know it.
export function searchItems(results, runs, shownRun) {
  const list = Array.isArray(runs) ? runs : [];
  return dedupeKeys((Array.isArray(results) ? results : []).map((h) => {
    const name = val(list.find((r) => r?.id === h.runId)?.name);
    let agent = null;
    if (h.agentId !== undefined) {
      const label = shownRun?.id === h.runId && isObj(shownRun.agents) && Object.hasOwn(shownRun.agents, h.agentId) ? val(shownRun.agents[h.agentId]?.label) : null;
      agent = isStr(label) ? label : h.agentId;
    }
    return { key: keyOf('hit', h.runId, h.agentId ?? null, h.field), hit: h, runName: isStr(name) ? name : h.runId, agent, fieldText: searchFieldText(h.field) };
  }));
}

// The line over the results: why there are none (or not yet: an empty answer that says `more` was cut short, it is not "no results"), or that
// there are more than shown. '' when the list says it all.
export function searchStatus(view) {
  if (view?.phase === 'waiting' || view?.phase === 'loading') return SEARCH_BUSY_TEXT;
  if (view?.phase === 'failed') return searchFailedText(view.reason);
  if (view?.phase === 'done') return view.results.length === 0 ? (view.more ? SEARCH_CUT_TEXT : SEARCH_NONE_TEXT) : view.more ? SEARCH_MORE_TEXT : '';
  return '';
}

// The query logic of the search box. `fetchJson(url, signal)` -> { data, error, reason } (never throws); `setTimer(fn, ms)` / `clearTimer(handle)`;
// `makeController()` -> { signal, abort() }; `onChange(view)` is told after every change. The view is
//   { phase: 'idle' | 'waiting' | 'loading' | 'done' | 'failed', text, results, more, reason }:
// typing waits `delay` ms (one timer at most, cleared before another is made, when it fires and on cancel) and then asks; a newer query
// aborts the older request, and an answer of a request that was aborted or superseded is never drawn, whatever the fetch did with the signal.
// While a newer query is waiting or out, the results of the last one stay on show (nothing flashes away and back). Text that is empty or only
// space asks for nothing and clears. The text sent is the text typed. A failure clears the results (they would answer another question) and
// says why; it is not "no results".
export function createSearch({ fetchJson, setTimer, clearTimer, makeController, onChange, delay = SEARCH_DELAY_MS }) {
  let timer = null;
  let controller = null;
  let turn = 0;
  const IDLE = { phase: 'idle', text: '', results: [], more: false, reason: null };
  let view = IDLE;
  const show = (patch) => {
    view = { ...view, ...patch };
    onChange(view);
  };
  // what is waiting or out is dropped, and whatever answers later is not for the current query
  const stop = () => {
    turn += 1;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (controller !== null) { const c = controller; controller = null; c.abort(); }
  };
  async function ask(text, mine) {
    const c = makeController();
    controller = c;
    show({ phase: 'loading' });
    let got;
    try {
      got = await fetchJson(searchUrl(text), c.signal);
    } catch (err) {
      got = { data: null, error: err };
    }
    if (mine !== turn || c.signal.aborted) return; // an aborted or superseded query is not a failure and draws nothing
    controller = null;
    if (got == null || got.error != null || got.reason != null) return show({ phase: 'failed', results: [], more: false, reason: got?.reason ?? fetchErrorText({ error: got?.error }) });
    const a = searchAnswer(got.data);
    if (!a.ok) return show({ phase: 'failed', results: [], more: false, reason: a.reason });
    return show({ phase: 'done', results: a.results, more: a.more, reason: null });
  }
  return {
    input(text) {
      stop();
      const typed = typeof text === 'string' ? text : '';
      if (typed.trim() === '') {
        view = IDLE;
        onChange(view);
        return;
      }
      const mine = turn;
      show({ phase: 'waiting', text: typed });
      timer = setTimer(() => { timer = null; ask(typed, mine); }, delay);
    },
    // Esc: nothing waits, nothing is out, the results are gone
    cancel() {
      stop();
      view = IDLE;
      onChange(view);
    },
    get view() { return view; },
  };
}
