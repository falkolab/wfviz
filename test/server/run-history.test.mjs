// test/server/run-history.test.mjs (node run-history, contract section 4, P1): the server with a `loader`:
// GET /api/runs lists every run with `loaded`, GET /api/runs/:id of a run that is not loaded loads it first (one load per run id),
// /api/stream sends snapshots of loaded runs only. The server knows no source: the loader is a fake with two methods.

import assert from 'node:assert/strict';

import { createServer } from '../../src/server/server.mjs';
import { closeServer, createFakeStore, getJson, listenOnFreePort, makeRun, openSse, request, sleep, test } from './helpers.mjs';

// A loader over a Set of loaded ids. `load(id)` is a function the test gives: it can wait, fail, and it marks the run loaded when it ends.
function fakeLoader(loadedIds, behave = async () => {}) {
  const loaded = new Set(loadedIds);
  const calls = [];
  return {
    loaded,
    calls,
    isLoaded: (id) => loaded.has(id),
    async load(id) {
      calls.push(id);
      await behave(id, loaded);
      loaded.add(id);
    },
  };
}

async function boot(t, { runs, loader, ...options } = {}) {
  const store = createFakeStore(runs ?? [makeRun('wf_new'), makeRun('wf_old')]);
  const errors = [];
  const server = createServer({
    store, mode: 'real', version: '9.9.9', loader, onError: (e) => errors.push(e), heartbeatMs: 60_000, throttleMs: 0, ...options,
  });
  const { port } = await listenOnFreePort(server);
  t.after(() => closeServer(server).catch(() => {}));
  return { server, store, port, errors };
}

const runFrames = (client, id) => client.events.filter((e) => e.event === 'run' && e.data.id === id);

test('GET /api/runs: every run with `loaded` from the loader, on a copy (the store\'s summaries are not touched); without a loader the items are the store\'s', async (t) => {
  const loader = fakeLoader(['wf_new']);
  const { port, store } = await boot(t, { loader });
  const list = (await getJson(port, '/api/runs')).json;
  assert.deepEqual(list.map((r) => [r.id, r.loaded]).sort(), [['wf_new', true], ['wf_old', false]]);
  for (const item of store.listRuns()) assert.ok(!('loaded' in item), 'the store gives no `loaded`, and nothing wrote one into its summaries');
  assert.deepEqual(Object.keys(list[0]).filter((k) => k !== 'loaded').sort(), Object.keys(JSON.parse(JSON.stringify(store.listRuns()[0]))).sort(), 'the other fields are the store\'s');

  const plain = await boot(t, {});
  for (const item of (await getJson(plain.port, '/api/runs')).json) assert.ok(!('loaded' in item), 'no loader: the list is as before');
  // a run of another mode is not listed, loader or not
  const other = await boot(t, { runs: [makeRun('wf_a'), makeRun('demo-x', { source: 'demo' })], loader: fakeLoader([]) });
  assert.deepEqual((await getJson(other.port, '/api/runs')).json.map((r) => r.id), ['wf_a']);
});

test('createServer: a loader without isLoaded() and load() is refused', () => {
  const store = createFakeStore([]);
  assert.throws(() => createServer({ store, mode: 'real', loader: {} }), TypeError);
  assert.throws(() => createServer({ store, mode: 'real', loader: { isLoaded() { return true; } } }), TypeError);
});

test('GET /api/runs/:id: a loaded run is answered at once, without a load', async (t) => {
  const loader = fakeLoader(['wf_new']);
  const { port } = await boot(t, { loader });
  const res = await getJson(port, '/api/runs/wf_new');
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'wf_new');
  assert.deepEqual(loader.calls, []);
});

test('GET /api/runs/:id of a run that is not loaded waits for the load, then answers the Run; the list says loaded after', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const loader = fakeLoader([], async (id) => { entered(); await gate; });
  const { port, store } = await boot(t, { loader });
  let status = null;
  const pending = getJson(port, '/api/runs/wf_old').then((r) => { status = r; return r; });
  await inside;
  await sleep(50);
  assert.equal(status, null, 'no answer while the run is being loaded');
  store.set({ ...store.getRun('wf_old'), counter: 41 }); // what the load adds to the store
  release();
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.json.counter, 41, 'the Run as the store has it after the load');
  assert.deepEqual(loader.calls, ['wf_old']);
  assert.equal((await getJson(port, '/api/runs')).json.find((r) => r.id === 'wf_old').loaded, true);
});

test('one load per run id at a time: simultaneous requests share it; the entry goes when it settles, so a later request loads again after a failure', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fail = true;
  const loader = fakeLoader([], async () => {
    await gate;
    if (fail) throw new Error('cannot read journal.jsonl\nsecond line of the stack');
  });
  const { port, errors } = await boot(t, { loader });
  const all = Promise.all([getJson(port, '/api/runs/wf_old'), getJson(port, '/api/runs/wf_old'), getJson(port, '/api/runs/wf_old')]);
  await sleep(80);
  assert.deepEqual(loader.calls, ['wf_old'], 'three requests, one load');
  release();
  const results = await all;
  for (const r of results) {
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'cannot read journal.jsonl' }, 'a JSON answer with the reason, one line');
  }
  assert.ok(errors.length >= 1, 'the failure is reported to onError');
  assert.equal(loader.loaded.has('wf_old'), false);

  fail = false;
  const again = await getJson(port, '/api/runs/wf_old');
  assert.equal(again.status, 200, 'the failed load can be tried again');
  assert.deepEqual(loader.calls, ['wf_old', 'wf_old']);
});

test('a load that rejects with no message is still a 500 with a reason', async (t) => {
  const loader = fakeLoader([], async () => { throw undefined; }); // eslint-disable-line no-throw-literal
  const { port } = await boot(t, { loader });
  const res = await getJson(port, '/api/runs/wf_old');
  assert.equal(res.status, 500);
  assert.match(res.json.error, /could not be loaded/);
});

test('an unknown run is a 404 and loads nothing; HEAD, /events and /transcript start no load', async (t) => {
  const loader = fakeLoader([]);
  const { port } = await boot(t, { loader, runs: [makeRun('wf_old', { agents: { a1: { id: 'a1', activity: [] } } }), makeRun('demo-x', { source: 'demo' })] });
  assert.equal((await getJson(port, '/api/runs/wf_nope')).status, 404);
  assert.equal((await getJson(port, '/api/runs/demo-x')).status, 404, 'a run of another mode is not found, so it is not loaded either');
  assert.equal((await request(port, { method: 'HEAD', path: '/api/runs/wf_old' })).status, 200);
  assert.equal((await getJson(port, '/api/runs/wf_old/events?since=0')).status, 200);
  assert.equal((await getJson(port, '/api/agents/wf_old/a1/transcript')).status, 200);
  assert.deepEqual(loader.calls, []);
});

test('a client that leaves while its run is loading: nothing is written to it, the load finishes, the server goes on', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = fakeLoader([], async () => { await gate; });
  const { port, errors } = await boot(t, { loader });
  const http = await import('node:http');
  const req = http.get({ host: '127.0.0.1', port, path: '/api/runs/wf_old', agent: false });
  req.on('error', () => {});
  await sleep(60);
  req.destroy();
  await sleep(60);
  release();
  await sleep(60);
  assert.equal(loader.loaded.has('wf_old'), true);
  assert.deepEqual(errors, []);
  assert.equal((await getJson(port, '/api/runs/wf_old')).status, 200);
});

test('/api/stream: snapshots of loaded runs only; a run that is only listed gets none (its events still go), and gets one when it is loaded', async (t) => {
  const loader = fakeLoader(['wf_new']);
  const { port, store } = await boot(t, { loader });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_new');
  await sleep(100);
  assert.equal(runFrames(sse, 'wf_old').length, 0, 'no first snapshot of a listed-only run');

  store.touch('wf_old'); // a change of the listed-only run
  store.pushEvent('wf_old', { message: 'listed-only event' });
  await sleep(100);
  assert.equal(runFrames(sse, 'wf_old').length, 0, 'no snapshot after a change either');
  assert.ok(sse.events.some((e) => e.event === 'event' && e.data.runId === 'wf_old'), 'the event frames stay as they are');

  store.touch('wf_new');
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_new' && e.data.counter === 1);

  assert.equal((await getJson(port, '/api/runs/wf_old')).status, 200); // loads it
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_old', 1000);
  const n = runFrames(sse, 'wf_old').length;
  store.touch('wf_old');
  await sleep(100);
  assert.ok(runFrames(sse, 'wf_old').length > n, 'loaded: its changes are sent');
});
