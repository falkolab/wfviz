// Integration, a run that goes quiet: the model turns "running" into unknown once no file has changed for
// staleMs (a session that was closed or crashed mid-run never writes the final file). That flip depends on
// the clock only, so no event announces it. These tests prove the store tells its listeners anyway, and that
// the server passes it on to an open SSE client, which then agrees with GET /api/runs/:id.
//
// The clock is injected and jumped, as a machine that slept would jump it: no test waits 30 real minutes.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createStore } from '../../src/model/reduce.mjs';
import { createServer } from '../../src/server/server.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { WEB_DIR, copyRun, eventually, findRun, getJson, lastEventTs, mkTmp, openSse, sleep } from './helpers.mjs';

const PROBE1 = findRun('wf_6509ce25-20a');
const RUN_ID = PROBE1.runId;
const MIN = 60e3;
const STORE_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'model', 'reduce.mjs');

// Probe 1 without its final file: what the run looked like while it was running.
async function inProgressEvents(t) {
  const tmp = mkTmp(t);
  const dst = path.join(tmp, PROBE1.slug, PROBE1.session);
  copyRun(PROBE1.sessionDir, PROBE1.runId, dst, { final: false });
  const events = await readRunDir(dst, RUN_ID);
  assert.ok(!events.some((e) => e.kind === 'run.final'), 'no final file in the copy');
  return events;
}

// A store on a controllable clock, one minute after the last event, filled with the events.
function storeAt(events) {
  const last = lastEventTs(events);
  const clock = { last, now: last + MIN };
  const store = createStore({ now: () => clock.now }); // default staleMs: 30 min
  for (const ev of events) store.apply(ev);
  return { store, clock };
}

async function serve(t, store) {
  const server = createServer({ store, webDir: WEB_DIR, mode: 'real', version: null, debounceMs: 20 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

const isRun = (e) => e.event === 'run' && e.data.id === RUN_ID;
// Contract 2 §4: the server sends one `run` snapshot of every run on connect. These tests count
// what comes after it, so they wait for that snapshot and leave it out.
const connectSnapshot = (sse) => sse.waitFor(isRun);
const runEvents = (sse, first) => sse.events.filter((e) => isRun(e) && e !== first);

test('an open SSE client is told when a quiet run crosses staleMs, and GET /api/runs/:id says the same', async (t) => {
  const events = await inProgressEvents(t);
  const { store, clock } = storeAt(events);
  const port = await serve(t, store);
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  const first = await connectSnapshot(sse);

  // what the UI does after `hello`: load the run list and the run
  const listed = (await getJson(port, '/api/runs')).json.find((r) => r.id === RUN_ID);
  assert.deepEqual([listed.status.value, listed.status.prov], ['running', 'inferred']);
  const before = (await getJson(port, `/api/runs/${RUN_ID}`)).json;
  assert.deepEqual([before.status.value, before.status.prov], ['running', 'inferred']);

  await sleep(700);
  assert.equal(runEvents(sse, first).length, 0, 'a run that is still within staleMs and has no new file activity sends nothing');

  clock.now = clock.last + 31 * MIN; // staleMs is 30 min; no file has changed since
  const pushed = await sse.waitFor((e) => isRun(e) && e !== first, 5000);
  assert.deepEqual([pushed.data.status.value, pushed.data.status.prov], [null, 'unknown'], 'the pushed snapshot no longer says running');
  assert.match(pushed.data.status.reason, /no file activity for 31 min \(limit 30 min\)/);
  assert.ok(pushed.data.unknowns.some((u) => u.field === 'status'));
  assert.ok(pushed.data.order.every((id) => pushed.data.agents[id].state.value === 'done'), 'what the journal proves stays proven');

  const served = (await getJson(port, `/api/runs/${RUN_ID}`)).json;
  assert.deepEqual(served.status, pushed.data.status, 'the API and the stream agree');
  const listedNow = (await getJson(port, '/api/runs')).json.find((r) => r.id === RUN_ID);
  assert.deepEqual(listedNow.status, served.status);

  await sleep(1200);
  assert.equal(runEvents(sse, first).length, 1, 'announced once, not on every wake-up of the watch');
});

test('a new file event moves the stale limit: the old limit passes without an announcement, the new one is announced', async (t) => {
  const events = await inProgressEvents(t);
  const { store, clock } = storeAt(events);
  const port = await serve(t, store);
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  const first = await connectSnapshot(sse);
  assert.equal((await getJson(port, `/api/runs/${RUN_ID}`)).json.status.value, 'running'); // observed as running

  // 25 min later one more line of agent activity arrives (the same shape as a real one, a later line number)
  const template = events.filter((e) => e.kind === 'agent.activity' && Number.isInteger(e.prov?.line)).at(-1);
  assert.ok(template, 'the fixture has agent activity');
  clock.now = clock.last + 25 * MIN;
  store.apply({ ...template, ts: clock.now, prov: { ...template.prov, line: template.prov.line + 100_000 } });
  await sse.waitFor((e) => isRun(e) && e !== first, 5000);
  assert.equal((await getJson(port, `/api/runs/${RUN_ID}`)).json.status.value, 'running');

  clock.now = clock.last + 31 * MIN; // past the limit the first events set, inside the one the new event set
  await sleep(1300); // more than two wake-ups of the watch
  assert.equal(runEvents(sse, first).length, 1, 'only the event that was applied; no stale announcement');
  assert.equal((await getJson(port, `/api/runs/${RUN_ID}`)).json.status.value, 'running');

  clock.now = clock.last + 56 * MIN; // 25 + 30 min: now it is quiet
  await eventually(() => {
    assert.equal(runEvents(sse, first).length, 2, 'the new limit is announced');
  }, { ms: 5000 });
  assert.deepEqual([runEvents(sse, first)[1].data.status.value, runEvents(sse, first)[1].data.status.prov], [null, 'unknown']);
});

test('store.onChange: the stale flip is reported once; after unsubscribing it is not reported', async (t) => {
  const events = await inProgressEvents(t);
  const { store, clock } = storeAt(events);
  const calls = [];
  const off = store.onChange((id) => calls.push(id));
  t.after(off);
  assert.equal(store.getRun(RUN_ID).status.value, 'running');
  assert.deepEqual(calls, []);

  clock.now = clock.last + 31 * MIN;
  await eventually(() => assert.deepEqual(calls, [RUN_ID]), { ms: 3000 });
  assert.equal(store.getRun(RUN_ID).status.prov, 'unknown');
  await sleep(1100);
  assert.deepEqual(calls, [RUN_ID], 'once');

  // a second store: unsubscribe before the clock passes the limit
  const second = storeAt(events);
  const seen = [];
  const offSecond = second.store.onChange((id) => seen.push(id));
  assert.equal(second.store.getRun(RUN_ID).status.value, 'running');
  offSecond();
  second.clock.now = second.clock.last + 31 * MIN;
  await sleep(1100);
  assert.deepEqual(seen, [], 'nobody listens, nothing fires');
  assert.equal(second.store.getRun(RUN_ID).status.prov, 'unknown', 'the answer itself is unchanged: asking gives unknown');
});

test('the stale watch does not keep a process alive: a script that subscribes and ends exits by itself', () => {
  const script = `
    import { createStore } from ${JSON.stringify(STORE_MODULE)};
    const store = createStore();
    store.apply({ src: 'claude-fs', kind: 'run.launched', runId: 'wf_idle-1', sessionId: null, project: null, ts: Date.now(), prov: { file: '(test)', line: 1 }, data: {} });
    store.onChange(() => {});
    const run = store.getRun('wf_idle-1');
    if (run.status.value !== 'running') throw new Error('expected a running run, got ' + JSON.stringify(run.status));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(res.error, undefined, `the script did not end by itself: ${res.error?.message}`);
  assert.deepEqual([res.status, res.signal], [0, null], res.stderr);
});
