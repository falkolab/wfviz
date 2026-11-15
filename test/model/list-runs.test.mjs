// Node agent-tokens (P2, item 4b): store.listRuns keeps one summary per run and builds it again only when that run changed. The summary
// must be what summaryOf(getRun(id)) says, field for field, whatever the clock does to a running run (the stale flip and the silence text of
// its reason). Builds are counted through the store's onBuild hook (a count, not a time).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { buildSchedule, locateRun } from '../../src/source/replay.mjs';
import { probe1, probe2, legacy, builder } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN = 60_000;

// what a list item is made of (the contract's RunSummary), written out here so that the test does not use the code it checks
const summaryOf = (run) => ({
  id: run.id, name: run.name, status: run.status, project: run.project, startedAt: run.startedAt,
  agents: run.totals.agents, running: run.totals.running, source: run.source,
});

function counting(clock) {
  const builds = [];
  const store = createStore({ now: () => clock.value, onBuild: (b) => builds.push(b) });
  return { store, builds, take: () => builds.splice(0) };
}

// a running run of one agent, last event at `ts`
function runningRun(runId, ts) {
  const b = builder({ runId });
  return [
    b.script({ name: runId, phases: [] }, ts), b.launched(1, ts + 1), b.started(2, ts + 2, 'a0000000000000001', 'w:a', 'P'),
    b.prompt('a0000000000000001', 'task', ts + 3, 1),
    b.activity('a0000000000000001', { text: 'working', model: 'claude-haiku-5-5', messageId: 'm1', usage: { input_tokens: 1, output_tokens: 1 } }, ts + 4, 2),
  ];
}

test('the first listRuns builds one summary per run and no run; the second builds nothing', () => {
  const clock = { value: 1794126725000 };
  const { store, take } = counting(clock);
  for (const ev of probe1().live) store.apply(ev);
  for (const ev of probe2().live) store.apply(ev);
  const first = store.listRuns();
  assert.equal(first.length, 2);
  const b1 = take();
  assert.deepEqual(b1.map((b) => b.kind), ['summary', 'summary'], 'one summary each, never a whole Run');
  assert.deepEqual(b1.map((b) => b.runId).sort(), ['wf_26eb8d70-5c4', 'wf_6509ce25-20a']);
  assert.deepEqual(store.listRuns(), first);
  assert.deepEqual(take(), [], 'nothing changed: nothing is built');
});

test('an event on one run rebuilds the summary of that run only', () => {
  const clock = { value: 1794126725000 };
  const { store, take } = counting(clock);
  const p1 = probe1();
  const p2 = probe2();
  p1.live.forEach((ev) => store.apply(ev));
  p2.live.forEach((ev) => store.apply(ev));
  assert.equal(store.listRuns().find((r) => r.id === 'wf_6509ce25-20a').status.prov, 'inferred');
  take();
  store.apply(p1.e.final);
  const list = store.listRuns();
  assert.deepEqual(take(), [{ runId: 'wf_6509ce25-20a', kind: 'summary' }], 'the run that got the event; the other one is not touched');
  assert.deepEqual(list.find((r) => r.id === 'wf_6509ce25-20a').status.prov, 'final', 'and the new summary shows the event');
  assert.deepEqual(take(), []);
  store.listRuns();
  assert.deepEqual(take(), [], 'and once only');
});

test('a re-emitted line (the same content) is not an event: nothing is built', () => {
  const clock = { value: 1794126725000 };
  const { store, take } = counting(clock);
  const p = probe1();
  p.live.forEach((ev) => store.apply(ev));
  store.listRuns();
  take();
  store.apply(p.e.startedA);
  store.listRuns();
  assert.deepEqual(take(), []);
});

test('a Run that getRun has built and that is still current answers the list: no second build', () => {
  const clock = { value: 1794126725000 };
  const { store, take } = counting(clock);
  const p = probe1();
  p.live.forEach((ev) => store.apply(ev));
  store.getRun(p.ids.runId);
  assert.deepEqual(take(), [{ runId: p.ids.runId, kind: 'run' }]);
  const list = store.listRuns();
  assert.deepEqual(take(), [], 'the cached Run is the summary\'s source');
  assert.deepEqual(list[0], summaryOf(store.getRun(p.ids.runId)));
  // a new event makes the cached Run old: the list builds a summary, not a Run
  store.apply({ ...p.e.actA, prov: { ...p.e.actA.prov, line: 99 }, data: { ...p.e.actA.data, text: 'later' } });
  store.listRuns();
  assert.deepEqual(take(), [{ runId: p.ids.runId, kind: 'summary' }]);
});

test('the list never builds a Run: only a request for the Run does', () => {
  const clock = { value: 1794126725000 };
  const { store, builds } = counting(clock);
  for (const ev of probe1().live) store.apply(ev);
  for (const ev of legacy().live) store.apply(ev);
  store.listRuns();
  store.apply(probe1().live[0]);
  store.listRuns();
  assert.ok(builds.length > 0 && builds.every((b) => b.kind === 'summary'), JSON.stringify(builds));
});

test('a hook that throws does not break the store', () => {
  const store = createStore({ now: () => 1794126725000, onBuild: () => { throw new Error('boom'); } });
  for (const ev of probe1().live) store.apply(ev);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.getRun('wf_6509ce25-20a').totals.agents, 5);
});

// ---- the clock: a running run goes stale, and its reason quotes how long it has been silent -----------------------------------------

test('a running run: the summary is the same as the Run\'s at every clock, and it is built again only when the clock changed what it says', () => {
  const ts = 1794200000000;
  const clock = { value: ts + 10_000 };
  const A = counting(clock);
  const events = runningRun('wf_idle', ts);
  for (const ev of events) A.store.apply(ev);
  const against = () => {
    const B = createStore({ now: () => clock.value }); // a second store that is always asked for the whole Run
    for (const ev of events) B.apply(ev);
    return summaryOf(B.getRun('wf_idle'));
  };
  const step = (at) => { clock.value = at; return A.store.listRuns()[0]; };

  assert.deepEqual(step(ts + 10_000), against());
  assert.equal(A.take().length, 1);
  assert.equal(A.store.listRuns().length, 1);
  assert.deepEqual(A.take(), [], 'same clock: no build');
  assert.deepEqual(step(ts + 29 * MIN), against(), 'later, but not past the stale limit (30 min): the same summary');
  assert.deepEqual(A.take(), [], 'and no build for it');
  assert.equal(A.store.listRuns()[0].status.value, 'running');

  const stale = step(ts + 31 * MIN);
  assert.deepEqual(stale, against(), 'past the limit the status flips; the summary is the Run\'s');
  assert.notEqual(stale.status.value, 'running', 'it did flip');
  assert.deepEqual(A.take(), [{ runId: 'wf_idle', kind: 'summary' }], 'one summary build, no Run');
  // still stale and the silence text (rounded to minutes) is the same: kept
  assert.deepEqual(step(ts + 31 * MIN + 10_000), against());
  assert.deepEqual(A.take(), []);
  // the silence text says 32 min now: it is a different summary
  const later = step(ts + 32 * MIN + 10_000);
  assert.deepEqual(later, against());
  assert.notDeepEqual(later.status, stale.status, 'the reason quotes the silence, so it changed');
  assert.deepEqual(A.take(), [{ runId: 'wf_idle', kind: 'summary' }]);
  // an event brings it back to running, with the new last time
  const more = { ...events.at(-1), prov: { ...events.at(-1).prov, line: 3 }, ts: ts + 33 * MIN, data: { text: 'again' } };
  events.push(more);
  A.store.apply(more);
  assert.deepEqual(step(ts + 33 * MIN + 1000), against());
  assert.equal(A.store.listRuns()[0].status.value, 'running');
  assert.deepEqual(A.take(), [{ runId: 'wf_idle', kind: 'summary' }]);
});

test('a finished run does not depend on the clock: its summary is built once however late it is listed', () => {
  const clock = { value: 1794126725000 };
  const { store, take } = counting(clock);
  const p = probe1();
  p.withFinal.forEach((ev) => store.apply(ev));
  const first = store.listRuns();
  take();
  for (const later of [1794126725000 + 3 * 86_400_000, 1794126725000 + 400 * 86_400_000]) {
    clock.value = later;
    assert.deepEqual(store.listRuns(), first);
  }
  assert.deepEqual(take(), []);
});

// ---- the same as the Run says, on every fixture run ----------------------------------------------------------------------------

async function fixtureEvents(runId) {
  const where = await locateRun({ target: runId, root: path.join(REPO, 'fixtures', 'claude-projects') });
  return buildSchedule(await readRunDir(where.sessionDir, where.runId), 1).map((x) => x.event);
}

test('every fixture and probe run, at several clocks: the list item equals summaryOf(getRun) field for field', async () => {
  const sets = [
    ['wf_6509ce25-20a', await fixtureEvents('wf_6509ce25-20a')],
    ['wf_26eb8d70-5c4', await fixtureEvents('wf_26eb8d70-5c4')],
    ['probe1 live', probe1().live],
    ['probe1 final', probe1().withFinal],
    ['probe2 live', probe2().live],
    ['legacy live', legacy().live],
    ['legacy final', legacy().withFinal ?? legacy().live],
    ['running', runningRun('wf_idle', 1794200000000)],
  ];
  let compared = 0;
  for (const [name, events] of sets) {
    const last = Math.max(...events.map((e) => (Number.isFinite(e.ts) ? e.ts : 0)));
    for (const at of [last - MIN, last + 1, last + 29 * MIN, last + 31 * MIN, last + 31 * MIN + 40_000, last + 3 * 86_400_000]) {
      const clock = { value: at };
      const A = counting(clock);
      const B = createStore({ now: () => clock.value });
      for (const ev of events) { A.store.apply(ev); B.apply(ev); }
      const [item] = A.store.listRuns();
      assert.deepEqual(item, summaryOf(B.getRun(item.id)), `${name} at ${at - last} ms from its last event`);
      assert.ok(A.builds.every((b) => b.kind === 'summary'));
      compared++;
    }
  }
  assert.equal(compared, sets.length * 6);
});

test('the list is sorted as before: newest start first, an unknown start last, ties by id', () => {
  const clock = { value: 1794200000000 + 1000 };
  const { store } = counting(clock);
  for (const ev of runningRun('wf_b', 1794100000000)) store.apply(ev);
  for (const ev of runningRun('wf_a', 1794100000000)) store.apply(ev);
  for (const ev of runningRun('wf_c', 1794150000000)) store.apply(ev);
  store.apply(builder({ runId: 'wf_none' }).launched(1, 1794000000000));
  const ids = store.listRuns().map((r) => r.id);
  assert.equal(ids.at(-1), 'wf_none', 'a run with no start known is last');
  assert.deepEqual(ids.slice(0, 3), ['wf_c', 'wf_a', 'wf_b']);
});
