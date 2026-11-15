// test/server/bin.test.mjs (node N5): bin/wfviz.mjs as a real child process.
//
// Three groups:
//   1. WFVIZ_TEST_FAKE=1: the in-file fake store and source, no other module needed.
//   2. A copy of bin + src/server in a temp tree next to stub source/model modules: proves which modules
//      are loaded in which mode, what the sources and the store are configured with, and the shutdown order
//      (real, demo and replay mode).
//   3. The real modules, only when they exist (skipped otherwise, the skip reason says which is missing).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectionRefused, freePort, getJson, openSse, request, sleep, startBin, test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'wfviz.mjs');
const HELPERS_URL = pathToFileURL(path.join(REPO, 'test', 'server', 'helpers.mjs')).href;

const stopAfter = (t, bin) => t.after(() => bin.kill('SIGKILL'));

async function interrupt(bin, signal = 'SIGINT') {
  bin.kill(signal);
  return bin.exited;
}

// ---- 1. fake mode -----------------------------------------------------------------------------------

test('prints "wfviz listening on http://127.0.0.1:<port> (real)" with a free port (default port 0)', async (t) => {
  const a = startBin(BIN, ['--no-open']);
  const b = startBin(BIN, ['--no-open']);
  stopAfter(t, a);
  stopAfter(t, b);
  const [ra, rb] = await Promise.all([a.ready, b.ready]);
  assert.equal(ra.mode, 'real');
  assert.ok(ra.port > 0 && rb.port > 0 && ra.port !== rb.port);
  assert.match(a.stdout(), new RegExp(`^wfviz listening on http://127\\.0\\.0\\.1:${ra.port} \\(real\\)\\n`));
  const res = await getJson(ra.port, '/api/runs');
  assert.equal(res.status, 200);
});

test('--demo prints (demo), says so in hello, and serves only the demo run', async (t) => {
  const bin = startBin(BIN, ['--demo', '--no-open']);
  stopAfter(t, bin);
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'demo');
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.equal(hello.data.mode, 'demo');
  await sse.waitFor((e) => e.event === 'run', 1500);
  const ids = (await getJson(port, '/api/runs')).json.map((r) => r.id);
  assert.deepEqual(ids, ['demo-fake-1']);
});

// `startBin().ready` only knows (real|demo); a replay prints (replay), so these tests wait for the line themselves.
const LISTENING_REPLAY = /^wfviz listening on http:\/\/127\.0\.0\.1:(\d+) \(replay\)$/m;
async function readyReplay(bin) {
  const m = await bin.waitForStdout(LISTENING_REPLAY);
  return { port: Number(m[1]) };
}

test('--replay (fake mode) prints (replay), says so in hello, and serves only the replay run', async (t) => {
  const bin = startBin(BIN, ['--replay', 'wf_whatever', '--no-open']);
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  assert.match(bin.stdout(), /^wfviz listening on http:\/\/127\.0\.0\.1:\d+ \(replay\)\n$/);
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(hello.data, { mode: 'replay', version: pkg.version });
  await sse.waitFor((e) => e.event === 'run', 1500);
  const runs = (await getJson(port, '/api/runs')).json;
  assert.deepEqual(runs.map((r) => r.id), ['replay-fake-1']);
  assert.equal((await getJson(port, '/api/runs/replay-fake-1')).status, 200);
  assert.equal((await getJson(port, '/api/runs/wf_fake-1')).status, 404);
  assert.equal((await getJson(port, '/api/runs/demo-fake-1')).status, 404);
  assert.equal((await interrupt(bin)).code, 0);
});

test('real mode: hello says real, carries the package version, and only real runs are listed', async (t) => {
  const bin = startBin(BIN, ['--no-open']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(hello.data, { mode: 'real', version: pkg.version });
  await sse.waitFor((e) => e.event === 'run', 1500);
  assert.deepEqual((await getJson(port, '/api/runs')).json.map((r) => r.id), ['wf_fake-1']);
});

test('SSE delivers the run snapshot on connect, later ones at most once a second, and an event per change', async (t) => {
  const bin = startBin(BIN, ['--no-open'], { env: { WFVIZ_TEST_FAKE_TICK_MS: '100' } });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  // The fake source changes the store every 100 ms: the run exists when the client connects.
  const first = await sse.waitFor((e) => e.event === 'run', 1000);
  assert.ok(first.at - hello.at < 1000);
  assert.equal(first.data.id, 'wf_fake-1');
  const next = await sse.waitFor((e) => e.event === 'run' && e.data.events > first.data.events, 3000);
  assert.ok(next.at - first.at >= 900, `the next snapshot came ${next.at - first.at} ms after the first: at most one a second`);
  const ev = await sse.waitFor((e) => e.event === 'event', 1000);
  assert.equal(ev.data.runId, 'wf_fake-1');
  assert.ok(Number.isInteger(ev.data.seq) && ev.data.seq >= 1);
  const seqs = sse.events.filter((e) => e.event === 'event').map((e) => e.data.seq);
  assert.ok(seqs.length >= 5, 'events are not throttled like snapshots: several arrived in the first second');
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'in order, no gaps');
});

test('the backlog endpoint of the launcher: events since a seq, 404 for another mode, 400 for a bad since', async (t) => {
  const bin = startBin(BIN, ['--no-open'], { env: { WFVIZ_TEST_FAKE_TICK_MS: '20' } });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  let all = [];
  const deadline = Date.now() + 5000;
  while (all.length < 6 && Date.now() < deadline) {
    const res = await getJson(port, '/api/runs/wf_fake-1/events');
    all = Array.isArray(res.json) ? res.json : []; // a 404 object until the fake run exists
    await sleep(30);
  }
  assert.ok(all.length >= 6);
  assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1));
  const since = await getJson(port, '/api/runs/wf_fake-1/events?since=3');
  assert.deepEqual(since.json.slice(0, 2).map((e) => e.seq), [4, 5]);
  assert.equal((await getJson(port, '/api/runs/wf_fake-1/events?since=-1')).status, 400);
  assert.equal((await getJson(port, '/api/runs/demo-fake-1/events')).status, 404);
});

test('--port <n> binds exactly that port; a busy port is a clean exit 1', async (t) => {
  const port = await freePort();
  const bin = startBin(BIN, ['--no-open', '--port', String(port)]);
  stopAfter(t, bin);
  assert.equal((await bin.ready).port, port);
  assert.equal((await getJson(port, '/api/runs')).status, 200);

  const second = startBin(BIN, ['--no-open', '--port', String(port)]);
  stopAfter(t, second);
  const { code } = await second.exited;
  assert.equal(code, 1);
  assert.match(second.stderr(), /already in use/);
  assert.doesNotMatch(second.stdout(), /listening/);
  assert.equal((await getJson(port, '/api/runs')).status, 200, 'the first instance is untouched');
});

test('SIGINT with an SSE client connected: exit code 0, client stream ended, port free afterwards', async (t) => {
  const bin = startBin(BIN, ['--no-open']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'hello');

  const started = Date.now();
  const { code, signal } = await interrupt(bin, 'SIGINT');
  assert.equal(signal, null, 'exited by itself, was not killed by the signal');
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 2500, 'prompt shutdown');
  await sse.waitClosed(500);
  assert.ok(sse.ended, 'SSE stream was closed by the server');
  assert.equal(await connectionRefused(port), true, 'port is free');
});

test('SIGTERM: exit code 0 and the port is free', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--demo']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const { code, signal } = await interrupt(bin, 'SIGTERM');
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.equal(await connectionRefused(port), true);
});

test('SIGINT before any client ever connected also exits 0', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '5']);
  stopAfter(t, bin);
  await bin.ready;
  const { code } = await interrupt(bin);
  assert.equal(code, 0);
});

test('a second signal while the first shutdown is still closing neither ends it early nor changes the exit code', async (t) => {
  const bin = startBin(BIN, ['--no-open']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  // A request that never gets its blank line keeps server.close() waiting, so the shutdown stays in progress.
  const stuck = net.connect({ host: '127.0.0.1', port });
  stuck.on('error', () => {});
  t.after(() => stuck.destroy());
  await new Promise((resolve) => stuck.once('connect', resolve));
  stuck.write('GET /api/runs HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  await sleep(100);

  bin.kill('SIGINT');
  await bin.waitForStderr(/SIGINT, shutting down/);
  await sleep(300);
  assert.equal(bin.hasExited(), false, 'the open request holds the shutdown');
  bin.kill('SIGTERM');
  await sleep(150);
  assert.equal(bin.hasExited(), false, 'the second signal does not abort the graceful close');

  const { code, signal } = await bin.exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.equal(await connectionRefused(port), true, 'port is free');
});

test('SIGINT followed by SIGTERM in quick succession exits 0 whatever the gap, never by the signal', async (t) => {
  for (const gapMs of [0, 1, 2, 5]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const bin = startBin(BIN, ['--no-open']);
      stopAfter(t, bin);
      const { port } = await bin.ready;
      const sse = await openSse(port);
      await sse.waitFor((e) => e.event === 'hello');

      bin.kill('SIGINT');
      if (gapMs > 0) await sleep(gapMs);
      bin.kill('SIGTERM');
      const { code, signal } = await bin.exited;
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, `gap ${gapMs} ms, attempt ${attempt}`);
      assert.equal(await connectionRefused(port), true, `port is free, gap ${gapMs} ms, attempt ${attempt}`);
    }
  }
});

test('idle: exits 0 after --idle seconds without SSE clients, once one has connected', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '1']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'hello');
  await sleep(1300);
  assert.equal(bin.hasExited(), false, 'a connected client keeps it alive past the idle time');

  const left = Date.now();
  sse.close();
  const { code, signal } = await bin.exited;
  const waited = Date.now() - left;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.ok(waited >= 900, `exited ${waited} ms after the last client left, expected about 1000`);
  assert.ok(waited < 3500, `exited ${waited} ms after the last client left`);
  assert.match(bin.stderr(), /no client for 1 s/);
  assert.equal(await connectionRefused(port), true);
});

test('idle: no exit while no client has ever connected', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0.5']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await sleep(1500);
  assert.equal(bin.hasExited(), false);
  assert.equal((await getJson(port, '/api/runs')).status, 200);
});

test('idle: a client that comes back before the timer fires cancels it', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '1']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const first = await openSse(port);
  await first.waitFor((e) => e.event === 'hello');
  first.close();
  await first.waitClosed();
  await sleep(400);
  const second = await openSse(port);
  t.after(() => second.close());
  await second.waitFor((e) => e.event === 'hello');
  await sleep(1400);
  assert.equal(bin.hasExited(), false, 'timer was cancelled by the reconnect');
  second.close();
  const { code } = await bin.exited;
  assert.equal(code, 0);
});

test('idle: --idle 0 never exits', async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'hello');
  sse.close();
  await sse.waitClosed();
  await sleep(1500);
  assert.equal(bin.hasExited(), false);
});

test('open: WFVIZ_OPEN_CMD is called with the URL; --no-open skips it', async (t) => {
  const opened = startBin(BIN, [], { env: { WFVIZ_OPEN_CMD: 'echo' } });
  stopAfter(t, opened);
  const { port } = await opened.ready;
  const url = `http://127.0.0.1:${port}`;
  await opened.waitForStdout(new RegExp(`^${url.replaceAll('.', '\\.')}$`, 'm'), 3000); // echo's own line

  const skipped = startBin(BIN, ['--no-open'], { env: { WFVIZ_OPEN_CMD: 'echo' } });
  stopAfter(t, skipped);
  const sPort = (await skipped.ready).port;
  await sleep(700); // the opener runs within a few ms of the listening line when it runs at all
  assert.equal(skipped.stdout().trim(), `wfviz listening on http://127.0.0.1:${sPort} (real)`, 'only the listening line');
  assert.doesNotMatch(skipped.stderr(), /could not run|browser/);
});

test('open: a missing opener program is a warning, not a crash', async (t) => {
  const bin = startBin(BIN, [], { env: { WFVIZ_OPEN_CMD: '/nonexistent/wfviz-opener' } });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/could not run \/nonexistent\/wfviz-opener/);
  assert.match(bin.stderr(), /open http:\/\/127\.0\.0\.1:\d+ in a browser yourself/);
  assert.equal(bin.hasExited(), false);
  assert.equal((await getJson(port, '/api/runs')).status, 200);
});

test('usage errors: exit code 2, message on stderr, nothing on stdout, no server', async (t) => {
  for (const args of [['--port', 'abc'], ['--port', '70000'], ['--bogus'], ['--idle', '-5'], ['--since', '0'], ['extra'],
    ['--replay', 'wf_x', '--demo'], ['--demo', '--replay', 'wf_x'], ['--replay'], ['--replay', ''], ['--speed', '4'],
    ['--replay', 'wf_x', '--speed', '0'], ['--replay', 'wf_x', '--speed', 'abc'], ['--replay', 'wf_x', '--speed', 'Infinity']]) {
    const bin = startBin(BIN, args);
    stopAfter(t, bin);
    const { code } = await bin.exited;
    assert.equal(code, 2, args.join(' '));
    assert.match(bin.stderr(), /^wfviz: .+\n[\s\S]*Usage: wfviz/, args.join(' '));
    assert.equal(bin.stdout(), '');
  }
});

test('--help prints usage on stdout and exits 0, and lists --replay and --speed', async (t) => {
  const bin = startBin(BIN, ['--help']);
  stopAfter(t, bin);
  const { code } = await bin.exited;
  assert.equal(code, 0);
  assert.match(bin.stdout(), /^Usage: wfviz/);
  assert.match(bin.stdout(), /^ {2}--replay <run> /m);
  assert.match(bin.stdout(), /^ {2}--speed <n> /m);
  assert.equal(bin.stderr(), '');
});

test('bin/wfviz.mjs is executable and runs directly through its shebang', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows has no executable bit');
  assert.equal(fs.readFileSync(BIN, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  assert.ok(fs.statSync(BIN).mode & 0o100, 'the owner may execute it');
  // `env node` needs node on PATH; the test runner's own node is put first so the check does not depend on it.
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  const { error, stdout } = await new Promise((resolve) => {
    execFile(BIN, ['--help'], { env, timeout: 10_000 }, (err, out) => resolve({ error: err, stdout: out }));
  });
  assert.equal(error, null, `running ${BIN} directly: ${error && error.message}`);
  assert.match(stdout, /^Usage: wfviz/);
});

test('the server only listens on loopback: a request with a foreign Host is refused', async (t) => {
  const bin = startBin(BIN, ['--no-open']);
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const res = await getJson(port, '/api/runs', { host: 'evil.example.com' });
  assert.equal(res.status, 403);
  // and nothing answers on another interface address of this machine
  const external = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4');
  if (external) {
    const reachable = await new Promise((resolve) => {
      const s = net.connect({ host: external.address, port });
      s.once('connect', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
    assert.equal(reachable, false, `must not accept connections on ${external.address}`);
  }
});

// ---- 2. stub module tree ----------------------------------------------------------------------------

function makeStubTree(t, { omit = [], modelDelayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'src/server', 'src/model', 'src/source', 'web', 'projects']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.copyFileSync(BIN, path.join(root, 'bin', 'wfviz.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'stub', version: '7.7.7' }));
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<title>stub</title>');
  for (const f of fs.readdirSync(path.join(REPO, 'src', 'server'))) {
    fs.copyFileSync(path.join(REPO, 'src', 'server', f), path.join(root, 'src', 'server', f));
  }
  const log = path.join(root, 'stub.log');
  const files = {
    reduce: [
      'src/model/reduce.mjs',
      `import fs from 'node:fs';
import { createFakeStore, makeRun } from ${JSON.stringify(HELPERS_URL)};
await new Promise((resolve) => setTimeout(resolve, ${Number(modelDelayMs)}));
// The fake store tags a run real or demo; a replayed run is tagged like the real model does.
export function createStore(opts) {
  fs.appendFileSync(process.env.STUB_LOG, 'store opts ' + JSON.stringify({ keys: Object.keys(opts ?? {}), staleMs: String(opts?.staleMs) }) + '\\n');
  const store = createFakeStore();
  const apply = store.apply;
  store.apply = (event) => {
    if (event.src === 'replay' && !store.runs.has(event.runId)) store.runs.set(event.runId, makeRun(event.runId, { source: 'replay' })); // before the first change is announced
    const id = apply(event);
    if (event.src === 'replay') store.runs.get(id).source = 'replay';
    if (event.src === 'claude-fs' && process.env.STUB_DONE) store.runs.get(id).status = { value: 'completed', prov: 'final', from: 'stub:1' };
    return id;
  };
  if (opts?.staleMs === Infinity) { // the store of a replay: every Run it builds is on the log (the replay must not build one per event)
    const getRun = store.getRun;
    store.getRun = (id) => { fs.appendFileSync(process.env.STUB_LOG, 'replay getRun\\n'); return getRun(id); };
  }
  return store;
}
`,
    ],
    'claude-fs': [
      'src/source/claude-fs.mjs',
      `import fs from 'node:fs';
const log = (s) => fs.appendFileSync(process.env.STUB_LOG, s + '\\n');
log('import claude-fs');
export function createClaudeFsSource(opts) {
  log('claude-fs opts ' + JSON.stringify({ root: String(opts.root), sinceMs: String(opts.sinceMs), keys: Object.keys(opts).sort() }));
  return {
    async start() {
      log('claude-fs start');
      if (process.env.STUB_FAIL_START) throw new Error('scan failed');
      const base = { sessionId: null, project: null, ts: 1, prov: { file: '(stub)', line: null }, data: {} };
      opts.onEvent({ ...base, src: 'claude-fs', kind: 'run.launched', runId: 'wf_stub-1' });
      opts.onEvent({ ...base, src: 'demo', kind: 'run.launched', runId: 'demo-leak' });
    },
    stop() { log('claude-fs stop'); },
    async rescan() {},
    isLoaded() { return true; },
    async loadRun() {},
  };
}
export async function readRunDir(sessionDir, runId) {
  log('readRunDir ' + JSON.stringify({ sessionDir, runId }));
  const base = { sessionId: null, project: null, prov: { file: '(stub)', line: null }, data: {}, src: 'claude-fs', runId };
  return Array.from({ length: Number(process.env.STUB_EVENTS) || 2 }, (_, i) => ({ ...base, ts: i + 1, kind: i === 0 ? 'run.launched' : 'agent.started' }));
}
`,
    ],
    demo: [
      'src/source/demo.mjs',
      `import fs from 'node:fs';
const log = (s) => fs.appendFileSync(process.env.STUB_LOG, s + '\\n');
log('import demo');
export function createDemoSource(opts) {
  log('demo opts ' + JSON.stringify(Object.keys(opts).sort()));
  return {
    async start() {
      log('demo start');
      const base = { sessionId: null, project: null, ts: 1, prov: { file: '(stub)', line: null }, data: {} };
      opts.onEvent({ ...base, src: 'demo', kind: 'run.launched', runId: 'demo-stub-1' });
      opts.onEvent({ ...base, src: 'claude-fs', kind: 'run.launched', runId: 'wf_leak' });
    },
    stop() { log('demo stop'); },
  };
}
`,
    ],
    replay: [
      'src/source/replay.mjs',
      `import fs from 'node:fs';
const log = (s) => fs.appendFileSync(process.env.STUB_LOG, s + '\\n');
log('import replay');
export async function locateRun(opts) {
  log('locate ' + JSON.stringify({ target: opts.target, root: String(opts.root), keys: Object.keys(opts).sort(), idOnly: opts.idOnly }));
  if (opts.target === 'wf_missing' || process.env.STUB_LOCATE_FAIL) {
    const err = new Error('no run "wf_missing" under ' + JSON.stringify(String(opts.root)));
    err.name = 'ReplayLookupError';
    throw err;
  }
  return { runDir: '/stub/' + opts.target, sessionDir: '/stub', runId: opts.target, via: process.env.STUB_VIA ?? 'runId' };
}
export function createReplaySource(opts) {
  log('replay opts ' + JSON.stringify({ keys: Object.keys(opts).sort(), runDir: opts.runDir, speed: String(opts.speed) }));
  return {
    async start() {
      log('replay start');
      if (process.env.STUB_FAIL_START) throw new Error('read failed');
      if (opts.readRun) { // the replay of a finished run inside the real server: read it with readRun, emit it again as src replay
        const events = await opts.readRun('/stub/session', opts.runDir.split('/').pop());
        log('replay read ' + events.length);
        opts.onEvent({ ...events[0], src: 'claude-fs' }); // a leak: it must not reach the replay store
        // like the real source: the first event is a step of its own, the others come after a wait (STUB_ONE_STEP: all of them in one step)
        opts.onEvent({ ...events[0], src: 'replay' });
        if (!process.env.STUB_ONE_STEP) await new Promise((resolve) => setTimeout(resolve, 20));
        for (const e of events.slice(1)) opts.onEvent({ ...e, src: 'replay' });
        return;
      }
      const base = { sessionId: null, project: null, ts: 1, prov: { file: '(stub)', line: null }, data: {} };
      opts.onEvent({ ...base, src: 'replay', kind: 'run.launched', runId: 'wf_stub-replay-1' });
      opts.onEvent({ ...base, src: 'claude-fs', kind: 'run.launched', runId: 'wf_leak-fs' });
      opts.onEvent({ ...base, src: 'demo', kind: 'run.launched', runId: 'demo-leak' });
      if (process.env.STUB_STEP_AGAIN) { // a second step, after a wait: the change of the first one has been told by then
        await new Promise((resolve) => setTimeout(resolve, 30));
        opts.onEvent({ ...base, ts: 2, src: 'replay', kind: 'agent.started', runId: 'wf_stub-replay-1' });
      }
    },
    stop() { log('replay stop'); },
  };
}
`,
    ],
  };
  for (const [name, [rel, text]] of Object.entries(files)) {
    if (!omit.includes(name)) fs.writeFileSync(path.join(root, rel), text);
  }
  return {
    root,
    bin: path.join(root, 'bin', 'wfviz.mjs'),
    env: { WFVIZ_TEST_FAKE: undefined, STUB_LOG: log },
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

const runIds = async (port) => (await getJson(port, '/api/runs')).json.map((r) => r.id).sort();

// A change in the copy of src/server/server.mjs of a stub tree: `from` must be in it (a patch that did not apply is no test).
function patchServer(tree, from, to) {
  const file = path.join(tree.root, 'src', 'server', 'server.mjs');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `server.mjs has ${JSON.stringify(from)}`);
  fs.writeFileSync(file, text.replace(from, () => to));
}
const listenerLines = (bin) => bin.stderr().split('\n').filter((l) => /a change listener failed/.test(l));

test('stub tree, real mode: loads claude-fs, never the demo module; only claude-fs events reach the store', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open'], { env: tree.env });
  stopAfter(t, bin);
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'real');
  await bin.waitForStderr(/dropped event with src=demo/);
  assert.deepEqual(await runIds(port), ['wf_stub-1'], 'the demo event was dropped');
  assert.equal((await getJson(port, '/api/runs/demo-leak')).status, 404);

  const log = tree.log();
  assert.match(log, /^import claude-fs$/m);
  assert.doesNotMatch(log, /demo/, 'the demo module was not even loaded');
  assert.doesNotMatch(log, /replay/, 'the replay module was not loaded either');
  assert.deepEqual(JSON.parse(log.match(/^claude-fs opts (.*)$/m)[1]), { root: 'undefined', sinceMs: 'undefined', keys: ['onEvent'] },
    'without flags the source gets only onEvent: its own defaults apply');

  const sse = await openSse(port);
  t.after(() => sse.close());
  assert.equal((await sse.waitFor((e) => e.event === 'hello')).data.version, '7.7.7', 'version comes from package.json next to bin/');
  assert.equal((await request(port, { path: '/' })).status, 200, 'web/ next to bin/ is served');

  const { code } = await interrupt(bin);
  assert.equal(code, 0);
  assert.match(tree.log(), /^claude-fs stop$/m, 'source.stop() is called on shutdown');
});

test('stub tree, real mode: --root and --since reach createClaudeFsSource (root absolute, hours as ms)', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--root', 'projects', '--since', '2'], { env: tree.env, cwd: tree.root });
  stopAfter(t, bin);
  await bin.ready;
  await bin.waitForStderr(/dropped event/);
  const opts = JSON.parse(tree.log().match(/^claude-fs opts (.*)$/m)[1]);
  assert.equal(opts.root, path.join(fs.realpathSync(tree.root), 'projects'));
  assert.equal(opts.sinceMs, '7200000');
  assert.deepEqual(opts.keys, ['onEvent', 'root', 'sinceMs']);
  assert.equal(bin.stderr().includes('does not exist'), false);

  const inf = startBin(tree.bin, ['--no-open', '--since', 'Infinity'], { env: tree.env });
  stopAfter(t, inf);
  await inf.ready;
  await inf.waitForStderr(/dropped event/);
  assert.match(tree.log(), /"sinceMs":"Infinity"/);
});

test('stub tree, real mode: a --root that does not exist is warned about, not fatal', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--root', path.join(tree.root, 'nope')], { env: tree.env });
  stopAfter(t, bin);
  await bin.ready;
  await bin.waitForStderr(/--root .*nope does not exist/);
  assert.equal(bin.hasExited(), false);
});

test('stub tree, --demo: loads the demo module, never claude-fs; only demo events reach the store', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--demo'], { env: tree.env });
  stopAfter(t, bin);
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'demo');
  await bin.waitForStderr(/dropped event with src=claude-fs/);
  assert.deepEqual(await runIds(port), ['demo-stub-1']);

  const log = tree.log();
  assert.match(log, /^import demo$/m);
  assert.doesNotMatch(log, /claude-fs/, 'the claude-fs module was not even loaded');
  assert.doesNotMatch(log, /replay/, 'the replay module was not loaded either');
  assert.deepEqual(JSON.parse(log.match(/^demo opts (.*)$/m)[1]), ['onEvent']);

  const { code } = await interrupt(bin);
  assert.equal(code, 0);
  assert.match(tree.log(), /^demo stop$/m);
});

test('stub tree, --demo with --root/--since: they are ignored, with a warning', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--demo', '--root', tree.root, '--since', '3'], { env: tree.env });
  stopAfter(t, bin);
  await bin.ready;
  await bin.waitForStderr(/--root and --since are ignored with --demo/);
  assert.doesNotMatch(tree.log(), /claude-fs/);
});

test('stub tree: real mode works without the demo module, and --demo works without the claude-fs module', async (t) => {
  const noDemo = makeStubTree(t, { omit: ['demo'] });
  const real = startBin(noDemo.bin, ['--no-open'], { env: noDemo.env });
  stopAfter(t, real);
  const { port } = await real.ready;
  await real.waitForStderr(/dropped event/);
  assert.deepEqual(await runIds(port), ['wf_stub-1']);

  const noFs = makeStubTree(t, { omit: ['claude-fs'] });
  const demo = startBin(noFs.bin, ['--no-open', '--demo'], { env: noFs.env });
  stopAfter(t, demo);
  const dPort = (await demo.ready).port;
  await demo.waitForStderr(/dropped event/);
  assert.deepEqual(await runIds(dPort), ['demo-stub-1']);
});

test('stub tree, --replay: loads the replay module, never claude-fs or demo; only replay events reach the store', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc'], { env: tree.env });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const sse = await openSse(port); // the first page connecting starts the replay
  t.after(() => sse.close());
  assert.deepEqual((await sse.waitFor((e) => e.event === 'hello')).data, { mode: 'replay', version: '7.7.7' });
  await bin.waitForStderr(/dropped event with src=demo/);
  await bin.waitForStderr(/dropped event with src=claude-fs \(only "replay" is accepted in replay mode\)/);
  assert.deepEqual(await runIds(port), ['wf_stub-replay-1'], 'the claude-fs and demo events were dropped');
  assert.equal((await getJson(port, '/api/runs/wf_leak-fs')).status, 404);
  assert.equal((await getJson(port, '/api/runs/demo-leak')).status, 404);
  assert.equal((await getJson(port, '/api/runs/wf_stub-replay-1')).json.source, 'replay');

  const log = tree.log();
  assert.match(log, /^import replay$/m);
  assert.doesNotMatch(log, /claude-fs|demo/, 'neither the real nor the demo module was loaded');
  assert.deepEqual(JSON.parse(log.match(/^replay opts (.*)$/m)[1]), { keys: ['onEvent', 'runDir', 'speed'], runDir: '/stub/wf_abc', speed: 'undefined' },
    'without --speed the source gets no speed value: its own default applies');
  assert.deepEqual(JSON.parse(log.match(/^locate (.*)$/m)[1]), { target: 'wf_abc', root: 'undefined', keys: ['root', 'target'] }, 'without --root the module looks in its own default root');


  const { code } = await interrupt(bin);
  assert.equal(code, 0);
  assert.match(tree.log(), /^replay stop$/m, 'source.stop() is called on shutdown');
});

test('stub tree: the store never marks a run stale in replay mode, and only there (one import of the model)', async (t) => {
  const storeOpts = (tree) => JSON.parse(tree.log().match(/^store opts (.*)$/m)[1]);
  const cases = [
    [['--replay', 'wf_abc'], { keys: ['staleMs'], staleMs: 'Infinity' }, 'replay'],
    [['--demo'], { keys: [], staleMs: 'undefined' }, 'demo'],
    [[], { keys: [], staleMs: 'undefined' }, 'real'],
  ];
  for (const [args, expected, mode] of cases) {
    const tree = makeStubTree(t);
    const bin = startBin(tree.bin, ['--no-open', ...args], { env: tree.env });
    stopAfter(t, bin);
    if (mode === 'replay') await readyReplay(bin);
    else await bin.ready;
    assert.deepEqual(storeOpts(tree), expected, mode);
    assert.equal((tree.log().match(/^store opts /gm) ?? []).length, 1, `${mode}: the model is loaded and the store made once`);
    await interrupt(bin);
  }
});

test('stub tree, --replay: --speed and --root reach the source and the lookup (root absolute, speed a number)', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc', '--speed', '8', '--root', 'projects'], { env: tree.env, cwd: tree.root });
  stopAfter(t, bin);
  await readyReplay(bin);
  const log = tree.log();
  assert.deepEqual(JSON.parse(log.match(/^replay opts (.*)$/m)[1]).speed, '8');
  const located = JSON.parse(log.match(/^locate (.*)$/m)[1]);
  assert.equal(located.root, path.join(fs.realpathSync(tree.root), 'projects'));
  assert.equal(located.target, 'wf_abc');
  assert.equal(bin.stderr().includes('does not exist'), false, 'a missing --root is the lookup\'s business in replay mode, not a launcher warning');
});

test('stub tree, --replay: --since is ignored with a warning; --root is ignored, with a warning, when the argument is a run directory', async (t) => {
  const tree = makeStubTree(t);
  const since = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc', '--since', '3'], { env: tree.env });
  stopAfter(t, since);
  await readyReplay(since);
  await since.waitForStderr(/--since is ignored with --replay/);
  assert.doesNotMatch(since.stderr(), /--root is ignored/);

  const dir = startBin(tree.bin, ['--no-open', '--replay', '/some/dir/wf_abc', '--root', tree.root], { env: { ...tree.env, STUB_VIA: 'directory' } });
  stopAfter(t, dir);
  await readyReplay(dir);
  await dir.waitForStderr(/--root is ignored: --replay names a run directory/);

  const id = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc', '--root', tree.root], { env: tree.env });
  stopAfter(t, id);
  await readyReplay(id);
  await sleep(300);
  assert.doesNotMatch(id.stderr(), /--root is ignored/, 'a run id is looked up under --root: nothing to warn about');
});

test('stub tree, --replay: a run that cannot be found is exit 2, one wfviz: line, empty stdout, and no source is created', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--replay', 'wf_missing', '--root', 'projects'], { env: tree.env, cwd: tree.root });
  stopAfter(t, bin);
  const { code, signal } = await bin.exited;
  assert.deepEqual({ code, signal }, { code: 2, signal: null });
  assert.equal(bin.stdout(), '', 'nothing on stdout');
  assert.match(bin.stderr(), /^wfviz: no run "wf_missing" under ".*projects"\n$/, 'exactly one line');
  assert.doesNotMatch(tree.log(), /replay opts|replay start/, 'the source was never made');
});

test('stub tree, --replay: nothing starts until the first page connects; one page starts it once, later pages and reconnects do not restart it', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--replay', 'wf_abc'], { env: tree.env });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const starts = () => (tree.log().match(/^replay start$/gm) ?? []).length;
  await sleep(400);
  assert.equal(starts(), 0, 'wfviz is up but no page has connected: the replay has not started');
  assert.deepEqual(await runIds(port), [], 'plain requests do not start it, and nothing is served yet');
  assert.equal((await getJson(port, '/api/runs/wf_stub-replay-1')).status, 404);
  assert.equal(starts(), 0);
  assert.match(bin.stderr(), /^wfviz: replay starts when the first page connects: open http:\/\/127\.0\.0\.1:\d+\n$/, 'one hint, so that --no-open is not a silent wait');

  const first = await openSse(port);
  t.after(() => first.close());
  await first.waitFor((e) => e.event === 'hello');
  // (the stub store tags the run after its first event, so the stream may not carry it: poll the list)
  for (let i = 0; i < 40 && (await runIds(port)).length === 0; i++) await sleep(50);
  assert.deepEqual(await runIds(port), ['wf_stub-replay-1'], 'the first page started the replay');
  assert.equal(starts(), 1);

  const second = await openSse(port);
  t.after(() => second.close());
  await second.waitFor((e) => e.event === 'hello');
  first.close();
  second.close();
  await first.waitClosed();
  await second.waitClosed();
  const again = await openSse(port); // every page left, a new one comes: the run stays as it is, it is not started again
  t.after(() => again.close());
  await again.waitFor((e) => e.event === 'run' && e.data.id === 'wf_stub-replay-1', 2000);
  await sleep(300);
  assert.equal(starts(), 1, 'one start for the whole life of the process');
  assert.deepEqual(await runIds(port), ['wf_stub-replay-1']);
  assert.equal((await interrupt(bin)).code, 0);
  assert.equal((tree.log().match(/^replay stop$/gm) ?? []).length, 1, 'stopped once, on shutdown');
});

test('stub tree, --replay: source.start() failing is exit 1, the source is stopped and the port freed', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc'], { env: { ...tree.env, STUB_FAIL_START: '1' } });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const sse = await openSse(port); // the source is started by the first page, and fails then
  t.after(() => sse.close());
  const { code } = await bin.exited;
  assert.equal(code, 1);
  assert.match(bin.stderr(), /read failed/);
  assert.match(tree.log(), /^replay stop$/m);
  assert.equal(await connectionRefused(port), true);
});

test('stub tree: a missing replay module is a clear exit 1 only under --replay; the other modes do not need it', async (t) => {
  const tree = makeStubTree(t, { omit: ['replay'] });
  const replay = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc'], { env: tree.env });
  stopAfter(t, replay);
  assert.equal((await replay.exited).code, 1);
  assert.match(replay.stderr(), /cannot load src\/source\/replay\.mjs/);
  assert.equal(replay.stdout(), '');

  const real = startBin(tree.bin, ['--no-open'], { env: tree.env });
  stopAfter(t, real);
  const { port } = await real.ready;
  await real.waitForStderr(/dropped event/);
  assert.deepEqual(await runIds(port), ['wf_stub-1']);
  const demo = startBin(tree.bin, ['--no-open', '--demo'], { env: tree.env });
  stopAfter(t, demo);
  await demo.ready;
});

test('stub tree: a missing module is a clear exit 1 before anything listens', async (t) => {
  const noFs = makeStubTree(t, { omit: ['claude-fs'] });
  const real = startBin(noFs.bin, ['--no-open'], { env: noFs.env });
  stopAfter(t, real);
  assert.equal((await real.exited).code, 1);
  assert.match(real.stderr(), /cannot load src\/source\/claude-fs\.mjs/);
  assert.equal(real.stdout(), '');

  const noDemo = makeStubTree(t, { omit: ['demo'] });
  const demo = startBin(noDemo.bin, ['--no-open', '--demo'], { env: noDemo.env });
  stopAfter(t, demo);
  assert.equal((await demo.exited).code, 1);
  assert.match(demo.stderr(), /cannot load src\/source\/demo\.mjs/);

  const noModel = makeStubTree(t, { omit: ['reduce'] });
  const model = startBin(noModel.bin, ['--no-open'], { env: noModel.env });
  stopAfter(t, model);
  assert.equal((await model.exited).code, 1);
  assert.match(model.stderr(), /cannot load src\/model\/reduce\.mjs/);
});

test('stub tree: a signal while the modules are still loading exits 0 and never starts a server or a source', async (t) => {
  const tree = makeStubTree(t, { modelDelayMs: 1500 });
  const bin = startBin(tree.bin, ['--no-open'], { env: tree.env });
  stopAfter(t, bin);
  await sleep(300);
  assert.equal(bin.stdout(), '', 'still loading, nothing listening yet');
  bin.kill('SIGINT');
  const { code, signal } = await bin.exited;
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.equal(bin.stdout(), '', 'no listening line after the signal');
  assert.doesNotMatch(tree.log(), /claude-fs start/);
});

test('stub tree: source.start() failing is exit 1, the source is stopped and the port freed', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open'], { env: { ...tree.env, STUB_FAIL_START: '1' } });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  const { code } = await bin.exited;
  assert.equal(code, 1);
  assert.match(bin.stderr(), /scan failed/);
  assert.match(tree.log(), /^claude-fs stop$/m);
  assert.equal(await connectionRefused(port), true);
});

test('stub tree, real mode: a replay request loads the replay module then (not at start) and builds its own source and store; the real store and its events stay as they were', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--root', 'projects'], { env: { ...tree.env, STUB_DONE: '1' }, cwd: tree.root });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/dropped event with src=demo/); // the real source has started: wf_stub-1 is in the real store
  assert.doesNotMatch(tree.log(), /replay/, 'the replay module is not loaded at start');
  const realRun = (await getJson(port, '/api/runs/wf_stub-1')).json;
  const realEvents = (await getJson(port, '/api/runs/wf_stub-1/events')).json;
  assert.deepEqual([realRun.source, realRun.status.value, realEvents.length], ['real', 'completed', 1]);

  for (let n = 1; n <= 2; n++) {
    const sse = await openSse(port, { path: '/api/runs/wf_stub-1/replay?speed=20' });
    t.after(() => sse.close());
    assert.equal(sse.status, 200);
    await sse.waitClosed(5000);
    assert.deepEqual(sse.events.map((e) => e.event), ['hello', 'event', 'run', 'event', 'run', 'end'], 'the first snapshot at once, the second held to the end');
    assert.deepEqual(sse.events[0].data, { mode: 'replay', version: '7.7.7', runId: 'wf_stub-1' });
    assert.deepEqual(sse.events.filter((e) => e.event === 'event').map((e) => e.data.seq), [1, 2], 'only the replay\'s own events, from 1');
    assert.ok(sse.events.filter((e) => e.event === 'run').every((e) => e.data.source === 'replay'));
    assert.deepEqual(sse.events.at(-1).data, { runId: 'wf_stub-1', events: 2 });
  }
  const log = tree.log();
  assert.equal((log.match(/^import replay$/gm) ?? []).length, 1, 'the module is imported once');
  const root = path.join(fs.realpathSync(tree.root), 'projects');
  assert.deepEqual(JSON.parse(log.match(/^locate (.*)$/m)[1]), { target: 'wf_stub-1', root, keys: ['idOnly', 'root', 'target'], idOnly: true },
    'the lookup uses the real source\'s root and only ever means a run id (idOnly), never a path relative to the process directory');
  assert.deepEqual(JSON.parse(log.match(/^replay opts (.*)$/m)[1]), { keys: ['onEvent', 'readRun', 'runDir', 'speed'], runDir: '/stub/wf_stub-1', speed: '20' });
  assert.deepEqual([...log.matchAll(/^store opts (.*)$/gm)].map((m) => JSON.parse(m[1]).staleMs), ['undefined', 'Infinity', 'Infinity'], 'the real store, then one store per replay, none of them marks a run stale');
  assert.equal((log.match(/^readRunDir /gm) ?? []).length, 2);
  assert.equal((log.match(/^replay stop$/gm) ?? []).length, 2, 'every replay is stopped once it ends');
  await bin.waitForStderr(/replay of wf_stub-1: dropped event with src=claude-fs/);
  assert.equal((bin.stderr().match(/replay of wf_stub-1: dropped event with src=claude-fs/g) ?? []).length, 1, 'the leak is reported once');
  assert.doesNotMatch(bin.stderr(), /server error/, 'no snapshot of a Run that is not a replay was dropped');
  assert.deepEqual((await getJson(port, '/api/runs/wf_stub-1')).json, realRun, 'the real run is as it was');
  assert.deepEqual((await getJson(port, '/api/runs/wf_stub-1/events')).json, realEvents, 'and has no replayed event');
  assert.deepEqual(await runIds(port), ['wf_stub-1']);
});

test('stub tree, real mode: a run whose files are not found is a 404 with the reason before any stream (no hello); a read that fails is a 500; the replay reads nothing then', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--root', 'projects'], { env: { ...tree.env, STUB_DONE: '1', STUB_LOCATE_FAIL: '1' }, cwd: tree.root });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/dropped event with src=demo/);
  const res = await getJson(port, '/api/runs/wf_stub-1/replay');
  assert.equal(res.status, 404);
  assert.match(res.json.error, /^no run "wf_missing" under /, 'the reason of the lookup is the body');
  assert.match(res.headers['content-type'], /^application\/json/, 'not an event stream');
  assert.doesNotMatch(tree.log(), /^readRunDir /m, 'nothing was read');
  assert.doesNotMatch(tree.log(), /^replay opts /m, 'no replay source was made');
  assert.doesNotMatch(bin.stderr(), /server error/, 'a run that is not found is an answer, not a fault of the server');
  assert.equal((await getJson(port, '/api/runs/wf_stub-1')).json.status.value, 'completed', 'the real run is as it was');
  // the slot is not kept by a refused request: three more refusals still say 404, never 429
  for (let i = 0; i < 4; i++) assert.equal((await getJson(port, '/api/runs/wf_stub-1/replay')).status, 404, `refusal ${i + 1}`);
});

test('stub tree, real mode: the replay builds its Run for a snapshot that goes out (one at once, one at the end), not once per event', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--root', 'projects'], { env: { ...tree.env, STUB_DONE: '1', STUB_EVENTS: '8' }, cwd: tree.root });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/dropped event with src=demo/);
  const sse = await openSse(port, { path: '/api/runs/wf_stub-1/replay?speed=20' });
  t.after(() => sse.close());
  await sse.waitClosed(5000);
  const names = sse.events.map((e) => e.event);
  assert.equal(names.filter((n) => n === 'event').length, 8);
  assert.equal(names.filter((n) => n === 'run').length, 2, 'the throttle sent two snapshots');
  assert.equal(names.at(-1), 'end');
  assert.equal((tree.log().match(/^replay getRun$/gm) ?? []).length, 2, 'and the Run was built twice, not eight times');
  assert.equal(sse.events.filter((e) => e.event === 'run').at(-1).data.counter, 8, 'the last snapshot is the state after the last event');
});

test('stub tree, real mode: the events a replay hands over in one step are one snapshot - the Run after the step, built once - and not a snapshot of the first event alone', async (t) => {
  const tree = makeStubTree(t);
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--root', 'projects'], { env: { ...tree.env, STUB_DONE: '1', STUB_EVENTS: '8', STUB_ONE_STEP: '1' }, cwd: tree.root });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/dropped event with src=demo/);
  const sse = await openSse(port, { path: '/api/runs/wf_stub-1/replay?speed=20' });
  t.after(() => sse.close());
  await sse.waitClosed(5000);
  assert.deepEqual(sse.events.map((e) => e.event), ['hello', ...Array(8).fill('event'), 'run', 'end'], 'all eight events, then the one snapshot, then end');
  assert.equal(sse.events.find((e) => e.event === 'run').data.counter, 8, 'the snapshot is the state after the last event of the step, not after the first');
  assert.equal((tree.log().match(/^replay getRun$/gm) ?? []).length, 1, 'the Run was built once');
});

// A listener of a change that throws. What a replay tells about its changes is told after the step, in a microtask, outside the store's
// own try/catch: a throw there would end the process. It is one line on stderr, the process stays up, the next step is told again.
for (const thrown of ['an Error', 'null']) {
  test(`stub tree, --replay: a change listener that throws (${thrown}) is one wfviz: line per step, the process stays up, answers, and the next step is told`, async (t) => {
    const tree = makeStubTree(t);
    patchServer(tree, 'function onStoreChange(runId) {', `function onStoreChange(runId) {
    globalThis.stubChanges = (globalThis.stubChanges ?? 0) + 1;
    if (globalThis.stubChanges === 1) throw process.env.STUB_THROW === 'null' ? null : new Error('listener boom');`);
    const bin = startBin(tree.bin, ['--no-open', '--replay', 'wf_abc'], { env: { ...tree.env, STUB_STEP_AGAIN: '1', STUB_THROW: thrown === 'null' ? 'null' : 'error' } });
    stopAfter(t, bin);
    const { port } = await readyReplay(bin);
    const sse = await openSse(port); // the first page connecting starts the replay
    t.after(() => sse.close());
    await sse.waitFor((e) => e.event === 'hello');
    const line = thrown === 'null' ? /^wfviz: a change listener failed: null$/m : /^wfviz: a change listener failed: listener boom$/m;
    await bin.waitForStderr(line);
    // the second step is told: its change reaches the server's listener, which now answers, and a snapshot goes out
    await sse.waitFor((e) => e.event === 'run', 3000);
    assert.equal(bin.hasExited(), false, 'the process is up');
    assert.equal(listenerLines(bin).length, 1, 'one line for the one step that threw');
    assert.deepEqual(await runIds(port), ['wf_stub-replay-1'], 'and still answers');
    assert.equal(tree.log().match(/^replay start$/gm).length, 1);
    assert.equal((await interrupt(bin)).code, 0, 'the exit code is the usual one');
  });
}

for (const when of ['the first step only', 'every step']) {
  test(`stub tree, real mode: a replay whose listener throws (${when}) is one wfviz: line per throwing step, the stream still gets its end, the process stays up and answers`, async (t) => {
    const tree = makeStubTree(t);
    patchServer(tree, 'onRun(latest) {', `onRun(latest) {
        globalThis.stubRuns = (globalThis.stubRuns ?? 0) + 1;
        if (process.env.STUB_THROW_EVERY || globalThis.stubRuns === 1) throw new Error('listener boom');`);
    const env = { ...tree.env, STUB_DONE: '1', ...(when === 'every step' ? { STUB_THROW_EVERY: '1' } : {}) };
    const bin = startBin(tree.bin, ['--no-open', '--idle', '0', '--root', 'projects'], { env, cwd: tree.root });
    stopAfter(t, bin);
    const { port } = await bin.ready;
    await bin.waitForStderr(/dropped event with src=demo/);
    const sse = await openSse(port, { path: '/api/runs/wf_stub-1/replay?speed=20' });
    t.after(() => sse.close());
    await sse.waitClosed(5000);
    const names = sse.events.map((e) => e.event);
    assert.equal(names.at(-1), 'end', 'the end is sent although the last change could not be told');
    assert.deepEqual(sse.events.at(-1).data, { runId: 'wf_stub-1', events: 2 });
    // the two steps of the stub replay (the first event, then the rest after a wait): one line each when both throw; the second is told when only the first throws
    assert.equal(listenerLines(bin).length, when === 'every step' ? 2 : 1, 'one line per throwing step');
    assert.match(listenerLines(bin)[0], /^wfviz: a change listener failed: listener boom$/);
    assert.equal(names.includes('run'), when !== 'every step', 'a step that was told again sends its snapshot');
    assert.equal(bin.hasExited(), false);
    assert.deepEqual(await runIds(port), ['wf_stub-1'], 'the process answers');
    // another replay still works: the throw did not leave a step stuck
    const again = await openSse(port, { path: '/api/runs/wf_stub-1/replay?speed=20' });
    t.after(() => again.close());
    await again.waitClosed(5000);
    assert.equal(again.events.at(-1).event, 'end');
    assert.equal((await interrupt(bin)).code, 0, 'the exit code is the usual one');
  });
}

test('stub tree, real mode: a run that is running is a 409 and loads nothing; demo and --replay modes have no replay route; the replay module is not needed to start', async (t) => {
  const tree = makeStubTree(t, { omit: ['replay'] });
  const bin = startBin(tree.bin, ['--no-open', '--idle', '0'], { env: tree.env });
  stopAfter(t, bin);
  const { port } = await bin.ready;
  await bin.waitForStderr(/dropped event with src=demo/);
  const res = await getJson(port, '/api/runs/wf_stub-1/replay');
  assert.equal(res.status, 409, 'the stub run has no final status: it is running');
  assert.match(res.json.error, /running/);
  assert.equal(bin.hasExited(), false);

  const done = makeStubTree(t, { omit: ['replay'] });
  const b2 = startBin(done.bin, ['--no-open', '--idle', '0'], { env: { ...done.env, STUB_DONE: '1' } });
  stopAfter(t, b2);
  const p2 = (await b2.ready).port;
  await b2.waitForStderr(/dropped event with src=demo/);
  const broken = await getJson(p2, '/api/runs/wf_stub-1/replay');
  assert.equal(broken.status, 500, 'a replay module that cannot be loaded is an answer before any stream: nothing was said but the reason');
  assert.match(broken.json.error, /cannot load src\/source\/replay\.mjs/);
  await b2.waitForStderr(/cannot load src\/source\/replay\.mjs/);
  assert.equal(b2.hasExited(), false, 'and does not stop wfviz');

  for (const args of [['--demo'], ['--replay', 'wf_abc']]) {
    const full = makeStubTree(t);
    const b = startBin(full.bin, ['--no-open', ...args], { env: full.env });
    stopAfter(t, b);
    const pt = args[0] === '--replay' ? (await readyReplay(b)).port : (await b.ready).port;
    assert.deepEqual((await getJson(pt, '/api/runs/wf_stub-1/replay')).json, { error: 'not found' }, args[0]);
    assert.equal((await getJson(pt, '/api/runs/demo-stub-1/replay')).status, 404, args[0]);
  }
});

// ---- grep checks on the source of bin/ and src/server/ ---------------------------------------------

test('source discipline: demo and claude-fs modules appear in bin only as dynamic import(); never in src/server', () => {
  const bin = fs.readFileSync(BIN, 'utf8');
  const lines = bin.split('\n');
  assert.doesNotMatch(bin, /^\s*import\s[^(]*?from\s+['"][^'"]*(demo|claude-fs|reduce)[^'"]*['"]/m, 'no static import of source or model modules');
  assert.doesNotMatch(bin, /^\s*import\s+['"][^'"]*(demo|claude-fs|reduce)/m, 'no side-effect import either');
  for (const name of ['demo.mjs', 'claude-fs.mjs', 'reduce.mjs']) {
    const hits = lines.filter((l) => l.includes(name));
    assert.ok(hits.length >= 1, `${name} is referenced`);
    for (const l of hits) assert.match(l, /import\(/, `every line naming ${name} is a dynamic import: ${l.trim()}`);
    assert.equal(hits.filter((l) => /^\s*(const|let|var)\b.*await\s+tryImport/.test(l)).length, 1, `${name}: exactly one import site`);
  }
  // The demo import is only reachable under --demo, the claude-fs import only after that branch returned.
  const demoLine = lines.findIndex((l) => l.includes('demo.mjs'));
  const fsLine = lines.findIndex((l) => l.includes('claude-fs.mjs'));
  const ifIdx = lines.findIndex((l) => /^\s*if \(opts\.demo\) \{/.test(l));
  const closeIdx = lines.findIndex((l, i) => i > ifIdx && /^ {2}\}$/.test(l));
  assert.ok(ifIdx >= 0 && closeIdx > ifIdx, 'found the --demo branch');
  assert.ok(ifIdx < demoLine && demoLine < closeIdx, 'the demo import is inside `if (opts.demo)`');
  assert.ok(fsLine > closeIdx, 'the claude-fs import is after (outside) the demo branch');
  assert.match(lines.slice(demoLine, closeIdx).join('\n'), /return \{/, 'the demo branch returns, so real code never runs under --demo');

  for (const f of fs.readdirSync(path.join(REPO, 'src', 'server'))) {
    const text = fs.readFileSync(path.join(REPO, 'src', 'server', f), 'utf8');
    assert.doesNotMatch(text, /demo\.mjs|claude-fs\.mjs|source\/|model\//, `src/server/${f} knows nothing about sources or the model`);
  }
});

test('source discipline: the replay module appears in bin only as two dynamic import()s: in its own `if (opts.replay ...)` block, and, lazily, inside prepare of the replays of the real branch', () => {
  const lines = fs.readFileSync(BIN, 'utf8').split('\n');
  assert.doesNotMatch(lines.join('\n'), /^\s*import\s[^(]*?from\s+['"][^'"]*replay[^'"]*['"]/m, 'no static import of the replay source');
  const IMPORT = /^\s*const\b.*await\s+tryImport\('src\/source\/replay\.mjs', \(\) => import\('\.\.\/src\/source\/replay\.mjs'\)\)/;
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('replay.mjs'));
  assert.equal(hits.length, 2, 'two lines name the replay module: the --replay block and the replays of the real mode');
  for (const [l] of hits) assert.match(l, IMPORT, `every line naming the replay module is a dynamic import: ${l.trim()}`);

  // 1. --replay: inside `if (opts.replay !== undefined) {`, between the demo block and the claude-fs import, and the block returns
  const [, at] = hits[0];
  const open = lines.findLastIndex((l, i) => i < at && /^ {2}if \(opts\.replay !== undefined\) \{$/.test(l));
  const close = lines.findIndex((l, i) => i > at && /^ {2}\}$/.test(l));
  assert.ok(open >= 0 && open < at && at < close, 'the first import is inside `if (opts.replay !== undefined) {`');
  assert.match(lines.slice(at, close).join('\n'), /return \{/, 'the replay block returns, so the real code never runs under --replay');
  const demoClose = lines.findIndex((l, i) => i > lines.findIndex((x) => /^\s*if \(opts\.demo\) \{/.test(x)) && /^ {2}\}$/.test(l));
  const fsLine = lines.findIndex((l) => l.includes('claude-fs.mjs'));
  assert.ok(demoClose < open && close < fsLine, 'order: demo block, replay block, claude-fs import');

  // 2. real mode: below the claude-fs import, inside `async function prepare` of `replays` (done at the first request, never at start)
  const [, lazy] = hits[1];
  assert.ok(lazy > fsLine, 'the second import is below the claude-fs import');
  assert.match(lines[lazy], /^ {4,}\S/, 'it is nested in functions (not at the top of the file, not in loadParts itself)');
  const asyncOpen = lines.findLastIndex((l, i) => i < lazy && /^\s+async function prepare\(/.test(l));
  const factory = lines.findLastIndex((l, i) => i < lazy && /^function realReplays\(/.test(l));
  assert.ok(factory >= 0 && asyncOpen > factory, 'the import is inside the async function prepare of realReplays');
  const wired = lines.findIndex((l) => /^\s*replays: realReplays\(/.test(l));
  assert.ok(wired > fsLine && wired < factory, 'realReplays is wired in the real branch (below the claude-fs import) and defined after loadParts');
  assert.equal(lines.filter((l) => /^\s*replays: /.test(l)).length, 1, 'only the real branch hands `replays` over (demo, --replay and the fakes return none)');

  assert.equal(lines.filter((l) => l.includes('reduce.mjs')).length, 1, 'the model is still imported at one site');
  assert.equal(lines.filter((l) => l.includes('claude-fs.mjs')).length, 1, 'and so is the claude-fs source');
  for (const f of fs.readdirSync(path.join(REPO, 'src', 'server'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'src', 'server', f), 'utf8'), /replay\.mjs/, `src/server/${f} does not name the replay source`);
  }
});

test('source discipline: the only network binding is 127.0.0.1', () => {
  const text = fs.readFileSync(BIN, 'utf8') + fs.readFileSync(path.join(REPO, 'src', 'server', 'server.mjs'), 'utf8');
  assert.match(text, /HOST = '127\.0\.0\.1'/);
  assert.doesNotMatch(text, /0\.0\.0\.0|'::'|"::"|host:\s*['"]localhost/);
  assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|http\.(get|request)\(|node:https|node:net|node:dns/, 'the launcher and server make no outgoing connections');
});

// ---- 3. real modules (when present) ---------------------------------------------------------------

const missing = ['src/source/claude-fs.mjs', 'src/model/reduce.mjs', 'fixtures/claude-projects'].filter((p) => !fs.existsSync(path.join(REPO, p)));

test('real modules: fixtures replayed through claude-fs and the model are served', { skip: missing.length ? `not present yet: ${missing.join(', ')}` : false }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', path.join(REPO, 'fixtures', 'claude-projects'), '--since', 'Infinity'], {
    env: { WFVIZ_TEST_FAKE: undefined },
  });
  stopAfter(t, bin);
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'real');
  const expected = ['wf_26eb8d70-5c4', 'wf_6509ce25-20a'];
  const deadline = Date.now() + 8000;
  let ids = [];
  while (Date.now() < deadline) {
    ids = await runIds(port);
    if (expected.every((id) => ids.includes(id))) break;
    await sleep(200);
  }
  for (const id of expected) assert.ok(ids.includes(id), `${id} in ${JSON.stringify(ids)}`);
  const run = await getJson(port, `/api/runs/${expected[1]}`);
  assert.equal(run.status, 200);
  assert.equal(run.json.id, expected[1]);
  assert.equal(run.json.source, 'real');
  const { code } = await interrupt(bin);
  assert.equal(code, 0);
});

const missingDemo = ['src/source/demo.mjs', 'src/model/reduce.mjs'].filter((p) => !fs.existsSync(path.join(REPO, p)));

test('real modules: --demo serves only demo-… runs', { skip: missingDemo.length ? `not present yet: ${missingDemo.join(', ')}` : false }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--demo'], { env: { WFVIZ_TEST_FAKE: undefined } });
  stopAfter(t, bin);
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'demo');
  const deadline = Date.now() + 8000;
  let ids = [];
  while (Date.now() < deadline && ids.length === 0) {
    ids = await runIds(port);
    await sleep(200);
  }
  assert.ok(ids.length > 0, 'the demo source produced at least one run');
  assert.ok(ids.every((id) => id.startsWith('demo-')), JSON.stringify(ids));
  const { code } = await interrupt(bin);
  assert.equal(code, 0);
});

// ---- 4. real modules, --replay --------------------------------------------------------------------------

const missingReplay = ['src/source/replay.mjs', 'src/model/reduce.mjs', 'fixtures/claude-projects'].filter((p) => !fs.existsSync(path.join(REPO, p)));
const FIXTURE_ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const SAVED = path.join(FIXTURE_ROOT, '-Volumes-MacMiniExt-Documents-work-incubator-adversarial-review-loop', '331703e5-9ca1-4323-b4b8-fccdb8917c4e');
const REAL = { WFVIZ_TEST_FAKE: undefined };
const skipReplay = missingReplay.length ? `not present yet: ${missingReplay.join(', ')}` : false;

async function waitForRun(port, id, pred, ms = 8000) {
  const deadline = Date.now() + ms;
  let run = null;
  while (Date.now() < deadline) {
    const res = await getJson(port, `/api/runs/${id}`);
    run = res.status === 200 ? res.json : null;
    if (run && pred(run)) return run;
    await sleep(100);
  }
  throw new Error(`run ${id} did not reach the expected state; last: ${JSON.stringify(run && { source: run.source, status: run.status, agents: run.totals })}`);
}

test('real modules: --replay <runId> --root <fixtures> replays the saved run: mode replay, source replay, completed with 5 agents', { skip: skipReplay }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--replay', 'wf_6509ce25-20a', '--root', FIXTURE_ROOT, '--speed', '100'], { env: REAL });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.equal(hello.data.mode, 'replay');
  const run = await waitForRun(port, 'wf_6509ce25-20a', (r) => r.status.value === 'completed' && r.totals.agents === 5);
  assert.equal(run.source, 'replay');
  assert.equal(run.name.value, 'probe-event-format');
  const list = (await getJson(port, '/api/runs')).json;
  assert.deepEqual(list.map((r) => [r.id, r.source]), [['wf_6509ce25-20a', 'replay']], 'only the replayed run, no run of the root is read live');
  assert.match(bin.stderr(), /^wfviz: replay starts when the first page connects: open http:\/\/127\.0\.0\.1:\d+\n$/, 'the hint only, no warning');
  const started = Date.now();
  const { code, signal } = await interrupt(bin);
  assert.deepEqual({ code, signal }, { code: 0, signal: null });
  assert.ok(Date.now() - started < 3000);
  assert.equal(await connectionRefused(port), true);
});

test('real modules: --replay does not start before a page connects: the page that connects sees the run from its first event', { skip: skipReplay }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--replay', 'wf_6509ce25-20a', '--root', FIXTURE_ROOT, '--speed', '100'], { env: REAL });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  await sleep(1000); // at speed 100 the transcript part of this run would be over in well under a second
  assert.deepEqual((await getJson(port, '/api/runs')).json, [], 'no page, no replay: the list is empty');
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  const first = await sse.waitFor((e) => e.event === 'event' && e.data.runId === 'wf_6509ce25-20a', 3000);
  assert.equal(first.data.seq, 1, 'the first event this page sees is the first event of the run');
  const run = await waitForRun(port, 'wf_6509ce25-20a', (r) => r.status.value === 'completed' && r.totals.agents === 5);
  assert.equal(run.source, 'replay');
  assert.equal((await interrupt(bin)).code, 0);
});

test('real modules: --replay: the first snapshot a page gets is the Run after the first step (the earliest agent start, status running), not the Run after run.script alone (the script file time as the start, no status)', { skip: skipReplay }, async (t) => {
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--replay', 'wf_6509ce25-20a', '--root', FIXTURE_ROOT, '--speed', '4'], { env: REAL });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const sse = await openSse(port);
  t.after(() => sse.close());
  const first = (await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_6509ce25-20a', 3000)).data;
  assert.equal(first.source, 'replay');
  assert.deepEqual([first.startedAt.prov, first.startedAt.method], ['inferred', 'earliest-agent-start'], JSON.stringify(first.startedAt));
  assert.deepEqual([first.status.value, first.status.prov], ['running', 'inferred']);
  assert.ok(first.totals.agents >= 1, 'the Run already has its first agent');
  assert.equal((await interrupt(bin)).code, 0);
});

test('real modules: --replay <run directory> works, the second saved run ends failed, and --root next to a directory is a warning', { skip: skipReplay }, async (t) => {
  const runDir = path.join(SAVED, 'subagents', 'workflows', 'wf_26eb8d70-5c4');
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--replay', runDir, '--root', '/nonexistent', '--speed', '100'], { env: REAL });
  stopAfter(t, bin);
  const { port } = await readyReplay(bin);
  const sse = await openSse(port); // the first page starts the replay
  t.after(() => sse.close());
  const run = await waitForRun(port, 'wf_26eb8d70-5c4', (r) => r.status.value === 'failed');
  assert.equal(run.source, 'replay');
  assert.match(bin.stderr(), /^wfviz: --root is ignored: --replay names a run directory\nwfviz: replay starts when the first page connects: open http:\/\/127\.0\.0\.1:\d+\n$/);
  assert.equal((await interrupt(bin)).code, 0);
});

test('real modules: --replay problems are exit 2 with an empty stdout and one wfviz: line first on stderr', { skip: skipReplay }, async (t) => {
  const cases = [
    [['--replay', 'wf_nope', '--root', FIXTURE_ROOT], /^wfviz: no run "wf_nope" under /],
    [['--replay', '../x', '--root', FIXTURE_ROOT], /^wfviz: "\.\.\/x" is not a run directory/],
    [['--replay', FIXTURE_ROOT], /^wfviz: .* is a directory but not a run directory/],
    [['--replay', path.join(SAVED, 'workflows')], /^wfviz: .* is a directory but not a run directory/],
    [['--replay', 'wf_6509ce25-20a', '--root', '/nonexistent'], /^wfviz: no run "wf_6509ce25-20a" under "\/nonexistent"/],
    [['--replay', 'wf_x\nwfviz: forged', '--root', FIXTURE_ROOT], /^wfviz: no run "wf_x\\nwfviz: forged" under /],
    [['--replay', 'wf_x', '--demo'], /^wfviz: --replay and --demo cannot be used together/],
    [['--replay', 'wf_x', '--speed', '0'], /^wfviz: --speed must be a number above 0/],
    [['--replay', 'wf_x', '--speed', 'abc'], /^wfviz: --speed must be a number above 0/],
    [['--speed', '3'], /^wfviz: --speed only works with --replay/],
  ];
  for (const [args, re] of cases) {
    const bin = startBin(BIN, ['--no-open', ...args], { env: REAL });
    stopAfter(t, bin);
    const { code, signal } = await bin.exited;
    assert.deepEqual({ code, signal }, { code: 2, signal: null }, args.join(' '));
    assert.equal(bin.stdout(), '', args.join(' '));
    assert.match(bin.stderr(), re, args.join(' '));
  }
  // a newline in the run id did not produce a second wfviz: line
  const forged = startBin(BIN, ['--no-open', '--replay', 'wf_x\nwfviz: forged', '--root', FIXTURE_ROOT], { env: REAL });
  stopAfter(t, forged);
  await forged.exited;
  assert.equal(forged.stderr().split('\n').filter((l) => l.startsWith('wfviz:')).length, 1);
  assert.equal(forged.stderr().split('\n').filter(Boolean).length, 1);
});

test('real modules: --replay <run id> that is in two places under the root is exit 2 with one wfviz: line that names both places and says to pass one of the run directories (the command line accepts a run directory)', { skip: skipReplay }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-dup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const slug of ['one', 'two']) fs.mkdirSync(path.join(root, slug, 'sess', 'subagents', 'workflows', 'wf_dup'), { recursive: true });
  const bin = startBin(BIN, ['--no-open', '--replay', 'wf_dup', '--root', root], { env: REAL });
  stopAfter(t, bin);
  const { code } = await bin.exited;
  assert.equal(code, 2);
  assert.equal(bin.stdout(), '');
  const lines = bin.stderr().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^wfviz: run "wf_dup" is in more than one place: .*one.* and .*two.*; pass one of the run directories$/);
  assert.doesNotMatch(lines[0], /ambiguous/);
});
