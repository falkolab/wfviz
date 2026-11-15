// Integration, live growth: probe 1 is rebuilt file by file under a temp root while a
// createClaudeFsSource -> createStore pair watches that root. The journal grows one line at a
// time, each agent's transcript grows (a line is cut in half once), and the final run file is
// copied last. After every step the Run in the store is checked.
//
// Two drivers run the same script: one calls source.rescan() after each step (deterministic,
// exact), one lets the source's own timer poll (the way bin/wfviz.mjs uses it).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createStore } from '../../src/model/reduce.mjs';
import { createClaudeFsSource, readRunDir } from '../../src/source/claude-fs.mjs';
import {
  assertRunShape, copyFileInto, edgeKeys, eventually, expectedDataFlow, findRun, mkTmp, readLines, replayInto, runFiles,
} from './helpers.mjs';

const RUN_ID = 'wf_6509ce25-20a';
const SRC = findRun(RUN_ID);
const SESSION = '22222222-2222-4222-8222-222222222222';
const SLUG = '-integration-grow';

function splitLines(buf) {
  const out = [];
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(from, i + 1));
      from = i + 1;
    }
  }
  if (from < buf.length) out.push(buf.subarray(from));
  return out;
}

const recordOf = (line) => JSON.parse(line.toString('utf8'));
const producesActivity = (line) => {
  const r = recordOf(line);
  const c = r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content : [];
  return c.some((b) => b.type === 'tool_use' || (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== ''));
};

// A transcript as three byte chunks: what is written when the agent starts (up to its first reply),
// then the rest up to the middle of the first line that is activity, then the rest of the file.
function transcriptChunks(file) {
  const lines = splitLines(fs.readFileSync(file));
  const firstReply = lines.findIndex((l) => recordOf(l).type === 'assistant');
  const headLines = lines.slice(0, firstReply < 0 ? lines.length : firstReply);
  const restLines = lines.slice(headLines.length);
  const k = restLines.findIndex(producesActivity);
  assert.ok(k >= 0, `${path.basename(file)} has a line of activity to cut in half`);
  const before = Buffer.concat(restLines.slice(0, k));
  const cut = Math.floor(restLines[k].length / 2);
  const rest = Buffer.concat(restLines);
  return {
    head: Buffer.concat(headLines),
    firstHalf: rest.subarray(0, before.length + cut),
    secondHalf: rest.subarray(before.length + cut),
  };
}

async function growProbe1(t, { poll }) {
  const tmp = mkTmp(t);
  const root = path.join(tmp, 'projects');
  const dst = path.join(root, SLUG, SESSION);
  const src = runFiles(SRC.sessionDir, RUN_ID);
  const dstRunDir = path.join(dst, 'subagents', 'workflows', RUN_ID);
  const dstJournal = path.join(dstRunDir, 'journal.jsonl');
  fs.mkdirSync(root, { recursive: true });

  const store = createStore({ staleMs: 24 * 3600e3 });
  const events = [];
  const history = new Map(); // agentId -> the states it went through
  store.onChange(() => {
    const run = store.getRun(RUN_ID);
    for (const id of run.order) {
      const v = run.agents[id].state.value ?? 'unknown';
      const h = history.get(id) ?? history.set(id, []).get(id);
      if (h[h.length - 1] !== v) h.push(v);
    }
  });
  const source = createClaudeFsSource({
    root,
    pollMs: poll ? 15 : Infinity, // Infinity: no timer, the source reads on start() and rescan() only
    scanMs: poll ? 100 : undefined,
    onEvent: (ev) => {
      events.push(ev);
      store.apply(ev);
    },
  });
  t.after(() => source.stop());
  const get = () => store.getRun(RUN_ID);

  const journal = readLines(src.journal).map((text) => ({ text, rec: JSON.parse(text) }));
  assert.equal(journal[0].rec.type, 'launched');
  const idOfLabel = Object.fromEntries(journal.filter((j) => j.rec.type === 'started').map((j) => [j.rec.label, j.rec.agentId]));
  const agentFile = (id) => src.agents.find((a) => a.id === id);
  const appendJournal = (text) => {
    fs.mkdirSync(dstRunDir, { recursive: true });
    fs.appendFileSync(dstJournal, `${text}\n`);
  };

  // ---- the script of the growth: [name, act, expect]
  const steps = [];
  const step = (name, act, expect) => steps.push({ name, act, expect });
  const running = new Set();
  const activityBefore = new Map();

  step('script written at launch', () => copyFileInto(SRC.sessionDir, src.script, dst), (run) => {
    assert.ok(run, 'the run is found from its script alone');
    assert.deepEqual([run.name.value, run.name.prov], ['probe-event-format', 'registered']);
    assert.deepEqual(run.declaredPhases.map((p) => p.title), ['Fanout', 'Judge', 'Loop']);
    assert.equal(run.order.length, 0);
    assert.deepEqual([run.status.value, run.status.prov], [null, 'unknown'], 'no journal line yet: no claim about the status');
    assert.deepEqual(run.edges, []);
  });

  step('journal: launched', () => appendJournal(journal[0].text), (run) => {
    assert.deepEqual([run.status.value, run.status.prov, run.status.method], ['running', 'inferred', 'no-final-file']);
    assert.equal(run.order.length, 0);
  });

  for (const { text, rec } of journal.slice(1)) {
    if (rec.type === 'started') {
      const id = rec.agentId;
      step(`journal: started ${rec.label}`, () => {
        appendJournal(text);
        copyFileInto(SRC.sessionDir, agentFile(id).meta, dst);
        fs.writeFileSync(path.join(dstRunDir, path.basename(agentFile(id).jsonl)), transcriptChunks(agentFile(id).jsonl).head);
        running.add(id);
      }, (run) => {
        const a = run.agents[id];
        assert.ok(a, `agent ${rec.label} appears when its started line does`);
        assert.deepEqual([a.state.value, a.state.prov], ['running', 'registered']);
        assert.deepEqual([a.label.value, a.label.prov], [rec.label, 'registered']);
        assert.deepEqual([a.phase.value, a.phase.prov], [rec.phase, 'registered']);
        assert.equal(a.prompt.prov, 'registered', 'its prompt is in the transcript head');
        assert.equal(a.activity.length, 0);
        assert.deepEqual([a.result.value, a.result.prov], [null, 'unknown'], 'running: no result yet');
        assert.equal(run.totals.running, running.size);
        assert.equal(run.totals.agents, run.order.length);
        assert.equal(run.status.value, 'running');
        // edges appear when the evidence does: with the judge's prompt, not before
        const flow = edgeKeys(run, 'data-flow');
        assert.deepEqual(flow, expectedDataFlow(run));
        if (/^reviewer:/.test(rec.label)) assert.equal(flow.size, 0, 'no result is known yet that a prompt could repeat');
        if (rec.label === 'judge') assert.equal(flow.size, 0, 'the judge prompt repeats both reviewer results, but they have 37 chars each: below the 64 of contract 2');
      });
    } else if (rec.type === 'result') {
      const id = rec.agentId;
      const label = journal.find((j) => j.rec.type === 'started' && j.rec.agentId === id).rec.label;
      const chunks = transcriptChunks(agentFile(id).jsonl);
      const target = path.join(dstRunDir, path.basename(agentFile(id).jsonl));
      step(`transcript of ${label}: first half of a line`, () => {
        activityBefore.set(id, get().agents[id].activity.length);
        fs.appendFileSync(target, chunks.firstHalf);
      }, (run) => {
        assert.equal(run.agents[id].activity.length, activityBefore.get(id), 'a half-written line is not read');
        assert.ok(!run.warnings.some((w) => /unreadable|JSON/.test(w)), `a half line is no error: ${JSON.stringify(run.warnings)}`);
        assert.equal(run.agents[id].state.value, 'running');
      });
      step(`transcript of ${label}: line completed`, () => fs.appendFileSync(target, chunks.secondHalf), (run) => {
        assert.ok(run.agents[id].activity.length > 0, 'the completed line is read');
        assert.equal(run.agents[id].lastActivity.prov, 'registered');
        assert.equal(run.agents[id].state.value, 'running', 'the journal has not said it is done');
      });
      step(`journal: result ${label}`, () => {
        appendJournal(text);
        running.delete(id);
      }, (run) => {
        const a = run.agents[id];
        assert.deepEqual([a.state.value, a.state.prov], ['done', 'registered']);
        assert.deepEqual(a.result.value, rec.result);
        assert.equal(a.result.prov, 'registered');
        assert.equal(run.totals.running, running.size);
        assert.equal(run.status.value, 'running', 'the run is not over until the final file exists');
        assert.deepEqual(edgeKeys(run, 'data-flow'), expectedDataFlow(run), 'edges follow the evidence at every step');
        assert.deepEqual(run.warnings, []);
      });
    }
  }

  step('final run file copied last', () => copyFileInto(SRC.sessionDir, src.final, dst), (run) => {
    assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
    assert.equal(run.status.from, `${path.join(dst, 'workflows', `${RUN_ID}.json`)}#status`);
    assert.equal(run.totals.running, 0);
    assert.equal(run.totals.done, 5);
    assert.deepEqual(run.logs.prov, 'final');
    assert.equal(run.logs.value.length, 3);
    for (const id of run.order) assert.deepEqual([run.agents[id].state.value, run.agents[id].state.prov], ['done', 'final']);
  });

  // ---- drive it
  const verify = async (s) => {
    try {
      if (poll) await eventually(() => s.expect(get()), { ms: 15_000 });
      else {
        await source.rescan();
        s.expect(get());
      }
    } catch (err) {
      err.message = `after step "${s.name}": ${err.message}`;
      throw err;
    }
  };

  const [first, ...later] = steps;
  if (poll) {
    await first.act(); // the run exists when the source starts
    await source.start();
  } else {
    await source.start(); // an empty root: nothing there yet
    assert.deepEqual(store.listRuns(), []);
    await first.act();
  }
  await verify(first);
  for (const s of later) {
    await s.act();
    await verify(s);
    const run = get();
    assertRunShape(run, `after "${s.name}"`);
  }
  source.stop();

  // ---- what the whole growth added up to
  const run = get();
  assert.equal(run.order.length, 5);
  assert.deepEqual(new Set(run.order), new Set(Object.values(idOfLabel)));
  const wanted = (label) => idOfLabel[label];
  assert.deepEqual(edgeKeys(run, 'data-flow'), new Set(), 'contract 2: the reviewer results are too short (37 chars) to make an edge');

  // every agent went started -> done, none went anywhere else
  for (const id of run.order) {
    const h = history.get(id);
    assert.ok(h, `agent ${id} was seen`);
    if (poll) assert.deepEqual(h.filter((s) => s !== 'unknown'), ['running', 'done'], `states of ${run.agents[id].label.value}: ${h}`);
    else assert.deepEqual(h, ['running', 'done'], `states of ${run.agents[id].label.value}`);
    assert.ok(!h.includes('failed'));
  }
  // the first two agents ran at the same time
  const a = run.agents[wanted('reviewer:A')];
  const b = run.agents[wanted('reviewer:B')];
  assert.ok(b.startedAt.value < a.endedAt.value, 'reviewers overlap');

  // the Run the live source built is the Run a replay of the finished directory builds
  const replayed = await replayInto(createStore, readRunDir, dst, RUN_ID);
  assert.deepEqual(JSON.parse(JSON.stringify(run)), JSON.parse(JSON.stringify(replayed.run)), 'live growth and one-shot replay agree');
  const count = (list) => list.reduce((m, e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1), new Map());
  assert.deepEqual([...count(events)].sort(), [...count(replayed.events)].sort(), 'the same events, once each');
  return { run, events };
}

test('probe 1 grows file by file; the source (rescan after each step) and the store follow it exactly', async (t) => {
  await growProbe1(t, { poll: false });
});

test('probe 1 grows file by file; the source polls by itself and the store follows it', { timeout: 120_000 }, async (t) => {
  await growProbe1(t, { poll: true });
});
