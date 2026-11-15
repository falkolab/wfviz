// Replay source (docs/contract.md section 1, "Replay").
//
// Replays ONE saved real run on a timer: the run is read once with readRunDir (src/source/claude-fs.mjs) and
// every event it returns is emitted again, in a computed order and at a computed pace, with src "replay".
// Nothing else changes: kind, runId, sessionId, project, ts, prov and data are the values the files gave
// (ts included, so the times shown are the run's own); a source never invents values.
//
// Schedule. Each event gets a key (scheduleKey): its own ts, except that
//   - a journal agent.started / agent.result, whose ts is only a file time, is keyed by that agent's first / last
//     transcript record ts when it has one (agent.prompt, agent.activity, agent.structured events of the agent);
//   - run.script and run.launched, whose ts is only a file time too (a script file can be saved hours before the run,
//     the journal's time is its last write), are keyed by the smallest key among the run's other events, so they go
//     out first; a run with no other event keys them by their own ts.
// Events go out in order of key; at the same key run.script and run.launched come first, and ties otherwise keep
// the order readRunDir returned (inside the two heads, and inside the rest). The wait before an event is
// (key - previous key) / speed, capped at 2000 ms; the first event waits 0, and so does the first event after the
// heads (it has their key). speed is clamped to 0.25..100 (default 4). A run with no run.script (or no run.launched)
// has no head of that kind: nothing is added, it starts with its earliest other event.
//
// Consequence of the rule (measured on saved runs, see the node note): only events whose ts is a file time and that
// are not a head (agent.meta) and the run.final of a run that was read after the fact are keyed by those times, so
// they arrive after the transcript events they were written next to. The values themselves, ts included, are never
// changed: run.script and run.launched still carry the file time as ts.
//
// An event with no finite ts is still emitted: its key is the key of the event before it in reader order (the
// first events of a list borrow the first finite key that follows; with no finite key at all every key is 0).
//
// Interface: the same as the other sources. createReplaySource({ onEvent, ... }) -> { start(), stop() };
// start(onEvent) also takes the callback, which then wins over the option. start() reads the run and resolves
// once the first events are out; the rest follows on one timer at a time. The replay does not loop and does
// not restart at the end: after the last event the run stays as read. stop() cancels the pending timer, also
// while the read is still running, and is safe to call twice; start() after stop() begins again.
//
// Beyond the contract, createReplaySource accepts two injections for tests: `timers` ({ setTimeout,
// clearTimeout }, default the global ones) and `readRun` (default readRunDir).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readRunDir } from './claude-fs.mjs';

export const DEFAULT_SPEED = 4;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 100;
export const MAX_DELAY_MS = 2000;

const SRC = 'replay';
const TRANSCRIPT_KINDS = new Set(['agent.prompt', 'agent.activity', 'agent.structured']);
const RUN_ID_PREFIX = 'wf_';

export class ReplayLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayLookupError';
  }
}

// A user-given text inside an error message: JSON string syntax, plus the C1 controls and the line and paragraph
// separators that JSON leaves as they are. A newline or an escape sequence in a run id cannot forge a second line.
export function quote(text) {
  return JSON.stringify(String(text)).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const isTs = (value) => typeof value === 'number' && Number.isFinite(value);

// ---- schedule ----------------------------------------------------------------------------------------

/**
 * Speed as a factor: a number above 0, clamped to 0.25..100 (Infinity gives 100).
 * @throws {TypeError} for NaN, 0, a negative number, text or anything that is not a number
 */
export function normalizeSpeed(speed) {
  if (typeof speed !== 'number' || Number.isNaN(speed) || speed <= 0) {
    throw new TypeError(`replay speed must be a number greater than 0 (it is clamped to ${MIN_SPEED}..${MAX_SPEED}), got ${typeof speed === 'string' ? quote(speed) : String(speed)}`);
  }
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

// First and last transcript record ts of every agent: agentId -> { first, last }.
function transcriptSpans(events) {
  const spans = new Map();
  for (const ev of events) {
    if (!TRANSCRIPT_KINDS.has(ev.kind) || !isTs(ev.ts)) continue;
    const agentId = ev.data?.agentId;
    if (typeof agentId !== 'string') continue;
    const span = spans.get(agentId);
    if (!span) spans.set(agentId, { first: ev.ts, last: ev.ts });
    else {
      if (ev.ts < span.first) span.first = ev.ts;
      if (ev.ts > span.last) span.last = ev.ts;
    }
  }
  return spans;
}

// The two kinds that are keyed by the run's other events (their ts is only a file time).
const HEAD_KINDS = new Set(['run.script', 'run.launched']);

// The schedule key of one event: a number, or null when the event has no finite ts to go by. `floor` is the smallest
// key among the run's other events; with it a head kind (run.script, run.launched) is keyed by it, without it (or when
// it is not a finite number) by its own ts.
export function scheduleKey(event, spans, floor) {
  if (HEAD_KINDS.has(event.kind) && isTs(floor)) return floor;
  const span = event.kind === 'agent.started' || event.kind === 'agent.result' ? spans.get(event.data?.agentId) : undefined;
  if (span) return event.kind === 'agent.started' ? span.first : span.last;
  return isTs(event.ts) ? event.ts : null;
}

/**
 * Pure: events (as readRunDir returns them) -> [{ event, delayMs }] in emission order. The events are the
 * input objects, untouched; delayMs is the wait before the event.
 * @param {object[]} events
 * @param {number} [speed] see normalizeSpeed
 */
export function buildSchedule(events, speed = DEFAULT_SPEED) {
  const factor = normalizeSpeed(speed);
  const spans = transcriptSpans(events);
  // The head kinds are keyed last: by the smallest key of the other events (their own ts when there is none).
  const keys = events.map((ev) => (HEAD_KINDS.has(ev.kind) ? null : scheduleKey(ev, spans)));
  let floor = null;
  for (const k of keys) if (k !== null && (floor === null || k < floor)) floor = k;
  events.forEach((ev, i) => {
    if (HEAD_KINDS.has(ev.kind)) keys[i] = scheduleKey(ev, spans, floor);
  });
  // An event without a key takes the key of the one before it; leading ones take the first key found later.
  let carried = null;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === null) keys[i] = carried;
    else carried = keys[i];
  }
  const firstKnown = keys.find((k) => k !== null);
  for (let i = 0; i < keys.length && keys[i] === null; i++) keys[i] = firstKnown === undefined ? 0 : firstKnown;

  // By key; at the same key the heads first; then reader order.
  const rank = (i) => (HEAD_KINDS.has(events[i].kind) ? 0 : 1);
  const order = events.map((_, i) => i).sort((a, b) => keys[a] - keys[b] || rank(a) - rank(b) || a - b);
  return order.map((index, n) => ({
    event: events[index],
    delayMs: n === 0 ? 0 : Math.min((keys[index] - keys[order[n - 1]]) / factor, MAX_DELAY_MS),
  }));
}

// ---- finding the run -----------------------------------------------------------------------------------

/**
 * A run directory is <session>/subagents/workflows/wf_<id>. Returns the session directory and the run id, or null.
 * @param {string} dir
 */
export function runDirShape(dir) {
  const abs = path.resolve(dir);
  const runId = path.basename(abs);
  const workflows = path.dirname(abs);
  const subagents = path.dirname(workflows);
  if (!runId.startsWith(RUN_ID_PREFIX) || path.basename(workflows) !== 'workflows' || path.basename(subagents) !== 'subagents') return null;
  return { sessionDir: path.dirname(subagents), runId, runDir: abs };
}

const subdirs = async (dir) => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

// A path that must be a run directory (createReplaySource with runDir): no run id lookup.
async function checkRunDirectory(dir) {
  const shape = runDirShape(dir);
  const isDir = shape !== null && (await fs.stat(shape.runDir).catch(() => null))?.isDirectory() === true;
  if (!isDir) throw new ReplayLookupError(`${quote(dir)} is not a run directory (expected <session>/subagents/workflows/${RUN_ID_PREFIX}<id>)`);
  return { ...shape, via: 'directory' };
}

/**
 * Finds the run named by a --replay argument.
 *  - an existing directory that is a run directory is used as it is (via "directory");
 *  - a bare name (no path separator) is a run id: <root>/<slug>/<session>/subagents/workflows/<runId> is looked up by
 *    comparing the name with the directory entries, never by joining it into a path (via "runId");
 *  - anything else (a path that is no run directory, a name with a separator that is no directory) is an error.
 * With idOnly the target is only ever a run id under the root (the replay endpoint of the real server: its run id comes from
 * a request): a target with a path separator, "." or ".." is refused and nothing is looked up relative to the process
 * directory, so a directory of the same name under the current directory is never read.
 * A name found under the root that has no "wf_" prefix is not a run (no run directory has such a name).
 * @param {{ target: string, root?: string, idOnly?: boolean }} options root defaults to ~/.claude/projects; idOnly defaults to false
 * @returns {Promise<{ runDir: string, sessionDir: string, runId: string, via: 'directory' | 'runId' }>}
 * @throws {ReplayLookupError} with a one-line message
 */
export async function locateRun({ target, root, idOnly = false } = {}) {
  if (typeof target !== 'string' || target.trim() === '') throw new ReplayLookupError('no run to replay: give a run directory or a run id');
  const hasSeparator = /[\\/]/.test(target);

  if (idOnly) {
    if (hasSeparator || target === '.' || target === '..') {
      throw new ReplayLookupError(`${quote(target)} is not a run id (a run id is a bare name such as ${RUN_ID_PREFIX}<id>, never a path)`);
    }
  } else {
    const stat = await fs.stat(path.resolve(target)).catch(() => null);
    if (stat?.isDirectory()) {
      const shape = runDirShape(target);
      if (shape) return { ...shape, via: 'directory' };
      if (hasSeparator) {
        throw new ReplayLookupError(`${quote(target)} is a directory but not a run directory (expected <session>/subagents/workflows/${RUN_ID_PREFIX}<id>)`);
      }
    }
    if (hasSeparator) {
      throw new ReplayLookupError(`${quote(target)} is not a run directory (expected <session>/subagents/workflows/${RUN_ID_PREFIX}<id>); a run id is a bare name such as ${RUN_ID_PREFIX}<id>`);
    }
  }

  const rootDir = path.resolve(root ?? path.join(os.homedir(), '.claude', 'projects'));
  const found = [];
  for (const slug of await subdirs(rootDir)) {
    for (const session of await subdirs(path.join(rootDir, slug))) {
      const workflows = path.join(rootDir, slug, session, 'subagents', 'workflows');
      if (target.startsWith(RUN_ID_PREFIX) && (await subdirs(workflows)).includes(target)) found.push(path.join(workflows, target));
    }
  }
  if (found.length === 0) throw new ReplayLookupError(`no run ${quote(target)} under ${quote(rootDir)} (looked in <root>/<project>/<session>/subagents/workflows/)`);
  if (found.length > 1) {
    const places = found.map(quote).join(' and ');
    // a run directory cannot be passed where only a run id is looked up (idOnly): there the run id is ambiguous, and the places say where
    if (idOnly) throw new ReplayLookupError(`run id ${quote(target)} is ambiguous under ${quote(rootDir)}: it is in more than one place: ${places}`);
    throw new ReplayLookupError(`run ${quote(target)} is in more than one place: ${places}; pass one of the run directories`);
  }
  return { ...runDirShape(found[0]), via: 'runId' };
}

// ---- the source ----------------------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.runDir] the run directory <session>/subagents/workflows/wf_<id> ...
 * @param {string} [options.root] ... or a projects root together with
 * @param {string} [options.runId] the run id to look up under it
 * @param {number} [options.speed] default 4, clamped to 0.25..100
 * @param {(event: object) => void} [options.onEvent] or pass the callback to start()
 * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers] test hook
 * @param {(sessionDir: string, runId: string) => Promise<object[]>} [options.readRun] test hook, default readRunDir
 * @returns {{ start(onEvent?: (event: object) => void): Promise<void>, stop(): void }}
 */
export function createReplaySource({ runDir, root, runId, speed = DEFAULT_SPEED, onEvent, timers = { setTimeout, clearTimeout }, readRun = readRunDir } = {}) {
  const byDir = runDir !== undefined;
  if (byDir === (runId !== undefined)) throw new TypeError('createReplaySource: give either runDir or runId (with an optional root), not both and not neither');
  if (byDir && typeof runDir !== 'string') throw new TypeError('createReplaySource: runDir must be a string');
  if (!byDir && typeof runId !== 'string') throw new TypeError('createReplaySource: runId must be a string');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('createReplaySource: onEvent must be a function');
  normalizeSpeed(speed);

  let epoch = 0; // bumped by stop() and by every start(): a pass that sees a newer epoch has been superseded
  let timer = null; // the one pending timer
  let active = null; // the promise of the start() that is reading or emitting

  function stop() {
    epoch += 1;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    active = null;
  }

  async function begin(handler, myEpoch) {
    const where = byDir ? await checkRunDirectory(runDir) : await locateRun({ target: runId, root });
    if (epoch !== myEpoch) return; // stopped while the run was being looked up: read nothing
    const events = await readRun(where.sessionDir, where.runId);
    if (epoch !== myEpoch) return; // stopped while reading: schedule nothing
    if (events.length === 0) throw new Error(`run ${quote(where.runId)} has no events to replay (${quote(where.runDir)})`);
    const entries = buildSchedule(events, speed);

    let next = 0;
    let waited = false; // the timer for entries[next] has fired
    const step = () => {
      timer = null;
      while (epoch === myEpoch && next < entries.length) {
        const { event, delayMs } = entries[next];
        if (delayMs > 0 && !waited) {
          waited = true;
          timer = timers.setTimeout(step, delayMs);
          return;
        }
        waited = false;
        next += 1;
        try {
          handler({ ...event, src: SRC });
        } catch (err) {
          process.emitWarning(`wfviz replay: onEvent threw: ${err?.message ?? err}`);
        }
      }
      if (epoch === myEpoch && next >= entries.length) active = null; // done: the run stays as read
    };
    step();
  }

  function start(callback) {
    const handler = typeof callback === 'function' ? callback : onEvent;
    if (typeof handler !== 'function') return Promise.reject(new TypeError('createReplaySource: start() needs an onEvent function (as an option or as the argument)'));
    if (active !== null) return active;
    const myEpoch = (epoch += 1);
    const run = begin(handler, myEpoch).catch((err) => {
      if (epoch === myEpoch) active = null;
      else return; // superseded by stop(): nobody is waiting for the failure
      throw err;
    });
    active = run;
    return run;
  }

  return { start, stop };
}
