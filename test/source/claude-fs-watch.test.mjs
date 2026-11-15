// File watching (contract 2, section 1 "Watching"): fs.watch(root, { recursive: true }) triggers an
// immediate poll of the run whose files changed; stat polling at pollMs stays the fallback.
// Two kinds of test: some use the real fs.watch (the platform delivers the change), most replace
// fs.watch with a fake whose listener the test calls itself, so the mapping from a changed path to
// what the source reads does not depend on the file system's event timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createClaudeFsSource, readRunDir } from '../../src/source/claude-fs.mjs';
import { RUN, SESSION, SLUG, lines, setup, sleep, started, track, waitFor, watcherIsLive } from './run-helpers.mjs';

class FakeWatcher extends EventEmitter {
  closed = 0;
  unrefs = 0;
  close() { this.closed++; }
  unref() { this.unrefs++; }
}

// Replaces fs.watch for the test. `watchers[i].listener(eventType, filename)` plays a change.
function fakeWatch(t, behaviour) {
  const calls = [];
  const watchers = [];
  t.mock.method(fs, 'watch', (...args) => {
    calls.push(args);
    if (behaviour) return behaviour(...args);
    const w = new FakeWatcher();
    w.listener = args[2];
    watchers.push(w);
    return w;
  });
  return { calls, watchers, fire: (filename, i = watchers.length - 1) => watchers[i].listener('change', filename) };
}

const idle = () => sleep(150); // long enough for a change-triggered pass that should not happen to show up

// ---- the real fs.watch ----------------------------------------------------------------------------

// How long a test waits for the platform's watcher. macOS FSEvents can deliver several seconds late on a loaded machine
// (5 s timed out at load average ~11, 2026-11-12). pollMs is 600 s in these tests, so an event seen within 20 s still
// came from the watcher, not from a poll: the claim "well before pollMs" holds.
const WATCH_WAIT_MS = 20_000;

test('watch (real fs.watch): a new journal line is emitted well before pollMs', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 600_000 }); // no timer will help within the test
  await source.start();
  await watcherIsLive(f.root); // a change made before the platform's watcher is live is lost, and no timer recovers it
  assert.deepEqual(events.map((e) => e.kind), ['run.launched']);

  const t0 = Date.now();
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await waitFor(() => kinds('agent.started').length === 1, WATCH_WAIT_MS, 'the line to be emitted by the watcher');
  assert.ok(Date.now() - t0 < WATCH_WAIT_MS);
  assert.deepEqual(kinds('agent.started')[0].data, { key: 'v2:a1', agentId: 'a1', label: 'x:A', phase: 'P' });

  // and again, with the agent files: whatever is written is read, once
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: 'hello' } }));
  await waitFor(() => kinds('agent.prompt').length === 1, WATCH_WAIT_MS, 'the transcript');
  await fsp.appendFile(f.agentFile('a1'), lines({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } }));
  await waitFor(() => kinds('agent.activity').length === 1, WATCH_WAIT_MS, 'the activity');
  await idle();
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'agent.started', 'agent.prompt', 'agent.activity'], 'nothing repeats');
});

test('watch (real fs.watch): a run that appears after start() is found without rescan() or a poll', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();
  await watcherIsLive(f.root);

  // a new session of a new project, then a second run in the known session
  const run2 = f.runDirOf('wf_second-002');
  await fsp.mkdir(run2, { recursive: true });
  await fsp.writeFile(path.join(run2, 'journal.jsonl'), lines({ type: 'launched' }));
  await waitFor(() => events.some((e) => e.runId === 'wf_second-002'), WATCH_WAIT_MS, 'the second run');

  const other = path.join(f.root, '-other-proj', '99999999-2222-4333-8444-555555555555', 'subagents', 'workflows', 'wf_third-003');
  await fsp.mkdir(other, { recursive: true });
  await fsp.writeFile(path.join(other, 'journal.jsonl'), lines({ type: 'launched' }));
  await waitFor(() => events.some((e) => e.runId === 'wf_third-003'), WATCH_WAIT_MS, 'the run in a new session');
  assert.equal(events.find((e) => e.runId === 'wf_third-003').project, '-other-proj');
  assert.equal(events.length, 3);
});

test('watch (real fs.watch): the source reads nothing by itself with watch false and a large pollMs', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const { source, events } = track(t, f.root, { watch: false, pollMs: 600_000 });
  await source.start();
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await sleep(400);
  assert.equal(events.length, 1, 'no watcher, no timer: nothing is read until rescan()');
  await source.rescan();
  assert.equal(events.length, 2);
});

test('watch false: polling alone still emits a new journal line, at pollMs', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const { source, events, kinds } = track(t, f.root, { watch: false, pollMs: 30 });
  const w = fakeWatch(t);
  await source.start();
  assert.equal(w.calls.length, 0, 'fs.watch is not even called');
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await waitFor(() => kinds('agent.started').length === 1, 3000, 'the poll');
  assert.equal(events.length, 2);
});

// ---- how the source uses fs.watch -------------------------------------------------------------------

test('watch is on by default: fs.watch is called once with the resolved root and { recursive: true }; stop() closes the watcher', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const events = [];
  const source = createClaudeFsSource({ root: f.root, pollMs: 600_000, sinceMs: Infinity, onEvent: (e) => events.push(e) }); // no `watch`
  t.after(() => source.stop());
  await source.start();
  await source.start(); // already started: no second watcher
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0][0], path.resolve(f.root));
  assert.deepEqual(w.calls[0][1], { recursive: true });
  assert.equal(typeof w.calls[0][2], 'function');
  assert.equal(w.watchers[0].unrefs, 1, 'the watcher does not keep the process alive');
  assert.equal(w.watchers[0].closed, 0);
  source.stop();
  assert.equal(w.watchers[0].closed, 1);
  source.stop();
  assert.equal(w.watchers[0].closed, 1, 'closed once');
});

test('a relative root is watched by its absolute path', async (t) => {
  const f = await setup(t);
  const w = fakeWatch(t);
  const { source } = track(t, path.relative(process.cwd(), f.root), { watch: true });
  await source.start();
  assert.equal(w.calls[0][0], f.root);
});

test('fs.watch throws: the source keeps working by polling', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const calls = [];
  t.mock.method(fs, 'watch', (...args) => {
    calls.push(args);
    throw Object.assign(new Error('recursive watching is not available here'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  });
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 30 });
  await source.start();
  assert.equal(calls.length, 1);
  assert.equal(events.length, 1);
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await waitFor(() => kinds('agent.started').length === 1, 3000, 'the poll');
  source.stop(); // nothing to close
});

test('a root that does not exist cannot be watched: start() still works (real fs.watch throws ENOENT)', async (t) => {
  const f = await setup(t);
  const missing = path.join(f.root, 'not-there-yet');
  const { source, events } = track(t, missing, { watch: true, pollMs: 30 });
  await source.start();
  assert.deepEqual(events, []);
  source.stop();
});

test("the watcher's 'error' event closes it and polling carries on", async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 30 });
  await source.start();
  assert.equal(w.watchers.length, 1);

  w.watchers[0].emit('error', Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
  assert.equal(w.watchers[0].closed, 1, 'the broken watcher is closed');

  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await waitFor(() => kinds('agent.started').length === 1, 3000, 'the poll after the error');
  assert.equal(events.length, 2);
  source.stop();
  assert.equal(w.watchers[0].closed, 1, 'not closed a second time');
  assert.equal(w.calls.length, 1, 'and not opened again');
});

test("an 'error' event of a watcher left over from before stop() does not hurt the new one", async (t) => {
  const f = await setup(t);
  const w = fakeWatch(t);
  const { source } = track(t, f.root, { watch: true });
  await source.start();
  source.stop();
  await source.start();
  assert.equal(w.watchers.length, 2);
  w.watchers[0].emit('error', new Error('late'));
  assert.equal(w.watchers[1].closed, 0, 'the watcher of the second start() is untouched');
  source.stop();
  assert.equal(w.watchers[1].closed, 1);
});

// ---- which run a change belongs to ------------------------------------------------------------------

async function twoRuns(t) {
  const f = await setup(t);
  await fsp.mkdir(f.runDirOf('wf_second-002'), { recursive: true });
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.journalOf('wf_second-002'), lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const tr = track(t, f.root, { watch: true, pollMs: 600_000 });
  await tr.source.start();
  assert.equal(tr.events.length, 2);
  return { f, w, ...tr };
}

test('a change in a run directory polls that run at once and only that run', async (t) => {
  const { f, w, events, kinds } = await twoRuns(t);
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  await fsp.appendFile(f.journalOf('wf_second-002'), lines(started('b1', 'y:B', 'P')));

  w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'));
  await waitFor(() => kinds('agent.started').length === 1, 3000, 'run 1');
  assert.equal(kinds('agent.started')[0].runId, RUN);
  await idle();
  assert.equal(kinds('agent.started').length, 1, 'the other run was not read: its files did not change as far as the watcher knows');

  w.fire(f.rel('subagents', 'workflows', 'wf_second-002'));
  await waitFor(() => kinds('agent.started').length === 2, 3000, 'run 2');
  assert.deepEqual(kinds('agent.started').map((e) => e.runId), [RUN, 'wf_second-002']);
  assert.equal(events.length, 4);
});

test('every file of a run maps to it: agent files, agent meta, the final file and a script', async (t) => {
  const { f, w, events, kinds } = await twoRuns(t);
  const fire = async (file, rel, until) => {
    w.fire(rel);
    await waitFor(until, 3000, `the event for ${path.basename(file)}`);
  };

  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: 'p' } }));
  await fire(f.agentFile('a1'), f.rel('subagents', 'workflows', RUN, 'agent-a1.jsonl'), () => kinds('agent.prompt').length === 1);
  await fsp.writeFile(f.metaFile('a1'), JSON.stringify({ agentType: 'workflow-subagent' }));
  await fire(f.metaFile('a1'), f.rel('subagents', 'workflows', RUN, 'agent-a1.meta.json'), () => kinds('agent.meta').length === 1);
  await fsp.writeFile(f.finalFile, JSON.stringify({ runId: RUN, status: 'completed' }));
  await fire(f.finalFile, f.rel('workflows', `${RUN}.json`), () => kinds('run.final').length === 1);

  // a script copy appears for a run that is already followed: its path is learnt from the change
  await fsp.mkdir(f.scriptsDir, { recursive: true });
  const script = path.join(f.scriptsDir, `flow-${RUN}.js`);
  await fsp.writeFile(script, "export const meta = { name: 'flow' }\n");
  await fire(script, f.rel('workflows', 'scripts', `flow-${RUN}.js`), () => kinds('run.script').length === 1);
  assert.deepEqual(kinds('run.script')[0].data.meta, { name: 'flow' });
  assert.equal(kinds('run.script')[0].prov.file, script);

  assert.ok(events.every((e) => e.runId === RUN || e.kind === 'run.launched'), 'nothing was read for the other run');
});

test('a change outside any run directory looks for new runs', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();
  assert.equal(events.length, 1);

  // 1. a second run in the known session, announced by a change to the session transcript beside it
  await fsp.mkdir(f.runDirOf('wf_second-002'), { recursive: true });
  await fsp.writeFile(f.journalOf('wf_second-002'), lines({ type: 'launched' }));
  await fsp.writeFile(path.join(f.root, SLUG, `${SESSION}.jsonl`), '{}\n');
  w.fire(path.join(SLUG, `${SESSION}.jsonl`));
  await waitFor(() => events.some((e) => e.runId === 'wf_second-002'), 3000, 'the second run');

  // 2. a run in a new session, announced by the new session directory
  const s2 = '22222222-2222-4333-8444-555555555555';
  const run3 = path.join(f.root, SLUG, s2, 'subagents', 'workflows', 'wf_third-003');
  await fsp.mkdir(run3, { recursive: true });
  await fsp.writeFile(path.join(run3, 'journal.jsonl'), lines({ type: 'launched' }));
  w.fire(path.join(SLUG, s2));
  await waitFor(() => events.some((e) => e.runId === 'wf_third-003'), 3000, 'the third run');

  // 3. a run in a new project, announced by the project directory
  const run4 = path.join(f.root, '-new-proj', s2, 'subagents', 'workflows', 'wf_fourth-004');
  await fsp.mkdir(run4, { recursive: true });
  await fsp.writeFile(path.join(run4, 'journal.jsonl'), lines({ type: 'launched' }));
  w.fire('-new-proj');
  await waitFor(() => events.some((e) => e.runId === 'wf_fourth-004'), 3000, 'the fourth run');

  // 4. a run in a new project, announced by a change the platform could not name
  const run5 = path.join(f.root, '-newer-proj', s2, 'subagents', 'workflows', 'wf_fifth-005');
  await fsp.mkdir(run5, { recursive: true });
  await fsp.writeFile(path.join(run5, 'journal.jsonl'), lines({ type: 'launched' }));
  w.watchers[0].listener('rename', null);
  await waitFor(() => events.some((e) => e.runId === 'wf_fifth-005'), 3000, 'the fifth run');

  assert.deepEqual(events.map((e) => e.runId), [RUN, 'wf_second-002', 'wf_third-003', 'wf_fourth-004', 'wf_fifth-005']);
  assert.equal(events.find((e) => e.runId === 'wf_fourth-004').project, '-new-proj');
});

test('a change to a file of a run that is not followed yet finds that run (and only that one) and reads it from its start', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();

  await fsp.mkdir(f.runDirOf('wf_second-002'), { recursive: true });
  await fsp.writeFile(f.journalOf('wf_second-002'), lines({ type: 'launched' }, started('b1', 'y:B', 'P')));
  await fsp.mkdir(f.runDirOf('wf_third-003'), { recursive: true });
  await fsp.writeFile(f.journalOf('wf_third-003'), lines({ type: 'launched' }));
  w.fire(f.rel('subagents', 'workflows', 'wf_second-002', 'journal.jsonl'));
  await waitFor(() => events.some((e) => e.runId === 'wf_second-002'), 3000, 'the second run');
  await idle();
  assert.deepEqual(events.filter((e) => e.runId === 'wf_second-002').map((e) => [e.kind, e.prov.line]), [['run.launched', 1], ['agent.started', 2]]);
  assert.ok(!events.some((e) => e.runId === 'wf_third-003'), 'the third run did not change as far as the watcher knows');
});

test('sinceMs still applies to runs found through a change: a run that only appears to have changed stays listed, not loaded', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const old = f.runDirOf('wf_old-000');
  await fsp.mkdir(old, { recursive: true });
  await fsp.writeFile(f.journalOf('wf_old-000'), lines({ type: 'launched' }));
  const longAgo = new Date(Date.now() - 10 * 3600e3);
  for (const p of [old, f.journalOf('wf_old-000')]) await fsp.utimes(p, longAgo, longAgo);
  const w = fakeWatch(t);
  const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000, sinceMs: 3600e3 });
  await source.start();
  assert.deepEqual(events.map((e) => [e.runId, e.kind]), [['wf_old-000', 'run.launched'], [RUN, 'run.launched']], 'both listed (journal events)');
  assert.equal(source.isLoaded('wf_old-000'), false);
  assert.equal(source.isLoaded(RUN), true);

  w.fire(f.rel('subagents', 'workflows', 'wf_old-000', 'journal.jsonl')); // e.g. a mere attribute change
  await idle();
  assert.equal(events.length, 2, 'nothing new in its files');
  assert.equal(source.isLoaded('wf_old-000'), false);

  await fsp.appendFile(f.journalOf('wf_old-000'), lines(started('o1', 'z:O', 'P'))); // now its files are within the window
  w.fire(f.rel('subagents', 'workflows', 'wf_old-000', 'journal.jsonl'));
  await waitFor(() => events.some((e) => e.runId === 'wf_old-000' && e.kind === 'agent.started'), 3000, 'the old run, changed');
  assert.deepEqual(events.filter((e) => e.runId === 'wf_old-000').map((e) => e.kind), ['run.launched', 'agent.started']);
  // The run is marked loaded at the end of the pass that emitted its new line, not before the line is emitted: under CPU load
  // the check right after the event lost that race in 18 of 30 runs (2026-11-15). Wait for the mark; it must still come.
  await waitFor(() => source.isLoaded('wf_old-000'), 3000, 'the old run to be marked loaded');
});

test('a burst of change events gives each new line once, in order', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();
  for (let i = 0; i < 30; i++) {
    await fsp.appendFile(f.journal, lines(started(`a${i}`, `x:${i}`, 'P')));
    w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'));
    w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'));
  }
  await waitFor(() => kinds('agent.started').length === 30, 5000, 'all 30 lines');
  await idle();
  assert.deepEqual(kinds('agent.started').map((e) => e.data.agentId), Array.from({ length: 30 }, (_, i) => `a${i}`));
  assert.equal(events.length, 31);
});

test('a change-triggered pass is not the "one more poll" a half-written file or a lone relayed request waits for', async (t) => {
  const RELAY = '[Workflow harness — user request] relays the user request. Approve both';
  const COMPUTED = '[Workflow harness — computed task] The task text follows:\n  Do the thing.';
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }, started('a1', 'x:A', 'P')));
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', version: '2.1.317', message: { content: RELAY } }));
  await fsp.writeFile(f.finalFile, '{"runId": "wf_test0001-abc", "status": "comp'); // the final file, half written
  const w = fakeWatch(t);
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start(); // the first regular poll: both wait
  assert.equal(kinds('agent.prompt').length, 0);
  assert.equal(kinds('source.warning').length, 0);

  for (let i = 0; i < 4; i++) { // change events with nothing new: no grace is used up
    w.fire(f.rel('subagents', 'workflows', RUN, 'agent-a1.jsonl'));
    w.fire(f.rel('workflows', `${RUN}.json`));
    await sleep(70);
  }
  assert.equal(kinds('agent.prompt').length, 0, 'the relayed request is not made the prompt by change events');
  assert.equal(kinds('source.warning').length, 0, 'the half-written file is not reported by change events');

  // the writers finish
  await fsp.appendFile(f.agentFile('a1'), lines({ type: 'user', version: '2.1.317', message: { content: COMPUTED } }));
  await fsp.writeFile(f.finalFile, JSON.stringify({ runId: RUN, status: 'completed' }));
  w.fire(f.rel('subagents', 'workflows', RUN, 'agent-a1.jsonl'));
  w.fire(f.rel('workflows', `${RUN}.json`));
  await waitFor(() => kinds('run.final').length === 1 && kinds('agent.prompt').length === 1, 3000, 'prompt and final');
  assert.deepEqual([kinds('agent.prompt')[0].data.text, kinds('agent.prompt')[0].data.framed], ['Do the thing.', true]);
  assert.equal(kinds('source.warning').length, 0);
  assert.equal(events.length, 4);
});

test('the regular poll still settles what change events left waiting', async (t) => {
  const RELAY = '[Workflow harness — user request] relays the user request. Approve both';
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }, started('a1', 'x:A', 'P')));
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: RELAY } }));
  await fsp.writeFile(f.finalFile, '{"status": "comp');
  const { source, kinds } = track(t, f.root, { watch: true, pollMs: 40 });
  await source.start();
  await waitFor(() => kinds('agent.prompt').length === 1 && kinds('source.warning').length === 1, 3000, 'the polls');
  assert.deepEqual([kinds('agent.prompt')[0].data.framed, kinds('agent.prompt')[0].data.text], [false, RELAY]);
  assert.match(kinds('source.warning')[0].data.message, /is not valid JSON/);
});

// ---- stop() -----------------------------------------------------------------------------------------

test('stop(): a change reported afterwards is ignored; start() opens a new watcher and the old one stays dead', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events, kinds } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();

  source.stop();
  assert.equal(w.watchers[0].closed, 1);
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
  w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'), 0);
  await idle();
  assert.equal(events.length, 1, 'nothing after stop()');

  await source.start();
  assert.equal(w.watchers.length, 2);
  assert.equal(kinds('agent.started').length, 1, 'start() reads what stop() left unread');
  await fsp.appendFile(f.journal, lines(started('a2', 'x:B', 'P')));
  w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'), 0); // the old listener: dead
  await idle();
  assert.equal(kinds('agent.started').length, 1);
  w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'), 1);
  await waitFor(() => kinds('agent.started').length === 2, 3000, 'the new watcher');
});

test('stop() right after a change: no event is delivered once stop() has returned', async (t) => {
  for (let i = 0; i < 20; i++) {
    const f = await setup(t);
    await fsp.writeFile(f.journal, lines({ type: 'launched' }));
    const w = fakeWatch(t);
    const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000 });
    await source.start();
    await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P')));
    w.fire(f.rel('subagents', 'workflows', RUN, 'journal.jsonl'));
    if (i % 2) await sleep(i); // the pass may be anywhere
    source.stop();
    const n = events.length;
    await sleep(60);
    assert.equal(events.length, n, `round ${i}: nothing after stop()`);
    w.watchers.length = 0;
    t.mock.restoreAll();
  }
});

test('readRunDir gives the same events as a source that was driven by change events', async (t) => {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  const w = fakeWatch(t);
  const { source, events } = track(t, f.root, { watch: true, pollMs: 600_000 });
  await source.start();
  await fsp.appendFile(f.journal, lines(started('a1', 'x:A', 'P'), { type: 'result', key: 'v2:a1', agentId: 'a1', result: { ok: true } }));
  await fsp.writeFile(f.metaFile('a1'), JSON.stringify({ agentType: 'workflow-subagent' }));
  await fsp.writeFile(f.agentFile('a1'), lines(
    { type: 'user', timestamp: '2026-11-08T10:00:01.000Z', message: { content: 'prompt' } },
    { type: 'assistant', timestamp: '2026-11-08T10:00:02.000Z', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a', content: 'x' } }] } }));
  await fsp.writeFile(f.finalFile, JSON.stringify({ runId: RUN, status: 'completed' }));
  w.fire(f.rel('subagents', 'workflows', RUN));
  await waitFor(() => events.some((e) => e.kind === 'run.final'), 3000, 'the final file');
  await idle();
  const replay = await readRunDir(f.sessionDir, RUN);
  const key = (e) => `${e.kind}|${e.prov.file}|${e.prov.line}|${JSON.stringify(e.data)}`;
  assert.deepEqual(events.map(key).sort(), replay.map(key).sort());
});
