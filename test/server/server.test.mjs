// test/server/server.test.mjs (node N5): createServer with an injected fake store. No real source or model.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createEditInputTracker } from '../../src/server/edit-inputs.mjs';
import { createServer, DEFAULT_TAIL, DEFAULT_THROTTLE_MS, MAX_TAIL } from '../../src/server/server.mjs';
import {
  closeServer, connectionRefused, createFakeStore, getJson, listenOnFreePort, makeAgent, makeRun, openSse, request, sleep, test,
} from './helpers.mjs';

async function start(t, { store = createFakeStore(), mode = 'real', version = '9.9.9', ...rest } = {}) {
  const calls = [];
  const server = createServer({ store, mode, version, onClientCountChange: (n) => calls.push(n), onError: (e) => calls.push(e), ...rest });
  const address = await listenOnFreePort(server);
  t.after(() => closeServer(server));
  return { server, store, port: address.port, address, counts: calls };
}

function makeWebDir(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-web-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const webDir = path.join(base, 'web');
  fs.mkdirSync(path.join(webDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>wfviz</title>');
  fs.writeFileSync(path.join(webDir, 'app.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(webDir, 'style.css'), 'body{}\n');
  fs.writeFileSync(path.join(webDir, 'data.bin'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(webDir, 'sub', 'index.html'), '<title>sub</title>');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-OUTSIDE-WEBDIR');
  fs.writeFileSync(path.join(base, 'web-sibling.txt'), 'SIBLING-WITH-WEB-PREFIX');
  return { base, webDir };
}

// ---- construction and binding -------------------------------------------------------------------------

test('createServer returns an http.Server that is not listening yet', () => {
  const server = createServer({ store: createFakeStore(), mode: 'real' });
  assert.ok(server instanceof http.Server);
  assert.equal(server.listening, false);
});

test('createServer rejects a store without the contract methods and a bad mode', () => {
  assert.throws(() => createServer({ store: {}, mode: 'real' }), TypeError);
  assert.throws(() => createServer({ store: createFakeStore(), mode: 'live' }), TypeError);
  assert.throws(() => createServer({ mode: 'real' }), TypeError);
  for (const missing of ['getRun', 'listRuns', 'onChange', 'onEvent', 'eventsSince']) {
    const store = { ...createFakeStore() };
    delete store[missing];
    assert.throws(() => createServer({ store, mode: 'real' }), { name: 'TypeError', message: new RegExp(missing) }, `store without ${missing}`);
  }
  assert.throws(() => createServer({ store: createFakeStore(), mode: 'real', throttleMs: -1 }), TypeError);
});

test('binds 127.0.0.1 only, on a free port chosen by the OS for port 0', async (t) => {
  const a = await start(t);
  const b = await start(t);
  assert.equal(a.address.address, '127.0.0.1');
  assert.equal(a.address.family, 'IPv4');
  assert.ok(a.port > 0 && b.port > 0);
  assert.notEqual(a.port, b.port);
});

// ---- JSON API -----------------------------------------------------------------------------------------

test('GET /api/runs lists the store summaries', async (t) => {
  const store = createFakeStore([makeRun('wf_a'), makeRun('wf_b')]);
  const { port } = await start(t, { store });
  const res = await getJson(port, '/api/runs');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(res.json.map((r) => r.id).sort(), ['wf_a', 'wf_b']);
  assert.equal((await getJson(port, '/api/runs/')).status, 200, 'one trailing slash is tolerated');
});

test('GET /api/runs is empty when the store is empty', async (t) => {
  const { port } = await start(t);
  const res = await getJson(port, '/api/runs');
  assert.deepEqual(res.json, []);
});

test('GET /api/runs/:id returns the Run unchanged; unknown id is a JSON 404', async (t) => {
  const run = makeRun('wf_6509ce25-20a', { agents: { a1: makeAgent('a1') }, order: ['a1'] });
  const { port } = await start(t, { store: createFakeStore([run]) });
  const ok = await getJson(port, '/api/runs/wf_6509ce25-20a');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, run);
  const missing = await getJson(port, '/api/runs/wf_nope');
  assert.equal(missing.status, 404);
  assert.match(missing.headers['content-type'], /^application\/json/);
  assert.deepEqual(missing.json, { error: 'run not found' });
  assert.equal((await getJson(port, '/api/runs/%E0%A4%A')).status, 400, 'malformed percent-encoding');
  assert.equal((await getJson(port, '/api/runs/__proto__')).status, 404);
});

test('run ids with reserved characters round-trip through percent-encoding', async (t) => {
  const { port } = await start(t, { store: createFakeStore([makeRun('demo-a b/c')]) });
  const res = await getJson(port, `/api/runs/${encodeURIComponent('demo-a b/c')}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'demo-a b/c');
});

test('unknown /api paths are a JSON 404, not the static handler', async (t) => {
  const { webDir } = makeWebDir(t);
  const { port } = await start(t, { webDir });
  for (const p of ['/api', '/api/', '/api/nothing', '/api/runs//x', '/api/agents/r/a', '/api/agents/r/a/other']) {
    const res = await getJson(port, p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers['content-type'], /^application\/json/, p);
  }
});

test('only GET and HEAD are answered', async (t) => {
  const { port } = await start(t, { store: createFakeStore([makeRun('wf_a')]) });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await request(port, { method, path: '/api/runs' });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
  }
  const head = await request(port, { method: 'HEAD', path: '/api/runs' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(port, { method: 'HEAD', path: '/api/stream' })).status, 405);
});

test('a store that throws is a JSON 500 without leaking the message, and the server stays up', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  store.listRuns = () => {
    throw new Error('boom with /secret/path');
  };
  const { port, counts } = await start(t, { store });
  const res = await getJson(port, '/api/runs');
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { error: 'internal error' });
  assert.ok(counts.some((c) => c instanceof Error && /boom/.test(c.message)), 'error reported via onError');
  assert.equal((await getJson(port, '/api/runs/wf_a')).status, 200);
});

// ---- transcript ---------------------------------------------------------------------------------------

function runWithActivity(n) {
  const activity = Array.from({ length: n }, (_, i) => ({ ts: 1000 + i, tool: 'Bash', inputSummary: `call ${i}` }));
  return makeRun('wf_t', { agents: { a1: makeAgent('a1', activity), a2: makeAgent('a2') } });
}

test('transcript returns the last `tail` activity items, default 200', async (t) => {
  const { port } = await start(t, { store: createFakeStore([runWithActivity(50)]) });
  const all = await getJson(port, '/api/agents/wf_t/a1/transcript');
  assert.equal(all.status, 200);
  assert.equal(all.json.length, 50);
  assert.equal(DEFAULT_TAIL, 200);

  const last3 = await getJson(port, '/api/agents/wf_t/a1/transcript?tail=3');
  assert.deepEqual(last3.json.map((a) => a.inputSummary), ['call 47', 'call 48', 'call 49']);

  const huge = await getJson(port, '/api/agents/wf_t/a1/transcript?tail=99999');
  assert.equal(huge.status, 200);
  assert.equal(huge.json.length, 50);
  assert.equal(MAX_TAIL, 1000);

  const none = await getJson(port, '/api/agents/wf_t/a2/transcript');
  assert.deepEqual(none.json, [], 'an agent without activity has an empty list');
});

test('transcript: default tail is applied to a long activity list', async (t) => {
  const { port } = await start(t, { store: createFakeStore([runWithActivity(350)]) });
  const res = await getJson(port, '/api/agents/wf_t/a1/transcript');
  assert.equal(res.json.length, 200);
  assert.equal(res.json.at(-1).inputSummary, 'call 349');
  const capped = await getJson(port, '/api/agents/wf_t/a1/transcript?tail=1000');
  assert.equal(capped.json.length, 350);
});

test('transcript: bad tail is 400; unknown run or agent is 404', async (t) => {
  const { port } = await start(t, { store: createFakeStore([runWithActivity(5)]) });
  for (const tail of ['0', '-1', 'abc', '1.5', '', '1e3']) {
    assert.equal((await getJson(port, `/api/agents/wf_t/a1/transcript?tail=${tail}`)).status, 400, `tail=${tail}`);
  }
  assert.equal((await getJson(port, '/api/agents/wf_x/a1/transcript')).status, 404);
  const noAgent = await getJson(port, '/api/agents/wf_t/zzz/transcript');
  assert.equal(noAgent.status, 404);
  assert.deepEqual(noAgent.json, { error: 'agent not found' });
  assert.equal((await getJson(port, '/api/agents/wf_t/constructor/transcript')).status, 404, 'no prototype lookups');
});

// ---- demo / real separation ---------------------------------------------------------------------------

test('a run tagged with the other mode is invisible, in the list and by id', async (t) => {
  const store = createFakeStore([makeRun('wf_real', { source: 'real' }), makeRun('demo-x', { source: 'demo' }), makeRun('wf_untagged', { source: undefined })]);
  const real = await start(t, { store, mode: 'real' });
  assert.deepEqual((await getJson(real.port, '/api/runs')).json.map((r) => r.id).sort(), ['wf_real', 'wf_untagged']);
  assert.equal((await getJson(real.port, '/api/runs/demo-x')).status, 404);
  assert.equal((await getJson(real.port, '/api/agents/demo-x/a/transcript')).status, 404);

  const demo = await start(t, { store, mode: 'demo' });
  assert.deepEqual((await getJson(demo.port, '/api/runs')).json.map((r) => r.id).sort(), ['demo-x', 'wf_untagged']);
  assert.equal((await getJson(demo.port, '/api/runs/wf_real')).status, 404);
});

// ---- static files -------------------------------------------------------------------------------------

test('static: / and directories serve index.html, with content types', async (t) => {
  const { webDir } = makeWebDir(t);
  const { port } = await start(t, { webDir });

  const root = await request(port, { path: '/' });
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.match(root.body, /<title>wfviz<\/title>/);
  assert.equal(root.headers['x-content-type-options'], 'nosniff');

  assert.match((await request(port, { path: '/index.html' })).body, /wfviz/);
  assert.match((await request(port, { path: '/sub/' })).body, /sub/);
  assert.match((await request(port, { path: '/sub' })).body, /sub/);
  const js = await request(port, { path: '/app.js?v=3' });
  assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(js.body, 'export const x = 1;\n');
  assert.match((await request(port, { path: '/style.css' })).headers['content-type'], /^text\/css/);
  assert.equal((await request(port, { path: '/data.bin' })).headers['content-type'], 'application/octet-stream');

  const head = await request(port, { method: 'HEAD', path: '/app.js' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String('export const x = 1;\n'.length));

  const missing = await request(port, { path: '/nope.html' });
  assert.equal(missing.status, 404);
  assert.equal((await request(port, { method: 'POST', path: '/' })).status, 405);
});

test('static: without webDir, / is a 404 and the API still works', async (t) => {
  const { port } = await start(t, { store: createFakeStore([makeRun('wf_a')]) });
  assert.equal((await request(port, { path: '/' })).status, 404);
  assert.equal((await getJson(port, '/api/runs')).status, 200);
});

test('static: a webDir that does not exist yet is a 404, not a crash', async (t) => {
  const { port } = await start(t, { webDir: path.join(os.tmpdir(), 'wfviz-does-not-exist-xyz') });
  assert.equal((await request(port, { path: '/' })).status, 404);
  assert.equal((await request(port, { path: '/index.html' })).status, 404);
});

test('static: path traversal is blocked in every spelling', async (t) => {
  const { webDir } = makeWebDir(t);
  const { port } = await start(t, { webDir });
  const attempts = [
    '/../secret.txt',
    '/../../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/sub/../../secret.txt',
    '/sub/%2e%2e/%2e%2e/secret.txt',
    '/..\\secret.txt',
    '/..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    '/....//secret.txt',
    '//../secret.txt',
    '/../web-sibling.txt',
    '/../web/../secret.txt',
    `/../${path.basename(path.dirname(webDir))}/secret.txt`,
    '/%00/../secret.txt',
    '/index.html%00.txt',
    '/%c0%ae%c0%ae/secret.txt',
  ];
  for (const p of attempts) {
    const res = await request(port, { path: p });
    assert.notEqual(res.status, 200, `${p} -> ${res.status}`);
    assert.ok(!res.body.includes('TOP-SECRET'), `${p} leaked the secret`);
    assert.ok(!res.body.includes('SIBLING'), `${p} leaked the sibling file`);
  }
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/sub/../../secret.txt']) {
    assert.equal((await request(port, { path: p })).status, 403, p);
  }
  assert.equal((await request(port, { path: '/%00' })).status, 400, 'NUL byte');
  assert.equal((await request(port, { path: '/%E0%A4%A' })).status, 400, 'malformed encoding');
});

test('static: a symlink inside webDir cannot lead outside it', async (t) => {
  const { base, webDir } = makeWebDir(t);
  try {
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(webDir, 'link.txt'));
    fs.symlinkSync(base, path.join(webDir, 'linkdir'));
  } catch (err) {
    t.skip(`cannot create symlinks here: ${err.code}`);
    return;
  }
  const { port } = await start(t, { webDir });
  for (const p of ['/link.txt', '/linkdir/secret.txt']) {
    const res = await request(port, { path: p });
    assert.equal(res.status, 403, p);
    assert.ok(!res.body.includes('TOP-SECRET'));
  }
});

// ---- static files: aborted, changing and unreadable files ---------------------------------------------

const openFdCount = () => {
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return null; // no /dev/fd here (Windows)
  }
};

async function waitUntil(pred, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

// A bare TCP client for the cases http.request would hide: it keeps every byte the server sends, so a
// response that is longer than its Content-Length shows up in `total`.
function rawClient(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const client = { socket, chunks: [], total: 0, closed: false };
  const waiters = new Set();
  const poke = () => {
    for (const w of [...waiters]) w();
  };
  socket.on('data', (chunk) => {
    client.chunks.push(chunk);
    client.total += chunk.length;
    poke();
  });
  socket.on('close', () => {
    client.closed = true;
    poke();
  });
  client.bytes = () => Buffer.concat(client.chunks);
  client.until = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`raw client: condition not met within ${ms} ms (received ${client.total} bytes, closed: ${client.closed})`));
      }, ms);
      const check = () => {
        if (!pred()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
      check();
    });
  // Resolves with { headLength, contentLength } once the response head is complete.
  client.head = async () => {
    await client.until(() => client.bytes().includes('\r\n\r\n'));
    const bytes = client.bytes();
    const end = bytes.indexOf('\r\n\r\n') + 4;
    const length = /^content-length: (\d+)/im.exec(bytes.subarray(0, end).toString('latin1'));
    return { headLength: end, contentLength: length ? Number(length[1]) : null };
  };
  return client;
}

const getRequest = (p) => `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;

test('static: requests aborted while the file is being looked up do not leak file descriptors', async (t) => {
  if (openFdCount() === null) return t.skip('cannot count open file descriptors here');
  const { webDir } = makeWebDir(t);
  fs.writeFileSync(path.join(webDir, 'big.js'), Buffer.alloc(8 * 1024 * 1024, 'a'));
  const { port } = await start(t, { webDir });

  assert.equal((await request(port, { path: '/big.js' })).body.length, 8 * 1024 * 1024);
  await sleep(50);
  const before = openFdCount();

  const aborts = [];
  for (let i = 0; i < 80; i++) {
    aborts.push(
      new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.write(getRequest('/big.js'));
          if (i % 2) socket.destroy();
          else setTimeout(() => socket.destroy(), 1);
        });
        socket.on('error', () => {});
        socket.on('close', resolve);
      }),
    );
  }
  await Promise.all(aborts);

  const settled = await waitUntil(() => openFdCount() <= before + 2);
  assert.ok(settled, `open file descriptors: ${before} before, ${openFdCount()} after 80 aborted requests`);
});

test('static: a file that grows while it is sent does not run past its Content-Length', async (t) => {
  const { webDir } = makeWebDir(t);
  const file = path.join(webDir, 'grow.bin');
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 'g'));
  const { port } = await start(t, { webDir });

  const client = rawClient(port);
  t.after(() => client.socket.destroy());
  client.socket.write(getRequest('/grow.bin'));
  const { headLength, contentLength } = await client.head();
  assert.equal(contentLength, 16 * 1024 * 1024);
  client.socket.pause();
  fs.appendFileSync(file, Buffer.alloc(1000, 'x'));
  client.socket.resume();

  await client.until(() => client.total >= headLength + contentLength, 10_000);
  await sleep(200);
  assert.equal(client.total, headLength + contentLength, 'not one byte beyond the announced length');

  // The same connection must still be in sync for the next response.
  const before = client.total;
  client.socket.write(getRequest('/app.js'));
  await client.until(() => client.total > before + 20 && client.bytes().subarray(before).includes('export const x'));
  assert.match(client.bytes().subarray(before).toString('utf8'), /^HTTP\/1\.1 200 /);
});

test('static: a file that shrinks while it is sent ends the connection instead of leaving the client waiting', async (t) => {
  const { webDir } = makeWebDir(t);
  const file = path.join(webDir, 'shrink.bin');
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 's'));
  const { port } = await start(t, { webDir });

  const client = rawClient(port);
  t.after(() => client.socket.destroy());
  client.socket.write(getRequest('/shrink.bin'));
  const { headLength, contentLength } = await client.head();
  client.socket.pause();
  fs.truncateSync(file, 0);
  client.socket.resume();

  await client.until(() => client.closed, 3000);
  assert.ok(client.total - headLength < contentLength, 'the body is short and the client can tell');
});

test('static: a file that cannot be opened is a 403 and is reported, not a reset connection', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('file modes are not enforced for this user');
  const { webDir } = makeWebDir(t);
  const locked = path.join(webDir, 'locked.js');
  fs.writeFileSync(locked, 'export const secret = 1;\n');
  fs.chmodSync(locked, 0o000);
  const { port, counts } = await start(t, { webDir });

  for (const method of ['GET', 'HEAD']) {
    const res = await request(port, { method, path: '/locked.js' });
    assert.equal(res.status, 403, method);
    if (method === 'GET') assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' });
  }
  const reported = counts.filter((c) => c instanceof Error);
  assert.ok(reported.length >= 1 && reported.every((e) => e.code === 'EACCES'), 'onError got the EACCES');
  assert.equal((await request(port, { path: '/app.js' })).status, 200, 'the server is still fine');
});

// ---- DNS rebinding guard ----------------------------------------------------------------------------

test('requests whose Host is not loopback are refused (DNS rebinding)', async (t) => {
  const { webDir } = makeWebDir(t);
  const { port } = await start(t, { webDir, store: createFakeStore([makeRun('wf_a')]) });
  for (const host of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1.evil.com', '192.168.1.5', 'localhost.evil.com']) {
    for (const p of ['/api/runs', '/', '/api/stream', '/api/search?q=a']) {
      const res = await request(port, { path: p, headers: { host } });
      assert.equal(res.status, 403, `${host} ${p}`);
    }
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, '127.0.0.1', 'localhost:9']) {
    assert.equal((await request(port, { path: '/api/runs', headers: { host } })).status, 200, host);
  }
});


// ---- GET /api/runs/:id/events ----------------------------------------------------------------------------

function storeWithEvents(n = 5, id = 'wf_e') {
  const store = createFakeStore([makeRun(id)]);
  for (let i = 1; i <= n; i++) store.pushEvent(id, { message: `m${i}`, agentId: 'a1', label: 'implement:S1', status: i === n ? 'done' : 'running' });
  return store;
}

test('events: the backlog of a run, since defaults to 0; since=N gives seq > N, oldest first', async (t) => {
  const store = storeWithEvents(5);
  const { port } = await start(t, { store });
  const all = await getJson(port, '/api/runs/wf_e/events');
  assert.equal(all.status, 200);
  assert.match(all.headers['content-type'], /^application\/json/);
  assert.equal(all.headers['cache-control'], 'no-store');
  assert.deepEqual(all.json.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(all.json, JSON.parse(JSON.stringify(store.eventsSince('wf_e', 0))), 'the store events, untouched');
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events?since=0')).json, all.json);
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events?since=3')).json.map((e) => e.seq), [4, 5]);
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events?since=5')).json, []);
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events?since=999999999999999')).json, []);
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events/?since=4')).json.map((e) => e.seq), [5], 'one trailing slash is tolerated');
  assert.deepEqual((await getJson(port, '/api/runs/wf_e/events?x=1&since=4')).json.map((e) => e.seq), [5]);
});

test('events: a run without events is an empty list, not a 404', async (t) => {
  const { port } = await start(t, { store: createFakeStore([makeRun('wf_quiet')]) });
  const res = await getJson(port, '/api/runs/wf_quiet/events');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, []);
});

test('events: a bad since is a JSON 400, an unknown run a JSON 404 (the 400 is checked first)', async (t) => {
  const { port } = await start(t, { store: storeWithEvents(2) });
  for (const since of ['-1', 'abc', '1.5', '', '1e3', '0x10', '%201', '1%20', '%2B1', '1234567890123456', 'NaN', 'Infinity']) {
    const res = await getJson(port, `/api/runs/wf_e/events?since=${since}`);
    assert.equal(res.status, 400, `since=${since}`);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.deepEqual(res.json, { error: 'since must be an integer >= 0' }, `since=${since}`);
  }
  const missing = await getJson(port, '/api/runs/wf_nope/events');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { error: 'run not found' });
  assert.equal((await getJson(port, '/api/runs/wf_nope/events?since=2')).status, 404);
  assert.equal((await getJson(port, '/api/runs/wf_nope/events?since=bad')).status, 400, 'a bad since is refused before the run is looked up');
  assert.equal((await getJson(port, '/api/runs/__proto__/events')).status, 404);
  assert.equal((await getJson(port, '/api/runs/%E0%A4%A/events')).status, 400, 'malformed percent-encoding');
});

test('events: only the shape /api/runs/:id/events exists; ids with reserved characters round-trip', async (t) => {
  const store = createFakeStore([makeRun('demo-a b/c')]);
  store.pushEvent('demo-a b/c', { message: 'x' });
  const { port } = await start(t, { store });
  assert.equal((await getJson(port, `/api/runs/${encodeURIComponent('demo-a b/c')}/events`)).json.length, 1);
  for (const p of ['/api/runs/demo-a%20b%2Fc/events/extra', '/api/runs/demo-a%20b%2Fc/event', '/api/runs//events']) {
    assert.equal((await getJson(port, p)).status, 404, p);
  }
});

test('events: read-only (POST and friends are 405), HEAD answers without a body', async (t) => {
  const { port } = await start(t, { store: storeWithEvents(1) });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await request(port, { method, path: '/api/runs/wf_e/events' })).status, 405, method);
  }
  const head = await request(port, { method: 'HEAD', path: '/api/runs/wf_e/events' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('events: a run of the other mode is a 404 here, and its events are never listed', async (t) => {
  const store = createFakeStore([makeRun('wf_real'), makeRun('demo-x', { source: 'demo' })]);
  store.pushEvent('wf_real', { message: 'real' });
  store.pushEvent('demo-x', { message: 'demo' });
  const real = await start(t, { store, mode: 'real' });
  assert.equal((await getJson(real.port, '/api/runs/wf_real/events')).json.length, 1);
  assert.equal((await getJson(real.port, '/api/runs/demo-x/events')).status, 404);
  const demo = await start(t, { store, mode: 'demo' });
  assert.equal((await getJson(demo.port, '/api/runs/demo-x/events')).json[0].message, 'demo');
  assert.equal((await getJson(demo.port, '/api/runs/wf_real/events')).status, 404);
});

// ---- transcript: the full input of edit tools --------------------------------------------------------------

test('transcript: the full input and inputTruncated of edit tools are served as the store has them', async (t) => {
  const activity = [
    { ts: 1, tool: 'Edit', inputSummary: '/a.js', input: { file_path: '/a.js', old_string: 'const a = 1;\n', new_string: 'const a = 2;\n', replace_all: false } },
    { ts: 2, tool: 'Write', inputSummary: '/b.js', input: { path: '/b.js', file_text: 'x'.repeat(5000) }, inputTruncated: true },
    { ts: 3, tool: 'MultiEdit', inputSummary: '/c.js', inputTruncated: true },
    { ts: 4, tool: 'NotebookEdit', inputSummary: '/n.ipynb', input: { notebook_path: '/n.ipynb', new_source: 'print(1)', cell_id: 'c1', future: { nested: [1, 2] } } },
    { ts: 5, tool: 'Bash', inputSummary: 'ls' },
    { ts: 6, text: 'done' },
  ];
  const run = makeRun('wf_t', { agents: { a1: makeAgent('a1', activity) } });
  const { port } = await start(t, { store: createFakeStore([run]) });
  const all = await getJson(port, '/api/agents/wf_t/a1/transcript');
  assert.equal(all.status, 200);
  assert.deepEqual(all.json, activity, 'every field of every entry, input and inputTruncated included, nothing added');
  const last3 = await getJson(port, '/api/agents/wf_t/a1/transcript?tail=3');
  assert.deepEqual(last3.json, activity.slice(-3));
  const edits = await getJson(port, '/api/agents/wf_t/a1/transcript?tail=6');
  assert.equal(edits.json[0].input.old_string, 'const a = 1;\n');
  assert.equal(edits.json[1].inputTruncated, true);
  assert.equal('input' in edits.json[2], false, 'an input that could not be kept is not made up');
  assert.deepEqual(edits.json[3].input.future, { nested: [1, 2] }, 'unknown fields are kept');
});

function rawEdit(agentId, ts, line, tool, input, extra = {}) {
  return {
    src: 'claude-fs', kind: 'agent.activity', runId: 'wf_t', sessionId: null, project: null, ts,
    prov: { file: `/x/agent-${agentId}.jsonl`, line },
    data: { agentId, tool, inputSummary: input.file_path ?? input.path ?? '', ...(input ? { input } : {}), ...extra },
  };
}

test('transcript with an edit-input tracker: inputs are put back on the store entries; older edits stay visible', async (t) => {
  const editInputs = createEditInputTracker();
  const edit1 = { file_path: '/early.js', old_string: 'a', new_string: 'b' }; // fell out of the store window
  const edit2 = { file_path: '/late.js', old_string: 'c', new_string: 'd' };
  const write = { path: '/w.js', file_text: 'hello' };
  editInputs.record(rawEdit('a1', 10, 3, 'Edit', edit1));
  editInputs.record(rawEdit('a1', 200, 40, 'Edit', edit2));
  editInputs.record(rawEdit('a1', 300, 41, 'Write', write, { inputTruncated: true }));
  editInputs.record(rawEdit('a2', 200, 5, 'Edit', { file_path: '/other-agent.js' })); // another agent
  const activity = [
    { ts: 100, tool: 'Bash', inputSummary: 'ls' },
    { ts: 200, tool: 'Edit', inputSummary: '/late.js' },
    { ts: 300, tool: 'Write', inputSummary: '/w.js' },
    { ts: 400, text: 'done' },
  ];
  const a2Activity = [{ ts: 200, tool: 'Edit', inputSummary: '/other-agent.js' }];
  const run = makeRun('wf_t', { agents: { a1: makeAgent('a1', activity), a2: makeAgent('a2', a2Activity) } });
  const { port } = await start(t, { store: createFakeStore([run]), editInputs });
  const res = await getJson(port, '/api/agents/wf_t/a1/transcript');
  assert.deepEqual(res.json, [
    { ts: 10, tool: 'Edit', inputSummary: '/early.js', input: edit1 },
    { ts: 100, tool: 'Bash', inputSummary: 'ls' },
    { ts: 200, tool: 'Edit', inputSummary: '/late.js', input: edit2 },
    { ts: 300, tool: 'Write', inputSummary: '/w.js', input: write, inputTruncated: true },
    { ts: 400, text: 'done' },
  ]);
  assert.deepEqual((await getJson(port, '/api/agents/wf_t/a1/transcript?tail=2')).json.map((e) => e.ts), [300, 400], 'tail counts from the end');
  assert.deepEqual((await getJson(port, '/api/agents/wf_t/a2/transcript')).json, [{ ts: 200, tool: 'Edit', inputSummary: '/other-agent.js', input: { file_path: '/other-agent.js' } }], 'another agent has its own entries');
  assert.deepEqual(run.agents.a1.activity, activity, 'the store run is not modified');
});

// ---- SSE ----------------------------------------------------------------------------------------------

const runFrames = (sse, id) => sse.events.filter((e) => e.event === 'run' && (id === undefined || e.data.id === id));
const eventFrames = (sse) => sse.events.filter((e) => e.event === 'event');

test('SSE: headers and a hello event with mode and version come first', async (t) => {
  const { port } = await start(t, { mode: 'real', version: '1.2.3' });
  const sse = await openSse(port);
  t.after(() => sse.close());
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /^text\/event-stream/);
  assert.match(sse.headers['cache-control'], /no-cache/);
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.deepEqual(hello.data, { mode: 'real', version: '1.2.3' });
  assert.equal(sse.events[0].event, 'hello');
});

test('SSE: hello reports demo mode', async (t) => {
  const { port } = await start(t, { mode: 'demo', version: null });
  const sse = await openSse(port);
  t.after(() => sse.close());
  const hello = await sse.waitFor((e) => e.event === 'hello');
  assert.deepEqual(hello.data, { mode: 'demo', version: null });
});

// -- run snapshots: on connect, throttled per run

test('SSE: on connect, hello comes first and then one full Run snapshot of every run of this mode', async (t) => {
  const store = createFakeStore([makeRun('wf_a', { agents: { a1: makeAgent('a1') } }), makeRun('wf_b'), makeRun('demo-x', { source: 'demo' })]);
  const { port } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_b');
  await sleep(100);
  assert.deepEqual(sse.events.map((e) => e.event), ['hello', 'run', 'run']);
  assert.deepEqual(runFrames(sse).map((e) => e.data.id).sort(), ['wf_a', 'wf_b'], 'the run of the other mode is not sent');
  assert.deepEqual(runFrames(sse, 'wf_a')[0].data, JSON.parse(JSON.stringify(store.getRun('wf_a'))), 'a full Run, as GET /api/runs/:id gives it');

  const demo = await start(t, { store, mode: 'demo' });
  const d = await openSse(demo.port);
  t.after(() => d.close());
  await d.waitFor((e) => e.event === 'run' && e.data.id === 'demo-x');
  await sleep(50);
  assert.deepEqual(runFrames(d).map((e) => e.data.id), ['demo-x']);
});

test('SSE: many large Runs on connect are sent as the connection takes them, not all at once (the client is not dropped)', async (t) => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const store = createFakeStore(Array.from({ length: 8 }, (_, i) => makeRun(`wf_big${i}`, { payload: big })));
  const { port } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_big7', 20_000);
  assert.deepEqual(runFrames(sse).map((e) => e.data.id).sort(), Array.from({ length: 8 }, (_, i) => `wf_big${i}`));
  assert.equal(sse.closed, false, '24 MB in one go is more than the buffer limit; one by one it is not');
});

test('SSE: waiting for the connection to take the connect snapshots leaves no listener on the response (no MaxListenersExceededWarning from 11 runs on)', async (t) => {
  // Real data: 21 runs of 1-2 MB. Every snapshot that has to wait for `drain` used to add a `close` listener that was never
  // removed; from the 11th Node warned on stderr at every connect and reconnect of a browser.
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const big = 'x'.repeat(2 * 1024 * 1024);
  const count = 14;
  const store = createFakeStore(Array.from({ length: count }, (_, i) => makeRun(`wf_many${i}`, { payload: big })));
  const { port, counts } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === `wf_many${count - 1}`, 30_000);
  assert.equal(runFrames(sse).length, count, 'every run arrived once');
  await sleep(50); // process warnings are emitted on the next tick
  assert.deepEqual(warnings.map((w) => `${w.name}: ${w.message}`), [], 'no process warning (MaxListenersExceededWarning)');
  assert.deepEqual(counts.filter((c) => c instanceof Error), [], 'nothing reported through onError');
});

test('SSE: a client that goes away while the connect snapshots wait for the connection stops the sending and leaves no listener behind', async (t) => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const big = 'x'.repeat(2 * 1024 * 1024);
  const store = createFakeStore(Array.from({ length: 14 }, (_, i) => makeRun(`wf_gone${i}`, { payload: big })));
  const { port, counts } = await start(t, { store });
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'run');
  sse.close(); // the first snapshots are out, the rest is waiting for `drain`
  await sleep(300);
  assert.deepEqual(counts.filter((c) => c instanceof Error), [], 'a client that left is not an error');
  assert.equal(counts.at(-1), 0, 'the client was removed');
  assert.deepEqual(warnings.map((w) => `${w.name}: ${w.message}`), []);
});

test('SSE: a store that cannot list its runs on connect is reported; the stream stays open and later changes still arrive', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const realList = store.listRuns;
  store.listRuns = () => {
    throw new Error('list boom');
  };
  const { port, counts } = await start(t, { store, throttleMs: 20 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  await sleep(60);
  assert.ok(counts.some((c) => c instanceof Error && /list boom/.test(c.message)), 'reported through onError');
  assert.equal(runFrames(sse).length, 0);
  store.listRuns = realList;
  store.touch('wf_a');
  assert.equal((await sse.waitFor((e) => e.event === 'run')).data.counter, 1);
});

test('SSE: the default throttle window is one second; a change right after the connect snapshot waits for the window to end', async (t) => {
  assert.equal(DEFAULT_THROTTLE_MS, 1000);
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  const first = await sse.waitFor((e) => e.event === 'run');
  assert.equal(first.data.counter, 0);
  store.touch('wf_a');
  store.touch('wf_a');
  await sleep(500);
  assert.equal(runFrames(sse).length, 1, 'nothing inside the window');
  const second = await sse.waitFor((e) => e.event === 'run' && e.data.counter === 2, 2500);
  const gap = second.at - first.at;
  assert.ok(gap >= 950 && gap < 1800, `the snapshot of the changes came ${gap} ms after the first (window 1000 ms)`);
  await sleep(1200);
  assert.equal(runFrames(sse).length, 2, 'two changes, one snapshot');
});

test('SSE: a change after a quiet window is sent at once (leading edge), not after a delay', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store, throttleMs: 200 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  await sleep(300); // the window of the connect snapshot is over
  const touchedAt = Date.now();
  store.touch('wf_a');
  const ev = await sse.waitFor((e) => e.event === 'run' && e.data.counter === 1, 1000);
  assert.ok(ev.at - touchedAt < 100, `sent ${ev.at - touchedAt} ms after the change`);
});

test('SSE: changes inside the window collapse into one snapshot with the latest state, sent when the window ends', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store, throttleMs: 300 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  const first = await sse.waitFor((e) => e.event === 'run');
  for (let i = 0; i < 10; i++) {
    store.touch('wf_a');
    await sleep(5);
  }
  const last = await sse.waitFor((e) => e.event === 'run' && e.data.counter > 0, 1500);
  assert.equal(last.data.counter, 10, 'the snapshot is the latest state');
  const gap = last.at - first.at;
  assert.ok(gap >= 260 && gap < 900, `window end ${gap} ms after the first snapshot (window 300 ms)`);
  await sleep(500);
  assert.equal(runFrames(sse).length, 2, `got ${runFrames(sse).length} snapshots`);
});

test('SSE: the last change inside a window is never dropped, and a steady stream of changes is not starved', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store, throttleMs: 200 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  const ticker = setInterval(() => store.touch('wf_a'), 20); // ten times faster than the window
  t.after(() => clearInterval(ticker));
  await sleep(1300);
  clearInterval(ticker);
  const finalCounter = store.getRun('wf_a').counter;
  await sleep(400); // the window in which the last change falls ends
  const snaps = runFrames(sse);
  assert.ok(snaps.length >= 5, `a steady stream still gets snapshots (${snaps.length})`);
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].at - snaps[i - 1].at >= 160, `snapshots ${i - 1} and ${i} are ${snaps[i].at - snaps[i - 1].at} ms apart`);
  assert.equal(snaps.at(-1).data.counter, finalCounter, 'the last change was sent');
  const count = snaps.length;
  await sleep(400);
  assert.equal(runFrames(sse).length, count, 'quiet again: nothing more');
});

test('SSE: each run has its own window', async (t) => {
  const store = createFakeStore([makeRun('wf_a'), makeRun('wf_b')]);
  const { port } = await start(t, { store, throttleMs: 250 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_b');
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_a');
  store.touch('wf_a');
  store.touch('wf_b');
  store.touch('wf_a');
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_a' && e.data.counter === 2, 1500);
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_b' && e.data.counter === 1, 1500);
  await sleep(400);
  assert.equal(runFrames(sse).length, 4, 'two on connect, one each for the changes');
});

test('SSE: every client gets the snapshots; a client that connects later gets the current state, not the past', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port, counts } = await start(t, { store, throttleMs: 30 });
  const a = await openSse(port);
  const b = await openSse(port);
  t.after(() => {
    a.close();
    b.close();
  });
  await a.waitFor((e) => e.event === 'run');
  await b.waitFor((e) => e.event === 'run');
  store.touch('wf_a');
  await a.waitFor((e) => e.event === 'run' && e.data.counter === 1);
  await b.waitFor((e) => e.event === 'run' && e.data.counter === 1);

  const late = await openSse(port);
  t.after(() => late.close());
  await late.waitFor((e) => e.event === 'run');
  await sleep(100);
  assert.deepEqual(late.events.map((e) => e.event), ['hello', 'run'], 'one snapshot of the current state, no replay of earlier ones');
  assert.equal(runFrames(late)[0].data.counter, 1);
  assert.deepEqual(counts.filter((c) => typeof c === 'number'), [1, 2, 3]);
});

test('SSE: the window is per client: a client that connects just after a change does not get two snapshots inside one window', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store, throttleMs: 300 });
  const a = await openSse(port);
  t.after(() => a.close());
  await a.waitFor((e) => e.event === 'run');
  await sleep(400); // a's window is over
  const b = await openSse(port);
  t.after(() => b.close());
  const onConnect = await b.waitFor((e) => e.event === 'run');
  store.touch('wf_a'); // a: at once; b: its connect snapshot is a few ms old, so it waits
  await a.waitFor((e) => e.event === 'run' && e.data.counter === 1, 300);
  const second = await b.waitFor((e) => e.event === 'run' && e.data.counter === 1, 1500);
  assert.ok(second.at - onConnect.at >= 260, `b got its second snapshot ${second.at - onConnect.at} ms after its first (window 300 ms)`);
});

test('SSE: a run that is not in the store any more sends no snapshot and does not crash the server', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store, throttleMs: 20 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  await sleep(60);
  store.runs.delete('wf_a');
  store.notify('wf_a'); // change notice for a run the store no longer has
  store.notify('wf_never_existed');
  await sleep(100);
  assert.equal(runFrames(sse).length, 1, 'only the connect snapshot');
  assert.equal((await request(port, { path: '/api/runs' })).status, 200);
});

test('SSE never carries a run of the other mode: no snapshot, no event', async (t) => {
  const store = createFakeStore([makeRun('wf_real'), makeRun('demo-x', { source: 'demo' })]);
  const { port } = await start(t, { store, throttleMs: 20 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === 'wf_real');
  store.touch('demo-x');
  store.touch('wf_real');
  store.pushEvent('demo-x', { message: 'demo event' });
  store.pushEvent('wf_real', { message: 'real event' });
  store.pushEvent('demo-x', { message: 'demo event 2' });
  await sse.waitFor((e) => e.event === 'event');
  await sleep(150);
  assert.deepEqual([...new Set(runFrames(sse).map((e) => e.data.id))], ['wf_real']);
  assert.deepEqual(eventFrames(sse).map((e) => e.data.message), ['real event']);
});

// -- events: one frame per UiEvent

test('SSE event: one frame per UiEvent, in the store order, to every client, with no throttle', async (t) => {
  const store = createFakeStore([makeRun('wf_a'), makeRun('wf_b')]);
  const { port } = await start(t, { store }); // default 1 s window for snapshots: events must not wait for it
  const a = await openSse(port);
  const b = await openSse(port);
  t.after(() => {
    a.close();
    b.close();
  });
  await a.waitFor((e) => e.event === 'hello');
  await b.waitFor((e) => e.event === 'hello');
  const pushed = [];
  const startedAt = Date.now();
  for (let i = 0; i < 30; i++) pushed.push(store.pushEvent(i % 3 === 0 ? 'wf_b' : 'wf_a', { message: `m${i}`, agentId: 'a1', label: 'implement:S1', status: 'running' }));
  for (const c of [a, b]) {
    await c.waitFor((e) => e.event === 'event' && e.data.message === 'm29', 1000);
    assert.ok(Date.now() - startedAt < 800, 'delivered well inside one snapshot window');
    assert.deepEqual(eventFrames(c).map((e) => e.data), JSON.parse(JSON.stringify(pushed)), 'every UiEvent, whole, in order');
  }
  const bSeqs = eventFrames(a).filter((e) => e.data.runId === 'wf_b').map((e) => e.data.seq);
  assert.deepEqual(bSeqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'seq of a run is untouched');
});

test('SSE event: events of a run the store does not know are dropped; the store is asked about a run once', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  const realGetRun = store.getRun;
  let asked = 0;
  store.getRun = (id) => {
    if (id === 'wf_a') asked++;
    return realGetRun(id);
  };
  store.pushEvent('wf_unknown', { message: 'nobody' });
  for (let i = 0; i < 40; i++) store.pushEvent('wf_a', { message: `m${i}` });
  await sse.waitFor((e) => e.event === 'event' && e.data.message === 'm39');
  assert.deepEqual([...new Set(eventFrames(sse).map((e) => e.data.runId))], ['wf_a']);
  assert.equal(asked, 1, 'the mode of a run is looked up on its first event only (a reduce per event would make a replay quadratic)');
});

test('SSE event: no client, no work; a client that comes later gets no old events (the backlog endpoint has them)', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store });
  store.pushEvent('wf_a', { message: 'before anybody listened' });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  await sleep(80);
  assert.equal(eventFrames(sse).length, 0);
  assert.equal((await getJson(port, '/api/runs/wf_a/events')).json.length, 1);
  store.pushEvent('wf_a', { message: 'live' });
  assert.equal((await sse.waitFor((e) => e.event === 'event')).data.seq, 2);
});

test('SSE event: the stream is read-only and carries the frame as `event: event`', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port } = await start(t, { store });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run');
  store.pushEvent('wf_a', { message: 'one line', kind: 'agent.result', status: 'done', prov: 'registered' });
  const ev = await sse.waitFor((e) => e.event === 'event');
  assert.deepEqual(Object.keys(ev.data).sort(), ['kind', 'message', 'prov', 'runId', 'seq', 'status', 'ts']);
  assert.equal(ev.data.status, 'done');
});

// -- heartbeat, clients, close

test('SSE: a heartbeat comment arrives (interval from the option)', async (t) => {
  const { port } = await start(t, { heartbeatMs: 40 });
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  const deadline = Date.now() + 1000;
  while (sse.comments.length < 3 && Date.now() < deadline) await sleep(20);
  assert.ok(sse.comments.length >= 3, `comments: ${JSON.stringify(sse.comments)}`);
  assert.ok(sse.comments.every((c) => c === 'heartbeat'));
  assert.equal(sse.events.length, 1, 'comments are not events');
});

test('SSE: the default heartbeat interval is 15 s', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { port } = await start(t);
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'hello');
  t.mock.timers.tick(14_999);
  await sleep(60);
  assert.deepEqual(sse.comments, [], 'nothing before 15 s');
  t.mock.timers.tick(1);
  const deadline = Date.now() + 1000;
  while (sse.comments.length < 1 && Date.now() < deadline) await sleep(10);
  assert.deepEqual(sse.comments, ['heartbeat']);
});

test('SSE: onClientCountChange reports each connect and disconnect', async (t) => {
  const { port, counts } = await start(t);
  const a = await openSse(port);
  await a.waitFor((e) => e.event === 'hello');
  const b = await openSse(port);
  await b.waitFor((e) => e.event === 'hello');
  a.close();
  await a.waitClosed();
  await sleep(50);
  b.close();
  await b.waitClosed();
  await sleep(50);
  assert.deepEqual(counts, [1, 2, 1, 0]);
});

test('SSE: a client that disconnects stops receiving; one store subscription per feed, not one per client', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { port, server } = await start(t, { store, throttleMs: 20 });
  assert.equal(store.listenerCount(), 1, 'one shared change subscription');
  assert.equal(store.eventListenerCount(), 1, 'one shared event subscription');
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'run');
  const other = await openSse(port);
  t.after(() => other.close());
  await other.waitFor((e) => e.event === 'run');
  assert.equal(store.listenerCount(), 1);
  assert.equal(store.eventListenerCount(), 1);
  sse.close();
  await sse.waitClosed();
  const seen = sse.events.length;
  store.touch('wf_a');
  store.pushEvent('wf_a', { message: 'after the first client left' });
  await other.waitFor((e) => e.event === 'event');
  await sleep(100);
  assert.equal(sse.events.length, seen, 'nothing reaches the closed connection');
  await closeServer(server);
  assert.equal(store.listenerCount(), 0, 'unsubscribed when the server closes');
  assert.equal(store.eventListenerCount(), 0);
});

test('server.close() ends open SSE streams and completes; the port is free afterwards', async (t) => {
  const { server, port, counts } = await start(t);
  const sse = await openSse(port);
  await sse.waitFor((e) => e.event === 'hello');
  const started = Date.now();
  await closeServer(server);
  assert.ok(Date.now() - started < 2000, 'close did not hang on the open stream');
  await sse.waitClosed(1000);
  assert.ok(sse.ended, 'the stream was ended, not cut');
  assert.equal(await connectionRefused(port), true);
  assert.equal(counts.at(-1), 0);
});

test('SSE: server.close() with a snapshot timer pending completes at once, and the timer does not fire later', async (t) => {
  const store = createFakeStore([makeRun('wf_a')]);
  const { server } = await start(t, { store });
  const sse = await openSse(server.address().port);
  await sse.waitFor((e) => e.event === 'run');
  store.touch('wf_a'); // inside the 1 s window of the connect snapshot: arms a timer
  const started = Date.now();
  await closeServer(server);
  assert.ok(Date.now() - started < 150, 'pending timer does not delay close');
  const seen = sse.events.length;
  await sleep(100);
  assert.equal(sse.events.length, seen);
});
