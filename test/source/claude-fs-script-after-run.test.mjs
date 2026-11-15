// Script read after the run (contract 2, section 1): a script read through the final file's scriptPath
// whose mtime is later than the run's end gets a source.warning "script modified after the run"
// (prov.file = the script path) in addition to run.script. The run's end is what the final file
// carries: endedAt, or startedAt / startTime plus durationMs. Nothing else is guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeFsSource, readRunDir } from '../../src/source/claude-fs.mjs';
import { RUN, lines, setup, track } from './run-helpers.mjs';

const MESSAGE = 'script modified after the run';
const SCRIPT = "export const meta = { name: 'external', phases: [{ title: 'P1' }] }\nexport default async function run() {}\n";
const NO_META_SCRIPT = 'console.log("no meta here")\n';

// Run window in 2027 (seconds-exact times, so utimes and the comparison are exact).
const START = 1_800_000_000_000;
const DURATION = 90_000;
const END = START + DURATION;
const at = (ms) => new Date(ms);

async function named(t, finalFields, { mtime, text = SCRIPT } = {}) {
  const f = await setup(t);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfviz-s1-script-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'my-flow.js');
  await fsp.writeFile(script, text);
  if (mtime !== undefined) await fsp.utimes(script, at(mtime), at(mtime));
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.finalFile, JSON.stringify({ runId: RUN, status: 'completed', scriptPath: script, ...finalFields }));
  return { ...f, script };
}

const modifiedWarnings = (events) => events.filter((e) => e.kind === 'source.warning' && e.data.message === MESSAGE);

test('startTime + durationMs: a script modified after the end gives run.script and then the warning, prov.file the script', async (t) => {
  const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime: END + 5000 });
  const events = await readRunDir(f.sessionDir, RUN);
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script', 'source.warning']);
  const [script, warning] = events.slice(2);
  assert.equal(script.prov.file, f.script);
  assert.equal(script.data.meta.name, 'external');
  assert.deepEqual(warning.data, { message: MESSAGE });
  assert.equal(warning.prov.file, f.script);
  assert.equal(warning.prov.line, null);
  assert.equal(warning.src, 'claude-fs');
  assert.equal(warning.runId, RUN);
  assert.equal(warning.ts, END + 5000, 'stamped with the script file mtime, like the other warnings about a file');
});

test('a script not modified after the end gives no warning: older, and exactly at the end', async (t) => {
  for (const [name, mtime] of [['long before', START - 3600_000], ['at the start', START], ['just before the end', END - 1000], ['exactly at the end', END]]) {
    const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime });
    const events = await readRunDir(f.sessionDir, RUN);
    assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script'], name);
  }
  const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime: END + 1000 });
  assert.equal(modifiedWarnings(await readRunDir(f.sessionDir, RUN)).length, 1, 'one second later is later');
});

test('the end is endedAt when the final file has it (number or ISO text), else start + durationMs with startTime or startedAt', async (t) => {
  const warns = async (fields, mtime) => {
    const f = await named(t, fields, { mtime });
    return modifiedWarnings(await readRunDir(f.sessionDir, RUN)).length;
  };
  // endedAt wins over start + duration
  assert.equal(await warns({ endedAt: END, startTime: START, durationMs: 1 }, END + 1000), 1);
  assert.equal(await warns({ endedAt: END, startTime: START, durationMs: 10 ** 9 }, END - 1000), 0);
  assert.equal(await warns({ endedAt: new Date(END).toISOString() }, END + 1000), 1);
  assert.equal(await warns({ endedAt: new Date(END).toISOString() }, END - 1000), 0);
  assert.equal(await warns({ endedAt: END }, END + 1000), 1, 'endedAt alone is enough');
  // start + duration
  assert.equal(await warns({ startedAt: START, durationMs: DURATION }, END + 1000), 1);
  assert.equal(await warns({ startedAt: START, durationMs: DURATION }, END - 1000), 0);
  assert.equal(await warns({ startedAt: new Date(START).toISOString(), durationMs: DURATION }, END + 1000), 1);
});

test('no end in the final file: no warning, however new the script is', async (t) => {
  const now = Date.now() + 3600_000;
  for (const fields of [{}, { startTime: START }, { durationMs: DURATION }, { startedAt: START }, { startTime: 'soon', durationMs: DURATION },
    { startTime: START, durationMs: 'long' }, { endedAt: 'never' }, { startTime: null, durationMs: null }]) {
    const f = await named(t, fields, { mtime: now });
    const events = await readRunDir(f.sessionDir, RUN);
    assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script'], JSON.stringify(fields));
  }
});

test('the final file timestamp is not an end time: only the fields named above are used', async (t) => {
  const f = await named(t, { timestamp: new Date(END).toISOString() }, { mtime: END + 60_000 });
  assert.deepEqual((await readRunDir(f.sessionDir, RUN)).map((e) => e.kind), ['run.launched', 'run.final', 'run.script']);
});

test('only a script read through the final file is checked: a copy under workflows/scripts/ is not', async (t) => {
  const f = await setup(t);
  await fsp.mkdir(f.scriptsDir, { recursive: true });
  const copy = path.join(f.scriptsDir, `copy-${RUN}.js`);
  await fsp.writeFile(copy, SCRIPT);
  await fsp.utimes(copy, at(END + 60_000), at(END + 60_000));
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.finalFile, JSON.stringify({ runId: RUN, status: 'completed', startTime: START, durationMs: DURATION, scriptPath: path.join(f.root, 'elsewhere.js') }));
  const events = await readRunDir(f.sessionDir, RUN);
  assert.deepEqual(events.map((e) => e.kind), ['run.script', 'run.launched', 'run.final']);
  assert.equal(events[0].prov.file, copy);
});

test('live: the warning comes once, after run.script, and the replay gives the same events', async (t) => {
  const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime: END + 5000 });
  const { source, events } = track(t, f.root);
  await source.start();
  await source.rescan();
  await source.rescan();
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script', 'source.warning']);
  assert.deepEqual(events, await readRunDir(f.sessionDir, RUN));
});

test('live: a script that appears later is checked when it is read; an edit afterwards is not read again', async (t) => {
  const f = await named(t, { startTime: START, durationMs: DURATION });
  await fsp.rm(f.script);
  const { source, events } = track(t, f.root);
  await source.start();
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final']);

  await fsp.writeFile(f.script, SCRIPT);
  await fsp.utimes(f.script, at(END + 1000), at(END + 1000));
  await source.rescan();
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script', 'source.warning']);

  await fsp.writeFile(f.script, `${SCRIPT}// again\n`);
  await source.rescan();
  assert.equal(events.length, 4);
});

test('a script with no readable meta that was also modified later gives both warnings, the meta one first', async (t) => {
  const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime: END + 5000, text: NO_META_SCRIPT });
  const events = await readRunDir(f.sessionDir, RUN);
  assert.deepEqual(events.map((e) => e.kind), ['run.launched', 'run.final', 'run.script', 'source.warning', 'source.warning']);
  assert.equal(events[2].data.meta, null);
  assert.match(events[3].data.message, /could not read the meta literal/);
  assert.equal(events[4].data.message, MESSAGE);

  const { source, events: live } = track(t, f.root);
  await source.start();
  await source.rescan(); // the meta-less script waits one poll
  assert.deepEqual(live, events);
});

test('stop() right after run.script keeps both warnings for the next pass, in order, once', async (t) => {
  const f = await named(t, { startTime: START, durationMs: DURATION }, { mtime: END + 5000, text: NO_META_SCRIPT });
  const seen = [];
  const source = createClaudeFsSource({
    root: f.root, pollMs: 60_000, watch: false, sinceMs: Infinity,
    onEvent: (e) => { seen.push(e.kind === 'source.warning' ? (e.data.message.startsWith('could not read the meta') ? 'meta warning' : e.data.message) : e.kind); if (e.kind === 'run.script') source.stop(); },
  });
  t.after(() => source.stop());
  await source.start();
  assert.deepEqual(seen, ['run.launched', 'run.final'], 'a script without meta waits one poll');
  await source.rescan();
  assert.deepEqual(seen, ['run.launched', 'run.final', 'run.script'], 'stop() came with run.script: its warnings are not delivered');
  await source.rescan(); // stopped: nothing
  assert.equal(seen.length, 3);
  await source.start();
  assert.deepEqual(seen, ['run.launched', 'run.final', 'run.script', 'meta warning', MESSAGE]);
  await source.rescan();
  assert.equal(seen.length, 5, 'nothing repeats');
});
