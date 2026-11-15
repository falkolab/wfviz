// Integration, replay: every run under fixtures/claude-projects and fixtures/synthetic goes
// readRunDir -> createStore().apply -> getRun, and the Run is checked against docs/contract.md
// section 2. Each run is replayed twice: as it stands (final file present) and as a temp copy
// with the end-of-run file removed (what the same run looked like while it was running).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import {
  allFixtureRuns, assertRunShape, copyRun, edgeKeys, expectedDataFlow, expectedTimeOrder, lastEventTs, mkTmp,
  readJson, readLines, replayInto, runFiles,
} from './helpers.mjs';

// What each fixture run must show. Read from the fixture files by hand, not from the code under test.
const EXPECT = {
  'wf_6509ce25-20a': {
    status: 'completed',
    name: 'probe-event-format',
    ccVersion: '2.1.317',
    phases: [{ title: 'Fanout', detail: 'two independent reviewers' }, { title: 'Judge' }, { title: 'Loop' }],
    agents: { 'reviewer:A': 'Fanout', 'reviewer:B': 'Fanout', judge: 'Judge', 'fixer:round1': 'Loop', 'fixer:round2': 'Loop' },
    labelsFrom: 'registered',
    dataFlow: [], // contract 2: each reviewer result has 37 non-space chars, below the 64 an edge needs (contract 1: A -> judge, B -> judge)
    logs: ['probe: starting fanout', 'probe: loop round 1', 'probe: loop round 2'],
  },
  'wf_26eb8d70-5c4': {
    status: 'failed',
    name: 'probe-edge-cases',
    ccVersion: '2.1.317',
    phases: [{ title: 'Pipe' }, { title: 'Errors' }],
    agents: {
      'stage1:alpha': 'Pipe', 'stage1:beta': 'Pipe', 'stage1:gamma': 'Pipe', 'stage2:gamma': 'Pipe', 'stage2:alpha': 'Pipe', 'errors:ok': 'Errors',
    },
    labelsFrom: 'registered',
    dataFlow: [], // every result is shorter than 64 characters: nothing can be shown to flow
    logs: 4,
  },
  'wf_00000206-leg': {
    status: 'completed',
    name: 'legacy-demo',
    ccVersion: '2.1.206',
    phases: [{ title: 'Sweep' }, { title: 'Synthesize' }],
    agents: { 'find:alpha': 'Sweep', 'find:beta': 'Sweep', synthesis: 'Synthesize' },
    labelsFrom: 'final', // 2.1.206 writes neither label nor phase to the journal
    dataFlow: [['find:alpha', 'synthesis'], ['find:beta', 'synthesis']],
    logs: ['Sweep done: 2/2'],
  },
};

const runs = allFixtureRuns();
const idOf = (run, label) => Object.values(run.agents).find((a) => a.label.value === label)?.id;
const pairs = (run, list) => new Set(list.map(([from, to]) => `${idOf(run, from)}>${idOf(run, to)}`));

test('the fixtures hold exactly the runs these tests know about', () => {
  assert.deepEqual(runs.map((r) => r.runId).sort(), Object.keys(EXPECT).sort());
});

// ---------------------------------------------------------------------------------------
// the run as it stands: final file present

for (const src of runs) {
  const want = EXPECT[src.runId];
  if (!want) continue;

  test(`${src.runId}: replay with the final file gives the Run of contract section 2`, async () => {
    const { run, events } = await replayInto(createStore, readRunDir, src.sessionDir, src.runId);
    const files = runFiles(src.sessionDir, src.runId);
    const final = readJson(files.final);
    assertRunShape(run);
    assert.ok(events.length > 0);

    // identity
    assert.equal(run.id, src.runId);
    assert.equal(run.source, 'real');
    assert.equal(run.sessionId, src.session);
    assert.equal(run.project, src.slug);
    assert.equal(run.ccVersion.value, want.ccVersion);
    assert.equal(run.ccVersion.prov, 'registered');

    // status: from the final file, and says so
    assert.equal(run.status.value, want.status);
    assert.equal(run.status.value, final.status, 'same value as the final file');
    assert.equal(run.status.prov, 'final');
    assert.equal(run.status.from, `${files.final}#status`);
    assert.equal(run.endedAt.prov, 'final');
    assert.equal(run.durationMs.value, final.durationMs);
    assert.equal(run.durationMs.prov, 'final');
    assert.equal(run.totals.tokens.value, final.totalTokens);
    assert.equal(run.totals.toolCalls.value, final.totalToolCalls);

    // name and phases come from the script meta; the final file agrees
    assert.deepEqual([run.name.value, run.name.prov], [want.name, 'registered']);
    assert.match(run.name.from, /workflows\/scripts\/.+\.js#meta\.name$/);
    assert.deepEqual(run.declaredPhases, want.phases);
    assert.deepEqual(final.phases, want.phases, 'the fixture itself is consistent');
    assert.deepEqual(run.phases.map((p) => p.title), want.phases.map((p) => p.title));
    assert.equal(run.description.prov, 'registered');

    // agents: every agent of the final file, with its label
    const progress = final.workflowProgress.filter((e) => e.type === 'workflow_agent');
    assert.equal(run.order.length, progress.length);
    assert.deepEqual(new Set(run.order), new Set(progress.map((e) => e.agentId)));
    for (const entry of progress) {
      const a = run.agents[entry.agentId];
      assert.equal(a.label.value, entry.label);
      assert.equal(a.label.prov, want.labelsFrom, `label of ${entry.label}`);
      assert.equal(a.phase.value, entry.phaseTitle);
      assert.equal(a.phase.prov, want.labelsFrom);
      assert.equal(a.phase.value, want.agents[entry.label]);
      assert.deepEqual([a.state.value, a.state.prov], ['done', 'final'], `state of ${entry.label}: the final file says ${entry.state}`);
      assert.equal(a.model.prov, 'final');
      assert.equal(a.tokens.value, entry.tokens);
      assert.equal(a.toolCalls.value, entry.toolCalls);
      assert.equal(a.prompt.prov, 'registered', 'full prompt from the transcript, not the preview');
      assert.ok(a.prompt.value.length > 0 && !a.prompt.value.startsWith('[Workflow harness'), 'prompt is unframed');
    }
    // phases list the agents that carry their title, in start order
    for (const p of run.phases) {
      assert.deepEqual(p.agentIds, run.order.filter((id) => run.agents[id].phase.value === p.title));
      assert.deepEqual([p.state.value, p.state.prov], ['done', 'inferred']);
    }
    // role / unit / round: inferred from the label, never registered
    const sample = run.agents[idOf(run, Object.keys(want.agents)[0])];
    const [role, unit] = Object.keys(want.agents)[0].split(':');
    assert.deepEqual([sample.role.value, sample.role.prov, sample.role.method], [role, 'inferred', 'label-pattern']);
    assert.equal(sample.unit.value, unit);

    // logs: the final file only
    assert.deepEqual([run.logs.prov, run.logs.from], ['final', `${files.final}#logs`]);
    if (Array.isArray(want.logs)) assert.deepEqual(run.logs.value, want.logs);
    else assert.equal(run.logs.value.length, want.logs);
    assert.deepEqual(run.logs.value, final.logs);

    // a failed run carries the error text of the final file, and only then
    if (final.error) assert.deepEqual([run.error.value, run.error.prov], [final.error, 'final']);

    // nothing registers dependencies
    assert.deepEqual(run.registeredEdges, { value: [], prov: 'unknown', reason: run.registeredEdges.reason });
    assert.ok(run.registeredEdges.reason.length > 0);
    assert.ok(run.unknowns.some((u) => u.field === 'registeredEdges'));
    assert.deepEqual(run.warnings, [], 'a clean fixture replays without warnings');
  });

  test(`${src.runId}: edges are exactly the ones the evidence supports`, async () => {
    const { run } = await replayInto(createStore, readRunDir, src.sessionDir, src.runId);
    const flow = edgeKeys(run, 'data-flow');
    assert.deepEqual(flow, pairs(run, want.dataFlow), 'data-flow edges named in the expectation');
    assert.deepEqual(flow, expectedDataFlow(run), 'data-flow edges = contract 2: >= 64 chars of a unique earlier result, not boilerplate');
    assert.deepEqual(edgeKeys(run, 'time-order'), expectedTimeOrder(run, flow), 'time-order edges = the 1500 ms rule');
    assert.equal(run.edges.length, flow.size + edgeKeys(run, 'time-order').size, 'no other kind of edge');
    for (const e of run.edges.filter((x) => x.kind === 'data-flow')) {
      assert.match(e.evidence, /result of/, 'the evidence names what was repeated');
    }
    // an agent that only ever shares a short result with its successors (stage1 -> stage2) gets no edge
    if (want.dataFlow.length === 0) assert.equal(flow.size, 0);
  });
}

test('wf_6509ce25-20a: the judge prompt holds both reviewer results, but each has 37 chars: no data-flow edge (contract 2)', async () => {
  const src = runs.find((r) => r.runId === 'wf_6509ce25-20a');
  const { run } = await replayInto(createStore, readRunDir, src.sessionDir, src.runId);
  const judge = idOf(run, 'judge');
  assert.ok(run.agents[judge].prompt.value.includes('"verdict":"pass","note":"A saw x=1"'), 'the judge prompt does quote reviewer A');
  assert.equal(run.edges.filter((e) => e.to === judge && e.kind === 'data-flow').length, 0);
  assert.equal(run.edges.filter((e) => e.kind === 'data-flow').length, 0);
  // the loop has no data evidence (its results are "round 1 done"), so fixer:round1 -> fixer:round2 does not exist
  assert.ok(!run.edges.some((e) => e.from === idOf(run, 'fixer:round1')));
});

// ---------------------------------------------------------------------------------------
// the same runs without their final file

for (const src of runs) {
  const want = EXPECT[src.runId];
  if (!want) continue;

  test(`${src.runId}: without the final file the run is running (inferred) and says what it does not know`, async (t) => {
    const tmp = mkTmp(t);
    const dst = path.join(tmp, src.slug, src.session);
    const files = copyRun(src.sessionDir, src.runId, dst, { final: false });
    assert.equal(files.final, null, 'the copy has no end-of-run file');
    const { run } = await replayInto(createStore, readRunDir, dst, src.runId);
    const { run: complete } = await replayInto(createStore, readRunDir, src.sessionDir, src.runId);
    assertRunShape(run);

    assert.deepEqual([run.status.value, run.status.prov, run.status.method], ['running', 'inferred', 'no-final-file']);
    for (const f of ['endedAt', 'durationMs', 'logs']) {
      assert.deepEqual([run[f].value, run[f].prov], [null, 'unknown'], `${f} is not recorded before the end`);
    }
    assert.match(run.logs.reason, /end/, 'log() lines are written only at the end');
    assert.deepEqual(run.unknowns.map((u) => u.field).filter((f) => ['endedAt', 'durationMs', 'logs', 'registeredEdges'].includes(f)).sort(),
      ['durationMs', 'endedAt', 'logs', 'registeredEdges']);
    assert.equal(run.registeredEdges.prov, 'unknown');

    // from the script: name and declared phases
    assert.deepEqual([run.name.value, run.name.prov], [want.name, 'registered']);
    assert.deepEqual(run.declaredPhases, want.phases);
    assert.deepEqual(run.phases.map((p) => p.title), want.phases.map((p) => p.title));

    // agents: the journal says they are done; labels come from the journal when the version writes them
    assert.deepEqual(new Set(run.order), new Set(complete.order));
    for (const id of run.order) {
      const a = run.agents[id];
      assert.deepEqual([a.state.value, a.state.prov], ['done', 'registered'], `${id} has a journal result line`);
      assert.match(a.state.from, /journal\.jsonl:\d+$/);
      assert.equal(a.result.prov, 'registered');
      const label = complete.agents[id].label.value;
      if (want.labelsFrom === 'registered') {
        assert.deepEqual([a.label.value, a.label.prov], [label, 'registered']);
        assert.equal(a.phase.value, want.agents[label]);
        assert.equal(a.phase.prov, 'registered');
      } else {
        // 2.1.206: no label and no phase before the final file; saying so is the right answer
        for (const f of ['label', 'phase', 'role', 'unit', 'round']) {
          assert.deepEqual([a[f].value, a[f].prov], [null, 'unknown'], `${f} of ${id}`);
          assert.ok(a[f].reason.length > 0);
        }
      }
    }
    if (want.labelsFrom !== 'registered') {
      assert.ok(run.phases.every((p) => p.agentIds.length === 0), 'no agent can be placed in a phase');
      assert.ok(run.phases.every((p) => p.state.prov === 'unknown'), 'and so no phase state is claimed');
    }

    // the dependency evidence does not need the final file
    assert.deepEqual(edgeKeys(run, 'data-flow'), edgeKeys(complete, 'data-flow'));
    assert.deepEqual(edgeKeys(run, 'data-flow'), expectedDataFlow(run));
    assert.deepEqual(edgeKeys(run, 'time-order'), expectedTimeOrder(run, edgeKeys(run, 'data-flow')));
    assert.deepEqual(run.warnings, []);
  });
}

test('a run with no final file and no activity for longer than staleMs is not claimed to be running', async (t) => {
  const src = runs.find((r) => r.runId === 'wf_6509ce25-20a');
  const tmp = mkTmp(t);
  const dst = path.join(tmp, src.slug, src.session);
  copyRun(src.sessionDir, src.runId, dst, { final: false });
  const events = await readRunDir(dst, src.runId);
  const store = createStore({ now: () => lastEventTs(events) + 31 * 60e3 }); // default staleMs is 30 min
  for (const ev of events) store.apply(ev);
  const run = store.getRun(src.runId);
  assert.deepEqual([run.status.value, run.status.prov], [null, 'unknown']);
  assert.match(run.status.reason, /no file activity/);
  assert.ok(run.unknowns.some((u) => u.field === 'status'));
});

// ---------------------------------------------------------------------------------------
// journal "failed"

// finalState: also keep the end-of-run file in the copy, with this value as the agent's `state` in it.
function copyWithFailedAgent(t, label, { finalState } = {}) {
  const src = runs.find((r) => r.runId === 'wf_6509ce25-20a');
  const tmp = mkTmp(t);
  const dst = path.join(tmp, src.slug, src.session);
  const files = copyRun(src.sessionDir, src.runId, dst, { final: finalState !== undefined });
  const lines = readLines(files.journal).map((l) => JSON.parse(l));
  const started = lines.find((r) => r.type === 'started' && r.label === label);
  const at = lines.findIndex((r) => r.type === 'result' && r.agentId === started.agentId);
  assert.ok(at > 0, 'the fixture journal has a result line for the agent');
  // the documented shape of a failure: a "failed" line with key and agentId, and no result line after it
  lines[at] = { type: 'failed', key: started.key, agentId: started.agentId };
  fs.writeFileSync(files.journal, `${lines.map((r) => JSON.stringify(r)).join('\n')}\n`);
  if (finalState !== undefined) {
    const final = readJson(files.final);
    const entry = final.workflowProgress.find((e) => e.agentId === started.agentId);
    assert.ok(entry, 'the final file lists the agent');
    entry.state = finalState;
    fs.writeFileSync(files.final, `${JSON.stringify(final, null, 2)}\n`);
  }
  return { src, dst, agentId: started.agentId, failedLine: at + 1 };
}

test('a journal "failed" line makes the agent failed (registered), and the run shows it', async (t) => {
  const { src, dst, agentId, failedLine } = copyWithFailedAgent(t, 'reviewer:B');
  const events = await readRunDir(dst, src.runId);
  assert.equal(events.filter((e) => e.kind === 'agent.failed').length, 1, 'the source emits agent.failed');
  const { run } = await replayInto(createStore, readRunDir, dst, src.runId);
  assertRunShape(run);

  const b = run.agents[agentId];
  assert.deepEqual([b.state.value, b.state.prov], ['failed', 'registered']);
  assert.match(b.state.from, new RegExp(`journal\\.jsonl:${failedLine}$`));
  assert.deepEqual([b.result.value, b.result.prov], [null, 'unknown'], 'a failed agent has no result and none is invented');
  assert.notEqual(b.endedAt.prov, 'unknown', 'it did end: its transcript says when');

  assert.equal(run.totals.failed, 1);
  assert.equal(run.totals.done, 4);
  assert.equal(run.totals.running, 0);
  const fanout = run.phases.find((p) => p.title === 'Fanout');
  assert.deepEqual([fanout.state.value, fanout.state.prov], ['failed', 'inferred']);
  assert.ok(!run.warnings.some((w) => /unknown event kind/.test(w)), `warnings: ${JSON.stringify(run.warnings)}`);
  // The judge's prompt still holds B's verdict word for word, but B has no result any more:
  // there is nothing to compare against, so there is no edge from B. (Contract 2: reviewer A's result has 37 chars,
  // below the 64 an edge needs, so there is no edge from A either.)
  assert.deepEqual(edgeKeys(run, 'data-flow'), new Set());
  assert.deepEqual(edgeKeys(run, 'data-flow'), expectedDataFlow(run));
});

test('final file present, state "error" (contract 2: failed, final, raw "error") for an agent the journal marks failed: the final file is read, and copying it does not change the state value', async (t) => {
  const { src, dst, agentId, failedLine } = copyWithFailedAgent(t, 'reviewer:B', { finalState: 'error' });
  const { run } = await replayInto(createStore, readRunDir, dst, src.runId);
  assertRunShape(run);
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final'], 'the final file is read: its status stands');

  const b = run.agents[agentId];
  assert.deepEqual([b.state.value, b.state.prov, b.state.raw], ['failed', 'final', 'error'], 'contract 2: "error" is a documented final state: failed, with the source value kept');
  assert.match(b.state.from, /workflowProgress\[\d+\]\.state$/);
  assert.ok(failedLine > 0 && !run.warnings.some((w) => w.includes(agentId)), `the journal line and the final file agree: no warning: ${JSON.stringify(run.warnings)}`);
  assert.ok(!run.unknowns.some((u) => u.field === `agents.${agentId}.state`), 'the state is not listed as unknown');

  assert.equal(run.totals.failed, 1);
  assert.equal(run.totals.done, 4);
  const fanout = run.phases.find((p) => p.title === 'Fanout');
  assert.deepEqual([fanout.state.value, fanout.state.prov], ['failed', 'inferred'], 'the phase is told by its agents, not unknown');
  for (const id of run.order.filter((x) => x !== agentId)) assert.deepEqual([run.agents[id].state.value, run.agents[id].state.prov], ['done', 'final']);

  // the same run before the final file existed says the same about every agent's state value
  const files = runFiles(dst, src.runId);
  fs.rmSync(files.final);
  const { run: live } = await replayInto(createStore, readRunDir, dst, src.runId);
  assert.deepEqual(Object.fromEntries(run.order.map((id) => [id, run.agents[id].state.value])), Object.fromEntries(live.order.map((id) => [id, live.agents[id].state.value])));
  assert.deepEqual(run.phases.map((p) => [p.title, p.state.value]), live.phases.map((p) => [p.title, p.state.value]));
});

test('a failed agent without any transcript still shows as failed', async (t) => {
  const { src, dst, agentId } = copyWithFailedAgent(t, 'reviewer:B');
  const files = runFiles(dst, src.runId);
  fs.rmSync(files.agents.find((a) => a.id === agentId).jsonl);
  const { run } = await replayInto(createStore, readRunDir, dst, src.runId);
  assertRunShape(run);
  assert.deepEqual([run.agents[agentId].state.value, run.agents[agentId].state.prov], ['failed', 'registered']);
  assert.equal(run.totals.failed, 1);
});

test('a "failed" line followed by a result line for the same agent: the result wins, and the model says so', async (t) => {
  const { src, dst, agentId } = copyWithFailedAgent(t, 'reviewer:B');
  const files = runFiles(dst, src.runId);
  const original = readLines(runFiles(src.sessionDir, src.runId).journal);
  const lines = readLines(files.journal);
  const at = lines.findIndex((l) => JSON.parse(l).type === 'failed');
  lines.splice(at + 1, 0, original.find((l) => JSON.parse(l).type === 'result' && JSON.parse(l).agentId === agentId));
  fs.writeFileSync(files.journal, `${lines.join('\n')}\n`);
  const { run } = await replayInto(createStore, readRunDir, dst, src.runId);
  assert.deepEqual([run.agents[agentId].state.value, run.agents[agentId].state.prov], ['done', 'registered']);
  assert.equal(run.totals.failed, 0);
  assert.ok(run.warnings.some((w) => w.includes(agentId) && /both a "failed" and a "result"/.test(w)), JSON.stringify(run.warnings));
});

test('every fixture replays to a Run that survives a JSON round trip unchanged (what the server sends)', async () => {
  for (const src of runs) {
    const { run } = await replayInto(createStore, readRunDir, src.sessionDir, src.runId);
    assert.deepEqual(JSON.parse(JSON.stringify(run)), run, src.runId);
  }
});
