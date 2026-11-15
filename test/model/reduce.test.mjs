import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reduceRun, reduceDetailed, createStore } from '../../src/model/reduce.mjs';
import { probe1, probe2, legacy, builder, FRAME, RELAY, framed, P1, P2, L } from './helpers.mjs';

const PROVS = new Set(['registered', 'final', 'inferred', 'unknown']);
const isFact = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && 'prov' in x && 'value' in x;
const fileLine = /^.+\.jsonl:\d+$/;

// every Fact anywhere in the run obeys the provenance rules of docs/contract.md section 2
function allFacts(node, path = 'run', out = []) {
  if (isFact(node)) { out.push([path, node]); return out; }
  if (Array.isArray(node)) node.forEach((x, i) => allFacts(x, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) allFacts(v, `${path}.${k}`, out);
  return out;
}
function checkFacts(run, min = 40) {
  const facts = allFacts(run);
  assert.ok(facts.length >= min, 'expected many facts');
  for (const [path, f] of facts) {
    assert.ok(PROVS.has(f.prov), `${path}: bad prov ${f.prov}`);
    if (f.prov === 'registered' || f.prov === 'final') {
      assert.ok(typeof f.from === 'string' && f.from.length > 0, `${path}: ${f.prov} fact without from`);
      assert.equal(f.method, undefined, `${path}: ${f.prov} fact with method`);
    }
    if (f.prov === 'inferred') {
      assert.ok(typeof f.method === 'string' && f.method.length > 0, `${path}: inferred fact without method`);
      assert.equal(f.from, undefined, `${path}: inferred fact with from`);
    }
    if (f.prov === 'unknown') {
      assert.ok(typeof f.reason === 'string' && f.reason.length > 0, `${path}: unknown fact without reason`);
      assert.equal(f.value === null || (Array.isArray(f.value) && f.value.length === 0), true, `${path}: unknown fact with a value`);
    }
  }
}
const by = (run, label) => Object.values(run.agents).find((a) => a.label.value === label);
const upTo = (events, ts) => events.filter((e) => e.ts <= ts);
const T = (iso) => Date.parse(iso);

// ------------------------------------------------------------------ probe 1, live (no final file)

test('probe 1 live: run facts are registered or inferred, status is "running" (no-final-file)', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  assert.equal(run.id, 'wf_6509ce25-20a');
  assert.equal(run.source, 'real');
  assert.equal(run.sessionId, '331703e5-9ca1-4323-b4b8-fccdb8917c4e');
  assert.match(run.project, /^-Volumes-MacMiniExt/);
  assert.deepEqual(run.status, { value: 'running', prov: 'inferred', method: 'no-final-file' });
  assert.equal(run.name.value, 'probe-event-format');
  assert.equal(run.name.prov, 'registered');
  assert.match(run.name.from, /test-wf_6509ce25-20a\.js#meta\.name$/);
  assert.equal(run.description.prov, 'registered');
  assert.match(run.description.value, /^Tiny probe: 2 parallel agents/);
  assert.deepEqual(run.declaredPhases, [{ title: 'Fanout', detail: 'two independent reviewers' }, { title: 'Judge' }, { title: 'Loop' }]);
  // no final file: the earliest agent start (the first transcript record of agent A), not the script file time (1794126711250)
  assert.deepEqual(run.startedAt, { value: 1794126711300, prov: 'inferred', method: 'earliest-agent-start' });
  assert.equal(run.endedAt.prov, 'unknown');
  assert.equal(run.endedAt.reason, 'run has not ended');
  assert.equal(run.durationMs.prov, 'unknown');
  assert.equal(run.ccVersion.prov, 'unknown');
  checkFacts(run);
});

test('probe 1 live: logs are unknown while running, registeredEdges is always unknown and empty', () => {
  const run = reduceRun(probe1().live, { now: () => 1794126725000 });
  assert.deepEqual(run.logs, { value: null, prov: 'unknown', reason: 'log() lines are written only at the end' });
  assert.deepEqual(run.registeredEdges, { value: [], prov: 'unknown', reason: 'no source registers dependencies' });
  assert.ok(run.unknowns.some((u) => u.field === 'logs' && u.reason === 'log() lines are written only at the end'));
  assert.ok(run.unknowns.some((u) => u.field === 'registeredEdges'));
});

test('probe 1 live: agent states come from the journal (registered, with the journal line)', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  assert.equal(run.totals.agents, 5);
  const a = run.agents[p.ids.A];
  assert.deepEqual([a.state.value, a.state.prov], ['done', 'registered']);
  assert.match(a.state.from, /wf_6509ce25-20a\/journal\.jsonl:4$/, 'done comes from the result line');
  assert.match(a.label.from, /journal\.jsonl:2$/, 'label comes from the started line');
  assert.deepEqual([a.label.value, a.label.prov], ['reviewer:A', 'registered']);
  assert.deepEqual([a.phase.value, a.phase.prov], ['Fanout', 'registered']);
  assert.match(a.agentType.from, /agent-acc4223d928e12071\.meta\.json#agentType$/, 'meta file names the agent, its data does not');
  assert.equal(a.agentType.value, 'workflow-subagent');
  assert.deepEqual([a.result.value, a.result.prov], [P1.resultA, 'registered']);
  assert.match(a.result.from, fileLine);
  assert.equal(a.prompt.prov, 'registered');
  assert.ok(a.prompt.value.startsWith(FRAME), 'the registered prompt is the full framed text, not a preview');
  assert.equal(a.model.value, 'claude-haiku-5-5');
  assert.equal(a.model.prov, 'registered');
  for (const id of run.order) assert.equal(run.agents[id].state.prov, 'registered');
  // P2: totals also carry usage and byModel (own tests below); this line is about the counts, so they are left out like tokens and toolCalls
  assert.deepEqual({ ...run.totals, tokens: undefined, toolCalls: undefined, usage: undefined, byModel: undefined },
    { agents: 5, running: 0, interrupted: 0, done: 5, failed: 0, tokens: undefined, toolCalls: undefined, usage: undefined, byModel: undefined });
});

test('probe 1 live: order, phases and phase states are derived from the agents', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  assert.deepEqual(run.order, [p.ids.A, p.ids.B, p.ids.J, p.ids.F1, p.ids.F2]);
  assert.deepEqual(run.phases.map((x) => [x.title, x.index, x.agentIds.length, x.state.value]), [['Fanout', 1, 2, 'done'], ['Judge', 2, 1, 'done'], ['Loop', 3, 2, 'done']]);
  assert.deepEqual(run.phases[0].agentIds, [p.ids.A, p.ids.B]);
  for (const ph of run.phases) {
    assert.equal(ph.state.prov, 'inferred');
    assert.equal(ph.state.method, 'agent-states');
    assert.equal(ph.startedAt.prov, 'inferred');
    assert.equal(ph.endedAt.prov, 'inferred');
  }
  assert.ok(run.phases[0].endedAt.value <= run.phases[1].startedAt.value);
});

test('probe 1 live: role, unit, round and tag are inferred from the label (label-pattern)', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  const rv = run.agents[p.ids.A];
  assert.deepEqual([rv.role, rv.unit], [{ value: 'reviewer', prov: 'inferred', method: 'label-pattern' }, { value: 'A', prov: 'inferred', method: 'label-pattern' }]);
  assert.equal(rv.round.prov, 'unknown');
  assert.match(rv.round.reason, /no round suffix/);
  assert.equal(rv.tag.prov, 'unknown');
  assert.match(rv.tag.reason, /no "#tag" suffix/);
  const j = run.agents[p.ids.J];
  assert.deepEqual(j.role, { value: 'judge', prov: 'inferred', method: 'label-pattern' });
  assert.equal(j.unit.prov, 'unknown');
  assert.match(j.unit.reason, /no ":unit" part/);
  const f2 = run.agents[p.ids.F2];
  assert.deepEqual(f2.role, { value: 'fixer', prov: 'inferred', method: 'label-pattern' });
  assert.deepEqual(f2.round, { value: 2, prov: 'inferred', method: 'label-pattern' });
  assert.equal(f2.unit.prov, 'unknown');
});

test('probe 1 live: recognised verdicts carry agentId and the journal line they came from', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  assert.deepEqual(run.recognized.verdicts.map((v) => [v.agentId, v.verdict, v.reason?.slice(0, 9)]), [
    [p.ids.A, 'pass', 'A saw x=1'],
    [p.ids.B, 'fail', 'B saw x=2'],
    [p.ids.J, 'fail', 'Reviews d'],
  ]);
  assert.match(run.recognized.verdicts[0].from, /journal\.jsonl:4$/);
  assert.match(run.recognized.verdicts[1].from, /journal\.jsonl:5$/);
  assert.match(run.recognized.verdicts[2].from, /journal\.jsonl:7$/);
  assert.deepEqual(run.recognized.findings, []);
  assert.deepEqual(run.recognized.tests, []);
});

test('probe 1 live: the results are shorter than 64 chars, so there is no data-flow edge into the judge (contract 2); a weak hint remains', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  assert.equal(run.edges.length, 1);
  const [e] = run.edges;
  assert.deepEqual([e.from, e.to, e.kind, e.strength, e.prov], [p.ids.B, p.ids.J, 'time-order', 'weak', 'inferred']);
  assert.match(e.evidence, /^"judge" started 1361 ms after "reviewer:B" ended, in a later phase \(Fanout -> Judge\)$/);
});

test('probe 1 live: tool calls and tokens are inferred from the transcript, approximate and labelled so', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  const a = run.agents[p.ids.A];
  assert.deepEqual(a.toolCalls, { value: 1, prov: 'inferred', method: 'count-of-tool-activity-events' });
  assert.deepEqual(a.tokens, { value: 2 + 56201 + 0 + 152, prov: 'inferred', method: 'latest-transcript-usage' });
  assert.deepEqual(run.agents[p.ids.B].tokens, { value: 56459, prov: 'inferred', method: 'latest-transcript-usage' },
    'input 2 + cache creation 17134 + cache read 39067 + output 256: the cache-read counter is the largest term');
  assert.equal(run.agents[p.ids.J].tokens.value, 2 + 17182 + 39067 + 234);
  assert.equal(run.totals.tokens.value, 56355 + 56459 + 56485 + 56049 + 56049);
  assert.equal(run.agents[p.ids.F1].toolCalls.value, 0, 'a text-only transcript counts zero tool calls');
  assert.equal(run.totals.toolCalls.value, 3);
  assert.equal(run.totals.toolCalls.prov, 'inferred');
  assert.match(run.totals.tokens.method, /^sum-of-agent-tokens \(5 of 5 agents\)$/);
  assert.deepEqual(a.lastActivity.value, { ts: T('2026-11-08T08:31:53.141Z'), tool: 'StructuredOutput', inputSummary: JSON.stringify(P1.resultA) });
  assert.equal(a.lastActivity.prov, 'registered');
  assert.deepEqual(a.activity, [a.lastActivity.value]);
});

test('probe 1 live: agent times come from transcript records (inferred), not from the journal', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126725000 });
  const a = run.agents[p.ids.A];
  assert.deepEqual(a.startedAt, { value: T('2026-11-08T08:31:51.300Z'), prov: 'inferred', method: 'first-transcript-record' });
  assert.deepEqual(a.endedAt, { value: T('2026-11-08T08:31:53.143Z'), prov: 'inferred', method: 'last-transcript-record' });
  assert.deepEqual(a.durationMs, { value: 1843, prov: 'inferred', method: 'endedAt-startedAt' });
});

// ------------------------------------------------------------------ probe 1, snapshots during the run

test('probe 1 mid-run: both reviewers running (registered), no result, no end, judge phase pending', () => {
  const p = probe1();
  const events = upTo(p.live, T('2026-11-08T08:31:52.600Z'));
  const run = reduceRun(events, { now: () => T('2026-11-08T08:31:53.000Z') });
  assert.deepEqual(run.status, { value: 'running', prov: 'inferred', method: 'no-final-file' });
  assert.deepEqual(run.order, [p.ids.A, p.ids.B]);
  for (const id of [p.ids.A, p.ids.B]) {
    const a = run.agents[id];
    assert.deepEqual([a.state.value, a.state.prov], ['running', 'registered']);
    assert.match(a.state.from, /journal\.jsonl:[23]$/, 'running comes from the started line');
    assert.deepEqual(a.result, { value: null, prov: 'unknown', reason: 'agent has not produced a result yet' });
    assert.equal(a.endedAt.prov, 'unknown');
    assert.equal(a.endedAt.reason, 'agent is still running');
    assert.equal(a.durationMs.prov, 'unknown');
  }
  assert.deepEqual({ agents: run.totals.agents, running: run.totals.running, done: run.totals.done }, { agents: 2, running: 2, done: 0 });
  assert.deepEqual(run.phases.map((x) => [x.title, x.state.value, x.state.prov]), [['Fanout', 'running', 'inferred'], ['Judge', 'pending', 'inferred'], ['Loop', 'pending', 'inferred']]);
  assert.equal(run.phases[1].state.method, 'no-agents-yet');
  assert.deepEqual(run.edges, []);
  assert.deepEqual(run.recognized, { findings: [], verdicts: [], tests: [] });
  checkFacts(run);
});

test('probe 1 mid-run: one reviewer done, the other still running, a verdict already recognised', () => {
  const p = probe1();
  const run = reduceRun(upTo(p.live, 1794126713300), { now: () => 1794126713400 });
  assert.equal(run.agents[p.ids.A].state.value, 'done');
  assert.equal(run.agents[p.ids.B].state.value, 'running');
  assert.equal(run.phases[0].state.value, 'running');
  assert.equal(run.phases[0].endedAt.prov, 'unknown');
  assert.deepEqual(run.recognized.verdicts.map((v) => v.agentId), [p.ids.A]);
  assert.deepEqual(run.totals, { ...run.totals, agents: 2, running: 1, done: 1, failed: 0 });
});

test('events can arrive in any order across files; the journal line order is what matters', () => {
  const p = probe1();
  const forward = reduceRun(p.live, { now: () => 1794126725000 });
  const shuffled = reduceRun([...p.live].reverse(), { now: () => 1794126725000 });
  // journal lines keep their own order, so agent states, labels, edges and verdicts agree
  for (const id of forward.order) {
    assert.deepEqual(shuffled.agents[id].state, forward.agents[id].state);
    assert.deepEqual(shuffled.agents[id].label, forward.agents[id].label);
    assert.deepEqual(shuffled.agents[id].result, forward.agents[id].result);
  }
  assert.deepEqual(shuffled.order, forward.order);
  assert.deepEqual(shuffled.edges, forward.edges);
  assert.deepEqual(shuffled.recognized.verdicts.map((v) => v.agentId), forward.recognized.verdicts.map((v) => v.agentId));
});

// ------------------------------------------------------------------ probe 1, completed (final file)

test('probe 1 with the final file: status and measured values are final, descriptive ones stay registered', () => {
  const p = probe1();
  const run = reduceRun(p.withFinal, { now: () => 1794126730000 });
  assert.equal(run.status.value, 'completed');
  assert.equal(run.status.prov, 'final');
  assert.match(run.status.from, /workflows\/wf_6509ce25-20a\.json#status$/);
  assert.deepEqual([run.startedAt.value, run.startedAt.prov], [1794126711269, 'final']);
  assert.deepEqual([run.endedAt.value, run.endedAt.prov], [T('2026-11-08T08:32:04.683Z'), 'final']);
  assert.deepEqual([run.durationMs.value, run.durationMs.prov], [13408, 'final']);
  assert.deepEqual(run.logs.value, ['probe: starting fanout', 'probe: loop round 1', 'probe: loop round 2']);
  assert.equal(run.logs.prov, 'final');
  assert.match(run.logs.from, /wf_6509ce25-20a\.json#logs$/);
  assert.equal(run.name.prov, 'registered', 'script meta is read first; the final file only fills gaps');
  assert.deepEqual([run.totals.tokens.value, run.totals.tokens.prov], [280755, 'final']);
  assert.deepEqual([run.totals.toolCalls.value, run.totals.toolCalls.prov], [3, 'final']);
  assert.equal(run.error.prov, 'unknown');
  assert.equal(run.unknowns.some((u) => u.field === 'error'), false, 'no error expected on a completed run');
  assert.equal(run.unknowns.some((u) => u.field === 'logs'), false);
  checkFacts(run);
});

test('probe 1 with the final file: agent state, times, tokens, tool calls and model are final', () => {
  const p = probe1();
  const run = reduceRun(p.withFinal, { now: () => 1794126730000 });
  const a = run.agents[p.ids.A];
  assert.equal(a.state.prov, 'final');
  assert.equal(a.state.value, 'done');
  assert.match(a.state.from, /wf_6509ce25-20a\.json#workflowProgress\[3\]\.state$/);
  assert.deepEqual([a.startedAt.value, a.startedAt.prov], [1794126711299, 'final']);
  assert.deepEqual([a.durationMs.value, a.durationMs.prov], [1882, 'final']);
  assert.deepEqual(a.endedAt, { value: 1794126711299 + 1882, prov: 'inferred', method: 'final-startedAt+durationMs' });
  assert.deepEqual([a.tokens.value, a.tokens.prov], [56206, 'final']);
  assert.deepEqual([a.toolCalls.value, a.toolCalls.prov], [1, 'final']);
  assert.deepEqual([a.model.value, a.model.prov], ['claude-haiku-5-5', 'final']);
  assert.equal(a.label.prov, 'registered');
  assert.equal(a.prompt.prov, 'registered', 'the registered full prompt beats the final preview');
  assert.equal(a.result.prov, 'registered');
  assert.equal(run.totals.done, 5);
  assert.equal(run.phases.every((x) => x.state.value === 'done'), true);
});

test('contract 2: the final file alone (no journal, no transcripts) creates no agent; its run-level facts are final and a warning says what it lists', () => {
  const p = probe1();
  const run = reduceRun([p.e.final], { now: () => 1794126730000 });
  assert.equal(run.totals.agents, 0, 'the journal decides which agents exist');
  assert.deepEqual(run.order, []);
  assert.deepEqual(run.agents, {});
  const listed = p.e.final.data.workflowProgress.filter((x) => x.type === 'workflow_agent').map((x) => x.agentId);
  assert.equal(listed.length, 5);
  assert.deepEqual(run.warnings.filter((w) => /final file lists/.test(w)),
    [`final file lists 5 agents (${listed.slice(0, 3).join(', ')}, ...) that no journal line, agent meta or transcript knows; the journal decides which agents exist, so they are not shown`]);
  assert.equal(run.name.prov, 'final');
  assert.equal(run.name.value, 'probe-event-format');
  assert.deepEqual(run.declaredPhases.map((x) => x.title), ['Fanout', 'Judge', 'Loop']);
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
  assert.deepEqual([run.totals.tokens.value, run.totals.tokens.prov], [280755, 'final']);
  assert.deepEqual(run.phases.map((x) => [x.title, x.agentIds.length, x.state.prov]), [['Fanout', 0, 'unknown'], ['Judge', 0, 'unknown'], ['Loop', 0, 'unknown']]);
  assert.deepEqual(run.edges, []);
  checkFacts(run, 10);
});

test('contract 2: the final file fills what the journal does not say about an agent it knows: label, phase, previews, last activity, state', () => {
  const p = probe1();
  // an older-style journal: "started" lines without label or phase, no transcripts, no results
  const started = [p.ids.A, p.ids.B, p.ids.J, p.ids.F1, p.ids.F2].map((id, i) => p.b.started(2 + i, 1794126711300 + i, id));
  const run = reduceRun([p.e.launched, ...started, p.e.final], { now: () => 1794126730000 });
  assert.equal(run.totals.agents, 5);
  assert.deepEqual(run.order, [p.ids.A, p.ids.B, p.ids.J, p.ids.F1, p.ids.F2]);
  const a = run.agents[p.ids.A];
  assert.deepEqual([a.label.value, a.label.prov], ['reviewer:A', 'final']);
  assert.deepEqual([a.phase.value, a.phase.prov], ['Fanout', 'final']);
  assert.equal(a.state.prov, 'final');
  assert.deepEqual([a.prompt.prov, a.prompt.value], ['final', 'Reply with verdict "pass" and note "A saw x=1". Do not use any tools.']);
  assert.match(a.prompt.from, /#workflowProgress\[3\]\.promptPreview$/);
  assert.deepEqual([a.result.prov, a.result.value], ['final', '{"verdict":"pass","note":"A saw x=1"}']);
  assert.equal(a.agentType.prov, 'unknown');
  assert.deepEqual([a.lastActivity.prov, a.lastActivity.value], ['final', { ts: 1794126713182, tool: 'StructuredOutput', inputSummary: 'pass' }]);
  // R1: the final file's run result is recognised too (scope run); agent previews still are not
  assert.deepEqual(run.recognized.verdicts.filter((v) => v.scope !== 'run'), [], 'previews are strings; only registered result objects are recognised');
  assert.equal(run.edges.length, 0, 'the judge prompt preview holds both reviewer result previews, but each has 37 chars: no edge');
  assert.equal(run.warnings.some((w) => /final file lists/.test(w)), false, 'every listed agent is in the journal');
  checkFacts(run);
});

test('contract 2: agents only the final file lists are not created, however many; the ones the journal knows are untouched', () => {
  const b = builder({ runId: 'wf_00000317-fin' });
  const run = reduceRun([
    b.launched(1, 100),
    b.final({
      status: 'completed',
      workflowProgress: [
        { type: 'workflow_agent', agentId: 'not-in-journal', state: 'done' },
        { type: 'workflow_agent', agentId: 'also-not', state: 'error' },
        { type: 'workflow_agent', agentId: 'third', state: 'done' },
        { type: 'workflow_agent', agentId: 'fourth', state: 'done' },
      ],
    }, 5000),
  ], { now: () => 6000 });
  assert.deepEqual(run.order, []);
  assert.equal('not-in-journal' in run.agents, false);
  assert.equal(run.totals.agents, 0);
  assert.equal(run.totals.done, 0);
  assert.equal(run.totals.failed, 0);
  assert.ok(run.warnings.includes('final file lists 4 agents (not-in-journal, also-not, third, ...) that no journal line, agent meta or transcript knows; the journal decides which agents exist, so they are not shown'));
  const one = reduceRun([b.launched(1, 100), b.final({ status: 'completed', workflowProgress: [{ type: 'workflow_agent', agentId: 'not-in-journal', state: 'done' }] }, 5000)], { now: () => 6000 });
  assert.deepEqual(one.order, []);
  assert.ok(one.warnings.includes('final file lists 1 agent (not-in-journal) that no journal line, agent meta or transcript knows; the journal decides which agents exist, so they are not shown'));
});

// ------------------------------------------------------------------ staleness

test('no file activity for staleMs: status becomes unknown with a reason (inject now())', () => {
  const p = probe1();
  const mid = upTo(p.live, T('2026-11-08T08:31:52.600Z'));
  const last = Math.max(...mid.map((e) => e.ts));
  const staleMs = 30 * 60e3;
  const fresh = reduceRun(mid, { now: () => last + staleMs });
  assert.equal(fresh.status.value, 'running', 'exactly staleMs of silence is not yet stale');
  const stale = reduceRun(mid, { now: () => last + staleMs + 1 });
  assert.equal(stale.status.prov, 'unknown');
  assert.equal(stale.status.value, null);
  assert.match(stale.status.reason, /no file activity for 30 min \(limit 30 min\) and no final run file/);
  assert.ok(stale.unknowns.some((u) => u.field === 'status'));
  // the agents that were running can no longer be called running
  for (const id of [p.ids.A, p.ids.B]) {
    assert.equal(stale.agents[id].state.prov, 'unknown');
    assert.match(stale.agents[id].state.reason, /started but no result, and no file activity for/);
  }
  assert.equal(stale.totals.running, 0);
  checkFacts(stale);
});

test('staleMs is configurable and the default is 30 minutes', () => {
  const mid = upTo(probe1().live, T('2026-11-08T08:31:52.600Z'));
  const last = Math.max(...mid.map((e) => e.ts));
  assert.equal(reduceRun(mid, { now: () => last + 10 * 60e3 }).status.value, 'running');
  assert.equal(reduceRun(mid, { now: () => last + 10 * 60e3, staleMs: 5 * 60e3 }).status.prov, 'unknown');
  assert.equal(reduceRun(mid, { now: () => last + 31 * 60e3 }).status.prov, 'unknown');
});

test('a stale run keeps the states it can still prove: finished agents stay done', () => {
  const p = probe1();
  const run = reduceRun(p.live, { now: () => 1794126723290 + 31 * 60e3 });
  assert.equal(run.status.prov, 'unknown');
  assert.equal(run.agents[p.ids.A].state.value, 'done');
  assert.equal(run.agents[p.ids.A].state.prov, 'registered');
});

test('a final file ends staleness: the status is final however long ago it was written', () => {
  const run = reduceRun(probe1().withFinal, { now: () => 1794126724683 + 10 * 24 * 3600e3 });
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
});

test('reduceRun is deterministic for the same events and the same now()', () => {
  const p = probe2();
  const a = JSON.stringify(reduceRun(p.live, { now: () => 1794127740000 }));
  const b = JSON.stringify(reduceRun(p.live, { now: () => 1794127740000 }));
  assert.equal(a, b);
});

test('script only, no journal yet: status is unknown, not running', () => {
  const p = probe1();
  const run = reduceRun([p.e.script], { now: () => 1794126711300 });
  assert.equal(run.status.prov, 'unknown');
  assert.match(run.status.reason, /no journal line and no final run file/);
  assert.equal(run.totals.agents, 0);
  assert.equal(run.name.value, 'probe-event-format');
});

test('launched line only: running (inferred), no agents', () => {
  const p = probe1();
  const run = reduceRun([p.e.script, p.e.launched], { now: () => 1794126711400 });
  assert.deepEqual(run.status, { value: 'running', prov: 'inferred', method: 'no-final-file' });
  assert.deepEqual(run.phases.map((x) => [x.title, x.state.value]), [['Fanout', 'pending'], ['Judge', 'pending'], ['Loop', 'pending']]);
});

// ------------------------------------------------------------------ probe 2: overlap and a failed run

test('probe 2 live: pipeline overlap is visible: stage2:gamma runs/finishes while stage1:alpha is still running', () => {
  const p = probe2();
  const run = reduceRun(upTo(p.live, 1794127727630), { now: () => 1794127727700 });
  assert.equal(by(run, 'stage1:alpha').state.value, 'running');
  assert.equal(by(run, 'stage2:gamma').state.value, 'done');
  assert.equal(by(run, 'stage2:gamma').state.prov, 'registered');
  assert.equal(by(run, 'stage1:beta').state.value, 'done');
  assert.deepEqual(run.totals, { ...run.totals, agents: 4, running: 1, done: 3 });
  assert.deepEqual(run.order.map((id) => run.agents[id].label.value), ['stage1:alpha', 'stage1:beta', 'stage1:gamma', 'stage2:gamma']);
  const a = by(run, 'stage1:alpha');
  assert.equal(a.toolCalls.value, 2, 'both Bash calls counted while the agent runs');
  assert.equal(a.lastActivity.value.tool, 'Bash');
  assert.equal(a.lastActivity.value.inputSummary, 'sleep 3; echo alpha-2');
  assert.deepEqual(a.activity.map((x) => x.inputSummary), ['sleep 3; echo alpha-1', 'sleep 3; echo alpha-2']);
  assert.equal(run.phases[0].state.value, 'running');
  assert.equal(run.phases[1].state.value, 'pending');
  checkFacts(run);
});

test('probe 2 live: agents without a transcript yet have unknown fields with reasons, not guesses', () => {
  const p = probe2();
  const run = reduceRun(upTo(p.live, 1794127727630), { now: () => 1794127727700 });
  const beta = by(run, 'stage1:beta');
  assert.equal(beta.tokens.prov, 'unknown');
  assert.match(beta.tokens.reason, /no usage in the transcript seen/);
  assert.equal(beta.toolCalls.prov, 'unknown');
  assert.equal(beta.prompt.prov, 'unknown');
  assert.equal(beta.model.prov, 'unknown');
  assert.deepEqual(beta.startedAt, { value: 1794127721750, prov: 'inferred', method: 'journal-event-ts' });
  assert.match(beta.durationMs.method, /coarse/);
  assert.equal(run.totals.tokens.prov, 'inferred');
  assert.match(run.totals.tokens.method, /\(2 of 4 agents\)/, 'a partial sum says how partial it is');
});

test('probe 2 failed run: status failed (final), error and logs final, every agent done (final)', () => {
  const p = probe2();
  const run = reduceRun(p.withFinal, { now: () => 1794127740000 });
  assert.deepEqual([run.status.value, run.status.prov], ['failed', 'final']);
  assert.equal(run.error.prov, 'final');
  assert.match(run.error.value, /^Error: probe2: deliberate script failure at the end/);
  assert.deepEqual([run.logs.prov, run.logs.value.length], ['final', 4]);
  assert.ok(run.logs.value.includes('pipeline[1] failed: probe: stage2 throws for beta'));
  assert.ok(run.logs.value.includes('parallel[1] failed: probe: thunk throws'));
  assert.equal(run.totals.agents, 6);
  assert.equal(run.totals.done, 6);
  for (const id of run.order) assert.deepEqual([run.agents[id].state.value, run.agents[id].state.prov], ['done', 'final']);
  assert.deepEqual([run.totals.tokens.value, run.totals.tokens.prov], [339417, 'final']);
  assert.equal(run.declaredPhases.length, 2);
  assert.equal(run.unknowns.some((u) => u.field === 'error'), false, 'the error is known');
  checkFacts(run);
});

function failedWithout(p, dropLabel, mutate) {
  const data = structuredClone(p.finalData);
  const drop = data.workflowProgress.find((x) => x.label === dropLabel);
  data.workflowProgress = data.workflowProgress.filter((x) => x !== drop);
  if (mutate) mutate(data);
  const dropId = drop.agentId;
  const events = p.live.filter((e) => !(e.kind === 'agent.result' && e.data.agentId === dropId));
  return { events: [...events, p.b.final(data, 1794127735595)], dropId };
}

test('failed run, agent started but never got a result and the final file does not list it: interrupted, no end time invented', () => {
  const p = probe2();
  const { events, dropId } = failedWithout(p, 'errors:ok');
  const run = reduceRun(events, { now: () => 1794127740000 });
  assert.equal(run.status.value, 'failed');
  const a = run.agents[dropId];
  assert.deepEqual([a.state.value, a.state.prov, a.state.interrupted], ['running', 'registered', true]);
  assert.match(a.state.from, /journal\.jsonl:12$/, 'the registered state is the journal "started" line');
  assert.equal(a.state.note, 'interrupted: the run failed while this agent was still running');
  assert.equal(a.endedAt.prov, 'unknown', 'no end time is invented');
  assert.match(a.endedAt.reason, /^interrupted: the run failed while this agent was still running; no end time is recorded$/);
  assert.equal(a.durationMs.prov, 'unknown');
  assert.equal(a.result.prov, 'unknown');
  assert.match(a.result.reason, /interrupted: the run failed .* before it produced a result/);
  assert.deepEqual({ agents: run.totals.agents, running: run.totals.running, interrupted: run.totals.interrupted, done: run.totals.done }, { agents: 6, running: 0, interrupted: 1, done: 5 });
  assert.deepEqual([run.phases[1].state.value, run.phases[1].state.prov, run.phases[1].state.method], ['interrupted', 'inferred', 'agent-states']);
  assert.equal(run.unknowns.some((u) => u.field === `agents.${dropId}.state`), false, 'the state is known: it was running when the run failed');
  assert.ok(run.unknowns.some((u) => u.field === `agents.${dropId}.endedAt`));
  checkFacts(run);
});

test('contract 2: the same agent in a run that completed is not "interrupted"; the final file says nothing about it, so it keeps its registered state', () => {
  const p = probe2();
  const { events, dropId } = failedWithout(p, 'errors:ok', (d) => { d.status = 'completed'; });
  const run = reduceRun(events, { now: () => 1794127740000 });
  const a = run.agents[dropId];
  assert.deepEqual([a.state.value, a.state.prov], ['running', 'registered']);
  assert.match(a.state.from, /journal\.jsonl:12$/, 'the journal "started" line');
  assert.equal(a.state.interrupted, undefined);
  assert.equal(a.state.note, undefined);
  assert.equal(a.endedAt.prov, 'unknown', 'no end time is invented');
  assert.equal(a.endedAt.reason, 'agent is still running');
  assert.equal(run.totals.interrupted, 0);
  assert.deepEqual({ agents: run.totals.agents, running: run.totals.running, done: run.totals.done }, { agents: 6, running: 1, done: 5 });
  assert.deepEqual([run.phases[1].state.value, run.phases[1].state.prov, run.phases[1].state.method], ['running', 'inferred', 'agent-states']);
  assert.equal(run.unknowns.some((u) => u.field === `agents.${dropId}.state`), false, 'the state is known');
  checkFacts(run);
});

test('contract 2: an agent the final file does not list keeps its registered running state whatever the run status says (other text, none)', () => {
  const b = builder({ runId: 'wf_00000317-abs' });
  for (const [status, expectInterrupted] of [['completed', false], ['stopped', false], [undefined, false], ['killed', true], ['failed', true]]) {
    const final = status === undefined ? { workflowProgress: [] } : { status, workflowProgress: [] };
    const run = reduceRun([b.launched(1, 100), b.started(2, 200, 'a', 'agent:a', 'P'), b.final(final, 5000)], { now: () => 6000 });
    const s = run.agents.a.state;
    assert.deepEqual([s.value, s.prov, s.interrupted === true], ['running', 'registered', expectInterrupted], `status ${status}`);
    assert.match(s.from, /journal\.jsonl:2$/);
    assert.equal(run.totals.agents, 1);
  }
  // the exact input of the finding: agent.started only, then a completed final file with no agents
  const run = reduceRun([b.ev('agent.started', { agentId: 'a' }, 200, b.files.journal, 1), b.final({ status: 'completed', workflowProgress: [] }, 5000)], { now: () => 6000 });
  assert.deepEqual([run.agents.a.state.value, run.agents.a.state.prov], ['running', 'registered']);
});

test('final file calling an agent "running" in a run that ended failed: interrupted; in a completed run it is not believed', () => {
  const p = probe2();
  const mk = (status, state) => {
    const data = structuredClone(p.finalData);
    data.status = status;
    data.workflowProgress.find((x) => x.label === 'errors:ok').state = state;
    return reduceRun([...p.live.filter((e) => !(e.kind === 'agent.result' && e.data.agentId === p.ids.ok)), p.b.final(data, 1794127735595)], { now: () => 1794127740000 });
  };
  const failed = mk('failed', 'running');
  const a = by(failed, 'errors:ok');
  assert.deepEqual([a.state.value, a.state.prov, a.state.raw, a.state.interrupted], ['running', 'final', 'running', true]);
  assert.match(a.state.from, /wf_26eb8d70-5c4\.json#workflowProgress\[\d+\]\.state$/);
  assert.equal(a.endedAt.prov, 'unknown');
  const done = mk('completed', 'running');
  const b = by(done, 'errors:ok');
  assert.equal(b.state.prov, 'unknown');
  assert.equal(b.state.raw, 'running', 'the source value is kept');
  assert.match(b.state.reason, /final file lists this agent as "running" although the run ended \(completed\)/);
  const queued = mk('failed', 'queued');
  assert.deepEqual([by(queued, 'errors:ok').state.value, by(queued, 'errors:ok').state.interrupted], ['queued', undefined], 'queued: it never started, nothing was interrupted');
  checkFacts(failed);
  checkFacts(done);
});

test('final state overrides the journal: journal says done, final says failed', () => {
  const p = probe2();
  const data = structuredClone(p.finalData);
  data.workflowProgress.find((x) => x.label === 'stage1:beta').state = 'failed';
  const run = reduceRun([...p.live, p.b.final(data, 1794127735595)], { now: () => 1794127740000 });
  const a = by(run, 'stage1:beta');
  assert.deepEqual([a.state.value, a.state.prov], ['failed', 'final']);
  assert.equal(a.result.prov, 'registered', 'the journal result is still shown');
  assert.deepEqual({ failed: run.totals.failed, done: run.totals.done }, { failed: 1, done: 5 });
  assert.equal(run.phases[0].state.value, 'failed');
});

test('an unrecognised final state becomes unknown with the raw value kept; an unrecognised run status is kept as it is (final)', () => {
  const p = probe2();
  const data = structuredClone(p.finalData);
  data.status = 'exploded';
  data.workflowProgress.find((x) => x.label === 'stage1:beta').state = 'weird';
  const run = reduceRun([...p.live, p.b.final(data, 1794127735595)], { now: () => 1794127740000 });
  assert.deepEqual([run.status.value, run.status.prov], ['exploded', 'final'], 'contract 2: any final status string passes through');
  assert.match(run.status.from, /wf_26eb8d70-5c4\.json#status$/);
  const a = by(run, 'stage1:beta');
  assert.equal(a.state.prov, 'unknown');
  assert.equal(a.state.raw, 'weird');
  assert.match(a.state.reason, /"weird"/);
  assert.equal(run.unknowns.some((u) => u.field === 'status'), false);
  checkFacts(run);
});

test('final status: running | completed | failed | killed are final facts, so is any other text ("stopped" is just one); a missing or non-text status is unknown', () => {
  const p = probe2();
  const status = (v, del = false) => {
    const data = structuredClone(p.finalData);
    if (del) delete data.status; else data.status = v;
    return reduceRun([...p.live, p.b.final(data, 1)], { now: () => 1 }).status;
  };
  for (const v of ['running', 'completed', 'failed', 'killed', 'stopped', 'cancelled', 'Killed']) {
    const f = status(v);
    assert.deepEqual([f.value, f.prov], [v, 'final'], v);
    assert.match(f.from, /wf_26eb8d70-5c4\.json#status$/);
  }
  const none = status(undefined, true);
  assert.equal(none.prov, 'unknown');
  assert.match(none.reason, /no status field/);
  for (const bad of [null, 5, { a: 1 }, '']) {
    const f = status(bad);
    assert.equal(f.prov, 'unknown', String(bad));
    assert.equal(f.value, null);
    assert.ok(f.reason.length > 0);
  }
});

// ------------------------------------------------------------------ legacy 2.1.206: no label/phase until the end

test('legacy live: labels and phases are unknown (with a reason) until the final file appears', () => {
  const p = legacy();
  const run = reduceRun(p.live, { now: () => 1783754110000 });
  assert.equal(run.totals.agents, 3);
  for (const id of run.order) {
    const a = run.agents[id];
    for (const f of ['label', 'phase']) {
      assert.equal(a[f].prov, 'unknown', `${f} of ${id}`);
      assert.equal(a[f].value, null);
      assert.match(a[f].reason, /older Claude Code/);
    }
    for (const f of ['role', 'unit', 'round']) {
      assert.equal(a[f].prov, 'unknown');
      assert.match(a[f].reason, /label is unknown/);
    }
    assert.equal(a.state.prov, 'registered');
    assert.equal(a.agentType.value, 'general-purpose');
    assert.equal(a.agentType.prov, 'registered');
  }
  assert.deepEqual(run.order, [p.ids.a1, p.ids.a2, p.ids.a3]);
  assert.ok(run.unknowns.some((u) => u.field === `agents.${p.ids.a1}.label`));
  assert.deepEqual(run.phases.map((x) => [x.title, x.agentIds.length, x.state.value, x.state.prov]), [['Sweep', 0, null, 'unknown'], ['Synthesize', 0, null, 'unknown']],
    'declared phases are known (script meta), but the three agents cannot be placed in them: "pending" would be a guess');
  for (const ph of run.phases) assert.match(ph.state.reason, /^3 agents with an unknown phase exist, so it cannot be told whether this phase has started$/);
  assert.ok(run.unknowns.some((u) => u.field === 'phases[Sweep].state'));
  assert.equal(run.name.value, 'legacy-demo');
  assert.deepEqual(run.status, { value: 'running', prov: 'inferred', method: 'no-final-file' });
  assert.deepEqual(run.registeredEdges.value, []);
  checkFacts(run);
});

test('legacy live: what the transcript gives is used: model, tokens, results, recognised nothing', () => {
  const p = legacy();
  const run = reduceRun(p.live, { now: () => 1783754110000 });
  const a = run.agents[p.ids.a1];
  assert.deepEqual([a.model.value, a.model.prov], ['claude-opus-4-8', 'registered']);
  assert.deepEqual([a.tokens.value, a.tokens.prov, a.tokens.method], [1200, 'inferred', 'latest-transcript-usage']);
  assert.deepEqual(a.result.value, L.r1);
  assert.equal(run.agents[p.ids.a3].result.value, L.r3);
  assert.deepEqual(run.recognized, { findings: [], verdicts: [], tests: [] }, '{angle, summary} matches no recognised field name');
});

test('legacy with the final file: labels and phases arrive as final, role/unit stay inferred, phases fill', () => {
  const p = legacy();
  const run = reduceRun(p.withFinal, { now: () => 1783754110000 });
  const a = run.agents[p.ids.a1];
  assert.deepEqual([a.label.value, a.label.prov], ['find:alpha', 'final']);
  assert.match(a.label.from, /wf_00000206-leg\.json#workflowProgress\[2\]\.label$/);
  assert.deepEqual([a.phase.value, a.phase.prov], ['Sweep', 'final']);
  assert.deepEqual(a.role, { value: 'find', prov: 'inferred', method: 'label-pattern' });
  assert.deepEqual(a.unit, { value: 'alpha', prov: 'inferred', method: 'label-pattern' });
  const s = run.agents[p.ids.a3];
  assert.deepEqual([s.label.value, s.label.prov, s.role.value, s.unit.prov], ['synthesis', 'final', 'synthesis', 'unknown']);
  assert.deepEqual(run.phases.map((x) => [x.title, x.agentIds.length, x.state.value]), [['Sweep', 2, 'done'], ['Synthesize', 1, 'done']]);
  assert.deepEqual([run.status.value, run.status.prov], ['completed', 'final']);
  assert.deepEqual([run.totals.tokens.value, run.totals.tokens.prov], [3600, 'final']);
  assert.deepEqual([run.agents[p.ids.a2].durationMs.value, run.agents[p.ids.a2].durationMs.prov], [55000, 'final']);
  assert.equal(run.unknowns.some((u) => /\.label$/.test(u.field)), false);
  checkFacts(run);
});

test('legacy: labels and phases come from the final file for the agents the journal knows; the final file alone creates none', () => {
  const p = legacy();
  const journalOnly = p.live.filter((e) => e.kind === 'agent.started');
  const run = reduceRun([...journalOnly, p.e.final], { now: () => 1783754110000 });
  assert.deepEqual(run.order.map((id) => run.agents[id].label.value), ['find:alpha', 'find:beta', 'synthesis']);
  assert.equal(run.agents[p.ids.a1].label.prov, 'final');
  assert.equal(run.agents[p.ids.a1].state.prov, 'final');
  const alone = reduceRun([p.e.final], { now: () => 1783754110000 });
  assert.deepEqual(alone.order, []);
  assert.deepEqual(alone.phases.map((x) => x.title), ['Sweep', 'Synthesize']);
  assert.deepEqual([alone.status.value, alone.status.prov], ['completed', 'final']);
});

// ------------------------------------------------------------------ robustness and bookkeeping

test('duplicate events (same file and line re-emitted by a rescan) change nothing', () => {
  const p = probe1();
  const once = reduceRun(p.live, { now: () => 1794126725000 });
  const twice = reduceRun([...p.live, ...p.live], { now: () => 1794126725000 });
  assert.deepEqual(twice, once);
});

test('two activity events of one transcript line but different content are both kept', () => {
  const p = probe1();
  const extra = p.b.activity(p.ids.F1, { tool: 'Bash', inputSummary: 'ls' }, 1794126720000, 2);
  const run = reduceRun([...p.live, extra], { now: () => 1794126725000 });
  assert.equal(run.agents[p.ids.F1].activity.length, 2);
});

test('agent activity is limited to the last 50 entries', () => {
  const p = probe2();
  const many = [];
  for (let i = 0; i < 80; i++) many.push(p.b.activity(p.ids.a1, { tool: 'Bash', inputSummary: `cmd ${i}` }, 1794127722000 + i, 100 + i));
  const run = reduceRun([...p.live, ...many], { now: () => 1794127740000 });
  const a = run.agents[p.ids.a1];
  assert.equal(a.activity.length, 50);
  assert.equal(a.activity.at(-1).inputSummary, 'cmd 79');
  assert.equal(a.activity[0].inputSummary, 'cmd 30');
  assert.equal(a.toolCalls.value, 2 + 80, 'tool calls count every event, not only the last 50');
});

test('malformed events, unknown kinds and events of another run become warnings, never exceptions', () => {
  const p = probe1();
  const other = { ...p.e.launched, runId: 'wf_other' };
  const events = [null, 42, 'x', {}, { kind: 'run.launched' }, { kind: 'mystery', runId: P1.runId, data: {}, prov: {} }, other,
    { kind: 'agent.started', runId: P1.runId, data: {}, prov: {} }, { kind: 'agent.result', runId: P1.runId, data: null, prov: {} },
    { kind: 'agent.meta', runId: P1.runId, data: { description: 'x' }, prov: { file: '/no/agent/file.json' } },
    ...p.live];
  const run = reduceRun(events, { now: () => 1794126725000 });
  assert.equal(run.id, P1.runId);
  assert.equal(run.totals.agents, 5);
  assert.ok(run.warnings.some((w) => /malformed event/.test(w)));
  assert.ok(run.warnings.some((w) => /without runId/.test(w)));
  assert.ok(run.warnings.some((w) => /unknown event kind "mystery"/.test(w)));
  assert.ok(run.warnings.some((w) => /run wf_other/.test(w)));
  assert.ok(run.warnings.some((w) => /agent\.started without agentId/.test(w)));
  assert.ok(run.warnings.some((w) => /agent\.result without agentId/.test(w)));
  assert.ok(run.warnings.some((w) => /agent\.meta whose agent id/.test(w)));
  checkFacts(run);
});

test('source.warning events are carried into run.warnings with their file and line', () => {
  const p = probe1();
  const w = p.b.warning('unreadable line', 1794126712000, p.b.files.journal, 12);
  const run = reduceRun([...p.live, w], { now: () => 1794126725000 });
  assert.ok(run.warnings.some((x) => x.startsWith('unreadable line') && x.endsWith('journal.jsonl:12]')));
});

test('a script whose meta failed to parse is a warning; name then comes from the final file or stays unknown', () => {
  const p = probe1();
  const broken = { ...p.e.script, data: { ...p.e.script.data, meta: null } };
  const live = reduceRun([broken, ...p.live.filter((e) => e.kind !== 'run.script')], { now: () => 1794126725000 });
  assert.ok(live.warnings.some((w) => /script meta could not be parsed/.test(w)));
  assert.equal(live.name.prov, 'unknown');
  assert.deepEqual(live.declaredPhases.map((x) => x.title), [], 'no declared phases, but phases still follow from the agents');
  assert.deepEqual(live.phases.map((x) => x.title), ['Fanout', 'Judge', 'Loop']);
  const done = reduceRun([broken, ...p.withFinal.filter((e) => e.kind !== 'run.script')], { now: () => 1794126725000 });
  assert.deepEqual([done.name.value, done.name.prov], ['probe-event-format', 'final']);
  assert.deepEqual(done.declaredPhases.map((x) => x.title), ['Fanout', 'Judge', 'Loop']);
});

test('conflicting registered and final labels are reported, the registered label is kept', () => {
  const p = probe1();
  const data = structuredClone(p.e.final.data);
  data.workflowProgress.find((x) => x.agentId === p.ids.A).label = 'something else';
  const run = reduceRun([...p.live, { ...p.e.final, data }], { now: () => 1794126730000 });
  assert.equal(run.agents[p.ids.A].label.value, 'reviewer:A');
  assert.ok(run.warnings.some((w) => /label "reviewer:A" differs from the final file's "something else"/.test(w)));
});

test('demo events give source "demo"; mixing demo and real events in one run is flagged', () => {
  const p = probe1();
  const demo = p.live.map((e) => ({ ...e, src: 'demo', runId: 'demo-1' }));
  const run = reduceRun(demo, { now: () => 1794126725000 });
  assert.equal(run.source, 'demo');
  assert.equal(run.id, 'demo-1');
  const mixed = reduceRun([...p.live, { ...p.e.launched, src: 'demo', prov: { file: 'x', line: 99 } }], { now: () => 1794126725000 });
  assert.ok(mixed.warnings.some((w) => /several sources/.test(w)));
});

test('ccVersion is registered when a transcript event carries the version, otherwise unknown', () => {
  const p = probe1();
  const withVersion = p.live.map((e) => (e.kind === 'agent.prompt' ? { ...e, data: { ...e.data, version: '2.1.306' } } : e));
  const run = reduceRun(withVersion, { now: () => 1794126725000 });
  assert.deepEqual([run.ccVersion.value, run.ccVersion.prov], ['2.1.306', 'registered']);
  assert.match(run.ccVersion.from, /agent-.*\.jsonl:1#?/);
  assert.equal(reduceRun(p.live, { now: () => 1794126725000 }).ccVersion.prov, 'unknown');
  const fromMeta = p.live.map((e) => (e.kind === 'agent.meta' ? { ...e, data: { ...e.data, version: '9.9.9' } } : e));
  assert.equal(reduceRun(fromMeta, { now: () => 1794126725000 }).ccVersion.prov, 'unknown', 'a version field in a meta file is not the Claude Code version');
});

test('no events: an empty, honest run; no throw', () => {
  const run = reduceRun([], { now: () => 1 });
  assert.equal(run.id, null);
  assert.equal(run.status.prov, 'unknown');
  assert.deepEqual(run.order, []);
  assert.deepEqual(run.edges, []);
  assert.equal(run.totals.agents, 0);
  checkFacts(run, 8);
  assert.doesNotThrow(() => reduceRun(undefined));
});

test('recognised findings and tests from registered results reach run.recognized with their journal line', () => {
  const p = probe1();
  const rev = {
    findings: [{ file: 'src/sum.mjs', line: 3, input: 'sum([])', description: 'returns NaN', severity: 'high', category: 'logic' }],
  };
  const tst = { tests: { passed: 4, failed: 1, skipped: 0 } };
  const events = [
    ...p.live,
    p.b.started(12, 1794126724000, 'aaaa', 'review-a:X#r1', 'Review'),
    p.b.result(13, 1794126724500, 'aaaa', rev),
    p.b.started(14, 1794126724600, 'bbbb', 'test:X#r1', 'Test'),
    p.b.result(15, 1794126724700, 'bbbb', tst),
  ];
  const run = reduceRun(events, { now: () => 1794126725000 });
  assert.equal(run.recognized.findings.length, 1);
  const f = run.recognized.findings[0];
  assert.deepEqual([f.agentId, f.file, f.line, f.input, f.severity, f.path], ['aaaa', 'src/sum.mjs', 3, 'sum([])', 'high', '$.findings[0]']);
  assert.match(f.from, /journal\.jsonl:13$/);
  assert.deepEqual(run.recognized.tests.map((t) => [t.agentId, t.passed, t.failed, t.skipped, t.path]), [['bbbb', 4, 1, 0, '$.tests']]);
  assert.match(run.recognized.tests[0].from, /journal\.jsonl:15$/);
  assert.deepEqual(run.agents.aaaa.round, { value: 1, prov: 'inferred', method: 'label-pattern' });
  assert.deepEqual(run.agents.aaaa.unit, { value: 'X', prov: 'inferred', method: 'label-pattern' });
  assert.equal(run.agents.aaaa.role.value, 'review-a');
  assert.deepEqual(run.phases.map((x) => x.title), ['Fanout', 'Judge', 'Loop', 'Review', 'Test'], 'phases used by agents but not declared are appended');
});

test('the same results before the journal result is written are not recognised (no registered result yet)', () => {
  const p = probe1();
  const events = [...p.live, p.b.started(12, 1794126724000, 'aaaa', 'review-a:X#r1', 'Review'),
    p.b.structured('aaaa', { findings: [{ file: 'f', line: 1 }] }, 1794126724400, 3)];
  const run = reduceRun(events, { now: () => 1794126725000 });
  assert.deepEqual(run.recognized.findings, []);
  assert.equal(run.agents.aaaa.result.prov, 'unknown');
});

// ------------------------------------------------------------------ several leading user records per agent

test('probe 2 transcripts have two leading user records: both reach the prompt, in line order', () => {
  const p = probe2();
  const run = reduceRun(p.live, { now: () => 1794127740000 });
  const a = run.agents[p.ids.a2];
  assert.equal(a.prompt.prov, 'registered');
  assert.ok(a.prompt.value.startsWith(RELAY));
  assert.ok(a.prompt.value.endsWith('Reply with plain text "alpha stage2 done". No tools.'));
  assert.ok(a.prompt.value.includes('\n\n' + FRAME));
  assert.match(a.prompt.from, /agent-ab87f05075146a588\.jsonl:1$/);
});

test('data-flow still works when the computed task is the second leading user record', () => {
  const { b } = probe1();
  const result = 'The vendor price page lists alpha at 12 credits per unit, valid from March 2026 onwards.';
  const events = [
    b.launched(1, 1000),
    b.started(2, 1100, 'aA', 'rev:A', 'Fanout'),
    b.result(3, 1500, 'aA', result),
    b.started(4, 2000, 'aJ', 'judge', 'Judge'),
    ...b.prompts('aJ', [RELAY, framed(`Judge this review: ${result}`)], 2000),
    b.result(5, 2500, 'aJ', 'ok'),
  ];
  const run = reduceRun(events, { now: () => 3000 });
  assert.deepEqual(run.edges.map((e) => [e.from, e.to, e.kind]), [['aA', 'aJ', 'data-flow']]);
  assert.ok(run.agents.aJ.prompt.value.startsWith(RELAY), 'both leading records are in the prompt');
  const reversed = reduceRun([...events].reverse(), { now: () => 3000 });
  assert.equal(reversed.agents.aJ.prompt.value, run.agents.aJ.prompt.value, 'joined in line order whatever the arrival order');
  const twice = reduceRun([...events, ...events], { now: () => 3000 });
  assert.equal(twice.agents.aJ.prompt.value, run.agents.aJ.prompt.value, 're-emitted records are not appended twice');
});

// ------------------------------------------------------------------ shape, purity, scale

test('the Run is plain JSON: it survives a JSON round trip unchanged (no undefined, NaN or Infinity)', () => {
  const scenarios = [
    [probe1().live, 1794126725000], [probe1().withFinal, 1794126730000],
    [probe2().live, 1794127740000], [probe2().withFinal, 1794127740000],
    [legacy().live, 1783754110000], [legacy().withFinal, 1783754110000],
    [upTo(probe1().live, 1794126712600), 1794126712700], [[], 1],
  ];
  for (const [events, now] of scenarios) {
    const run = reduceRun(events, { now: () => now });
    assert.deepEqual(JSON.parse(JSON.stringify(run)), run);
  }
});

test('reduceRun does not modify its input events', () => {
  const deepFreeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze); } return x; };
  const p = probe2();
  const frozen = deepFreeze(structuredClone(p.withFinal));
  assert.doesNotThrow(() => reduceRun(frozen, { now: () => 1794127740000 }));
  assert.deepEqual(frozen, p.withFinal);
});

test('the Run holds its own copies of activity lists (a later reduce does not alias an earlier run)', () => {
  const p = probe2();
  const r1 = reduceRun(p.live, { now: () => 1794127740000 });
  const r2 = reduceRun(p.live, { now: () => 1794127740000 });
  r1.agents[p.ids.a1].activity.push({ ts: 0 });
  assert.equal(r2.agents[p.ids.a1].activity.length, 3);
});

test('scale: 200 agents with kilobyte prompts and results reduce in well under two seconds', () => {
  let seed = 12345; // mulberry32: deterministic, long period
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const word = () => Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)]).join('');
  const text = (n) => Array.from({ length: n }, word).join(' ');
  const p = probe1();
  const b = p.b;
  const events = [p.e.script, p.e.launched];
  const results = [];
  const N = 200;
  for (let i = 0; i < N; i++) {
    const id = `agent${String(i).padStart(4, '0')}`;
    const t0 = 1794126800000 + i * 10_000;
    const picks = [i - 1, i - 2].filter((k) => k >= 0).map((k) => results[k]);
    const result = { note: text(150) };
    results.push(result);
    events.push(b.started(3 + i * 2, t0, id, `worker:${i}`, 'Loop'));
    events.push(b.prompt(id, `Task ${i}. ${picks.map((r) => JSON.stringify(r, null, 2)).join('\n')}\n${text(400)}`, t0 + 1));
    events.push(b.result(4 + i * 2, t0 + 5000, id, result));
  }
  const t = Date.now();
  const run = reduceRun(events, { now: () => 1794126800000 + N * 10_000 + 1000 });
  const ms = Date.now() - t;
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.equal(run.totals.agents, N);
  const strong = run.edges.filter((e) => e.kind === 'data-flow');
  // each result is quoted by the next two agents only: for each of them it is in the prompt of one OTHER agent, below the
  // boilerplate limit of two (a result quoted by three agents would give no edge to any of them)
  assert.equal(strong.length, 1 + 2 * (N - 2), 'each agent sees exactly its two predecessors (one at the start)');
  assert.ok(strong.every((e) => e.to > e.from));
});

test('probe 1 with the final file still recognises the three verdicts from the registered results', () => {
  const run = reduceRun(probe1().withFinal, { now: () => 1794126730000 });
  // R1: agent-scope verdicts are unchanged; the run result adds its own, marked scope run
  assert.deepEqual(run.recognized.verdicts.filter((v) => v.scope === 'agent').map((v) => v.verdict), ['pass', 'fail', 'fail']);
});

// ------------------------------------------------------------------ model: final > transcript > agent meta

test('model: the agent meta alias is used while no transcript model is seen; the transcript model replaces it; the final file wins', () => {
  const p = probe1();
  const early = reduceRun(upTo(p.live, 1794126712000), { now: () => 1794126712500 });
  const a0 = early.agents[p.ids.A];
  assert.equal(a0.activity.length, 0, 'no transcript activity yet, so no transcript model');
  assert.deepEqual([a0.model.value, a0.model.prov], ['haiku', 'registered']);
  assert.match(a0.model.from, /agent-acc4223d928e12071\.meta\.json#model$/);
  const live = reduceRun(p.live, { now: () => 1794126725000 });
  assert.deepEqual([live.agents[p.ids.A].model.value, live.agents[p.ids.A].model.prov], ['claude-haiku-5-5', 'registered']);
  assert.match(live.agents[p.ids.A].model.from, /agent-acc4223d928e12071\.jsonl:3$/);
  const done = reduceRun(p.withFinal, { now: () => 1794126730000 });
  assert.deepEqual([done.agents[p.ids.A].model.value, done.agents[p.ids.A].model.prov], ['claude-haiku-5-5', 'final']);
});

// ------------------------------------------------------------------ durations from journal file times

test('journal-only agent: start and end are the same journal file time, so the duration is unknown, not 0 ms', () => {
  const b = probe1().b;
  const events = [b.launched(1, 5000), b.started(2, 5000, 'aX', 'w:X', 'Fanout'), b.result(3, 5000, 'aX', 'a result of some length')];
  const run = reduceRun(events, { now: () => 6000 });
  const a = run.agents.aX;
  assert.deepEqual([a.startedAt.value, a.startedAt.method, a.endedAt.value, a.endedAt.method], [5000, 'journal-event-ts', 5000, 'journal-event-ts']);
  assert.deepEqual([a.durationMs.prov, a.durationMs.value], ['unknown', null]);
  assert.match(a.durationMs.reason, /same journal file time/);
  assert.ok(run.unknowns.some((u) => u.field === 'agents.aX.durationMs'));
  checkFacts(run, 8);
  // two different file times still give the coarse duration, labelled as such
  const later = reduceRun([b.launched(1, 5000), b.started(2, 5000, 'aX', 'w:X', 'Fanout'), b.result(3, 7500, 'aX', 'a result of some length')], { now: () => 8000 });
  assert.deepEqual(later.agents.aX.durationMs, { value: 2500, prov: 'inferred', method: 'endedAt-startedAt (journal file times, coarse)' });
});

// ------------------------------------------------------------------ ids that are not safe object keys

test('an agent id "__proto__" is an own key of run.agents, not a prototype, and survives JSON', () => {
  const b = probe1().b;
  const events = [b.launched(1, 5000), b.started(2, 5000, '__proto__', 'w:proto', 'Fanout'), b.result(3, 6000, '__proto__', 'a result of some length')];
  const run = reduceRun(events, { now: () => 7000 });
  assert.deepEqual(run.order, ['__proto__']);
  assert.equal(run.totals.agents, 1);
  assert.deepEqual(Object.keys(run.agents), ['__proto__']);
  assert.equal(Object.getPrototypeOf(run.agents), Object.prototype);
  assert.equal(run.agents['__proto__'].id, '__proto__');
  assert.equal(run.agents['__proto__'].label.value, 'w:proto');
  assert.deepEqual(run.phases[0].agentIds, ['__proto__']);
  const back = JSON.parse(JSON.stringify(run));
  assert.deepEqual(Object.keys(back.agents), ['__proto__']);
  assert.deepEqual(back, run);
  assert.ok(run.unknowns.some((u) => u.field === 'agents.__proto__.agentType'));
  // an id that only the transcript file name carries
  const viaFile = reduceRun([b.launched(1, 5000), { ...b.prompt('x', 'hello', 5001), data: { text: 'hello' }, prov: { file: b.files.transcript('__proto__'), line: 1 } }], { now: () => 7000 });
  assert.deepEqual(Object.keys(viaFile.agents), ['__proto__']);
  assert.equal(viaFile.agents['__proto__'].prompt.value, 'hello');
});

// ------------------------------------------------------------------ warnings

test('a flood of source warnings does not hide the reducer\'s own findings, and what was dropped is counted', () => {
  const p = probe1();
  const data = structuredClone(p.e.final.data);
  data.workflowProgress.find((x) => x.agentId === p.ids.A).label = 'something else';
  const flood = Array.from({ length: 300 }, (_, i) => p.b.warning(`unreadable line ${i}`, 1794126712000, p.b.files.journal, 100 + i));
  const run = reduceRun([...flood, ...p.live, { ...p.e.final, data }], { now: () => 1794126730000 });
  assert.equal(run.warnings.filter((w) => /^unreadable line \d+ \[/.test(w)).length, 200);
  assert.ok(run.warnings.some((w) => /label "reviewer:A" differs from the final file's "something else"/.test(w)), 'the reducer\'s own warning survives the flood');
  assert.ok(run.warnings.includes('100 more warnings of this kind suppressed (limit 200)'));
  assert.equal(run.warnings.length, 200 + 1 + 1);
});

test('the reducer\'s own findings are capped too, with the count of what was dropped', () => {
  const b = probe1().b;
  const events = [];
  const progress = [];
  for (let i = 0; i < 250; i++) {
    const id = `ag${i}`;
    events.push(b.started(2 + i, 5000 + i, id, `reg:${i}`, 'P'));
    progress.push({ type: 'workflow_agent', agentId: id, label: `fin:${i}`, phaseTitle: 'P', state: 'done', startedAt: 5000 + i, durationMs: 1 });
  }
  events.push(b.final({ status: 'completed', workflowProgress: progress }, 9000));
  const run = reduceRun(events, { now: () => 9500 });
  assert.equal(run.warnings.filter((w) => /differs from the final file/.test(w)).length, 200);
  assert.equal(run.warnings.at(-1), '50 more warnings of this kind suppressed (limit 200)');
});

test('fewer warnings than the limit come without a marker', () => {
  const p = probe1();
  const w = Array.from({ length: 5 }, (_, i) => p.b.warning(`unreadable line ${i}`, 1794126712000, p.b.files.journal, 100 + i));
  const run = reduceRun([...p.live, ...w], { now: () => 1794126725000 });
  assert.equal(run.warnings.length, 5);
  assert.ok(run.warnings.every((x) => !/suppressed/.test(x)));
});

// ------------------------------------------------------------------ lines read again

test('a journal line read again with different content replaces the old one and is reported; identical re-reads change nothing', () => {
  const b = probe1().b;
  const first = [b.launched(1, 1000), b.started(2, 1100, 'aX', 'w:X', 'P'), b.result(3, 1200, 'aX', 'first result of aX, of some length')];
  const rewritten = [b.launched(1, 2000), b.started(2, 2100, 'aY', 'w:Y', 'P'), b.result(3, 2200, 'aY', 'second result of aY, of some length')];
  const run = reduceRun([...first, ...rewritten], { now: () => 3000 });
  assert.deepEqual(run.order, ['aY'], 'the old agent of line 2 is gone, the new one is there');
  assert.equal(run.agents.aY.label.value, 'w:Y');
  assert.equal(run.agents.aY.result.value, 'second result of aY, of some length');
  assert.equal(run.agents.aX, undefined);
  assert.equal(run.totals.agents, 1);
  const changed = run.warnings.filter((w) => /read again with different content/.test(w));
  assert.equal(changed.length, 2, 'started and result lines; the identical "launched" line is no news');
  assert.match(changed[0], /^agent\.started at .*journal\.jsonl:2 was read again with different content \(the file was probably rewritten\); the newer content replaces the earlier one$/);
  assert.match(changed[1], /^agent\.result at .*journal\.jsonl:3 was read again/);
  // the same lines twice: nothing changes, nothing is reported
  const same = reduceRun([...first, ...first], { now: () => 3000 });
  assert.deepEqual(same, reduceRun(first, { now: () => 3000 }));
  assert.deepEqual(same.warnings, []);
  // order of arrival: the later event wins
  const reverse = reduceRun([...rewritten, ...first], { now: () => 3000 });
  assert.deepEqual(reverse.order, ['aX']);
});

test('transcript lines read again with different content are replaced too (prompt, structured output)', () => {
  const p = probe1();
  const { b } = p;
  const old = b.prompt('aX', 'the old prompt text of this agent', 1000, 1);
  const fresh = b.prompt('aX', 'the new prompt text of this agent', 2000, 1);
  const run = reduceRun([b.launched(1, 900), b.started(2, 950, 'aX', 'w:X', 'P'), old, fresh], { now: () => 3000 });
  assert.equal(run.agents.aX.prompt.value, 'the new prompt text of this agent');
  assert.ok(run.warnings.some((w) => /^agent\.prompt at .*agent-aX\.jsonl:1 was read again with different content/.test(w)));
});

// ------------------------------------------------------------------ edge inference inside the reducer

test('an exception inside edge inference becomes a warning and an empty edge list, not a thrown error', () => {
  const p = probe1();
  const memo = { get snap() { throw new RangeError('Map maximum size exceeded'); } };
  let out;
  assert.doesNotThrow(() => { out = reduceDetailed(p.live, { now: () => 1794126725000, memo }); });
  assert.deepEqual(out.run.edges, []);
  assert.ok(out.run.warnings.some((w) => /^edge inference failed \(Map maximum size exceeded\); no edges are shown for this run$/.test(w)));
  assert.equal(out.run.totals.agents, 5, 'everything else is still reduced');
  assert.equal(out.run.recognized.verdicts.length, 3);
});

test('events that cannot change an edge do not rebuild the edges; one that can does', () => {
  const p = probe1();
  const now = () => 1794126725000;
  const memo = {};
  const first = reduceDetailed(p.live, { now, memo }).run;
  const stored = memo.edges;
  assert.equal(stored.length, 1, 'the weak hint B -> judge (probe 1 results are too short for data-flow)');
  const tool = p.b.activity(p.ids.J, { tool: 'Bash', inputSummary: 'ls' }, T('2026-11-08T08:31:56.500Z'), 10); // inside J's known time range
  const second = reduceDetailed([...p.live, tool], { now, memo }).run;
  assert.equal(second.agents[p.ids.J].toolCalls.value, 2, 'the event was reduced');
  assert.equal(memo.edges, stored, 'the stored edges were reused');
  assert.deepEqual(second.edges, first.edges);
  const next = p.b.started(12, 1794126724000, 'late', 'late:L', 'Loop');
  const nextPrompt = p.b.prompt('late', 'Look again at A saw x=1 and B saw x=2 and the verdict "pass" from reviewer A, please.', 1794126724001);
  const third = reduceDetailed([...p.live, tool, next, nextPrompt], { now, memo }).run;
  assert.notEqual(memo.edges, stored, 'a new agent changes the inputs of the inference');
  assert.equal(third.totals.agents, 6);
});

test('scale: 300 agents with 70 KB results do not throw; what the size limits left out is reported, not dropped silently', () => {
  const p = probe1();
  const b = p.b;
  const blob = (i) => createHash('shake256', { outputLength: 52_500 }).update(`result-${i}`).digest('base64'); // 70,000 chars, deterministic, unique
  const events = [p.e.script, p.e.launched];
  const results = [];
  const N = 300;
  for (let i = 0; i < N; i++) {
    const id = `agent${String(i).padStart(4, '0')}`;
    const t0 = 1794126800000 + i * 10_000;
    const result = { note: blob(i) };
    const prev = results[i - 1];
    results.push(result);
    events.push(b.started(3 + i * 2, t0, id, `worker:${i}`, 'Loop'));
    events.push(b.prompt(id, `Task ${i}.\n${prev ? JSON.stringify(prev, null, 2) : ''}`, t0 + 1));
    events.push(b.result(4 + i * 2, t0 + 5000, id, result));
  }
  const store = createStore({ now: () => 1794126800000 + N * 10_000 + 1000 });
  for (const ev of events) store.apply(ev);
  const t = Date.now();
  let run;
  assert.doesNotThrow(() => { run = store.getRun(events[0].runId); });
  assert.doesNotThrow(() => store.listRuns());
  const ms = Date.now() - t;
  assert.ok(ms < 8000, `took ${ms} ms`);
  assert.equal(run.totals.agents, N);
  assert.ok(run.edges.length > 0, 'the results that fit the limits are still linked');
  assert.ok(run.edges.every((e) => e.kind === 'data-flow' && e.to > e.from));
  const notes = run.warnings.filter((w) => /^edge inference/.test(w));
  assert.ok(notes.length >= 1, 'the cut is reported');
  assert.ok(notes.some((w) => /were examined only in part or not at all/.test(w) && /may be missing/.test(w)));
  assert.equal(store.getRun(events[0].runId), run, 'cached');
});

// ------------------------------------------------------------------ contract 2: status, agent states, interrupted agents

const failedLine = (p, line, ts, agentId) => p.b.ev('agent.failed', { agentId, key: `v2:${agentId}` }, ts, p.b.files.journal, line);

test('contract 2: final agent states are normalised with the source value kept: done, error -> failed, progress -> running', () => {
  const p = probe2();
  const data = structuredClone(p.finalData);
  data.status = 'killed';
  const set = (label, state) => { data.workflowProgress.find((x) => x.label === label).state = state; };
  set('stage1:alpha', 'error');
  set('stage1:beta', 'progress'); // the others stay "done"
  const events = [...p.live.filter((e) => !(e.kind === 'agent.result' && e.data.agentId === p.ids.b1)), p.b.final(data, 1794127735595)];
  const run = reduceRun(events, { now: () => 1794127740000 });
  const alpha = by(run, 'stage1:alpha').state;
  assert.deepEqual([alpha.value, alpha.prov, alpha.raw], ['failed', 'final', 'error']);
  assert.match(alpha.from, /wf_26eb8d70-5c4\.json#workflowProgress\[\d+\]\.state$/);
  const beta = by(run, 'stage1:beta').state;
  assert.deepEqual([beta.value, beta.prov, beta.raw, beta.interrupted], ['running', 'final', 'progress', true]);
  const gamma = by(run, 'stage1:gamma').state;
  assert.deepEqual([gamma.value, gamma.prov, gamma.raw, gamma.interrupted], ['done', 'final', 'done', undefined]);
  assert.deepEqual([run.status.value, run.status.prov], ['killed', 'final']);
  assert.deepEqual({ failed: run.totals.failed, running: run.totals.running, interrupted: run.totals.interrupted, done: run.totals.done }, { failed: 1, running: 0, interrupted: 1, done: 4 });
  // the model invents no end time for the interrupted agent; the failed one has its final start + duration
  const b = by(run, 'stage1:beta');
  assert.equal(b.endedAt.prov, 'unknown');
  assert.match(b.endedAt.reason, /interrupted: the run killed while this agent was still running; no end time is recorded/);
  assert.equal(by(run, 'stage1:alpha').endedAt.prov, 'inferred');
  assert.equal(run.phases[0].state.value, 'interrupted');
  checkFacts(run);
});

test('contract 2: the journal line decides when the final file still says "progress" for an agent that has one', () => {
  const p = probe2();
  const data = structuredClone(p.finalData);
  data.status = 'killed';
  data.workflowProgress.find((x) => x.label === 'stage1:beta').state = 'progress';
  const run = reduceRun([...p.live, p.b.final(data, 1794127735595)], { now: () => 1794127740000 });
  const s = by(run, 'stage1:beta').state;
  assert.deepEqual([s.value, s.prov, s.interrupted], ['done', 'registered', undefined], 'it has a result line: it finished');
  assert.ok(run.warnings.some((w) => /final file lists it as "progress", but the journal records how it ended/.test(w)));
  assert.equal(run.totals.interrupted, 0);
});

test('contract 2: a journal "failed" line is the state failed (registered), with the line; the result stays unknown', () => {
  const p = probe1();
  const events = [...p.live.filter((e) => !(e.kind === 'agent.result' && e.data.agentId === p.ids.B)), failedLine(p, 5, 1794126714530, p.ids.B)];
  for (const withFinal of [false, true]) {
    const run = reduceRun(withFinal ? events.concat([{ ...p.e.final, data: { ...p.e.final.data, workflowProgress: p.e.final.data.workflowProgress.filter((x) => x.agentId !== p.ids.B) } }]) : events, { now: () => 1794126730000 });
    const b = run.agents[p.ids.B];
    assert.deepEqual([b.state.value, b.state.prov], ['failed', 'registered'], `withFinal ${withFinal}`);
    assert.match(b.state.from, /journal\.jsonl:5$/);
    assert.equal(b.state.raw, undefined);
    assert.equal(b.result.prov, 'unknown');
    assert.equal(run.totals.failed, 1);
    assert.equal(run.phases[0].state.value, 'failed');
  }
});

test('contract 2: an interrupted agent in a killed run, seen from the journal alone (no final state for it)', () => {
  const p = probe2();
  const { events, dropId } = failedWithout(p, 'errors:ok', (d) => { d.status = 'killed'; });
  const run = reduceRun(events, { now: () => 1794127740000 });
  const a = run.agents[dropId];
  assert.deepEqual([a.state.value, a.state.prov, a.state.interrupted], ['running', 'registered', true]);
  assert.equal(a.state.note, 'interrupted: the run killed while this agent was still running');
  assert.equal(a.endedAt.prov, 'unknown');
  assert.equal(run.totals.interrupted, 1);
  assert.equal(JSON.stringify(a).includes('"interrupted":true'), true, 'the flag reaches the JSON the UI gets');
});

test('contract 2: workflow_phase items are phases, never agents, whatever else they carry', () => {
  const p = probe1();
  const data = structuredClone(p.e.final.data);
  // phase items as the real files have them carry no state; one that does, or that has an agentId, is still a phase
  data.workflowProgress[1] = { type: 'workflow_phase', index: 2, title: 'Judge', state: 'done', agentId: 'phase-not-an-agent' };
  data.workflowProgress.push({ type: 'workflow_phase', index: 4, title: 'Extra' });
  const run = reduceRun([...p.live, { ...p.e.final, data }], { now: () => 1794126730000 });
  assert.equal(run.totals.agents, 5);
  assert.equal('phase-not-an-agent' in run.agents, false);
  assert.deepEqual(run.order, [p.ids.A, p.ids.B, p.ids.J, p.ids.F1, p.ids.F2]);
  assert.deepEqual(run.phases.map((x) => x.title), ['Fanout', 'Judge', 'Loop', 'Extra']);
  assert.equal(run.unknowns.some((u) => /phase-not-an-agent/.test(u.field)), false, 'no "unknown state" agent from a phase item');
  assert.equal(run.warnings.some((w) => /no agentId/.test(w)), false);
});

test('contract 2: the final file does not list every started agent: the journal decides, the others keep their registered values', () => {
  const p = probe1();
  const data = structuredClone(p.e.final.data);
  data.workflowProgress = data.workflowProgress.filter((x) => x.type === 'workflow_phase' || ![p.ids.F1, p.ids.F2].includes(x.agentId));
  const run = reduceRun([...p.live, { ...p.e.final, data }], { now: () => 1794126730000 });
  assert.equal(run.totals.agents, 5, 'all five agents started in the journal exist');
  for (const id of [p.ids.F1, p.ids.F2]) {
    const a = run.agents[id];
    assert.deepEqual([a.state.value, a.state.prov], ['done', 'registered'], 'from the journal result line');
    assert.equal(a.label.prov, 'registered');
    assert.equal(a.phase.prov, 'registered');
    assert.equal(a.result.prov, 'registered');
    assert.equal(a.tokens.prov, 'inferred', 'no final tokens for it: what the transcript gives');
    assert.equal(a.startedAt.prov, 'inferred');
  }
  assert.deepEqual([run.agents[p.ids.A].state.prov, run.agents[p.ids.A].tokens.prov], ['final', 'final'], 'the listed ones have final values');
  checkFacts(run);
});

// ------------------------------------------------------------------ contract 2: ccVersion and version-aware reasons

const withVersion = (events, version) => events.map((e) => (e.kind === 'agent.prompt' ? { ...e, data: { ...e.data, ccVersion: version, version } } : e));

test('contract 2: ccVersion comes from the ccVersion (or version) field of transcript events, registered, with the line', () => {
  const p = probe1();
  const run = reduceRun(withVersion(p.live, '2.1.317'), { now: () => 1794126725000 });
  assert.deepEqual([run.ccVersion.value, run.ccVersion.prov], ['2.1.317', 'registered']);
  assert.match(run.ccVersion.from, /agent-[0-9a-f]+\.jsonl:1$/);
  const onlyCc = reduceRun(p.live.map((e) => (e.kind === 'agent.prompt' ? { ...e, data: { ...e.data, ccVersion: '2.1.280' } } : e)), { now: () => 1794126725000 });
  assert.equal(onlyCc.ccVersion.value, '2.1.280', 'ccVersion alone is enough');
  const activity = reduceRun(p.live.map((e) => (e.kind === 'agent.activity' ? { ...e, data: { ...e.data, version: '2.1.275' } } : e)), { now: () => 1794126725000 });
  assert.equal(activity.ccVersion.value, '2.1.275', 'any transcript record');
  checkFacts(run);
});

test('contract 2: several distinct versions are joined with " + ", in version order, each once; from names the first event of each', () => {
  const p = probe1();
  const ver = { [p.ids.A]: '2.1.317', [p.ids.B]: '2.1.280', [p.ids.J]: '2.1.317', [p.ids.F1]: '2.1.271', [p.ids.F2]: '2.1.280' };
  const events = p.live.map((e) => (e.kind === 'agent.prompt' ? { ...e, data: { ...e.data, ccVersion: ver[e.data.agentId] } } : e));
  for (const evs of [events, [...events].reverse()]) {
    const run = reduceRun(evs, { now: () => 1794126725000 });
    assert.equal(run.ccVersion.value, '2.1.271 + 2.1.280 + 2.1.317');
    assert.equal(run.ccVersion.prov, 'registered');
    assert.equal(run.ccVersion.from.split(', ').length, 3);
  }
  assert.equal(reduceRun(withVersion(p.live, '2.1.306'), { now: () => 1794126725000 }).ccVersion.value, '2.1.306', 'one value: no " + "');
});

test('contract 2: a version in agent meta, or none at all, leaves ccVersion unknown', () => {
  const p = probe1();
  const run = reduceRun(p.live.map((e) => (e.kind === 'agent.meta' ? { ...e, data: { ...e.data, version: '9.9.9', ccVersion: '9.9.9' } } : e)), { now: () => 1794126725000 });
  assert.equal(run.ccVersion.prov, 'unknown');
  assert.equal(run.ccVersion.value, null);
});

const stripLabels = (events) => events.map((e) => {
  if (e.kind === 'agent.started') { const { label, phase, ...rest } = e.data; return { ...e, data: rest }; }
  if (e.kind === 'agent.meta') { const { description, workflowPhase, ...rest } = e.data; return { ...e, data: rest }; }
  return e;
});

test('contract 2: before the final file, a run older than 2.1.271 gets label and phase unknown with the reason "not recorded live before 2.1.271"', () => {
  const p = probe1();
  const old = reduceRun(stripLabels(withVersion(p.live, '2.1.260')), { now: () => 1794126725000 });
  assert.equal(old.totals.agents, 5);
  for (const id of old.order) {
    const a = old.agents[id];
    for (const f of ['label', 'phase']) {
      assert.deepEqual([a[f].prov, a[f].value, a[f].reason], ['unknown', null, 'not recorded live before 2.1.271'], `${f} of ${id}`);
    }
    for (const f of ['role', 'unit', 'round', 'tag']) assert.match(a[f].reason, /label is unknown/);
  }
  assert.ok(old.unknowns.some((u) => u.field === `agents.${p.ids.A}.label` && u.reason === 'not recorded live before 2.1.271'));
  checkFacts(old);
});

test('contract 2: from 2.1.271 on, or with no version known, the reason stays the generic one', () => {
  const p = probe1();
  for (const events of [withVersion(p.live, '2.1.271'), withVersion(p.live, '2.1.317'), p.live]) {
    const run = reduceRun(stripLabels(events), { now: () => 1794126725000 });
    for (const id of run.order) assert.match(run.agents[id].label.reason, /^journal "started" line and agent meta carry no label \(older Claude Code\); the final run file is not written yet$/);
  }
});

test('contract 2: the agent\'s own version decides; a run with mixed versions is judged agent by agent', () => {
  const p = probe1();
  const ver = { [p.ids.A]: '2.1.260', [p.ids.B]: '2.1.317' };
  const events = stripLabels(p.live.map((e) => (e.kind === 'agent.prompt' && ver[e.data.agentId] ? { ...e, data: { ...e.data, ccVersion: ver[e.data.agentId] } } : e)));
  const run = reduceRun(events, { now: () => 1794126725000 });
  assert.equal(run.agents[p.ids.A].label.reason, 'not recorded live before 2.1.271');
  assert.match(run.agents[p.ids.B].label.reason, /older Claude Code/);
  assert.match(run.agents[p.ids.J].label.reason, /older Claude Code/, 'no version of its own and the run has a newer one: generic');
  assert.equal(run.ccVersion.value, '2.1.260 + 2.1.317');
  // only old versions in the run: an agent without a version of its own is old too
  const onlyOld = reduceRun(stripLabels(p.live.map((e) => (e.kind === 'agent.prompt' && e.data.agentId === p.ids.A ? { ...e, data: { ...e.data, ccVersion: '2.1.260' } } : e))), { now: () => 1794126725000 });
  assert.equal(onlyOld.agents[p.ids.J].label.reason, 'not recorded live before 2.1.271');
});

test('contract 2: once the final file has arrived the version reason is gone; labels come from it', () => {
  const p = probe1();
  const run = reduceRun([...stripLabels(withVersion(p.live, '2.1.260')), p.e.final], { now: () => 1794126730000 });
  const a = run.agents[p.ids.A];
  assert.deepEqual([a.label.value, a.label.prov, a.phase.value, a.phase.prov], ['reviewer:A', 'final', 'Fanout', 'final']);
});

// ------------------------------------------------------------------ contract 2: label pattern and recognised tests through the reducer

test('contract 2: role:unit#tag - the tag is an Agent fact (label-pattern), the unit never holds it, the round only comes from #rN', () => {
  const { b } = probe1();
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'aX', 'impl:x#carried', 'P'),
    b.started(3, 1000, 'aY', 'fix:sum.js#r2', 'P'),
    b.started(4, 1000, 'aZ', 'judge', 'P'),
  ], { now: () => 2000 });
  const x = run.agents.aX;
  assert.deepEqual(x.role, { value: 'impl', prov: 'inferred', method: 'label-pattern' });
  assert.deepEqual(x.unit, { value: 'x', prov: 'inferred', method: 'label-pattern' });
  assert.deepEqual(x.tag, { value: 'carried', prov: 'inferred', method: 'label-pattern' });
  assert.equal(x.round.prov, 'unknown');
  const y = run.agents.aY;
  assert.deepEqual([y.unit.value, y.tag.value, y.round.value], ['sum.js', 'r2', 2]);
  assert.equal(run.agents.aZ.tag.prov, 'unknown');
  assert.match(run.agents.aZ.tag.reason, /no "#tag" suffix/);
  assert.ok(run.unknowns.some((u) => u.field === 'agents.aZ.tag'));
});

test('contract 2: a node --test summary in a string result reaches run.recognized.tests', () => {
  const { b } = probe1();
  const out = '> node --test test/\nℹ tests 12\nℹ pass 11\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n';
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'aT', 'test:M1', 'P'),
    b.result(3, 2000, 'aT', out),
    b.started(4, 2100, 'aU', 'test:M2', 'P'),
    b.result(5, 2200, 'aU', { exitCode: 1, tail: out }),
  ], { now: () => 3000 });
  assert.deepEqual(run.recognized.tests.map((t) => [t.agentId, t.path, t.passed, t.failed, t.skipped, t.todo, t.prov, t.method]), [
    ['aT', '$', 11, 1, 0, 0, 'inferred', 'node-test-summary'],
    ['aU', '$.tail', 11, 1, 0, 0, 'inferred', 'node-test-summary'],
  ]);
  assert.match(run.recognized.tests[0].from, /journal\.jsonl:3$/);
});

test('Run.source: demo wins, then replay, else real; replay mixed with another source is flagged, not dropped', () => {
  const p = probe1();
  const now = () => 1794126725000;
  const as = (src, events = p.live) => events.map((e) => ({ ...e, src }));
  assert.equal(reduceRun(as('claude-fs'), { now }).source, 'real');
  assert.equal(reduceRun(as('replay'), { now }).source, 'replay');
  assert.equal(reduceRun(as('demo'), { now }).source, 'demo');
  assert.equal(reduceRun(p.live.map(({ src, ...rest }) => rest), { now }).source, 'real', 'events without src are real');
  assert.equal(reduceRun(as('replay'), { now }).warnings.some((w) => /several sources/.test(w)), false, 'a pure replay has no warning');

  const mixed = [...as('replay'), { ...p.e.launched, src: 'claude-fs', prov: { file: 'x', line: 99 } }];
  const run = reduceRun(mixed, { now });
  assert.equal(run.source, 'replay', 'replay wins over real');
  assert.ok(run.warnings.some((w) => /several sources \((replay, claude-fs|claude-fs, replay)\)/.test(w)), JSON.stringify(run.warnings));
  assert.equal(run.totals.agents, 5, 'the mixed events are still part of the run');

  const all3 = reduceRun([...mixed, { ...p.e.launched, src: 'demo', prov: { file: 'y', line: 98 } }], { now });
  assert.equal(all3.source, 'demo', 'demo wins over replay');
  assert.ok(all3.warnings.some((w) => /several sources/.test(w)));
});

test('a replayed run is the same Run as the direct read of the same events, except for source', () => {
  const p = probe1();
  const now = () => 1794126725000;
  const direct = reduceRun(p.withFinal, { now });
  const replayed = reduceRun(p.withFinal.map((e) => ({ ...e, src: 'replay' })), { now });
  assert.equal(replayed.source, 'replay');
  assert.deepEqual({ ...replayed, source: 'real' }, direct);
});

// ------------------------------------------------------------------ run start (docs/contract.md section 2, Run startedAt)
// order: the final file's startTime; else the earliest agent start (inferred); else the script file time (inferred); else unknown

const HOUR = 3_600_000;

test('run start: a script saved hours before the first agent record does not win; the agent start does', () => {
  const b = builder({ runId: 'wf_start1' });
  const events = [b.script({ name: 'w' }, 1000), b.launched(1, 1000 + 10), b.prompt('aA', 'task', HOUR)];
  assert.deepEqual(reduceRun(events, { now: () => 2 * HOUR }).startedAt, { value: HOUR, prov: 'inferred', method: 'earliest-agent-start' });
  // the earliest of several agent starts
  const more = [...events, b.prompt('aB', 'task', HOUR - 500), b.prompt('aC', 'task', HOUR + 900)];
  assert.deepEqual(reduceRun(more, { now: () => 2 * HOUR }).startedAt, { value: HOUR - 500, prov: 'inferred', method: 'earliest-agent-start' });
});

test('run start: no agent start gives the script file time; with neither, unknown with a reason that names all three', () => {
  const b = builder({ runId: 'wf_start2' });
  const onlyScript = reduceRun([b.script({ name: 'w' }, 1000)], { now: () => 5000 }).startedAt;
  assert.deepEqual(onlyScript, { value: 1000, prov: 'inferred', method: 'script-file-time' });
  // run.launched alone is no start of the run (its ts is a journal file time)
  const none = reduceRun([b.launched(1, 4000)], { now: () => 5000 }).startedAt;
  assert.equal(none.prov, 'unknown');
  assert.equal(none.value, null);
  assert.match(none.reason, /final file startTime/);
  assert.match(none.reason, /agent start/);
  assert.match(none.reason, /script file time/);
  assert.deepEqual(Object.keys(none).sort(), ['prov', 'reason', 'value']);
});

test('run start: the final file wins over the agent start and the script time; a final without a numeric startTime does not count', () => {
  const b = builder({ runId: 'wf_start3' });
  const live = [b.script({ name: 'w' }, 1000), b.launched(1, 1010), b.prompt('aA', 'task', HOUR)];
  const withFinal = reduceRun([...live, b.final({ status: 'completed', startTime: 3_000_000, durationMs: 500 }, 4 * HOUR)], { now: () => 5 * HOUR }).startedAt;
  assert.equal(withFinal.value, 3_000_000);
  assert.equal(withFinal.prov, 'final');
  assert.match(withFinal.from, /wf_start3\.json#startTime$/);
  assert.deepEqual(Object.keys(withFinal).sort(), ['from', 'prov', 'value']);
  for (const startTime of [undefined, '2026-11-10T10:00:00Z', null]) {
    const data = { status: 'completed', durationMs: 500, ...(startTime === undefined ? {} : { startTime }) };
    assert.deepEqual(reduceRun([...live, b.final(data, 4 * HOUR)], { now: () => 5 * HOUR }).startedAt, { value: HOUR, prov: 'inferred', method: 'earliest-agent-start' }, `final startTime ${String(startTime)}`);
  }
});

test('run start: a journal file time (coarse) never wins over a transcript start of another agent, and says it is coarse when it is all there is', () => {
  const b = builder({ runId: 'wf_start4' });
  const coarse = [b.script({ name: 'w' }, 100), b.launched(1, 150), b.started(2, 2000, 'aA', 'x', 'P')];
  const alone = reduceRun(coarse, { now: () => 9000 });
  assert.equal(alone.agents.aA.startedAt.method, 'journal-event-ts');
  assert.deepEqual(alone.startedAt, { value: 2000, prov: 'inferred', method: 'earliest-agent-start (journal file times, coarse)' });
  // another agent has a transcript record that is LATER than the journal file time: the transcript start still wins
  const mixed = reduceRun([...coarse, b.started(3, 2000, 'aB', 'y', 'P'), b.prompt('aB', 'task', 9000)], { now: () => 9500 });
  assert.equal(mixed.agents.aB.startedAt.method, 'first-transcript-record');
  assert.deepEqual(mixed.startedAt, { value: 9000, prov: 'inferred', method: 'earliest-agent-start' });
  // the same agent: its own transcript record replaces the journal time (agent start rule of its own)
  const same = reduceRun([...coarse, b.prompt('aA', 'task', 7000)], { now: () => 9500 });
  assert.deepEqual(same.startedAt, { value: 7000, prov: 'inferred', method: 'earliest-agent-start' });
  // a coarse agent start is still an agent start: it ranks before the script file time
  assert.equal(alone.startedAt.value, 2000);
});

test('run start: it moves once, from the journal file time to the first transcript record, then stays equal until run.final', () => {
  const b = builder({ runId: 'wf_start5' });
  const events = [
    b.script({ name: 'w' }, 100), b.launched(1, 150), b.started(2, 8000, 'aA', 'x', 'P'),
    b.prompt('aA', 'task', 1000), b.activity('aA', { text: 'a' }, 1500, 2), b.activity('aA', { text: 'b' }, 2500, 3),
    b.result(3, 8000, 'aA', 'r'),
  ];
  const facts = events.map((_, i) => reduceRun(events.slice(0, i + 1), { now: () => 9000 }).startedAt);
  assert.equal(facts[0].method, 'script-file-time');
  assert.equal(facts[2].method, 'earliest-agent-start (journal file times, coarse)');
  for (const f of facts.slice(3)) assert.deepEqual(f, { value: 1000, prov: 'inferred', method: 'earliest-agent-start' });
});

test('run start: what is derived from it follows (no duration from the start, run list newest start first, unknown last)', () => {
  const mk = (runId, scriptTs, promptTs) => {
    const b = builder({ runId });
    return [b.script({ name: runId }, scriptTs), b.launched(1, scriptTs + 5), ...(promptTs === undefined ? [] : [b.prompt('aA', 'task', promptTs)])];
  };
  // the script of wf_early was saved last (5 h) but its agent started first (2 h): the list follows the agent start; the old
  // order of the list was early, script_only, late
  const store = createStore({ now: () => 9 * HOUR, staleMs: Infinity });
  for (const e of [...mk('wf_early', 5 * HOUR, 2 * HOUR), ...mk('wf_late', 1 * HOUR, 3 * HOUR), ...mk('wf_script_only', 4 * HOUR)]) store.apply(e);
  const bn = builder({ runId: 'wf_nothing' });
  store.apply(bn.launched(1, 6 * HOUR));
  const list = store.listRuns();
  assert.deepEqual(list.map((r) => r.id), ['wf_script_only', 'wf_late', 'wf_early', 'wf_nothing']);
  assert.deepEqual(list.map((r) => r.startedAt.method ?? 'unknown'), ['script-file-time', 'earliest-agent-start', 'earliest-agent-start', 'unknown']);
  // the duration is the final file's or unknown: it is never computed from the run start
  const run = store.getRun('wf_late');
  assert.equal(run.durationMs.prov, 'unknown');
  assert.equal(run.endedAt.prov, 'unknown');
});
