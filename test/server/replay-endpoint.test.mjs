// test/server/replay-endpoint.test.mjs (node replay-in-app): GET /api/runs/:id/replay (contract section 4).
//   part 1: createServer with a fake `replays` (the server's side of the route: frames, order, refusals, stop, throttle, the real side untouched);
//   part 2: the launcher with the real modules on the saved runs in fixtures/claude-projects (the real `replays`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { createServer, MAX_REPLAYS } from '../../src/server/server.mjs';
import {
  closeServer, createFakeStore, getJson, listenOnFreePort, makeRun, openSse, request, sleep, startBin, test,
} from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'wfviz.mjs');

// ---- part 1: the server with a fake `replays` ---------------------------------------------------------------------------------

const finished = (id, extra = {}) => makeRun(id, { status: { value: 'completed', prov: 'final', from: 'test:1' }, ...extra });
const replayRun = (id, counter) => makeRun(id, { source: 'replay', counter, status: { value: 'running', prov: 'inferred', method: 'no-final-file' } });
const uiEvent = (runId, seq) => ({ runId, seq, ts: 1000 + seq, kind: 'agent.activity', message: `event ${seq}`, prov: 'registered' });

// replays.open records the request (and its callbacks) and returns a handle that counts stop(); `behave(rec)` runs inside open(), so a
// test can call back at once, throw, or hand back another handle
function fakeReplays(behave, prepare) {
  const opened = [];
  return {
    opened,
    ...(prepare ? { prepare } : {}),
    open(request) {
      const rec = { request, stops: 0, at: opened.length };
      opened.push(rec);
      const own = behave ? behave(rec) : undefined;
      return own !== undefined ? own : { stop() { rec.stops += 1; } };
    },
  };
}

async function boot(t, { runs = [finished('wf_a')], mode = 'real', replays, ...options } = {}) {
  const store = createFakeStore(runs);
  const counts = [];
  const errors = [];
  const server = createServer({
    store, mode, version: '9.9.9', replays, onClientCountChange: (n) => counts.push(n), onError: (e) => errors.push(e),
    heartbeatMs: 60_000, throttleMs: 60_000, ...options,
  });
  const { port } = await listenOnFreePort(server);
  t.after(() => closeServer(server).catch(() => {}));
  return { server, store, port, counts, errors };
}

async function until(pred, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(5);
  }
  assert.fail(`not reached within ${ms} ms: ${what}`);
}

const replayPath = (id = 'wf_a', query = '') => `/api/runs/${id}/replay${query}`;
// a replay stream that has been opened: the client, and the fake's record of the open() call it made
async function openReplay(t, ctx, id = 'wf_a', query = '') {
  const before = ctx.replays.opened.length;
  const client = await openSse(ctx.port, { path: replayPath(id, query) });
  t.after(() => client.close());
  assert.equal(client.status, 200);
  await until(() => ctx.replays.opened.length === before + 1, 2000, 'replays.open was called');
  return { client, rec: ctx.replays.opened[before] };
}
const names = (client) => client.events.map((e) => e.event);

test('a replay stream: hello first, then the events and snapshots the replay gives, then end; the stream closes by itself and stop() runs once', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const { client, rec } = await openReplay(t, ctx, 'wf_a', '?speed=100');
  assert.match(client.headers['content-type'], /^text\/event-stream/);
  assert.match(client.headers['cache-control'], /no-cache/);
  assert.deepEqual(rec.request.speed, 100);
  assert.equal(rec.request.runId, 'wf_a');

  rec.request.onEvent(uiEvent('wf_a', 1));
  rec.request.onRun(replayRun('wf_a', 1)); // the first change goes out at once
  rec.request.onEvent(uiEvent('wf_a', 2));
  rec.request.onEvent(uiEvent('wf_a', 3));
  rec.request.onRun(replayRun('wf_a', 3)); // inside the window (60 s): held back
  await client.waitFor((e) => e.event === 'run');
  await sleep(30);
  assert.deepEqual(names(client), ['hello', 'event', 'run', 'event', 'event'], 'the second snapshot waits for its window');
  rec.request.onEnd();
  await client.waitClosed();

  assert.deepEqual(names(client), ['hello', 'event', 'run', 'event', 'event', 'run', 'end'], 'at the end the held snapshot goes out first, then end');
  assert.deepEqual(client.events[0].data, { mode: 'replay', version: '9.9.9', runId: 'wf_a' });
  assert.deepEqual(client.events.filter((e) => e.event === 'event').map((e) => e.data.seq), [1, 2, 3], 'seq as the replay gave it, from 1, no gap');
  assert.deepEqual(client.events.filter((e) => e.event === 'run').map((e) => [e.data.source, e.data.counter]), [['replay', 1], ['replay', 3]]);
  assert.deepEqual(client.events.at(-1).data, { runId: 'wf_a', events: 3 });
  assert.equal(client.ended, true, 'the response is ended, nothing waits for a reconnect');
  await until(() => rec.stops === 1, 2000, 'stop() after the end');
  await sleep(30);
  assert.equal(rec.stops, 1, 'stop() once');
  assert.deepEqual(ctx.errors, []);
});

test('a replay stream with no change held back at the end: no repeated snapshot, end follows the last one', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const { client, rec } = await openReplay(t, ctx);
  rec.request.onRun(replayRun('wf_a', 1));
  rec.request.onEnd();
  await client.waitClosed();
  assert.deepEqual(names(client), ['hello', 'run', 'end']);
  assert.deepEqual(client.events.at(-1).data, { runId: 'wf_a', events: 0 }, 'events counts the event frames this stream carried');
});

test('the run snapshots are throttled like /api/stream: the first at once, the changes of a window coalesce, the trailing one carries the last Run given', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, throttleMs: 150 })), replays };
  const { client, rec } = await openReplay(t, ctx);
  rec.request.onRun(replayRun('wf_a', 1));
  rec.request.onRun(replayRun('wf_a', 2));
  rec.request.onRun(replayRun('wf_a', 3));
  await client.waitFor((e) => e.event === 'run' && e.data.counter === 3, 2000);
  assert.deepEqual(client.events.filter((e) => e.event === 'run').map((e) => e.data.counter), [1, 3], 'the middle one is superseded, the last is not dropped');
  const gap = client.events.filter((e) => e.event === 'run').map((e) => e.at);
  assert.ok(gap[1] - gap[0] >= 100, `the trailing snapshot waited for the window (${gap[1] - gap[0]} ms)`);
  rec.request.onRun(replayRun('wf_a', 4)); // a quiet window has passed? not yet: it is again held
  await sleep(20);
  assert.equal(client.events.filter((e) => e.event === 'run').length, 2);
  await client.waitFor((e) => e.event === 'run' && e.data.counter === 4, 2000);
});

test('a snapshot whose source is not "replay" never leaves: it is dropped, reported once per snapshot to onError, and the stream goes on', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const { client, rec } = await openReplay(t, ctx);
  rec.request.onRun(makeRun('wf_a', { source: 'real' }));
  await sleep(30);
  assert.deepEqual(names(client), ['hello']);
  assert.equal(ctx.errors.length, 1);
  assert.match(ctx.errors[0].message, /source is not "replay"/);
  for (const bad of [makeRun('wf_a', { source: undefined }), makeRun('wf_a', { source: 'demo' })]) {
    delete bad.source;
    rec.request.onRun(bad);
  }
  await sleep(30);
  assert.deepEqual(names(client), ['hello'], 'a Run with no source is not a replay either');
  rec.request.onRun(replayRun('wf_a', 9));
  await client.waitFor((e) => e.event === 'run');
  assert.equal(client.events.find((e) => e.event === 'run').data.counter, 9);
  assert.equal(client.closed, false);
});

test('speed: absent reaches the replay as undefined (the server invents no default), a decimal number above 0 as that number (the replay clamps it)', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const cases = [['', undefined], ['?speed=4', 4], ['?speed=0.25', 0.25], ['?speed=.5', 0.5], ['?speed=1e2', 100], ['?speed=500', 500], ['?speed=1.', 1]];
  for (const [query, expected] of cases) {
    const { client, rec } = await openReplay(t, ctx, 'wf_a', query);
    assert.equal(rec.request.speed, expected, `speed ${JSON.stringify(query)}`);
    client.close();
    await until(() => rec.stops === 1);
  }
});

test('speed that is no number above 0 is a 400 and no replay is opened; so is a repeated speed', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  for (const q of ['speed=abc', 'speed=0', 'speed=-1', 'speed=', 'speed', 'speed=%20', 'speed=+1', 'speed=%2B1', 'speed=0x10', 'speed=Infinity', 'speed=1e999', 'speed=NaN', 'speed=1e-999', 'speed=1&speed=2', 'speed=4&speed=']) {
    const res = await getJson(ctx.port, replayPath('wf_a', `?${q}`));
    assert.equal(res.status, 400, q);
    assert.equal(typeof res.json.error, 'string', q);
    assert.match(res.headers['content-type'], /^application\/json/);
  }
  assert.equal(replays.opened.length, 0);
  assert.equal(ctx.counts.length, 0, 'a refusal is no stream');
});

test('404 when the mode is not real, when there is no `replays`, or when the real store does not have the run; 405 for what is not GET', async (t) => {
  const replays = fakeReplays();
  const demo = await boot(t, { mode: 'demo', runs: [finished('demo-1', { source: 'demo' })], replays });
  assert.deepEqual((await getJson(demo.port, replayPath('demo-1'))).json, { error: 'not found' });
  assert.equal((await getJson(demo.port, replayPath('demo-1'))).status, 404);
  assert.equal((await getJson(demo.port, replayPath('demo-1', '?speed=abc'))).status, 404, 'the mode is asked before the speed');
  const mode = await boot(t, { mode: 'replay', runs: [finished('wf_a', { source: 'replay' })], replays });
  assert.equal((await getJson(mode.port, replayPath('wf_a'))).status, 404);

  const none = await boot(t, { runs: [finished('wf_a')] });
  const noReplays = await getJson(none.port, replayPath('wf_a'));
  assert.deepEqual([noReplays.status, noReplays.json], [404, { error: 'not found' }]);

  const real = await boot(t, { runs: [finished('wf_a'), finished('demo-1', { source: 'demo' })], replays });
  const unknown = await getJson(real.port, replayPath('wf_nope'));
  assert.deepEqual([unknown.status, unknown.json], [404, { error: 'run not found' }]);
  assert.equal((await getJson(real.port, replayPath('demo-1'))).status, 404, 'a run of another source is not in the real store');
  assert.equal((await getJson(real.port, '/api/runs//replay')).status, 404);
  assert.equal((await getJson(real.port, `${replayPath('wf_a')}/more`)).status, 404, 'no longer path');

  const post = await request(real.port, { method: 'POST', path: replayPath('wf_a') });
  assert.equal(post.status, 405);
  const head = await request(real.port, { method: 'HEAD', path: replayPath('wf_a') });
  assert.equal(head.status, 405);
  assert.equal(head.headers.allow, 'GET');
  assert.equal(replays.opened.length, 0, 'none of this opened a replay');
});

test('409 when the run is running (the status value "running", whatever its prov); any other status, an unknown one too, can be replayed', async (t) => {
  const running = (id, prov) => makeRun(id, { status: { value: 'running', prov, ...(prov === 'final' ? { from: 'f:1' } : { method: 'no-final-file' }) } });
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, {
    replays,
    runs: [
      running('wf_run1', 'inferred'), running('wf_run2', 'final'), finished('wf_done'),
      makeRun('wf_unknown', { status: { value: null, prov: 'unknown', reason: 'the journal is not read yet' } }),
      makeRun('wf_stale', { status: { value: 'stale', prov: 'inferred', method: 'no event for 30 minutes' } }),
      makeRun('wf_inf', { status: { value: 'completed', prov: 'inferred', method: 'x' } }),
    ],
  })), replays };
  for (const id of ['wf_run1', 'wf_run2']) {
    const res = await getJson(ctx.port, replayPath(id));
    assert.equal(res.status, 409, id);
    assert.match(res.json.error, /running/, 'the reason says why');
  }
  assert.equal(replays.opened.length, 0);
  for (const id of ['wf_done', 'wf_unknown', 'wf_stale', 'wf_inf']) {
    const { client } = await openReplay(t, ctx, id);
    assert.equal((await client.waitFor((e) => e.event === 'hello')).data.runId, id);
    client.close();
  }
  assert.equal(replays.opened.length, 4);
});

test('429 for the fourth replay open at the same time; a closed one frees its slot, so does an ended one; the checks go in order: speed, run, running, then the limit', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, runs: [finished('wf_a'), finished('wf_b'), makeRun('wf_run')] })), replays };
  assert.equal(MAX_REPLAYS, 3);
  const open = [];
  for (let i = 0; i < MAX_REPLAYS; i++) open.push(await openReplay(t, ctx, i % 2 ? 'wf_b' : 'wf_a'));
  const fourth = await getJson(ctx.port, replayPath('wf_a'));
  assert.equal(fourth.status, 429);
  assert.match(fourth.json.error, /3 replays/);
  assert.equal(replays.opened.length, 3, 'the fourth was not opened');
  assert.equal((await getJson(ctx.port, replayPath('wf_a', '?speed=abc'))).status, 400, 'a bad speed is a 400 even when the server is full');
  assert.equal((await getJson(ctx.port, replayPath('wf_nope'))).status, 404, 'an unknown run is a 404 when the server is full');
  assert.equal((await getJson(ctx.port, replayPath('wf_run'))).status, 409, 'a running run is a 409 when the server is full');

  open[0].client.close(); // a closed one frees its slot
  await until(() => open[0].rec.stops === 1, 2000, 'the closed replay was stopped');
  const again = await openReplay(t, ctx, 'wf_a');
  assert.equal(again.client.status, 200);
  assert.equal((await getJson(ctx.port, replayPath('wf_a'))).status, 429, 'full again');

  open[1].rec.request.onEnd(); // an ended one frees its slot at once
  await open[1].client.waitClosed();
  const fifth = await openReplay(t, ctx, 'wf_a');
  assert.equal(fifth.client.status, 200);
});

test('closing the request stops the replay once and leaves no timer: the snapshot timer and the heartbeat are cleared, and nothing the replay still calls writes or throws', async (t) => {
  const handles = { set: new Set(), cleared: new Set() };
  const realSet = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const ours = (ms) => ms > 50_000 && ms <= 62_000; // the throttle (about 60 s) and the heartbeat (61 s) of this server, not the timers of node
  globalThis.setTimeout = (fn, ms, ...rest) => { const h = realSet.setTimeout(fn, ms, ...rest); if (ours(ms)) handles.set.add(h); return h; };
  globalThis.clearTimeout = (h) => { handles.cleared.add(h); return realSet.clearTimeout(h); };
  globalThis.setInterval = (fn, ms, ...rest) => { const h = realSet.setInterval(fn, ms, ...rest); if (ours(ms)) handles.set.add(h); return h; };
  globalThis.clearInterval = (h) => { handles.cleared.add(h); return realSet.clearInterval(h); };
  const restore = () => Object.assign(globalThis, realSet);
  t.after(restore);

  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, throttleMs: 60_000, heartbeatMs: 61_000 })), replays };
  const { client, rec } = await openReplay(t, ctx);
  rec.request.onRun(replayRun('wf_a', 1));
  rec.request.onRun(replayRun('wf_a', 2)); // arms the snapshot timer
  await client.waitFor((e) => e.event === 'run');
  assert.ok(handles.set.size >= 2, `the server armed a snapshot timer and a heartbeat (${handles.set.size})`);
  assert.ok([...handles.set].some((h) => !handles.cleared.has(h)), 'something is pending while the client is there');

  client.close();
  await until(() => rec.stops === 1, 2000, 'stop() after the client left');
  assert.deepEqual([...handles.set].filter((h) => !handles.cleared.has(h)), [], 'every timer the server made is cleared');
  assert.equal(ctx.counts.at(-1), 0);

  // what the replay still calls after stop() is ignored
  rec.request.onEvent(uiEvent('wf_a', 5));
  rec.request.onRun(replayRun('wf_a', 5));
  rec.request.onEnd();
  rec.request.onError(new Error('late'));
  await sleep(30);
  assert.equal(rec.stops, 1, 'stop() once however often it is called back');
  assert.deepEqual(ctx.errors, [], 'a late callback is no error');
  assert.deepEqual([...handles.set].filter((h) => !handles.cleared.has(h)), [], 'and arms no timer');
});

test('server.close() ends every open replay stream and stops each replay once', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const a = await openReplay(t, ctx, 'wf_a');
  const b = await openReplay(t, ctx, 'wf_a');
  const stream = await openSse(ctx.port);
  t.after(() => stream.close());
  await stream.waitFor((e) => e.event === 'hello');
  await closeServer(ctx.server);
  await a.client.waitClosed();
  await b.client.waitClosed();
  await stream.waitClosed();
  assert.deepEqual([a.rec.stops, b.rec.stops], [1, 1]);
  assert.equal(ctx.counts.at(-1), 0);
});

test('nothing of a replay reaches /api/stream, /api/runs or the real store, and nothing of the real store reaches a replay stream', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, throttleMs: 0 })), replays };
  const real = await openSse(ctx.port);
  t.after(() => real.close());
  await real.waitFor((e) => e.event === 'run' && e.data.id === 'wf_a');
  const realBefore = real.events.length;
  const listing = JSON.stringify((await getJson(ctx.port, '/api/runs')).json);
  const runBefore = JSON.stringify((await getJson(ctx.port, '/api/runs/wf_a')).json);
  const eventsBefore = JSON.stringify((await getJson(ctx.port, '/api/runs/wf_a/events')).json);
  const subscribed = [ctx.store.listenerCount(), ctx.store.eventListenerCount()];

  const { client, rec } = await openReplay(t, ctx, 'wf_a'); // the same run id as the real run
  assert.deepEqual([ctx.store.listenerCount(), ctx.store.eventListenerCount()], subscribed, 'a replay stream subscribes to nothing of the real store');
  rec.request.onEvent(uiEvent('wf_a', 1));
  rec.request.onRun(replayRun('wf_a', 7));
  await client.waitFor((e) => e.event === 'run');
  await sleep(40);
  assert.equal(real.events.length, realBefore, 'the /api/stream client got nothing from the replay');
  assert.equal(real.events.some((e) => e.data?.source === 'replay' || e.event === 'event'), false);
  assert.equal(JSON.stringify((await getJson(ctx.port, '/api/runs')).json), listing, 'the run list is the real one');
  assert.equal(JSON.stringify((await getJson(ctx.port, '/api/runs/wf_a')).json), runBefore, 'the run is the real one');
  assert.equal(JSON.stringify((await getJson(ctx.port, '/api/runs/wf_a/events')).json), eventsBefore, 'the real run has no replayed event');
  assert.equal(ctx.store.getRun('wf_a').source, 'real');

  // the other way: a change of the real run, and a real event, of the same run id, are not written to the replay stream
  const replayFrames = client.events.length;
  ctx.store.pushEvent('wf_a', { message: 'a real event' });
  ctx.store.touch('wf_a');
  await real.waitFor((e) => e.event === 'event' && e.data.message === 'a real event', 2000, realBefore);
  await sleep(40);
  assert.equal(client.events.length, replayFrames, 'the replay stream got nothing from the real store');
});

test('replay streams count as clients (the idle shutdown), together with /api/stream', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const { client, rec } = await openReplay(t, ctx);
  assert.deepEqual(ctx.counts, [1]);
  const stream = await openSse(ctx.port);
  t.after(() => stream.close());
  await stream.waitFor((e) => e.event === 'hello');
  assert.equal(ctx.counts.at(-1), 2);
  client.close();
  await until(() => rec.stops === 1);
  assert.equal(ctx.counts.at(-1), 1, 'the replay is gone, the stream stays');
  stream.close();
  await until(() => ctx.counts.at(-1) === 0);
});

test('heartbeat comments reach a replay stream, also when it is the only client; the timer stops with it', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, heartbeatMs: 30 })), replays };
  const { client, rec } = await openReplay(t, ctx);
  await until(() => client.comments.includes('heartbeat'), 1000, 'a heartbeat comment');
  client.close();
  await until(() => rec.stops === 1);
});

test('open() calls back before it returns: the frames come in order, end ends the stream, stop() runs once, after open() has returned', async (t) => {
  let stopsAtReturn = null;
  const replays = fakeReplays((rec) => {
    rec.request.onEvent(uiEvent('wf_a', 1));
    rec.request.onRun(replayRun('wf_a', 1));
    rec.request.onEnd();
    stopsAtReturn = rec.stops; // the handle does not exist yet
  });
  const ctx = { ...(await boot(t, { replays })), replays };
  const client = await openSse(ctx.port, { path: replayPath('wf_a') });
  t.after(() => client.close());
  await client.waitClosed();
  assert.deepEqual(names(client), ['hello', 'event', 'run', 'end']);
  assert.equal(stopsAtReturn, 0);
  await until(() => replays.opened[0].stops === 1);
  await sleep(30);
  assert.equal(replays.opened[0].stops, 1);
  assert.equal(ctx.counts.at(-1), 0, 'the slot is free');
});

test('a failing replay: open() throws, or the replay calls onError - the stream ends with no `end`, the reason goes to onError, the slot is free', async (t) => {
  const boom = new Error('cannot read the run');
  const throwing = fakeReplays(() => { throw boom; });
  const a = { ...(await boot(t, { replays: throwing })), replays: throwing };
  const c1 = await openSse(a.port, { path: replayPath('wf_a') });
  t.after(() => c1.close());
  await c1.waitClosed();
  assert.deepEqual(names(c1), ['hello'], 'no end, no invented error event');
  assert.deepEqual(a.errors, [boom]);
  assert.equal(a.counts.at(-1), 0);

  const failing = fakeReplays();
  const b = { ...(await boot(t, { replays: failing })), replays: failing };
  const { client, rec } = await openReplay(t, b);
  rec.request.onEvent(uiEvent('wf_a', 1));
  rec.request.onError(new Error('the files are gone'));
  await client.waitClosed();
  assert.deepEqual(names(client), ['hello', 'event']);
  assert.equal(b.errors.length, 1);
  assert.match(b.errors[0].message, /files are gone/);
  await until(() => rec.stops === 1);
  rec.request.onEnd(); // nothing after an error
  rec.request.onError(new Error('again'));
  await sleep(30);
  assert.deepEqual([rec.stops, b.errors.length], [1, 1]);
});

test('onRun may give a function that builds the newest Run: it is called when a snapshot goes out (the first at once, the held one at the end), never once per change', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays })), replays };
  const { client, rec } = await openReplay(t, ctx);
  let built = 0;
  const latest = (n) => () => { built += 1; return replayRun('wf_a', n); };
  rec.request.onRun(latest(1)); // the first change goes out at once
  await client.waitFor((e) => e.event === 'run');
  assert.equal(built, 1);
  for (let n = 2; n <= 50; n++) rec.request.onRun(latest(n)); // 49 changes inside the window (60 s): none is built
  await sleep(30);
  assert.equal(built, 1, 'a change that is held back builds nothing');
  rec.request.onEnd();
  await client.waitClosed();
  assert.equal(built, 2, 'the end builds the newest one, once');
  assert.deepEqual(names(client), ['hello', 'run', 'run', 'end']);
  assert.deepEqual(client.events.filter((e) => e.event === 'run').map((e) => e.data.counter), [1, 50], 'the last snapshot is the newest state');
  assert.deepEqual(ctx.errors, []);
});

test('a function given to onRun that returns a real Run is dropped like a real Run (reported, the stream goes on); one that throws, or returns nothing, is reported or skipped and the stream goes on', async (t) => {
  const replays = fakeReplays();
  const ctx = { ...(await boot(t, { replays, throttleMs: 0 })), replays };
  const { client, rec } = await openReplay(t, ctx);
  rec.request.onRun(() => finished('wf_a')); // source real
  rec.request.onRun(() => { throw new Error('the model failed'); });
  rec.request.onRun(() => null);
  rec.request.onRun(() => replayRun('wf_a', 7));
  await client.waitFor((e) => e.event === 'run');
  assert.deepEqual(client.events.filter((e) => e.event === 'run').map((e) => e.data.source), ['replay']);
  assert.equal(ctx.errors.length, 2);
  assert.match(ctx.errors[0].message, /source is not "replay"/);
  assert.match(ctx.errors[1].message, /the model failed/);
  assert.equal(client.closed, false, 'the stream is still open');
});

// `prepare`: the run is found and read before the stream starts
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('prepare: it runs before hello, what it resolves with is the `prepared` of open(), and the stream is the same as without it', async (t) => {
  const order = [];
  const replays = fakeReplays((rec) => { order.push('open'); rec.request.onEvent(uiEvent('wf_a', 1)); rec.request.onEnd(); }, async ({ runId }) => { order.push(`prepare ${runId}`); return { events: 1 }; });
  const ctx = { ...(await boot(t, { replays })), replays };
  const client = await openSse(ctx.port, { path: replayPath('wf_a', '?speed=2') });
  t.after(() => client.close());
  await client.waitClosed();
  assert.deepEqual(order, ['prepare wf_a', 'open']);
  assert.deepEqual(replays.opened[0].request.prepared, { events: 1 });
  assert.equal(replays.opened[0].request.speed, 2);
  assert.deepEqual(names(client), ['hello', 'event', 'end']);
});

test('prepare that rejects: a JSON answer with the reason and no stream at all (no hello, no open); the status is the error\'s own (404), else 500 (reported to onError); the slot is free', async (t) => {
  const lookup = Object.assign(new Error('no run "wf_a" under "/x" (looked in <root>/<project>/<session>/subagents/workflows/)'), { status: 404 });
  let failWith = lookup;
  const replays = fakeReplays(undefined, async () => { throw failWith; });
  const ctx = { ...(await boot(t, { replays })), replays };
  const res = await getJson(ctx.port, replayPath('wf_a'));
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/json/, 'not an event stream: the page sees a status and a reason, never a hello first');
  assert.deepEqual(res.json, { error: lookup.message });
  assert.equal(replays.opened.length, 0, 'open() was not called');
  assert.deepEqual(ctx.errors, [], 'a lookup that says "not found" is an answer, not a fault');
  assert.deepEqual(ctx.counts, [], 'no stream was counted');

  failWith = new Error('EACCES: permission denied');
  const bad = await getJson(ctx.port, replayPath('wf_a'));
  assert.deepEqual([bad.status, bad.json], [500, { error: 'EACCES: permission denied' }]);
  assert.equal(ctx.errors.length, 1, 'a read that fails is the server\'s to report');
  for (const odd of [Object.assign(new Error('x'), { status: 200 }), Object.assign(new Error('x'), { status: '404' }), Object.assign(new Error('x'), { status: 700 }), new Error('')]) {
    failWith = odd;
    const r = await getJson(ctx.port, replayPath('wf_a'));
    assert.equal(r.status, 500, 'a status that is not an integer 400..599 is not used');
    assert.match(r.json.error, /./, 'the answer always says something');
  }
  for (const nothing of [undefined, null, 'text']) {
    failWith = nothing;
    const r = await getJson(ctx.port, replayPath('wf_a'));
    assert.equal(r.status, 500);
    assert.match(r.json.error, /no reason given/);
  }
  // after all of that three replays can still be opened: no refusal kept a slot
  failWith = null;
  replays.prepare = async () => ({});
  for (let i = 0; i < MAX_REPLAYS; i++) {
    const c = await openSse(ctx.port, { path: replayPath('wf_a') });
    t.after(() => c.close());
    assert.equal(c.status, 200, `replay ${i + 1}`);
  }
});

test('prepare that throws at once (not a promise) is the same answer; a prepare given with a run that is running or unknown is never called', async (t) => {
  const replays = fakeReplays(undefined, () => { throw Object.assign(new Error('sync failure'), { status: 404 }); });
  let called = 0;
  const watch = replays.prepare;
  replays.prepare = (r) => { called += 1; return watch(r); };
  const ctx = { ...(await boot(t, { replays, runs: [finished('wf_a'), makeRun('wf_run', { status: { value: 'running', prov: 'inferred', method: 'm' } })] })), replays };
  assert.deepEqual((await getJson(ctx.port, replayPath('wf_a'))).json, { error: 'sync failure' });
  assert.equal(called, 1);
  assert.equal((await getJson(ctx.port, replayPath('wf_run'))).status, 409);
  assert.equal((await getJson(ctx.port, replayPath('wf_nope'))).status, 404);
  assert.equal((await getJson(ctx.port, replayPath('wf_a', '?speed=abc'))).status, 400);
  assert.equal(called, 1, 'prepare is for a run that may be replayed: nothing else reads files');
});

test('prepare holds a slot while it runs: with three pending the fourth request is a 429, and a pending one that fails frees its slot', async (t) => {
  const pending = [];
  const replays = fakeReplays(undefined, () => { const d = deferred(); pending.push(d); return d.promise; });
  const ctx = { ...(await boot(t, { replays })), replays };
  const clients = [];
  for (let i = 0; i < MAX_REPLAYS; i++) {
    clients.push(openSse(ctx.port, { path: replayPath('wf_a') }).then((c) => { t.after(() => c.close()); return c; }));
  }
  await until(() => pending.length === MAX_REPLAYS, 2000, 'three prepares are pending');
  const fourth = await getJson(ctx.port, replayPath('wf_a'));
  assert.equal(fourth.status, 429, 'the pending ones count');
  assert.equal(pending.length, MAX_REPLAYS, 'and the fourth did not prepare');
  pending[0].reject(Object.assign(new Error('gone'), { status: 404 }));
  pending[1].resolve({});
  pending[2].resolve({});
  const [first, second, third] = await Promise.all(clients);
  assert.deepEqual([first.status, second.status, third.status], [404, 200, 200]);
  assert.equal(replays.opened.length, 2);
  const againP = openSse(ctx.port, { path: replayPath('wf_a') }); // answers once its prepare has
  await until(() => pending.length === MAX_REPLAYS + 1, 2000, 'a prepare is pending for the next one: it was not refused');
  pending[MAX_REPLAYS].resolve({});
  const again = await againP;
  t.after(() => again.close());
  assert.equal(again.status, 200, 'the failed one freed its slot');
});

test('a client that leaves while prepare runs gets nothing and nothing is opened for it; a server that closes meanwhile opens nothing either', async (t) => {
  const pending = [];
  const replays = fakeReplays(undefined, () => { const d = deferred(); pending.push(d); return d.promise; });
  const ctx = { ...(await boot(t, { replays })), replays };
  const gone = new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: ctx.port, path: replayPath('wf_a'), agent: false }, () => {});
    req.on('error', () => resolve());
    req.on('close', () => resolve());
    until(() => pending.length === 1, 2000, 'prepare is pending').then(() => req.destroy());
  });
  await gone;
  await sleep(30);
  pending[0].resolve({});
  await sleep(30);
  assert.equal(replays.opened.length, 0, 'nobody is left to stream to: open() is not called');
  assert.deepEqual(ctx.counts, [], 'no stream was counted');

  const waiting = getJson(ctx.port, replayPath('wf_a')); // pending again
  await until(() => pending.length === 2, 2000, 'a second prepare is pending');
  const closed = closeServer(ctx.server);
  await sleep(20);
  pending[1].resolve({});
  const res = await waiting;
  await closed;
  assert.equal(res.status, 503);
  assert.match(res.json.error, /closing/);
  assert.equal(replays.opened.length, 0);
});

test('the slot of a prepare is held until prepare answers (also for a client that has left) and free after it', async (t) => {
  const pending = [];
  const replays = fakeReplays(undefined, () => { const d = deferred(); pending.push(d); return d.promise; });
  const ctx = { ...(await boot(t, { replays })), replays };
  const requests = [];
  for (let i = 0; i < MAX_REPLAYS; i++) {
    const req = http.get({ host: '127.0.0.1', port: ctx.port, path: replayPath('wf_a'), agent: false }, () => {});
    req.on('error', () => {});
    requests.push(req);
  }
  await until(() => pending.length === MAX_REPLAYS, 2000, 'three prepares are pending');
  for (const req of requests) req.destroy(); // all three clients leave
  await sleep(30);
  assert.equal((await getJson(ctx.port, replayPath('wf_a'))).status, 429, 'the reading is still going on: its slot is not free');
  for (const d of pending) d.resolve({});
  await sleep(30);
  assert.equal(replays.opened.length, 0, 'nobody was left to stream to');
  const next = getJson(ctx.port, replayPath('wf_a'));
  await until(() => pending.length === MAX_REPLAYS + 1, 2000, 'the next request prepares: the slots are free');
  pending[MAX_REPLAYS].reject(Object.assign(new Error('not found'), { status: 404 }));
  assert.equal((await next).status, 404);
});

test('createServer: `replays` without open() is a TypeError', () => {
  assert.throws(() => createServer({ store: createFakeStore(), mode: 'real', replays: {} }), /replays must provide open/);
  assert.doesNotThrow(() => createServer({ store: createFakeStore(), mode: 'real', replays: null }));
  assert.doesNotThrow(() => createServer({ store: createFakeStore(), mode: 'real' }));
});

// ---- part 2: the launcher with the real modules on the saved runs -----------------------------------------------------------------

const FIXTURE_ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const missing = ['src/source/claude-fs.mjs', 'src/source/replay.mjs', 'src/model/reduce.mjs', 'fixtures/claude-projects'].filter((p) => !fs.existsSync(path.join(REPO, p)));
const skip = missing.length ? `not present yet: ${missing.join(', ')}` : false;
const REAL = { WFVIZ_TEST_FAKE: undefined };
const COMPLETED = 'wf_6509ce25-20a'; // 31 events, completed, 5 agents
const FAILED = 'wf_26eb8d70-5c4'; // 35 events, failed

// the listening line comes before the real source has read the runs: wait until the saved runs are in the real store
async function ready(bin, ids = [COMPLETED, FAILED]) {
  const { port } = await bin.ready;
  for (const id of ids) {
    const end = Date.now() + 10_000;
    while ((await getJson(port, `/api/runs/${id}`)).status !== 200) {
      assert.ok(Date.now() < end, `${id} is in the real store`);
      await sleep(50);
    }
  }
  return { port };
}

function startReal(t, args = [], env = {}) {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', FIXTURE_ROOT, '--since', 'Infinity', ...args], { env: { ...REAL, ...env } });
  t.after(() => bin.kill('SIGKILL'));
  return bin;
}

test('real replays: a saved run at speed 100 - hello, events 1..N with no gap, snapshots of source replay, the last one final, end, and the stream closes', { skip }, async (t) => {
  const bin = startReal(t);
  const { port } = await ready(bin);
  for (const [id, total, status] of [[COMPLETED, 31, 'completed'], [FAILED, 35, 'failed']]) {
    const client = await openSse(port, { path: replayPath(id, '?speed=100') });
    t.after(() => client.close());
    assert.equal(client.status, 200);
    await client.waitClosed(20_000);
    const first = client.events[0];
    assert.deepEqual([first.event, first.data.mode, first.data.runId, typeof first.data.version], ['hello', 'replay', id, 'string'], id);
    const events = client.events.filter((e) => e.event === 'event').map((e) => e.data);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: total }, (_, i) => i + 1), `${id}: seq from 1 without gaps`);
    assert.ok(events.every((e) => e.runId === id && typeof e.kind === 'string' && typeof e.message === 'string'), 'the shape of /api/stream');
    const runs = client.events.filter((e) => e.event === 'run').map((e) => e.data);
    assert.ok(runs.length >= 2, 'snapshots came along');
    assert.ok(runs.every((r) => r.source === 'replay' && r.id === id), 'every snapshot is the replayed Run');
    assert.equal(runs.at(-1).status.value, status, 'the last snapshot is the final state');
    const last = client.events.at(-1);
    assert.deepEqual([last.event, last.data], ['end', { runId: id, events: total }]);
    assert.equal(client.events.at(-2).event, 'run', 'the final snapshot comes before end');
    assert.equal(client.ended, true);
    // the order: an event is never written after end
    assert.equal(client.events.slice(0, -1).some((e) => e.event === 'end'), false);
  }
});

// The replay source hands the heads (run.script, run.launched) and the first records of the first agent over in one step. The first
// snapshot is the Run after that step: built after the first event alone it would show the script file time (hours before the run, on
// some runs) as the start, for a whole throttle window, with the status unknown.
const TRANSCRIPT = new Set(['agent.prompt', 'agent.activity', 'agent.structured']);

test('real replays: the first snapshot is the Run after the first step - the start is the earliest agent start (never the script file time), the status running - and the start does not change until the final one', { skip }, async (t) => {
  const { readRunDir } = await import('../../src/source/claude-fs.mjs');
  const { locateRun } = await import('../../src/source/replay.mjs');
  const bin = startReal(t);
  const { port } = await ready(bin);
  for (const [id, total] of [[COMPLETED, 31], [FAILED, 35]]) {
    const where = await locateRun({ target: id, root: FIXTURE_ROOT });
    const read = await readRunDir(where.sessionDir, where.runId);
    const script = read.find((e) => e.kind === 'run.script');
    const firstRecord = Math.min(...read.filter((e) => TRANSCRIPT.has(e.kind)).map((e) => e.ts));
    assert.ok(script && Number.isFinite(firstRecord), `${id}: the saved run has a script and transcript records`);

    const client = await openSse(port, { path: replayPath(id, '?speed=100') });
    t.after(() => client.close());
    await client.waitClosed(20_000);
    const names = client.events.map((e) => e.event);
    assert.equal(names.filter((n) => n === 'event').length, total, id);
    const runs = client.events.filter((e) => e.event === 'run').map((e) => e.data);
    assert.ok(runs.length >= 2, `${id}: a first snapshot and the final one`);

    const first = runs[0];
    assert.deepEqual([first.startedAt.value, first.startedAt.prov, first.startedAt.method], [firstRecord, 'inferred', 'earliest-agent-start'], `${id}: the first snapshot's start is the first agent record, not the script file time ${script.ts}`);
    assert.deepEqual([first.status.value, first.status.prov], ['running', 'inferred'], `${id}: the first snapshot is not the state after the heads alone`);
    assert.ok(first.totals.agents >= 1, `${id}: the first snapshot already has an agent`);
    // the start is the same Fact in every snapshot until the final file is applied, and the final file's from then on
    const finalAt = runs.findIndex((r) => r.startedAt.prov === 'final');
    assert.ok(finalAt > 0 && runs.slice(finalAt).every((r) => r.startedAt.prov === 'final'), `${id}: the start is the final file's from one snapshot on, to the last`);
    for (const run of runs.slice(0, finalAt)) assert.deepEqual(run.startedAt, first.startedAt, `${id}: the start does not change before the final file is applied`);
    assert.equal(runs.some((r) => r.startedAt.method === 'script-file-time'), false, `${id}: no snapshot takes the script file time as the start`);
    assert.ok(names.indexOf('run') > names.indexOf('event'), 'an event frame comes before the first snapshot');
  }
});

test('real replays: the real side is untouched - /api/stream sees no replay frame, the real Run and its events are the same after, and two replays of one run run side by side', { skip }, async (t) => {
  const bin = startReal(t);
  const { port } = await ready(bin);
  const stream = await openSse(port);
  t.after(() => stream.close());
  await stream.waitFor((e) => e.event === 'run' && e.data.id === COMPLETED, 8000);
  await sleep(100);
  const before = stream.events.length;
  const real = (await getJson(port, `/api/runs/${COMPLETED}`)).json;
  const eventsBefore = (await getJson(port, `/api/runs/${COMPLETED}/events`)).json;
  const listBefore = (await getJson(port, '/api/runs')).json;
  assert.equal(real.source, 'real');

  const a = await openSse(port, { path: replayPath(COMPLETED, '?speed=100') });
  const b = await openSse(port, { path: replayPath(COMPLETED, '?speed=100') });
  t.after(() => { a.close(); b.close(); });
  await Promise.all([a.waitClosed(20_000), b.waitClosed(20_000)]);
  for (const c of [a, b]) assert.deepEqual(c.events.at(-1).data, { runId: COMPLETED, events: 31 });
  await sleep(100);
  assert.equal(stream.events.slice(before).some((e) => e.event === 'event' || e.data?.source === 'replay'), false, 'nothing of the replays on the real stream');
  assert.deepEqual((await getJson(port, `/api/runs/${COMPLETED}`)).json, real, 'the real Run is the same');
  assert.deepEqual((await getJson(port, `/api/runs/${COMPLETED}/events`)).json, eventsBefore, 'the real run has gained no event');
  assert.deepEqual((await getJson(port, '/api/runs')).json, listBefore, 'the run list is the same');
});

test('real replays: refusals - bad speed 400, unknown run 404, a run id with a separator 404, no route in --demo or --replay mode', { skip }, async (t) => {
  const bin = startReal(t);
  const { port } = await ready(bin);
  for (const q of ['speed=abc', 'speed=0', 'speed=-1', 'speed=', 'speed=1e999', 'speed=Infinity']) {
    assert.equal((await getJson(port, replayPath(COMPLETED, `?${q}`))).status, 400, q);
  }
  assert.deepEqual((await getJson(port, replayPath('wf_nope'))).json, { error: 'run not found' });
  assert.equal((await getJson(port, replayPath('..%2Fetc'))).status, 404);
  assert.equal((await getJson(port, replayPath('a%5Cb'))).status, 404);

  const demo = startBin(BIN, ['--no-open', '--idle', '0', '--demo'], { env: REAL });
  t.after(() => demo.kill('SIGKILL'));
  const d = await demo.ready;
  assert.deepEqual((await getJson(d.port, replayPath('demo-x'))).json, { error: 'not found' });

  const replay = startBin(BIN, ['--no-open', '--idle', '0', '--replay', COMPLETED, '--root', FIXTURE_ROOT], { env: REAL });
  t.after(() => replay.kill('SIGKILL'));
  await replay.waitForStdout(/\(replay\)/);
  const m = /127\.0\.0\.1:(\d+)/.exec(replay.stdout());
  assert.deepEqual((await getJson(Number(m[1]), replayPath(COMPLETED))).json, { error: 'not found' });

  const fake = startBin(BIN, ['--no-open', '--idle', '0'], {});
  t.after(() => fake.kill('SIGKILL'));
  const f = await fake.ready;
  assert.equal((await getJson(f.port, replayPath('wf_fake-1'))).status, 404, 'the test stand-ins pass no replays');
});

test('real replays: a run that is running is a 409 with the reason', { skip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-replay-409-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const RUN = 'wf_running01-abc';
  const runDir = path.join(root, '-tmp-proj', '11111111-2222-4333-8444-555555555555', 'subagents', 'workflows', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'launched' })}\n${JSON.stringify({ type: 'started', key: 'v2:a1', agentId: 'a1', label: 'worker:one', phase: 'Build' })}\n`);
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', root, '--since', 'Infinity'], { env: REAL });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await bin.ready;
  let run = null;
  const end = Date.now() + 8000;
  while (Date.now() < end && !run) {
    const res = await getJson(port, `/api/runs/${RUN}`);
    if (res.status === 200) run = res.json;
    else await sleep(100);
  }
  assert.equal(run.status.value, 'running');
  const res = await getJson(port, replayPath(RUN));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /running/);
});

// the same copy of the saved runs, with the run directory of COMPLETED gone: workflows/<id>.json is left, so the run is in the real list
function prunedCopy(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-replay-pruned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  const found = fs.readdirSync(root).flatMap((slug) => fs.readdirSync(path.join(root, slug)).map((session) => path.join(root, slug, session, 'subagents', 'workflows', COMPLETED))).filter((d) => fs.existsSync(d));
  assert.equal(found.length, 1);
  fs.rmSync(found[0], { recursive: true, force: true });
  return { root, session: path.dirname(path.dirname(path.dirname(found[0]))) };
}

test('real replays: a run in the list whose run directory is gone is a 404 with the reason before any stream, and the other run still replays', { skip }, async (t) => {
  const { root } = prunedCopy(t);
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', root, '--since', 'Infinity'], { env: REAL });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await ready(bin);
  const run = (await getJson(port, `/api/runs/${COMPLETED}`)).json;
  assert.equal(run.status.value, 'completed', 'the run is in the real list (a final file only)');
  const res = await getJson(port, replayPath(COMPLETED));
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/json/, 'no stream was started: the page gets a status and a reason, never a hello');
  assert.match(res.json.error, /^no run "wf_6509ce25-20a" under /, 'the reason of the lookup');
  const other = await openSse(port, { path: replayPath(FAILED, '?speed=100') });
  t.after(() => other.close());
  await other.waitClosed(20_000);
  assert.deepEqual(other.events.at(-1).data, { runId: FAILED, events: 35 }, 'a run that is there replays as before');
});

// A process directory that is itself <session>/subagents/workflows, holding a hollowed run directory (its journal only) named like a run
// in the list: with a lookup relative to the process directory a replay would play this one, not the run of the root.
function hollowCwd(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-replay-cwd-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'sess', 'subagents', 'workflows');
  fs.mkdirSync(path.join(cwd, COMPLETED), { recursive: true });
  const slug = fs.readdirSync(FIXTURE_ROOT).find((s) => fs.readdirSync(path.join(FIXTURE_ROOT, s)).some((x) => fs.existsSync(path.join(FIXTURE_ROOT, s, x, 'subagents', 'workflows', COMPLETED))));
  const session = fs.readdirSync(path.join(FIXTURE_ROOT, slug)).find((x) => fs.existsSync(path.join(FIXTURE_ROOT, slug, x, 'subagents', 'workflows', COMPLETED)));
  fs.copyFileSync(path.join(FIXTURE_ROOT, slug, session, 'subagents', 'workflows', COMPLETED, 'journal.jsonl'), path.join(cwd, COMPLETED, 'journal.jsonl'));
  return cwd;
}

test('real replays: the run id is looked up under the root only - a run directory of that name under the process directory is never played', { skip }, async (t) => {
  const cwd = hollowCwd(t);
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', FIXTURE_ROOT, '--since', 'Infinity'], { env: REAL, cwd });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await ready(bin);
  const client = await openSse(port, { path: replayPath(COMPLETED, '?speed=100') });
  t.after(() => client.close());
  assert.equal(client.status, 200);
  await client.waitClosed(20_000);
  const events = client.events.filter((e) => e.event === 'event').map((e) => e.data);
  assert.equal(events.length, 31, 'the 31 events of the run under the root, not the few of the hollow copy under the process directory');
  assert.deepEqual(client.events.at(-1).data, { runId: COMPLETED, events: 31 });
  assert.equal(client.events.filter((e) => e.event === 'run').at(-1).data.totals.agents, 5);
});

test('real replays: a run whose directory is gone from the root is a 404 with the reason, even when the process directory has one of that name', { skip }, async (t) => {
  const { root } = prunedCopy(t);
  const cwd = hollowCwd(t);
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', root, '--since', 'Infinity'], { env: REAL, cwd });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await ready(bin);
  const res = await getJson(port, replayPath(COMPLETED));
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /^application\/json/, 'no stream: a status and a reason, never a hello');
  assert.match(res.json.error, /^no run "wf_6509ce25-20a" under /);
});

test('real replays: a run id that is in two places is a 404 with both places in the reason, before any stream', { skip }, async (t) => {
  const { root } = prunedCopy(t);
  // a directory named COMPLETED in two sessions (its content is a copy of FAILED's: only the name matters for the lookup)
  const slug = fs.readdirSync(root)[0];
  const session = fs.readdirSync(path.join(root, slug))[0];
  const workflows = path.join(root, slug, session, 'subagents', 'workflows');
  fs.cpSync(path.join(workflows, FAILED), path.join(workflows, COMPLETED), { recursive: true });
  const second = path.join(root, `${slug}-copy`, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'subagents', 'workflows');
  fs.mkdirSync(second, { recursive: true });
  fs.cpSync(path.join(workflows, COMPLETED), path.join(second, COMPLETED), { recursive: true });
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', root, '--since', 'Infinity'], { env: REAL });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await ready(bin);
  const res = await getJson(port, replayPath(COMPLETED));
  assert.equal(res.status, 404);
  assert.match(res.json.error, /is in more than one place/);
  assert.match(res.json.error, /^run id "wf_[^"]*" is ambiguous under /, 'the run id is ambiguous under the root');
  assert.ok(res.json.error.includes(`${slug}/${session}/subagents/workflows/${COMPLETED}`) && res.json.error.includes(`${slug}-copy/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/subagents/workflows/${COMPLETED}`), `both places are named: ${res.json.error}`);
  assert.doesNotMatch(res.json.error, /pass one of/, 'a run directory is not accepted by the endpoint, so the answer does not ask for one');
  assert.equal(res.json.error.includes('\n'), false, 'one line');
  assert.deepEqual(Object.keys(res.json), ['error'], 'no hello, no other field');
  assert.match(res.headers['content-type'], /^application\/json/);
});

test('real replays: three replays open, the fourth is a 429; a closed one frees its slot', { skip }, async (t) => {
  const bin = startReal(t);
  const { port } = await ready(bin);
  const slow = [];
  for (let i = 0; i < 3; i++) {
    const c = await openSse(port, { path: replayPath(COMPLETED, '?speed=0.25') });
    t.after(() => c.close());
    assert.equal(c.status, 200);
    slow.push(c);
  }
  const fourth = await getJson(port, replayPath(COMPLETED, '?speed=0.25'));
  assert.equal(fourth.status, 429);
  slow[0].close();
  let again = null;
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const res = await openSse(port, { path: replayPath(COMPLETED, '?speed=0.25') });
    if (res.status === 200) { again = res; t.after(() => res.close()); break; }
    res.close();
    await sleep(50);
  }
  assert.ok(again, 'the next one is accepted once the closed one is gone');
});

test('real replays: a replay stream counts as a client for --idle; the process exits after the last stream is gone', { skip }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '1', '--root', FIXTURE_ROOT, '--since', 'Infinity'], { env: REAL });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await ready(bin);
  const stream = await openSse(port);
  await stream.waitFor((e) => e.event === 'hello');
  const replay = await openSse(port, { path: replayPath(COMPLETED, '?speed=0.25') });
  t.after(() => replay.close());
  await replay.waitFor((e) => e.event === 'hello');
  stream.close();
  await sleep(2500);
  assert.equal(bin.hasExited(), false, 'the open replay stream keeps wfviz alive');
  replay.close();
  const { code } = await Promise.race([bin.exited, sleep(5000).then(() => ({ code: 'still running' }))]);
  assert.equal(code, 0, 'about --idle seconds after the last stream is gone it exits');
});
