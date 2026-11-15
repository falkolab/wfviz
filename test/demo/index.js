// Tests for src/source/demo.mjs (node N7).
//
// This file is named index.js on purpose: `node --test test/demo/` on Node 26 runs a directory
// argument as `node test/demo/`, which needs an entry file; on Node 20 the runner scans the
// directory and runs this same file. Either way the tests below are the only ones in the folder.
//
// Most tests run on a fake clock (injected through the `now` and `timers` options), so a run of
// about 80 virtual seconds takes milliseconds and nothing depends on real time. Three tests use
// the real timers at a high speed to check stop() and the end of a run against the actual event loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDemoSource } from '../../src/source/demo.mjs';
import { reduceRun } from '../../src/model/reduce.mjs';
import { inferEdges, MIN_SHARED_CHARS } from '../../src/model/infer.mjs';

const DEMO_FILE = fileURLToPath(new URL('../../src/source/demo.mjs', import.meta.url));
const KINDS = new Set([
  'run.script', 'run.launched', 'agent.started', 'agent.meta', 'agent.prompt',
  'agent.activity', 'agent.result', 'run.final',
]);
const LABEL = /^(implement|reviewer-a|reviewer-b|judge|fix|test):([^:#]+)(?:#r(\d+))?$/;
// agent.meta is left out: its data has no agentId (contract section 1), see metaFor().
const AGENT_KINDS = new Set(['agent.started', 'agent.prompt', 'agent.activity', 'agent.result']);

// ---------------------------------------------------------------------------------------
// helpers

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  let seq = 0;
  const queue = new Map();
  const earliest = (limit) => {
    let next = null;
    for (const e of queue.values()) {
      if (e.at > limit) continue;
      if (!next || e.at < next.at || (e.at === next.at && e.id < next.id)) next = e;
    }
    return next;
  };
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      queue.set(id, { id, fn, at: t + Math.max(0, ms) });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    get pending() {
      return queue.size;
    },
    advance(ms) {
      const until = t + ms;
      for (let e = earliest(until); e; e = earliest(until)) {
        queue.delete(e.id);
        t = Math.max(t, e.at);
        e.fn();
      }
      t = Math.max(t, until);
    },
    runAll(limit = 100_000) {
      for (let n = 0, e = earliest(Infinity); e; e = earliest(Infinity)) {
        if (++n > limit) throw new Error('fake clock: too many timers');
        queue.delete(e.id);
        t = Math.max(t, e.at);
        e.fn();
      }
    },
  };
}

// One complete run (loop off) on the fake clock.
async function playRun({ speed = 1 } = {}) {
  const clock = fakeClock();
  const events = [];
  const src = createDemoSource({ speed, loop: false, now: clock.now, timers: clock, onEvent: (e) => events.push(e) });
  await src.start();
  clock.runAll();
  return { events, clock, src };
}

let cachedRun = null;
const standardRun = async () => (cachedRun ??= await playRun());

// Group the agent events of a run by agent and remember where each one sits in the stream.
function indexAgents(events) {
  const agents = new Map();
  events.forEach((e, i) => {
    if (!AGENT_KINDS.has(e.kind)) return;
    const id = e.data.agentId;
    if (!agents.has(id)) agents.set(id, { id, started: null, prompt: null, activities: [], result: null });
    const a = agents.get(id);
    if (e.kind === 'agent.started') Object.assign(a, { started: { e, i }, label: e.data.label, phase: e.data.phase });
    else if (e.kind === 'agent.prompt') a.prompt = { e, i };
    else if (e.kind === 'agent.activity') a.activities.push({ e, i });
    else a.result = { e, i };
  });
  return [...agents.values()];
}

// agent.meta carries no agentId, so it is linked to its agent through the pseudo file name
// (the real file is agent-<id>.meta.json).
function metaFor(events, agent) {
  return events.find((e) => e.kind === 'agent.meta' && e.prov.file.includes(`agent-${agent.id}.meta.json`));
}

function parseLabel(label) {
  const m = LABEL.exec(label);
  assert.ok(m, `label does not match the role:unit#rN pattern: ${label}`);
  return { role: m[1], unit: m[2], round: m[3] ? Number(m[3]) : null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutCount = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

// ---------------------------------------------------------------------------------------
// every event is demo-tagged

test('every event is tagged as demo and has the RawEvent shape', async () => {
  const { events } = await standardRun();
  assert.ok(events.length > 100, `expected a full run, got ${events.length} events`);
  const runId = events[0].runId;
  for (const e of events) {
    assert.equal(e.src, 'demo');
    assert.ok(KINDS.has(e.kind), `unexpected kind ${e.kind}`);
    assert.ok(e.runId.startsWith('demo-'), e.runId);
    assert.equal(e.runId, runId, 'one run, one runId');
    assert.equal(e.data.demo, true, `${e.kind} lacks data.demo`);
    assert.equal(e.sessionId, null);
    assert.equal(typeof e.project, 'string');
    assert.ok(Number.isFinite(e.ts));
    assert.ok(typeof e.prov.file === 'string' && e.prov.file.startsWith('demo://'), e.prov.file);
    assert.ok(e.prov.line === null || (Number.isInteger(e.prov.line) && e.prov.line >= 1));
  }
  assert.ok(!events.some((e) => e.src === 'claude-fs'));
});

test('events do not share objects with the scenario: mutating one does not change the next run', async () => {
  const clock = fakeClock();
  const first = [];
  const src = createDemoSource({ speed: 1, loop: false, now: clock.now, timers: clock, onEvent: (e) => first.push(e) });
  await src.start();
  clock.runAll();
  const result = first.find((e) => e.kind === 'agent.result' && typeof e.data.result === 'object');
  const before = JSON.stringify(result.data.result);
  result.data.result.verdict = 'tampered';
  first.find((e) => e.kind === 'run.script').data.meta.name = 'tampered';
  const second = await playRun();
  const again = second.events.filter((e) => e.kind === 'agent.result' && typeof e.data.result === 'object')[0];
  assert.equal(JSON.stringify(again.data.result), before);
  assert.notEqual(second.events.find((e) => e.kind === 'run.script').data.meta.name, 'tampered');
});

// ---------------------------------------------------------------------------------------
// event order

test('run.script and run.launched come first, run.final comes last, timestamps never go back', async () => {
  const { events } = await standardRun();
  assert.deepEqual(events.slice(0, 2).map((e) => e.kind), ['run.script', 'run.launched']);
  assert.equal(events.at(-1).kind, 'run.final');
  for (const kind of ['run.script', 'run.launched', 'run.final']) {
    assert.equal(events.filter((e) => e.kind === kind).length, 1, kind);
  }
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts, `ts went back at ${i}`);
});

test('for every agent: started, meta, prompt, then activity, then result, each started once', async () => {
  const { events } = await standardRun();
  const agents = indexAgents(events);
  assert.ok(agents.length > 0);
  for (const a of agents) {
    assert.ok(a.started, `agent ${a.id} has no started`);
    assert.ok(a.result, `agent ${a.id} has no result`);
    assert.ok(a.prompt, `agent ${a.id} has no prompt`);
    assert.ok(metaFor(events, a), `agent ${a.id} has no meta`);
    assert.ok(a.started.i < a.prompt.i, 'started before prompt');
    assert.ok(a.prompt.i < a.result.i, 'prompt before result');
    assert.ok(a.activities.length >= 1);
    for (const act of a.activities) {
      assert.ok(act.i > a.started.i && act.i < a.result.i, 'activity between started and result');
    }
    assert.ok(a.started.e.ts <= a.result.e.ts);
  }
  const count = (k) => events.filter((e) => e.kind === k).length;
  assert.equal(count('agent.started'), agents.length);
  assert.equal(count('agent.result'), agents.length);
  assert.equal(count('agent.meta'), agents.length);
  assert.equal(count('agent.prompt'), agents.length);
});

test('prov.line counts journal lines and transcript lines without gaps', async () => {
  const { events } = await standardRun();
  const perFile = new Map();
  for (const e of events) {
    if (e.prov.line === null) continue;
    if (!perFile.has(e.prov.file)) perFile.set(e.prov.file, []);
    perFile.get(e.prov.file).push(e.prov.line);
  }
  const journals = [...perFile.keys()].filter((f) => f.endsWith('/journal.jsonl'));
  assert.equal(journals.length, 1);
  for (const [file, lines] of perFile) {
    assert.deepEqual(lines, lines.map((_, i) => i + 1), `lines of ${file} are not 1..n`);
  }
  const first = indexAgents(events)[0];
  assert.equal(first.prompt.e.prov.line, 1, 'the prompt is the first transcript record');
});

// ---------------------------------------------------------------------------------------
// shape: implement -> two reviewers in parallel -> judge -> fixer -> tests, 3 units

test('workflow shape: implement, two parallel reviewers, judge, fixer, tests, per round and unit', async () => {
  const { events } = await standardRun();
  const agents = indexAgents(events).map((a) => ({ ...a, ...parseLabel(a.label) }));
  const units = [...new Set(agents.map((a) => a.unit))].sort();
  assert.deepEqual(units, ['chunk.js', 'slugify.js', 'sum.js']);

  const expectedRounds = { 'slugify.js': 1, 'sum.js': 2, 'chunk.js': 3 };
  const phases = { implement: 'Implement', 'reviewer-a': 'Review', 'reviewer-b': 'Review', judge: 'Judge', fix: 'Fix', test: 'Test' };
  for (const a of agents) assert.equal(a.phase, phases[a.role], `${a.label} is in phase ${a.phase}`);

  for (const unit of units) {
    const mine = agents.filter((a) => a.unit === unit);
    const one = (role, round) => {
      const found = mine.filter((a) => a.role === role && a.round === round);
      assert.equal(found.length, 1, `${unit}: expected one ${role} in round ${round}, got ${found.length}`);
      return found[0];
    };
    const impl = one('implement', null);
    const rounds = Math.max(...mine.map((a) => a.round ?? 0));
    assert.equal(rounds, expectedRounds[unit], `${unit} rounds`);
    assert.ok(rounds <= 3);
    assert.equal(mine.length, 1 + 5 * rounds, `${unit}: agent count`);

    let previous = impl;
    for (let r = 1; r <= rounds; r++) {
      const a = one('reviewer-a', r);
      const b = one('reviewer-b', r);
      const judge = one('judge', r);
      const fix = one('fix', r);
      const tests = one('test', r);
      assert.ok(a.started.i > previous.result.i && b.started.i > previous.result.i, `${unit} r${r}: reviewers wait for ${previous.label}`);
      assert.ok(Math.max(a.started.i, b.started.i) < Math.min(a.result.i, b.result.i), `${unit} r${r}: reviewers run in parallel`);
      assert.ok(Math.max(a.started.e.ts, b.started.e.ts) < Math.min(a.result.e.ts, b.result.e.ts), `${unit} r${r}: reviewers overlap in time`);
      assert.ok(judge.started.i > Math.max(a.result.i, b.result.i), `${unit} r${r}: judge waits for both reviewers`);
      assert.ok(fix.started.i > judge.result.i, `${unit} r${r}: fixer waits for judge`);
      assert.ok(tests.started.i > fix.result.i, `${unit} r${r}: tests wait for fixer`);
      previous = tests;
    }
  }

  const impls = agents.filter((a) => a.role === 'implement');
  assert.equal(impls.length, 3);
  assert.ok(Math.max(...impls.map((a) => a.started.i)) < Math.min(...impls.map((a) => a.result.i)), 'units run in parallel');
});

test('two units pass and one is blocked after 3 rounds', async () => {
  const { events } = await standardRun();
  const final = events.at(-1).data;
  assert.deepEqual(final.result, {
    units: [
      { unit: 'slugify.js', status: 'done', rounds: 1 },
      { unit: 'sum.js', status: 'done', rounds: 2 },
      { unit: 'chunk.js', status: 'blocked', rounds: 3 },
    ],
    blocked: ['chunk.js'],
  });
  const tests = indexAgents(events)
    .map((a) => ({ ...parseLabel(a.label), result: a.result.e.data.result }))
    .filter((a) => a.role === 'test');
  for (const unit of ['slugify.js', 'sum.js', 'chunk.js']) {
    const mine = tests.filter((t) => t.unit === unit).sort((x, y) => x.round - y.round);
    const last = mine.at(-1).result;
    const earlier = mine.slice(0, -1);
    assert.ok(earlier.every((t) => t.result.failed > 0), `${unit}: a failing round is followed by another round`);
    if (unit === 'chunk.js') assert.ok(last.failed > 0, 'blocked unit still has failing tests after round 3');
    else assert.equal(last.failed, 0, `${unit}: last round passes`);
  }
});

test('agent ids and keys are unique, labels follow role:unit#rN', async () => {
  const { events } = await standardRun();
  const started = events.filter((e) => e.kind === 'agent.started');
  assert.equal(new Set(started.map((e) => e.data.agentId)).size, started.length);
  assert.equal(new Set(started.map((e) => e.data.key)).size, started.length);
  assert.equal(new Set(started.map((e) => e.data.label)).size, started.length);
  for (const e of started) {
    assert.match(e.data.agentId, /^ademo[0-9a-f]{12}$/);
    assert.match(e.data.key, /^v2:[0-9a-f]{64}$/);
    parseLabel(e.data.label);
    assert.ok(e.data.phase);
  }
});

test('agent.meta matches its started event (label, phase) and agent.result carries the same key', async () => {
  const { events } = await standardRun();
  for (const a of indexAgents(events)) {
    const meta = metaFor(events, a).data;
    assert.equal(meta.description, a.label);
    assert.equal(meta.workflowPhase, a.phase);
    assert.equal(meta.agentType, 'workflow-subagent');
    assert.equal(a.result.e.data.key, a.started.e.data.key);
    assert.equal(a.result.e.data.agentId, a.id);
  }
});

// ---------------------------------------------------------------------------------------
// data the model will read

test('prompts embed earlier results, so data-flow edges can be inferred; the test prompt embeds none', async () => {
  const { events } = await standardRun();
  const agents = indexAgents(events).map((a) => ({
    ...a, ...parseLabel(a.label), text: a.prompt.e.data.text, result: a.result.e.data.result,
  }));
  const get = (unit, role, round) => agents.find((a) => a.unit === unit && a.role === role && a.round === round);
  const unit = 'sum.js';

  const judge = get(unit, 'judge', 1);
  const revA = get(unit, 'reviewer-a', 1);
  const revB = get(unit, 'reviewer-b', 1);
  assert.ok(judge.text.includes(JSON.stringify(revA.result)), 'judge prompt has reviewer A result');
  assert.ok(judge.text.includes(JSON.stringify(revB.result)), 'judge prompt has reviewer B result');

  const fix = get(unit, 'fix', 1);
  assert.ok(fix.text.includes(JSON.stringify(judge.result.findings)), 'fixer prompt has the judge findings');

  const impl = get(unit, 'implement', null);
  assert.ok(typeof impl.result === 'string' && impl.result.length >= 24);
  assert.ok(revA.text.includes(impl.result), 'round 1 reviewers see the implementer report');

  const tests1 = get(unit, 'test', 1);
  const revA2 = get(unit, 'reviewer-a', 2);
  assert.ok(revA2.text.includes(JSON.stringify(fix.result)), 'round 2 reviewers see the fixer result');
  assert.ok(revA2.text.includes(JSON.stringify(tests1.result)), 'round 2 reviewers see the test result');

  assert.ok(!tests1.text.includes(JSON.stringify(fix.result)), 'tests prompt does not embed the fixer result');
  assert.ok(!tests1.text.includes(fix.result.summary));
});

test('no two results of one run serialise identically, so every result can be traced to its agent', async () => {
  const { events } = await standardRun();
  const agents = indexAgents(events);
  const seen = new Map();
  for (const a of agents) {
    const text = JSON.stringify(a.result.e.data.result);
    assert.ok(!seen.has(text), `${a.label} and ${seen.get(text)} return the same result: ${text}`);
    seen.set(text, a.label);
  }
  assert.equal(seen.size, agents.length);
});

test('the model draws a data-flow edge from every reviewer into its judge (reduceRun, inferEdges)', async () => {
  const { events } = await standardRun();
  const run = reduceRun(events);
  const edges = inferEdges(run);
  const idOf = new Map(run.order.map((id) => [run.agents[id].label.value, id]));
  const flows = new Set(edges.filter((e) => e.kind === 'data-flow').map((e) => `${e.from}>${e.to}`));
  let reviewers = 0;
  for (const [label, id] of idOf) {
    const m = /^reviewer-[ab]:(.+#r\d+)$/.exec(label);
    if (!m) continue;
    const judge = idOf.get(`judge:${m[1]}`);
    assert.ok(judge, `no judge for ${label}`);
    assert.ok(flows.has(`${id}>${judge}`), `no data-flow edge from ${label} to judge:${m[1]}`);
    reviewers += 1;
  }
  assert.equal(reviewers, 2 * (1 + 2 + 3), 'two reviewers in each of the six rounds');
});

test('no data-flow edge joins agents of different units: the three units are independent (reduceRun, inferEdges)', async () => {
  const { events } = await standardRun();
  const run = reduceRun(events);
  const label = (id) => run.agents[id].label.value;
  const unitOf = (id) => parseLabel(label(id)).unit;
  const flows = inferEdges(run).filter((e) => e.kind === 'data-flow');
  assert.ok(flows.length > 20, `the run has data-flow edges at all, got ${flows.length}`); // contract 2: only distinctive text counts (contract 1 gave over 50)
  assert.ok(flows.every((e) => e.from !== e.to));
  assert.ok(flows.some((e) => unitOf(e.from) === unitOf(e.to)), 'edges inside a unit are still drawn');
  const crossing = flows
    .filter((e) => unitOf(e.from) !== unitOf(e.to))
    .map((e) => `${label(e.from)} -> ${label(e.to)}: ${e.evidence}`);
  assert.deepEqual(crossing, []);
});

// The same property at the level of text, so it holds whatever the pace of the units: an edge needs
// only that A ended before B started, and a change of the pace changes which pairs satisfy that.
test('no run of 24 chars of a result recurs in the prompt of another unit, whatever the timing', async () => {
  const { events } = await standardRun();
  const agents = indexAgents(events).map((a) => ({
    ...parseLabel(a.label), label: a.label, prompt: a.prompt.e.data.text, result: a.result.e.data.result,
  }));
  const squash = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, '');
  const grams = (text) => {
    const out = [];
    for (let i = 0; i + MIN_SHARED_CHARS <= text.length; i++) out.push(text.slice(i, i + MIN_SHARED_CHARS));
    return out;
  };
  const owners = new Map(); // 24-gram of a result -> every agent whose result holds it
  for (const a of agents) {
    for (const g of grams(squash(a.result))) owners.set(g, [...(owners.get(g) ?? []), a]);
  }
  assert.ok(owners.size > 500, 'the results have text to compare');
  const shared = [];
  for (const b of agents) {
    for (const g of grams(squash(b.prompt))) {
      for (const a of owners.get(g) ?? []) {
        if (a.unit !== b.unit) shared.push(`${b.label} repeats the result of ${a.label}: ${g}`);
      }
    }
  }
  assert.deepEqual([...new Set(shared)].slice(0, 10), []);
});

test('results have the fields the recognisers read: verdict, findings, test counts', async () => {
  const { events } = await standardRun();
  let findings = 0;
  for (const a of indexAgents(events)) {
    const { role } = parseLabel(a.label);
    const result = a.result.e.data.result;
    if (role === 'implement') {
      assert.equal(typeof result, 'string');
    } else if (role === 'reviewer-a' || role === 'reviewer-b' || role === 'judge') {
      assert.ok(['pass', 'fail'].includes(result.verdict), `${a.label} verdict`);
      assert.ok(Array.isArray(result.findings));
      if (result.verdict === 'pass') assert.equal(result.findings.length, 0);
      for (const f of result.findings) {
        findings += 1;
        assert.equal(typeof f.file, 'string');
        assert.ok(Number.isInteger(f.line) && f.line > 0);
        for (const k of ['severity', 'title', 'description', 'input']) assert.equal(typeof f[k], 'string', `${a.label}.${k}`);
      }
      if (role === 'judge') assert.equal(typeof result.reason, 'string');
    } else if (role === 'fix') {
      assert.equal(typeof result.summary, 'string');
      assert.ok(Array.isArray(result.filesChanged));
    } else {
      for (const k of ['passed', 'failed', 'skipped', 'total']) assert.ok(Number.isInteger(result[k]) && result[k] >= 0, `${a.label}.${k}`);
      assert.equal(result.total, result.passed + result.failed + result.skipped);
    }
    const toolsUsed = a.result.e.data.toolsUsed;
    if (toolsUsed) assert.ok(Array.isArray(toolsUsed) && toolsUsed.length > 0);
  }
  assert.ok(findings > 10, 'the demo has findings to show');
});

test('agent.activity: tool or text, size limits, model and usage', async () => {
  const { events } = await standardRun();
  const activities = events.filter((e) => e.kind === 'agent.activity');
  assert.ok(activities.length > 100);
  for (const { data } of activities) {
    assert.ok(data.tool !== undefined || data.text !== undefined, 'activity has a tool or a text');
    if (data.tool !== undefined) assert.equal(typeof data.tool, 'string');
    if (data.inputSummary !== undefined) assert.ok(data.inputSummary.length <= 200, 'inputSummary > 200');
    if (data.text !== undefined) assert.ok(data.text.length <= 500, 'text > 500');
    assert.match(data.model, /^claude-/);
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      assert.ok(Number.isInteger(data.usage[k]) && data.usage[k] >= 0, k);
    }
  }
  assert.ok(activities.some((e) => e.data.tool === 'StructuredOutput'));
  assert.ok(activities.some((e) => e.data.tool === 'Bash'));
  assert.ok(activities.some((e) => e.data.text !== undefined));
});

test('run.script: meta equals the literal in the text, the script parses, phases cover every agent', async () => {
  const { events } = await standardRun();
  const ev = events[0];
  assert.equal(ev.kind, 'run.script');
  const { text, meta, scriptPath } = ev.data;
  assert.ok(scriptPath.endsWith(`${meta.name}-${ev.runId}.js`), scriptPath);
  assert.equal(ev.prov.file, scriptPath);

  const literal = /^export const meta = (\{[\s\S]*?\n\})$/m.exec(text);
  assert.ok(literal, 'meta literal found in the script text');
  const parsed = JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal[1]})`)));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(meta)));
  assert.equal(typeof meta.name, 'string');
  assert.equal(typeof meta.description, 'string');
  assert.ok(Array.isArray(meta.phases) && meta.phases.length === 5);

  // Syntax only: the constructor compiles the body without calling it.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction('phase', 'agent', 'parallel', 'log', text.replace('export const meta', 'const meta')));

  const titles = new Set(meta.phases.map((p) => p.title));
  for (const a of indexAgents(events)) assert.ok(titles.has(a.phase), `phase ${a.phase} is declared`);
  for (const role of ['implement', 'reviewer-', 'judge', 'fix', 'test']) assert.ok(text.includes(`label: \`${role}`), `script labels ${role}`);
});

test('run.final agrees with the events that came before it', async () => {
  const { events } = await standardRun();
  const final = events.at(-1);
  const d = final.data;
  const launched = events.find((e) => e.kind === 'run.launched');
  const agents = indexAgents(events);

  assert.equal(d.runId, final.runId);
  assert.equal(d.status, 'completed');
  assert.equal(d.startTime, launched.ts);
  assert.equal(d.durationMs, final.ts - launched.ts);
  assert.equal(d.timestamp, new Date(final.ts).toISOString());
  assert.equal(d.agentCount, agents.length);
  assert.deepEqual(d.phases, events[0].data.meta.phases);
  assert.equal(d.workflowName, events[0].data.meta.name);
  assert.ok(Array.isArray(d.logs) && d.logs.length > 0 && d.logs.every((l) => typeof l === 'string'));
  assert.equal(final.prov.file, `demo://${final.runId}/workflows/${final.runId}.json`);

  const progress = d.workflowProgress.filter((p) => p.type === 'workflow_agent');
  assert.equal(progress.length, agents.length);
  const byId = new Map(agents.map((a) => [a.id, a]));
  progress.forEach((p, i) => {
    const a = byId.get(p.agentId);
    assert.ok(a, `progress entry for unknown agent ${p.agentId}`);
    assert.equal(p.index, i + 1);
    assert.equal(p.label, a.label);
    assert.equal(p.phaseTitle, a.phase);
    assert.equal(p.state, 'done');
    assert.equal(p.startedAt, a.started.e.ts);
    assert.equal(p.durationMs, a.result.e.ts - a.started.e.ts);
    assert.equal(p.toolCalls, a.activities.filter((x) => x.e.data.tool).length);
    const tokens = a.activities.reduce((n, x) => {
      const u = x.e.data.usage;
      return n + u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
    }, 0);
    assert.equal(p.tokens, tokens);
  });
  assert.equal(d.totalTokens, progress.reduce((n, p) => n + p.tokens, 0));
  assert.equal(d.totalToolCalls, progress.reduce((n, p) => n + p.toolCalls, 0));
  assert.deepEqual(d.workflowProgress.filter((p) => p.type === 'workflow_phase').map((p) => p.title), d.phases.map((p) => p.title));
});

test('the scenario is deterministic: two runs give the same sequence of events apart from ids and times', async () => {
  const shape = (events) => events.map((e) => [e.kind, e.data.label ?? '', e.data.tool ?? '', e.prov.line]);
  const [a, b] = await Promise.all([playRun(), playRun()]);
  assert.deepEqual(shape(a.events), shape(b.events));
  assert.notEqual(a.events[0].runId, b.events[0].runId, 'two sources never share a runId');
});

// ---------------------------------------------------------------------------------------
// start()

test('start() resolves after the events due at t=0 are emitted; a second start() does nothing', async () => {
  const clock = fakeClock();
  const events = [];
  const src = createDemoSource({ loop: false, now: clock.now, timers: clock, onEvent: (e) => events.push(e) });
  await src.start();
  assert.deepEqual(events.slice(0, 2).map((e) => e.kind), ['run.script', 'run.launched']);
  assert.ok(clock.pending === 1, 'exactly one timer is waiting for the next event');
  const n = events.length;
  await src.start();
  assert.equal(events.length, n);
  assert.equal(clock.pending, 1);
  clock.runAll();
  assert.equal(events.filter((e) => e.kind === 'run.script').length, 1);
  assert.equal(clock.pending, 0);
});

test('bad arguments are rejected instead of corrected', () => {
  assert.throws(() => createDemoSource({}), TypeError);
  assert.throws(() => createDemoSource(), TypeError);
  assert.throws(() => createDemoSource({ onEvent: 'x' }), TypeError);
  for (const speed of [0, -1, NaN, Infinity, '2', null]) {
    assert.throws(() => createDemoSource({ onEvent() {}, speed }), RangeError, `speed ${String(speed)}`);
  }
});

// ---------------------------------------------------------------------------------------
// speed

test('speed scales the timers: every event time shrinks by the same factor', async () => {
  const offsets = async (speed) => {
    const { events } = await playRun({ speed });
    const t0 = events[0].ts;
    return events.map((e) => e.ts - t0);
  };
  const [x1, x4, half] = [await offsets(1), await offsets(4), await offsets(0.5)];
  assert.equal(x1.length, x4.length);
  assert.equal(x1.length, half.length);
  assert.ok(x1.at(-1) > 60_000 && x1.at(-1) < 120_000, `a run takes about 80 s at speed 1, got ${x1.at(-1)} ms`);
  for (let i = 0; i < x1.length; i++) {
    assert.ok(Math.abs(x4[i] - x1[i] / 4) < 1.5, `speed 4, event ${i}: ${x4[i]} vs ${x1[i] / 4}`);
    assert.ok(Math.abs(half[i] - x1[i] * 2) < 1.5, `speed 0.5, event ${i}: ${half[i]} vs ${x1[i] * 2}`);
  }
});

// ---------------------------------------------------------------------------------------
// loop

test('loop restarts the run with a new runId after run.final (loop is on by default)', async () => {
  const clock = fakeClock();
  const events = [];
  const src = createDemoSource({ now: clock.now, timers: clock, onEvent: (e) => events.push(e) });
  await src.start();
  const runIds = () => [...new Set(events.map((e) => e.runId))];
  for (let s = 0; s < 1000 && runIds().length < 3; s++) clock.advance(1000);
  src.stop();
  assert.equal(clock.pending, 0);

  const ids = runIds();
  assert.equal(ids.length, 3, 'three runs started');
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.ok(id.startsWith('demo-'));
  for (const e of events) assert.ok(e.src === 'demo' && e.data.demo === true);

  const of = (id) => events.filter((e) => e.runId === id);
  const [r1, r2] = [of(ids[0]), of(ids[1])];
  assert.equal(r1.at(-1).kind, 'run.final', 'run 1 finished before run 2 began');
  assert.ok(events.indexOf(r2[0]) > events.indexOf(r1.at(-1)));
  assert.ok(r2[0].ts > r1.at(-1).ts, 'run 2 starts after a pause');
  assert.equal(r2[0].kind, 'run.script');
  assert.deepEqual(r2.slice(0, 2).map((e) => e.kind), ['run.script', 'run.launched']);
  assert.equal(r2.at(-1).kind, 'run.final');

  const agentIds = (run) => new Set(run.filter((e) => e.kind === 'agent.started').map((e) => e.data.agentId));
  const a1 = agentIds(r1);
  for (const id of agentIds(r2)) assert.ok(!a1.has(id), 'agent ids are not reused between runs');
  assert.deepEqual(r1.filter((e) => e.kind === 'agent.started').map((e) => e.data.label),
    r2.filter((e) => e.kind === 'agent.started').map((e) => e.data.label));
});

test('loop false: the run ends with run.final and nothing is scheduled afterwards', async () => {
  const { events, clock } = await playRun();
  const n = events.length;
  assert.equal(events.at(-1).kind, 'run.final');
  assert.equal(clock.pending, 0);
  clock.advance(60 * 60_000);
  assert.equal(events.length, n);
});

test('start() after a run ended on its own (loop false) begins a new run, again and again', async () => {
  const { events, clock, src } = await playRun();
  const perRun = events.length;
  assert.equal(events.at(-1).kind, 'run.final');
  for (let again = 2; again <= 3; again++) {
    const before = events.length;
    await src.start(); // the first events are due at t = 0 and are emitted before start() resolves
    assert.ok(events.length > before, `start() number ${again} emitted nothing: the source still counts as running`);
    assert.equal(events[before].kind, 'run.script');
    clock.runAll();
    assert.equal(events.length - before, perRun, `run ${again} has as many events as run 1`);
    assert.equal(events.at(-1).kind, 'run.final');
    assert.equal(clock.pending, 0);
  }
  const ids = [...new Set(events.map((e) => e.runId))];
  assert.equal(ids.length, 3, 'every start() used a new runId');
  assert.equal(events.filter((e) => e.kind === 'run.final').length, 3);
});

// ---------------------------------------------------------------------------------------
// stop()

test('stop() clears the timer and no event is emitted afterwards (fake clock)', async () => {
  const clock = fakeClock();
  const events = [];
  const src = createDemoSource({ now: clock.now, timers: clock, onEvent: (e) => events.push(e) });
  await src.start();
  clock.advance(20_000);
  const n = events.length;
  assert.ok(n > 19, 'events were flowing');
  assert.equal(clock.pending, 1);
  src.stop();
  assert.equal(clock.pending, 0, 'stop() leaves no timer');
  clock.advance(10 * 60_000);
  assert.equal(events.length, n, 'no event after stop()');
  src.stop(); // idempotent
  assert.equal(clock.pending, 0);
});

test('stop() before start() is harmless; start() after stop() begins a new run', async () => {
  const clock = fakeClock();
  const events = [];
  const src = createDemoSource({ loop: false, now: clock.now, timers: clock, onEvent: (e) => events.push(e) });
  src.stop();
  assert.equal(events.length, 0);
  await src.start();
  clock.advance(5000);
  src.stop();
  await src.start();
  clock.runAll();
  const ids = [...new Set(events.map((e) => e.runId))];
  assert.equal(ids.length, 2, 'the second start() used a new runId');
  assert.equal(events.at(-1).kind, 'run.final');
  assert.equal(events.at(-1).runId, ids[1]);
});

test('stop() called from inside onEvent takes effect at once', async () => {
  const clock = fakeClock();
  const events = [];
  let src;
  src = createDemoSource({
    now: clock.now,
    timers: clock,
    onEvent(e) {
      events.push(e);
      if (events.length === 5) src.stop();
    },
  });
  await src.start();
  assert.equal(events.length, 5, 'no event after the one that called stop()');
  assert.equal(clock.pending, 0);
  clock.advance(10 * 60_000);
  assert.equal(events.length, 5);
});

test('an exception thrown by onEvent stops the source and reaches the caller', async () => {
  const clock = fakeClock();
  const events = [];
  const boom = new Error('consumer failed');
  const src = createDemoSource({
    now: clock.now,
    timers: clock,
    onEvent(e) {
      events.push(e);
      if (events.length === 3) throw boom;
    },
  });
  await assert.rejects(src.start(), boom);
  assert.equal(clock.pending, 0);
  clock.advance(10 * 60_000);
  assert.equal(events.length, 3);

  // Same for an exception inside a timer callback.
  const events2 = [];
  const src2 = createDemoSource({
    now: clock.now,
    timers: clock,
    onEvent(e) {
      events2.push(e);
      if (events2.length === 30) throw boom;
    },
  });
  await src2.start();
  assert.throws(() => clock.advance(60_000), boom);
  assert.equal(clock.pending, 0);
  assert.equal(events2.length, 30);
});

// stop() inside the catch blocks matters: without it the source would go on counting as running, and
// start() would return at once and emit nothing for ever.
for (const where of ['start() (the first events)', 'a timer callback (a later event)']) {
  test(`after an exception thrown by onEvent in ${where}, start() begins a new run`, async () => {
    const clock = fakeClock();
    const events = [];
    const boom = new Error('consumer failed');
    const failAt = where.startsWith('start') ? 3 : 30;
    let armed = true;
    const src = createDemoSource({
      loop: false,
      now: clock.now,
      timers: clock,
      onEvent(e) {
        events.push(e);
        if (armed && events.length === failAt) {
          armed = false;
          throw boom;
        }
      },
    });
    if (where.startsWith('start')) {
      await assert.rejects(src.start(), boom);
    } else {
      await src.start();
      assert.throws(() => clock.advance(60_000), boom);
    }
    assert.equal(events.length, failAt);
    assert.equal(clock.pending, 0);

    await src.start();
    assert.ok(events.length > failAt, 'start() after the exception emitted nothing: the source still counts as running');
    assert.equal(events[failAt].kind, 'run.script');
    clock.runAll();
    const ids = [...new Set(events.map((e) => e.runId))];
    assert.equal(ids.length, 2, 'the second start() used a new runId');
    assert.equal(events.filter((e) => e.runId === ids[0]).length, failAt, 'the failed run emits nothing more');
    assert.equal(events.filter((e) => e.runId === ids[1] && e.kind === 'agent.started').length, 3 + 5 * (1 + 2 + 3));
    assert.equal(events.at(-1).kind, 'run.final');
    assert.equal(events.at(-1).runId, ids[1]);
    assert.equal(clock.pending, 0);
  });
}

test('stop() cancels the real timer: no event after it and no Timeout left in the event loop', { timeout: 20_000 }, async () => {
  const events = [];
  const baseline = timeoutCount();
  const src = createDemoSource({ speed: 5000, onEvent: (e) => events.push(e) });
  try {
    await src.start();
    while (events.length < 300) await sleep(2);
    assert.ok(timeoutCount() > baseline, 'a timer is pending while the source runs');
  } finally {
    src.stop();
  }
  assert.equal(timeoutCount(), baseline, 'stop() left no timer behind');
  const n = events.length;
  await sleep(80);
  assert.equal(events.length, n, 'no event after stop()');
  assert.ok(new Set(events.map((e) => e.runId)).size >= 1);
});

test('a finished run (loop false) leaves no timer behind (real timers)', { timeout: 20_000 }, async () => {
  const events = [];
  const baseline = timeoutCount();
  const src = createDemoSource({ speed: 5000, loop: false, onEvent: (e) => events.push(e) });
  try {
    await src.start();
    while (events.at(-1)?.kind !== 'run.final') await sleep(2);
    assert.equal(timeoutCount(), baseline);
  } finally {
    src.stop();
  }
  assert.equal(events.filter((e) => e.kind === 'run.final').length, 1);
  assert.equal(events.at(-1).data.agentCount, events.filter((e) => e.kind === 'agent.started').length);
});

// ---------------------------------------------------------------------------------------
// the shown script and the final file tell the same story

test('the script text, run against the emitted results, sends the emitted prompts and logs the emitted lines', async () => {
  const { events } = await standardRun();
  const final = events.at(-1).data;
  const agents = indexAgents(events);
  const byLabel = new Map(agents.map((a) => [a.label, a]));

  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    const known = byLabel.get(opts.label);
    assert.ok(known, `the script starts an agent the run never emitted: ${opts.label}`);
    calls.push({ prompt, opts });
    return structuredClone(known.result.e.data.result);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const body = events[0].data.text.replace('export const meta', 'const meta');
  const returned = await new AsyncFunction('phase', 'agent', 'parallel', 'log', body)(() => {}, agent, parallel, (m) => logs.push(m));

  assert.deepEqual(calls.map((c) => c.opts.label).sort(), [...byLabel.keys()].sort(), 'the script starts exactly the emitted agents, once each');
  for (const { prompt, opts } of calls) {
    const known = byLabel.get(opts.label);
    assert.equal(prompt, known.prompt.e.data.text, `prompt of ${opts.label}`);
    assert.equal(opts.phase, known.phase, `phase of ${opts.label}`);
    assert.equal(opts.model, metaFor(events, known).data.model, `model of ${opts.label}`);
  }
  assert.deepEqual([...logs].sort(), [...final.logs].sort(), 'final.logs are the log() calls of the script');
  assert.deepEqual(returned, final.result, 'the script returns the final result');
});

test('the invented findings state facts that hold in Node', async () => {
  const { events } = await standardRun();
  const findings = events
    .filter((e) => e.kind === 'agent.result' && typeof e.data.result === 'object')
    .flatMap((e) => e.data.result.findings ?? []);
  const empty = findings.filter((f) => f.input === 'sum([])');
  assert.ok(empty.length >= 2, 'a reviewer and the judge both carry the empty-list finding');
  // reduce() without a start value throws on an empty array; it does not return undefined.
  assert.throws(() => [].reduce((a, b) => a + b), TypeError);
  for (const f of empty) {
    assert.match(`${f.title} ${f.description}`, /TypeError/);
    assert.doesNotMatch(`${f.title} ${f.description}`, /undefined/);
  }
});

// ---------------------------------------------------------------------------------------
// timing at the extremes of speed

const MAX_TIMER_MS = 2 ** 31 - 1;

test('a very high speed does not starve the event loop: start() returns and timers pace the run (fake clock)', async () => {
  for (const speed of [1e9, 1e15, Number.MAX_VALUE]) {
    const clock = fakeClock();
    const events = [];
    const src = createDemoSource({
      speed,
      now: clock.now,
      timers: clock,
      onEvent(e) {
        events.push(e);
        if (events.length > 50_000) throw new Error(`speed ${speed}: runaway, start() never yielded`);
      },
    });
    await src.start();
    assert.deepEqual(events.slice(0, 2).map((e) => e.kind), ['run.script', 'run.launched']);
    assert.equal(clock.pending, 1, `speed ${speed}: a timer waits for the next event`);
    clock.advance(5);
    assert.ok(new Set(events.map((e) => e.runId)).size >= 3, `speed ${speed}: the loop keeps restarting, one timer at a time`);
    assert.ok(events.filter((e) => e.kind === 'run.final').length >= 3, `speed ${speed}: runs finish`);
    src.stop();
    assert.equal(clock.pending, 0, `speed ${speed}: stop() leaves no timer`);
  }
});

test('a very high speed does not starve the event loop (real timers)', { timeout: 20_000 }, async () => {
  const baseline = timeoutCount();
  let n = 0;
  const src = createDemoSource({
    speed: Number.MAX_VALUE,
    onEvent() {
      if (++n > 500_000) throw new Error('runaway: start() never yielded');
    },
  });
  try {
    await src.start();
    await sleep(30); // the event loop gets a turn between runs
    assert.ok(n > 0);
  } finally {
    src.stop();
  }
  assert.equal(timeoutCount(), baseline, 'stop() left no timer behind');
  const after = n;
  await sleep(30);
  assert.equal(n, after, 'no event after stop()');
});

test('a very low speed never asks for a timer beyond the 32-bit limit, and the replay stays slow (fake clock)', async () => {
  for (const speed of [1e-7, Number.MIN_VALUE]) {
    const clock = fakeClock();
    const delays = [];
    const timers = {
      setTimeout(fn, ms) {
        delays.push(ms);
        return clock.setTimeout(fn, ms);
      },
      clearTimeout: (id) => clock.clearTimeout(id),
    };
    const events = [];
    const src = createDemoSource({ speed, loop: false, now: clock.now, timers, onEvent: (e) => events.push(e) });
    await src.start();
    const atStart = events.length;
    clock.advance(MAX_TIMER_MS);
    clock.advance(MAX_TIMER_MS);
    assert.equal(events.length, atStart, `speed ${speed}: nothing is due yet`);
    assert.ok(delays.length >= 2 && delays.every((d) => Number.isInteger(d) && d >= 1 && d <= MAX_TIMER_MS), `speed ${speed}: delays ${delays.join(', ')}`);
    assert.equal(clock.pending, 1);
    if (speed === 1e-7) {
      // The first agent activity is due after about 500 virtual ms = 5e9 real ms at this speed.
      clock.advance(1e9);
      assert.ok(events.length > atStart, 'the next event arrives once its time has come');
    }
    src.stop();
    assert.equal(clock.pending, 0);
  }
});

test('a very low speed does not trigger the Node timer overflow warning, and no event comes early (real timers)', { timeout: 20_000 }, async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on('warning', onWarning);
  const events = [];
  const baseline = timeoutCount();
  const src = createDemoSource({ speed: 1e-7, loop: false, onEvent: (e) => events.push(e) });
  try {
    await src.start();
    const atStart = events.length;
    await sleep(60);
    assert.deepEqual(warnings.filter((w) => w.name === 'TimeoutOverflowWarning').map((w) => w.message), []);
    assert.equal(events.length, atStart, 'an overflowing delay would replay at 1 ms per step');
    assert.ok(timeoutCount() > baseline, 'a timer is pending');
  } finally {
    process.off('warning', onWarning);
    src.stop();
  }
  assert.equal(timeoutCount(), baseline);
});

// ---------------------------------------------------------------------------------------
// the wall clock steps (host suspend, NTP, a manual change): pacing follows the monotonic clock

// One run on a fake monotonic clock. `now` (the event timestamps) follows it plus a skew that the
// caller moves at the given monotonic offsets. Returns every event with the monotonic offset it
// was emitted at.
async function playWithWallSteps(steps) {
  const clock = fakeClock();
  const t0 = clock.now();
  let skew = 0;
  const log = [];
  const src = createDemoSource({
    loop: false,
    now: () => clock.now() + skew,
    monotonic: clock.now,
    timers: clock,
    onEvent: (e) => log.push({ at: clock.now() - t0, skew, e }),
  });
  await src.start();
  let elapsed = 0;
  for (const [atMs, delta] of steps) {
    clock.advance(atMs - elapsed);
    elapsed = atMs;
    skew += delta;
  }
  clock.runAll();
  return log;
}

test('a wall-clock step in either direction changes neither the pace nor the order of the replay (fake clock)', async () => {
  const hour = 3_600_000;
  const control = await playWithWallSteps([]);
  const cases = {
    'one hour forward': [[10_000, hour]],
    'one hour back': [[10_000, -hour]],
    'forward, then back past the start': [[10_000, hour], [30_000, -2 * hour]],
  };
  assert.ok(control.length > 100 && control.at(-1).e.kind === 'run.final');
  for (const [name, steps] of Object.entries(cases)) {
    const log = await playWithWallSteps(steps);
    // The same events at the same monotonic instants: no burst of due steps after a forward step
    // and no silence after a backward one.
    assert.deepEqual(log.map((x) => x.at), control.map((x) => x.at), `${name}: emission times`);
    assert.deepEqual(log.map((x) => [x.e.kind, x.e.data.label ?? '', x.e.data.tool ?? '']), control.map((x) => [x.e.kind, x.e.data.label ?? '', x.e.data.tool ?? '']), `${name}: events`);
    // The wall clock still stamps the events: `now` is used for ts and for nothing else.
    log.forEach((x, i) => assert.equal(x.e.ts, control[i].e.ts + x.skew, `${name}: ts of event ${i}`));
  }
});

// The same with the default clocks. Date.now is moved while the replay runs on real timers.
test('a forward step of Date.now does not make the real-timer replay jump to its end', { timeout: 20_000 }, async (t) => {
  const total = (await standardRun()).events.length;
  let skew = 0;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + skew);
  const events = [];
  const baseline = timeoutCount();
  const src = createDemoSource({ speed: 20, loop: false, onEvent: (e) => events.push(e) }); // a run takes about 4 s
  try {
    await src.start();
    skew = 3_600_000;
    await sleep(250);
    assert.ok(!events.some((e) => e.kind === 'run.final'), 'the run did not finish after the step');
    assert.ok(events.length < total / 2, `${events.length} of ${total} events after 250 ms`);
    assert.ok(timeoutCount() > baseline, 'a timer is still waiting for the next event');
  } finally {
    src.stop();
  }
  assert.equal(timeoutCount(), baseline);
});

test('a backward step of Date.now does not stall the real-timer replay', { timeout: 20_000 }, async (t) => {
  let skew = 0;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + skew);
  const events = [];
  const src = createDemoSource({ speed: 20, loop: false, onEvent: (e) => events.push(e) });
  try {
    await src.start();
    skew = -3_600_000;
    await sleep(40); // the timer that was already pending fires and pump measures the time again
    const n = events.length;
    await sleep(300);
    assert.ok(events.length > n + 3, `${events.length - n} events in 300 ms after the step`);
  } finally {
    src.stop();
  }
});

// ---------------------------------------------------------------------------------------
// restart from inside onEvent

function restartingSource(options = {}) {
  const events = [];
  const state = { restarted: false };
  const src = createDemoSource({
    ...options,
    onEvent(e) {
      events.push(e);
      if (events.length === 3 && !state.restarted) {
        state.restarted = true;
        src.stop();
        src.start();
      }
    },
  });
  return { src, events };
}

test('stop() then start() inside onEvent leaves exactly one timer, and stop() clears it (fake clock)', async () => {
  const clock = fakeClock();
  const { src, events } = restartingSource({ loop: false, now: clock.now, timers: clock });
  await src.start();
  const ids = [...new Set(events.map((e) => e.runId))];
  assert.equal(ids.length, 2, 'the restart began a new run');
  assert.equal(events.filter((e) => e.runId === ids[0]).length, 3, 'the old run emits nothing after the restart');
  assert.deepEqual(events.filter((e) => e.runId === ids[1]).slice(0, 2).map((e) => e.kind), ['run.script', 'run.launched']);
  assert.equal(clock.pending, 1, 'one timer waits for the next event of the new run');
  src.stop();
  assert.equal(clock.pending, 0, 'stop() leaves no timer');
  const n = events.length;
  clock.advance(10 * 60_000);
  assert.equal(events.length, n, 'no event after stop()');
});

test('a restart from inside onEvent runs the new run to its end exactly once (fake clock)', async () => {
  const clock = fakeClock();
  const { src, events } = restartingSource({ loop: false, now: clock.now, timers: clock });
  await src.start();
  clock.runAll();
  const ids = [...new Set(events.map((e) => e.runId))];
  assert.equal(ids.length, 2);
  assert.equal(events.filter((e) => e.kind === 'run.final').length, 1);
  assert.equal(events.at(-1).runId, ids[1]);
  // 3 implementers, plus 5 agents per round; the three units take 1, 2 and 3 rounds.
  assert.equal(events.filter((e) => e.runId === ids[1] && e.kind === 'agent.started').length, 3 + 5 * (1 + 2 + 3), 'every agent of the new run started once');
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts);
  assert.equal(clock.pending, 0);
});

test('stop() then start() inside onEvent leaves no timer behind after the final stop() (real timers)', { timeout: 20_000 }, async () => {
  const baseline = timeoutCount();
  const { src, events } = restartingSource({ speed: 5000 });
  await src.start();
  await sleep(50);
  src.stop();
  assert.equal(timeoutCount(), baseline, 'the final stop() left no timer');
  const n = events.length;
  await sleep(50);
  assert.equal(events.length, n, 'no event after stop()');
});

// ---------------------------------------------------------------------------------------
// isolation from the real source

test('demo.mjs never imports the real-run source, and imports nothing from disk or network', () => {
  const text = readFileSync(DEMO_FILE, 'utf8');
  const specifiers = [
    ...text.matchAll(/\bimport\s+(?:[\w*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  assert.ok(specifiers.includes('node:crypto'), `the scan found the known import (found: ${specifiers.join(', ')})`);
  for (const s of specifiers) {
    assert.ok(s.startsWith('node:'), `only built-in modules are imported, found ${s}`);
    assert.ok(!/claude-fs/.test(s));
    assert.ok(!/^node:(fs|fs\/promises|net|http|https|http2|tls|dns|dgram|child_process|os|path)$/.test(s), `${s} is not needed by a synthetic source`);
  }
  assert.ok(!text.includes('claude-fs'), 'demo.mjs does not mention the real source at all');
  assert.ok(!text.includes('createClaudeFsSource'));
  assert.ok(!text.includes('claude-projects') && !text.includes('.claude'), 'demo.mjs does not point at Claude Code session directories');
  assert.ok(!/\bfetch\s*\(/.test(text) && !/\bXMLHttpRequest\b/.test(text));
});
