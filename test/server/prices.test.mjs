// test/server/prices.test.mjs (node agent-tokens, P2): GET /api/prices (docs/contract.md section 4). The server reads OpenRouter's public model list
// (GET https://openrouter.ai/api/v1/models: data[].id and data[].pricing.prompt / completion / input_cache_read / input_cache_write, USD per token as
// strings), keeps the answer in memory for one hour, shares one fetch among concurrent requests, gives up after 5 s and says offline under --offline.
// The fetch function and the clock are options of createServer; no test touches the network.

import assert from 'node:assert/strict';
import http from 'node:http';

import { createServer, PRICES_TIMEOUT_MS, PRICES_TTL_MS, PRICES_URL } from '../../src/server/server.mjs';
import { closeServer, createFakeStore, getJson, listenOnFreePort, request, sleep, test } from './helpers.mjs';

const HOUR = 3_600_000;
const T0 = 1_794_300_000_000;

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
// a fetch function that records its calls and answers by `handler(callNumber, url, init)`
function fakeFetch(handler) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return handler(calls.length, url, init);
  };
  fn.calls = calls;
  return fn;
}
// a promise that a test settles by hand
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// what OpenRouter answers, reduced to what the server reads, plus the shapes that must not get through
const LIST = {
  data: [
    { id: 'anthropic/claude-haiku-5.5', name: 'x', pricing: { prompt: '0.0000001', completion: '0.0000005', input_cache_read: '0.00000001', input_cache_write: '0.000000125', request: '0' } },
    { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000004', completion: '0.00002' } },
    { id: 'vendor/free', pricing: { prompt: '0', completion: '0', input_cache_read: '0' } },
    { id: 'vendor/numbers', pricing: { prompt: 0.5, completion: 1.5, input_cache_write: 2 } },
    { id: 'vendor/varies', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'vendor/bad-completion', pricing: { prompt: '0.1', completion: 'abc' } },
    { id: 'vendor/no-pricing' },
    { id: 'vendor/bad-cache', pricing: { prompt: '0.1', completion: '0.2', input_cache_read: 'x', input_cache_write: '' } },
    { id: 'vendor/negative-cache', pricing: { prompt: '0.1', completion: '0.2', input_cache_read: '-1' } },
    { id: '__proto__', pricing: { prompt: '1', completion: '2' } },
    { id: 'constructor', pricing: { prompt: '3', completion: '4' } },
    { pricing: { prompt: '1', completion: '1' } },
    { id: '', pricing: { prompt: '1', completion: '1' } },
    { id: 7, pricing: { prompt: '1', completion: '1' } },
    null,
    'text',
    { id: 'dup', pricing: { prompt: '1', completion: '1' } },
    { id: 'dup', pricing: { prompt: '9', completion: '9' } },
  ],
};

async function start(t, { fetchImpl, now, offline, pricesTimeoutMs, store = createFakeStore() } = {}) {
  const errors = [];
  const server = createServer({
    store, mode: 'real', version: '9.9.9', onError: (e) => errors.push(e),
    ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(offline !== undefined ? { offline } : {}), ...(pricesTimeoutMs !== undefined ? { pricesTimeoutMs } : {}),
  });
  const { port } = await listenOnFreePort(server);
  t.after(() => closeServer(server));
  return { server, port, errors };
}
const prices = (port, headers) => getJson(port, '/api/prices', headers);

// ---- the answer ------------------------------------------------------------------------------------------------------------------

test('GET /api/prices: the answer names its source and url, fetchedAt is the clock, models carry the per-token prices of the list', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f, now: () => T0 });
  const res = await prices(port);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(Object.keys(res.json), ['source', 'url', 'fetchedAt', 'models']);
  assert.equal(res.json.source, 'openrouter');
  assert.equal(res.json.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(res.json.url, PRICES_URL);
  assert.equal(res.json.fetchedAt, T0, 'ms since the epoch, like every other time');
  const m = res.json.models;
  assert.deepEqual(m['anthropic/claude-haiku-5.5'], { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001, cacheWrite: 0.000000125 });
  assert.deepEqual(m['anthropic/claude-opus-5'], { input: 0.000004, output: 0.00002 }, 'no cache prices in the list: no cache keys, never 0');
  assert.deepEqual(m['vendor/free'], { input: 0, output: 0, cacheRead: 0 }, 'a real 0 stays 0');
  assert.deepEqual(m['vendor/numbers'], { input: 0.5, output: 1.5, cacheWrite: 2 }, 'a number is a price like a string');
  assert.deepEqual(m['vendor/bad-cache'], { input: 0.1, output: 0.2 }, 'a bad cache price leaves its key out; the entry stays');
  assert.deepEqual(m['vendor/negative-cache'], { input: 0.1, output: 0.2 }, '-1 means "varies": not a price');
  assert.equal(Object.hasOwn(m, 'vendor/varies'), false, 'a base price that is not a price leaves the entry out');
  assert.equal(Object.hasOwn(m, 'vendor/bad-completion'), false);
  assert.equal(Object.hasOwn(m, 'vendor/no-pricing'), false);
  assert.deepEqual(m.dup, { input: 1, output: 1 }, 'the first entry of an id counts');
  assert.deepEqual(Object.keys(m).filter((k) => !k.includes('/')).sort(), ['__proto__', 'constructor', 'dup']);
  assert.equal(Object.keys(m).length, 9, 'entries with no usable id, and non-objects, are not there');
  assert.equal(f.calls.length, 1);
});

test('model ids are data: "__proto__" and "constructor" come through the wire as keys of their own', async (t) => {
  const { port } = await start(t, { fetchImpl: fakeFetch(() => okJson(LIST)), now: () => T0 });
  const { json } = await prices(port);
  assert.deepEqual(Object.getOwnPropertyDescriptor(json.models, '__proto__')?.value, { input: 1, output: 2 });
  assert.deepEqual(Object.getOwnPropertyDescriptor(json.models, 'constructor')?.value, { input: 3, output: 4 });
  assert.equal(Object.getPrototypeOf(json.models), Object.prototype, 'nothing was assigned to the prototype');
  assert.equal(({}).input, undefined);
});

test('the request is a plain GET of the public list: the url, an AbortSignal, and nothing else (no headers, no credentials, no query, no body)', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f });
  await getJson(port, '/api/prices?run=wf_x&token=abc', { Cookie: 'a=b', Authorization: 'Bearer x', Referer: 'http://127.0.0.1/' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/models');
  assert.ok(!url.includes('?'), 'nothing of the client\'s request goes to the list');
  assert.deepEqual(Object.keys(init), ['signal']);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
});

// ---- one hour in memory, one fetch at a time -------------------------------------------------------------------------------------

test('kept in memory for one hour by the injected clock: no second fetch inside it, a new one at the hour, with a new fetchedAt', async (t) => {
  assert.equal(PRICES_TTL_MS, HOUR);
  let clock = T0;
  const f = fakeFetch((n) => okJson({ data: [{ id: 'a/b', pricing: { prompt: String(n), completion: '1' } }] }));
  const { port } = await start(t, { fetchImpl: f, now: () => clock });
  const first = (await prices(port)).json;
  assert.equal(first.models['a/b'].input, 1);
  clock = T0 + HOUR - 1;
  const again = (await prices(port)).json;
  assert.deepEqual(again, first, 'one ms before the hour: the kept answer, fetchedAt unchanged');
  assert.equal(f.calls.length, 1);
  clock = T0 + HOUR;
  const renewed = (await prices(port)).json;
  assert.equal(f.calls.length, 2, 'at the hour: fetched again');
  assert.equal(renewed.fetchedAt, T0 + HOUR);
  assert.equal(renewed.models['a/b'].input, 2);
  clock = T0 + HOUR + 5 * 60_000;
  assert.deepEqual((await prices(port)).json, renewed);
  assert.equal(f.calls.length, 2);
});

test('concurrent requests share one fetch; the entry goes when it settles, so the next request after a failure fetches again', async (t) => {
  const g = gate();
  const f = fakeFetch(() => g.promise);
  const { port } = await start(t, { fetchImpl: f, now: () => T0 });
  const five = Array.from({ length: 5 }, () => prices(port));
  await sleep(100);
  assert.equal(f.calls.length, 1, 'five requests in flight, one fetch');
  g.resolve(okJson(LIST));
  const done = await Promise.all(five);
  assert.ok(done.every((r) => r.status === 200));
  assert.ok(done.every((r) => JSON.stringify(r.json) === JSON.stringify(done[0].json)));
  assert.equal(f.calls.length, 1);

  // the same when the shared fetch fails: all five get the 503, and the next request starts a new fetch
  const g2 = gate();
  const f2 = fakeFetch((n) => (n === 1 ? g2.promise : okJson(LIST)));
  const b = await start(t, { fetchImpl: f2, now: () => T0 });
  const waiting = Array.from({ length: 4 }, () => prices(b.port));
  await sleep(100);
  g2.reject(new Error('connection reset'));
  const failed = await Promise.all(waiting);
  assert.ok(failed.every((r) => r.status === 503 && r.json.error === 'request failed: connection reset'), JSON.stringify(failed.map((r) => r.json)));
  assert.equal(f2.calls.length, 1);
  const next = await prices(b.port);
  assert.equal(next.status, 200, 'a failure is not kept');
  assert.equal(f2.calls.length, 2);
});

test('an expired list is not served after a failed refetch: 503, never the old prices', async (t) => {
  let clock = T0;
  const f = fakeFetch((n) => (n === 1 ? okJson(LIST) : Promise.reject(new Error('offline network'))));
  const { port } = await start(t, { fetchImpl: f, now: () => clock });
  assert.equal((await prices(port)).status, 200);
  clock = T0 + HOUR + 1;
  const res = await prices(port);
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'request failed: offline network');
  assert.deepEqual(Object.keys(res.json), ['error']);
  assert.equal(f.calls.length, 2);
});

// ---- failures: 503 { error } with a one-line reason --------------------------------------------------------------------------------

test('failures are 503 { error } with the reason in one line; the upstream body is never in it', async (t) => {
  const cases = [
    [() => ({ ok: false, status: 500, json: async () => ({ error: 'SECRET upstream body' }) }), 'HTTP 500'],
    [() => ({ ok: false, status: 429, json: async () => ({}) }), 'HTTP 429'],
    [() => ({ ok: false, json: async () => ({}) }), 'HTTP error'],
    [() => undefined, 'HTTP error'],
    [() => okJson(null), 'answer is not a model list'],
    [() => okJson([]), 'answer is not a model list'],
    [() => okJson({}), 'answer is not a model list'],
    [() => okJson({ data: 'x' }), 'answer is not a model list'],
    [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON SECRET'); } }), 'answer is not a model list'],
    [() => okJson({ data: [] }), 'answer has no model with a price'],
    [() => okJson({ data: [{ id: 'a', pricing: { prompt: 'x', completion: '1' } }] }), 'answer has no model with a price'],
    [() => Promise.reject(new Error('socket hang up\n    at stack line')), 'request failed: socket hang up'],
    [() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'request failed: ENOTFOUND'],
    [() => Promise.reject(new Error('x'.repeat(500))), `request failed: ${'x'.repeat(120)}`],
    [() => Promise.reject({}), 'request failed'],
    [() => { throw new Error('thrown at once'); }, 'request failed: thrown at once'],
  ];
  for (const [answer, want] of cases) {
    const f = fakeFetch(answer);
    const { port } = await start(t, { fetchImpl: f, now: () => T0 });
    const res = await prices(port);
    assert.equal(res.status, 503, want);
    assert.deepEqual(res.json, { error: want });
    assert.ok(!res.body.includes('SECRET') && !res.body.includes('\n'), 'one line, no upstream text');
    // not kept: the second request fetches again
    await prices(port);
    assert.equal(f.calls.length, 2, `${want}: a failure is not kept`);
  }
});

test('the timeout: a fetch that does not answer ends with 503 "timeout after ..." and its signal is aborted; the next request fetches again', async (t) => {
  const never = fakeFetch((n, _url, init) => (n === 1 ? new Promise(() => { void init; }) : okJson(LIST)));
  const { port } = await start(t, { fetchImpl: never, now: () => T0, pricesTimeoutMs: 60 });
  const started = Date.now();
  const res = await prices(port);
  assert.ok(Date.now() - started >= 50, 'it waited for the timeout');
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'timeout after 60 ms');
  assert.equal(never.calls[0].init.signal.aborted, true, 'the request is aborted');
  assert.equal((await prices(port)).status, 200, 'and the failure is not kept');
  assert.equal(never.calls.length, 2);
});

test('the timeout is 5 s by default, and its timer is unref\'d and cleared when the fetch settles (no timer is left behind, none for the expiry)', async (t) => {
  assert.equal(PRICES_TIMEOUT_MS, 5000);
  const made = [];
  const cleared = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const h = realSet(fn, ms, ...rest);
    if (ms === PRICES_TIMEOUT_MS) made.push(h);
    return h;
  };
  globalThis.clearTimeout = (h) => { cleared.add(h); return realClear(h); };
  try {
    const { port } = await start(t, { fetchImpl: fakeFetch(() => okJson(LIST)), now: () => T0 });
    assert.equal((await prices(port)).status, 200);
    assert.equal((await prices(port)).status, 200, 'the second answer is the kept one');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(made.length, 1, 'one timeout timer, for the one fetch of 5000 ms; the kept answer needs none and nothing times the hour');
  assert.equal(made[0].hasRef(), false, 'unref\'d: it never keeps the process alive');
  assert.ok(cleared.has(made[0]), 'cleared when the fetch settled');
});

test('a client that leaves does not abort the shared fetch, and nothing is written to its closed response', async (t) => {
  const g = gate();
  const f = fakeFetch(() => g.promise);
  const { port, errors } = await start(t, { fetchImpl: f, now: () => T0 });
  // client A leaves while the fetch is out
  const req = http.get({ host: '127.0.0.1', port, path: '/api/prices', agent: false });
  req.on('error', () => {});
  await sleep(50);
  assert.equal(f.calls.length, 1);
  req.destroy();
  await sleep(50);
  assert.equal(f.calls[0].init.signal.aborted, false, 'the fetch goes on');
  // client B asks meanwhile and gets the one answer
  const b = prices(port);
  await sleep(50);
  assert.equal(f.calls.length, 1, 'no second fetch');
  g.resolve(okJson(LIST));
  const res = await b;
  assert.equal(res.status, 200);
  await sleep(50);
  assert.deepEqual(errors, [], 'no error, nothing written to a destroyed response');
});

test('closing the server aborts a fetch in flight; the process is not held by it', async (t) => {
  const g = gate();
  const f = fakeFetch(() => g.promise);
  const { server, port } = await start(t, { fetchImpl: f, now: () => T0 });
  const pending = prices(port).catch((err) => ({ err }));
  await sleep(50);
  assert.equal(f.calls.length, 1);
  await closeServer(server);
  assert.equal(f.calls[0].init.signal.aborted, true);
  g.resolve(okJson(LIST)); // a late answer of a fetch that was aborted changes nothing
  await pending;
});

// ---- what starts a fetch and what does not ----------------------------------------------------------------------------------------

test('GET only, and exactly /api/prices: HEAD, other methods and other paths start no fetch', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f, now: () => T0 });
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await request(port, { method, path: '/api/prices' });
    assert.equal(res.status, 405, method);
    assert.match(res.headers.allow, /^GET/, method);
  }
  for (const p of ['/api/prices/x', '/api/price', '/api/prices/models', '/api/priceslist', '/prices']) {
    const res = await request(port, { path: p });
    assert.ok(res.status === 404 || res.status === 200 /* the static fallback of /prices */, `${p}: ${res.status}`);
    assert.ok(!res.body.includes('openrouter'), p);
  }
  assert.equal(f.calls.length, 0, 'none of them fetched');
  assert.equal((await request(port, { path: '/api/prices' })).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal((await request(port, { path: '/api/prices/' })).status, 200, 'one trailing slash is the same resource, as for the other endpoints');
  assert.equal(f.calls.length, 1, 'and it is the kept answer');
});

test('the Host check applies: a request for a name that is not loopback is refused and starts no fetch', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f, now: () => T0 });
  const res = await request(port, { path: '/api/prices', headers: { Host: 'evil.example.com' } });
  assert.ok(res.status === 403 || res.status === 421, `status ${res.status}`);
  assert.equal(f.calls.length, 0);
  const ok = await request(port, { path: '/api/prices', headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});

// ---- --offline --------------------------------------------------------------------------------------------------------------------

test('offline: 503 { error: "offline" } and the fetch function is never called, however often it is asked', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f, now: () => T0, offline: true });
  for (let i = 0; i < 3; i++) {
    const res = await prices(port);
    assert.equal(res.status, 503);
    assert.deepEqual(res.json, { error: 'offline' });
  }
  const head = await request(port, { method: 'HEAD', path: '/api/prices' });
  assert.equal(head.status, 405);
  assert.equal(f.calls.length, 0);
});

test('without the option the server is online; offline: false is online', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  const { port } = await start(t, { fetchImpl: f, now: () => T0, offline: false });
  assert.equal((await prices(port)).status, 200);
  assert.equal(f.calls.length, 1);
});

test('createServer checks its price options: fetchImpl and now are functions, the timeout is a number above 0', () => {
  const make = (extra) => createServer({ store: createFakeStore(), mode: 'real', ...extra });
  assert.throws(() => make({ fetchImpl: 'x' }), TypeError);
  assert.throws(() => make({ now: 5 }), TypeError);
  for (const bad of [0, -1, NaN, Infinity, '5', null]) assert.throws(() => make({ pricesTimeoutMs: bad }), TypeError, String(bad));
  assert.doesNotThrow(() => make({ pricesTimeoutMs: 1 }));
});

// ---- demo mode -----------------------------------------------------------------------------------------------------------------------

test('mode demo: GET /api/prices is a 404 { error: "not found" } before anything else: no fetch, with or without --offline, whatever the fetch function would do', async (t) => {
  const f = fakeFetch(() => { throw new Error('a demo must never ask the network'); });
  for (const offline of [undefined, false, true]) {
    const server = createServer({ store: createFakeStore(), mode: 'demo', fetchImpl: f, now: () => T0, ...(offline === undefined ? {} : { offline }) });
    const { port } = await listenOnFreePort(server);
    try {
      for (const method of ['GET', 'HEAD']) {
        const res = await request(port, { method, path: '/api/prices' });
        assert.equal(res.status, 404, `${method} offline=${offline}`);
        if (method === 'GET') assert.deepEqual(JSON.parse(res.body), { error: 'not found' });
      }
      assert.equal((await request(port, { method: 'POST', path: '/api/prices' })).status, 405, 'any other method is refused as everywhere');
    } finally {
      await closeServer(server);
    }
  }
  assert.equal(f.calls.length, 0, 'the price list was never fetched');
});

test('the other modes keep the prices route: real answers it, replay is not a demo', async (t) => {
  const f = fakeFetch(() => okJson(LIST));
  for (const mode of ['real', 'replay']) {
    const server = createServer({ store: createFakeStore(), mode, fetchImpl: f, now: () => T0 });
    const { port } = await listenOnFreePort(server);
    try {
      assert.equal((await prices(port)).status, 200, mode);
    } finally {
      await closeServer(server);
    }
  }
  assert.ok(f.calls.length >= 1);
});
