// test/source/replay.test.mjs: the replay source (src/source/replay.mjs, docs/contract.md section 1 "Replay").
// The pure schedule is tested on hand-built events (exact numbers) and on a real fixture run; the source is
// driven with injected timers, so no test waits for a delay, except one run at speed 100 on real timers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readRunDir } from '../../src/source/claude-fs.mjs';
import {
  DEFAULT_SPEED, MAX_DELAY_MS, MAX_SPEED, MIN_SPEED, ReplayLookupError, buildSchedule, createReplaySource, locateRun, normalizeSpeed, quote,
  runDirShape, scheduleKey,
} from '../../src/source/replay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const RUN_ID = 'wf_6509ce25-20a';
const FAILED_RUN_ID = 'wf_26eb8d70-5c4';
const SESSION_DIR = path.join(ROOT, '-Volumes-MacMiniExt-Documents-work-incubator-adversarial-review-loop', '331703e5-9ca1-4323-b4b8-fccdb8917c4e');
const RUN_DIR = path.join(SESSION_DIR, 'subagents', 'workflows', RUN_ID);

const tmp = (t, prefix = 'wfviz-replay-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const withoutSrc = ({ src, ...rest }) => rest;

// ---- hand-built events ---------------------------------------------------------------------------------

const ev = (kind, ts, data = {}, extra = {}) => ({ src: 'claude-fs', kind, runId: 'wf_t', sessionId: null, project: null, ts, prov: { file: '/f', line: null }, data, ...extra });

// A journal start/result carries a file time; the transcript events carry the record times.
function small() {
  return [
    ev('run.launched', 9_000_000),
    ev('agent.started', 9_000_000, { agentId: 'a1', key: 'k1' }),
    ev('agent.result', 9_000_000, { agentId: 'a1', key: 'k1', result: 'r' }),
    ev('agent.prompt', 1_000, { agentId: 'a1', text: 'p' }),
    ev('agent.activity', 1_400, { agentId: 'a1', tool: 'Read' }),
    ev('agent.activity', 2_400, { agentId: 'a1', text: 't' }),
    ev('run.final', 3_000, { status: 'completed' }),
  ];
}

test('scheduleKey: journal start/result are keyed by the agent\'s first/last transcript ts, a head by the floor, everything else by its own ts', () => {
  const events = small();
  const spans = new Map([['a1', { first: 1_000, last: 2_400 }]]);
  assert.equal(scheduleKey(events[1], spans), 1_000);
  assert.equal(scheduleKey(events[2], spans), 2_400);
  assert.equal(scheduleKey(events[0], spans), 9_000_000, 'run.launched with no floor keeps its own ts');
  assert.equal(scheduleKey(events[3], spans), 1_000);
  assert.equal(scheduleKey(events[6], spans), 3_000);
  assert.equal(scheduleKey(ev('agent.started', 55, { agentId: 'nobody' }), spans), 55, 'no transcript: the journal event keeps its own ts');
  assert.equal(scheduleKey(ev('agent.failed', 66, { agentId: 'a1' }), spans), 66, 'failed is not rekeyed');
  assert.equal(scheduleKey(ev('agent.meta', Number.NaN, {}), spans), null, 'no finite ts: no key of its own');
  assert.equal(scheduleKey(ev('agent.meta', '12', {}), spans), null, 'a text ts is not a ts');
});

test('scheduleKey: run.script and run.launched take the floor (the smallest key of the other events); other kinds ignore it', () => {
  const spans = new Map([['a1', { first: 1_000, last: 2_400 }]]);
  for (const kind of ['run.script', 'run.launched']) {
    assert.equal(scheduleKey(ev(kind, 9_000_000), spans, 1_000), 1_000, `${kind} with a floor`);
    assert.equal(scheduleKey(ev(kind, 5), spans, 1_000), 1_000, `${kind}: the floor, even when its own ts is smaller`);
    assert.equal(scheduleKey(ev(kind, 9_000_000), spans, undefined), 9_000_000, `${kind} without a floor`);
    assert.equal(scheduleKey(ev(kind, 9_000_000), spans, null), 9_000_000, `${kind}: null is no floor`);
    assert.equal(scheduleKey(ev(kind, 9_000_000), spans, Number.NaN), 9_000_000, `${kind}: NaN is no floor`);
    assert.equal(scheduleKey(ev(kind, Number.NaN), spans), null, `${kind}: no floor and no finite ts: no key`);
    assert.equal(scheduleKey(ev(kind, Number.NaN), spans, 7), 7, `${kind}: the floor does not need an own ts`);
  }
  assert.equal(scheduleKey(ev('agent.started', 9_000_000, { agentId: 'a1' }), spans, 5), 1_000, 'agent.started keeps its span key');
  assert.equal(scheduleKey(ev('agent.activity', 4_000, { agentId: 'a1' }), spans, 5), 4_000, 'a floor changes no other kind');
  assert.equal(scheduleKey(ev('agent.meta', Number.NaN), spans, 5), null);
});

test('buildSchedule: order by key, ties in reader order, delay = key gap / speed, first delay 0', () => {
  const events = small();
  const s = buildSchedule(events, 1);
  // keys: launched 1000 (the smallest key of the others: its own 9e6 is a file time), started 1000, prompt 1000, activity 1400,
  // result 2400 (reader index 2, before activity#2 at index 5), activity 2400, final 3000
  assert.deepEqual(s.map((x) => x.event.kind), ['run.launched', 'agent.started', 'agent.prompt', 'agent.activity', 'agent.result', 'agent.activity', 'run.final']);
  assert.deepEqual(s.map((x) => x.delayMs), [0, 0, 0, 400, 1000, 0, 600]);
  assert.equal(s[0].event, events[0], 'the schedule holds the input objects, untouched');
  assert.equal(s[1].event, events[1]);
  assert.equal(s[4].event, events[2]);
  assert.equal(s[5].event, events[5], 'tie: the journal result came first in reader order');
  assert.equal(s[0].event.ts, 9_000_000, 'the head keeps its own ts');
  assert.ok(events.every((e) => e.src === 'claude-fs'), 'the input is not changed');
});

test('buildSchedule: divide first, then cap (speed 0.25 and a 1000 ms gap give 2000, a 400 ms gap gives 1600)', () => {
  const two = (gap) => [ev('agent.activity', 100), ev('run.final', 100 + gap)];
  assert.equal(buildSchedule(two(1000), 0.25)[1].delayMs, 2000);
  assert.equal(buildSchedule(two(400), 0.25)[1].delayMs, 1600);
  assert.equal(buildSchedule(two(5000), 2)[1].delayMs, 2000);
  assert.equal(buildSchedule(two(5000), 4)[1].delayMs, 1250);
  assert.equal(buildSchedule(two(100), 100)[1].delayMs, 1);
  assert.equal(buildSchedule(two(0), 4)[1].delayMs, 0);
  assert.equal(buildSchedule(two(1e9), 100)[1].delayMs, MAX_DELAY_MS);
  assert.equal(buildSchedule(two(1000))[1].delayMs, 1000 / DEFAULT_SPEED, 'default speed 4');
});

test('buildSchedule: speed is clamped to 0.25..100', () => {
  const two = [ev('agent.activity', 0), ev('run.final', 400)];
  assert.equal(buildSchedule(two, 0.001)[1].delayMs, 1600, 'below the range: 0.25');
  assert.equal(buildSchedule(two, 1e6)[1].delayMs, 4, 'above the range: 100');
  assert.equal(buildSchedule(two, Infinity)[1].delayMs, 4, 'Infinity gives 100');
});

test('normalizeSpeed: numbers above 0 are clamped; NaN, 0, negatives, text and non-numbers are a TypeError', () => {
  assert.equal(normalizeSpeed(8), 8);
  assert.equal(normalizeSpeed(0.25), MIN_SPEED);
  assert.equal(normalizeSpeed(100), MAX_SPEED);
  assert.equal(normalizeSpeed(0.01), 0.25);
  assert.equal(normalizeSpeed(1000), 100);
  assert.equal(normalizeSpeed(Infinity), 100);
  for (const bad of [Number.NaN, 0, -1, -Infinity, '4', '', null, undefined, {}, [4], true]) {
    assert.throws(() => normalizeSpeed(bad), TypeError, String(bad));
  }
  assert.throws(() => buildSchedule([], 0), TypeError);
  assert.throws(() => createReplaySource({ runDir: RUN_DIR, speed: 'fast' }), TypeError);
  assert.throws(() => createReplaySource({ runDir: RUN_DIR, speed: 0 }), TypeError);
});

test('buildSchedule: an event without a finite ts is still emitted, keyed like the event before it', () => {
  const events = [ev('agent.activity', 1000), ev('agent.meta', undefined), ev('agent.activity', Number.NaN, { agentId: 'x' }), ev('run.final', 1500), ev('agent.meta', null)];
  const s = buildSchedule(events, 1);
  assert.equal(s.length, 5);
  assert.deepEqual(s.map((x) => x.event), [events[0], events[1], events[2], events[3], events[4]], 'reader order kept: all keys are 1000, 1000, 1000, 1500, 1500');
  assert.deepEqual(s.map((x) => x.delayMs), [0, 0, 0, 500, 0]);
  // leading events borrow the first key that follows; with no finite ts at all every delay is 0
  const lead = buildSchedule([ev('agent.meta', undefined), ev('agent.activity', 700), ev('run.final', 900)], 1);
  assert.deepEqual(lead.map((x) => x.delayMs), [0, 0, 200]);
  assert.deepEqual(buildSchedule([ev('agent.meta', undefined), ev('agent.meta', Number.NaN)], 1).map((x) => x.delayMs), [0, 0]);
  assert.deepEqual(buildSchedule([], 1), []);
  // a head is keyed by the smallest key of the others: with run.launched in place of the first activity, the only finite key
  // among the others is run.final's 1500, so the head and the keyless events all take it and nothing waits
  const withHead = [ev('run.launched', 1000), ...events.slice(1)];
  assert.deepEqual(buildSchedule(withHead, 1).map((x) => x.delayMs), [0, 0, 0, 0, 0]);
  const leadHead = buildSchedule([ev('agent.meta', undefined), ev('run.launched', 700), ev('run.final', 900)], 1);
  assert.deepEqual(leadHead.map((x) => x.delayMs), [0, 0, 0], 'the head takes the floor 900; the leading keyless event borrows it');
});

test('buildSchedule: an agent with a result but no transcript keeps its journal ts for both events, started first', () => {
  const events = [ev('agent.result', 500, { agentId: 'z', result: 'r' }), ev('agent.started', 500, { agentId: 'z' })];
  const s = buildSchedule(events, 1);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.delayMs), [0, 0]);
});

// ---- the schedule of a real run ------------------------------------------------------------------------

test('schedule of the saved run wf_6509ce25-20a: 31 events, heads first, starts before results, delays bounded, the late events', async () => {
  const events = await readRunDir(SESSION_DIR, RUN_ID);
  assert.equal(events.length, 31);
  const heads = events.filter((e) => e.kind === 'run.script' || e.kind === 'run.launched');
  assert.equal(heads.length, 2);
  for (const speed of [0.25, 4, 100]) {
    const s = buildSchedule(events, speed);
    assert.equal(s.length, events.length, `speed ${speed}: every event is scheduled once`);
    assert.deepEqual([...s.map((x) => x.event)].sort((a, b) => events.indexOf(a) - events.indexOf(b)), events);
    assert.equal(s[0].delayMs, 0);
    for (const { delayMs } of s) assert.ok(delayMs >= 0 && delayMs <= MAX_DELAY_MS, `speed ${speed}: delay ${delayMs}`);
    const at = (kind, agentId) => s.findIndex((x) => x.event.kind === kind && x.event.data.agentId === agentId);
    const agents = [...new Set(events.filter((e) => e.kind === 'agent.started').map((e) => e.data.agentId))];
    assert.equal(agents.length, 5);
    for (const id of agents) assert.ok(at('agent.started', id) < at('agent.result', id), `${id}: start before result`);
    // run.script and run.launched go out first, in reader order, with no wait before the next event; their values are the file's
    assert.deepEqual([s[0].event, s[1].event], heads, `speed ${speed}: the two heads first, in reader order`);
    assert.deepEqual(s.slice(0, 3).map((x) => x.delayMs), [0, 0, 0], `speed ${speed}: no wait after the heads`);
    assert.ok(s[0].event.ts === heads[0].ts && s[1].event.ts === heads[1].ts, 'the heads keep their file time as ts');
    // measured consequence: run.final lands at index 25, then only the five agent.meta (a file time each)
    assert.equal(s.findIndex((x) => x.event.kind === 'run.final'), 25);
    assert.deepEqual(s.slice(26).map((x) => x.event.kind), ['agent.meta', 'agent.meta', 'agent.meta', 'agent.meta', 'agent.meta']);
  }
  assert.ok(Math.max(...buildSchedule(events, 0.25).map((x) => x.delayMs)) <= 2000, 'speed 0.25: capped');
  assert.equal(buildSchedule(events, 0.25).filter((x) => x.delayMs === 2000).length >= 1, true, 'speed 0.25: the cap is reached');
  // at speed 100 the run's own 13 s of transcript time takes well under 2 s, the rest is the capped jump to the file times
  const fast = buildSchedule(events, 100).slice(0, 26).reduce((sum, x) => sum + x.delayMs, 0);
  assert.ok(fast < 200, `the transcript part at speed 100 takes ${fast} ms`);
});

test('schedule: run.script and run.launched go out first wherever the reader put them; absent ones are not invented', () => {
  const script = ev('run.script', 9_500_000, { scriptPath: '/s.js' });
  const launched = ev('run.launched', 9_000_000);
  const rest = [ev('agent.prompt', 1_000, { agentId: 'a1', text: 'p' }), ev('agent.started', 9_000_000, { agentId: 'a1' }), ev('agent.activity', 1_600, { agentId: 'a1' }), ev('run.final', 2_000)];
  const kinds = (events) => buildSchedule(events, 1).map((x) => x.event.kind);
  const tail = ['agent.prompt', 'agent.started', 'agent.activity', 'run.final'];
  // reader order: script last, as when it is read through the final file's scriptPath
  assert.deepEqual(kinds([launched, ...rest, script]), ['run.launched', 'run.script', ...tail]);
  assert.deepEqual(kinds([script, launched, ...rest]), ['run.script', 'run.launched', ...tail]);
  assert.deepEqual(kinds([...rest, launched, script]), ['run.launched', 'run.script', ...tail], 'the heads keep their reader order among themselves');
  assert.deepEqual(kinds([...rest, script, launched]), ['run.script', 'run.launched', ...tail]);
  // no run.script, no run.launched, or neither: nothing is added and the run starts with its earliest other event
  assert.deepEqual(kinds([...rest, script]), ['run.script', ...tail]);
  assert.deepEqual(kinds([launched, ...rest]), ['run.launched', ...tail]);
  assert.deepEqual(kinds(rest), tail);
  // the delay before the first event after the heads is 0; the gaps after it are the ones between the others
  const s = buildSchedule([...rest, launched, script], 1);
  assert.deepEqual(s.map((x) => x.delayMs), [0, 0, 0, 0, 600, 400]);
  // a run with only heads: their own ts is the key (nothing else to go by), the gap of 500 s is capped at 2000 ms
  assert.deepEqual(buildSchedule([script, launched], 1).map((x) => [x.event.kind, x.delayMs]), [['run.launched', 0], ['run.script', 2000]]);
  assert.deepEqual(buildSchedule([script, { ...launched, ts: 9_500_300 }], 1).map((x) => [x.event.kind, x.delayMs]), [['run.script', 0], ['run.launched', 300]]);
  // values and objects are untouched, and nothing is written into the events
  const input = [launched, ...rest, script];
  const before = JSON.stringify(input);
  const out = buildSchedule(input, 4);
  assert.equal(JSON.stringify(input), before);
  assert.ok(out.every((x) => input.includes(x.event)), 'the schedule holds the input objects');
  assert.equal(out[0].event.ts, 9_000_000);
  assert.equal(out[1].event.ts, 9_500_000);
});

test('schedule of the second saved run (failed): same invariants', async () => {
  const events = await readRunDir(SESSION_DIR, FAILED_RUN_ID);
  assert.ok(events.length > 0);
  const s = buildSchedule(events, 4);
  assert.equal(s.length, events.length);
  for (const id of new Set(events.filter((e) => e.kind === 'agent.started').map((e) => e.data.agentId))) {
    const a = s.findIndex((x) => x.event.kind === 'agent.started' && x.event.data.agentId === id);
    const b = s.findIndex((x) => x.event.kind === 'agent.result' && x.event.data.agentId === id);
    assert.ok(a >= 0 && (b < 0 || a < b), id);
  }
  for (const { delayMs } of s) assert.ok(delayMs >= 0 && delayMs <= MAX_DELAY_MS);
});

// ---- the source with injected timers -------------------------------------------------------------------

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  const log = [];
  return {
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { fn, ms });
        log.push(ms);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    log,
    count: () => pending.size,
    // fires the one pending timer; returns its delay
    fire() {
      assert.equal(pending.size, 1, 'exactly one pending timer');
      const [[id, { fn, ms }]] = [...pending];
      pending.delete(id);
      fn();
      return ms;
    },
    drain() {
      let n = 0;
      while (pending.size) {
        this.fire();
        n++;
      }
      return n;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

test('source on the saved run: every event once, src "replay", every other value as readRunDir gave it, nothing mutated', async () => {
  const expected = await readRunDir(SESSION_DIR, RUN_ID);
  const frozen = structuredClone(expected);
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, speed: 8, onEvent: (e) => got.push(e), timers: clock.timers });
  await source.start();
  assert.ok(got.length >= 1, 'the first events are out when start() resolves');
  clock.drain();
  assert.equal(got.length, expected.length);
  assert.ok(got.every((e) => e.src === 'replay'));
  const key = (e) => JSON.stringify([e.kind, e.runId, e.prov, e.ts, e.data]);
  assert.deepEqual(got.map(withoutSrc).map(key).sort(), expected.map(withoutSrc).map(key).sort());
  const byKey = new Map(expected.map((e) => [key(e), e]));
  for (const e of got) assert.deepEqual(withoutSrc(e), withoutSrc(byKey.get(key(e))), 'every field of the event, ts and prov included, is the one read');
  assert.deepEqual(expected, frozen, 'readRunDir\'s objects are not mutated');
  assert.ok(expected.every((e) => e.src === 'claude-fs'));
  assert.equal(clock.count(), 0, 'no timer left after the last event');
  assert.ok(clock.log.every((ms) => ms > 0 && ms <= MAX_DELAY_MS));
  // the order is the schedule's
  assert.deepEqual(got.map((e) => e.kind), buildSchedule(expected, 8).map((x) => x.event.kind));
});

test('source: no loop and no restart at the end; a new start() after the end replays again', async () => {
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, speed: 100, onEvent: (e) => got.push(e), timers: clock.timers });
  await source.start();
  clock.drain();
  const total = got.length;
  assert.equal(total, 31);
  await tick();
  assert.equal(clock.count(), 0);
  assert.equal(got.length, total, 'nothing more arrives');
  await source.start();
  clock.drain();
  assert.equal(got.length, 2 * total);
});

test('source: one timer at a time, the delays are the schedule\'s, a zero delay is not a timer', async () => {
  const events = await readRunDir(SESSION_DIR, RUN_ID);
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, speed: 4, onEvent: (e) => got.push(e), timers: clock.timers });
  await source.start();
  const wanted = buildSchedule(events, 4).map((x) => x.delayMs);
  const seen = [];
  while (clock.count() > 0) {
    assert.equal(clock.count(), 1);
    seen.push(clock.fire());
  }
  assert.deepEqual(seen, wanted.filter((d) => d > 0));
});

test('source: stop() cancels the pending timer, is safe twice, and nothing is emitted afterwards', async () => {
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, onEvent: (e) => got.push(e), timers: clock.timers });
  await source.start();
  clock.fire();
  const before = got.length;
  assert.equal(clock.count(), 1);
  source.stop();
  assert.equal(clock.count(), 0, 'pending timers are 0 after stop()');
  source.stop();
  assert.equal(clock.count(), 0);
  await tick();
  assert.equal(got.length, before);
});

test('source: stop() while the run is still being read schedules nothing; a later start() works', async () => {
  const gate = deferred();
  const reading = deferred();
  const events = small();
  let reads = 0;
  const readRun = () => {
    if (++reads > 1) return Promise.resolve(events);
    reading.resolve();
    return gate.promise;
  };
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, onEvent: (e) => got.push(e), timers: clock.timers, readRun });
  const first = source.start();
  await reading.promise; // readRun is running and not finished
  source.stop();
  gate.resolve(events);
  await first; // resolves, does not reject
  assert.equal(got.length, 0, 'nothing emitted by the stopped start()');
  assert.equal(clock.count(), 0, 'nothing scheduled by the stopped start()');

  await source.start();
  clock.drain();
  assert.equal(got.length, events.length, 'the later start() replays the run');
});

test('source: a read that fails after stop() is not reported; one that fails while running makes start() reject', async () => {
  const gate = deferred();
  const reading = deferred();
  const stopped = createReplaySource({ runDir: RUN_DIR, onEvent() {}, readRun: () => (reading.resolve(), gate.promise) });
  const p = stopped.start();
  await reading.promise;
  stopped.stop();
  gate.reject(new Error('late failure'));
  await p; // resolves: nobody is waiting for the failure of a stopped start()

  // stop() before the read begins: readRun is never called
  let called = false;
  const early = createReplaySource({ runDir: RUN_DIR, onEvent() {}, readRun: async () => { called = true; return small(); } });
  const q = early.start();
  early.stop();
  await q;
  assert.equal(called, false, 'a start() stopped while the run was being looked up reads nothing');

  const failing = createReplaySource({ runDir: RUN_DIR, onEvent() {}, readRun: async () => { throw new Error('cannot read'); } });
  await assert.rejects(failing.start(), /cannot read/);
  await assert.rejects(failing.start(), /cannot read/, 'a failed start leaves the source ready to try again');
});

test('source: a run without events is an error, not an empty replay', async () => {
  const source = createReplaySource({ runDir: RUN_DIR, onEvent() {}, readRun: async () => [] });
  await assert.rejects(source.start(), /no events to replay/);
});

test('source: onEvent may call stop(); nothing follows it, no timer is left', async () => {
  const clock = fakeTimers();
  const got = [];
  let source;
  source = createReplaySource({
    runDir: RUN_DIR,
    timers: clock.timers,
    onEvent: (e) => {
      got.push(e);
      if (got.length === 3) source.stop();
    },
  });
  await source.start();
  clock.drain();
  assert.equal(got.length, 3);
  assert.equal(clock.count(), 0);
});

test('source: onEvent that throws does not end the replay (a process warning is raised instead)', async (t) => {
  const warnings = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = (message) => warnings.push(String(message)); // keeps the test output quiet
  t.after(() => { process.emitWarning = emitWarning; });
  const clock = fakeTimers();
  let calls = 0;
  const source = createReplaySource({ runDir: RUN_DIR, timers: clock.timers, onEvent: () => { calls++; throw new Error('listener broke'); } });
  await source.start();
  clock.drain();
  assert.equal(calls, 31);
  await tick();
  assert.equal(warnings.length, 31);
  assert.ok(warnings.every((m) => /onEvent threw: listener broke/.test(m)));
});

test('source: start(onEvent) takes the callback as an argument and wins over the option; none at all is a TypeError', async () => {
  const clock = fakeTimers();
  const viaOption = [];
  const viaStart = [];
  const source = createReplaySource({ runDir: RUN_DIR, onEvent: (e) => viaOption.push(e), timers: clock.timers });
  await source.start((e) => viaStart.push(e));
  clock.drain();
  assert.equal(viaOption.length, 0);
  assert.equal(viaStart.length, 31);
  await assert.rejects(createReplaySource({ runDir: RUN_DIR }).start(), TypeError);
});

test('source: start() while a replay is in progress does not start a second one', async () => {
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ runDir: RUN_DIR, onEvent: (e) => got.push(e), timers: clock.timers });
  const a = source.start();
  const b = source.start();
  await Promise.all([a, b]);
  clock.drain();
  assert.equal(got.length, 31, 'one replay, not two');
});

test('createReplaySource: runDir or runId, never both and never neither; bad types are a TypeError', () => {
  assert.throws(() => createReplaySource({}), TypeError);
  assert.throws(() => createReplaySource(), TypeError);
  assert.throws(() => createReplaySource({ runDir: RUN_DIR, runId: RUN_ID }), TypeError);
  assert.throws(() => createReplaySource({ runDir: 5 }), TypeError);
  assert.throws(() => createReplaySource({ runId: 5 }), TypeError);
  assert.throws(() => createReplaySource({ runDir: RUN_DIR, onEvent: 'x' }), TypeError);
  assert.doesNotThrow(() => createReplaySource({ runDir: RUN_DIR }));
  assert.doesNotThrow(() => createReplaySource({ root: ROOT, runId: RUN_ID }));
});

test('source with (root, runId): looks the run up and replays it', async () => {
  const clock = fakeTimers();
  const got = [];
  const source = createReplaySource({ root: ROOT, runId: FAILED_RUN_ID, speed: 50, onEvent: (e) => got.push(e), timers: clock.timers });
  await source.start();
  clock.drain();
  const expected = await readRunDir(SESSION_DIR, FAILED_RUN_ID);
  assert.equal(got.length, expected.length);
  assert.ok(got.every((e) => e.src === 'replay' && e.runId === FAILED_RUN_ID));
});

test('source with a runDir that is not a run directory: start() rejects with a lookup error, no run id lookup is tried', async () => {
  for (const runDir of [SESSION_DIR, path.join(SESSION_DIR, 'workflows'), RUN_ID, path.join(os.tmpdir(), 'wfviz-nope', RUN_ID)]) {
    const source = createReplaySource({ runDir, onEvent() {} });
    await assert.rejects(source.start(), (err) => err instanceof ReplayLookupError && /is not a run directory/.test(err.message), runDir);
  }
});

test('source on real timers at speed 100: all events arrive, src replay, and the process has nothing left to wait for', async () => {
  const expected = await readRunDir(SESSION_DIR, RUN_ID);
  const got = [];
  const started = performance.now();
  const source = createReplaySource({ runDir: RUN_DIR, speed: 100, onEvent: (e) => got.push(e) });
  await source.start();
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (got.length === expected.length) (clearInterval(poll), resolve());
    }, 20);
  });
  const took = performance.now() - started;
  assert.ok(took < 5000, `took ${took} ms`);
  assert.deepEqual(got.map(withoutSrc).map((e) => e.kind).sort(), expected.map((e) => e.kind).sort());
  assert.ok(got.every((e) => e.src === 'replay'));
  source.stop();
});

// ---- finding the run -----------------------------------------------------------------------------------

test('runDirShape: <session>/subagents/workflows/wf_<id> only', () => {
  assert.deepEqual(runDirShape(RUN_DIR), { sessionDir: SESSION_DIR, runId: RUN_ID, runDir: RUN_DIR });
  assert.deepEqual(runDirShape(`${RUN_DIR}/`), { sessionDir: SESSION_DIR, runId: RUN_ID, runDir: RUN_DIR }, 'a trailing slash is fine');
  for (const bad of [SESSION_DIR, path.join(SESSION_DIR, 'workflows', RUN_ID), path.join(SESSION_DIR, 'subagents', RUN_ID), path.join(SESSION_DIR, 'subagents', 'workflows', 'notwf'), '/']) {
    assert.equal(runDirShape(bad), null, bad);
  }
});

test('locateRun: a run directory is used as it is; a run id is looked up under the root', async () => {
  const a = await locateRun({ target: RUN_DIR });
  assert.deepEqual(a, { sessionDir: SESSION_DIR, runId: RUN_ID, runDir: RUN_DIR, via: 'directory' });
  const b = await locateRun({ target: FAILED_RUN_ID, root: ROOT });
  assert.equal(b.via, 'runId');
  assert.equal(b.runId, FAILED_RUN_ID);
  assert.equal(b.sessionDir, SESSION_DIR);
  assert.equal(b.runDir, path.join(SESSION_DIR, 'subagents', 'workflows', FAILED_RUN_ID));
  const rel = await locateRun({ target: path.relative(process.cwd(), RUN_DIR) });
  assert.equal(rel.runDir, RUN_DIR, 'a relative directory works');
});

test('locateRun: an unknown run id, a path that is no run directory and an empty target are errors with one-line messages', async () => {
  const cases = [
    [{ target: 'wf_nope', root: ROOT }, /no run "wf_nope" under /],
    [{ target: '../x', root: ROOT }, /"\.\.\/x" is not a run directory/],
    [{ target: SESSION_DIR, root: ROOT }, /is a directory but not a run directory/],
    [{ target: ROOT }, /is a directory but not a run directory/],
    [{ target: path.join(os.tmpdir(), 'wfviz-definitely-not-here', RUN_ID) }, /is not a run directory/],
    [{ target: '' }, /no run to replay/],
    [{ target: '   ' }, /no run to replay/],
    [{ target: undefined }, /no run to replay/],
    [{ target: 7 }, /no run to replay/],
  ];
  for (const [options, re] of cases) {
    await assert.rejects(locateRun(options), (err) => err instanceof ReplayLookupError && err.name === 'ReplayLookupError' && re.test(err.message) && !err.message.includes('\n'), JSON.stringify(options));
  }
});

test('locateRun: a run id never escapes the root; ".." and separators are not joined into a path', async (t) => {
  const outer = tmp(t);
  const root = path.join(outer, 'projects');
  fs.mkdirSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows', 'wf_inside'), { recursive: true });
  fs.mkdirSync(path.join(outer, 'subagents', 'workflows', 'wf_outside'), { recursive: true });
  assert.equal((await locateRun({ target: 'wf_inside', root })).runId, 'wf_inside');
  for (const target of ['..', '../subagents/workflows/wf_outside', 'wf_outside', '.', 'slug/sess/subagents/workflows/wf_inside']) {
    await assert.rejects(locateRun({ target, root }), ReplayLookupError, target);
  }
});

test('locateRun: a bare name that is a directory in the working directory but no run directory still means a run id', async (t) => {
  const dir = tmp(t);
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows', 'wf_here'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cwd', 'wf_here'), { recursive: true }); // a stray directory of the same name
  const previous = process.cwd();
  process.chdir(path.join(dir, 'cwd'));
  try {
    const found = await locateRun({ target: 'wf_here', root });
    assert.equal(found.via, 'runId');
    assert.equal(found.runDir, path.join(root, 'slug', 'sess', 'subagents', 'workflows', 'wf_here'));
  } finally {
    process.chdir(previous);
  }
});

// ---- idOnly: the target is only ever a run id under the root (the replay endpoint of the real server) ----

// <dir>/projects/slug/sess/subagents/workflows/<ids...> and a "cwd" that is itself <dir>/cwd/subagents/workflows
function idOnlyLayout(t, { inRoot = [], inCwd = [] } = {}) {
  const dir = fs.realpathSync(tmp(t));
  const root = path.join(dir, 'projects');
  fs.mkdirSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows'), { recursive: true });
  for (const id of inRoot) fs.mkdirSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows', id));
  const cwd = path.join(dir, 'cwd', 'sess', 'subagents', 'workflows');
  fs.mkdirSync(cwd, { recursive: true });
  for (const id of inCwd) fs.mkdirSync(path.join(cwd, id));
  return { dir, root, cwd, rootRun: (id) => path.join(root, 'slug', 'sess', 'subagents', 'workflows', id), cwdRun: (id) => path.join(cwd, id) };
}

async function inCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

test('locateRun idOnly: a run directory of that name under the process directory is never used; the root answers', async (t) => {
  const l = idOnlyLayout(t, { inRoot: ['wf_same'], inCwd: ['wf_same'] });
  await inCwd(l.cwd, async () => {
    const old = await locateRun({ target: 'wf_same', root: l.root });
    assert.deepEqual([old.via, old.runDir], ['directory', l.cwdRun('wf_same')], 'control: without the option the relative directory wins');
    const found = await locateRun({ target: 'wf_same', root: l.root, idOnly: true });
    assert.deepEqual(found, { sessionDir: path.join(l.root, 'slug', 'sess'), runId: 'wf_same', runDir: l.rootRun('wf_same'), via: 'runId' });
  });
});

test('locateRun idOnly: a run that only the process directory has is "no run", never read from there', async (t) => {
  const l = idOnlyLayout(t, { inRoot: [], inCwd: ['wf_only_here'] });
  await inCwd(l.cwd, async () => {
    assert.equal((await locateRun({ target: 'wf_only_here', root: l.root })).via, 'directory', 'control: without the option it is found in the working directory');
    await assert.rejects(locateRun({ target: 'wf_only_here', root: l.root, idOnly: true }), (err) => err instanceof ReplayLookupError && /no run "wf_only_here" under /.test(err.message) && !err.message.includes('\n'));
  });
});

test('locateRun idOnly: a path separator, "." and ".." are refused as one-line lookup errors, and nothing is stat-ed relative to the process directory', async (t) => {
  const l = idOnlyLayout(t, { inRoot: ['wf_ok'], inCwd: ['wf_ok'] });
  const targets = ['.', '..', './wf_ok', '../workflows/wf_ok', 'a/b', 'a\\b', l.cwdRun('wf_ok'), 'wf_ok/', '/', 'wf_x\nwfviz: forged'];
  const real = fs.promises.stat;
  const stated = [];
  fs.promises.stat = (...args) => (stated.push(String(args[0])), real(...args));
  try {
    await inCwd(l.cwd, async () => {
      for (const target of targets) {
        await assert.rejects(locateRun({ target, root: l.root, idOnly: true }), (err) => {
          assert.ok(err instanceof ReplayLookupError, target);
          assert.equal(err.name, 'ReplayLookupError');
          assert.doesNotMatch(err.message, /[\n\r]/, `one line for ${JSON.stringify(target)}`);
          assert.ok(err.message.includes(quote(target)), `the message quotes the target: ${err.message}`);
          return true;
        }, JSON.stringify(target));
      }
    });
  } finally {
    fs.promises.stat = real;
  }
  assert.deepEqual(stated, [], 'no stat at all: the target is not a path');
  // control: without the option the same working directory resolves "." and a relative run directory
  await inCwd(l.cwd, async () => {
    assert.equal((await locateRun({ target: './wf_ok', root: l.root })).via, 'directory');
    await assert.rejects(locateRun({ target: '.', root: l.root }), ReplayLookupError, 'the workflows directory is no run directory');
  });
  // "." inside a real run directory resolves to it without the option and is refused with it
  await inCwd(RUN_DIR, async () => {
    assert.equal((await locateRun({ target: '.', root: ROOT })).runDir, RUN_DIR);
    await assert.rejects(locateRun({ target: '.', root: ROOT, idOnly: true }), (err) => err instanceof ReplayLookupError && /"\." is not a run id/.test(err.message));
  });
});

test('locateRun idOnly: the empty target is still "no run to replay"; a valid id gives the same answer as without the option', async () => {
  for (const target of ['', '   ', undefined, 7]) {
    await assert.rejects(locateRun({ target, idOnly: true }), (err) => err instanceof ReplayLookupError && /no run to replay/.test(err.message), String(target));
  }
  const plain = await locateRun({ target: FAILED_RUN_ID, root: ROOT });
  assert.deepEqual(await locateRun({ target: FAILED_RUN_ID, root: ROOT, idOnly: true }), plain);
  assert.deepEqual(await locateRun({ target: FAILED_RUN_ID, root: ROOT, idOnly: false }), plain);
  await assert.rejects(locateRun({ target: 'wf_nope', root: ROOT, idOnly: true }), /no run "wf_nope" under /);
  await assert.rejects(locateRun({ target: RUN_ID, idOnly: true, root: path.join(os.tmpdir(), 'wfviz-no-such-root') }), /no run /);
});

test('locateRun: a directory under the root whose name has no wf_ prefix is no run (a lookup error, not a result without a runDir)', async (t) => {
  const l = idOnlyLayout(t, { inRoot: ['abc'] });
  for (const idOnly of [false, true]) {
    await assert.rejects(locateRun({ target: 'abc', root: l.root, idOnly }), (err) => err instanceof ReplayLookupError && /no run "abc" under /.test(err.message), `idOnly ${idOnly}`);
  }
});

test('locateRun: the same run id in two places is an error that names both, and for the command line tells to pass one of the run directories', async (t) => {
  const root = path.join(tmp(t), 'projects');
  for (const slug of ['one', 'two']) fs.mkdirSync(path.join(root, slug, 'sess', 'subagents', 'workflows', 'wf_dup'), { recursive: true });
  await assert.rejects(locateRun({ target: 'wf_dup', root }), (err) => {
    assert.ok(err instanceof ReplayLookupError);
    assert.match(err.message, /more than one place/);
    assert.ok(err.message.includes(path.join(root, 'one')) && err.message.includes(path.join(root, 'two')), err.message);
    assert.match(err.message, /; pass one of the run directories$/, 'a run directory can be passed on the command line');
    assert.doesNotMatch(err.message, /ambiguous/);
    assert.equal(err.message.includes('\n'), false, 'one line');
    return true;
  });
});

test('locateRun with idOnly: the same run id in two places says the run id is ambiguous under the root and names the places, and never tells to pass a run directory (it is refused there)', async (t) => {
  const root = path.join(tmp(t), 'projects');
  for (const slug of ['one', 'two']) fs.mkdirSync(path.join(root, slug, 'sess', 'subagents', 'workflows', 'wf_dup'), { recursive: true });
  await assert.rejects(locateRun({ target: 'wf_dup', root, idOnly: true }), (err) => {
    assert.ok(err instanceof ReplayLookupError);
    assert.match(err.message, /^run id "wf_dup" is ambiguous under /);
    assert.match(err.message, /more than one place/);
    assert.ok(err.message.includes(quote(path.resolve(root))), 'the root is named');
    const place = (slug) => quote(path.join(root, slug, 'sess', 'subagents', 'workflows', 'wf_dup'));
    assert.ok(err.message.endsWith(`: ${place('one')} and ${place('two')}`), `both places are named, each quoted: ${err.message}`);
    assert.doesNotMatch(err.message, /pass one of/);
    assert.equal(err.message.includes('\n'), false, 'one line');
    return true;
  });
  // three places: all of them
  const third = path.join(root, 'three', 'sess', 'subagents', 'workflows', 'wf_dup');
  fs.mkdirSync(third, { recursive: true });
  await assert.rejects(locateRun({ target: 'wf_dup', root, idOnly: true }), (err) => err.message.includes(quote(third)) && err.message.includes(quote(path.join(root, 'one', 'sess', 'subagents', 'workflows', 'wf_dup'))) && !/pass one of/.test(err.message));
  // a run id with a line break in it stays one quoted line
  const odd = 'wf_odd\nwfviz: forged';
  for (const slug of ['one', 'two']) fs.mkdirSync(path.join(root, slug, 'sess', 'subagents', 'workflows', odd), { recursive: true });
  await assert.rejects(locateRun({ target: odd, root, idOnly: true }), (err) => {
    assert.equal(err.message.includes('\n'), false, 'one line');
    assert.match(err.message, /^run id "wf_odd\\nwfviz: forged" is ambiguous under /);
    return true;
  });
});

test('locateRun: a file named like a run is not a run; the root may be missing', async (t) => {
  const root = path.join(tmp(t), 'projects');
  fs.mkdirSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, 'slug', 'sess', 'subagents', 'workflows', 'wf_file'), 'x');
  await assert.rejects(locateRun({ target: 'wf_file', root }), /no run "wf_file"/);
  await assert.rejects(locateRun({ target: 'wf_x', root: path.join(root, 'missing') }), /no run "wf_x" under /);
});

test('error messages echo a user-given run id as one JSON string: a newline or control character cannot forge a second line', async () => {
  const target = 'wf_x\nwfviz: forged\u001b[31m\u0085\u2028end';
  await assert.rejects(locateRun({ target, root: ROOT }), (err) => {
    assert.doesNotMatch(err.message, /[\n\r\u001b\u0085\u2028\u2029]/);
    assert.ok(err.message.includes('\\n') && err.message.includes('\\u001b') && err.message.includes('\\u0085') && err.message.includes('\\u2028'), err.message);
    return true;
  });
  assert.equal(quote('a"b'), '"a\\"b"');
  assert.equal(quote('\u007f'), '"\\u007f"');
});
