// test/server/web-replay.test.mjs (node replay-in-app): the replay of a finished run in the page.
//   part 1: the pure functions in web/lib.js (control state by run status and phase, speed, url, SSE parser, the frame queue that Pause and
//           Resume work on, checks of the stream); the queue runs on a fake clock and a fake timer;
//   part 2: app.js on a fake browser (a copy of the small fake DOM of web-u4.test.mjs, which is not imported: its tests would run twice) with a
//           fetch whose replay answer is a stream the test pushes into, a fake clock (performance.now) and fake timers that run only when a
//           test moves the clock (page.advance), and a fake EventSource for the real stream.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';
import { createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { buildSchedule, locateRun } from '../../src/source/replay.mjs';
import { test } from './helpers.mjs';

const {
  REPLAY_FINISHED, REPLAY_SPEEDS, DEFAULT_REPLAY_SPEED, canReplay, createReplayQueue, createSseParser, isRunningStatus, parseReplaySpeed, readReplayFrame,
  replayControl, replayCutText, replayFailure, replayHelloProblem, replayRunProblem, replayUrl, modeInfo,
} = lib;
const parseFragment = lib.parseHtml; // the page's own html as data

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(REPO, 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

const reg = (value, from = 'f:1') => ({ value, prov: 'registered', from });
const inf = (value, method = 'label-pattern') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });

function agent(id, label, over = {}) {
  const m = /^([^:#]+)(?::([^#]+))?(?:#(.+))?$/.exec(label ?? '');
  return {
    id,
    label: label ? reg(label) : unk('no label'),
    role: m ? inf(m[1]) : unk(), unit: m && m[2] ? inf(m[2]) : unk('no unit'), round: unk('no round'), tag: m && m[3] ? inf(m[3]) : unk('no tag'),
    phase: reg('P1'), state: reg('done'), startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(), ...over,
  };
}
function run(agents, over = {}) {
  return {
    id: 'wf_x', source: 'real', name: reg('a run'), status: fin('completed'), startedAt: inf(1000), durationMs: fin(5000),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] },
    totals: { agents: agents.length, running: 0, done: agents.length, failed: 0 }, ...over,
  };
}
const summary = (r) => ({ id: r.id, name: r.name, status: r.status, project: null, startedAt: r.startedAt, agents: r.totals.agents, running: r.totals.running, source: r.source });

// =====================================================================================================================
// part 1: the pure functions
// =====================================================================================================================

test('parseReplaySpeed: only the control\'s own values (1, 4, 20) are speeds; a missing, empty, text, 0 or other value is 4', () => {
  assert.deepEqual(REPLAY_SPEEDS, [1, 4, 20]);
  assert.equal(DEFAULT_REPLAY_SPEED, 4);
  for (const ok of [1, 4, 20]) {
    assert.equal(parseReplaySpeed(ok), ok);
    assert.equal(parseReplaySpeed(String(ok)), ok);
  }
  for (const bad of [null, undefined, '', ' ', 'abc', '0', '100', '2', '0.5', '4.0', '+4', '-1', '1e1', '020', '0x14', NaN, Infinity, 0, 100, 3, {}, [], true, '4 ']) {
    assert.equal(parseReplaySpeed(bad), 4, `${JSON.stringify(bad)} -> 4`);
  }
});

test('replayUrl: the run id is encoded, the speed is a number made from the control\'s values, never the text that was given', () => {
  assert.equal(replayUrl('wf_6509ce25-20a', 4), '/api/runs/wf_6509ce25-20a/replay?speed=4');
  assert.equal(replayUrl('a b/c?d', 20), '/api/runs/a%20b%2Fc%3Fd/replay?speed=20');
  assert.equal(replayUrl('wf_x', '1'), '/api/runs/wf_x/replay?speed=1');
  for (const hostile of ['1&speed=2', '4/../x', '100', 'abc', '']) assert.match(replayUrl('wf_x', hostile), /^\/api\/runs\/wf_x\/replay\?speed=4$/, hostile);
});

test('the status rule: only the value "running" is running; an unknown status (no value) is not, and the prov is never read; one rule for isRunningStatus and canReplay', () => {
  assert.equal(isRunningStatus({ value: 'running', prov: 'inferred', method: 'no-final-file' }), true);
  assert.equal(isRunningStatus({ value: 'running', prov: 'final', from: 'f:1' }), true, 'a final file that says running still says running');
  for (const s of [{ value: 'completed', prov: 'inferred', method: 'm' }, fin('failed'), fin('killed'), { value: 'stale', prov: 'inferred', method: 'm' }, unk(), { value: null, prov: 'unknown', reason: 'r' }, {}, null, undefined]) {
    assert.equal(isRunningStatus(s), false, JSON.stringify(s));
  }
  const status = fin('completed');
  assert.equal(canReplay({ source: 'real', status }), true);
  assert.equal(canReplay({ source: 'real', status: unk('the journal is not read yet') }), true, 'unknown status: offered (the server answers 409 only for "running")');
  assert.equal(canReplay({ source: 'real' }), true, 'a Run with no status Fact at all is not running');
  assert.equal(canReplay({ source: 'real', status: { value: 'running', prov: 'final', from: 'f' } }), false);
  for (const source of ['demo', 'replay', undefined, null, 'REAL', 'real ', 'something-new']) assert.equal(canReplay({ source, status }), false, `source ${JSON.stringify(source)}`);
  assert.equal(canReplay(null), false);
  assert.equal(canReplay(undefined), false);
  assert.equal(canReplay({}), false, 'a Run with no source gets no control');
});

test('replayControl: by run status with no replay, and by phase while there is one', () => {
  const done = { source: 'real', status: fin('completed') };
  const none = { speed: false, go: null, pause: null, stop: false, note: null };
  assert.deepEqual(replayControl(done, null), { ...none, speed: true, go: 'Replay' });
  assert.deepEqual(replayControl(done, undefined), { ...none, speed: true, go: 'Replay' });
  assert.deepEqual(replayControl({ source: 'real', status: unk() }, null), { ...none, speed: true, go: 'Replay' }, 'an unknown status counts as not running');
  for (const r of [{ source: 'real', status: { value: 'running', prov: 'inferred', method: 'm' } }, { source: 'demo', status: fin('completed') }, { source: 'replay', status: fin('completed') }, { status: fin('completed') }, null, undefined]) {
    assert.deepEqual(replayControl(r, null), none, JSON.stringify(r));
  }
  // while a replay is on, the Run on show is the replayed one: the control reads the real Run the replay was started from
  const replayed = { source: 'replay', status: { value: 'running', prov: 'inferred', method: 'm' } };
  const state = (phase, over = {}) => ({ phase, shown: true, real: done, line: null, ...over });
  for (const phase of ['connecting', 'playing']) assert.deepEqual(replayControl(replayed, state(phase)), { ...none, pause: 'Pause', stop: true }, phase);
  assert.deepEqual(replayControl(replayed, state('paused')), { ...none, pause: 'Resume', stop: true });
  assert.deepEqual(replayControl(replayed, state('ended')), { speed: true, go: 'Replay again', pause: null, stop: true, note: REPLAY_FINISHED });
  assert.equal(REPLAY_FINISHED, 'replay finished');
  // a failure before the replayed view began: the real view stays, the Replay control and the reason, no Stop; after it began: a way back
  assert.deepEqual(replayControl(done, state('failed', { shown: false, line: 'HTTP 409' })), { speed: true, go: 'Replay', pause: null, stop: false, note: 'HTTP 409' });
  assert.deepEqual(replayControl(replayed, state('failed', { shown: true, line: 'stream lost' })), { speed: true, go: 'Replay again', pause: null, stop: true, note: 'stream lost' });
  assert.equal(replayControl(replayed, state('failed', { shown: false, line: null })).note, 'the replay failed, no reason given', 'a failure always says something');
  // the real Run that cannot be replayed (it is no longer a finished real run) is not offered again
  const gone = state('ended', { real: { source: 'real', status: { value: 'running', prov: 'inferred', method: 'm' } } });
  assert.deepEqual(replayControl(replayed, gone), { ...none, stop: true, note: REPLAY_FINISHED });
  assert.deepEqual(replayControl(done, { phase: 'nonsense', real: done }), { ...none, speed: true, go: 'Replay' }, 'an unknown phase is no replay');
});

test('replayFailure: the error text of the body, else the status, else the error\'s own message', () => {
  assert.equal(replayFailure({ status: 409, body: { error: 'the run is still running' } }), 'the run is still running');
  assert.equal(replayFailure({ status: 429, body: { error: '3 replays are already open' } }), '3 replays are already open');
  assert.equal(replayFailure({ status: 409, body: null }), 'HTTP 409');
  assert.equal(replayFailure({ status: 404, body: { error: '' } }), 'HTTP 404');
  assert.equal(replayFailure({ status: 400, body: { error: 5 } }), 'HTTP 400');
  assert.equal(replayFailure({ status: 500, body: 'text' }), 'HTTP 500');
  assert.equal(replayFailure({ error: new Error('Failed to fetch') }), 'Failed to fetch');
  assert.equal(replayFailure({ error: 'plain' }), 'plain');
  assert.match(replayFailure({}), /no error text/);
  assert.match(replayFailure(), /no error text/);
});

test('replayHelloProblem and replayRunProblem: the stream must say mode replay for the run asked for, and its snapshots are that run, source replay', () => {
  assert.equal(replayHelloProblem({ mode: 'replay', version: '1', runId: 'wf_x' }, 'wf_x'), null);
  for (const bad of [{ mode: 'real', version: '1' }, { mode: 'replay', runId: 'wf_y' }, { mode: 'replay' }, { mode: 'demo', runId: 'wf_x' }, null, undefined, 'x', {}]) {
    assert.match(replayHelloProblem(bad, 'wf_x'), /unexpected hello/, JSON.stringify(bad));
  }
  assert.equal(replayRunProblem({ id: 'wf_x', source: 'replay' }, 'wf_x'), null);
  for (const bad of [{ id: 'wf_x', source: 'real' }, { id: 'wf_y', source: 'replay' }, { id: 'wf_x' }, { id: 'wf_x', source: 'demo' }, null, undefined]) {
    assert.match(replayRunProblem(bad, 'wf_x'), /not the replay of "wf_x"/, JSON.stringify(bad));
  }
  assert.equal(replayCutText(0), 'stream ended before the end (0 events played)');
  assert.equal(replayCutText(1), 'stream ended before the end (1 event played)');
  assert.equal(replayCutText(12), 'stream ended before the end (12 events played)');
});

test('createSseParser: frames from chunks, a frame cut anywhere waits for the rest, comments and unknown fields are skipped, CRLF and CR are line ends', () => {
  const text = ': heartbeat\n\nevent: hello\ndata: {"a":1}\n\nevent: event\ndata: {"seq":1}\n\n: heartbeat\n\nevent: end\ndata: {"events":1}\n\n';
  const whole = createSseParser().feed(text);
  assert.deepEqual(whole, [{ event: 'hello', data: '{"a":1}' }, { event: 'event', data: '{"seq":1}' }, { event: 'end', data: '{"events":1}' }]);
  // cut at every position into two chunks, and in single characters: the same frames
  for (let i = 0; i <= text.length; i++) {
    const p = createSseParser();
    assert.deepEqual([...p.feed(text.slice(0, i)), ...p.feed(text.slice(i))], whole, `cut at ${i}`);
  }
  const p = createSseParser();
  assert.deepEqual([...text].flatMap((c) => p.feed(c)), whole, 'one character at a time');
  // a frame that is cut waits: nothing is returned for it until its blank line
  const q = createSseParser();
  assert.deepEqual(q.feed('event: run\ndata: {"id":"wf'), []);
  assert.deepEqual(q.feed('_x"}\n'), []);
  assert.deepEqual(q.feed('\n'), [{ event: 'run', data: '{"id":"wf_x"}' }]);
  // line ends, data lines, defaults and fields that are not read
  const crs = createSseParser();
  assert.deepEqual(crs.feed('event: a\r\ndata: 1\r\n\r\ndata: 2\rdata: 3\r\r'), [], 'a chunk that ends with CR waits (it may be half of CRLF)');
  assert.deepEqual(crs.feed(': next\n'), [{ event: 'a', data: '1' }, { event: 'message', data: '2\n3' }]);
  const r = createSseParser();
  assert.deepEqual([...r.feed('event: a\r'), ...r.feed('\ndata: 1\r'), ...r.feed('\n\r'), ...r.feed('\n')], [{ event: 'a', data: '1' }], 'a chunk that ends with CR waits: it may be half of CRLF');
  assert.deepEqual(createSseParser().feed('id: 7\nretry: 100\nevent: x\ndata:no-space\n\n'), [{ event: 'x', data: 'no-space' }]);
  assert.deepEqual(createSseParser().feed('event: only-event\n\n'), [], 'a frame with no data is no frame');
  assert.deepEqual(createSseParser().feed('\n\n\n'), []);
  assert.deepEqual(createSseParser().feed('event: x\ndata: a: b\n\n'), [{ event: 'x', data: 'a: b' }], 'a colon inside the value');
  assert.deepEqual(createSseParser().feed('event: x\nevent: y\ndata: 1\n\n'), [{ event: 'y', data: '1' }], 'the last event field wins');
  const s = createSseParser();
  s.feed('event: x\ndata: 1\n\nevent: y\ndata: lost');
  assert.deepEqual(s.feed(''), [], 'a frame that never gets its blank line is not delivered');
});

test('readReplayFrame: the data is read as JSON; data that is not JSON is marked bad', () => {
  assert.deepEqual(readReplayFrame({ event: 'run', data: '{"id":"wf_x"}' }), { name: 'run', value: { id: 'wf_x' } });
  assert.deepEqual(readReplayFrame({ event: 'end', data: 'null' }), { name: 'end', value: null });
  assert.deepEqual(readReplayFrame({ event: 'event', data: '{"seq":' }), { name: 'event', bad: true });
  assert.deepEqual(readReplayFrame({ event: 'event', data: '' }), { name: 'event', bad: true });
  assert.deepEqual(readReplayFrame(null), { name: null, bad: true });
});

// A fake clock and a fake timer: a timer runs when the clock is moved past it, with the clock set to the timer's own time. `most` is the
// largest number of timers that were pending at once.
function fakeClock() {
  const c = { t: 0, timers: new Map(), n: 0, most: 0 };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { c.timers.set(++c.n, { fn, at: c.t + ms }); c.most = Math.max(c.most, c.timers.size); return c.n; };
  c.clearTimer = (id) => { c.timers.delete(id); };
  c.to = (t) => {
    for (;;) {
      let next = null;
      for (const [id, x] of c.timers) if (x.at <= t && (next === null || x.at < next.x.at)) next = { id, x };
      if (next === null) break;
      c.timers.delete(next.id);
      c.t = Math.max(c.t, next.x.at);
      next.x.fn();
    }
    c.t = t;
  };
  return c;
}
// a queue on a fake clock; `applied` is what it gave out, with the time of the clock when it did
function queueOn(clock, extra = {}) {
  const applied = [];
  const queue = createReplayQueue({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, apply: (name, value) => { applied.push({ name, value, t: clock.t }); extra.apply?.(name, value); } });
  return { queue, applied };
}
const seen = (applied) => applied.map((a) => `${a.name}${a.value ?? ''}@${a.t}`);

test('createReplayQueue: a pause with nothing kept holds back only what the pause held (arrivals at 0, 100 and 400 ms, a pause at 50 for 1000 ms: applied at 0, 1050 and 1350)', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  queue.push('event', 1); // at 0, playing, nothing kept: applied on arrival, no timer
  assert.deepEqual(seen(applied), ['event1@0']);
  assert.equal(clock.timers.size, 0, 'no timer for a frame that is applied on arrival');
  clock.to(50);
  queue.pause(); // nothing is kept
  clock.to(100); queue.push('event', 2);
  clock.to(400); queue.push('event', 3);
  assert.deepEqual(seen(applied), ['event1@0'], 'nothing is applied while paused');
  assert.equal(queue.size, 2);
  assert.equal(clock.timers.size, 0, 'and no timer waits');
  clock.to(1050);
  queue.resume(); // the first kept frame (arrived at 100) is shown at the resume: the view falls behind by 950, the pause time minus the time before its arrival
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050'], 'the first kept frame is shown at the resume');
  assert.equal(queue.offset, 950);
  assert.equal(clock.timers.size, 1, 'one timer waits for the next');
  clock.to(1349);
  assert.equal(applied.length, 2);
  clock.to(1350);
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050', 'event3@1350'], 'the gap between the kept frames is the gap they arrived with: 300');
  assert.equal(queue.size, 0);
  assert.equal(clock.timers.size, 0, 'no timer is left when the queue is empty');
  assert.equal(clock.most, 1, 'never more than one timer at a time');
});

test('createReplayQueue: a pause with a frame waiting keeps the wait it had left: the offset grows by the whole time paused', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  clock.to(10); queue.pause(); // nothing kept
  clock.to(100); queue.push('event', 1);
  clock.to(400); queue.push('event', 2);
  clock.to(1000); queue.resume(); // offset 900: 1 at 1000 (at the resume), 2 at 1300
  assert.deepEqual(seen(applied), ['event1@1000']);
  clock.to(1100); queue.pause(); // frame 2 is waiting, due 1300: 200 left
  assert.equal(clock.timers.size, 0);
  clock.to(1600); queue.resume(); // 500 ms paused with a frame kept: offset 1400, frame 2 at 1800
  assert.equal(queue.offset, 1400);
  assert.equal(applied.length, 1, 'not at the resume: it keeps its wait');
  clock.to(1799);
  assert.equal(applied.length, 1);
  clock.to(1800);
  assert.deepEqual(seen(applied), ['event1@1000', 'event2@1800']);
  assert.equal(clock.most, 1);
  // the flag belongs to each pause: this one had nothing kept (the queue is empty), so a frame that arrives in it is due at its own time
  clock.to(2000); queue.pause();
  clock.to(2400); queue.push('event', 3); // due 3800 with the offset of 1400
  clock.to(2500); queue.resume();
  assert.equal(queue.offset, 1400, 'nothing was kept at this pause: it adds nothing, however long it was');
  assert.equal(applied.length, 2);
  clock.to(3799);
  assert.equal(applied.length, 2);
  clock.to(3800);
  assert.equal(seen(applied).at(-1), 'event3@3800');
  assert.equal(clock.most, 1);
});

test('createReplayQueue: the offset never shrinks, whatever the clock does (a resume that is read earlier than its pause, a frame that is due after the resume)', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  clock.to(100); queue.pause();
  clock.t = 40; queue.resume(); // nothing kept, nothing arrived
  assert.equal(queue.offset, 0);
  clock.to(200); queue.pause();
  clock.to(300); queue.push('event', 1);
  clock.t = 250; queue.resume(); // the first kept frame is due after the resume
  assert.equal(queue.offset, 0);
  assert.equal(applied.length, 0);
  clock.to(300);
  assert.deepEqual(seen(applied), ['event1@300']);
  // a frame was kept at the pause
  clock.to(400); queue.pause(); // nothing kept
  clock.to(450); queue.push('event', 2);
  clock.t = 420; queue.pause(); // already paused: no change
  clock.t = 460; queue.resume(); // 2 was due at 450, 10 ms before
  assert.equal(queue.offset, 10);
  assert.deepEqual(seen(applied).at(-1), 'event2@460');
  clock.to(500); queue.pause(); // nothing kept
  clock.to(520); queue.push('event', 3); // due 530
  clock.to(540); queue.pause();
  clock.to(560); queue.resume();
  assert.ok(queue.offset >= 10, 'never smaller than before');
  // the offset a pause with a frame kept adds is never negative
  const c2 = fakeClock();
  const q2 = queueOn(c2);
  c2.to(10); q2.queue.pause();
  c2.to(20); q2.queue.push('event', 1);
  c2.to(30); q2.queue.push('event', 2);
  c2.to(60); q2.queue.resume(); // offset 40: 1 at 60, 2 at 70
  c2.to(65); q2.queue.pause(); // 2 is kept
  c2.t = 50; q2.queue.resume(); // the clock stepped back
  assert.equal(q2.queue.offset, 40, 'never shrinks');
});

test('createReplayQueue: the spec examples: a pause with nothing kept and no frame during it delays nothing; a frame that came late in the pause is shown at the resume; a frame waiting at the pause is delayed by the whole pause', () => {
  // pause at 100 with nothing kept, resume at 10100, a frame arriving at 10100: applied at 10100, no timer
  let clock = fakeClock();
  let q = queueOn(clock);
  clock.to(100); q.queue.pause();
  clock.to(10100); q.queue.resume();
  assert.equal(q.queue.offset, 0, 'nothing arrived during the pause, nothing was held back');
  q.queue.push('event', 1);
  assert.deepEqual(seen(q.applied), ['event1@10100']);
  assert.equal(clock.most, 0, 'no timer at all');
  // pause at 0 with nothing kept, a frame at 9900, resume at 10000: applied at 10000
  clock = fakeClock();
  q = queueOn(clock);
  q.queue.pause();
  clock.to(9900); q.queue.push('event', 1);
  assert.deepEqual(q.applied, []);
  clock.to(10000); q.queue.resume();
  assert.deepEqual(seen(q.applied), ['event1@10000']);
  assert.equal(q.queue.offset, 100, 'the frame was due 100 ms before the resume');
  assert.equal(clock.most, 0, 'it is due at once: no timer');
  // pause during catch-up: a frame waiting due at 1350, pause at 1200 for 500: applied at 1850
  clock = fakeClock();
  q = queueOn(clock);
  q.queue.push('event', 1);
  clock.to(50); q.queue.pause();
  clock.to(100); q.queue.push('event', 2);
  clock.to(400); q.queue.push('event', 3);
  clock.to(1050); q.queue.resume(); // 2 at 1050, 3 due 1350
  assert.deepEqual(seen(q.applied), ['event1@0', 'event2@1050']);
  clock.to(1200); q.queue.pause();
  clock.to(1700); q.queue.resume();
  clock.to(1849);
  assert.equal(q.applied.length, 2);
  clock.to(1850);
  assert.deepEqual(seen(q.applied), ['event1@0', 'event2@1050', 'event3@1850']);
  assert.equal(clock.most, 1);
});

test('createReplayQueue: two pauses add up (frames kept at each), also when the second comes while the queue catches up; the gaps are the gaps they arrived with', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  queue.push('event', 1);
  clock.to(50); queue.pause(); // nothing kept
  clock.to(100); queue.push('event', 2);
  clock.to(400); queue.push('event', 3);
  clock.to(900); queue.push('event', 4);
  clock.to(1050); queue.resume(); // offset 950: 2 at 1050, 3 at 1350, 4 at 1850
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050']);
  clock.to(1200); queue.pause(); // catching up: 3 and 4 are kept
  assert.equal(clock.timers.size, 0, 'a pause takes the timer away');
  clock.to(1300); queue.push('event', 5); // arrives while paused
  clock.to(1700); queue.resume(); // 500 more with frames kept: offset 1450: 3 at 1850, 4 at 2350, 5 at 2750
  assert.equal(queue.offset, 1450);
  clock.to(1849);
  assert.equal(applied.length, 2, 'frame 3 is not applied at 1350 any more');
  clock.to(1850);
  clock.to(2349);
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050', 'event3@1850']);
  clock.to(2350);
  clock.to(2749);
  assert.equal(applied.length, 4);
  clock.to(2750);
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050', 'event3@1850', 'event4@2350', 'event5@2750'], 'the gaps are the gaps they arrived with: 500, 500, 400');
  assert.equal(clock.most, 1);
  assert.equal(clock.timers.size, 0);
  // two pauses with a frame kept at both: the whole 300 and 100 ms are added to the 50 that the first one held back
  const c2 = fakeClock();
  const q2 = queueOn(c2);
  q2.queue.pause(); // at 0, nothing kept
  c2.to(100); q2.queue.push('event', 1);
  c2.to(150); q2.queue.resume(); // 1 is shown at the resume: offset 50
  c2.to(200); q2.queue.push('event', 2); // due 250
  c2.to(220); q2.queue.pause(); // 2 is kept
  c2.to(520); q2.queue.resume(); // 300 more: offset 350, 2 due 550
  assert.equal(q2.queue.offset, 350);
  c2.to(540); q2.queue.pause(); // still kept
  c2.to(640); q2.queue.resume(); // 100 more: offset 450, 2 due 650
  assert.equal(q2.queue.offset, 450);
  c2.to(649);
  assert.deepEqual(seen(q2.applied), ['event1@150']);
  c2.to(650);
  assert.deepEqual(seen(q2.applied), ['event1@150', 'event2@650']);
  assert.equal(c2.most, 1);
});

test('createReplayQueue: frames that arrive while it catches up go behind the kept ones, with the same offset; the view stays behind the stream by what the pause held back', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  queue.push('event', 1);
  clock.to(50); queue.pause();
  clock.to(100); queue.push('event', 2);
  clock.to(400); queue.push('event', 3);
  clock.to(1050); queue.resume(); // offset 950: 2 at 1050, 3 at 1350
  clock.to(1200); queue.push('event', 4); // frame 3 (due 1350) is still waiting
  clock.to(1300); queue.push('event', 5);
  assert.equal(queue.size, 3, '2 was applied at 1050; 3 is due at 1350, 4 at 2150 (arrived at 1200), 5 at 2250 (arrived at 1300)');
  clock.to(5000);
  assert.deepEqual(seen(applied), ['event1@0', 'event2@1050', 'event3@1350', 'event4@2150', 'event5@2250']);
  // the queue is empty and the offset stays: a later frame is behind by 950 too (the view does not catch up)
  clock.to(6000); queue.push('event', 6);
  assert.equal(applied.length, 5, 'not applied on arrival');
  assert.equal(clock.timers.size, 1);
  clock.to(6949);
  assert.equal(applied.length, 5);
  clock.to(6950);
  assert.equal(seen(applied).at(-1), 'event6@6950');
  assert.equal(clock.most, 1);
});

test('createReplayQueue: a snapshot directly followed by a newer snapshot is dropped; an event between them keeps both; the newer keeps its own arrival time; order is the stream\'s', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  clock.to(10); queue.pause();
  clock.to(20); queue.push('run', 'A');
  clock.to(30); queue.push('event', 1);
  clock.to(40); queue.push('run', 'B');
  clock.to(50); queue.push('run', 'C'); // B is directly followed by C: B goes
  clock.to(60); queue.push('run', 'D'); // and C by D
  clock.to(70); queue.push('event', 2);
  clock.to(80); queue.push('run', 'E');
  clock.to(90); queue.push('end', null);
  assert.equal(queue.size, 6, 'A, 1, D, 2, E, end');
  clock.to(1000); queue.resume(); // nothing was kept at the pause: A, the first kept frame, is shown at 1000 (offset 980)
  clock.to(5000);
  assert.deepEqual(seen(applied), ['runA@1000', 'event1@1010', 'runD@1040', 'event2@1050', 'runE@1060', 'end@1070'], 'each at its own arrival time plus the offset; D kept its own time, 60');
  // a lone snapshot in the queue stays, and two snapshots with only the end after them are neighbours too
  const c2 = fakeClock();
  const q2 = queueOn(c2);
  q2.queue.pause();
  q2.queue.push('run', 'X');
  q2.queue.push('run', 'Y');
  assert.equal(q2.queue.size, 1);
  q2.queue.resume();
  assert.deepEqual(seen(q2.applied), ['runY@0'], 'the last snapshot before the end stays');
  // while playing with nothing kept nothing is dropped
  const c3 = fakeClock();
  const q3 = queueOn(c3);
  q3.queue.push('run', 'P');
  q3.queue.push('run', 'Q');
  assert.deepEqual(seen(q3.applied), ['runP@0', 'runQ@0']);
  // "the first kept frame" is the frame that is first in the queue at the resume, not the first that arrived: the older of two snapshots is
  // dropped, so the newer one is shown at the resume (offset 700), not 200 ms later
  const c4 = fakeClock();
  const q4 = queueOn(c4);
  q4.queue.pause();
  c4.to(100); q4.queue.push('run', 'old');
  c4.to(300); q4.queue.push('run', 'new');
  assert.equal(q4.queue.size, 1);
  c4.to(1000); q4.queue.resume();
  assert.deepEqual(seen(q4.applied), ['runnew@1000']);
  assert.equal(q4.queue.offset, 700);
  assert.equal(c4.most, 0);
});

test('createReplayQueue: a dropped snapshot that the timer waited for gives the timer to the one behind it', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  clock.to(10); queue.pause();
  clock.to(100); queue.push('event', 1);
  clock.to(200); queue.push('run', 'A');
  clock.to(1010); queue.resume(); // offset 910: 1 at 1010 (at the resume), A at 1110
  assert.deepEqual(seen(applied), ['event1@1010']);
  assert.equal(clock.timers.size, 1, 'waiting for A at 1110');
  clock.to(1050); queue.push('run', 'B'); // arrives at 1050, due 1960; A is directly followed by B and goes
  assert.equal(queue.size, 1);
  assert.equal(clock.timers.size, 1);
  clock.to(1110);
  assert.equal(applied.length, 1, 'A is gone: nothing at 1110');
  clock.to(1959);
  assert.equal(applied.length, 1);
  clock.to(1960);
  assert.deepEqual(seen(applied), ['event1@1010', 'runB@1960']);
  assert.equal(clock.most, 1);
});

test('createReplayQueue: with no pause there is no delay and no timer, however many frames come; the arrival time is the time the frame was pushed', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  for (let i = 1; i <= 100; i++) { clock.to(i * 3); queue.push(i % 5 === 0 ? 'run' : 'event', i); }
  assert.equal(applied.length, 100);
  assert.deepEqual(applied.map((a) => a.t), Array.from({ length: 100 }, (_, i) => (i + 1) * 3), 'each at its arrival, in order');
  assert.equal(clock.most, 0, 'no timer was ever made');
  assert.equal(queue.waiting, false);
  assert.equal(queue.size, 0);
  // a pause and a resume with nothing kept makes no timer either
  queue.pause(); queue.resume();
  assert.equal(clock.most, 0);
});

test('createReplayQueue: pause twice is one pause (the second call does not forget what was kept, or not kept, at the first), resume without a pause does nothing, a resume with nothing kept and nothing arrived delays nothing', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  queue.resume();
  assert.equal(queue.offset, 0);
  clock.to(10); queue.pause();
  clock.to(20); queue.pause(); // the pause that began at 10 goes on
  assert.equal(queue.paused, true);
  clock.to(110); queue.resume();
  clock.to(120); queue.resume();
  assert.equal(queue.offset, 0, 'nothing was kept and nothing arrived: the pause held nothing back');
  assert.equal(queue.paused, false);
  clock.to(200); queue.push('event', 1);
  assert.deepEqual(seen(applied), ['event1@200'], 'applied on arrival, the view is not behind the stream');
  assert.equal(clock.most, 0, 'no timer');
  // a longer pause with nothing kept: the same
  clock.to(300); queue.pause();
  clock.to(800); queue.resume();
  clock.to(900); queue.push('event', 2);
  assert.deepEqual(seen(applied), ['event1@200', 'event2@900']);
  assert.equal(clock.most, 0);
  // a second pause() after a frame arrived must not turn "nothing kept at the pause" into "kept": pause at 1000, a frame at 1500, pause
  // again at 1520, resume at 1600: the frame was due 100 ms before the resume (offset 100), not held for the whole 600 ms
  clock.to(1000); queue.pause();
  clock.to(1500); queue.push('event', 3);
  clock.to(1520); queue.pause();
  clock.to(1600); queue.resume();
  assert.deepEqual(seen(applied).slice(2), ['event3@1600']);
  assert.equal(queue.offset, 100);
  assert.equal(clock.most, 0);
  // the flag belongs to each pause: the next pause starts again from what is kept then
  clock.to(1700); queue.pause();
  clock.to(2000); queue.resume();
  assert.equal(queue.offset, 100, 'a pause with nothing kept and nothing arrived adds nothing');
});

test('createReplayQueue: a frame that arrives in a pause with nothing kept is shown at its own due time when that is later than the resume (the offset never shrinks)', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock);
  queue.push('event', 1);
  clock.to(50); queue.pause(); // nothing kept
  clock.to(100); queue.push('event', 2);
  clock.to(500); queue.resume(); // offset 400: 2 at 500
  assert.deepEqual(seen(applied), ['event1@0', 'event2@500']);
  assert.equal(queue.offset, 400);
  clock.to(900); queue.pause(); // nothing kept again (playing, queue empty)
  clock.to(2100); queue.push('event', 3); // due 2500 with the offset of 400
  clock.to(2200); queue.resume();
  assert.equal(queue.offset, 400, 'the frame is due after the resume: no growth, never a shrink');
  assert.equal(applied.length, 2, 'not shown at the resume');
  assert.equal(clock.timers.size, 1, 'a timer waits for its own due time');
  clock.to(2499);
  assert.equal(applied.length, 2);
  clock.to(2500);
  assert.deepEqual(seen(applied).at(-1), 'event3@2500');
  assert.equal(clock.most, 1);
});

test('createReplayQueue: clear() drops what is kept and the timer, also while paused; a frame applied may pause or clear the queue and the pass stops at once', () => {
  const clock = fakeClock();
  const a = queueOn(clock);
  clock.to(5); a.queue.pause();
  a.queue.push('event', 1);
  a.queue.push('event', 2);
  a.queue.clear();
  assert.equal(a.queue.size, 0);
  clock.to(105); a.queue.resume();
  clock.to(1000);
  assert.deepEqual(a.applied, [], 'what was kept is never applied');
  assert.equal(clock.timers.size, 0);
  // clear() while a timer waits
  const c2 = fakeClock();
  const b = queueOn(c2);
  c2.to(10); b.queue.pause();
  c2.to(20); b.queue.push('event', 1);
  c2.to(30); b.queue.push('event', 2);
  c2.to(110); b.queue.resume(); // offset 90: 1 at 110 (at the resume), 2 at 120
  assert.deepEqual(seen(b.applied), ['event1@110']);
  assert.equal(c2.timers.size, 1);
  b.queue.clear();
  assert.equal(c2.timers.size, 0, 'no timer left after clear');
  c2.to(1000);
  assert.deepEqual(seen(b.applied), ['event1@110'], 'what was kept is never applied');
  // an apply that clears the queue (a failure): the frames behind it are not applied, and no timer is left
  const c3 = fakeClock();
  const holder = {};
  const d = queueOn(c3, { apply: (name) => { if (name === 'stop') holder.q.clear(); } });
  holder.q = d.queue;
  c3.to(5); d.queue.pause();
  d.queue.push('event', 1); d.queue.push('stop', null); d.queue.push('event', 2);
  c3.to(10); d.queue.resume();
  c3.to(1000);
  assert.deepEqual(seen(d.applied), ['event1@10', 'stop@10']);
  assert.equal(c3.timers.size, 0);
  // an apply that pauses the queue: the pass stops, and nothing is applied or waiting until the resume
  const c4 = fakeClock();
  const hold4 = {};
  const e = queueOn(c4, { apply: (name) => { if (name === 'halt') hold4.q.pause(); } });
  hold4.q = e.queue;
  c4.to(5); e.queue.pause();
  e.queue.push('event', 1); e.queue.push('halt', null); e.queue.push('event', 2);
  c4.to(6); e.queue.resume();
  c4.to(100);
  assert.deepEqual(seen(e.applied), ['event1@6', 'halt@6']);
  assert.equal(c4.timers.size, 0, 'paused: no timer');
  e.queue.resume(); // a frame was kept when the apply paused: it keeps its wait, so the whole 94 ms is added: the frame that arrived at 5 is due at 100
  assert.deepEqual(seen(e.applied), ['event1@6', 'halt@6', 'event2@100'], 'resumed');
  assert.equal(c4.timers.size, 0);
});

test('createReplayQueue: an apply that throws does not break the chain of timers', () => {
  const clock = fakeClock();
  const { queue, applied } = queueOn(clock, { apply: (name, value) => { if (value === 2) throw new Error('boom'); } });
  clock.to(10); queue.pause();
  clock.to(20); queue.push('event', 1);
  clock.to(30); queue.push('event', 2);
  clock.to(40); queue.push('event', 3);
  clock.to(110); queue.resume(); // offset 90: 1 at 110 (at the resume), 2 at 120, 3 at 130
  assert.throws(() => clock.to(200), /boom/);
  assert.equal(clock.timers.size, 1, 'the next one is armed');
  clock.to(300);
  assert.deepEqual(seen(applied), ['event1@110', 'event2@120', 'event3@130']);
});

test('the REPLAY mark and the banner of lib.modeInfo are the page\'s existing look; index.html has the static mark with that text and the control hidden', () => {
  assert.equal(modeInfo('replay').text, 'REPLAY');
  assert.equal(modeInfo('replay').cls, 'replay');
  const html = read('index.html');
  assert.match(html, new RegExp(`<span id="replay-mark" class="badge replay"[^>]*hidden>${modeInfo('replay').text}</span>`), 'a static mark with the .badge.replay look');
  assert.match(html, /<div id="replay-ctl"[^>]*hidden>/);
  for (const id of ['replay-speed', 'replay-go', 'replay-pause', 'replay-stop', 'replay-line']) assert.match(html, new RegExp(`id="${id}"[^>]*hidden>`), `${id} starts hidden`);
  for (const n of [1, 4, 20]) assert.match(html, new RegExp(`<button id="replay-s${n}"[^>]*aria-pressed="${n === 4}"[^>]*>${n}x</button>`), `${n}x`);
  assert.ok(html.indexOf('id="run-select"') < html.indexOf('id="replay-mark"') && html.indexOf('id="replay-mark"') < html.indexOf('id="replay-ctl"'), 'the mark is next to the picker, then the control');
  assert.match(html, /<div id="replay-banner" hidden>/, 'the existing banner is kept');
  const css = read('style.css');
  assert.match(css, /\.badge\.replay\s*\{/);
  assert.match(css, /#replay-banner\s*\{/);
  assert.match(css, /\.replay-ctl\s*\{[^}]*flex-wrap:\s*wrap/, 'the control wraps inside the header instead of pushing it wider');
  assert.match(css, /\.replay-line\s*\{[^}]*overflow-wrap:\s*anywhere/, 'a long reason wraps');
});

// =====================================================================================================================
// part 2: app.js on the fake browser
// =====================================================================================================================

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const XHTML = 'http://www.w3.org/1999/xhtml';
// what esc() writes: the same five characters, so the html an element gives back is the html the page wrote
const escS = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function serialize(n) {
  if (n.nodeType === 3) return escS(n.data);
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escS(v)}"`).join('');
  return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${serializeKids(n)}</${n.tag}>`;
}
const serializeKids = (n) => n.childNodes.map(serialize).join('');

// the mutations of a document, like the records of a MutationObserver (kept only while a test asks: doc.mut is an array)
const recorder = (doc) => (type, parent, node) => {
  if (doc.mut) doc.mut.push({ type, parent, node, ser: type === 'add' || type === 'remove' ? serialize(node) : null });
};

// a text node: its own writes are counted, and a change of its data is a write of the node, not of an element
class TextNode {
  constructor(doc, data) {
    Object.assign(this, { doc, nodeType: 3, nodeName: '#text', tag: '#text', childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), writes: 0, moves: 0, htmlWrites: 0, _data: String(data) });
  }

  get data() { return this._data; }

  set data(v) { this.writes++; this._data = String(v); this.doc.note?.('text', this.parentNode, this); }

  get textContent() { return this._data; }

  get html() { return escS(this._data); }

  get ownerDocument() { return this.doc; }

  closest(sel) { return this.parentNode ? this.parentNode.closest(sel) : null; }

  contains(n) { return n === this; }

  matches() { return false; }
}

function matchesCompound(el, c) {
  if (c.tag && el.tag.toLowerCase() !== c.tag) return false;
  if (c.id && el.attrs.get('id') !== c.id) return false;
  if (c.classes.some((k) => !el.classes.has(k))) return false;
  return c.attrs.every((a) => el.attrs.has(a.name) && (a.value === null || el.attrs.get(a.name) === a.value));
}
function parseCompound(text) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4], value: m[5] ?? null });
  }
  if (re.lastIndex !== text.length) return null; // a selector the fake does not know matches nothing
  return c;
}
// "a, b c": a list of chains; a chain is compounds with the descendant combinator only (the page uses nothing else)
const parseSelector = (sel) => String(sel).split(',').map((part) => part.trim().split(/\s+/).map(parseCompound));
function elMatches(el, sel) {
  return parseSelector(sel).some((chain) => {
    if (chain.some((c) => c === null)) return false;
    if (!matchesCompound(el, chain.at(-1))) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node && !matchesCompound(node, chain[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class El {
  constructor(doc, tag, ns = null) {
    Object.assign(this, { doc, tag, ns, nodeType: 1, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), props: new Map(), text: '', writes: 0, htmlWrites: 0, moves: 0, listeners: {} });
    Object.assign(this, { _hidden: false, value: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0, offsetWidth: 0, offsetHeight: 0, scrolledIntoView: 0 });
    const self = this;
    this.classList = {
      add(t) { self.writes++; self.classes.add(t); self.syncClass(); },
      remove(t) { self.writes++; self.classes.delete(t); self.syncClass(); },
      contains: (t) => self.classes.has(t),
      toggle(t, force) {
        const on = force === undefined ? !self.classes.has(t) : !!force;
        self.writes++;
        if (on) self.classes.add(t); else self.classes.delete(t);
        self.syncClass();
        return on;
      },
    };
    this.style = {
      setProperty(k, v) { self.writes++; self.props.set(k, v); },
      removeProperty(k) { self.writes++; self.props.delete(k); },
    };
  }

  syncClass() { this.attrs.set('class', [...this.classes].join(' ')); }

  get id() { return this.attrs.get('id') ?? ''; }

  get className() { return this.attrs.get('class') ?? ''; }

  set className(v) { this.setAttribute('class', v); }

  get hidden() { return this._hidden; }

  set hidden(v) { this.writes++; this._hidden = !!v; }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }

  get ownerDocument() { return this.doc; }

  get namespaceURI() { return this.ns ?? XHTML; }

  get nodeName() { return this.ns ? this.tag : this.tag.toUpperCase(); }

  get textContent() { return this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this.text; }

  set textContent(v) {
    this.writes++;
    for (const c of this.childNodes) { this.doc.note?.('remove', this, c); c.parentNode = null; }
    this.childNodes = [];
    this.text = String(v);
  }

  // what the element holds, as the html a browser would give back: nodes, not the string that was written
  get html() { return serializeKids(this); }

  get innerHTML() { return serializeKids(this); }

  set innerHTML(v) {
    this.writes++;
    this.htmlWrites++;
    for (const c of this.childNodes) { this.doc.blurIfInside(c); this.doc.note?.('remove', this, c); c.parentNode = null; }
    this.childNodes = [];
    this.scrollTop = 0;
    this.text = '';
    const make = (n) => {
      if (typeof n === 'string') return new TextNode(this.doc, n);
      const el = new El(this.doc, n.tag, this.ns);
      for (const [k, x] of Object.entries(n.attrs)) el.setAttribute(k, x);
      for (const kid of n.kids) { const c = make(kid); c.parentNode = el; el.childNodes.push(c); }
      return el;
    };
    for (const n of parseFragment(v)) {
      const c = make(n);
      c.parentNode = this;
      this.childNodes.push(c);
      this.doc.note?.('add', this, c);
    }
  }

  setAttribute(k, v) {
    this.writes++;
    this.attrs.set(k, String(v));
    if (k === 'class') this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  removeAttribute(k) { this.writes++; this.attrs.delete(k); if (k === 'class') this.classes = new Set(); }

  hasAttribute(k) { return this.attrs.has(k); }

  insertBefore(node, ref) {
    this.doc.note?.(node.parentNode ? 'move' : 'add', this, node);
    if (node.parentNode) {
      this.doc.blurIfInside(node);
      node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    }
    node.parentNode = this;
    node.moves++;
    if (ref === null || ref === undefined) this.childNodes.push(node);
    else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    assert.ok(i >= 0, 'removeChild: the element is a child of this parent');
    this.doc.blurIfInside(node);
    this.doc.note?.('remove', this, node);
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  matches(sel) { return elMatches(this, sel); }

  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (elMatches(n, sel)) return n;
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (elMatches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }

  // an event that bubbles to the document, like the browser's
  dispatch(type, extra = {}) {
    const ev = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (let n = this; n; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners[type] || [])]) fn(ev);
    }
    for (const fn of [...(this.doc.listeners[type] || [])]) fn(ev);
    return ev;
  }

  // listeners of this element only (the pointer events of a handle, which has its own)
  fire(type, ev = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(ev); }

  focus() { this.doc.activeElement = this; }

  blur() { if (this.doc.activeElement === this) this.doc.activeElement = null; }

  scrollIntoView() { this.scrolledIntoView++; }

  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

// index.html as elements: a small parser (tags, attributes, nesting; no text nodes, the page never reads them)
function parseHtml(doc, text) {
  const root = new El(doc, 'html');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const el = new El(doc, tag);
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (a[1] === 'hidden') el._hidden = true;
      else el.attrs.set(a[1], v);
      if (a[1] === 'class') el.classes = new Set(v.split(/\s+/).filter(Boolean));
    }
    const parent = stack.at(-1);
    el.parentNode = parent;
    parent.childNodes.push(el);
    if (!m[4] && !VOID.has(tag) && tag !== 'svg' && tag !== 'line') stack.push(el);
    else if (tag === 'svg' && !m[4]) stack.push(el);
  }
  return root;
}

const GLOBALS = ['document', 'window', 'location', 'history', 'localStorage', 'fetch', 'EventSource', 'ResizeObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'];
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
let bootCount = 0;

// A replay answer: the body of a response that the test pushes text into. The page reads it with getReader() like a browser's fetch body;
// aborting the request rejects a read that is waiting, as a browser does.
function makeStream(signal) {
  const encoder = new TextEncoder();
  const chunks = [];
  let wake = null;
  const settle = () => { if (wake) { const w = wake; wake = null; w(); } };
  signal?.addEventListener('abort', () => { chunks.push({ error: Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }) }); settle(); });
  return {
    signal,
    get aborted() { return signal?.aborted === true; },
    push(text) { chunks.push(encoder.encode(text)); settle(); },
    end() { chunks.push('done'); settle(); },
    fail(message) { chunks.push({ error: new Error(message) }); settle(); },
    reader: {
      async read() {
        for (;;) {
          if (chunks.length) {
            const c = chunks.shift();
            if (c === 'done') return { done: true, value: undefined };
            if (c.error) throw c.error;
            return { done: false, value: c };
          }
          await new Promise((r) => { wake = r; });
        }
      },
      async cancel() {},
    },
  };
}
const sse = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// opts: runs (the list), runDocs (id -> Run), events (id -> UiEvent[] the backlog answers), storage, answer(url, init) for the replay request
// (default: 200 with a stream the test pushes into, kept in page.streams)
async function bootPage({ runs = [], runDocs = {}, events = {}, width = 1228, height = 800, storage = {}, answer = null, hash = '' } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const doc = { listeners: {}, title: 'wfviz', activeElement: null };
  const html = parseHtml(doc, read('index.html'));
  const body = html.querySelector('body');
  Object.assign(doc, {
    documentElement: new El(doc, 'html'), body, html,
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new El(doc, t), createElementNS: (ns, t) => new El(doc, t, ns), createTextNode: (d) => new TextNode(doc, d),
    mut: null,
    note: recorder(doc),
    addEventListener: (t, fn) => { (doc.listeners[t] ||= []).push(fn); }, elementFromPoint: () => null,
    blurIfInside(node) { if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = null; },
  });
  html.querySelector('.grid').clientWidth = width;
  // the clock of the page (performance.now) is a number the test moves; a timeout runs only when page.advance moves the clock past it
  const clock = { t: 0 };
  const timers = { intervals: new Map(), timeouts: new Map(), n: 0 };
  const windowListeners = {};
  const page = {
    doc, timers, clock, windowListeners, storage, requests: [], streams: [], answer, es: null, runs, runDocs, events,
    // moves the clock by ms, running the timeouts that come due on the way, each with the clock at its own time
    advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers.timeouts) if (x.at <= target && (next === null || x.at < next.x.at)) next = { id, x };
        if (next === null) break;
        timers.timeouts.delete(next.id);
        clock.t = Math.max(clock.t, next.x.at);
        next.x.fn();
      }
      clock.t = target;
    },
    to(t) { page.advance(t - clock.t); },
    // the timeouts waiting, as their delays
    waiting: () => [...timers.timeouts.values()].map((x) => x.ms),
    el: (s) => { const e = html.querySelector(s); assert.ok(e, `index.html has ${s}`); return e; },
    flush: async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
    emit(type, data) { for (const fn of page.es.listeners[type] || []) fn({ data: JSON.stringify(data) }); },
    async hello(mode = 'real') { page.emit('hello', { mode, version: '1' }); await page.flush(); },
    async snapshot(r) { page.emit('run', r); await page.flush(); },
    async event(e) { page.emit('event', e); await page.flush(); },
    async click(el) { el.dispatch('click'); await page.flush(); },
    replayRequests: () => page.requests.filter((u) => /\/replay\?/.test(u)),
    runRequests: (id) => page.requests.filter((u) => u === `/api/runs/${id}`),
    transcriptRequests: () => page.requests.filter((u) => /\/transcript/.test(u)),
    stream: () => page.streams.at(-1),
    // frames into the replay stream, then let the page read them
    async send(...frames) { for (const [name, data] of frames) page.stream().push(sse(name, data)); await page.flush(); },
    restore() { for (const n of GLOBALS) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n]; } },
  };
  class FakeES {
    constructor() { this.listeners = {}; page.es = this; }

    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  }
  setGlobal('document', doc);
  setGlobal('window', { innerHeight: height, innerWidth: width, addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); } });
  // the page's address: the picker's filters live in location.hash (read at the start, written with history.replaceState)
  const location = { hash, pathname: '/', search: '' };
  setGlobal('location', location);
  setGlobal('history', { replaceState(_state, _title, url) { location.hash = String(url).startsWith('#') ? String(url) : ''; } });
  setGlobal('performance', { now: () => clock.t });
  setGlobal('localStorage', { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } });
  setGlobal('getComputedStyle', () => ({ paddingLeft: '14px', paddingRight: '14px' }));
  setGlobal('CSS', { escape: (x) => String(x) });
  setGlobal('ResizeObserver', class { observe() {} });
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('EventSource', FakeES);
  setGlobal('setInterval', (fn, ms) => { timers.intervals.set(++timers.n, { fn, ms }); return timers.n; });
  setGlobal('clearInterval', (id) => { timers.intervals.delete(id); });
  setGlobal('setTimeout', (fn, ms) => { timers.timeouts.set(++timers.n, { fn, ms, at: clock.t + ms }); return timers.n; });
  setGlobal('clearTimeout', (id) => { timers.timeouts.delete(id); });
  setGlobal('fetch', async (url, init) => {
    const u = String(url);
    page.requests.push(u);
    let m;
    let data;
    if ((m = /^\/api\/runs\/([^/?]+)\/replay\?speed=(\d+)$/.exec(u))) {
      if (page.answer) return page.answer(u, init);
      const stream = makeStream(init?.signal);
      page.streams.push(stream);
      return { ok: true, status: 200, body: { getReader: () => stream.reader } };
    }
    if (u === '/api/runs') data = page.runs;
    else if ((m = /^\/api\/runs\/([^/?]+)\/events\?since=(\d+)$/.exec(u))) data = (page.events[decodeURIComponent(m[1])] ?? []).filter((e) => e.seq > Number(m[2]));
    else if ((m = /^\/api\/runs\/([^/?]+)$/.exec(u))) data = page.runDocs[decodeURIComponent(m[1])];
    if (data === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(data) };
  });
  try {
    await import(`../../web/app.js?replay=${++bootCount}`);
    await page.flush();
    page.emit('hello', { mode: 'real', version: '1' });
    await page.flush();
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}

// a page on a finished real run, with a real run of its own, and what the tests need to look at
const REGIONS = ['#run-status', '#steps', '#roles', '#facts', '#matrix-grid', '#matrix-fallback', '#lanes', '#tl-rows', '#tl-edges', '#tl-axis', '#counters', '#verdicts', '#tests', '#report', '#log', '#drawer-body', '#rp-cur', '#rp-list'];
const ctl = (page) => {
  const hid = (s) => page.el(s).hidden;
  const txt = (s) => page.el(s).textContent;
  return {
    ctl: !hid('#replay-ctl'), speed: !hid('#replay-speed'), go: hid('#replay-go') ? null : txt('#replay-go'), pause: hid('#replay-pause') ? null : txt('#replay-pause'),
    stop: !hid('#replay-stop'), line: hid('#replay-line') ? null : txt('#replay-line'), mark: !hid('#replay-mark'), banner: !hid('#replay-banner'),
  };
};
const logSeqs = (page) => page.el('#log').childNodes.map((c) => Number(c.attrs.get('data-seq')));
const uev = (seq, over = {}) => ({ runId: 'wf_x', seq, ts: 9000 + seq, kind: 'agent.activity', agentId: 'a1', label: 'w:U', message: `replayed ${seq}`, prov: 'registered', ...over });
const rep = (n, over = {}) => run([agent('a1', 'w:U'), agent('a2', 'w:V')], {
  source: 'replay', status: { value: 'running', prov: 'inferred', method: 'no-final-file' }, durationMs: unk('run is still running'),
  totals: { agents: 2, running: 0, done: n, failed: 0 }, ...over,
});
const realRun = () => run([agent('r1', 'real:one'), agent('r2', 'real:two')], { name: reg('the real run') });

// finished real run on show, and the control with its 4x
async function realPage(over = {}) {
  const real = over.run ?? realRun();
  return bootPage({ runs: [summary(real)], runDocs: { [real.id]: real }, events: { [real.id]: [] }, hash: '#range=all', ...over.boot });
}
const startedReplay = async (page) => { await page.click(page.el('#replay-go')); return page.stream(); };
const withPage = (fn, opts) => async () => {
  const page = await realPage(opts);
  try { await fn(page); } finally { page.restore(); }
};
// the nodes that a change took out and a rewrite put back as new ones with the same content: what a MutationObserver sees as flicker
function identicalReadds(records) {
  const out = [];
  for (const r of records) {
    if (r.type === 'remove' && records.some((a) => a.type === 'add' && a.parent === r.parent && a.node !== r.node && a.ser === r.ser)) out.push(r.ser);
  }
  return out;
}
const rowsOf = (page) => page.el('#rp-list').childNodes;
const rowOf = (page, id) => rowsOf(page).find((r) => r.attrs.get('data-run') === id);

// ---- the control ----------------------------------------------------------------------------------------------------------------

test('control: a finished run of source real has Replay with 1x / 4x / 20x (4x pressed), no Pause or Stop, no mark; the real mode\'s banner stays hidden', withPage(async (page) => {
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false });
  assert.deepEqual([1, 4, 20].map((n) => page.el(`#replay-s${n}`).attrs.get('aria-pressed')), ['false', 'true', 'false']);
  assert.equal(page.el('#mode').textContent, 'REAL');
}));

test('control: no Replay for a running run, a run of source demo or replay, or a run with no source; an unknown status has it', async () => {
  const cases = [
    ['running', { status: { value: 'running', prov: 'inferred', method: 'no-final-file' } }, false],
    ['a final file that says running', { status: { value: 'running', prov: 'final', from: 'wf.json#status' } }, false],
    ['demo', { source: 'demo' }, false],
    ['replay', { source: 'replay' }, false],
    ['no source', { source: undefined }, false],
    ['unknown status', { status: unk('the journal is not read yet') }, true],
    ['failed', { status: fin('failed') }, true],
  ];
  for (const [what, over, shown] of cases) {
    const r = realRun();
    Object.assign(r, over);
    if (over.source === undefined && 'source' in over) delete r.source;
    const page = await bootPage({ runs: [summary(r)], runDocs: { wf_x: r }, events: { wf_x: [] } });
    try {
      const c = ctl(page);
      assert.equal(c.go, shown ? 'Replay' : null, what);
      assert.equal(c.ctl, shown, what);
      assert.deepEqual([c.pause, c.stop, c.mark], [null, false, false], what);
    } finally {
      page.restore();
    }
  }
});

test('control: a run that finishes while the page is open gets the control when its snapshot says so, and loses it if it is running again', withPage(async (page) => {
  const running = realRun();
  running.status = { value: 'running', prov: 'inferred', method: 'no-final-file' };
  await page.snapshot(running);
  assert.equal(ctl(page).ctl, false);
  await page.snapshot(realRun());
  assert.equal(ctl(page).go, 'Replay');
  await page.snapshot(running);
  assert.equal(ctl(page).ctl, false);
}));

test('speed: the choice is remembered under one key, only 1, 4 and 20 are read back, and the request takes it', async () => {
  const kept = {};
  const page = await realPage({ boot: { storage: kept } });
  try {
    await page.click(page.el('#replay-s20'));
    assert.equal(kept['wfviz.replay.speed'], '20');
    assert.deepEqual([1, 4, 20].map((n) => page.el(`#replay-s${n}`).attrs.get('aria-pressed')), ['false', 'false', 'true']);
    await page.click(page.el('#replay-s1'));
    assert.equal(kept['wfviz.replay.speed'], '1');
    await page.click(page.el('#replay-s20'));
    await startedReplay(page);
    assert.deepEqual(page.replayRequests(), ['/api/runs/wf_x/replay?speed=20'], 'the url has the number of the control');
  } finally {
    page.restore();
  }
  const reloaded = await realPage({ boot: { storage: { 'wfviz.replay.speed': '20' } } });
  try {
    assert.deepEqual([1, 4, 20].map((n) => reloaded.el(`#replay-s${n}`).attrs.get('aria-pressed')), ['false', 'false', 'true'], 'a reload shows the choice');
  } finally {
    reloaded.restore();
  }
  for (const stored of ['100', 'abc', '', '0', '1e1']) {
    const p = await realPage({ boot: { storage: { 'wfviz.replay.speed': stored } } });
    try {
      assert.deepEqual([1, 4, 20].map((n) => p.el(`#replay-s${n}`).attrs.get('aria-pressed')), ['false', 'true', 'false'], `${JSON.stringify(stored)} is 4x`);
      await startedReplay(p);
      assert.deepEqual(p.replayRequests(), ['/api/runs/wf_x/replay?speed=4'], 'the url never carries the stored text');
    } finally {
      p.restore();
    }
  }
});

test('speed: a storage that throws is no problem (the page shows 4x and still replays)', async () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const real = realRun();
  const page = await bootPage({ runs: [summary(real)], runDocs: { wf_x: real }, events: { wf_x: [] } });
  try {
    globalThis.localStorage = bad; // from here on every read and write of the page throws
    await page.click(page.el('#replay-s20'));
    await startedReplay(page);
    assert.deepEqual(page.replayRequests(), ['/api/runs/wf_x/replay?speed=20'], 'the choice works for this page even when it cannot be kept');
  } finally {
    page.restore();
  }
});

// ---- a replay from start to end ----------------------------------------------------------------------------------------------------

test('replay: Replay opens the stream once with the chosen speed, the view stays real until the stream\'s hello, then shows the replay from empty with the REPLAY mark and banner', withPage(async (page) => {
  assert.ok(page.el('#matrix-grid').childNodes.length > 0, 'the real run is drawn');
  const realRows = rowsOf(page);
  await page.click(page.el('#replay-go'));
  assert.deepEqual(page.replayRequests(), ['/api/runs/wf_x/replay?speed=4']);
  assert.equal(page.stream().signal instanceof AbortSignal, true, 'one AbortController per stream');
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Pause', stop: true, line: null, mark: false, banner: false }, 'connecting: Pause and Stop; the real view is still on show');
  assert.ok(page.el('#matrix-grid').childNodes.length > 0, 'nothing was cleared before the stream answered');

  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }]);
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Pause', stop: true, line: null, mark: true, banner: true });
  assert.equal(page.el('#mode').textContent, 'REAL', 'the badge keeps the mode of the server');
  assert.equal(page.el('#matrix-grid').hidden, true, 'the real run is gone from the matrix');
  const empty = page.el('#matrix-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /^Replay starting/);
  assert.doesNotMatch(empty.textContent, /No workflow runs found/, 'a run on show that has not drawn yet is not "no runs"');
  assert.equal(page.el('#log').childNodes.length, 0, 'the log starts empty');
  assert.equal(page.el('#run-status').childNodes.length, 0, 'so does the status line');
  void realRows;

  await page.send(['event', uev(1)], ['event', uev(2)], ['run', rep(0)]);
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.ok(page.el('#matrix-grid').childNodes.length > 0, 'the replayed Run is drawn');
  assert.equal(page.el('#matrix-empty').hidden, true);
  assert.match(page.el('#run-status').textContent, /status\s*running/);
  assert.equal(page.runRequests('wf_x').length, 1, 'the real run was read once, at load: the replay reads nothing from the real run');
  assert.equal(page.requests.filter((u) => /\/events\?/.test(u)).length, 1, 'and no backlog');
}));

test('replay: the end shows "replay finished" and a way to play again; the stream is not opened a second time, and a later frame or a closed stream changes nothing', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['event', uev(2)], ['run', rep(2, { status: fin('completed'), durationMs: fin(3000) })]);
  await page.send(['end', { runId: 'wf_x', events: 2 }]);
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true });
  stream.end();
  await page.flush();
  assert.equal(ctl(page).line, 'replay finished', 'the closed stream after the end is no error');
  assert.equal(page.replayRequests().length, 1, 'no reconnect');
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.match(page.el('#run-status').textContent, /status\s*completed/);
}));

test('replay again: a second click plays it again from empty, one more request, the old stream is left; the speed chosen meanwhile is used', withPage(async (page) => {
  const first = await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1, { status: fin('completed') })], ['end', { runId: 'wf_x', events: 1 }]);
  await page.click(page.el('#replay-s20'));
  await page.click(page.el('#replay-go'));
  assert.deepEqual(page.replayRequests(), ['/api/runs/wf_x/replay?speed=4', '/api/runs/wf_x/replay?speed=20']);
  assert.equal(first.aborted, true, 'the earlier stream was left');
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Pause', stop: true, line: null, mark: true, banner: true },
    'until the hello the old replayed view is still on show, and the mark, the banner and Stop belong to it');
  assert.deepEqual(logSeqs(page), [1], 'the old view stays until the new stream says hello');
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }]);
  assert.deepEqual(logSeqs(page), [], 'then it starts from empty again');
  assert.match(page.el('#matrix-empty').textContent, /^Replay starting/);
  await page.send(['event', uev(1)], ['run', rep(1)]);
  assert.deepEqual(logSeqs(page), [1]);
  // frames of the first stream that arrive late are ignored
  first.push(sse('event', uev(2)));
  await page.flush();
  assert.deepEqual(logSeqs(page), [1]);
}));

// Replay again on a replayed view that is on screen: whatever the new request comes to, the REPLAY mark is on exactly the replayed view.
// `answer` is read at every request, so a test changes it after the first replay has ended.
const endedReplay = async (page) => {
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['event', uev(2)], ['run', rep(2, { status: fin('completed'), durationMs: fin(3000) })], ['end', { runId: 'wf_x', events: 2 }]);
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true });
};
const stillTheReplayedView = (page, line) => {
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line, mark: true, banner: true }, 'the mark, the banner and Stop stay with the replayed view');
  assert.deepEqual(logSeqs(page), [1, 2], 'the replayed log is still on screen');
  assert.match(page.el('#run-status').textContent, /status\s*completed/, 'and the replayed Run');
  assert.equal(page.el('#replay-line').classes.has('bad'), true, 'the reason looks like an error');
};

test('replay again that is refused (429, 409, 404, the network): the replayed view stays on screen with its mark, banner and Stop, the reason is the line, and the real stream is still not drawn over it', async () => {
  for (const how of [
    { name: '429', answer: async () => ({ ok: false, status: 429, json: async () => ({ error: '3 replays are already open: close one first' }) }), line: '3 replays are already open: close one first' },
    { name: '409', answer: async () => ({ ok: false, status: 409, json: async () => ({ error: 'the run is still running: only a finished run can be replayed' }) }), line: 'the run is still running: only a finished run can be replayed' },
    { name: '404', answer: async () => ({ ok: false, status: 404, json: async () => ({ error: 'no run "wf_x" under "/r"' }) }), line: 'no run "wf_x" under "/r"' },
    { name: 'network', answer: async () => { throw new TypeError('Failed to fetch'); }, line: 'Failed to fetch' },
  ]) {
    const page = await realPage();
    try {
      await endedReplay(page);
      page.answer = how.answer;
      await page.click(page.el('#replay-go'));
      assert.equal(page.replayRequests().length, 2, how.name);
      stillTheReplayedView(page, how.line);
      // the real stream goes on for the run list; what it says of the run on show changes nothing of the replayed view
      const grid = page.el('#matrix-grid').html;
      const renamed = realRun();
      renamed.name = reg('renamed while the replay was refused');
      await page.snapshot(renamed);
      await page.event({ runId: 'wf_x', seq: 77, ts: 1, kind: 'run.final', message: 'a real event', prov: 'final' });
      assert.equal(page.el('#matrix-grid').html, grid, `${how.name}: the real Run is not drawn over the replayed view`);
      assert.deepEqual(logSeqs(page), [1, 2], `${how.name}: no real line in the replayed log`);
      assert.match(page.el('#rp-cur').textContent, /renamed while the replay was refused/, 'the picker row follows the real stream');
      // Replay again once more works from there, and Stop is the way back to the real view
      page.answer = null;
      await page.click(page.el('#replay-go'));
      assert.equal(ctl(page).line, null, 'the next click starts over');
      assert.deepEqual([ctl(page).mark, ctl(page).pause, ctl(page).stop], [true, 'Pause', true]);
      await page.click(page.el('#replay-stop'));
      assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false }, `${how.name}: Stop goes back to the real view`);
      assert.match(page.el('#run-status').textContent, /status\s*completed/);
      assert.equal(page.runRequests('wf_x').length, 2, 'the real Run was read again by Stop');
    } finally {
      page.restore();
    }
  }
});

test('replay again whose stream is cut or says something wrong before its hello: the old replayed view stays with its mark; after a right hello the view is the new replay\'s', async () => {
  for (const [name, play, line] of [
    ['cut', (p) => p.stream().end(), 'stream ended before the end (0 events played)'],
    ['wrong hello', (p) => p.send(['hello', { mode: 'real', version: '1', runId: 'wf_x' }]), /unexpected hello/],
    ['no hello', (p) => p.send(['event', uev(1)]), 'the replay stream did not start with its hello'],
  ]) {
    const page = await realPage();
    try {
      await endedReplay(page);
      await page.click(page.el('#replay-go'));
      assert.deepEqual([ctl(page).mark, ctl(page).banner, ctl(page).stop, ctl(page).pause], [true, true, true, 'Pause'], `${name}: connecting`);
      await play(page);
      await page.flush();
      assert.deepEqual([ctl(page).mark, ctl(page).banner, ctl(page).stop, ctl(page).go], [true, true, true, 'Replay again'], name);
      if (line instanceof RegExp) assert.match(ctl(page).line, line, name); else assert.equal(ctl(page).line, line, name);
      assert.deepEqual(logSeqs(page), [1, 2], `${name}: the old replayed log`);
    } finally {
      page.restore();
    }
  }
  // the right hello: the old view is cleared for the new stream, and the mark never went away
  const page = await realPage();
  try {
    await endedReplay(page);
    await page.click(page.el('#replay-go'));
    await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }]);
    assert.deepEqual([ctl(page).mark, ctl(page).banner, ctl(page).pause], [true, true, 'Pause']);
    assert.deepEqual(logSeqs(page), [], 'the new replay starts from empty');
    await page.send(['event', uev(1)]);
    assert.deepEqual(logSeqs(page), [1]);
  } finally {
    page.restore();
  }
});

test('replay again while paused before the hello: Resume goes back to connecting, the frames that came are applied after the hello, and the old view keeps its mark meanwhile', withPage(async (page) => {
  await endedReplay(page);
  await page.click(page.el('#replay-go'));
  await page.click(page.el('#replay-pause'));
  assert.deepEqual([ctl(page).pause, ctl(page).mark, ctl(page).stop], ['Resume', true, true]);
  await page.click(page.el('#replay-pause'));
  assert.deepEqual([ctl(page).pause, ctl(page).mark], ['Pause', true], 'back to connecting');
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)]);
  assert.deepEqual(logSeqs(page), [1], 'the hello was accepted after the resume: the new stream is on');
}));

test('replay: the replayed Run and its events never reach the run list or the real stream\'s state: the picker row of the run keeps the real data', withPage(async (page) => {
  await page.click(page.el('#rp-trigger'));
  const meta = () => rowOf(page, 'wf_x').textContent;
  assert.match(meta(), /real/);
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1, { name: reg('REPLAYED NAME') })]);
  await page.click(page.el('#rp-trigger')); // closes
  await page.click(page.el('#rp-trigger')); // opens again, rows are patched
  assert.match(meta(), /real/);
  assert.doesNotMatch(meta(), /REPLAYED NAME|replay/);
  assert.match(page.el('#rp-cur').textContent, /the real run/, 'the button shows the run list\'s name of the run');
}));

test('replay: the real stream goes on for the run list, but its `run` and `event` for the run on show change nothing of the replayed view, and a reconnect does not read the run again', withPage(async (page) => {
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
  const grid = page.el('#matrix-grid').html;
  const status = page.el('#run-status').html;
  const lines = logSeqs(page);
  const reads = page.requests.length;
  const renamed = realRun();
  renamed.name = reg('renamed while replaying');
  await page.snapshot(renamed);
  await page.event({ runId: 'wf_x', seq: 77, ts: 1, kind: 'run.final', message: 'a real event', prov: 'final' });
  await page.hello('real'); // the real stream was cut and came back
  assert.equal(page.el('#matrix-grid').html, grid, 'the matrix is the replayed one');
  assert.equal(page.el('#run-status').html, status);
  assert.deepEqual(logSeqs(page), lines, 'no line of the real run');
  assert.equal(page.requests.length, reads, 'no read of the real run: neither the backlog nor the run');
  assert.match(page.el('#rp-cur').textContent, /renamed while replaying/, 'the picker row did follow the real stream');
  assert.equal(ctl(page).banner, true, 'the hello of a reconnect does not hide the banner');
  assert.equal(ctl(page).mark, true);
  assert.equal(page.el('#mode').textContent, 'REAL');
  await page.send(['event', uev(2)]);
  assert.deepEqual(logSeqs(page), [1, 2], 'the replay goes on');
}));

// ---- pause, resume, stop ----------------------------------------------------------------------------------------------------------

const doneStat = (page) => {
  const stat = page.el('#run-status').childNodes.find((c) => /^done/.test(c.textContent));
  return stat.querySelector('b').childNodes[0];
};

const HELLO = ['hello', { mode: 'replay', version: '1', runId: 'wf_x' }];
const END = (events) => ['end', { runId: 'wf_x', events }];
// an event with no agent: it lights nothing, so the only timer on the page is the replay queue's
const quiet = (seq) => uev(seq, { agentId: undefined, label: undefined });
const pauseBtn = (page) => page.el('#replay-pause');
// the writes made so far to an element and everything under it
const writesUnder = (n) => (n.writes ?? 0) + n.childNodes.reduce((sum, c) => sum + writesUnder(c), 0);

test('pause: frames are kept and none is applied; resume plays the events and the snapshots in the order they came, at the gaps they arrived with, and the end after them', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', uev(1)], ['run', rep(1)]);
  assert.equal(pauseBtn(page).textContent, 'Pause');
  await page.click(pauseBtn(page));
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Resume', stop: true, line: null, mark: true, banner: true });
  const before = { grid: page.el('#matrix-grid').html, status: page.el('#run-status').html };
  page.to(100); await page.send(['event', uev(2)], ['run', rep(2)]);
  page.to(200); await page.send(['event', uev(3)], ['event', uev(4)], ['run', rep(3)]);
  page.to(300); await page.send(['event', uev(5)], ['run', rep(4)], END(5));
  assert.deepEqual(logSeqs(page), [1], 'nothing was applied while paused');
  assert.equal(page.el('#matrix-grid').html, before.grid);
  assert.equal(page.el('#run-status').html, before.status);
  assert.equal(ctl(page).line, null, 'and the end is not shown yet');

  const node = doneStat(page);
  const writes = node.writes;
  assert.equal(node.data, '1');
  page.to(400);
  await page.click(pauseBtn(page)); // nothing was kept at the pause: the first kept frame (arrived at 100) is shown at the resume, the rest keep their gaps: 200 at 500, 300 at 600
  assert.deepEqual(logSeqs(page), [1, 2], 'the first kept frame is shown at the resume, not in a burst with the rest');
  assert.equal(node.data, '2', 'the snapshot comes at its place, after the event before it');
  assert.equal(ctl(page).pause, 'Pause', 'while it catches up the button is Pause');
  page.to(499);
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(500);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4]);
  assert.equal(node.data, '3');
  assert.equal(ctl(page).line, null);
  page.to(599);
  assert.equal(ctl(page).line, null, 'the end comes after the last kept frame');
  page.to(600);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5], 'the events in the order they came');
  assert.equal(node.data, '4');
  assert.equal(node.writes, writes + 3, 'every snapshot that has an event before it was drawn, once, in its place');
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true }, 'then the end');
}));

test('pace: arrivals at 0, 137 and 400 ms with a pause at 50 (nothing kept) for 1000 ms are applied at 0, 1050 and 1313; the button says Pause while it catches up and one timer waits', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  assert.deepEqual(logSeqs(page), [1], 'on arrival');
  assert.deepEqual(page.waiting(), [], 'no timer while playing with nothing kept');
  page.to(50); await page.click(pauseBtn(page));
  assert.equal(ctl(page).pause, 'Resume');
  page.to(137); await page.send(['event', quiet(2)]);
  page.to(400); await page.send(['event', quiet(3)]);
  assert.deepEqual(page.waiting(), [], 'no timer while paused');
  page.to(1050); await page.click(pauseBtn(page)); // the first kept frame (137) is shown at the resume: the view is behind by 913
  assert.deepEqual(logSeqs(page), [1, 2], 'the first kept frame is shown at the resume');
  assert.deepEqual(page.waiting(), [263], 'one timer, for the next frame: 400 + 913 = 1313');
  assert.equal(ctl(page).pause, 'Pause');
  page.to(1312);
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(1313);
  assert.deepEqual(logSeqs(page), [1, 2, 3], 'the gap between the kept frames is the gap they arrived with: 263');
  assert.deepEqual(page.waiting(), [], 'none when the queue is empty');
  assert.equal(ctl(page).pause, 'Pause', 'still playing: the replay has not ended');
}));

test('pace: two pauses add up, a pause while it catches up stops it again; frames that arrive meanwhile queue behind with the same offset, in order', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  page.to(50); await page.click(pauseBtn(page));
  page.to(137); await page.send(['event', quiet(2)]);
  page.to(400); await page.send(['event', quiet(3)]);
  page.to(1050); await page.click(pauseBtn(page)); // offset 913: 2 at 1050 (at the resume), 3 at 1313
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(1200); await page.click(pauseBtn(page)); // pause while catching up: 3 is kept
  assert.equal(ctl(page).pause, 'Resume', 'the button shows what a click does');
  assert.deepEqual(page.waiting(), [], 'stopped again');
  page.to(1300); await page.send(['event', quiet(4)]); // arrives while paused
  page.to(1700); await page.click(pauseBtn(page)); // a frame was kept: the whole 500 ms are added, offset 1413: 3 at 1813, 4 at 2713
  assert.equal(ctl(page).pause, 'Pause');
  page.to(1812);
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(1813);
  assert.deepEqual(logSeqs(page), [1, 2, 3]);
  page.to(1950); await page.send(['event', quiet(5)]); // arrives during the catch-up: behind 4, at 1950 + 1413
  page.to(2712);
  assert.deepEqual(logSeqs(page), [1, 2, 3]);
  page.to(2713);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4]);
  page.to(3362);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4]);
  page.to(3363);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5], 'the view runs behind the stream by what the pauses held back');
  assert.deepEqual(page.waiting(), []);
  // after the catch-up a frame is still behind by the same offset
  page.to(4000); await page.send(['event', quiet(6)]);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5]);
  page.to(5412);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5]);
  page.to(5413);
  assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5, 6]);
}));

test('pace: no timer is made while playing with nothing kept, however many frames come; Pause then Resume at once changes nothing', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO);
  for (let i = 1; i <= 100; i++) {
    page.to(i * 3);
    page.stream().push(sse('event', quiet(i)));
    if (i % 10 === 0) page.stream().push(sse('run', rep(i)));
  }
  await page.flush();
  assert.equal(logSeqs(page).length, 100, 'all applied on arrival');
  assert.deepEqual(page.waiting(), [], 'no timer');
  await page.click(pauseBtn(page));
  await page.click(pauseBtn(page));
  assert.deepEqual(page.waiting(), []);
}));

test('snapshots are frames like the others: one that follows an event is drawn after it, two with nothing between are one; the end comes after the last of them', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO);
  await page.click(pauseBtn(page));
  const seqAt = [];
  page.to(10); await page.send(['run', rep(1)]);
  page.to(20); await page.send(['event', uev(1)]);
  page.to(30); await page.send(['run', rep(2)]);
  page.to(40); await page.send(['run', rep(3)]); // rep(2) is directly followed by a newer snapshot: it is dropped
  page.to(50); await page.send(['event', uev(2)]);
  page.to(60); await page.send(['run', rep(4)], END(2));
  page.to(100);
  assert.equal(page.el('#matrix-grid').hidden, true, 'nothing drawn yet');
  await page.click(pauseBtn(page)); // nothing was kept at the pause: the first kept frame (arrived at 10) is shown at 100, the others keep their gaps (offset 90)
  const done = () => { const stat = page.el('#run-status').childNodes.find((c) => /^done/.test(c.textContent)); return stat ? stat.querySelector('b').childNodes[0].data : null; };
  const trail = [];
  for (let t = 100; t <= 200; t += 1) {
    page.to(t);
    const now = `${logSeqs(page).join(',')}|${done()}`;
    if (trail.at(-1) !== now) { trail.push(now); seqAt.push(t); }
  }
  assert.deepEqual(trail, ['|1', '1|1', '1|3', '1,2|3', '1,2|4'], 'run 1 (at the resume), event 1, run 3 (run 2 never drawn), event 2, run 4');
  assert.deepEqual(seqAt, [100, 110, 130, 140, 150], 'each at its arrival time plus the 90 ms the first kept frame was due before the resume');
  assert.equal(ctl(page).line, 'replay finished');
}));

test('end: "replay finished" appears only after the last kept frame, and the stream that closes right after `end` does not cut the queue short', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  await page.click(pauseBtn(page));
  page.to(100); await page.send(['event', quiet(2)]);
  page.to(200); await page.send(['run', rep(2, { status: fin('completed') })], END(2));
  stream.end();
  await page.flush();
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Resume', stop: true, line: null, mark: true, banner: true }, 'still paused, no error, no end');
  page.to(500); await page.click(pauseBtn(page)); // nothing was kept at the pause: 2 is shown at 500 (offset 400), the run and the end at 600
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Pause', stop: true, line: null, mark: true, banner: true }, 'catching up: Pause, no end yet, no error from the closed stream');
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.equal(ctl(page).line, null);
  page.to(599);
  assert.equal(ctl(page).line, null);
  page.to(600);
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true });
  assert.match(page.el('#run-status').textContent, /status\s*completed/);
  assert.equal(page.replayRequests().length, 1, 'no reconnect');
  assert.deepEqual(page.waiting(), []);
}));

test('failure while frames are kept: nothing kept is dropped; while paused they stay, on Resume they are played and the line with its reason comes after the last of them', async () => {
  for (const how of ['breaks', 'ends before the end', 'a snapshot that is not the replay', 'a frame that is not JSON']) {
    const page = await realPage();
    try {
      const stream = await startedReplay(page);
      await page.send(HELLO, ['event', quiet(1)]);
      await page.click(pauseBtn(page));
      page.to(100); await page.send(['event', quiet(2)]);
      page.to(200); await page.send(['event', quiet(3)]);
      page.to(300);
      if (how === 'breaks') stream.fail('network error');
      else if (how === 'ends before the end') stream.end();
      else if (how === 'a snapshot that is not the replay') await page.send(['run', realRun()]);
      else { stream.push('event: event\ndata: {oops\n\n'); }
      await page.flush();
      const line = { breaks: 'network error', 'ends before the end': 'stream ended before the end (3 events played)', 'a snapshot that is not the replay': /not the replay of "wf_x"/, 'a frame that is not JSON': /could not be read \(event\)/ }[how];
      assert.deepEqual([ctl(page).pause, ctl(page).line, ctl(page).go, ctl(page).stop], ['Resume', null, null, true], `${how}: while paused nothing is shown, Resume is there`);
      assert.deepEqual(logSeqs(page), [1], `${how}: nothing was applied`);
      page.to(2000); // time passes while paused: no timer, nothing applied
      assert.deepEqual(logSeqs(page), [1]);
      assert.deepEqual(page.waiting(), []);
      page.to(2100); await page.click(pauseBtn(page)); // paused 2000 - 50... the frames are due at (their arrival + the time paused)
      assert.equal(ctl(page).pause, 'Pause', `${how}: Pause while the kept frames play`);
      assert.equal(ctl(page).line, null, `${how}: the failure is not shown before the frames that came before it`);
      const play = [];
      for (let t = page.clock.t; t <= page.clock.t + 3000; t += 10) { page.to(t); play.push(`${logSeqs(page).join(',')}|${ctl(page).line === null ? '' : 'line'}`); if (ctl(page).line !== null) break; }
      assert.deepEqual(logSeqs(page), [1, 2, 3], `${how}: every kept frame was played`);
      if (line instanceof RegExp) assert.match(ctl(page).line, line, how); else assert.equal(ctl(page).line, line, how);
      assert.equal(play.at(-1), '1,2,3|line', `${how}: the line comes with the last frame, not before it`);
      assert.equal(play.some((x) => x === '1,2|line' || x === '1|line'), false, `${how}: never before the frames`);
      assert.deepEqual([ctl(page).go, ctl(page).stop, ctl(page).pause, ctl(page).mark], ['Replay again', true, null, true], how);
      assert.equal(page.el('#replay-line').classes.has('bad'), true);
      assert.deepEqual(page.waiting(), [], `${how}: no timer is left`);
      assert.equal(page.replayRequests().length, 1, 'no reconnect');
      await page.click(page.el('#replay-stop'));
      assert.equal(ctl(page).mark, false);
    } finally {
      page.restore();
    }
  }
});

// The same frames as above, but they come while the kept frames are already playing: Resume was pressed (phase playing, the button says
// Pause) and one frame (3) is still kept. What arrives goes behind it, due at its arrival time plus the offset; nothing of it is
// applied or shown at arrival, and nothing that was kept is dropped.
test('catching up: a failure, a cut, the end or a snapshot that arrives while kept frames are still playing goes behind them and is shown at its own turn, never at arrival', async () => {
  const cases = [
    ['the stream breaks', (page, stream) => stream.fail('network error'), { line: 'network error', bad: true }],
    ['the stream closes with no end', (page, stream) => stream.end(), { line: 'stream ended before the end (3 events played)', bad: true }],
    ['a snapshot that is not the replay', (page) => page.send(['run', realRun()]), { line: /not the replay of "wf_x"/, bad: true }],
    ['a frame that is not JSON', (page, stream) => stream.push('event: event\ndata: {oops\n\n'), { line: /could not be read \(event\)/, bad: true }],
    ['the end, then the stream closes', async (page, stream) => { await page.send(END(3)); stream.end(); }, { line: 'replay finished', bad: false }],
    ['a snapshot', (page) => page.send(['run', rep(9)]), { line: null, bad: false, done: '9' }],
  ];
  for (const [how, arrive, after] of cases) {
    const page = await realPage();
    try {
      const stream = await startedReplay(page);
      await page.send(HELLO, ['event', quiet(1)], ['run', rep(1)]);
      const done = () => doneStat(page).data;
      assert.equal(done(), '1');
      await page.click(pauseBtn(page));
      page.to(100); await page.send(['event', quiet(2)]);
      page.to(200); await page.send(['event', quiet(3)]);
      page.to(500); await page.click(pauseBtn(page)); // nothing was kept at the pause: 2 is shown at 500 (offset 400), 3 is due at 600
      page.to(550);
      assert.deepEqual(logSeqs(page), [1, 2], `${how}: frame 3 is still kept`);
      assert.equal(ctl(page).pause, 'Pause', `${how}: catching up, not paused`);
      await arrive(page, stream);
      await page.flush();
      const quietNow = (when) => {
        assert.deepEqual([ctl(page).pause, ctl(page).line, ctl(page).go, ctl(page).stop], ['Pause', null, null, true], `${how}: ${when}: still playing, nothing shown`);
        assert.equal(page.el('#replay-line').classes.has('bad'), false, `${how}: ${when}`);
        assert.equal(done(), '1', `${how}: ${when}: no snapshot drawn`);
      };
      quietNow('at arrival');
      assert.deepEqual(logSeqs(page), [1, 2], `${how}: nothing was applied at arrival`);
      assert.deepEqual(page.waiting(), [100], `${how}: one timer, for the frame that was kept (set at 500 for 600); the arrival made no second one`);
      page.to(599);
      assert.deepEqual(logSeqs(page), [1, 2], how);
      page.to(600);
      assert.deepEqual(logSeqs(page), [1, 2, 3], `${how}: the kept frame is played first`);
      quietNow('after the kept frame');
      assert.deepEqual(page.waiting(), [350], `${how}: one timer, for the frame that arrived (550 + 400 = 950, set at 600)`);
      page.to(949);
      quietNow('just before its turn');
      assert.deepEqual(logSeqs(page), [1, 2, 3], how);
      page.to(950);
      assert.deepEqual(logSeqs(page), [1, 2, 3], `${how}: every frame was played`);
      if (after.line instanceof RegExp) assert.match(ctl(page).line, after.line, how); else assert.equal(ctl(page).line, after.line, how);
      assert.equal(page.el('#replay-line').classes.has('bad'), after.bad, how);
      if (after.line === null) {
        assert.deepEqual([ctl(page).pause, ctl(page).go, ctl(page).stop], ['Pause', null, true], `${how}: still playing`);
        assert.equal(done(), after.done, `${how}: the snapshot is drawn at its turn`);
      } else {
        assert.deepEqual([ctl(page).pause, ctl(page).go, ctl(page).stop, ctl(page).mark], [null, 'Replay again', true, true], how);
        assert.equal(done(), '1', `${how}: no snapshot came`);
      }
      assert.deepEqual(page.waiting(), [], `${how}: no timer is left`);
      assert.equal(page.replayRequests().length, 1, `${how}: no reconnect`);
    } finally {
      page.restore();
    }
  }
});

test('failure while frames are kept: Pause and Resume stay usable until the queue is empty, and Stop drops what was kept (the failure line too) and goes back to the real view', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  await page.click(pauseBtn(page));
  page.to(100); await page.send(['event', quiet(2)]);
  page.to(200); await page.send(['event', quiet(3)]);
  stream.fail('network error');
  await page.flush();
  page.to(1000); await page.click(pauseBtn(page)); // nothing was kept at the first pause: offset 900: 2 at 1000 (at the resume), 3 and the failure at 1100
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(1050);
  await page.click(pauseBtn(page)); // pause again, catching up: 3 and the failure are kept
  assert.equal(ctl(page).pause, 'Resume');
  assert.deepEqual(page.waiting(), []);
  page.to(5000);
  assert.deepEqual(logSeqs(page), [1, 2], 'still paused: nothing more');
  assert.equal(ctl(page).line, null);
  await page.click(pauseBtn(page)); // frames were kept: the whole 3950 ms are added, offset 4850
  assert.equal(ctl(page).pause, 'Pause');
  page.to(5049);
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.equal(ctl(page).line, null);
  page.to(5050); // 3 and the failure were due at 200 + 4850
  assert.deepEqual(logSeqs(page), [1, 2, 3]);
  assert.equal(ctl(page).line, 'network error');
  // Stop with a failure frame and frames still kept
  const second = await realPage();
  try {
    const st = await startedReplay(second);
    await second.send(HELLO, ['event', quiet(1)]);
    await second.click(pauseBtn(second));
    second.to(100); await second.send(['event', quiet(2)]);
    st.fail('network error');
    await second.flush();
    await second.click(second.el('#replay-stop'));
    assert.deepEqual(ctl(second), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false }, 'back to the real view, no line');
    assert.deepEqual(second.waiting(), []);
    second.to(10000);
    assert.equal(ctl(second).line, null, 'the dropped failure line never comes');
    assert.deepEqual(logSeqs(second), []);
  } finally {
    second.restore();
  }
}));

test('failure found when a frame is applied (events out of order): shown at once, the frames behind it are not played (a snapshot, an event that is valid by itself and the end), no timer is left', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)], ['run', rep(1)]);
  await page.click(pauseBtn(page));
  page.to(100); await page.send(['event', quiet(2)]);
  page.to(200); await page.send(['event', quiet(4)]); // 4 after 2: a gap
  // behind the gap, each valid by itself: a snapshot, the event that fills the gap (3 after 2), and the end
  page.to(210); await page.send(['run', rep(7)]);
  page.to(220); await page.send(['event', quiet(3)]);
  page.to(230); await page.send(END(4));
  page.to(300); await page.click(pauseBtn(page)); // nothing was kept at the pause: offset 200 (2 arrived at 100): 2 at 300, 4 at 400, the snapshot at 410, 3 at 420, the end at 430
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.equal(ctl(page).line, null);
  page.to(399);
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.equal(ctl(page).line, null);
  page.to(400);
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.match(ctl(page).line, /out of order \(seq 4 after 2\)/);
  assert.deepEqual([ctl(page).go, ctl(page).pause, ctl(page).stop], ['Replay again', null, true]);
  assert.deepEqual(page.waiting(), []);
  page.to(5000);
  assert.deepEqual(logSeqs(page), [1, 2], 'the event behind the broken order is not shown');
  assert.equal(doneStat(page).data, '1', 'nor the snapshot');
  assert.match(ctl(page).line, /out of order \(seq 4 after 2\)/, 'nor does the end replace the failure with "replay finished"');
  assert.equal(page.el('#replay-line').classes.has('bad'), true);
  assert.deepEqual([ctl(page).go, ctl(page).pause, ctl(page).stop], ['Replay again', null, true]);
  assert.deepEqual(page.waiting(), []);
}));

test('the count in a cut line is the events applied when the line is shown, not the events received', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)], ['event', quiet(2)]);
  await page.click(pauseBtn(page));
  page.to(100); await page.send(['event', quiet(3)]);
  page.to(200); await page.send(['event', quiet(4)]);
  stream.end(); // the stream closes with no `end`
  await page.flush();
  page.to(300); await page.click(pauseBtn(page)); // nothing was kept at the pause: offset 200: 3 at 300, 4 at 400, the cut at 400
  page.to(350);
  assert.deepEqual(logSeqs(page), [1, 2, 3], 'four events came, three are applied');
  assert.equal(ctl(page).line, null);
  page.to(399);
  assert.equal(ctl(page).line, null);
  page.to(400);
  assert.equal(ctl(page).line, 'stream ended before the end (4 events played)');
}));

test('Stop, another run, Replay again and the page going away each leave no timer of the queue and apply nothing that was kept', async () => {
  const other = run([agent('o1', 'other:one')], { id: 'wf_y', name: reg('the other run') });
  const real = realRun();
  for (const how of ['stop', 'another run', 'replay again', 'page hide']) {
    const page = await bootPage({ runs: [summary(real), summary(other)], runDocs: { wf_x: real, wf_y: other }, events: { wf_x: [], wf_y: [] }, hash: '#range=all' });
    try {
      await page.click(page.el('#rp-trigger'));
      await page.click(rowOf(page, 'wf_x'));
      const stream = await startedReplay(page);
      await page.send(HELLO, ['event', quiet(1)]);
      await page.click(pauseBtn(page));
      page.to(100); await page.send(['event', quiet(2)]);
      page.to(200); await page.send(['event', quiet(3)]);
      page.to(300); await page.click(pauseBtn(page)); // 2 is shown at the resume (offset 200), 3 is due at 400
      assert.deepEqual(page.waiting(), [100], `${how}: a timer waits for frame 3`);
      if (how === 'stop') await page.click(page.el('#replay-stop'));
      else if (how === 'another run') { await page.click(page.el('#rp-trigger')); await page.click(rowOf(page, 'wf_y')); } else if (how === 'replay again') {
        // a replay that can be started again: it must have ended or failed; a failure frame at the end of the queue ends it here
        stream.fail('x');
        await page.flush();
        page.to(1000);
        assert.equal(ctl(page).line, 'x');
        assert.equal(ctl(page).go, 'Replay again');
      } else { assert.equal(page.windowListeners.pagehide?.length, 1, 'one pagehide listener'); for (const fn of page.windowListeners.pagehide) fn({}); }
      if (how === 'replay again') {
        page.to(1000);
        const logged = logSeqs(page);
        await page.click(page.el('#replay-go')); // the old queue is dropped: nothing of it plays into the new view
        assert.deepEqual(page.waiting(), [], `${how}: no timer of the old queue`);
        await page.send(HELLO, ['event', quiet(1)]);
        assert.deepEqual(logSeqs(page), [1], 'the new replay starts from empty');
        assert.notDeepEqual(logged, []);
      } else {
        assert.deepEqual(page.waiting(), [], `${how}: no timer is left`);
        const seqs = logSeqs(page);
        page.to(10000);
        assert.deepEqual(logSeqs(page), seqs, `${how}: nothing that was kept is applied afterwards`);
        assert.equal(stream.aborted, true, how);
      }
    } finally {
      page.restore();
    }
  }
});

test('the control tells the truth through a replay: Pause, Resume, Pause while catching up, Resume; a stream that has ended its frames still shows Pause until the last is applied', withPage(async (page) => {
  const stream = await startedReplay(page);
  assert.equal(ctl(page).pause, 'Pause', 'connecting');
  await page.send(HELLO, ['event', quiet(1)]);
  assert.equal(ctl(page).pause, 'Pause');
  await page.click(pauseBtn(page));
  assert.equal(ctl(page).pause, 'Resume');
  page.to(100); await page.send(['event', quiet(2)]);
  page.to(200); await page.send(['event', quiet(3)], END(3));
  stream.end();
  await page.flush();
  assert.equal(ctl(page).pause, 'Resume');
  page.to(1000); await page.click(pauseBtn(page)); // nothing was kept at the pause: 2 is shown at 1000 (offset 900), 3 and the end are due at 1100
  assert.equal(ctl(page).pause, 'Pause', 'catching up');
  page.to(1050);
  assert.equal(ctl(page).pause, 'Pause', 'the stream is over but the frames are not all played');
  await page.click(pauseBtn(page));
  assert.equal(ctl(page).pause, 'Resume');
  page.to(2000);
  assert.deepEqual(logSeqs(page), [1, 2]);
  await page.click(pauseBtn(page)); // 3 and the end were kept: the whole 950 ms are added, they are due at 2050
  assert.equal(ctl(page).pause, 'Pause');
  page.to(2049);
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(3000);
  assert.deepEqual(logSeqs(page), [1, 2, 3]);
  assert.equal(ctl(page).line, 'replay finished');
  assert.equal(ctl(page).pause, null, 'no Pause or Resume after the end');
}));

test('highlight: a pending highlight end never changes the centre view while the replay is paused; a highlight that has run out is taken off at Resume, one that has not ends at its own time', async () => {
  for (const [name, pausedFor, litAfter] of [['run out meanwhile', 2000, false], ['not yet run out', 600, true]]) {
    const page = await realPage();
    try {
      await startedReplay(page);
      await page.send(HELLO, ['run', rep(1)], ['event', uev(1)]);
      const lit = () => page.el('#matrix-grid').querySelectorAll('[data-agent]').filter((c) => c.classes.has('flash'));
      assert.ok(lit().length > 0, `${name}: the agent of the event is lit`);
      assert.ok(page.waiting().includes(1530), `${name}: its end is a timer`);
      page.to(100); await page.click(pauseBtn(page));
      assert.equal(page.waiting().includes(1530), false, `${name}: the end timer is held while paused`);
      const centre = page.el('.center');
      const writes = writesUnder(centre);
      page.advance(pausedFor);
      assert.equal(writesUnder(centre), writes, `${name}: nothing in the centre view was written while paused`);
      assert.ok(lit().length > 0, `${name}: still as it was`);
      await page.click(pauseBtn(page));
      assert.equal(lit().length > 0, litAfter, `${name}: after Resume`);
      page.advance(2000);
      assert.equal(lit().length, 0, `${name}: and in the end it is off`);
      assert.deepEqual(page.waiting(), [], name);
    } finally {
      page.restore();
    }
  }
});

test('highlight: two events of one agent at the same time leave one pending end (the second cancels the first\'s); Pause holds it, so the centre view is not written while paused', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['run', rep(1)], ['event', uev(1)], ['event', uev(2)]); // the page clock does not move: both lit at the same time
  const lit = () => page.el('#matrix-grid').querySelectorAll('[data-agent]').filter((c) => c.classes.has('flash'));
  assert.ok(lit().length > 0, 'the agent is lit');
  assert.deepEqual(page.waiting(), [1530], 'one end for the agent, not one per event');
  page.to(100); await page.click(pauseBtn(page));
  assert.deepEqual(page.waiting(), [], 'no end is left to fire while paused');
  const centre = page.el('.center');
  const writes = writesUnder(centre);
  page.advance(2000);
  assert.equal(writesUnder(centre), writes, 'nothing in the centre view was written while paused');
  assert.ok(lit().length > 0, 'still lit as it was');
  await page.click(pauseBtn(page));
  assert.equal(lit().length, 0, 'the highlight that ran out meanwhile is taken off at Resume');
  assert.deepEqual(page.waiting(), []);
}));

test('a replay that failed before it ever showed does not keep the real Run it was started from: the control follows the Run that is on show', async () => {
  const page = await realPage({ boot: { answer: async () => ({ ok: false, status: 404, json: async () => ({ error: 'no run "wf_x" under "/r"' }) }) } });
  try {
    await page.click(page.el('#replay-go'));
    assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: 'no run "wf_x" under "/r"', mark: false, banner: false });
    const running = realRun();
    running.status = { value: 'running', prov: 'inferred', method: 'no-final-file' };
    await page.snapshot(running); // the real run started again
    assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: null, stop: false, line: 'no run "wf_x" under "/r"', mark: false, banner: false }, 'no Replay for a running run; the line stays');
    await page.snapshot(realRun());
    assert.equal(ctl(page).go, 'Replay', 'and back when it is final again');
    assert.equal(ctl(page).line, 'no run "wf_x" under "/r"');
    // a run of no source is no real run: no control either
    const none = realRun();
    delete none.source;
    await page.snapshot(none);
    assert.equal(ctl(page).go, null);
  } finally {
    page.restore();
  }
});

// The real stream comes back (a reconnect) while a replay is being opened: the run is read again, and the answer is slow. The replay shows
// (its hello) before the answer, and the real stream is ignored from then on, so nothing puts a real Run back. The control must still know
// the real Run it was started from.
const holdRunRead = (page, id) => {
  const orig = globalThis.fetch;
  setGlobal('fetch', (url, init) => {
    if (String(url) !== `/api/runs/${id}`) return orig(url, init);
    page.requests.push(String(url)); // the request is made, and never answered
    return new Promise(() => {});
  });
};

test('a reconnect of the real stream while the replay is being opened (the run is read again, the answer is slow): at the end and at a cut the control still has Replay again and the speeds', async () => {
  for (const how of ['end', 'cut']) {
    const page = await realPage();
    try {
      holdRunRead(page, 'wf_x');
      const stream = await startedReplay(page); // connecting, the real view is on show
      await page.hello('real'); // the real stream came back: the run is read again, the answer is held back
      assert.equal(page.runRequests('wf_x').length, 2, `${how}: the run is being read again`);
      await page.send(HELLO, ['event', quiet(1)]);
      assert.deepEqual([ctl(page).mark, ctl(page).pause], [true, 'Pause'], `${how}: the replay is on show`);
      if (how === 'end') await page.send(END(1));
      else { stream.end(); await page.flush(); }
      const line = how === 'end' ? 'replay finished' : 'stream ended before the end (1 event played)';
      assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line, mark: true, banner: true }, `${how}: Replay again and the speeds are there`);
    } finally {
      page.restore();
    }
  }
});

test('a replay that was refused, then a reconnect of the real stream with the run read slowly: Replay is still offered, and a new replay keeps the real Run it was started from', async () => {
  const page = await realPage({ boot: { answer: async () => ({ ok: false, status: 404, json: async () => ({ error: 'gone' }) }) } });
  try {
    holdRunRead(page, 'wf_x');
    await startedReplay(page);
    assert.deepEqual([ctl(page).go, ctl(page).line, ctl(page).mark], ['Replay', 'gone', false]);
    await page.hello('real'); // the run is read again, the answer is held back: no real Run is on show
    assert.deepEqual([ctl(page).go, ctl(page).line], ['Replay', 'gone'], 'the control still follows the Run the replay was started from');
    page.answer = null; // the next request is answered with a stream
    await startedReplay(page); // a click on Replay in that window
    await page.send(HELLO, ['event', quiet(1)], END(1));
    assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true }, 'Replay again and the speeds at the end of the new replay');
  } finally {
    page.restore();
  }
});

test('pause: a resume with nothing kept changes nothing; pausing twice in a row is Pause then Resume; Pause and Resume are not offered once it has ended', withPage(async (page) => {
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
  const html = page.el('#matrix-grid').html;
  await page.click(page.el('#replay-pause'));
  await page.click(page.el('#replay-pause'));
  assert.equal(ctl(page).pause, 'Pause');
  assert.equal(page.el('#matrix-grid').html, html);
  assert.deepEqual(logSeqs(page), [1]);
  await page.send(['event', uev(2)]);
  assert.deepEqual(logSeqs(page), [1, 2], 'playing again');
}));

test('pause: a resume with nothing kept and nothing arrived delays nothing: a frame that comes later is applied on arrival, with no timer', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  page.to(100); await page.click(pauseBtn(page));
  page.to(600); await page.click(pauseBtn(page)); // 500 ms, nothing kept, nothing arrived
  assert.deepEqual(page.waiting(), []);
  page.to(700); await page.send(['event', quiet(2)]);
  assert.deepEqual(logSeqs(page), [1, 2], 'the view was never behind the stream: applied at once');
  assert.deepEqual(page.waiting(), [], 'no timer');
}));

test('pause: a pause before the hello that is resumed later delays nothing: the hello and the first event at the resume are applied at once, with no timer', withPage(async (page) => {
  await startedReplay(page); // connecting: the control already offers Pause
  assert.equal(ctl(page).pause, 'Pause');
  page.to(100); await page.click(pauseBtn(page));
  assert.equal(ctl(page).pause, 'Resume');
  page.to(10100); await page.click(pauseBtn(page));
  assert.equal(ctl(page).pause, 'Pause');
  await page.send(HELLO, ['event', quiet(1)]);
  assert.deepEqual(logSeqs(page), [1], 'applied at 10100, when it arrived');
  assert.deepEqual(page.waiting(), [], 'no timer');
  page.to(10200); await page.send(['event', quiet(2)]);
  assert.deepEqual(logSeqs(page), [1, 2], 'and the view is not behind the stream afterwards');
  assert.deepEqual(page.waiting(), []);
}));

test('pause: a frame that arrives in a pause with nothing kept is shown at the resume, a later pause with a frame kept keeps the wait it had left', withPage(async (page) => {
  await startedReplay(page);
  await page.send(HELLO, ['event', quiet(1)]);
  page.to(100); await page.click(pauseBtn(page)); // nothing kept
  page.to(9900); await page.send(['event', quiet(2)]);
  assert.deepEqual(logSeqs(page), [1]);
  page.to(10000); await page.click(pauseBtn(page)); // the frame was due 100 ms before the resume
  assert.deepEqual(logSeqs(page), [1, 2], 'shown at the resume');
  assert.deepEqual(page.waiting(), []);
  page.to(10050); await page.send(['event', quiet(3)]); // behind by the 100 ms: due 10150
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(10100); await page.click(pauseBtn(page)); // frame 3 is kept, 50 ms of its wait are left
  page.to(10600); await page.click(pauseBtn(page)); // 500 ms with a frame kept: all of them are added, it is due at 10650
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(10649);
  assert.deepEqual(logSeqs(page), [1, 2]);
  page.to(10650);
  assert.deepEqual(logSeqs(page), [1, 2, 3]);
  assert.deepEqual(page.waiting(), []);
}));

test('pause: the stream that ends right after `end` while paused is not "cut short"; the resume then applies the end', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
  await page.click(page.el('#replay-pause'));
  await page.send(['event', uev(2)], ['run', rep(2, { status: fin('completed') })], ['end', { runId: 'wf_x', events: 2 }]);
  stream.end();
  await page.flush();
  assert.deepEqual(ctl(page), { ctl: true, speed: false, go: null, pause: 'Resume', stop: true, line: null, mark: true, banner: true }, 'still paused, no error');
  await page.click(page.el('#replay-pause'));
  assert.deepEqual(logSeqs(page), [1, 2]);
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay again', pause: null, stop: true, line: 'replay finished', mark: true, banner: true });
}));

test('pause: the end that arrives while paused waits for the resume, and a stop while paused drops what was kept', withPage(async (page) => {
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
  await page.click(page.el('#replay-pause'));
  await page.send(['event', uev(2)], ['end', { runId: 'wf_x', events: 2 }]);
  await page.click(page.el('#replay-stop'));
  assert.equal(ctl(page).mark, false);
  assert.equal(ctl(page).go, 'Replay', 'back to the real view with the Replay control');
  assert.deepEqual(logSeqs(page), [], 'what was kept is not applied after the stop (the real run has no events)');
}));

test('stop: the stream is aborted, the real view of the run is read again (the run and its backlog), the control and the marks go back, later frames change nothing', withPage(async (page) => {
  const stream = await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
  const reads = page.runRequests('wf_x').length;
  await page.click(page.el('#replay-stop'));
  assert.equal(stream.aborted, true);
  assert.equal(page.runRequests('wf_x').length, reads + 1, 'the real Run is read again');
  assert.equal(page.requests.filter((u) => u === '/api/runs/wf_x/events?since=0').length, 2, 'and its backlog');
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false });
  assert.equal(page.el('#matrix-grid').hidden, false);
  assert.match(page.el('#run-status').textContent, /status\s*completed/);
  assert.match(page.el('#matrix-grid').textContent, /real/, 'the real run is back');
  stream.push(sse('event', uev(2)) + sse('run', rep(2)));
  await page.flush();
  assert.deepEqual(logSeqs(page), [], 'a frame of the stream that was left is ignored');
  assert.equal(page.replayRequests().length, 1);
}));

test('stop after the end goes back to the real view as well', withPage(async (page) => {
  await startedReplay(page);
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1, { status: fin('completed') })], ['end', { runId: 'wf_x', events: 1 }]);
  await page.click(page.el('#replay-stop'));
  assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false });
  assert.match(page.el('#matrix-grid').textContent, /real/);
}));

test('choosing another run in the picker stops the replay (aborted, mark and banner gone) and reads only the new run', async () => {
  const other = run([agent('o1', 'other:one')], { id: 'wf_y', name: reg('the other run') });
  const real = realRun();
  const page = await bootPage({ runs: [summary(real), summary(other)], runDocs: { wf_x: real, wf_y: other }, events: { wf_x: [], wf_y: [] }, hash: '#range=all' });
  try {
    await page.click(page.el('#rp-trigger'));
    await page.click(rowOf(page, 'wf_x')); // closes the dropdown on the run that is on show
    const stream = await startedReplay(page);
    await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', rep(1)]);
    const reads = page.runRequests('wf_x').length;
    await page.click(page.el('#rp-trigger'));
    await page.click(rowOf(page, 'wf_y'));
    assert.equal(stream.aborted, true);
    assert.equal(page.runRequests('wf_x').length, reads, 'the old run is not read again');
    assert.equal(page.runRequests('wf_y').length, 1);
    assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false }, 'the other run is a finished real run: it can be replayed');
    assert.match(page.el('#matrix-grid').textContent, /other/);
    assert.deepEqual(logSeqs(page), []);
    stream.push(sse('event', uev(2)));
    await page.flush();
    assert.deepEqual(logSeqs(page), [], 'a frame of the stopped replay is not drawn into the other run');
  } finally {
    page.restore();
  }
});

// ---- errors: always a line with the reason ------------------------------------------------------------------------------------------

async function refusal(status, body, { json = true } = {}) {
  const page = await realPage({ boot: { answer: async () => ({ ok: false, status, json: async () => { if (!json) throw new Error('not json'); return body; } }) } });
  try {
    await page.click(page.el('#replay-go'));
    await page.flush();
    return { c: ctl(page), page, grid: page.el('#matrix-grid').hidden };
  } finally {
    page.restore();
  }
}

test('errors: a refusal shows the reason of the body as a line with the Replay control; the real view is not touched; 409, 429, 404, 400 and a body that is no JSON', async () => {
  for (const [status, body, line] of [
    [409, { error: 'the run is still running: only a finished run can be replayed' }, 'the run is still running: only a finished run can be replayed'],
    [429, { error: '3 replays are already open: close one first' }, '3 replays are already open: close one first'],
    [404, { error: 'run not found' }, 'run not found'],
    [400, { error: 'speed must be a number above 0' }, 'speed must be a number above 0'],
    [500, null, 'HTTP 500'],
  ]) {
    const r = await refusal(status, body);
    assert.deepEqual(r.c, { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line, mark: false, banner: false }, String(status));
    assert.equal(r.grid, false, `${status}: the real matrix is still there`);
  }
  const notJson = await refusal(502, null, { json: false });
  assert.equal(notJson.c.line, 'HTTP 502');
});

test('errors: a request that fails (the network) shows the error\'s message; the line stays until the next click, which clears it', async () => {
  let fail = true;
  const page = await realPage({ boot: {
    answer: async (u, init) => {
      if (fail) throw new TypeError('Failed to fetch');
      const stream = makeStream(init?.signal);
      page.streams.push(stream);
      return { ok: true, status: 200, body: { getReader: () => stream.reader } };
    },
  } });
  try {
    await page.click(page.el('#replay-go'));
    assert.equal(ctl(page).line, 'Failed to fetch');
    assert.equal(ctl(page).go, 'Replay');
    await page.click(page.el('#replay-s1'));
    assert.equal(ctl(page).line, 'Failed to fetch', 'choosing a speed does not clear it');
    fail = false;
    await page.click(page.el('#replay-go'));
    assert.equal(ctl(page).line, null, 'the next click starts over');
    assert.equal(ctl(page).pause, 'Pause');
  } finally {
    page.restore();
  }
});

test('errors: the reason is text: a markup in it is shown as the characters, no element is made', async () => {
  const evil = '<img src=x onerror="alert(1)"> & "quoted"';
  const r = await refusal(409, { error: evil });
  const line = r.page.el('#replay-line');
  assert.equal(line.textContent, evil);
  assert.equal(line.childNodes.length, 0, 'set as text, not parsed');
  assert.equal(line.htmlWrites, 0);
});

test('errors: a failure line goes away when another run is chosen', async () => {
  const other = run([agent('o1', 'other:one')], { id: 'wf_y', name: reg('the other run') });
  const real = realRun();
  const page = await bootPage({
    runs: [summary(real), summary(other)], runDocs: { wf_x: real, wf_y: other }, events: { wf_x: [], wf_y: [] }, hash: '#range=all',
    answer: async () => ({ ok: false, status: 409, json: async () => ({ error: 'the run is still running' }) }),
  });
  try {
    await page.click(page.el('#replay-go'));
    assert.equal(ctl(page).line, 'the run is still running');
    await page.click(page.el('#rp-trigger'));
    await page.click(rowOf(page, 'wf_y'));
    assert.equal(ctl(page).line, null);
    assert.equal(ctl(page).go, 'Replay');
  } finally {
    page.restore();
  }
});

test('errors: a hello that is not the replay of this run, a first frame that is not hello, a snapshot that is not the replayed Run, a frame that is not JSON', async () => {
  const cases = [
    ['wrong mode', (p) => p.send(['hello', { mode: 'real', version: '1', runId: 'wf_x' }]), /unexpected hello.*"real"/],
    ['wrong run', (p) => p.send(['hello', { mode: 'replay', version: '1', runId: 'wf_other' }]), /unexpected hello.*wf_other/],
    ['no hello first', (p) => p.send(['event', uev(1)]), /did not start with its hello/],
    ['a real Run', async (p) => { await p.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }]); await p.send(['run', realRun()]); }, /not the replay of "wf_x"/],
    ['not JSON', async (p) => { await p.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }]); p.stream().push('event: event\ndata: {oops\n\n'); await p.flush(); }, /could not be read \(event\)/],
  ];
  for (const [what, play, line] of cases) {
    const page = await realPage();
    try {
      const stream = await startedReplay(page);
      await play(page);
      const c = ctl(page);
      assert.match(c.line, line, what);
      assert.equal(c.go !== null && c.pause === null, true, `${what}: the control is Replay${c.stop ? ' again' : ''}`);
      assert.equal(stream.aborted, true, `${what}: the stream was left`);
      assert.equal(page.el('#replay-line').classes.has('bad'), true, `${what}: it looks like an error`);
    } finally {
      page.restore();
    }
  }
});

test('errors: a stream that ends before `end` says so with the count so far; one that breaks says why; both leave what was shown and a way back (Replay again, Stop)', async () => {
  for (const how of ['ends', 'breaks']) {
    const page = await realPage();
    try {
      const stream = await startedReplay(page);
      await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['event', uev(2)], ['run', rep(2)]);
      if (how === 'ends') stream.end(); else stream.fail('network error');
      await page.flush();
      const c = ctl(page);
      assert.equal(c.line, how === 'ends' ? 'stream ended before the end (2 events played)' : 'network error', how);
      assert.deepEqual([c.go, c.stop, c.pause, c.mark, c.banner], ['Replay again', true, null, true, true], how);
      assert.deepEqual(logSeqs(page), [1, 2], 'what was shown stays');
      assert.equal(page.replayRequests().length, 1, 'no reconnect');
      await page.click(page.el('#replay-stop'));
      assert.deepEqual(ctl(page), { ctl: true, speed: true, go: 'Replay', pause: null, stop: false, line: null, mark: false, banner: false }, 'Stop goes back to the real view');
    } finally {
      page.restore();
    }
  }
});

test('errors: a stream that closes at once (no frame) is "stream ended before the end (0 events played)", never a silent stop', withPage(async (page) => {
  const stream = await startedReplay(page);
  stream.end();
  await page.flush();
  assert.equal(ctl(page).line, 'stream ended before the end (0 events played)');
  assert.equal(ctl(page).go, 'Replay');
  assert.equal(page.el('#matrix-grid').hidden, false, 'the real view was never replaced');
}));

test('errors: an event out of order is a failure with a line (the page never asks the real run\'s backlog for it)', withPage(async (page) => {
  await startedReplay(page);
  const reads = page.requests.length;
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['event', uev(3)]);
  assert.match(ctl(page).line, /out of order \(seq 3 after 1\)/);
  assert.equal(page.requests.length, reads + 0, 'no request');
}));

// ---- the drawer, the flicker rule ---------------------------------------------------------------------------------------------------

test('drawer: while replaying no transcript of the real run is read, the Changes section says edit inputs are not available, and the activity comes from the replayed agent', withPage(async (page) => {
  await startedReplay(page);
  const a1 = agent('a1', 'w:U', { activity: [{ ts: 5, tool: 'Read', inputSummary: 'file.js' }] });
  const replayed = rep(1);
  replayed.agents.a1 = a1;
  await page.send(['hello', { mode: 'replay', version: '1', runId: 'wf_x' }], ['event', uev(1)], ['run', replayed]);
  const cell = page.el('#matrix-grid').querySelectorAll('[data-agent]').find((c) => c.attrs.get('data-agent') === 'a1');
  assert.ok(cell, 'the replayed agent has a cell');
  await page.click(cell);
  assert.equal(page.transcriptRequests().length, 0, 'the real transcript holds activity that has not happened yet');
  const drawer = page.el('#drawer-body');
  assert.equal(drawer.textContent.includes('edit inputs are not available in a replay'), true);
  assert.equal(drawer.textContent.includes('loading'), false, 'nothing waits for a read that will not come');
  assert.match(drawer.textContent, /Read\s*file\.js/, 'the activity of the replayed agent');
  await page.send(['event', uev(2)]);
  assert.equal(page.transcriptRequests().length, 0, 'an event of the open agent does not schedule a read either');
  assert.equal(page.timers.timeouts.size >= 0, true);
}));

test('drawer: the real run\'s transcript is read as before when no replay is on show', withPage(async (page) => {
  const cell = page.el('#matrix-grid').querySelectorAll('[data-agent]').find((c) => c.attrs.get('data-agent') === 'r1');
  await page.click(cell);
  assert.equal(page.transcriptRequests().length, 1);
}));

// the frames of a saved run, played through a real store, as the server's replay would send them
const FIXTURE_ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const FIXTURE_RUN = 'wf_6509ce25-20a';
async function fixtureFrames(source) {
  const where = await locateRun({ target: FIXTURE_RUN, root: FIXTURE_ROOT });
  const raw = buildSchedule(await readRunDir(where.sessionDir, where.runId), 1).map((x) => ({ ...x.event, src: source }));
  const store = createStore({ now: () => 1794130000000, staleMs: Infinity });
  const uis = [];
  store.onEvent((e) => uis.push(e));
  const steps = raw.map((e) => {
    const before = uis.length;
    store.apply(e);
    return { ui: uis.slice(before), run: structuredClone(store.getRun(FIXTURE_RUN)) };
  });
  return { steps, final: store.getRun(FIXTURE_RUN) };
}

test('replay of a saved run, from empty to final: every event is a log line in order, the views are patched by key (no region is rewritten, no node removed and put back with the same content), the end says "replay finished"', async () => {
  const real = await fixtureFrames('claude-fs');
  const replayed = await fixtureFrames('replay');
  assert.equal(real.final.source, 'real');
  assert.equal(replayed.final.source, 'replay');
  const page = await bootPage({ runs: [summary(real.final)], runDocs: { [FIXTURE_RUN]: structuredClone(real.final) }, events: { [FIXTURE_RUN]: [] } });
  try {
    assert.equal(ctl(page).go, 'Replay', 'the saved run is finished');
    await page.click(page.el('#replay-go'));
    await page.send(['hello', { mode: 'replay', version: '1', runId: FIXTURE_RUN }]);
    let n = 0;
    const readds = [];
    for (const { ui, run: r } of replayed.steps) {
      page.doc.mut = []; // the records of one step, as a MutationObserver delivers them
      for (const e of ui) { page.stream().push(sse('event', e)); n++; }
      page.stream().push(sse('run', r));
      await page.flush();
      for (const x of identicalReadds(page.doc.mut)) readds.push(`event ${n}: ${x.slice(0, 120)}`);
      for (const sel of REGIONS) assert.equal(page.el(sel).htmlWrites, 0, `${sel} was not rewritten whole (event ${n})`);
    }
    page.doc.mut = null;
    assert.deepEqual(readds, [], 'no node was removed and put back with the same content in one step');
    await page.send(['end', { runId: FIXTURE_RUN, events: n }]);
    assert.equal(n, 31);
    assert.deepEqual(logSeqs(page), Array.from({ length: 31 }, (_, i) => i + 1), 'the log has the events in order');
    assert.match(page.el('#run-status').textContent, /status\s*completed/);
    assert.ok(page.el('#matrix-grid').childNodes.length > 0);
    assert.equal(ctl(page).line, 'replay finished');
    assert.equal(page.requests.filter((u) => /\/events\?/.test(u)).length, 1, 'the real run\'s backlog was read once, at load');
  } finally {
    page.restore();
  }
});

test('page code: the replay adds no timer and no document listener, keeps localStorage to the helpers, and puts no data into innerHTML', () => {
  const app = read('app.js');
  assert.equal([...app.matchAll(/setInterval\(/g)].length, 1);
  assert.equal([...app.matchAll(/setTimeout\(/g)].length, 5, 'the highlight, the transcript re-read, the copy label reset, the replay frame queue and the search debounce: the queue\'s is the only one the replay adds, the debounce is the search box\'s');
  assert.equal([...app.matchAll(/document\.addEventListener\(/g)].length >= 1, true);
  assert.equal([...app.matchAll(/document\.addEventListener\('click'/g)].length, 1);
  assert.equal([...app.matchAll(/document\.addEventListener\('keydown'/g)].length, 1);
  assert.equal([...app.matchAll(/new EventSource\(/g)].length, 1, 'the replay is read with fetch, the page\'s one EventSource is the real stream\'s');
  assert.equal([...app.matchAll(/localStorage/g)].length, 3, 'only localGet, localSet and localRemove touch it');
  assert.equal([...app.matchAll(/localSet\('replay\.speed'/g)].length, 1);
  assert.equal([...app.matchAll(/localGet\('replay\.speed'\)/g)].length, 1);
  const section = app.slice(app.indexOf('// ---------- replay of a finished run ----------'), app.indexOf('// ---------- the tracking notice ----------'));
  assert.ok(section.length > 1000, 'the replay section is there, before the tracking notice');
  const code = section.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /innerHTML|setHtml\(|insertAdjacent/, 'no html is written from the replay code');
  assert.doesNotMatch(code, /onLiveEvent|refetchEvents|loadEvents|EventSource/, 'the replay never goes through the real stream\'s paths');
  assert.match(section, /setText\(line, c\.note \?\? ''\)/, 'the reason is set as text');
  // the replay stream's frames never go to the run list
  assert.doesNotMatch(code, /state\.runs|mergeRun|summaryOfRun/);
});
