// test/server/replay.test.mjs: the server in mode "replay" (docs/contract.md section 1 "Replay", section 4 hello).
//
//   1. createServer with a fake store: the mode is accepted, hello carries it, the other modes' runs are invisible.
//   2. The real replay source and the real store (staleMs Infinity) in front of createServer, on a saved fixture
//      run: what a browser would be told while a replay runs and after it ended.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../../src/model/reduce.mjs';
import { createReplaySource } from '../../src/source/replay.mjs';
import { createServer } from '../../src/server/server.mjs';
import { closeServer, createFakeStore, getJson, listenOnFreePort, makeRun, openSse, sleep, test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const RUN_ID = 'wf_6509ce25-20a';

async function start(t, { store = createFakeStore(), mode = 'replay', version = '9.9.9', ...rest } = {}) {
  const server = createServer({ store, mode, version, onError: () => {}, ...rest });
  const address = await listenOnFreePort(server);
  t.after(() => closeServer(server));
  return { server, store, port: address.port };
}

// The launcher tells the server of a replay's changes after a step (the events the source hands over in one go), so that the first snapshot
// is the Run after the first step and not the Run after run.script alone. This stands in for that part of the launcher (bin.test.mjs and
// replay-endpoint.test.mjs run the launcher itself): the same real source, real store and real server, the changes announced after the step.
function announcedAfterStep(store) {
  return {
    ...store,
    onChange(listener) {
      const waiting = new Set();
      return store.onChange((runId) => {
        if (waiting.has(runId)) return;
        waiting.add(runId);
        queueMicrotask(() => { waiting.delete(runId); listener(runId); });
      });
    },
  };
}

// ---- 1. fake store ---------------------------------------------------------------------------------------

test('createServer accepts mode "replay"; an unknown mode is a TypeError that names the three modes', () => {
  assert.doesNotThrow(() => createServer({ store: createFakeStore(), mode: 'replay' }));
  for (const bad of ['Replay', 'live', '', undefined, null, 1]) {
    assert.throws(() => createServer({ store: createFakeStore(), mode: bad }), { name: 'TypeError', message: /"real", "demo" or "replay"/ }, String(bad));
  }
});

test('hello carries mode "replay" first, with the version', async (t) => {
  const { port } = await start(t);
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.deepEqual(hello.data, { mode: 'replay', version: '9.9.9' });
  assert.equal(sse.events[0].event, 'hello', 'hello is the first event');
});

test('replay mode shows only replay runs, in the list, by id, in the transcript endpoint and on the stream', async (t) => {
  const store = createFakeStore([
    makeRun('wf_replayed', { source: 'replay' }),
    makeRun('wf_real', { source: 'real' }),
    makeRun('demo-x', { source: 'demo' }),
    makeRun('wf_untagged', { source: undefined }),
  ]);
  const { port } = await start(t, { store });
  assert.deepEqual((await getJson(port, '/api/runs')).json.map((r) => r.id).sort(), ['wf_replayed', 'wf_untagged']);
  assert.equal((await getJson(port, '/api/runs/wf_replayed')).status, 200);
  for (const hidden of ['wf_real', 'demo-x']) {
    assert.equal((await getJson(port, `/api/runs/${hidden}`)).status, 404, hidden);
    assert.equal((await getJson(port, `/api/runs/${hidden}/events`)).status, 404, hidden);
    assert.equal((await getJson(port, `/api/agents/${hidden}/a/transcript`)).status, 404, hidden);
  }
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  store.pushEvent('wf_real', { kind: 'agent.activity' });
  store.pushEvent('wf_replayed', { kind: 'agent.activity' });
  await sse.waitFor((e) => e.event === 'event' && e.data.runId === 'wf_replayed');
  await sleep(100);
  const ids = new Set(sse.events.filter((e) => e.event === 'run' || e.event === 'event').map((e) => e.data.runId ?? e.data.id));
  assert.ok(!ids.has('wf_real') && !ids.has('demo-x'), JSON.stringify([...ids]));
});

test('the other modes do not show replay runs', async (t) => {
  const store = createFakeStore([makeRun('wf_replayed', { source: 'replay' }), makeRun('wf_real', { source: 'real' }), makeRun('demo-x', { source: 'demo' })]);
  const real = await start(t, { store, mode: 'real' });
  assert.deepEqual((await getJson(real.port, '/api/runs')).json.map((r) => r.id), ['wf_real']);
  assert.equal((await getJson(real.port, '/api/runs/wf_replayed')).status, 404);
  const demo = await start(t, { store, mode: 'demo' });
  assert.deepEqual((await getJson(demo.port, '/api/runs')).json.map((r) => r.id), ['demo-x']);
  assert.equal((await getJson(demo.port, '/api/runs/wf_replayed')).status, 404);
});

// ---- 2. real replay source + real store ------------------------------------------------------------------

test('a saved run replayed through the source and the store: the server says replay, shows the run as it unfolds, and ends completed', async (t) => {
  const store = createStore({ staleMs: Infinity });
  // a short snapshot window: with the default 1 s the whole replay (under a second at speed 20) would give one snapshot at the start and one at the end
  const { port } = await start(t, { store: announcedAfterStep(store), throttleMs: 50 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.equal(hello.data.mode, 'replay');

  // speed 20: the 13 s of transcript time take under a second; the jump to the files' own times is capped at 2 s / speed
  const source = createReplaySource({ root: ROOT, runId: RUN_ID, speed: 20, onEvent: (e) => store.apply(e) });
  t.after(() => source.stop());
  await source.start();

  const first = await sse.waitFor((e) => e.event === 'run' && e.data.id === RUN_ID, 3000);
  assert.equal(first.data.source, 'replay');
  const list = (await getJson(port, '/api/runs')).json;
  assert.deepEqual(list.map((r) => [r.id, r.source]), [[RUN_ID, 'replay']]);

  // while it runs the status is "running" (inferred), never the stale "unknown" a day-old run would get; and that holds for the first snapshot
  // too: it is the Run after the first step (run.script, run.launched, the first records of the first agent), with the first agent's
  // start as the run's start, and not the Run after run.script alone (the script file time as the start, no status)
  const finalSnapshot = await sse.waitFor((e) => e.event === 'run' && e.data.id === RUN_ID && e.data.status.value === 'completed', 8000);
  const snapshots = sse.events.slice(0, sse.events.indexOf(finalSnapshot) + 1).filter((e) => e.event === 'run' && e.data.id === RUN_ID).map((e) => e.data);
  const statuses = snapshots.map((r) => `${r.status.value}/${r.status.prov}`);
  assert.ok(statuses.every((s) => s === 'running/inferred' || s === 'completed/final'), JSON.stringify(statuses));
  assert.equal(statuses[0], 'running/inferred', `the first snapshot of a run that is still being replayed is running: ${JSON.stringify(statuses)}`);
  assert.equal(snapshots[0].startedAt.method, 'earliest-agent-start', `the first snapshot's start is an agent's, not the script file time: ${JSON.stringify(snapshots[0].startedAt)}`);
  assert.ok(snapshots.length >= 2 && statuses.includes('running/inferred'), JSON.stringify(statuses));
  assert.equal(finalSnapshot.data.totals.agents, 5);

  const run = (await getJson(port, `/api/runs/${RUN_ID}`)).json;
  assert.equal(run.source, 'replay');
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
  assert.equal(run.totals.done, 5);
  assert.equal(run.name.value, 'probe-event-format');

  // the UiEvents are the run's own events, in order, no gaps
  const events = (await getJson(port, `/api/runs/${RUN_ID}/events`)).json;
  assert.ok(events.length >= 20);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
});

test('the replayed run equals the direct read of the saved run except for source', async (t) => {
  const { readRunDir } = await import('../../src/source/claude-fs.mjs');
  const { locateRun } = await import('../../src/source/replay.mjs');
  const where = await locateRun({ target: RUN_ID, root: ROOT });
  const now = () => Date.now();
  const direct = createStore({ now, staleMs: Infinity });
  for (const ev of await readRunDir(where.sessionDir, where.runId)) direct.apply(ev);

  const replayed = createStore({ now, staleMs: Infinity });
  const source = createReplaySource({ runDir: where.runDir, speed: 100, onEvent: (e) => replayed.apply(e) });
  t.after(() => source.stop());
  await source.start();
  // the agent.meta events (written at file times) come last in the schedule: wait for all of the events
  const total = direct.eventsSince(RUN_ID, 0).length;
  for (let i = 0; i < 200 && replayed.eventsSince(RUN_ID, 0).length < total; i++) await sleep(50);
  assert.equal(replayed.eventsSince(RUN_ID, 0).length, total, 'every event was replayed');
  const a = replayed.getRun(RUN_ID);
  const b = direct.getRun(RUN_ID);
  assert.equal(a.source, 'replay');
  assert.equal(b.source, 'real');
  assert.deepEqual({ ...a, source: 'real' }, b);
});
