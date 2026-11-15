#!/usr/bin/env node
// wfviz launcher (node N5, contract section 5): parses flags, wires source -> store -> server,
// listens on 127.0.0.1, prints the URL, opens the browser, shuts down cleanly.
//
// Flags: --demo --replay <run> --speed <n> --port <n> --no-open --root <dir> --since <hours> --offline --idle <seconds>
// (see --help). --offline goes to the server only (it never fetches model prices: GET /api/prices is a 503 "offline"); the store and
// the source get no key for it.
//
// Module loading is lazy and dynamic on purpose:
//   real mode: the model and the claude-fs source          (the demo source is never loaded; the replay source only when a page
//                                                            asks for the replay of a finished run, see realReplays below)
//   --demo:    the model and the demo source               (the claude-fs source is never loaded)
//   --replay:  the model and the replay source             (the demo source is never loaded)
// In real mode the store receives only events with src "claude-fs", in --demo only src "demo", in --replay
// only src "replay". Under --replay the store never marks a run stale: a saved run is old by definition.
// Under --replay the source is started when the first browser page connects to the event stream, not when wfviz
// starts, so the page (and a screen recording) sees the run from its first event. It is started once: a page that
// reloads or reconnects later finds the run as it is, and the replay neither loops nor restarts.
//
// Replay inside the real server (contract sections 1 and 4): in real mode only, the server gets `replays`, which opens one replay of a
// finished run per request of GET /api/runs/:id/replay: its own source and its own store (the real store and the real stream never see
// it). Demo, --replay and the WFVIZ_TEST_FAKE stand-ins pass none.
//
// Run history (contract section 4, P1): in real mode the server is given a `loader` made from the claude-fs source (isLoaded, loadRun), so
// that the run list holds every run under --root with `loaded` true or false and a run that is only listed is loaded when it is first
// asked for. --since chooses which runs are loaded at start (the --since line of --help in src/server/args.mjs says so, HELP_NOTE below
// adds what happens to the others).
//
// Output: stdout carries exactly the line `wfviz listening on http://127.0.0.1:<port> (real|demo|replay)`
// (plus whatever a WFVIZ_OPEN_CMD test hook prints). Warnings and shutdown reasons go to stderr.
// A --replay run that cannot be found is exit code 2 with one `wfviz: ...` line on stderr and nothing on stdout.
//
// Test hooks (environment):
//   WFVIZ_TEST_FAKE=1          use the fake store and fake source defined below instead of the real
//                              modules (they may not exist yet). The fake source emits one event for
//                              one fake run every WFVIZ_TEST_FAKE_TICK_MS (default 100) ms. Under --replay the
//                              fake source emits src "replay" events and the --replay argument is not looked up.
//   WFVIZ_OPEN_CMD=<program>   run <program> <url> instead of the platform opener, with stdio inherited
//                              (WFVIZ_OPEN_CMD=echo prints the URL on stdout). A single program name or
//                              path: no argument splitting.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgv, usage, UsageError } from '../src/server/args.mjs';
import { createServer } from '../src/server/server.mjs';
import { createEditInputTracker } from '../src/server/edit-inputs.mjs';

const HOST = '127.0.0.1';
const FORCE_EXIT_MS = 3000;

// What --help says after the usage text, and only what the --since line there does not: a run that was not loaded at start is listed from its
// journal, final file and script, and is loaded when it is opened.
const HELP_NOTE = [
  '',
  'A run that was not loaded at start is listed from its journal, final file and script only, and is loaded when it is opened.',
  '',
].join('\n');

const info = (line) => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`wfviz: ${line}\n`);

// ---- state shared by the signal handlers, the idle timer and main() ------------------------------

let server = null;
let source = null;
let shuttingDown = false;
let everConnected = false;
let idleTimer = null;
let idleSeconds = 0;
let replayWaiting = false; // --replay: the source is not started yet, it waits for the first client

// A source that fails to start (or any startup error) ends the process with code 1.
function fatal(err) {
  warn(err && err.code === 'EADDRINUSE' ? `port is already in use: ${err.message}` : err && err.message ? err.message : String(err));
  shutdown(1);
  // `shutdown` leaves the process to end by itself once the server is closed; make sure it does.
  setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();
}

function startReplayOnce() {
  if (!replayWaiting) return;
  replayWaiting = false;
  if (shuttingDown || !source) return;
  (async () => source.start())().catch(fatal);
}

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(idleTimer);
  idleTimer = null;
  if (reason) warn(reason);
  if (source) {
    try {
      source.stop();
    } catch (err) {
      warn(`source.stop failed: ${err.message}`);
    }
  }
  process.exitCode = code;
  // Fallback: whatever keeps the process alive after this, do not hang. It stays armed until the process is gone.
  const force = setTimeout(() => {
    warn(`shutdown did not finish within ${FORCE_EXIT_MS} ms, forcing exit`); // a trace: a clean close never says this
    server?.closeAllConnections?.();
    process.exit(code);
  }, FORCE_EXIT_MS);
  force.unref();
  if (!server || !server.listening) return finish(code); // nothing to wait for
  server.close(() => finish(code)); // also ends every SSE stream
}

// Ends the process explicitly once the output is written. A natural exit tears the signal handlers down
// before the process is gone, and a signal that lands in that window kills the process with the signal
// (exit code null) instead of the code. process.exit() keeps the handlers installed until the very end.
function finish(code) {
  const flushed = (stream) => new Promise((resolve) => stream.write('', () => resolve()));
  Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(
    () => process.exit(code),
    () => process.exit(code),
  );
}

function onSignal(name) {
  // A repeated signal (a supervisor adding SIGTERM after Ctrl+C) must neither cut the graceful close short nor
  // change the exit code. The force timer in shutdown() bounds how long a stuck close can take.
  if (shuttingDown) return;
  shutdown(0, `${name}, shutting down`);
}

function onClientCountChange(count) {
  if (count > 0) {
    startReplayOnce();
    everConnected = true;
    clearTimeout(idleTimer);
    idleTimer = null;
    return;
  }
  if (!everConnected || idleSeconds <= 0 || shuttingDown) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(0, `no client for ${idleSeconds} s, exiting`), idleSeconds * 1000);
}

// ---- browser ---------------------------------------------------------------------------------------

function openBrowser(url) {
  const override = process.env.WFVIZ_OPEN_CMD;
  let command;
  let args;
  if (override) {
    [command, args] = [override, [url]];
  } else if (process.platform === 'darwin') {
    [command, args] = ['open', [url]];
  } else if (process.platform === 'win32') {
    [command, args] = ['cmd', ['/c', 'start', '', url]];
  } else {
    [command, args] = ['xdg-open', [url]];
  }
  const hint = `open ${url} in a browser yourself`;
  try {
    const child = spawn(command, args, {
      stdio: override ? ['ignore', 'inherit', 'inherit'] : 'ignore',
      detached: !override,
      windowsHide: true,
    });
    child.on('error', (err) => warn(`could not run ${command}: ${err.message}; ${hint}`));
    if (!override) child.unref();
  } catch (err) {
    warn(`could not run ${command}: ${err.message}; ${hint}`);
  }
}

// ---- wiring ----------------------------------------------------------------------------------------

async function tryImport(label, load) {
  try {
    return await load();
  } catch (err) {
    throw new Error(`cannot load ${label}: ${err.message}`);
  }
}

// A replay's source hands several events over in one go (the events of one schedule key: the first step is the head events and the first
// records of the first agent). A change that the server hears of after each event would make it send, at the first change, a snapshot of
// the Run built from the first event alone (the script file time as the start, no status). So what a replay tells about its changes is told
// after the step: oncePerStep(fn) returns a function that calls fn once, in a microtask, however often it is called before; its `now()`
// calls fn at once when a call is waiting. fn runs outside the store's own try/catch (a listener that throws in the store is held there),
// so a throw is caught here and said in one line on stderr, whatever was thrown: it never ends the process, and the next step is told again.
function oncePerStep(fn) {
  let waiting = false;
  const run = () => {
    if (!waiting) return;
    waiting = false;
    try {
      fn();
    } catch (err) {
      let reason;
      try {
        reason = String(err?.message ?? err); // `throw null` has no message; String() also gives a symbol a text
      } catch {
        reason = 'a value that cannot be shown';
      }
      warn(`a change listener failed: ${reason.split('\n')[0]}`);
    }
  };
  const call = () => {
    if (waiting) return;
    waiting = true;
    queueMicrotask(run);
  };
  call.now = run;
  return call;
}

// The store of a --replay, for the server: its changes are announced after the step (oncePerStep), one per run; all else is the store.
function announcingAfterStep(store) {
  return {
    ...store,
    onChange(listener) {
      const steps = new Map();
      const off = store.onChange((runId) => {
        if (!steps.has(runId)) steps.set(runId, oncePerStep(() => listener(runId)));
        steps.get(runId)();
      });
      return off;
    },
  };
}

// Returns the store and a factory for the matching source. The factory takes the event sink.
async function loadParts(opts) {
  if (process.env.WFVIZ_TEST_FAKE === '1') return makeFakeParts(opts.demo ? 'demo' : opts.replay !== undefined ? 'replay' : 'real');

  const { createStore } = await tryImport('src/model/reduce.mjs', () => import('../src/model/reduce.mjs'));
  const store = createStore(opts.replay !== undefined ? { staleMs: Infinity } : {});

  if (opts.demo) {
    const { createDemoSource } = await tryImport('src/source/demo.mjs', () => import('../src/source/demo.mjs'));
    return { store, makeSource: (onEvent) => createDemoSource({ onEvent }) };
  }

  if (opts.replay !== undefined) {
    const { createReplaySource, locateRun } = await tryImport('src/source/replay.mjs', () => import('../src/source/replay.mjs'));
    const root = opts.root === undefined ? undefined : path.resolve(opts.root); // else the module's default
    const found = await locateRun({ target: opts.replay, root });
    if (found.via === 'directory' && opts.root !== undefined) warn('--root is ignored: --replay names a run directory');
    return {
      store: announcingAfterStep(store),
      makeSource: (onEvent) => createReplaySource({ runDir: found.runDir, speed: opts.speed, onEvent }),
    };
  }

  const { createClaudeFsSource, readRunDir } = await tryImport('src/source/claude-fs.mjs', () => import('../src/source/claude-fs.mjs'));
  const root = opts.root === undefined ? undefined : path.resolve(opts.root); // else the module's default
  return {
    store,
    makeSource: (onEvent) => {
      const config = { onEvent };
      if (root !== undefined) config.root = root;
      if (opts.sinceHours !== undefined) config.sinceMs = opts.sinceHours * 3600e3; // else the module's default
      return createClaudeFsSource(config);
    },
    replays: realReplays({ createStore, readRunDir, root }),
  };
}

// `replays` of the server in real mode: prepare({ runId }) -> prepared, then open({ runId, speed, prepared, onRun, onEvent, onEnd, onError }) ->
// { stop() }. prepare looks the run up under the same root as the real source and reads it once, BEFORE the server says hello, so that a
// run whose files are not there (or are in two places, or hold no event) is an answer with its reason and not a stream that ends for no
// visible cause; its errors carry `status` 404 for what the lookup or the run says, nothing for a read that fails (the server answers 500).
// prepare asks for a lookup by run id only: whatever the request carries, nothing is looked up relative to the process directory.
// open plays what prepare read into a store of its own (staleMs Infinity: a saved run is old by definition; it arms no stale timer).
// The replay module is loaded at the first prepare, not at start. The events the replay store applies go to onEvent; its Run is not built
// on every change: onRun is given a function and the server calls it when a snapshot goes out (a Run of 2000 events costs ~60 ms, and a
// replay changes it at every event); onRun is told once per step of the replay (what the source hands over in one go), after the step,
// so that the first snapshot is the Run after the first step and not the Run after its first event. A replay event never goes to the real
// store or to the edit-input tracker. The replay source has no end signal: the end is the moment it has handed over as many events as were read.
function realReplays({ createStore, readRunDir, root }) {
  const reported = new Set();

  async function prepare({ runId }) {
    if (/[\\/]/.test(runId)) throw Object.assign(new Error(`cannot replay ${JSON.stringify(runId)}: a run id has no path separator`), { status: 404 });
    const { createReplaySource, locateRun } = await tryImport('src/source/replay.mjs', () => import('../src/source/replay.mjs'));
    let found;
    try {
      found = await locateRun({ target: runId, root, idOnly: true }); // a run id of the list, never a path relative to the process directory
    } catch (err) {
      if (err && err.name === 'ReplayLookupError') err.status = 404; // the run is in the list but its files are not found (or not unique)
      throw err;
    }
    const events = await readRunDir(found.sessionDir, found.runId);
    if (events.length === 0) throw Object.assign(new Error(`run ${JSON.stringify(found.runId)} has no events to replay (${found.runDir})`), { status: 404 });
    return { createReplaySource, found, events };
  }

  return {
    prepare,
    open({ runId, speed, prepared, onRun, onEvent, onEnd, onError }) {
      let stopped = false;
      let source = null;
      let off = [];
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const f of off) f();
        off = [];
        source?.stop();
      };
      (async () => {
        const { createReplaySource, found, events } = prepared ?? (await prepare({ runId }));
        if (stopped) return;
        const store = createStore({ staleMs: Infinity });
        const latest = () => store.getRun(found.runId);
        const announce = oncePerStep(() => {
          if (!stopped) onRun(latest);
        });
        off.push(
          store.onChange((id) => {
            if (!stopped && id === found.runId) announce();
          }),
          store.onEvent((ui) => {
            if (!stopped) onEvent(ui);
          }),
        );
        let handed = 0;
        const sink = (event) => {
          if (stopped) return;
          if (!event || event.src !== 'replay') {
            const seen = String(event && event.src);
            if (!reported.has(seen)) {
              reported.add(seen);
              warn(`replay of ${runId}: dropped event with src=${seen} (only "replay" is accepted)`);
            }
            return;
          }
          try {
            store.apply(event);
          } catch (err) {
            warn(`store.apply failed for ${event.kind} of ${event.runId} in the replay: ${err.message}`);
          }
          handed += 1;
          if (handed >= events.length) {
            announce.now(); // the change of the last step is told before the end: the end sends the state the throttle held back
            onEnd();
          }
        };
        // what prepare read is what the source plays: the run is read once per replay
        source = createReplaySource({ runDir: found.runDir, speed, readRun: async () => events, onEvent: sink });
        await source.start();
      })().catch((err) => {
        if (!stopped) onError(err);
      });
      return { stop };
    },
  };
}

// The store must only ever see events of its own mode. Anything else is dropped and reported once per src.
// The edit-input tracker sees what the store sees (the full input of edit tools is not kept in a Run; the
// transcript endpoint serves it from the tracker).
function guardedSink(store, mode, editInputs) {
  const accepted = mode === 'demo' ? 'demo' : mode === 'replay' ? 'replay' : 'claude-fs';
  const reported = new Set();
  return (event) => {
    if (!event || event.src !== accepted) {
      const seen = String(event && event.src);
      if (!reported.has(seen)) {
        reported.add(seen);
        warn(`dropped event with src=${seen} (only "${accepted}" is accepted in ${mode} mode)`);
      }
      return;
    }
    try {
      store.apply(event);
    } catch (err) {
      warn(`store.apply failed for ${event.kind} of ${event.runId}: ${err.message}`);
    }
    try {
      editInputs.record(event);
    } catch (err) {
      warn(`edit-input tracking failed for ${event.kind} of ${event.runId}: ${err.message}`);
    }
  };
}

// ---- test fakes (WFVIZ_TEST_FAKE=1 only) -----------------------------------------------------------
// Minimal stand-ins with the contract's method names. Not a model: the fake run is a counter.

function makeFakeParts(mode) {
  const src = mode === 'demo' ? 'demo' : mode === 'replay' ? 'replay' : 'claude-fs';
  const runId = mode === 'demo' ? 'demo-fake-1' : mode === 'replay' ? 'replay-fake-1' : 'wf_fake-1';
  const tickMs = Number(process.env.WFVIZ_TEST_FAKE_TICK_MS) || 100;
  const unknown = { value: null, prov: 'unknown', reason: 'WFVIZ_TEST_FAKE stand-in' };

  const runs = new Map();
  const listeners = new Set();
  const eventListeners = new Set();
  const backlog = new Map(); // runId -> UiEvent[]
  const store = {
    apply(event) {
      const prev = runs.get(event.runId);
      runs.set(event.runId, {
        id: event.runId,
        source: mode === 'demo' || mode === 'replay' ? mode : 'real',
        project: event.project ?? null,
        name: unknown,
        status: unknown,
        startedAt: unknown,
        agents: {},
        events: (prev ? prev.events : 0) + 1,
        lastKind: event.kind,
      });
      const list = backlog.get(event.runId) ?? [];
      backlog.set(event.runId, list);
      const ui = { runId: event.runId, seq: list.length + 1, ts: event.ts ?? null, kind: event.kind, message: `${event.kind} event`, prov: 'registered' };
      list.push(ui);
      for (const cb of eventListeners) cb(ui);
      for (const cb of listeners) cb(event.runId);
      return event.runId;
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    eventsSince: (id, seq) => (backlog.get(id) ?? []).filter((e) => e.seq > (Number(seq) || 0)),
    getRun: (id) => runs.get(id) ?? null,
    listRuns: () =>
      [...runs.values()].map((r) => ({
        id: r.id, name: r.name, status: r.status, project: r.project, startedAt: r.startedAt, agents: 0, running: 0, events: r.events,
      })),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  const makeSource = (onEvent) => {
    let timer = null;
    const emit = (kind) =>
      onEvent({ src, kind, runId, sessionId: null, project: null, ts: Date.now(), prov: { file: '(fake)', line: null }, data: {} });
    return {
      async start() {
        emit('run.launched');
        timer = setInterval(() => emit('agent.activity'), tickMs);
      },
      stop() {
        clearInterval(timer);
        timer = null;
      },
      async rescan() {},
      isLoaded() { return true; },
      async loadRun() {},
    };
  };

  return { store, makeSource };
}

// ---- main ------------------------------------------------------------------------------------------

function listen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen({ port, host: HOST }, () => {
      srv.off('error', reject);
      resolve();
    });
  });
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`wfviz: ${err.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}${HELP_NOTE}`);
    return;
  }

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const mode = opts.demo ? 'demo' : opts.replay !== undefined ? 'replay' : 'real';
  idleSeconds = opts.idleSeconds;
  if (opts.demo && (opts.root !== undefined || opts.sinceHours !== undefined)) {
    warn('--root and --since are ignored with --demo');
  }
  if (opts.replay !== undefined && opts.sinceHours !== undefined) {
    warn('--since is ignored with --replay');
  }
  if (!opts.demo && opts.replay === undefined && opts.root !== undefined && !fs.existsSync(opts.root)) {
    warn(`--root ${opts.root} does not exist`);
  }

  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  if (!fs.existsSync(webDir)) warn('web/ not found: serving the API only');

  let parts;
  try {
    parts = await loadParts(opts);
  } catch (err) {
    if (!err || err.name !== 'ReplayLookupError') throw err;
    shutdown(2, err.message); // the run to replay is not there: a usage-level error, nothing has been started
    return;
  }
  const { store, makeSource } = parts;
  if (shuttingDown) return; // a signal arrived while the modules were loading
  const editInputs = createEditInputTracker();
  source = makeSource(guardedSink(store, mode, editInputs));
  replayWaiting = mode === 'replay';
  // real mode: which runs are read in full, and a way to read one more (the demo and the replay have no listed-only runs)
  const loader = mode === 'real' ? { isLoaded: (runId) => source.isLoaded(runId), load: (runId) => source.loadRun(runId) } : null;
  server = createServer({ store, webDir, mode, version: readVersion(), onClientCountChange, editInputs, replays: parts.replays, loader, offline: opts.offline });

  await listen(server, opts.port);
  server.on('error', (err) => warn(`server error: ${err.message}`));
  if (shuttingDown) {
    server.close(); // a signal arrived while binding
    return;
  }
  const url = `http://${HOST}:${server.address().port}`;
  info(`wfviz listening on ${url} (${mode})`);

  if (mode === 'replay') {
    // Nothing is emitted yet: the first page that connects starts the run (startReplayOnce), so it opens at the beginning.
    warn(`replay starts when the first page connects: open ${url}`);
  } else {
    await source.start();
  }
  if (!opts.noOpen && !shuttingDown) openBrowser(url);
}

main().catch(fatal);
