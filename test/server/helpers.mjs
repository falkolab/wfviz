// test/server/helpers.mjs (node N5): shared test utilities. Not a test file.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { test as nodeTest } from 'node:test';

// node:test with a default timeout: a test that waits for something that never happens (a process that does
// not exit, a stream that is not closed) fails by name after 30 s instead of hanging the whole run.
export const TEST_TIMEOUT_MS = 30_000;
export function test(name, optionsOrFn, maybeFn) {
  if (typeof optionsOrFn === 'function') return nodeTest(name, { timeout: TEST_TIMEOUT_MS }, optionsOrFn);
  return nodeTest(name, { timeout: TEST_TIMEOUT_MS, ...optionsOrFn }, maybeFn);
}

// ---- fake store (the contract's createStore surface, nothing more) -------------------------------

export function makeRun(id, extra = {}) {
  return {
    id,
    source: 'real',
    sessionId: null,
    project: null,
    name: { value: `run ${id}`, prov: 'registered', from: 'test:1' },
    status: { value: 'running', prov: 'inferred', method: 'no-final-file' },
    agents: {},
    order: [],
    counter: 0,
    ...extra,
  };
}

export function makeAgent(id, activity = []) {
  return { id, label: { value: id, prov: 'registered', from: 'test:2' }, activity };
}

export function createFakeStore(initial = []) {
  const runs = new Map(initial.map((r) => [r.id, r]));
  const listeners = new Set();
  const eventListeners = new Set();
  const backlog = new Map(); // runId -> UiEvent[], seq from 1 per run, like the real store
  const emit = (id) => {
    for (const cb of [...listeners]) cb(id);
  };
  const pushUi = (runId, fields = {}) => {
    const list = backlog.get(runId) ?? [];
    backlog.set(runId, list);
    const ui = { runId, seq: list.length + 1, ts: 1000 + list.length, kind: 'agent.activity', message: `event ${list.length + 1}`, prov: 'registered', ...fields };
    list.push(ui);
    for (const cb of [...eventListeners]) cb(ui);
    return ui;
  };
  return {
    runs,
    getRun: (id) => runs.get(id) ?? null,
    listRuns: () =>
      [...runs.values()].map((r) => ({
        id: r.id,
        ...(r.source === undefined ? {} : { source: r.source }),
        name: r.name,
        status: r.status,
        project: r.project,
        startedAt: r.startedAt,
        agents: Object.keys(r.agents ?? {}).length,
        running: 0,
      })),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    eventsSince: (id, seq) => (backlog.get(id) ?? []).filter((e) => e.seq > (Number.isFinite(Number(seq)) ? Number(seq) : 0)),
    listenerCount: () => listeners.size,
    eventListenerCount: () => eventListeners.size,
    // test helpers
    notify: emit,
    // One UiEvent of a run (the run need not exist: a test may emit for an unknown one on purpose).
    pushEvent: pushUi,
    set(run) {
      runs.set(run.id, run);
      emit(run.id);
    },
    touch(id) {
      const run = runs.get(id);
      run.counter += 1;
      emit(id);
    },
    // Used by the stub source modules of bin tests: a RawEvent becomes a counter on a minimal run and one UiEvent.
    apply(event) {
      const prev = runs.get(event.runId);
      const run = prev ?? makeRun(event.runId, { source: event.src === 'demo' ? 'demo' : 'real' });
      run.counter += 1;
      runs.set(run.id, run);
      pushUi(run.id, { kind: event.kind, ts: event.ts ?? null });
      emit(run.id);
      return run.id;
    },
  };
}

// ---- HTTP client helpers ---------------------------------------------------------------------------

export function request(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

export async function getJson(port, path, headers) {
  const res = await request(port, { path, headers });
  return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
}

/**
 * Open an SSE stream and collect its frames.
 * client.events: [{ event, data, at }]   client.comments: [string]   client.closed: boolean
 */
export function openSse(port, { path = '/api/stream', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      const client = {
        status: res.statusCode,
        headers: res.headers,
        events: [],
        comments: [],
        closed: false,
        ended: false,
        close: () => req.destroy(),
        mark: () => client.events.length,
        // Resolves with the first event at index >= from that satisfies pred. Rejects after `ms`.
        waitFor(pred, ms = 1000, from = 0) {
          return new Promise((res2, rej2) => {
            const tryNow = () => {
              for (let i = from; i < client.events.length; i++) {
                if (pred(client.events[i])) return client.events[i];
              }
              return null;
            };
            const hit = tryNow();
            if (hit) return res2(hit);
            const timer = setTimeout(() => {
              waiters.delete(check);
              rej2(new Error(`SSE: no matching event within ${ms} ms; got ${JSON.stringify(client.events.map((e) => e.event))}`));
            }, ms);
            const check = () => {
              const found = tryNow();
              if (!found) return;
              clearTimeout(timer);
              waiters.delete(check);
              res2(found);
            };
            waiters.add(check);
          });
        },
        waitClosed(ms = 2000) {
          if (client.closed) return Promise.resolve();
          return new Promise((res2, rej2) => {
            const timer = setTimeout(() => rej2(new Error(`SSE: connection not closed within ${ms} ms`)), ms);
            closeWaiters.add(() => {
              clearTimeout(timer);
              res2();
            });
          });
        },
      };
      const waiters = new Set();
      const closeWaiters = new Set();
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const lines = block.split('\n');
          if (lines.every((l) => l.startsWith(':'))) {
            client.comments.push(...lines.map((l) => l.slice(1).trim()));
            continue;
          }
          let event = 'message';
          const data = [];
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          client.events.push({ event, data: data.length ? JSON.parse(data.join('\n')) : null, at: Date.now() });
        }
        for (const w of [...waiters]) w();
      });
      res.on('end', () => {
        client.ended = true;
      });
      res.on('close', () => {
        client.closed = true;
        for (const w of [...closeWaiters]) w();
      });
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server start helper (in-process) ---------------------------------------------------------------

export async function listenOnFreePort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address();
}

// Rejects instead of hanging when close() does not complete (for example an SSE stream that is never ended).
export function closeServer(server, ms = 3000) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error(`server.close() did not complete within ${ms} ms`));
    }, ms);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---- port probing ---------------------------------------------------------------------------------

// True when nothing accepts connections on the port any more.
export function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (err) => resolve(err.code === 'ECONNREFUSED'));
  });
}

export async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// ---- bin runner -------------------------------------------------------------------------------------

const LISTENING = /^wfviz listening on http:\/\/127\.0\.0\.1:(\d+) \((real|demo)\)$/m;

/**
 * Start `node <bin> ...args` with WFVIZ_TEST_FAKE=1 unless env overrides it.
 * Returns { child, stdout(), stderr(), ready, exited, kill() }.
 * `ready` resolves with { port, mode } when the "listening" line appears.
 */
export function startBin(binPath, args = [], { env = {}, cwd } = {}) {
  // WFVIZ_OPEN_CMD=true (a program that does nothing) is the default so that no test can ever open a
  // real browser, even by forgetting --no-open.
  const childEnv = { ...process.env, WFVIZ_TEST_FAKE: '1', WFVIZ_OPEN_CMD: 'true' };
  Object.assign(childEnv, env);
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];

  const child = spawn(process.execPath, [binPath, ...args], { env: childEnv, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const listeners = new Set();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
    for (const l of [...listeners]) l();
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    for (const l of [...listeners]) l();
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let hasExited = false;
  exited.then(() => {
    hasExited = true;
  });

  const waitForText = (pick, regex, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timeout waiting for ${regex}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, ms);
      const check = () => {
        const m = regex.exec(pick());
        if (!m) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(m);
      };
      listeners.add(check);
      check();
    });

  const handle = {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    hasExited: () => hasExited,
    waitForStdout: (regex, ms = 5000) => waitForText(() => stdout, regex, ms),
    waitForStderr: (regex, ms = 5000) => waitForText(() => stderr, regex, ms),
    ready: null,
    kill(signal = 'SIGKILL') {
      if (!hasExited) child.kill(signal);
    },
  };
  handle.ready = handle.waitForStdout(LISTENING).then((m) => ({ port: Number(m[1]), mode: m[2] }));
  // A failed `ready` must not surface as an unhandled rejection when a test only awaits `exited`.
  handle.ready.catch(() => {});
  return handle;
}
