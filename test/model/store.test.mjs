import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, reduceRun } from '../../src/model/reduce.mjs';
import { probe1, probe2, legacy, P1 } from './helpers.mjs';

const clock = (t) => ({ now: () => t.value });

test('apply returns the run id; getRun reduces what has been applied so far', () => {
  const p = probe1();
  const t = { value: 1794126725000 };
  const store = createStore(clock(t));
  assert.equal(store.getRun(p.ids.runId), null);
  assert.deepEqual(store.listRuns(), []);
  const ids = p.live.map((ev) => store.apply(ev));
  assert.ok(ids.every((id) => id === 'wf_6509ce25-20a'));
  const run = store.getRun('wf_6509ce25-20a');
  assert.deepEqual(run, reduceRun(p.live, { now: () => t.value }), 'the store and the pure reducer agree');
  assert.equal(run.totals.agents, 5);
});

test('getRun after only some events shows the partial run', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126713000 }));
  for (const ev of p.live.filter((e) => e.ts <= 1794126712600)) store.apply(ev);
  const run = store.getRun(p.ids.runId);
  assert.equal(run.totals.running, 2);
  for (const ev of p.live.filter((e) => e.ts > 1794126712600)) store.apply(ev);
  assert.equal(store.getRun(p.ids.runId).totals.done, 5);
});

test('onChange fires once per applied event with the run id; unsubscribe stops it', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const seen = [];
  const off = store.onChange((id) => seen.push(id));
  p.live.slice(0, 4).forEach((ev) => store.apply(ev));
  assert.deepEqual(seen, Array(4).fill('wf_6509ce25-20a'));
  off();
  store.apply(p.live[4]);
  assert.equal(seen.length, 4);
});

test('the listener sees the new state when it is called', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const counts = [];
  store.onChange((id) => counts.push(store.getRun(id).totals.agents));
  for (const ev of p.live.slice(0, 6)) store.apply(ev); // script, launched, startedA, startedB, metaA, metaB
  assert.deepEqual(counts, [0, 0, 1, 2, 2, 2]);
});

test('a re-emitted line is not applied twice and does not notify', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  let calls = 0;
  store.onChange(() => calls++);
  p.live.forEach((ev) => store.apply(ev));
  const n = calls;
  assert.equal(store.apply(p.e.startedA), 'wf_6509ce25-20a', 'still returns the run id');
  assert.equal(calls, n);
  assert.equal(store.getRun(p.ids.runId).totals.agents, 5);
});

test('a throwing listener does not break apply or the other listeners', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  let ok = 0;
  store.onChange(() => { throw new Error('boom'); });
  store.onChange(() => ok++);
  assert.doesNotThrow(() => store.apply(p.e.script));
  assert.equal(ok, 1);
});

test('events without a run id are rejected (null), not stored', () => {
  const store = createStore();
  for (const bad of [null, undefined, 42, {}, { kind: 'run.launched' }, { kind: 'run.launched', runId: '' }]) assert.equal(store.apply(bad), null);
  assert.deepEqual(store.listRuns(), []);
});

test('listRuns returns summaries made of Facts, newest start first, and keeps runs apart', () => {
  const a = probe1(), b = probe2(), c = legacy();
  const store = createStore(clock({ value: 1794127740000 }));
  for (const ev of [...c.withFinal, ...a.withFinal, ...b.withFinal]) store.apply(ev);
  const list = store.listRuns();
  assert.deepEqual(list.map((r) => r.id), ['wf_26eb8d70-5c4', 'wf_6509ce25-20a', 'wf_00000206-leg']);
  const first = list[0];
  assert.deepEqual(Object.keys(first).sort(), ['agents', 'id', 'name', 'project', 'running', 'source', 'startedAt', 'status']);
  assert.deepEqual([first.name.value, first.name.prov], ['probe-edge-cases', 'registered']);
  assert.deepEqual([first.status.value, first.status.prov], ['failed', 'final']);
  assert.equal(first.startedAt.prov, 'final');
  assert.equal(first.agents, 6);
  assert.equal(first.running, 0);
  assert.equal(first.source, 'real');
  assert.equal(list[2].project, '-synthetic-project');
  assert.equal(store.getRun('wf_26eb8d70-5c4').totals.agents, 6);
  assert.equal(store.getRun('wf_6509ce25-20a').totals.agents, 5);
});

test('runs with an unknown start sort last, ties by id', () => {
  const store = createStore();
  const mk = (runId) => ({ src: 'claude-fs', kind: 'agent.started', runId, sessionId: null, project: null, ts: null, prov: { file: `/j/${runId}`, line: 1 }, data: { agentId: 'a1' } });
  store.apply(mk('wf_b'));
  store.apply(mk('wf_a'));
  const p = probe1();
  p.live.forEach((e) => store.apply(e));
  assert.deepEqual(store.listRuns().map((r) => r.id), ['wf_6509ce25-20a', 'wf_a', 'wf_b']);
});

test('summary running counts the running agents of an active run', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126713000 }));
  for (const ev of p.live.filter((e) => e.ts <= 1794126712600)) store.apply(ev);
  const [s] = store.listRuns();
  assert.deepEqual([s.agents, s.running, s.status.value], [2, 2, 'running']);
});

test('getRun is cached until an event arrives or the stale limit is crossed; nothing else changes it', () => {
  const p = probe1();
  const t = { value: 1794126712600 };
  const store = createStore({ ...clock(t), staleMs: 1000 });
  for (const ev of p.live.filter((e) => e.ts <= 1794126712600)) store.apply(ev);
  const r1 = store.getRun(p.ids.runId);
  t.value += 500;
  assert.equal(store.getRun(p.ids.runId), r1, 'same object while nothing changed');
  assert.equal(r1.status.value, 'running');
  t.value = 1794126712583 + 1001; // last event ts + staleMs + 1
  const r2 = store.getRun(p.ids.runId);
  assert.notEqual(r2, r1);
  assert.equal(r2.status.prov, 'unknown');
  assert.match(r2.status.reason, /no file activity for 1 s \(limit 1 s\)/);
  assert.equal(store.getRun(p.ids.runId), r2, 'cached again on the stale side');
  t.value += 100;
  assert.equal(store.getRun(p.ids.runId), r2, 'the reason still reads "1 s", so the cached Run is still true');
  t.value += 10_000; // the reason quotes the silence: "11 s" now, so the Run is rebuilt
  const r2b = store.getRun(p.ids.runId);
  assert.notEqual(r2b, r2);
  assert.match(r2b.status.reason, /no file activity for 11 s \(limit 1 s\)/);
  assert.equal(store.getRun(p.ids.runId), r2b);
  store.apply(p.e.resultA); // new activity (journal ts 1794126713200) ...
  t.value = 1794126713700; // ... and the clock is within staleMs of it
  const r3 = store.getRun(p.ids.runId);
  assert.notEqual(r3, r2);
  assert.equal(r3.status.value, 'running');
});

test('a final file ends the clock dependence: the cache survives any later now()', () => {
  const p = probe1();
  const t = { value: 1794126730000 };
  const store = createStore(clock(t));
  p.withFinal.forEach((ev) => store.apply(ev));
  const r1 = store.getRun(p.ids.runId);
  t.value += 365 * 24 * 3600e3;
  assert.equal(store.getRun(p.ids.runId), r1);
  assert.equal(r1.status.prov, 'final');
});

test('the default clock is Date.now and the default staleMs is 30 minutes', (t) => {
  const p = probe1();
  const last = Math.max(...p.live.map((e) => e.ts)); // the newest file activity in the run
  let wall = last + 60_000;
  t.mock.method(Date, 'now', () => wall);
  const store = createStore(); // no options at all
  p.live.forEach((ev) => store.apply(ev));
  assert.deepEqual(store.getRun(p.ids.runId).status, { value: 'running', prov: 'inferred', method: 'no-final-file' }, 'one minute of silence');
  wall = last + 30 * 60e3;
  assert.equal(store.getRun(p.ids.runId).status.value, 'running', 'exactly 30 minutes: not stale yet');
  wall = last + 30 * 60e3 + 1;
  const stale = store.getRun(p.ids.runId);
  assert.deepEqual([stale.status.prov, stale.status.value], ['unknown', null]);
  assert.match(stale.status.reason, /no file activity for 30 min \(limit 30 min\)/);
  assert.equal(stale.agents[p.ids.A].state.value, 'done', 'what the journal proves stays');
  wall = last + 5 * 3600e3; // the clock keeps being read: the Run follows it
  assert.match(store.getRun(p.ids.runId).status.reason, /no file activity for 300 min \(limit 30 min\)/);
});

test('a stale run does not keep an old duration in its reasons: the Run is rebuilt when the quoted silence changes', () => {
  const p = probe1();
  const t = { value: 1794126712583 };
  const store = createStore({ ...clock(t), staleMs: 30 * 60e3 });
  for (const ev of p.live.filter((e) => e.ts <= 1794126712600)) store.apply(ev);
  const last = 1794126712583;
  t.value = last + 31 * 60e3;
  const at31 = store.getRun(p.ids.runId);
  assert.match(at31.status.reason, /no file activity for 31 min \(limit 30 min\)/);
  assert.match(at31.agents[p.ids.A].state.reason, /started but no result, and no file activity for 31 min /);
  t.value = last + 31 * 60e3 + 20_000;
  assert.equal(store.getRun(p.ids.runId), at31, 'same minute: the cached Run is still right');
  t.value = last + 5 * 3600e3;
  const at5h = store.getRun(p.ids.runId);
  assert.notEqual(at5h, at31);
  assert.match(at5h.status.reason, /no file activity for 300 min \(limit 30 min\)/);
  assert.match(at5h.agents[p.ids.A].state.reason, /started but no result, and no file activity for 300 min /);
  assert.doesNotMatch(JSON.stringify(at5h), /31 min/);
  t.value = last + 5 * 3600e3 + 10_000;
  assert.equal(store.getRun(p.ids.runId), at5h);
});

test('a line re-read with different content (a rewritten journal) reaches the Run and notifies; the same content does not', () => {
  const { b } = probe1();
  const first = [b.launched(1, 1000), b.started(2, 1100, 'aX', 'w:X', 'P'), b.result(3, 1200, 'aX', 'first result of aX, of some length')];
  const rewritten = [b.launched(1, 2000), b.started(2, 2100, 'aY', 'w:Y', 'P'), b.result(3, 2200, 'aY', 'second result of aY, of some length')];
  const store = createStore({ now: () => 3000 });
  let calls = 0;
  store.onChange(() => calls++);
  first.forEach((ev) => store.apply(ev));
  assert.equal(calls, 3);
  first.forEach((ev) => store.apply(ev));
  assert.equal(calls, 3, 'same lines, same content: nothing');
  rewritten.forEach((ev) => store.apply(ev));
  assert.equal(calls, 5, 'the identical launched line is nothing; the two changed lines notify');
  const run = store.getRun('wf_6509ce25-20a');
  assert.deepEqual(run.order, ['aY']);
  assert.equal(run.agents.aY.result.value, 'second result of aY, of some length');
  assert.equal(run.warnings.filter((w) => /read again with different content/.test(w)).length, 2);
  assert.deepEqual(run, reduceRun([...first, ...rewritten], { now: () => 3000 }), 'the store and the pure reducer agree');
});

test('events that cannot change an edge leave a big run cheap: no 1 MB re-index per event', () => {
  let seed = 99;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const word = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)]).join('');
  const text = (n) => Array.from({ length: n }, word).join(' ');
  const { b } = probe1();
  const store = createStore({ now: () => 1794126800000 + 100 * 10_000 + 1000 });
  const prior = [];
  store.apply(b.launched(1, 1794126799000));
  for (let i = 0; i < 100; i++) {
    const id = `agent${String(i).padStart(4, '0')}`;
    const t0 = 1794126800000 + i * 10_000;
    const result = { note: text(1500) }; // about 10 KB each, 1 MB in all
    store.apply(b.started(2 + i * 2, t0, id, `worker:${i}`, 'Loop'));
    store.apply(b.prompt(id, `Task ${i}. ${prior.length ? JSON.stringify(prior.at(-1), null, 2) : ''}`, t0 + 1));
    store.apply(b.result(3 + i * 2, t0 + 5000, id, result));
    prior.push(result);
  }
  // a running agent that reports tool use: not one of these events moves a time, a prompt or a result
  store.apply(b.started(300, 1794126801000 + 100 * 10_000, 'live', 'live:L', 'Loop'));
  store.apply(b.prompt('live', 'Short prompt of the live agent.', 1794126801000 + 100 * 10_000 + 1));
  const id = b.ev('x', {}, 0, 'f').runId;
  const before = store.getRun(id);
  assert.equal(before.edges.length, 99);
  let worst = 0;
  for (let k = 0; k < 5; k++) {
    store.apply(b.activity('live', { tool: 'Bash', inputSummary: `step ${k}` }, 1794126801000 + 100 * 10_000 + 10 + k, 10 + k));
    const t = Date.now();
    const run = store.getRun(id);
    worst = Math.max(worst, Date.now() - t);
    assert.equal(run.agents.live.toolCalls.value, k + 1, 'the event is in the Run');
    assert.deepEqual(run.edges, before.edges);
  }
  assert.ok(worst < 150, `a getRun after a tool event took ${worst} ms`);
});

// ------------------------------------------------------------------ contract 2: the event stream (UiEvent)

const RUN = 'wf_6509ce25-20a';
const listen = (store) => {
  const seen = [];
  const off = store.onEvent((e) => seen.push(e));
  return { seen, off };
};

test('onEvent: one UiEvent per applied RawEvent, seq per run from 1 without gaps, in order', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const { seen } = listen(store);
  p.live.forEach((ev) => store.apply(ev));
  assert.equal(seen.length, p.live.length, 'probe 1 has no source.warning');
  assert.deepEqual(seen.map((e) => e.seq), p.live.map((_, i) => i + 1));
  for (const [i, e] of seen.entries()) {
    assert.equal(e.runId, RUN);
    assert.equal(e.kind, p.live[i].kind);
    assert.equal(e.ts, p.live[i].ts);
    assert.equal(e.prov, 'registered');
    assert.ok(typeof e.message === 'string' && e.message.length > 0 && e.message.length < 200, e.message);
    assert.deepEqual(Object.keys(e).filter((k) => !['runId', 'seq', 'ts', 'kind', 'agentId', 'label', 'role', 'unit', 'message', 'status', 'prov'].includes(k)), [], 'only the contract fields');
  }
});

test('onEvent: a re-emitted line is not applied again, so it is no event and leaves no gap in seq', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const { seen } = listen(store);
  p.live.slice(0, 5).forEach((ev) => store.apply(ev));
  store.apply(p.e.startedA);
  store.apply(p.e.startedB);
  p.live.slice(5, 8).forEach((ev) => store.apply(ev));
  assert.deepEqual(seen.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('onEvent: source.warning is applied (it is in run.warnings) but is no event and takes no seq', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const { seen } = listen(store);
  store.apply(p.e.script);
  store.apply(p.b.warning('unreadable line', 1794126711290, p.b.files.journal, 7));
  store.apply(p.e.launched);
  assert.deepEqual(seen.map((e) => [e.seq, e.kind]), [[1, 'run.script'], [2, 'run.launched']]);
  assert.ok(store.getRun(RUN).warnings.some((w) => /unreadable line/.test(w)));
  assert.deepEqual(store.eventsSince(RUN, 0).map((e) => e.seq), [1, 2]);
});

test('onEvent: agent events carry agentId and the label, role and unit of the label pattern; the label is the one known so far', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const { seen } = listen(store);
  // the agent meta (description = label) before the journal line: the meta names the agent, the journal line then wins
  store.apply(p.e.launched);
  store.apply(p.e.metaA);
  store.apply(p.e.startedA);
  store.apply(p.e.resultA);
  const [, meta, started, result] = seen;
  assert.deepEqual([meta.agentId, meta.label, meta.role, meta.unit], [p.ids.A, 'reviewer:A', 'reviewer', 'A']);
  assert.deepEqual([started.agentId, started.label, started.role, started.unit], [p.ids.A, 'reviewer:A', 'reviewer', 'A']);
  assert.deepEqual([result.agentId, result.label, result.role, result.unit], [p.ids.A, 'reviewer:A', 'reviewer', 'A'], 'a result line has no label of its own');
  assert.equal(seen[0].agentId, undefined, 'run.launched has no agent');
  assert.equal('label' in seen[0], false);
  // a label without a unit has no unit key; an agent with no known label has no label keys, never an invented one
  const q = createStore(clock({ value: 1794126725000 }));
  const out = listen(q).seen;
  q.apply(p.b.result(4, 1794126713200, 'aNoLabel', { x: 1 }));
  q.apply(p.e.startedJ);
  assert.deepEqual(['label', 'role', 'unit'].filter((k) => k in out[0]), []);
  assert.equal(out[0].agentId, 'aNoLabel');
  assert.deepEqual([out[1].label, out[1].role, 'unit' in out[1]], ['judge', 'judge', false]);
});

test('onEvent: status is what the event itself says; prov is "final" only for the final file', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126730000 }));
  const { seen } = listen(store);
  p.withFinal.forEach((ev) => store.apply(ev));
  const first = (kind) => seen.find((e) => e.kind === kind);
  assert.equal(first('agent.started').status, 'running');
  assert.equal(first('agent.result').status, 'done');
  assert.equal(first('run.final').status, 'completed', 'the final file\'s own status text');
  assert.equal(first('run.final').prov, 'final');
  assert.equal(first('run.final').agentId, undefined);
  for (const e of seen) assert.equal(e.prov, e.kind === 'run.final' ? 'final' : 'registered');
  for (const kind of ['run.script', 'run.launched', 'agent.meta', 'agent.prompt', 'agent.activity', 'agent.structured']) assert.equal('status' in first(kind), false, `${kind} has no status`);
  // a failed line, and a final status that is not one of the usual ones, pass through
  const q = createStore(clock({ value: 1794126730000 }));
  const out = listen(q).seen;
  q.apply(p.b.ev('agent.failed', { agentId: 'aF', key: 'v2:aF' }, 1000, p.b.files.journal, 2));
  q.apply({ ...p.e.final, data: { ...p.e.final.data, status: 'killed' } });
  assert.deepEqual([out[0].status, out[1].status], ['failed', 'killed']);
});

test('onEvent: the message is built from the event data only', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126730000 }));
  const { seen } = listen(store);
  p.withFinal.forEach((ev) => store.apply(ev));
  const msg = (pred) => seen.find(pred).message;
  assert.equal(msg((e) => e.kind === 'run.script'), 'script read: probe-event-format (3 phases)');
  assert.equal(msg((e) => e.kind === 'run.launched'), 'run launched');
  assert.equal(msg((e) => e.kind === 'agent.started' && e.agentId === p.ids.A), 'reviewer:A started in phase Fanout');
  assert.equal(msg((e) => e.kind === 'agent.meta' && e.agentId === p.ids.A), 'reviewer:A meta read (workflow-subagent)');
  assert.match(msg((e) => e.kind === 'agent.prompt' && e.agentId === p.ids.A), /^reviewer:A prompt read \(\d+ chars\)$/);
  assert.equal(msg((e) => e.kind === 'agent.activity' && e.agentId === p.ids.A), `reviewer:A StructuredOutput: ${JSON.stringify(P1.resultA)}`);
  assert.equal(msg((e) => e.kind === 'agent.activity' && e.agentId === p.ids.F1), 'fixer:round1 wrote: round 1 done');
  assert.equal(msg((e) => e.kind === 'agent.structured' && e.agentId === p.ids.A), 'reviewer:A structured output');
  assert.equal(msg((e) => e.kind === 'agent.result' && e.agentId === p.ids.A), `reviewer:A done: ${JSON.stringify(P1.resultA)}`);
  assert.equal(msg((e) => e.kind === 'agent.result' && e.agentId === p.ids.F1), 'fixer:round1 done: round 1 done');
  assert.equal(msg((e) => e.kind === 'run.final'), 'final file written: run completed, 5 agents');
  // a long text is cut; nothing in a message is made up: with no data, the line says only what it knows
  const q = createStore(clock({ value: 1 }));
  const out = listen(q).seen;
  q.apply(p.b.activity('aL', { tool: 'Bash', inputSummary: `${'x'.repeat(300)}` }, 5, 3));
  q.apply(p.b.ev('agent.activity', { agentId: 'aL' }, 6, 'f.jsonl', 4));
  q.apply(p.b.ev('agent.result', { agentId: 'aL', key: 'k' }, 7, 'j', 5));
  q.apply(p.b.ev('something.new', {}, 8, 'j', 6));
  assert.ok(out[0].message.length <= 'aL Bash: '.length + 103, out[0].message.length);
  assert.ok(out[0].message.endsWith('...'));
  assert.deepEqual(out.slice(1).map((e) => e.message), ['aL activity', 'aL done', 'something.new event']);
});

test('onEvent: the final file names agents that no other event named', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126730000 }));
  const { seen } = listen(store);
  store.apply(p.e.final);
  store.apply(p.b.result(4, 1794126713200, p.ids.A, P1.resultA));
  assert.equal(seen[1].label, 'reviewer:A', 'the label of the final file (rank below the journal and the meta, above nothing)');
  assert.equal(seen[1].role, 'reviewer');
});

test('onEvent: ts is the RawEvent ts, or null when it has none (no invented time)', () => {
  const p = probe1();
  const store = createStore();
  const { seen } = listen(store);
  store.apply({ ...p.e.launched, ts: null });
  store.apply({ ...p.e.startedA, ts: 'yesterday' });
  store.apply(p.e.startedB);
  assert.deepEqual(seen.map((e) => e.ts), [null, null, p.e.startedB.ts]);
});

test('onEvent: unsubscribe stops it; a throwing listener breaks neither apply nor the other listeners; the event reaches them before onChange', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  const order = [];
  const offBad = store.onEvent(() => { throw new Error('boom'); });
  const off = store.onEvent((e) => order.push(`event ${e.seq}`));
  store.onChange(() => order.push('change'));
  assert.doesNotThrow(() => store.apply(p.e.script));
  store.apply(p.e.launched);
  assert.deepEqual(order, ['event 1', 'change', 'event 2', 'change']);
  off();
  offBad();
  store.apply(p.e.startedA);
  assert.deepEqual(order, ['event 1', 'change', 'event 2', 'change', 'change']);
});

test('eventsSince: events with seq greater than the given one, oldest first; 0 or less is all; an unknown run has none', () => {
  const p = probe1();
  const store = createStore(clock({ value: 1794126725000 }));
  p.live.slice(0, 10).forEach((ev) => store.apply(ev));
  assert.deepEqual(store.eventsSince(RUN, 0).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(store.eventsSince(RUN, -5).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(store.eventsSince(RUN, 7).map((e) => e.seq), [8, 9, 10]);
  assert.deepEqual(store.eventsSince(RUN, 10), []);
  assert.deepEqual(store.eventsSince(RUN, 99), []);
  assert.deepEqual(store.eventsSince(RUN, '8').map((e) => e.seq), [9, 10], 'a query string value');
  assert.deepEqual(store.eventsSince(RUN, undefined).length, 10);
  assert.deepEqual(store.eventsSince(RUN, 'x').length, 10);
  assert.deepEqual(store.eventsSince('wf_nope', 0), []);
  const a = store.eventsSince(RUN, 0);
  a.pop();
  assert.equal(store.eventsSince(RUN, 0).length, 10, 'the caller gets its own array');
  assert.ok(Object.isFrozen(a[0]), 'the events themselves are frozen: no caller can change what another one reads');
});

test('eventsSince: seq counts per run, and the runs do not share a backlog', () => {
  const a = probe1(), b = probe2();
  const store = createStore(clock({ value: 1794127740000 }));
  for (const ev of [...a.live.slice(0, 3), ...b.live.slice(0, 5), ...a.live.slice(3, 6)]) store.apply(ev);
  assert.deepEqual(store.eventsSince(a.ids.runId, 0).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(store.eventsSince(b.ids.runId, 0).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.ok(store.eventsSince(b.ids.runId, 0).every((e) => e.runId === b.ids.runId));
});

test('eventsSince: the last 2000 events of a run are kept; seq keeps counting', () => {
  const { b } = probe1();
  const store = createStore();
  const seen = [];
  store.onEvent((e) => seen.push(e.seq));
  for (let i = 0; i < 2300; i++) store.apply(b.activity('aL', { tool: 'Bash', inputSummary: `step ${i}` }, 1000 + i, 10 + i));
  assert.equal(seen.length, 2300);
  assert.equal(seen.at(-1), 2300);
  const all = store.eventsSince(RUN, 0);
  assert.equal(all.length, 2000);
  assert.deepEqual([all[0].seq, all.at(-1).seq], [301, 2300]);
  assert.deepEqual(store.eventsSince(RUN, 2290).map((e) => e.seq), [2291, 2292, 2293, 2294, 2295, 2296, 2297, 2298, 2299, 2300]);
  assert.equal(store.eventsSince(RUN, 100).length, 2000, 'what was dropped is simply not there');
  assert.equal(all[0].message, 'aL Bash: step 300');
});

test('the events do not change what getRun answers: same Run with or without a listener', () => {
  const p = probe1();
  const t = { value: 1794126725000 };
  const plain = createStore(clock(t));
  const heard = createStore(clock(t));
  listen(heard);
  p.live.forEach((ev) => { plain.apply(ev); heard.apply(ev); });
  assert.deepEqual(heard.getRun(RUN), plain.getRun(RUN));
});

// ---- replay (docs/contract.md section 1 "Replay"): the store of a replayed run ------------------------------

const DAY = 24 * 3600e3;
const asReplay = (events) => events.map((e) => ({ ...e, src: 'replay' }));

test('replay: a run whose events say src "replay" is a replay run, in getRun and in listRuns', () => {
  const p = probe1();
  const store = createStore({ ...clock({ value: 1794126725000 }), staleMs: Infinity });
  asReplay(p.live).forEach((e) => store.apply(e));
  assert.equal(store.getRun(p.ids.runId).source, 'replay');
  assert.deepEqual(store.listRuns().map((r) => r.source), ['replay']);
});

test('replay: events a day old keep the run running until run.final when staleMs is Infinity, and complete it at the end', () => {
  const p = probe1();
  const later = 1794126713000 + DAY; // the replay runs a day after the run
  const store = createStore({ now: () => later, staleMs: Infinity });
  const events = asReplay(p.withFinal);
  const beforeFinal = events.filter((e) => e.kind !== 'run.final' && e.ts <= 1794126717800);
  beforeFinal.forEach((e) => store.apply(e));
  let run = store.getRun(p.ids.runId);
  assert.deepEqual([run.status.value, run.status.prov, run.status.method], ['running', 'inferred', 'no-final-file']);
  assert.ok(Object.values(run.agents).every((a) => a.state.value === 'done' || a.state.value === 'running'), 'no agent state is unknown');
  assert.ok(run.totals.running >= 1 || run.totals.done >= 1);

  events.filter((e) => !beforeFinal.includes(e)).forEach((e) => store.apply(e));
  run = store.getRun(p.ids.runId);
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
  assert.equal(run.totals.done, 5);

  const direct = reduceRun(p.withFinal, { now: () => later });
  assert.deepEqual({ ...run, source: 'real' }, direct, 'at the end the run stays as read');
});

test('replay: with the default stale limit the same old events read as unknown, which is why replay mode turns the limit off', () => {
  const p = probe1();
  const store = createStore({ now: () => 1794126713000 + DAY });
  asReplay(p.live.filter((e) => e.ts <= 1794126717800)).forEach((e) => store.apply(e));
  const run = store.getRun(p.ids.runId);
  assert.equal(run.status.prov, 'unknown');
  assert.match(run.status.reason, /no file activity for .* \(limit 30 min\)/);
});

test('replay: staleMs Infinity arms no timer, whatever the subscribers and events; a finite limit does (control)', () => {
  const p = probe1();
  const realSetTimeout = globalThis.setTimeout;
  const armed = [];
  globalThis.setTimeout = (...args) => {
    armed.push(args[1]);
    return realSetTimeout(...args);
  };
  try {
    const off = [];
    const store = createStore({ now: () => 1794126713000 + DAY, staleMs: Infinity });
    off.push(store.onChange(() => {}));
    asReplay(p.live).forEach((e) => { store.apply(e); store.getRun(p.ids.runId); });
    store.listRuns();
    assert.deepEqual(armed, [], 'no stale timer for an unlimited store');
    off.forEach((f) => f());

    const finite = createStore({ now: () => 1794126713000, staleMs: 60_000 });
    const stop = finite.onChange(() => {});
    p.live.filter((e) => e.ts <= 1794126712600).forEach((e) => finite.apply(e));
    finite.getRun(p.ids.runId);
    assert.ok(armed.length >= 1, 'a finite limit arms a timer: the control sees one');
    stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
