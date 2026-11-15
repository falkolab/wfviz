// Run history (contract section 4, P1): the source lists every run under the root, of any age, from its journal,
// final file and script only (the index), and reads the rest of one run on loadRun(runId). Fixtures: a copy of
// fixtures/claude-projects as project A with every file set back to 2025-11-01 (two old runs), and a fresh run
// written now as project B.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeFsSource, readRunDir } from '../../src/source/claude-fs.mjs';
import { reduceRun } from '../../src/model/reduce.mjs';
import { lines, started } from './run-helpers.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/claude-projects/', import.meta.url));
const FIX_SLUG = fs.readdirSync(FIXTURES)[0];
const FIX_SESSION = fs.readdirSync(path.join(FIXTURES, FIX_SLUG))[0];
const OLD_A = 'wf_6509ce25-20a';
const OLD_B = 'wf_26eb8d70-5c4';
const NEW_RUN = 'wf_fresh-b01';
const INDEX_KINDS = new Set(['run.script', 'run.launched', 'agent.started', 'agent.result', 'agent.failed', 'run.final']);
const AGENT_KINDS = ['agent.meta', 'agent.prompt', 'agent.activity', 'agent.structured'];
const LONG_AGO = new Date('2025-11-01T00:00:00Z');

async function setTimes(dir) {
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await setTimes(p);
    await fsp.utimes(p, LONG_AGO, LONG_AGO);
  }
}

// Two project dirs: the old fixture runs (project A) and a run written now (project B).
async function makeRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfviz-p1-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const slugA = path.join(root, FIX_SLUG);
  await fsp.cp(path.join(FIXTURES, FIX_SLUG), slugA, { recursive: true });
  await setTimes(slugA);
  const sessionDir = path.join(root, '-Users-other-proj', '22222222-3333-4444-8555-666666666666');
  const runDir = path.join(sessionDir, 'subagents', 'workflows', NEW_RUN);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'journal.jsonl'), lines({ type: 'launched' }, started('b1', 'x:A', 'P')));
  await fsp.writeFile(path.join(runDir, 'agent-b1.jsonl'), lines({ type: 'user', message: { content: 'fresh prompt' } }));
  return { root, oldSession: path.join(slugA, FIX_SESSION), newSession: sessionDir, newRunDir: runDir };
}

function spyOpens(t) {
  const opened = [];
  const open = fsp.open;
  const readFile = fsp.readFile;
  t.mock.method(fsp, 'open', (p, ...rest) => { opened.push(String(p)); return open.call(fsp, p, ...rest); });
  t.mock.method(fsp, 'readFile', (p, ...rest) => { opened.push(String(p)); return readFile.call(fsp, p, ...rest); });
  return opened;
}

function startSource(t, root, opts = {}) {
  const events = [];
  const source = createClaudeFsSource({ root, pollMs: Infinity, watch: false, sinceMs: 24 * 3600e3, onEvent: (e) => events.push(e), ...opts });
  t.after(() => source.stop());
  return { source, events, of: (id) => events.filter((e) => e.runId === id), start: () => source.start() };
}

const key = (e) => `${e.kind} ${e.prov.file}:${e.prov.line}`;
const agentFile = (p) => path.basename(p).startsWith('agent-');

test('index: every run of every project is listed, the old ones from journal, final file and script only, and not loaded', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const opened = spyOpens(t);
  const s = startSource(t, r.root);
  await s.start();

  assert.deepEqual([...new Set(s.events.map((e) => e.runId))].sort(), [NEW_RUN, OLD_B, OLD_A].sort());
  for (const id of [OLD_A, OLD_B]) {
    const kinds = new Set(s.of(id).map((e) => e.kind));
    assert.ok(kinds.has('run.final') && kinds.has('run.launched') && kinds.has('agent.started') && kinds.has('run.script'), `${id}: ${[...kinds]}`);
    for (const k of kinds) assert.ok(INDEX_KINDS.has(k), `${id}: unexpected kind ${k}`);
    assert.equal(s.source.isLoaded(id), false);
  }
  // project and session come from where the files are, as for a loaded run
  assert.equal(s.of(OLD_A)[0].project, FIX_SLUG);
  assert.equal(s.of(NEW_RUN)[0].project, '-Users-other-proj');

  // the fresh run is loaded: its transcript was read; no agent file of an old run was opened or read
  assert.equal(s.source.isLoaded(NEW_RUN), true);
  assert.ok(s.of(NEW_RUN).some((e) => e.kind === 'agent.prompt'));
  const oldAgentFiles = opened.filter((p) => agentFile(p) && p.startsWith(r.oldSession));
  assert.deepEqual(oldAgentFiles, [], 'no transcript or meta file of a listed-only run is opened');
  assert.ok(opened.some((p) => p.endsWith('journal.jsonl') && p.startsWith(r.oldSession)), 'the journal is read');
  assert.ok(opened.some((p) => agentFile(p) && p.startsWith(r.newSession)), 'the loaded run is read in full');

  // a rescan reads the three index files again and still opens no agent file of the old runs
  opened.length = 0;
  await s.source.rescan();
  assert.deepEqual(opened.filter((p) => agentFile(p) && p.startsWith(r.oldSession)), []);
  assert.equal(s.events.filter((e) => e.runId === OLD_A).length, s.of(OLD_A).length);
});

test('loadRun: the transcript events come once, and index events plus loadRun events are what readRunDir gives', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const s = startSource(t, r.root);
  await s.start();
  const before = s.of(OLD_A).length;
  assert.equal(s.of(OLD_A).filter((e) => AGENT_KINDS.includes(e.kind)).length, 0);

  const p1 = s.source.loadRun(OLD_A);
  const p2 = s.source.loadRun(OLD_A);
  assert.equal(p1, p2, 'a call while a load is under way gets the same promise');
  await p1;
  assert.equal(s.source.isLoaded(OLD_A), true);
  assert.equal(s.source.isLoaded(OLD_B), false, 'only that run');

  const after = s.of(OLD_A);
  assert.ok(after.length > before);
  const full = await readRunDir(r.oldSession, OLD_A);
  assert.deepEqual(after.map(key).sort(), full.map(key).sort(), 'the same events, each once, by kind and prov.file:line');
  // the reduced Runs are equal whichever order the depths came in
  const now = () => 1_800_000_000_000;
  assert.deepEqual(JSON.parse(JSON.stringify(reduceRun(after, { now }))), JSON.parse(JSON.stringify(reduceRun(full, { now }))));

  await s.source.loadRun(OLD_A); // a loaded run: a no-op
  await s.source.rescan();
  assert.equal(s.of(OLD_A).length, after.length, 'a second call and a rescan emit nothing more');
  for (const e of s.of(OLD_A)) assert.ok(!('loaded' in e) && !('loaded' in e.data), 'no loaded flag in an event');
});

test('loadRun: an unknown id rejects (the id is looked up, never turned into a path); a run listed twice loads as one id; stop() cuts a load', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const s = startSource(t, r.root);
  await assert.rejects(s.source.loadRun(OLD_A), /not running/, 'before start()');
  await s.start();
  for (const id of ['wf_nope', '__proto__', 'constructor', '../../etc/passwd', '']) await assert.rejects(s.source.loadRun(id), /no run|listed/, id);
  await assert.rejects(s.source.loadRun(undefined), TypeError);
  assert.equal(s.source.isLoaded('__proto__'), false);
  assert.equal(s.source.isLoaded('wf_nope'), false);

  // stop() while a load is queued: it rejects, nothing hangs, and the run stays listed only
  const pending = s.source.loadRun(OLD_B);
  s.source.stop();
  await assert.rejects(pending, /stopped/);
  assert.equal(s.source.isLoaded(OLD_B), false);
  // started again: it can be loaded
  await s.source.start();
  await s.source.loadRun(OLD_B);
  assert.equal(s.source.isLoaded(OLD_B), true);
  const keys = s.of(OLD_B).map(key);
  assert.equal(new Set(keys.filter((k) => !k.startsWith('source.warning'))).size, keys.filter((k) => !k.startsWith('source.warning')).length, 'no line twice');
});

test('loadRun: a run id held by two session directories is loaded whole, and counts as loaded only when both are', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  // a second entry of OLD_A: only its script copy, in another project dir with the same session id
  const other = path.join(r.root, '-Users-third', FIX_SESSION);
  const scripts = path.join(other, 'workflows', 'scripts');
  await fsp.mkdir(scripts, { recursive: true });
  const script = path.join(scripts, `probe-event-format-${OLD_A}.js`);
  await fsp.copyFile(path.join(r.oldSession, 'workflows', 'scripts', `probe-event-format-${OLD_A}.js`), script);
  await fsp.utimes(script, LONG_AGO, LONG_AGO);
  const s = startSource(t, r.root);
  await s.start();
  assert.equal(s.source.isLoaded(OLD_A), false);
  await s.source.loadRun(OLD_A);
  assert.equal(s.source.isLoaded(OLD_A), true);
});

test('index: a run that is listed-only and is written to within the window is loaded by the same path (no event twice)', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const s = startSource(t, r.root);
  await s.start();
  const journal = path.join(r.oldSession, 'subagents', 'workflows', OLD_B, 'journal.jsonl');
  const n = s.of(OLD_B).length;
  await fsp.appendFile(journal, lines({ type: 'launched' }));
  await s.source.rescan();
  assert.equal(s.source.isLoaded(OLD_B), true);
  const full = await readRunDir(r.oldSession, OLD_B);
  assert.equal(s.of(OLD_B).length, full.length, 'what the index gave is not given again');
  assert.ok(s.of(OLD_B).length > n);
});

test('the watcher: one fs.watch for the whole root; a change under the agent files of a listed-only run is dropped, its journal is read', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const calls = [];
  let listener = null;
  t.mock.method(fs, 'watch', (...args) => {
    calls.push(args);
    listener = args[2];
    return { on() {}, close() {}, unref() {} };
  });
  const opened = spyOpens(t);
  const stats = [];
  const stat = fsp.stat;
  t.mock.method(fsp, 'stat', (p, ...rest) => { stats.push(String(p)); return stat.call(fsp, p, ...rest); });
  const s = startSource(t, r.root, { watch: true });
  await s.start();
  assert.equal(calls.length, 1, 'one watcher on the root');
  opened.length = 0;
  stats.length = 0;

  const runDir = path.join(r.oldSession, 'subagents', 'workflows', OLD_A);
  const agent = fs.readdirSync(runDir).find((n) => /^agent-.*\.jsonl$/.test(n));
  await fsp.appendFile(path.join(runDir, agent), lines({ type: 'user', message: { content: 'x' } }));
  await fsp.utimes(path.join(runDir, agent), LONG_AGO, LONG_AGO); // the window test must not see this write
  const rel = (...parts) => path.join(FIX_SLUG, FIX_SESSION, 'subagents', 'workflows', OLD_A, ...parts);
  listener('change', rel(agent));
  listener('change', rel(agent.replace(/\.jsonl$/, '.meta.json')));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(opened, [], 'nothing opened for a change under an agent file of an unloaded run');
  assert.deepEqual(stats, [], 'and no pass at all: not even a stat of its journal, final file or script');
  assert.equal(s.source.isLoaded(OLD_A), false);

  const journal = path.join(runDir, 'journal.jsonl');
  await fsp.appendFile(journal, lines({ type: 'launched' }));
  await fsp.utimes(journal, LONG_AGO, LONG_AGO);
  const n = s.of(OLD_A).length;
  listener('change', rel('journal.jsonl'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(stats.some((p) => p.endsWith('journal.jsonl')), 'a change of the journal is looked at');
  assert.ok(opened.some((p) => p.endsWith('journal.jsonl')), 'a change of the journal is read');
  assert.equal(s.of(OLD_A).length, n + 1, 'its new line is delivered');
  assert.deepEqual(opened.filter(agentFile), [], 'and still no agent file');
  assert.equal(s.source.isLoaded(OLD_A), false, 'a write the window test does not see as recent does not load the run');
  assert.equal(calls.length, 1);
});

test('loadRun: a call made while a load is half done gets that load\'s promise and resolves only when it is done; the run is not loaded until then', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const s = startSource(t, r.root);
  await s.start();
  // hold the first transcript open until the test lets it go
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (p, ...rest) => {
    if (agentFile(String(p))) {
      entered();
      await gate;
    }
    return open.call(fsp, p, ...rest);
  });
  const first = s.source.loadRun(OLD_A);
  await inside;
  assert.equal(s.source.isLoaded(OLD_A), false, 'being loaded is not loaded');
  const second = s.source.loadRun(OLD_A);
  assert.equal(second, first, 'the same promise');
  let done = false;
  second.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, 'not resolved while the load is half done');
  release();
  await first;
  assert.equal(done || (await second, true), true);
  assert.equal(s.source.isLoaded(OLD_A), true);
  const full = await readRunDir(r.oldSession, OLD_A);
  assert.equal(s.of(OLD_A).length, full.length, 'each event once');
});

test('loadRun: stop() while a load is half done rejects it, leaves the run listed only, and a later load finishes it with no event twice', { timeout: 30_000 }, async (t) => {
  const r = await makeRoot(t);
  const s = startSource(t, r.root);
  await s.start();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  const open = fsp.open;
  const hold = t.mock.method(fsp, 'open', async (p, ...rest) => {
    if (agentFile(String(p))) {
      entered();
      await gate;
    }
    return open.call(fsp, p, ...rest);
  });
  const pending = s.source.loadRun(OLD_A);
  await inside;
  s.source.stop();
  release();
  await assert.rejects(pending, /stopped/);
  assert.equal(s.source.isLoaded(OLD_A), false, 'a load cut by stop() is not a loaded run');
  const delivered = s.of(OLD_A).length;
  hold.mock.restore();
  await s.source.start();
  await s.source.loadRun(OLD_A);
  assert.equal(s.source.isLoaded(OLD_A), true);
  const full = await readRunDir(r.oldSession, OLD_A);
  assert.deepEqual(s.of(OLD_A).map(key).sort(), full.map(key).sort(), 'what the cut load had not delivered comes now, nothing twice');
  assert.ok(s.of(OLD_A).length >= delivered);
});
