// test/server/web-lib.test.mjs (nodes U1 and U2): the pure part of the page (web/lib.js). The page has no test runner;
// what it decides lives in lib.js so that it can be checked here without a DOM. The U2 tests are at the end of the file
// (test/server/index.js lists the test files of this folder, so a new file would not be run by `node --test test/`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';
import {
  agentState, backlogNotice, createEventLog, editDiff, edgeEmphasis, edgeKey, edgesOf, elapsedFact, eventLine, eventTime, fetchErrorText,
  hasEditInput, hoverInfo, interruptedEnd, interruptNote, isBusy, isFinalStatus, isInterrupted, isNearBottom, lastEventOf, logHeader,
  lineSeq, logLine, logOrder, matrixCell, matrixRoles, matrixUnits, parsedAgents, relatedIds, reportCard, retimedLines, roundHistory, runOption,
  sortByShownTime, splitError, tagOf, testsEmptyMessage, timeKey, val, visualState,
  findingCounts, isRunScope, runItemLabel, runResultView, scopeSplit, testRows, testsView,
} from '../../web/lib.js';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
    state: reg('done'), startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(), ...over,
  };
}
function run(agents, over = {}) {
  return { id: 'wf_x', status: { value: 'running', prov: 'inferred', method: 'no-final-file' }, agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] }, ...over };
}

// ---- item 7: interrupted ---------------------------------------------------------------------------------

test('interrupted agent: state running with interrupted: true is not busy and shows as interrupted, with its note', () => {
  const stopped = agent('a', 'implement:S1', { state: { ...reg('running'), interrupted: true, note: 'interrupted: the run killed while this agent was still running' } });
  const live = agent('b', 'review:S1', { state: reg('running') });
  assert.equal(isInterrupted(stopped), true);
  assert.equal(isInterrupted(live), false);
  assert.equal(agentState(stopped), 'running', 'the model value is kept');
  assert.equal(visualState(stopped), 'interrupted');
  assert.equal(visualState(live), 'running');
  assert.equal(isBusy(stopped), false);
  assert.equal(isBusy(live), true);
  assert.match(interruptNote(stopped), /the run killed while this agent was still running/);
  assert.match(interruptNote(agent('c', 'x:y', { state: { ...reg('running'), interrupted: true } })), /interrupted/, 'a note is not required to say something');
  assert.equal(isInterrupted(null), false);
  assert.equal(isInterrupted({ state: unk() }), false);
});

test('interrupted bar: ends at the last recorded activity, else at the start; never at "now", never invented', () => {
  const base = { state: { ...reg('running'), interrupted: true, note: 'n' }, startedAt: inf(1000), endedAt: unk('interrupted') };
  assert.equal(interruptedEnd(agent('a', 'x:y', { ...base, lastActivity: reg({ ts: 5000, tool: 'Bash' }) })), 5000);
  assert.equal(interruptedEnd(agent('a', 'x:y', { ...base, lastActivity: reg({ ts: 500 }) })), 1000, 'activity before the start says nothing: the start');
  assert.equal(interruptedEnd(agent('a', 'x:y', { ...base, lastActivity: unk('none') })), 1000);
  assert.equal(interruptedEnd(agent('a', 'x:y', { ...base, startedAt: unk('none') })), null);
});

test('tag: the Fact value when known, null when unknown or empty (most agents have none)', () => {
  assert.equal(tagOf(agent('a', 'implement:S1#r2')), 'r2');
  assert.equal(tagOf(agent('a', 'implement:S1')), null);
  assert.equal(tagOf({ tag: inf('') }), null);
  assert.equal(tagOf({}), null);
});

// ---- item 10: matrix --------------------------------------------------------------------------------------

test('matrix: one agent that parses as role:unit is enough; only labels without role:unit leave it empty', () => {
  const one = run([agent('a', 'implement:S1')]);
  assert.deepEqual(parsedAgents(one).map((a) => a.id), ['a']);
  assert.deepEqual(matrixRoles(parsedAgents(one)), ['implement']);
  assert.deepEqual(matrixUnits(parsedAgents(one)), ['S1']);

  const mixed = run([agent('a', 'implement:S1'), agent('b', 'just a sentence'), agent('c', 'implement:S2#carried'), agent('d', 'review:S1')]);
  assert.deepEqual(parsedAgents(mixed).map((a) => a.id), ['a', 'c', 'd']);
  assert.deepEqual(matrixRoles(parsedAgents(mixed)), ['implement', 'review'], 'columns come from the agents that parse, not from every role');
  assert.deepEqual(matrixUnits(parsedAgents(mixed)), ['S1', 'S2']);

  const none = run([agent('a', 'just a sentence'), agent('b', null)]);
  assert.deepEqual(parsedAgents(none), []);
  assert.deepEqual(parsedAgents(run([])), []);
  assert.deepEqual(parsedAgents(null), []);
});

test('tests panel: a running run says no test agent has reported yet, any other says none were recognised', () => {
  assert.match(testsEmptyMessage(run([], { status: { value: 'running', prov: 'inferred', method: 'no-final-file' } })), /no test agent has reported yet/);
  assert.match(testsEmptyMessage(run([], { status: fin('completed') })), /no test counts recognised/);
  assert.match(testsEmptyMessage(run([], { status: unk('stale') })), /no test counts recognised/);
  assert.doesNotMatch(testsEmptyMessage(run([], { status: fin('completed') })), /yet/);
  assert.match(testsEmptyMessage(run([], { status: fin('completed') })), /agent results or in the run result/, 'the run result is one of the places that were looked in');
});

// ---- item 9: report card ----------------------------------------------------------------------------------

test('final status: any text read from the final file except "running"', () => {
  for (const s of ['completed', 'failed', 'killed', 'stopped', 'something-new']) assert.equal(isFinalStatus(fin(s)), true, s);
  assert.equal(isFinalStatus(fin('running')), false);
  assert.equal(isFinalStatus({ value: 'running', prov: 'inferred', method: 'no-final-file' }), false);
  assert.equal(isFinalStatus({ value: 'completed', prov: 'inferred', method: 'x' }), false, 'only the final file ends a run');
  assert.equal(isFinalStatus(unk('stale')), false);
  assert.equal(isFinalStatus(fin('')), false);
  assert.equal(isFinalStatus(undefined), false);
});

test('report card: status, duration, agents by state, tests, findings and verdicts, all from the Run', () => {
  const stopped = { ...reg('running'), interrupted: true, note: 'n' };
  const r = run([
    agent('a', 'impl:S1'), agent('b', 'impl:S2'), agent('c', 'rev:S1', { state: reg('failed') }),
    agent('d', 'rev:S2', { state: stopped }), agent('e', 'sentence', { state: unk('x') }),
  ], {
    status: fin('killed'), durationMs: fin(61000, 'wf.json#durationMs'), error: fin('stopped by the user', 'wf.json#error'),
    result: unk('final file has "result": null'),
    recognized: {
      // items with no scope are the agents' (a Run from before the scope was added)
      findings: [{ agentId: 'c' }, { agentId: 'c' }, { agentId: 'd', scope: 'agent' }],
      verdicts: [{ agentId: 'c', verdict: 'fix' }, { agentId: 'd', verdict: 'fix', scope: 'agent' }, { agentId: 'a', verdict: 'accept' }],
      tests: [{ agentId: 'a', passed: 3, failed: 1, method: 'x' }, { agentId: 'b', passed: 10, failed: 0, skipped: 0, todo: 0, method: 'node-test-summary', from: 'j:9' }],
    },
  });
  const c = reportCard(r);
  assert.deepEqual(c.status, fin('killed'));
  assert.deepEqual(c.durationMs, fin(61000, 'wf.json#durationMs'));
  assert.deepEqual(c.error, fin('stopped by the user', 'wf.json#error'));
  assert.equal(c.agents.total, 5);
  assert.deepEqual(c.agents.states, [{ state: 'done', count: 2 }, { state: 'failed', count: 1 }, { state: 'interrupted', count: 1 }, { state: 'unknown', count: 1 }]);
  assert.equal(c.tests.reports, 2, 'the number of reports of the agents');
  assert.equal(c.tests.total, null, 'two agent reports are not a run total: no "last of" stands in for it');
  assert.equal('last' in c.tests, false);
  assert.equal(c.tests.reason, 'final file has "result": null', 'the run result is unknown: its reason');
  assert.equal(c.findings, 3);
  assert.deepEqual(c.verdicts, { total: 3, byValue: { fix: 2, accept: 1 } });
  assert.equal(c.inRunResult, null, 'nothing in the run result');
});

test('report card: exactly one run-scope tests item is the run total, with its counts, inferred, its method and the final file; the agents\' reports are only counted', () => {
  const total = { scope: 'run', agentId: null, from: 'wf.json#result', path: '$.tests', passed: 558, failed: 2, skipped: 1, todo: 3, prov: 'inferred', method: 'field-name:tests' };
  const r = run([agent('a', 'impl:S1')], {
    status: fin('completed'), result: fin({ tests: {} }, 'wf.json#result'),
    recognized: { findings: [], verdicts: [], tests: [{ scope: 'agent', agentId: 'a', passed: 1, failed: 0, skipped: 0 }, { scope: 'agent', agentId: 'a', passed: 2, failed: 0, skipped: 0 }, total] },
  });
  const c = reportCard(r);
  assert.deepEqual(c.tests.total, { passed: 558, failed: 2, skipped: 1, todo: 3, method: 'field-name:tests', from: 'wf.json#result', prov: 'inferred' });
  assert.equal(c.tests.reports, 2, 'only the agents\' reports');
  assert.equal(c.tests.reason, null);
  assert.deepEqual(c.inRunResult, { findings: 0, verdicts: 0, tests: 1 });
  // a count the item does not have stays missing; todo only when the item has it
  const part = reportCard(run([], { status: fin('completed'), result: fin({}), recognized: { findings: [], verdicts: [], tests: [{ scope: 'run', agentId: null, from: 'f#result', path: '$', passed: 7, method: 'node-test-summary' }] } }));
  assert.deepEqual(part.tests.total, { passed: 7, failed: undefined, skipped: undefined, method: 'node-test-summary', from: 'f#result', prov: 'inferred' });
  assert.equal('todo' in part.tests.total, false);
  assert.equal(part.tests.reports, 0);
});

test('report card: no run-scope tests item is no run total, and the reason says why: the run result is unknown (its reason), has none recognised, or the Run has no result', () => {
  const agentReport = { scope: 'agent', agentId: 'a', passed: 9, failed: 0, skipped: 0, method: 'x' };
  const rec = { findings: [], verdicts: [], tests: [agentReport] };
  const noTests = reportCard(run([agent('a', 'x:y')], { status: fin('completed'), result: fin({ summary: 'ok' }, 'f#result'), recognized: rec }));
  assert.equal(noTests.tests.total, null);
  assert.match(noTests.tests.reason, /no test counts recognised in the run result/);
  assert.equal(noTests.tests.reports, 1, 'the agent report is counted, never shown as the total');
  const nul = reportCard(run([agent('a', 'x:y')], { status: fin('failed'), result: unk('final file has "result": null'), recognized: rec }));
  assert.equal(nul.tests.reason, 'final file has "result": null');
  const noKey = reportCard(run([agent('a', 'x:y')], { status: fin('completed'), recognized: rec }));
  assert.equal(noKey.tests.total, null);
  assert.match(noKey.tests.reason, /no run result/);
  for (const c of [noTests, nul, noKey]) assert.equal(c.tests.total, null);
});

test('report card: several run-scope tests items give no total, and the reason names how many', () => {
  const item = (path, passed) => ({ scope: 'run', agentId: null, from: 'f#result', path, passed, failed: 0, skipped: 0, method: 'node-test-summary', prov: 'inferred' });
  const r = run([agent('a', 'x:y')], { status: fin('completed'), result: fin({}, 'f#result'), recognized: { findings: [], verdicts: [], tests: [{ scope: 'agent', agentId: 'a', passed: 1 }, item('$.a', 1), item('$.b', 2)] } });
  const c = reportCard(r);
  assert.equal(c.tests.total, null);
  assert.match(c.tests.reason, /2 test results/);
  assert.equal(c.tests.reports, 1);
  assert.deepEqual(c.inRunResult, { findings: 0, verdicts: 0, tests: 2 });
  const four = reportCard(run([], { status: fin('completed'), result: fin({}), recognized: { findings: [], verdicts: [], tests: [item('$.a', 1), item('$.b', 2), item('$.c', 3), item('$.d', 4)] } }));
  assert.match(four.tests.reason, /4 test results/);
});

test('report card: findings and verdicts count the agents\' items only; what the run result holds is counted apart and is null when it holds nothing', () => {
  const r = run([agent('a', 'x:y')], {
    status: fin('completed'), result: fin({}, 'f#result'),
    recognized: {
      findings: [{ scope: 'agent', agentId: 'a' }, { scope: 'run', agentId: null }, { scope: 'run', agentId: null }, { scope: 'run', agentId: null }, { scope: 'run', agentId: null }],
      verdicts: [{ scope: 'agent', agentId: 'a', verdict: 'pass' }, { scope: 'run', agentId: null, verdict: 'fail' }, { scope: 'run', agentId: null, verdict: 'pass' }],
      tests: [],
    },
  });
  const c = reportCard(r);
  assert.equal(c.findings, 1);
  assert.deepEqual(c.verdicts, { total: 1, byValue: { pass: 1 } });
  assert.deepEqual(c.inRunResult, { findings: 4, verdicts: 2, tests: 0 });
  assert.equal(reportCard(run([agent('a', 'x:y')], { status: fin('completed') })).inRunResult, null);
});

test('report card: what the Run does not have is unknown with a reason; nothing is made up', () => {
  const c = reportCard(run([agent('a', 'impl:S1')], { status: fin('completed') }));
  assert.equal(c.durationMs.prov, 'unknown');
  assert.match(c.durationMs.reason, /no duration/);
  assert.equal(c.error, null);
  assert.equal(c.tests.total, null);
  assert.equal(c.tests.reports, 0);
  assert.match(c.tests.reason, /no run result/);
  assert.equal(c.findings, 0);
  assert.deepEqual(c.verdicts, { total: 0, byValue: {} });
  assert.deepEqual(c.agents.states, [{ state: 'done', count: 1 }]);
  assert.equal(c.inRunResult, null);
  // a Run with an unknown error Fact does not show one
  assert.equal(reportCard(run([], { status: fin('failed'), error: unk('none') })).error, null);
  // an empty or missing run, or one with no `recognized`, does not throw and has no run-scope item
  assert.equal(reportCard(null).agents.total, 0);
  assert.equal(reportCard(null).status.prov, 'unknown');
  assert.equal(reportCard(null).tests.total, null);
  assert.equal(reportCard(null).inRunResult, null);
  const bare = reportCard({ status: fin('completed'), agents: {}, order: [] });
  assert.deepEqual([bare.tests.reports, bare.tests.total, bare.findings, bare.verdicts.total, bare.inRunResult], [0, null, 0, 0, null]);
});

test('report card from a real run: the numbers are the model\'s', async () => {
  const { createStore } = await import('../../src/model/reduce.mjs');
  const { readRunDir } = await import('../../src/source/claude-fs.mjs');
  const base = path.join(REPO, 'fixtures', 'claude-projects');
  const slug = fs.readdirSync(base)[0];
  const session = fs.readdirSync(path.join(base, slug)).find((d) => fs.existsSync(path.join(base, slug, d, 'subagents', 'workflows', 'wf_6509ce25-20a')));
  const store = createStore();
  for (const ev of await readRunDir(path.join(base, slug, session), 'wf_6509ce25-20a')) store.apply(ev);
  const r = store.getRun('wf_6509ce25-20a');
  assert.equal(isFinalStatus(r.status), true);
  const c = reportCard(r);
  assert.equal(c.status, r.status);
  assert.equal(c.durationMs, r.durationMs);
  assert.equal(c.agents.total, r.totals.agents);
  assert.equal(c.agents.states.find((s) => s.state === 'done').count, r.totals.done);
  const agentScope = (kind) => r.recognized[kind].filter((x) => x.scope !== 'run');
  const runScope = (kind) => r.recognized[kind].filter((x) => x.scope === 'run');
  assert.equal(c.findings, agentScope('findings').length);
  assert.equal(c.verdicts.total, agentScope('verdicts').length);
  assert.equal(c.verdicts.total, 3, 'the three verdicts of the agents');
  assert.deepEqual(c.inRunResult, { findings: runScope('findings').length, verdicts: runScope('verdicts').length, tests: runScope('tests').length });
  assert.deepEqual(c.inRunResult, { findings: 0, verdicts: 3, tests: 0 }, 'the run result holds the three verdicts again');
  assert.equal(c.tests.total, null, 'no tests in this run: no total, and the agents\' reports are none');
  assert.equal(c.tests.reports, 0);
  assert.match(c.tests.reason, /no test counts recognised in the run result/);
  assert.ok(parsedAgents(r).length > 0, 'the matrix has agents to show');
});

// ---- scope on the page: which items belong to an agent and which to the run result

test('scope: only the text "run" is run scope; a missing or any other scope is an agent item', () => {
  assert.equal(isRunScope({ scope: 'run' }), true);
  for (const x of [{ scope: 'agent' }, {}, { scope: 'Run' }, { scope: 'runs' }, { scope: null }, null, undefined]) assert.equal(isRunScope(x), false, JSON.stringify(x));
  assert.equal(runItemLabel({ scope: 'run', path: '$.a' }), 'run result · $.a');
  assert.equal(runItemLabel({ scope: 'run' }), 'run result');
  assert.equal(runItemLabel(null), 'run result');
});

test('scopeSplit: the items of a Run by scope, in the model\'s order; a Run with no recognised items has none', () => {
  const by = scopeSplit(run([], { recognized: {
    findings: [{ agentId: 'a', path: '1' }, { scope: 'run', agentId: null, path: '2' }, { scope: 'agent', agentId: 'b', path: '3' }],
    verdicts: [{ scope: 'run', agentId: null, verdict: 'x' }], tests: [],
  } }));
  assert.deepEqual(by.agent.findings.map((f) => f.path), ['1', '3']);
  assert.deepEqual(by.run.findings.map((f) => f.path), ['2']);
  assert.deepEqual([by.agent.verdicts.length, by.run.verdicts.length, by.agent.tests.length, by.run.tests.length], [0, 1, 0, 0]);
  for (const x of [null, undefined, {}, { recognized: null }, { recognized: { findings: 'x' } }]) {
    assert.deepEqual(scopeSplit(x), { agent: { findings: [], verdicts: [], tests: [] }, run: { findings: [], verdicts: [], tests: [] } });
  }
});

test('finding counts: an item of the run result is no agent\'s; the counts per agent are the agents\' own', () => {
  const counts = findingCounts(run([], { recognized: { findings: [{ agentId: 'a' }, { scope: 'run', agentId: null }, { scope: 'agent', agentId: 'a' }, { scope: 'run', agentId: 'a' }], verdicts: [], tests: [] } }));
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.has(null), false);
  assert.equal(counts.size, 1);
});

test('tests rows: the rows of the run result say "run result", belong to no agent, have their own k of n and a key no agent row can have', () => {
  const tests = [
    { scope: 'agent', agentId: 'a', path: '$', passed: 1, failed: 0, skipped: 0, method: 'node-test-summary' },
    { scope: 'agent', agentId: 'run', path: '$.tests', passed: 2, failed: 0, skipped: 0 },
    { scope: 'run', agentId: null, path: '$.tests', passed: 3, failed: 1, skipped: 0, method: 'field-name:tests' },
    { scope: 'run', agentId: null, path: '$.out', passed: 4, failed: 0, skipped: 2, todo: 1, method: 'node-test-summary' },
    { scope: 'run', agentId: null, path: '$.tests', passed: 5 },
  ];
  const rows = testRows(run([agent('a', 'check:alpha'), agent('run', 'plain')], { recognized: { findings: [], verdicts: [], tests } }));
  assert.deepEqual(rows.map((r) => r.caption), ['run result · summary 3 of 3', 'run result · summary 2 of 3', 'run result · summary 1 of 3', 'plain', 'check:alpha'], 'newest first; the run result comes last in the model, so first here');
  assert.deepEqual(rows.map((r) => r.scope), ['run', 'run', 'run', 'agent', 'agent']);
  assert.deepEqual(rows.map((r) => r.agentId), [null, null, null, 'run', 'a'], 'an agent named "run" is an agent');
  assert.deepEqual(rows.slice(0, 3).map((r) => r.path), ['$.tests', '$.out', '$.tests'], 'a run row says where in the result it was found');
  assert.equal(rows.every((r) => r.scope !== 'run' || (r.role === null && r.unit === null)), true);
  assert.equal(new Set(rows.map((r) => r.key)).size, 5, 'every key is different, a run row\'s from an agent row\'s too');
  assert.doesNotThrow(() => lib.planPatch([], rows, (r) => r.key));
  const lone = testRows(run([], { recognized: { findings: [], verdicts: [], tests: [tests[2]] } }));
  assert.deepEqual([lone[0].caption, lone[0].k, lone[0].n], ['run result', 1, 1], 'one row: no "summary k of n"');
  assert.deepEqual([lone[0].passed, lone[0].failed, lone[0].skipped, lone[0].method], [3, 1, 0, 'field-name:tests']);
  const part = testRows(run([], { recognized: { findings: [], verdicts: [], tests: [tests[4]] } }))[0];
  assert.deepEqual([part.passed, part.failed, part.skipped, part.method], [5, null, null, null], 'a count the item has not stays null');
});

test('tests rows: a row of the run result keeps its key when a row is added; the view counts the run result\'s rows among the run\'s', () => {
  const t = (path, n) => ({ scope: 'run', agentId: null, path, passed: n, failed: 0, skipped: 0 });
  const before = testRows(run([], { recognized: { findings: [], verdicts: [], tests: [t('$.a', 1), t('$.a', 2)] } }));
  const after = testRows(run([], { recognized: { findings: [], verdicts: [], tests: [t('$.a', 1), t('$.a', 2), t('$.b', 3)] } }));
  const keyOfPassed = (rows, n) => rows.find((r) => r.passed === n).key;
  for (const n of [1, 2]) assert.equal(keyOfPassed(after, n), keyOfPassed(before, n));
  const v = testsView(run([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests: [{ scope: 'agent', agentId: 'a', passed: 1 }, t('$.a', 1), t('$.b', 2)] } }));
  assert.deepEqual([v.shown, v.total, v.hidden], [3, 3, 0]);
});

test('run result view: a text as it is, anything else as indented JSON with its provenance; an unknown result says why', () => {
  const obj = { a: 1, list: ['<img src=x onerror=y>'] };
  assert.deepEqual(runResultView(run([], { result: fin(obj, 'wf.json#result') })), { known: true, prov: 'final', from: 'wf.json#result', text: JSON.stringify(obj, null, 2), reason: null });
  assert.equal(runResultView(run([], { result: fin('plain text', 'f#result') })).text, 'plain text');
  assert.equal(runResultView(run([], { result: fin([1, 2], 'f#result') })).text, JSON.stringify([1, 2], null, 2));
  assert.equal(runResultView(run([], { result: fin(0, 'f#result') })).text, '0');
  const none = runResultView(run([], { result: unk('final file has "result": null') }));
  assert.deepEqual([none.known, none.prov, none.text, none.reason], [false, 'unknown', null, 'final file has "result": null']);
  for (const x of [null, undefined, run([])]) assert.deepEqual([runResultView(x).known, typeof runResultView(x).reason], [false, 'string']);
});

// ---- item 8: diff -----------------------------------------------------------------------------------------

const byKind = (blocks, kind) => blocks.filter((b) => b.kind === kind).map((b) => [b.name, b.text]);

test('diff: Edit shows the file and old/new text; replace_all is a flag; the file field is not a block', () => {
  const d = editDiff({ ts: 5, tool: 'Edit', inputSummary: '/a.js', input: { file_path: '/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;', replace_all: true } });
  assert.deepEqual([d.tool, d.ts, d.file, d.truncated, d.hasInput], ['Edit', 5, '/a.js', false, true]);
  assert.deepEqual(byKind(d.blocks, 'old'), [['old_string', 'const a = 1;']]);
  assert.deepEqual(byKind(d.blocks, 'new'), [['new_string', 'const a = 2;']]);
  assert.deepEqual(byKind(d.blocks, 'flag'), [['replace_all', 'true']]);
  assert.equal(d.blocks.some((b) => b.name === 'file_path'), false);
});

test('diff: Write with file_path/content and with path/file_text (field names are not assumed)', () => {
  const a = editDiff({ tool: 'Write', input: { file_path: '/a.js', content: 'line 1\nline 2' } });
  assert.equal(a.file, '/a.js');
  assert.deepEqual(byKind(a.blocks, 'new'), [['content', 'line 1\nline 2']]);
  const b = editDiff({ tool: 'Write', input: { path: '/b.js', file_text: 'text' } });
  assert.equal(b.file, '/b.js');
  assert.deepEqual(byKind(b.blocks, 'new'), [['file_text', 'text']]);
  assert.equal(b.blocks.some((x) => x.name === 'path'), false);
});

test('diff: MultiEdit lists each item of edits[] with its own old/new', () => {
  const d = editDiff({ tool: 'MultiEdit', input: { file_path: '/m.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true }, 'not an object', null] } });
  assert.equal(d.file, '/m.js');
  assert.deepEqual(d.blocks, [], 'the array itself is not a block');
  assert.equal(d.edits.length, 2);
  assert.deepEqual(byKind(d.edits[0].blocks, 'old'), [['old_string', 'a']]);
  assert.deepEqual(byKind(d.edits[1].blocks, 'new'), [['new_string', 'd']]);
  assert.deepEqual(byKind(d.edits[1].blocks, 'flag'), [['replace_all', 'true']]);
});

test('diff: NotebookEdit uses notebook_path and new_source; other string fields are shown under their own names', () => {
  const d = editDiff({ tool: 'NotebookEdit', input: { notebook_path: '/n.ipynb', new_source: 'print(1)', cell_id: 'c1', edit_mode: 'replace', some_future_field: { nested: true }, count: 3 } });
  assert.equal(d.file, '/n.ipynb');
  assert.deepEqual(byKind(d.blocks, 'new'), [['new_source', 'print(1)']]);
  assert.deepEqual(byKind(d.blocks, 'other'), [['cell_id', 'c1'], ['edit_mode', 'replace']]);
  assert.deepEqual(byKind(d.blocks, 'flag'), [['count', '3']]);
  assert.equal(d.blocks.some((b) => b.name === 'some_future_field'), false, 'an object is not a string field');
});

test('diff: file is the first of file_path, path, notebook_path that is a string; none is null, not made up', () => {
  assert.equal(editDiff({ input: { path: '/p', notebook_path: '/n', file_path: '/f' } }).file, '/f');
  assert.equal(editDiff({ input: { file_path: '', path: '/p' } }).file, '/p');
  assert.equal(editDiff({ input: { file_path: 7, notebook_path: '/n' } }).file, '/n');
  const none = editDiff({ tool: 'Edit', input: { old_string: 'a', new_string: 'b' } });
  assert.equal(none.file, null);
  assert.equal(none.blocks.length, 2);
});

test('diff: inputTruncated marks it truncated, with or without an input; no input means no blocks and nothing made up', () => {
  const cut = editDiff({ tool: 'Write', inputSummary: '/big.js', input: { file_path: '/big.js', content: 'xxx' }, inputTruncated: true });
  assert.equal(cut.truncated, true);
  assert.equal(cut.hasInput, true);
  const bare = editDiff({ tool: 'MultiEdit', inputSummary: '/huge.js', inputTruncated: true });
  assert.deepEqual([bare.truncated, bare.hasInput, bare.file, bare.blocks, bare.edits, bare.summary], [true, false, null, [], [], '/huge.js']);
  assert.equal(editDiff({ input: { file_path: '/a' } }).truncated, false);
  assert.equal(editDiff({ input: { file_path: '/a' }, inputTruncated: false }).truncated, false);
  for (const junk of [null, undefined, 3, 'x', [], {}, { input: 'x' }, { input: [1] }]) assert.doesNotThrow(() => editDiff(junk));
});

test('hasEditInput: an input object or inputTruncated, nothing else', () => {
  assert.equal(hasEditInput({ input: { a: 1 } }), true);
  assert.equal(hasEditInput({ inputTruncated: true }), true);
  assert.equal(hasEditInput({ tool: 'Bash', inputSummary: 'ls' }), false);
  assert.equal(hasEditInput({ input: 'x' }), false);
  assert.equal(hasEditInput(null), false);
});

// ---- item 5: event line -----------------------------------------------------------------------------------

test('event line: time, actor (label, else agentId), message, status', () => {
  assert.deepEqual(eventLine({ ts: 5, label: 'implement:S1', agentId: 'a1', message: 'x', status: 'done' }), { ts: 5, actor: 'implement:S1', message: 'x', status: 'done' });
  assert.equal(eventLine({ ts: 5, agentId: 'a1', message: 'x' }).actor, 'a1');
  assert.equal(eventLine({ ts: 5, agentId: 'a1', label: '', message: 'x' }).actor, 'a1');
  assert.equal(eventLine({ ts: 5, kind: 'run.launched', message: 'run launched' }).actor, 'run');
  assert.equal(eventLine({ ts: 5, kind: 'agent.activity', message: 'x' }).actor, '');
  assert.deepEqual(eventLine({ ts: null, message: 'x' }), { ts: null, actor: '', message: 'x', status: null });
  assert.equal(val({ value: 3, prov: 'registered' }), 3);
});

// ---- item 4: the event log --------------------------------------------------------------------------------

const ev = (seq, runId = 'wf_a', over = {}) => ({ runId, seq, ts: 1000 + seq, kind: 'agent.activity', message: `m${seq}`, prov: 'registered', ...over });
const seqs = (log) => log.lines.map((l) => l.seq ?? `missing:${l.from}-${l.to}`);

test('log: the backlog fills it, live events with seq > last are added, duplicates are ignored', () => {
  const log = createEventLog();
  log.reset('wf_a');
  assert.equal(log.ready, false);
  const r = log.load([ev(1), ev(2), ev(3)]);
  assert.deepEqual(r.added.map((e) => e.seq), [1, 2, 3]);
  assert.equal(r.gap, false);
  assert.equal(log.ready, true);
  assert.equal(log.last, 3);
  assert.equal(log.push(ev(4)).status, 'added');
  assert.equal(log.push(ev(4)).status, 'duplicate');
  assert.equal(log.push(ev(2)).status, 'duplicate');
  assert.equal(log.push(ev(5)).status, 'added');
  assert.deepEqual(seqs(log), [1, 2, 3, 4, 5]);
  assert.equal(log.push(ev(6, 'wf_other')).status, 'ignored', 'an event of another run');
  assert.equal(log.push({ runId: 'wf_a' }).status, 'ignored', 'no seq');
  assert.equal(log.push(null).status, 'ignored');
});

test('log: a backlog that does not start at 1 (the store keeps the last events only) is fine', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load([ev(501), ev(502)]);
  assert.equal(log.last, 502);
  assert.equal(log.push(ev(503)).status, 'added');
});

test('log: a live event that arrives before the backlog is held and applied after it, without duplicates or gaps', () => {
  const log = createEventLog();
  log.reset('wf_a');
  assert.equal(log.push(ev(3)).status, 'held');
  assert.equal(log.push(ev(4)).status, 'held');
  assert.equal(log.push(ev(2)).status, 'held');
  const r = log.load([ev(1), ev(2), ev(3)]); // the backlog was read before 4 existed
  assert.deepEqual(r.added.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(r.gap, false);
  assert.deepEqual(seqs(log), [1, 2, 3, 4]);
});

test('log: a gap is announced, later events are held, and the backlog since `last` closes it', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load([ev(1), ev(2)]);
  assert.equal(log.push(ev(5)).status, 'gap', 'seq 3 and 4 were missed');
  assert.equal(log.push(ev(6)).status, 'gap', 'still open: held, the page tries again');
  assert.deepEqual(seqs(log), [1, 2], 'nothing added out of order');
  assert.equal(log.last, 2);
  const r = log.load([ev(3), ev(4), ev(5)]); // GET ...events?since=2
  assert.deepEqual(r.added.map((e) => e.seq), [3, 4, 5, 6]);
  assert.equal(r.gap, false);
  assert.deepEqual(seqs(log), [1, 2, 3, 4, 5, 6]);
  assert.equal(log.push(ev(7)).status, 'added', 'back to normal');
});

test('log: events the server no longer has are accepted after one more try, with a line that says how many are missing', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load([ev(1)]);
  assert.equal(log.push(ev(5)).status, 'gap');
  let r = log.load([]); // the backlog has nothing since 1: the gap stays open
  assert.equal(r.gap, true);
  assert.deepEqual(seqs(log), [1]);
  r = log.load([]); // read again: still nothing
  assert.equal(r.gap, false);
  assert.deepEqual(seqs(log), [1, 'missing:2-4', 5]);
  assert.deepEqual(log.lines[1], { missing: 3, from: 2, to: 4 });
  assert.equal(log.last, 5);
  assert.equal(log.push(ev(6)).status, 'added');
});

test('log: a gap right after the first backlog (events missed between the read and the stream) is read again', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.push(ev(7)); // arrived by SSE while the backlog was out
  const first = log.load([ev(1), ev(2), ev(3)]);
  assert.equal(first.gap, true, 'seq 4-6 are neither in the backlog nor in the stream');
  const second = log.load([ev(4), ev(5), ev(6)]);
  assert.equal(second.gap, false);
  assert.deepEqual(seqs(log), [1, 2, 3, 4, 5, 6, 7]);
});

test('log: the failed read of a gap leaves it open; the next live event is announced as a gap again', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load([ev(1)]);
  assert.equal(log.push(ev(4)).status, 'gap');
  // the page could not read the backlog and does not call load(); the next event tries again
  assert.equal(log.push(ev(5)).status, 'gap');
  assert.deepEqual(log.load([ev(2), ev(3)]).added.map((e) => e.seq), [2, 3, 4, 5]);
});

test('log: at most 2000 lines, the newest', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load(Array.from({ length: 1990 }, (_, i) => ev(i + 1)));
  for (let i = 1991; i <= 2050; i++) assert.equal(log.push(ev(i)).status, 'added');
  assert.equal(log.lines.length, 2000);
  assert.equal(log.lines[0].seq, 51);
  assert.equal(log.lines.at(-1).seq, 2050);
  assert.equal(log.last, 2050);
  const big = createEventLog({ cap: 3 });
  big.reset('wf_a');
  big.load([ev(1), ev(2), ev(3), ev(4), ev(5)]);
  assert.deepEqual(seqs(big), [3, 4, 5]);
});

test('log: reset starts over for another run; events of the earlier run are ignored', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load([ev(1), ev(2)]);
  log.reset('wf_b');
  assert.equal(log.runId, 'wf_b');
  assert.deepEqual(log.lines, []);
  assert.equal(log.ready, false);
  assert.equal(log.push(ev(3, 'wf_a')).status, 'ignored');
  assert.equal(log.push(ev(1, 'wf_b')).status, 'held');
  assert.deepEqual(log.load([ev(1, 'wf_a'), ev(1, 'wf_b')]).added.map((e) => e.runId), ['wf_b'], 'a backlog of another run is not mixed in');
  assert.deepEqual(log.load(null).added, []);
});

// =====================================================================================================================
// Node U2
// =====================================================================================================================

// ---- items 1 and 2: the displayed time of a log line, and the order of the backlog --------------------------

const uev = (seq, over = {}) => ({ runId: 'wf_x', seq, ts: 9000, kind: 'agent.activity', agentId: 'a1', label: 'implement:S1', message: `m${seq}`, prov: 'registered', ...over });

test('log time: the start event of an agent shows its startedAt, the result and failed events its endedAt, and the tooltip says so', () => {
  // implement:S1 of run wf_f9e4e148-265: the journal file time was 21:57:30 (the end of the run), the agent started 21:06:06
  const fileTime = Date.UTC(2026, 10, 8, 21, 57, 30);
  const started = Date.UTC(2026, 10, 8, 21, 6, 6);
  const ended = Date.UTC(2026, 10, 8, 21, 20, 0);
  const r = run([agent('a1', 'implement:S1', { startedAt: inf(started, 'first-transcript-record'), endedAt: inf(ended, 'last-transcript-record') })]);

  const s = eventTime(uev(3, { kind: 'agent.started', ts: fileTime, status: 'running' }), r);
  assert.deepEqual(s, { ts: started, source: 'agent', tip: 'agent start time (inferred, first-transcript-record)' });
  const d = eventTime(uev(9, { kind: 'agent.result', ts: fileTime, status: 'done' }), r);
  assert.deepEqual(d, { ts: ended, source: 'agent', tip: 'agent end time (inferred, last-transcript-record)' });
  const f = eventTime(uev(9, { kind: 'agent.failed', ts: fileTime, status: 'failed' }), r);
  assert.equal(f.ts, ended);
  assert.match(f.tip, /^agent end time \(/);
  // the line as drawn
  assert.equal(logLine(uev(3, { kind: 'agent.started', ts: fileTime }), r).ts, started);
  assert.equal(logLine(uev(3, { kind: 'agent.started', ts: fileTime }), r).timeTip, 'agent start time (inferred, first-transcript-record)');
  assert.equal(logLine(uev(3, { kind: 'agent.started', ts: fileTime }), r).message, 'm3', 'the rest of the line is the event\'s own');
});

test('log time: a registered or final Fact names its source (file#field) instead of a method', () => {
  const r = run([agent('a1', 'x:y', { startedAt: fin(5000, '/long/path/to/wf_1.json#workflowProgress[3].startedAt'), endedAt: reg(6000, '/p/agent.jsonl:7') })]);
  assert.equal(eventTime(uev(1, { kind: 'agent.started' }), r).tip, 'agent start time (final, wf_1.json#workflowProgress[3].startedAt)');
  assert.equal(eventTime(uev(2, { kind: 'agent.result' }), r).tip, 'agent end time (registered, agent.jsonl:7)');
  const bare = run([agent('a1', 'x:y', { startedAt: { value: 5000, prov: 'final' } })]);
  assert.equal(eventTime(uev(1, { kind: 'agent.started' }), bare).tip, 'agent start time (final)', 'no method and no from: nothing made up');
});

test('log time: an unknown Fact, another kind of event, no run or an unknown agent keeps the event ts, and the tooltip says it may be a file time', () => {
  const r = run([agent('a1', 'x:y', { startedAt: unk('none'), endedAt: unk('still running') })]);
  const own = { ts: 7777, source: 'event', tip: 'event time (may be a file time)' };
  assert.deepEqual(eventTime(uev(1, { kind: 'agent.started', ts: 7777 }), r), own);
  assert.deepEqual(eventTime(uev(2, { kind: 'agent.result', ts: 7777 }), r), own);
  assert.deepEqual(eventTime(uev(3, { kind: 'agent.activity', ts: 7777 }), run([agent('a1', 'x:y')])), own, 'an activity event is not a start or an end');
  assert.deepEqual(eventTime(uev(4, { kind: 'run.final', ts: 7777, agentId: undefined }), run([agent('a1', 'x:y')])), own);
  assert.deepEqual(eventTime(uev(5, { kind: 'agent.started', ts: 7777 }), null), own);
  assert.deepEqual(eventTime(uev(6, { kind: 'agent.started', ts: 7777, agentId: 'nobody' }), run([agent('a1', 'x:y')])), own);
  assert.deepEqual(eventTime(uev(7, { kind: 'agent.started', ts: null }), r), { ts: null, source: 'event', tip: 'the event has no timestamp' });
  // an unusable Fact value is not shown either
  assert.equal(eventTime(uev(8, { kind: 'agent.started', ts: 7777 }), run([agent('a1', 'x:y', { startedAt: { value: 'soon', prov: 'inferred', method: 'm' } })])).source, 'event');
});

test('log time, real run: the start events show the agents\' startedAt from the Run, not the journal file time', async () => {
  const { createStore } = await import('../../src/model/reduce.mjs');
  const { readRunDir } = await import('../../src/source/claude-fs.mjs');
  const base = path.join(REPO, 'fixtures', 'claude-projects');
  const slug = fs.readdirSync(base)[0];
  const session = fs.readdirSync(path.join(base, slug)).find((d) => fs.existsSync(path.join(base, slug, d, 'subagents', 'workflows', 'wf_6509ce25-20a')));
  const store = createStore();
  for (const e of await readRunDir(path.join(base, slug, session), 'wf_6509ce25-20a')) store.apply(e);
  const r = store.getRun('wf_6509ce25-20a');
  const events = store.eventsSince('wf_6509ce25-20a', 0);
  const starts = events.filter((e) => e.kind === 'agent.started');
  const results = events.filter((e) => e.kind === 'agent.result');
  assert.ok(starts.length > 0 && results.length > 0);
  for (const e of starts) {
    const t = eventTime(e, r);
    assert.equal(t.ts, r.agents[e.agentId].startedAt.value);
    assert.notEqual(t.ts, e.ts, 'the journal file time is not what the log shows');
    assert.match(t.tip, /^agent start time \(final, wf_6509ce25-20a\.json#workflowProgress\[\d+\]\.startedAt\)$/);
  }
  for (const e of results) {
    const t = eventTime(e, r);
    assert.equal(t.ts, r.agents[e.agentId].endedAt.value);
    assert.equal(t.tip, 'agent end time (inferred, final-startedAt+durationMs)');
  }
  for (const e of events.filter((x) => !x.kind.startsWith('agent.started') && x.kind !== 'agent.result' && x.kind !== 'agent.failed')) {
    assert.equal(eventTime(e, r).source, 'event');
    assert.equal(eventTime(e, r).ts, e.ts);
  }
  // the backlog is shown in the order of the displayed time, and no line is lost
  const sorted = sortByShownTime(events, r);
  assert.equal(sorted.length, events.length);
  assert.deepEqual(sorted.map((e) => e.seq).sort((a, b) => a - b), events.map((e) => e.seq));
  const shown = sorted.map((e) => eventTime(e, r).ts);
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i] >= shown[i - 1], `line ${i} is not before its predecessor`);
});

test('log order: the backlog is sorted by the displayed time; stable, seq breaks ties; the input is not changed', () => {
  const r = run([agent('a1', 'x:y', { startedAt: inf(100), endedAt: inf(900) }), agent('a2', 'x:z', { startedAt: inf(300), endedAt: inf(500) })]);
  const lines = [
    uev(1, { kind: 'run.launched', agentId: undefined, ts: 5000 }),          // event time 5000
    uev(2, { kind: 'agent.started', agentId: 'a1', ts: 5000 }),               // shown 100
    uev(3, { kind: 'agent.started', agentId: 'a2', ts: 5000 }),               // shown 300
    uev(4, { kind: 'agent.result', agentId: 'a2', ts: 5000 }),                // shown 500
    uev(5, { kind: 'agent.result', agentId: 'a1', ts: 5000 }),                // shown 900
    uev(6, { kind: 'agent.activity', agentId: 'a1', ts: 5000 }),              // 5000, ties with seq 1
  ];
  const copy = lines.slice();
  assert.deepEqual(sortByShownTime(lines, r).map((e) => e.seq), [2, 3, 4, 5, 1, 6]);
  assert.deepEqual(lines, copy, 'not changed');
  // no run: every line shows its own ts, so the order is by ts then seq
  assert.deepEqual(sortByShownTime(lines, null).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  // equal times keep their seq order whatever the input order
  assert.deepEqual(sortByShownTime([uev(3, { ts: 10 }), uev(1, { ts: 10 }), uev(2, { ts: 10 })], null).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(sortByShownTime([], r), []);
});

test('log order: a line with no time stays next to the line before it; the marker of missing events too; leading ones take the first known time', () => {
  const lines = [
    uev(1, { ts: null }), uev(2, { ts: 50 }), uev(3, { ts: null }), { missing: 2, from: 4, to: 5 }, uev(6, { ts: 70 }), uev(7, { ts: 60 }),
  ];
  // shown: 1 -> carries 50, 2 -> 50, 3 -> 50, marker -> 50, 6 -> 70, 7 -> 60
  const order = sortByShownTime(lines, null).map((l) => l.seq ?? `missing:${l.from}`);
  assert.deepEqual(order, [1, 2, 3, 'missing:4', 7, 6]);
  assert.deepEqual(sortByShownTime([uev(1, { ts: null }), uev(2, { ts: null })], null).map((l) => l.seq), [1, 2], 'no time at all: seq order');
});

// ---- items 1 and 2 on live lines: a line is timed again when the snapshot that holds its agent arrives --------

// The page keeps, for every line it draws, the timeKey it was drawn with (data-tkey); this stands in for it.
function pageLog() {
  const shown = new Map();
  return {
    draw(items, r) { for (const it of items) shown.set(it.seq, logLine(it, r).timeKey); },
    retime(items, r) {
      const changed = retimedLines(items, r, (it) => shown.get(it.seq));
      for (const c of changed) shown.set(c.seq, c.line.timeKey);
      return changed;
    },
  };
}

test('live log time: the agent.started event comes before the snapshot that holds the agent; the line is timed again when the snapshot arrives', () => {
  const fileTime = Date.UTC(2026, 10, 8, 21, 57, 30);
  const started = Date.UTC(2026, 10, 8, 21, 6, 6);
  const before = run([agent('a1', 'implement:S0')]); // the snapshot on hand when the event arrives: no agent X yet
  const after = run([agent('a1', 'implement:S0'), agent('aX', 'implement:S1', { startedAt: inf(started, 'first-transcript-record'), endedAt: unk('not ended') })]);
  const startEv = uev(7, { kind: 'agent.started', agentId: 'aX', ts: fileTime });
  const page = pageLog();

  // as drawn: the agent is not in the snapshot, so the event ts and the file-time tooltip
  const first = logLine(startEv, before);
  assert.equal(first.ts, fileTime);
  assert.equal(first.timeSource, 'event');
  assert.equal(first.timeTip, 'event time (may be a file time)');
  page.draw([startEv], before);

  // the snapshot with the agent arrives: the line shows the agent start time and says so
  const changed = page.retime([startEv], after);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].seq, 7);
  assert.equal(changed[0].line.ts, started);
  assert.equal(changed[0].line.timeSource, 'agent');
  assert.equal(changed[0].line.timeTip, 'agent start time (inferred, first-transcript-record)');
  assert.deepEqual(changed[0].line, logLine(startEv, after), 'the same line as after a reload');
  assert.deepEqual(page.retime([startEv], after), [], 'nothing more to change when the next snapshot says the same');
});

test('live log time: the agent.result event is timed again when the snapshot brings endedAt; another kind of event never changes', () => {
  const fileTime = 123456;
  const ended = 100000;
  const running = run([agent('a1', 'x:y', { state: reg('running'), endedAt: unk('still running') })]);
  const finished = run([agent('a1', 'x:y', { endedAt: reg(ended, 'agent.jsonl:9') })]);
  const resultEv = uev(4, { kind: 'agent.result', ts: fileTime });
  const failedEv = uev(5, { kind: 'agent.failed', ts: fileTime });
  const activityEv = uev(6, { kind: 'agent.activity', ts: fileTime });
  const lines = [resultEv, failedEv, activityEv];
  const page = pageLog();
  page.draw(lines, running);
  assert.equal(logLine(resultEv, running).timeSource, 'event');
  const changed = page.retime(lines, finished);
  assert.deepEqual(changed.map((c) => c.seq), [4, 5], 'the result and the failed line; not the activity line');
  for (const c of changed) {
    assert.equal(c.line.ts, ended);
    assert.equal(c.line.timeTip, 'agent end time (registered, agent.jsonl:9)');
  }
  // a Fact that changes its source changes the tooltip even when the time is the same
  const finalNow = run([agent('a1', 'x:y', { endedAt: fin(ended, 'wf.json#workflowProgress[0].endedAt') })]);
  const again = page.retime(lines, finalNow);
  assert.deepEqual(again.map((c) => c.seq), [4, 5]);
  assert.equal(again[0].line.timeTip, 'agent end time (final, wf.json#workflowProgress[0].endedAt)');
  // an agent that goes back to unknown (the final file is replaced by a fresher read) shows the event time again
  const back = page.retime(lines, running);
  assert.deepEqual(back.map((c) => c.seq), [4, 5]);
  assert.equal(back[0].line.ts, fileTime);
  assert.equal(back[0].line.timeTip, 'event time (may be a file time)');
});

test('retimedLines: the marker of missing events and a line that is not on the page are left alone; no run keeps the event time', () => {
  const lines = [uev(1, { kind: 'agent.started', ts: 50 }), { missing: 2, from: 2, to: 3 }, uev(4, { kind: 'agent.started', ts: 60 })];
  const r = run([agent('a1', 'x:y', { startedAt: inf(10) })]);
  const drawn = new Map([[1, logLine(lines[0], null).timeKey]]); // seq 4 is not on the page
  const changed = retimedLines(lines, r, (it) => drawn.get(it.seq));
  assert.deepEqual(changed.map((c) => c.seq), [1]);
  assert.equal(changed[0].line.ts, 10);
  assert.deepEqual(retimedLines(lines, null, (it) => drawn.get(it.seq)), [], 'without a run the line is timed as drawn');
  assert.deepEqual(retimedLines(null, r, () => 'x'), []);
  assert.equal(lineSeq({ missing: 2, from: 7, to: 8 }), 7);
  assert.equal(lineSeq(uev(9)), 9);
  assert.notEqual(timeKey({ source: 'event', ts: 1, tip: 'a' }), timeKey({ source: 'agent', ts: 1, tip: 'a' }));
  assert.notEqual(timeKey({ source: 'event', ts: null, tip: 'a' }), timeKey({ source: 'event', ts: 0, tip: 'a' }));
});

test('log order on the page: the backlog is sorted by the displayed time, the lines that came live after it keep arrival order', () => {
  const r = run([agent('a1', 'x:y', { startedAt: inf(100) }), agent('a2', 'x:z', { startedAt: inf(50) }), agent('a3', 'x:w', { startedAt: inf(10) })]);
  const lines = [
    uev(1, { kind: 'agent.started', agentId: 'a1', ts: 5000 }), // shown 100
    uev(2, { kind: 'agent.started', agentId: 'a2', ts: 5000 }), // shown 50
    uev(3, { kind: 'agent.started', agentId: 'a3', ts: 5000 }), // live: shown 10, but it stays after the backlog
    { missing: 2, from: 4, to: 5 },
    uev(6, { kind: 'agent.activity', agentId: 'a1', ts: 6000 }),
  ];
  const seqs = (l) => l.map(lineSeq);
  assert.deepEqual(seqs(logOrder(lines, r, 2)), [2, 1, 3, 4, 6]);
  assert.deepEqual(seqs(logOrder(lines, r, 3)), [3, 2, 1, 4, 6]);
  assert.deepEqual(seqs(logOrder(lines, r)), seqs(sortByShownTime(lines, r)), 'without a backlog boundary the whole log is sorted');
  assert.deepEqual(seqs(logOrder(lines.slice().reverse(), r, 2)), [2, 1, 3, 4, 6], 'whatever the input order');
  assert.deepEqual(seqs(logOrder(lines, r, 0)), [1, 2, 3, 4, 6], 'no backlog: arrival order');
  // a backlog drawn before the run was known is in the order of the event times; with the snapshot it is sorted by the agent times
  assert.deepEqual(seqs(logOrder(lines.slice(0, 3), null, 3)), [1, 2, 3]);
  assert.deepEqual(seqs(logOrder(lines.slice(0, 3), r, 3)), [3, 2, 1]);
});

// ---- item 4: the log header ---------------------------------------------------------------------------------

test('log header: at the cap it says "showing the last 2000 of N events" (N = highest seq seen); below it, the count', () => {
  const log = createEventLog();
  log.reset('wf_a');
  log.load(Array.from({ length: 1990 }, (_, i) => ev(i + 1)));
  assert.equal(log.maxSeen, 1990);
  assert.equal(logHeader({ shown: log.lines.length, cap: 2000, maxSeq: log.maxSeen }), '1990');
  for (let i = 1991; i <= 2050; i++) log.push(ev(i));
  assert.equal(log.lines.length, 2000);
  assert.equal(log.maxSeen, 2050);
  assert.equal(logHeader({ shown: log.lines.length, cap: 2000, maxSeq: log.maxSeen }), 'showing the last 2000 of 2050 events');
  assert.equal(logHeader({ shown: 0, cap: 2000, maxSeq: 0 }), '');
  assert.equal(logHeader({ shown: 3, cap: 3, maxSeq: 3 }), 'showing the last 3 of 3 events');
});

test('log header: maxSeen counts events held for a gap and survives a reset only as zero', () => {
  const log = createEventLog();
  log.reset('wf_a');
  assert.equal(log.maxSeen, 0);
  log.push(ev(7)); // held: the backlog is not read yet
  assert.equal(log.maxSeen, 7);
  log.push(ev(4, 'wf_other')); // another run: ignored
  assert.equal(log.maxSeen, 7);
  log.load([ev(1), ev(2)]);
  assert.equal(log.maxSeen, 7);
  log.reset('wf_b');
  assert.equal(log.maxSeen, 0);
  log.load([ev(501, 'wf_b'), ev(502, 'wf_b')]);
  assert.equal(log.maxSeen, 502, 'a backlog that does not start at 1');
});

test('log follow: a box at (or within 30 px of) its bottom follows new lines; a box scrolled up does not', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 810, clientHeight: 190 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 785, clientHeight: 190 }), true, '25 px away');
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 190 }), false);
  assert.equal(isNearBottom({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 }), true, 'a hidden (collapsed) pane follows');
});

// ---- item 5: matrix cell tags -------------------------------------------------------------------------------

test('matrix cell: several agents show every agent\'s tag, not only the count', () => {
  const a = agent('a', 'implement:S1#impl', { startedAt: inf(1000) });
  const b = agent('b', 'implement:S1#full', { startedAt: inf(2000) });
  const c = agent('c', 'implement:S1', { startedAt: inf(3000) }); // no tag: adds nothing
  const cell = matrixCell([b, c, a]);
  assert.equal(cell.count, 3);
  assert.deepEqual(cell.tags, ['impl', 'full'], 'in start order, whatever the input order');
  assert.equal(cell.tags.join(', '), 'impl, full');
  assert.equal(cell.shown.id, 'c', 'the latest start is shown when no round is known');
});

test('matrix cell: the shown agent is the latest round, then the latest start; one agent is a cell of one; nothing is no cell', () => {
  const r1 = agent('r1', 'fix:S1#r1', { round: inf(1), startedAt: inf(9000) });
  const r2 = agent('r2', 'fix:S1#r2', { round: inf(2), startedAt: inf(1000) });
  assert.equal(matrixCell([r1, r2]).shown.id, 'r2');
  assert.deepEqual(matrixCell([r1, r2]).tags, ['r2', 'r1'], 'tags in start order: r2 started first');
  const one = matrixCell([agent('a', 'x:y#solo')]);
  assert.deepEqual([one.count, one.tags, one.shown.id], [1, ['solo'], 'a']);
  assert.equal(matrixCell([]), null);
  assert.equal(matrixCell(null), null);
  assert.deepEqual(matrixCell([agent('a', 'x:y'), agent('b', 'x:y')]).tags, [], 'no tags: none shown');
});

// ---- item 10: round history ---------------------------------------------------------------------------------

test('round history: agents in start order, grouped by round; a group is placed where its first agent starts', () => {
  const list = [
    agent('c', 'fix:S1#r2', { round: inf(2), startedAt: inf(3000) }),
    agent('a', 'implement:S1#r1', { round: inf(1), startedAt: inf(1000) }),
    agent('b', 'review:S1#r1', { round: inf(1), startedAt: inf(2000), state: reg('failed') }),
  ];
  const g = roundHistory(list);
  assert.deepEqual(g.map((x) => [x.title, x.roundKnown, x.agents.map((y) => y.id)]), [['round 1', true, ['a', 'b']], ['round 2', true, ['c']]]);
  assert.deepEqual(g[0].agents[1], { id: 'b', agent: list[2], label: 'review:S1#r1', role: 'review', tag: 'r1', state: 'failed', note: null });
});

test('round history: an unknown round is grouped by #tag, else "round unknown"; nothing is invented', () => {
  const list = [
    agent('a', 'impl:S1#carried', { startedAt: inf(1000) }),
    agent('b', 'impl:S1', { startedAt: inf(1500) }),
    agent('c', 'review:S1#carried', { startedAt: inf(2000) }),
    agent('d', 'fix:S1#r2', { round: inf(2), startedAt: inf(2500) }),
    agent('e', 'impl:S1#late', { startedAt: unk('none') }),
  ];
  const g = roundHistory(list);
  assert.deepEqual(g.map((x) => [x.title, x.roundKnown, x.round, x.tag, x.agents.map((y) => y.id)]), [
    ['#carried', false, null, 'carried', ['a', 'c']],
    ['round unknown', false, null, null, ['b']],
    ['round 2', true, 2, null, ['d']],
    ['#late', false, null, 'late', ['e']],
  ]);
  assert.deepEqual(roundHistory([]), []);
  assert.deepEqual(roundHistory(null), []);
});

test('round history: an interrupted agent keeps the model\'s note; its state is interrupted', () => {
  const stopped = agent('a', 'impl:S1', { state: { ...reg('running'), interrupted: true, note: 'interrupted: the run killed it' } });
  const [grp] = roundHistory([stopped]);
  assert.equal(grp.agents[0].state, 'interrupted');
  assert.equal(grp.agents[0].note, 'interrupted: the run killed it');
});

// ---- item 9: edge evidence ----------------------------------------------------------------------------------

const edge = (from, to, over = {}) => ({ from, to, kind: 'data-flow', strength: 'strong', evidence: `prompt of "${to}" repeats 80 non-space chars of the result of "${from}": {"verdict":"pass"} <b>&`, prov: 'inferred', ...over });

test('edges of an agent: incoming and outgoing, with kind, strength, prov and the evidence text exactly as in the Run', () => {
  const r = run([agent('a', 'impl:S1'), agent('b', 'review:S1'), agent('c', 'judge:S1'), agent('d', 'other:Z')], {
    edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'c', { kind: 'time-order', strength: 'weak', evidence: 'c started 5 ms after a ended' }), edge('d', 'a')],
  });
  const e = edgesOf(r, 'b');
  assert.deepEqual(e.incoming.map((x) => [x.key, x.other, x.otherLabel]), [['a>b', 'a', 'impl:S1']]);
  assert.deepEqual(e.outgoing.map((x) => [x.key, x.other, x.otherLabel]), [['b>c', 'c', 'judge:S1']]);
  assert.equal(e.incoming[0].evidence, r.edges[0].evidence, 'the text is the Run\'s, character for character');
  assert.deepEqual([e.incoming[0].kind, e.incoming[0].strength, e.incoming[0].prov], ['data-flow', 'strong', 'inferred']);
  const c = edgesOf(r, 'c');
  assert.deepEqual(c.incoming.map((x) => [x.kind, x.strength, x.prov, x.evidence]), [
    ['data-flow', 'strong', 'inferred', r.edges[1].evidence], ['time-order', 'weak', 'inferred', 'c started 5 ms after a ended'],
  ]);
  assert.deepEqual(edgesOf(r, 'a').outgoing.map((x) => x.other), ['b', 'c']);
  assert.deepEqual(edgesOf(r, 'a').incoming.map((x) => x.other), ['d']);
  assert.deepEqual(edgesOf(r, 'zzz'), { incoming: [], outgoing: [] });
  assert.deepEqual(edgesOf(null, 'a'), { incoming: [], outgoing: [] });
});

test('edges: method is the Run\'s own field; the contract-2 edge has none, so it is null (the page shows it as unknown)', () => {
  const r = run([agent('a', 'x:y'), agent('b', 'x:z')], { edges: [edge('a', 'b'), edge('b', 'a', { method: 'normalised-substring' })] });
  assert.equal(edgesOf(r, 'b').incoming[0].method, null);
  assert.equal(edgesOf(r, 'b').outgoing[0].method, 'normalised-substring');
  // an agent with no label is named by its id
  assert.equal(edgesOf(run([agent('a', null), agent('b', 'x:z')], { edges: [edge('a', 'b')] }), 'b').incoming[0].otherLabel, 'a');
});

test('edge emphasis: the selected agent\'s edges (in and out) stand out, every other edge is dimmed, nothing selected dims nothing', () => {
  assert.equal(edgeKey({ from: 'a', to: 'b' }), 'a>b');
  assert.equal(edgeEmphasis(edge('a', 'b'), 'a'), 'hl');
  assert.equal(edgeEmphasis(edge('a', 'b'), 'b'), 'hl');
  assert.equal(edgeEmphasis(edge('a', 'b'), 'c'), 'dim');
  assert.equal(edgeEmphasis(edge('a', 'b'), null), '');
  assert.equal(edgeEmphasis(edge('a', 'b'), undefined), '');
  const r = run([agent('a', 'x:1'), agent('b', 'x:2'), agent('c', 'x:3')], { edges: [edge('a', 'b'), edge('b', 'c', { kind: 'time-order', strength: 'weak' })] });
  assert.deepEqual([...relatedIds(r, 'b')].sort(), ['a', 'c']);
  assert.deepEqual([...relatedIds(r, 'b', (x) => x.kind === 'data-flow')], ['a'], 'only the edges the page draws');
  assert.deepEqual([...relatedIds(r, 'zzz')], []);
});

// ---- item 8: hover activity ---------------------------------------------------------------------------------

const act = (n, over = {}) => ({ ts: 1000 + n, tool: 'Bash', inputSummary: `cmd ${n}`, ...over });

test('hover: label, state and the last 5 activity items, newest first', () => {
  const activity = Array.from({ length: 8 }, (_, i) => act(i + 1));
  const r = run([agent('a', 'implement:S1', { activity, state: reg('running') })]);
  const h = hoverInfo(r, 'a');
  assert.equal(h.label, 'implement:S1');
  assert.equal(h.state, 'running');
  assert.equal(h.interrupted, false);
  assert.deepEqual(h.items.map((x) => x.inputSummary), ['cmd 8', 'cmd 7', 'cmd 6', 'cmd 5', 'cmd 4']);
  assert.deepEqual(h.items[0], { ts: 1008, tool: 'Bash', inputSummary: 'cmd 8', text: null });
  assert.equal(h.reason, null);
  assert.equal(hoverInfo(r, 'a', { max: 2 }).items.length, 2);
  assert.equal(hoverInfo(r, 'nobody'), null);
  assert.equal(hoverInfo(null, 'a'), null);
});

test('hover: it follows the Run - a new snapshot with a new activity changes what the panel shows', () => {
  const before = run([agent('a', 'x:y', { activity: [act(1), act(2)] })]);
  const after = run([agent('a', 'x:y', { activity: [act(1), act(2), act(3, { tool: 'Edit', inputSummary: '/a.js' })], state: reg('done') })]);
  assert.equal(hoverInfo(before, 'a').items[0].inputSummary, 'cmd 2');
  const h = hoverInfo(after, 'a');
  assert.deepEqual([h.items[0].tool, h.items[0].inputSummary, h.state], ['Edit', '/a.js', 'done']);
});

test('hover: a text-only entry shows its text; no activity list falls back to the Run\'s lastActivity, else says why', () => {
  const t = hoverInfo(run([agent('a', 'x:y', { activity: [act(1), { ts: 1002, text: 'thinking out loud' }] })]), 'a');
  assert.deepEqual([t.items[0].tool, t.items[0].text], [null, 'thinking out loud']);
  const fromFinal = hoverInfo(run([agent('a', 'x:y', { activity: [], lastActivity: fin({ ts: 4000, tool: 'Read', inputSummary: '/x' }, 'wf.json#lastToolName') })]), 'a');
  assert.deepEqual(fromFinal.items, [{ ts: 4000, tool: 'Read', inputSummary: '/x', text: null }]);
  const none = hoverInfo(run([agent('a', 'x:y', { lastActivity: unk('no transcript activity seen; the final run file is not written yet') })]), 'a');
  assert.deepEqual(none.items, []);
  assert.equal(none.reason, 'no transcript activity seen; the final run file is not written yet');
  assert.equal(hoverInfo(run([agent('a', 'x:y', { lastActivity: undefined })]), 'a').reason, 'no activity recorded');
});

test('hover: an interrupted agent shows as interrupted with the model\'s note, or "interrupted (no note)"', () => {
  const withNote = hoverInfo(run([agent('a', 'x:y', { state: { ...reg('running'), interrupted: true, note: 'interrupted: the run killed while this agent was still running' }, lastActivity: reg({ ts: 5000, tool: 'Bash' }) })]), 'a');
  assert.deepEqual([withNote.state, withNote.interrupted, withNote.note, withNote.lastTs], ['interrupted', true, 'interrupted: the run killed while this agent was still running', 5000]);
  const bare = hoverInfo(run([agent('a', 'x:y', { state: { ...reg('running'), interrupted: true } })]), 'a');
  assert.equal(bare.note, 'interrupted (no note)', 'not a reason of the page\'s own');
  assert.equal(bare.lastTs, null);
  assert.equal(interruptNote({ state: { ...reg('running'), interrupted: true, note: '' } }), 'interrupted (no note)');
  assert.equal(interruptNote({ state: { ...reg('running'), interrupted: true, note: 'the model says this' } }), 'the model says this');
});

test('hover: the newest event of an agent comes from the log lines', () => {
  const lines = [uev(1, { agentId: 'a1' }), uev(2, { agentId: 'a2' }), { missing: 2, from: 3, to: 4 }, uev(5, { agentId: 'a1', message: 'newest' }), uev(6, { agentId: 'a2' })];
  assert.equal(lastEventOf(lines, 'a1').message, 'newest');
  assert.equal(lastEventOf(lines, 'a2').seq, 6);
  assert.equal(lastEventOf(lines, 'nobody'), null);
  assert.equal(lastEventOf([], 'a1'), null);
});

// ---- item 6: the long error text ----------------------------------------------------------------------------

test('error text: the first line is shown, the rest (a stack trace) is behind a toggle', () => {
  const trace = 'Error: agent "review:S1" exploded\n    at run (/x/y.js:10:5)\n    at async main (/x/y.js:20:3)\n';
  assert.deepEqual(splitError(trace), { first: 'Error: agent "review:S1" exploded', rest: '    at run (/x/y.js:10:5)\n    at async main (/x/y.js:20:3)', restLines: 2 });
  assert.deepEqual(splitError('stopped by the user'), { first: 'stopped by the user', rest: '', restLines: 0 }, 'one line: nothing to fold');
  assert.deepEqual(splitError('line 1\r\nline 2\r\nline 3'), { first: 'line 1', rest: 'line 2\nline 3', restLines: 2 });
  assert.deepEqual(splitError('\n\n  \nfirst real line\nrest'), { first: 'first real line', rest: 'rest', restLines: 1 }, 'leading blank lines are skipped');
  assert.deepEqual(splitError('only\n\n\n'), { first: 'only', rest: '', restLines: 0 }, 'trailing blank lines are not a rest');
  assert.deepEqual(splitError(''), { first: '', rest: '', restLines: 0 });
  assert.deepEqual(splitError(null), { first: '', rest: '', restLines: 0 });
  assert.equal(splitError('a\n\nb').rest, '\nb', 'a blank line inside the rest stays');
});

// ---- item 7: the run selector -------------------------------------------------------------------------------

test('run option: the whole name, status and id in the text; a title with the full name and the run id', () => {
  const longName = 'adversarial-review-loop: one unit through the gates with a live run of A nested inside it';
  const o = runOption({ id: 'wf_f9e4e148-265', name: reg(longName), status: fin('completed') });
  assert.equal(o.text, `${longName} · completed · wf_f9e4e148-265`);
  assert.equal(o.title, `${longName}\nrun id: wf_f9e4e148-265`);
  const noName = runOption({ id: 'wf_1', name: unk('no script meta'), status: undefined });
  // steady UI (item 7): an unknown name shows the id once and "(no name)", not "id · status · id"
  assert.equal(noName.text, 'wf_1 (no name) · ?');
  assert.equal(noName.text.split('wf_1').length, 2, 'the id appears once');
  assert.equal(runOption({ id: 'wf_3', name: unk('x'), status: fin('completed') }).text, 'wf_3 (no name) · completed');
  assert.equal(noName.title, 'run id: wf_1\nrun name unknown: no script meta');
  assert.match(runOption({ id: 'wf_2' }).title, /run name unknown: not provided/);
});

// ---- item 11: small fixes -----------------------------------------------------------------------------------

test('elapsed: the tooltip names the method the Run gives for the start, not a fixed one', () => {
  const NOW = 100000;
  const a = elapsedFact(run([], { durationMs: unk('run is still running'), startedAt: inf(40000, 'script-file-time') }), NOW);
  assert.deepEqual(a, { value: 60000, prov: 'inferred', method: 'now minus the run start (inferred, script-file-time)' });
  const b = elapsedFact(run([], { durationMs: unk('x'), startedAt: inf(40000, 'earliest-agent-start') }), NOW);
  assert.equal(b.method, 'now minus the run start (inferred, earliest-agent-start)');
  const c = elapsedFact(run([], { durationMs: unk('x'), startedAt: fin(40000, '/p/wf_1.json#startTime') }), NOW);
  assert.equal(c.method, 'now minus the run start (final, wf_1.json#startTime)');
});

test('elapsed: the Run\'s own duration wins; without a start or when the run is not running it stays the Run\'s unknown Fact', () => {
  const own = fin(61000, 'wf.json#durationMs');
  assert.equal(elapsedFact(run([], { durationMs: own, startedAt: inf(1, 'x') }), 99999), own);
  const noStart = run([], { durationMs: unk('run is still running'), startedAt: unk('nothing') });
  assert.equal(elapsedFact(noStart, 99999), noStart.durationMs);
  const done = run([], { status: fin('completed'), durationMs: unk('final file has no durationMs'), startedAt: inf(1, 'x') });
  assert.equal(elapsedFact(done, 99999), done.durationMs, 'only a running run counts up');
  assert.equal(elapsedFact(run([], { durationMs: unk('x'), startedAt: inf(5000, 'm') }), 4000).prov, 'unknown', 'a start in the future says nothing');
  assert.equal(elapsedFact(run([], {}), 1).prov, 'unknown');
  assert.equal(elapsedFact(null, 1).prov, 'unknown');
});

test('failed backlog: the error is the HTTP status or the error\'s message, and the log line says "backlog not loaded: <error>"', () => {
  assert.equal(fetchErrorText({ status: 500 }), 'HTTP 500');
  assert.equal(fetchErrorText({ status: 404, error: new Error('x') }), 'HTTP 404');
  assert.equal(fetchErrorText({ error: new TypeError('Failed to fetch') }), 'Failed to fetch');
  assert.equal(fetchErrorText({ error: 'boom' }), 'boom');
  assert.equal(fetchErrorText({}), 'the request failed, no error text');
  assert.equal(fetchErrorText(), 'the request failed, no error text');
  assert.equal(backlogNotice('HTTP 500'), 'backlog not loaded: HTTP 500');
  assert.equal(backlogNotice(undefined), 'backlog not loaded: no error text');
});

// ---- the page itself: what can be checked without a browser -------------------------------------------------

const WEB = path.join(REPO, 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

test('page: app.js parses, and every name it imports from lib.js exists', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--check', path.join(WEB, 'app.js')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = /import \{([^}]*)\} from '\.\/lib\.js'/.exec(read('app.js'));
  assert.ok(m, 'app.js imports from lib.js');
  const names = m[1].split(',').map((x) => x.trim()).filter(Boolean);
  assert.ok(names.length > 20);
  for (const n of names) assert.equal(typeof lib[n], 'function', `lib.js exports ${n}`);
});

test('page: every element app.js looks up by id is in index.html or drawn by app.js itself', () => {
  const html = read('index.html');
  const app = read('app.js');
  const known = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]));
  const drawn = new Set([...app.matchAll(/\bid="([^"$]+)"/g)].map((x) => x[1]));
  const looked = new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((x) => x[1]));
  assert.ok(looked.size > 10);
  for (const id of looked) assert.ok(known.has(id) || drawn.has(id), `#${id} exists`);
  for (const id of ['log-pane', 'log-toggle', 'log-notice', 'log', 'log-count', 'hover', 'run-select']) assert.ok(known.has(id), `index.html has #${id}`);
});

test('page: nothing is re-rendered on a timer; the one interval is the 1 s elapsed clock, the highlight and the transcript read are one-shot timeouts', () => {
  const app = read('app.js');
  assert.equal([...app.matchAll(/setInterval\(/g)].length, 1, 'one interval: the elapsed clock');
  assert.match(app, /setInterval\(tick, 1000\)/, 'it ticks every second and calls tick only');
  assert.match(app, /clearInterval\(state\.clock\)/, 'a handle is cleared before another is made and when the clock stops');
  // H1 (2026-11-10): a third one-shot timeout puts the copy button's label back after 2 s; it writes that label only.
  // Replay pause pace (2026-11-10): a fourth is the replay's frame queue (one timer at a time, for the next kept frame).
  // Run search: a fifth is the search box's debounce (lib.js createSearch gets its timer from the page: one more `setTimeout(` in app.js, in the search section).
  assert.equal([...app.matchAll(/setTimeout\(/g)].length, 5, 'the highlight, the transcript re-read, the copy label reset, the replay frame queue and the search debounce only');
  assert.equal([...app.matchAll(/setTimer: \(fn, ms\) => setTimeout\(fn, ms\)/g)].length, 2, 'the replay queue\'s timer and the search debounce\'s, each looked up when it is used');
  assert.match(app, /setTimeout\(\(\) => \{ state\.hintTimer = null; setText\(btn, copyLabel\('idle'\)\); \}, HINT_RESET_MS\)/);
});

test('page: the log is the bottom pane of a window-high page: its height is --log-h (80 px .. 60%), the lines scroll inside it, it collapses', () => {
  const css = read('style.css');
  const pane = /\.log-pane\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(pane, /position:\s*fixed/, 'in the flow of the page, so the columns above it end where it starts');
  assert.match(pane, /height:\s*var\(--log-h/);
  assert.match(pane, /max-height:\s*60vh/);
  assert.match(css, /\.log-pane\.collapsed\s*\{[^}]*height:\s*auto/, 'a collapsed pane is only its head; the saved size stays in --log-h');
  assert.match(css, /\.log-pane\.collapsed\s+\.log\b/);
  assert.match(/\.log\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /overflow-y:\s*auto/, 'the lines scroll inside the pane');
  assert.match(/(?:^|\n)body\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /flex-direction:\s*column/, 'the page is a column as high as the window');
  const app = read('app.js');
  assert.doesNotMatch(app, /paddingBottom|syncLogPadding/, 'no bottom padding is needed: the pane is not over the page');
  assert.match(read('index.html'), /<footer id="log-pane"/);
});

test('page: a snapshot times the log lines again (render calls retimeLog) and the lines carry the key they were drawn with', () => {
  const app = read('app.js');
  assert.match(/function render\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /\bretimeLog\(\)/, 'render() runs on every snapshot');
  assert.match(app, /'data-tkey':\s*l\.timeKey/, 'every line keeps the key of the time it shows');
  assert.match(app, /retimedLines\(state\.log\.lines, state\.run,/);
  assert.match(app, /logOrder\(state\.log\.lines, state\.run, state\.backlogSeq\)/, 'the backlog sorted, the live lines in arrival order');
  assert.doesNotMatch(app, /sortByShownTime/, 'the page no longer sorts the whole log');
});

test('page: every data string reaches the page through esc() - no raw interpolation of a Run field in a template', () => {
  // the places U2 added: each ${...} that holds text from the Run or an event is inside esc() or fact()
  const app = read('app.js');
  for (const needle of ['esc(o.title)', 'esc(o.text)', 'esc(e.evidence)', 'esc(e.otherLabel)', 'esc(e.kind)', 'esc(e.prov)', 'esc(p.rest)', 'esc(g.title)', 'esc(x.label)', 'esc(info.label)', 'esc(x.inputSummary', 'esc(l.timeTip)', 'esc(l.message)']) {
    assert.ok(app.includes(needle), `app.js has ${needle}`);
  }
  assert.equal(lib.esc('<img src=x onerror="a">&\'').includes('<'), false);
});

// ---- the page and the run result: app.js on a small fake browser of this file -------------------------------------------------
// Only what these checks need: elements that hold children and attributes, count their own writes and match the selectors app.js uses;
// index.html as the elements it declares; fetch and EventSource answered from data. The html an element is given is read with lib.js
// parseHtml (the page's own reader, tested on its own). Not here, left to the look-and-colour check: how the cards look and where
// the drawer stands over the page.

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const escText = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class FText {
  constructor(data) { Object.assign(this, { nodeType: 3, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), data: String(data) }); }

  get textContent() { return this.data; }

  closest(sel) { return this.parentNode?.closest(sel) ?? null; }

  matches() { return false; }
}

const compound = (text) => {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/y;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4], value: m[5] ?? null });
  }
  return re.lastIndex === text.length ? c : null;
};
const hit = (el, c) => c !== null && (!c.tag || el.tag === c.tag) && (!c.id || el.attrs.get('id') === c.id) && c.classes.every((k) => el.classes.has(k))
  && c.attrs.every((a) => el.attrs.has(a.name) && (a.value === null || el.attrs.get(a.name) === a.value));
function selMatch(el, sel) {
  return String(sel).split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(compound);
    if (!hit(el, chain.at(-1))) return false;
    let n = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (n && !hit(n, chain[i])) n = n.parentNode;
      if (!n) return false;
      n = n.parentNode;
    }
    return true;
  });
}

class FEl {
  constructor(doc, tag) {
    Object.assign(this, { doc, tag, nodeType: 1, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), listeners: {}, writes: 0, _hidden: false, scrollTop: 0, value: '', props: new Map() });
    const self = this;
    this.classList = {
      add(t) { self.writes++; self.classes.add(t); self.attrs.set('class', [...self.classes].join(' ')); },
      remove(t) { self.writes++; self.classes.delete(t); self.attrs.set('class', [...self.classes].join(' ')); },
      contains: (t) => self.classes.has(t),
      toggle(t, force) { const on = force === undefined ? !self.classes.has(t) : !!force; if (on) this.add(t); else this.remove(t); return on; },
    };
    this.style = { setProperty(k, v) { self.writes++; self.props.set(k, v); }, removeProperty(k) { self.writes++; self.props.delete(k); } };
  }

  get hidden() { return this._hidden; }

  set hidden(v) { this.writes++; this._hidden = !!v; }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }

  set textContent(v) { this.writes++; this.childNodes = []; if (String(v) !== '') this.insertBefore(new FText(v), null); }

  get html() { return this.childNodes.map((n) => (n.nodeType === 3 ? escText(n.data) : `<${n.tag}${[...n.attrs].map(([k, v]) => ` ${k}="${escText(v)}"`).join('')}>${VOID.has(n.tag) ? '' : `${n.html}</${n.tag}>`}`)).join(''); }

  get innerHTML() { return this.html; }

  set innerHTML(v) {
    this.writes++;
    this.childNodes = [];
    this.scrollTop = 0;
    const make = (n) => {
      if (typeof n === 'string') return new FText(n);
      const el = new FEl(this.doc, n.tag);
      for (const [k, x] of Object.entries(n.attrs)) el.setAttribute(k, x);
      for (const kid of n.kids) { const c = make(kid); c.parentNode = el; el.childNodes.push(c); }
      return el;
    };
    for (const n of lib.parseHtml(v)) this.insertBefore(make(n), null);
  }

  setAttribute(k, v) { this.writes++; this.attrs.set(k, String(v)); if (k === 'class') this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  removeAttribute(k) { this.writes++; this.attrs.delete(k); if (k === 'class') this.classes = new Set(); }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    if (ref === null || ref === undefined) this.childNodes.push(node); else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }

  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }

  matches(sel) { return selMatch(this, sel); }

  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && selMatch(n, sel)) return n; return null; }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1 && selMatch(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }

  dispatch(type, extra = {}) {
    const ev = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (let n = this; n; n = n.parentNode) for (const fn of [...(n.listeners?.[type] || [])]) fn(ev);
    if (this.onclick && type === 'click') this.onclick(ev);
    for (const fn of [...(this.doc.listeners[type] || [])]) fn(ev);
    return ev;
  }

  focus() {}

  blur() {}

  scrollIntoView() {}

  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

function pageFromHtml(doc, text) {
  const root = new FEl(doc, 'html');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } continue; }
    const el = new FEl(doc, tag);
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (a[1] === 'hidden') el._hidden = true; else el.attrs.set(a[1], v);
      if (a[1] === 'class') el.classes = new Set(v.split(/\s+/).filter(Boolean));
    }
    const parent = stack.at(-1);
    el.parentNode = parent;
    parent.childNodes.push(el);
    if (!m[4] && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

const GLOBALS = ['document', 'window', 'location', 'history', 'localStorage', 'fetch', 'EventSource', 'ResizeObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
let boots = 0;

// A page showing `runDoc` (the only run). `transcripts`: agentId -> a promise the transcript answer waits for (a request in flight).
async function bootResultPage(runDoc, { transcripts = {}, hash = '' } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const doc = { listeners: {}, title: 'wfviz' };
  const html = pageFromHtml(doc, fs.readFileSync(path.join(REPO, 'web', 'index.html'), 'utf8'));
  Object.assign(doc, {
    documentElement: new FEl(doc, 'html'), body: html.querySelector('body'),
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new FEl(doc, t), createElementNS: (ns, t) => new FEl(doc, t), createTextNode: (d) => new FText(d),
    addEventListener: (t, fn) => { (doc.listeners[t] ||= []).push(fn); }, elementFromPoint: () => null,
  });
  html.querySelector('.grid').clientWidth = 1228;
  const page = {
    doc, requests: [], es: null, runDoc,
    el: (s) => { const e = html.querySelector(s); assert.ok(e, `index.html has ${s}`); return e; },
    flush: async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
    async snapshot(r) { for (const fn of page.es.listeners.run || []) fn({ data: JSON.stringify(r) }); await page.flush(); },
    async click(el) { el.dispatch('click'); await page.flush(); },
    async escape() { doc.listeners.keydown.forEach((fn) => fn({ key: 'Escape', preventDefault() {} })); await page.flush(); },
    restore() { for (const n of GLOBALS) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n]; } },
  };
  class FakeES {
    constructor() { this.listeners = {}; page.es = this; }

    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  }
  const summary = { id: runDoc.id, name: runDoc.name, status: runDoc.status, project: null, startedAt: null, agents: Object.keys(runDoc.agents).length, running: 0, source: 'real' };
  const store = {};
  setGlobal('document', doc);
  setGlobal('window', { innerHeight: 800, innerWidth: 1228, addEventListener() {} });
  // the page's address: the picker's filters live in location.hash (read at the start, written with history.replaceState)
  const location = { hash, pathname: '/', search: '' };
  setGlobal('location', location);
  setGlobal('history', { replaceState(_state, _title, url) { location.hash = String(url).startsWith('#') ? String(url) : ''; } });
  setGlobal('localStorage', { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } });
  setGlobal('getComputedStyle', () => ({ paddingLeft: '14px', paddingRight: '14px' }));
  setGlobal('CSS', { escape: (x) => String(x) });
  setGlobal('ResizeObserver', class { observe() {} });
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('EventSource', FakeES);
  setGlobal('setInterval', () => 1);
  setGlobal('clearInterval', () => {});
  setGlobal('setTimeout', () => 1);
  setGlobal('clearTimeout', () => {});
  setGlobal('fetch', async (url) => {
    const u = String(url);
    page.requests.push(u);
    let m;
    let body;
    if (u === '/api/runs') body = [summary];
    else if (/\/events\?since=/.test(u)) body = [];
    else if ((m = /\/api\/agents\/[^/]+\/([^/]+)\/transcript/.exec(u))) {
      await transcripts[decodeURIComponent(m[1])];
      body = [];
    } else if (u === `/api/runs/${runDoc.id}`) body = page.runDoc;
    if (body === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  try {
    await import(`../../web/app.js?lib=${++boots}`);
    await page.flush();
    for (const fn of page.es.listeners.hello || []) fn({ data: JSON.stringify({ mode: 'real', version: '1' }) });
    await page.flush();
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}

const RESULT_FROM = '/w/wf_x.json#result';
function resultRun(over = {}) {
  const result = over.resultValue ?? { verdict: 'fix', note: 'overall <b>', findings: [{ file: 'a.js', line: 3, description: 'bad <img src=x onerror=y>' }], tests: { passed: 5, failed: 1, skipped: 0 }, 'odd"key': 1 };
  const item = (kind, x) => ({ scope: 'run', agentId: null, from: RESULT_FROM, prov: 'inferred', ...x, kind });
  const agentTests = [{ scope: 'agent', agentId: 'a1', from: 'j:5', path: '$', passed: 2, failed: 0, skipped: 0, prov: 'inferred', method: 'node-test-summary' }];
  const recognized = over.recognized ?? {
    findings: [{ scope: 'agent', agentId: 'a1', from: 'j:5', path: '$.findings[0]', file: 'b.js', line: 1, severity: 'low', prov: 'inferred', method: 'field-name:findings' },
      item('f', { path: '$.findings[0]', file: 'a.js', line: 3, description: 'bad <img src=x onerror=y>', method: 'field-name:findings' })],
    verdicts: [{ scope: 'agent', agentId: 'a1', from: 'j:5', path: '$', verdict: 'pass', prov: 'inferred', method: 'field-name:verdict' },
      item('v', { path: '$', verdict: 'fix', reason: 'overall <b>', method: 'field-name:verdict' })],
    tests: [...agentTests, item('t', { path: '$.tests', passed: 5, failed: 1, skipped: 0, method: 'field-name:tests' })],
  };
  for (const k of ['findings', 'verdicts', 'tests']) for (const x of recognized[k]) delete x.kind;
  return {
    id: 'wf_x', source: 'real', name: reg('a run'), status: fin('completed'), durationMs: fin(1000, 'wf.json#durationMs'),
    agents: { a1: agent('a1', 'w:U1') }, order: ['a1'], totals: { agents: 1, running: 0, done: 1, failed: 0 },
    result: over.result ?? fin(result, RESULT_FROM), recognized, edges: [], phases: [], logs: unk('x'), error: unk('none'),
    ...over.rest,
  };
}
const kids = (page, sel) => page.el(sel).childNodes;

test('page: items of the run result are marked as such, belong to no agent and carry data-result, never data-agent', async () => {
  const page = await bootResultPage(resultRun());
  try {
    const cards = kids(page, '#verdicts');
    assert.equal(cards[0].attrs.get('data-sec'), undefined);
    const group = cards[0];
    assert.equal(group.attrs.has('data-result'), false, 'the group is not clickable, its cards are');
    const runCards = group.childNodes.filter((c) => c.attrs.has('data-result'));
    assert.equal(runCards.length, 2, 'a verdict and a finding of the run result');
    for (const c of runCards) {
      assert.equal(c.attrs.has('data-agent'), false);
      assert.match(c.html, /run result · \$/);
    }
    assert.match(group.childNodes[0].html, /in the run result/);
    const agentCards = cards.slice(1);
    assert.equal(agentCards.length, 2, 'the agent\'s own verdict and finding follow');
    for (const c of agentCards) { assert.equal(c.attrs.get('data-agent'), 'a1'); assert.equal(c.attrs.has('data-result'), false); }
    const rows = kids(page, '#tests');
    const runRow = rows.find((r) => r.attrs.has('data-result'));
    assert.ok(runRow, 'a tests row of the run result');
    assert.equal(runRow.attrs.has('data-agent'), false);
    assert.match(runRow.html, /run result/);
    assert.match(runRow.html, /\$\.tests/);
    assert.equal(rows.filter((r) => r.attrs.get('data-agent') === 'a1').length, 1);
    // counters: the agents' own, and the run result's in words
    const counters = kids(page, '#counters').map((c) => c.textContent);
    assert.match(counters[0], /^1findings in results \+ 1 in the run result$/);
    assert.match(counters[1], /^1verdicts pass:1 \+ 1 in the run result$/);
  } finally { page.restore(); }
});

test('page: a Run with no items in its result has exactly the children it had (no group, no run row), and its cards are the agents\'', async () => {
  const doc = resultRun({ result: unk('final file has "result": null') });
  doc.recognized = { findings: [], verdicts: [{ agentId: 'a1', path: '$', verdict: 'pass', method: 'field-name:verdict' }], tests: [] };
  const page = await bootResultPage(doc);
  try {
    const cards = kids(page, '#verdicts');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].attrs.get('data-agent'), 'a1');
    assert.equal(page.doc.querySelectorAll('[data-result]').length, 0, 'nothing on the page opens a run result');
    assert.doesNotMatch(kids(page, '#counters').map((c) => c.textContent).join(' '), /run result/);
    assert.doesNotMatch(page.el('#report').textContent, /in the run result/);
    assert.match(page.el('#report').textContent, /no run-level total/);
    assert.match(page.el('#report').textContent, /final file has "result": null/, 'the reason of the unknown result');
  } finally { page.restore(); }
});

test('report card on the page: one run total says so (counts, inferred method); the agent reports are counted; no "last of" anywhere', async () => {
  const page = await bootResultPage(resultRun());
  try {
    const report = page.el('#report').textContent.replace(/\s+/g, ' ');
    assert.match(report, /5 pass · 1 fail · 0 skipped/);
    assert.match(report, /run total, from the run result in the final file \(inferred: field-name:tests\); 1 agent report/);
    assert.doesNotMatch(report, /last of/);
    assert.match(report, /in the run result: 1 findings, 1 verdicts, 1 tests/);
    const cells = Object.fromEntries(kids(page, '#report').filter((c) => c.childNodes.length).map((c) => [c.childNodes[0]?.textContent, c]));
    assert.equal(cells.findings.childNodes[1].textContent, '1', 'the agents\' findings only');
    assert.equal(cells.verdicts.childNodes[1].textContent, '1');
    // two run-scope tests items: no total
    const two = resultRun();
    two.recognized.tests.push({ scope: 'run', agentId: null, from: RESULT_FROM, path: '$.out', passed: 9, failed: 0, skipped: 0, prov: 'inferred', method: 'node-test-summary' });
    await page.snapshot(two);
    const text = page.el('#report').textContent.replace(/\s+/g, ' ');
    assert.match(text, /1 agent report/);
    assert.match(text, /no run-level total/);
    assert.match(text, /2 test results/);
    assert.doesNotMatch(text, /5 pass/);
    // the run total and the "in the run result" line are keyed elements that open the run result
    assert.equal(page.doc.querySelectorAll('#report [data-result]').length, 1, 'the line of the run result\'s items');
  } finally { page.restore(); }
});

test('page: a click on an item of the run result opens the drawer with the raw result (escaped), its provenance and source; no agent is read', async () => {
  const resultValue = { verdict: 'fix', note: '<img src=x onerror=boom()>', list: ['a & b'], 'odd"key': "it's" };
  const page = await bootResultPage(resultRun({ resultValue }));
  try {
    assert.equal(page.el('#drawer').hidden, true);
    const card = kids(page, '#verdicts')[0].childNodes.find((c) => c.attrs.has('data-result'));
    await page.click(card);
    assert.equal(page.el('#drawer').hidden, false);
    const body = page.el('#drawer-body');
    const pre = body.querySelector('pre');
    assert.equal(pre.textContent, JSON.stringify(resultValue, null, 2), 'the result as JSON, as text');
    assert.match(pre.html, /&lt;img src=x onerror=boom\(\)&gt;/, 'escaped');
    assert.equal(body.querySelectorAll('img').length, 0, 'no element came from the data');
    assert.match(body.textContent, /Run result/);
    assert.match(body.textContent, /final/);
    assert.ok(body.textContent.includes(RESULT_FROM), 'where it came from');
    assert.equal(page.requests.filter((u) => /transcript/.test(u)).length, 0, 'no agent transcript is read for the run result');
    // Escape closes it
    await page.escape();
    assert.equal(page.el('#drawer').hidden, true);
    assert.equal(body.childNodes.length, 0);
    // a row of the tests card and the line of the report open it too; the close button closes it
    await page.click(kids(page, '#tests').find((r) => r.attrs.has('data-result')));
    assert.equal(page.el('#drawer').hidden, false);
    await page.click(page.el('#drawer-close'));
    assert.equal(page.el('#drawer').hidden, true);
    await page.click(page.doc.querySelector('#report [data-result]'));
    assert.equal(page.el('#drawer').hidden, false);
    assert.equal(page.requests.filter((u) => /transcript/.test(u)).length, 0);
  } finally { page.restore(); }
});

test('page: the open run result is refreshed through the patch: the same pre element and scroll position over equal snapshots, the text patched when it changes', async () => {
  const page = await bootResultPage(resultRun());
  try {
    await page.click(kids(page, '#verdicts')[0].childNodes.find((c) => c.attrs.has('data-result')));
    const body = page.el('#drawer-body');
    const pre = body.querySelector('pre');
    const sections = body.childNodes.slice();
    pre.scrollTop = 123;
    const writes = pre.writes;
    await page.snapshot(resultRun());
    await page.snapshot(resultRun());
    assert.equal(body.querySelector('pre'), pre, 'the same element');
    assert.equal(pre.scrollTop, 123, 'the scrolled position is kept');
    assert.equal(pre.writes, writes, 'an equal snapshot writes nothing to it');
    assert.ok(body.childNodes.every((c, i) => c === sections[i]), 'the sections are the same elements');
    // another result: the same element, new text
    const next = resultRun({ resultValue: { verdict: 'accept' } });
    await page.snapshot(next);
    assert.equal(body.querySelector('pre'), pre);
    assert.equal(pre.textContent, JSON.stringify({ verdict: 'accept' }, null, 2));
    // the result goes unknown (the Run says why): the drawer says why instead
    await page.snapshot(resultRun({ result: unk('final file has "result": null') }));
    assert.match(body.querySelector('pre').textContent, /"result": null/);
  } finally { page.restore(); }
});

test('page: the run result and an agent share the drawer without leaving anything of each other; an agent\'s transcript still on its way does not draw into the run result', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const page = await bootResultPage(resultRun(), { transcripts: { a1: gate } });
  try {
    // an agent opens: its transcript request waits
    await page.click(kids(page, '#verdicts').find((c) => c.attrs.get('data-agent') === 'a1'));
    assert.equal(page.requests.filter((u) => /transcript/.test(u)).length, 1);
    assert.ok(page.el('#drawer-body').querySelector('[data-sec="facts"]'), 'the agent\'s facts');
    // the run result replaces it
    await page.click(kids(page, '#verdicts')[0].childNodes.find((c) => c.attrs.has('data-result')));
    const body = page.el('#drawer-body');
    assert.equal(body.querySelector('[data-sec="facts"]'), null, 'nothing of the agent stays');
    assert.ok(body.querySelector('[data-sec="run-result"]'));
    release();
    await page.flush();
    assert.equal(body.querySelector('[data-sec="facts"]'), null, 'the transcript that came in late is not drawn');
    assert.equal(body.querySelector('#activity'), null);
    assert.ok(body.querySelector('[data-sec="run-result"]'));
    // and back: an agent replaces the run result
    await page.click(kids(page, '#verdicts').find((c) => c.attrs.get('data-agent') === 'a1'));
    assert.equal(body.querySelector('[data-sec="run-result"]'), null);
    assert.ok(body.querySelector('[data-sec="facts"]'));
  } finally { page.restore(); }
});

test('page: selecting another run closes the run result\'s drawer, and the code writes nothing of the run result without esc()', async () => {
  const app = fs.readFileSync(path.join(REPO, 'web', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /last of/, 'no report ever says "last of N reports"');
  for (const needle of ['esc(runItemLabel(v))', 'esc(runItemLabel(f))', 'esc(t.path)', 'esc(v.text)', 'esc(v.reason)', 'esc(v.from)']) assert.ok(app.includes(needle), `app.js has ${needle}`);
  // an element is an agent's or the run result's, never both: no spec that is written on one line holds both attributes (a choice between them is a ternary, not a spec)
  assert.deepEqual(app.split('\n').filter((l) => /specOf\(|groupOf\(/.test(l) && /data-agent/.test(l) && /data-result/.test(l)), []);
  assert.match(/async function selectRun\([\s\S]*?\n\}\n/.exec(app)?.[0] ?? '', /closeDrawer\(\)/, 'selecting a run closes whatever the drawer shows');
  assert.match(/function closeDrawer\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /drawerResult = false/);
  const clickHandler = /document\.addEventListener\('click'[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '';
  assert.ok(clickHandler.indexOf("closest('[data-result]')") > 0 && clickHandler.indexOf("closest('[data-result]')") < clickHandler.indexOf("closest('[data-agent]')"), 'the run result branch comes before the agent branch');
  for (const name of ['isRunScope', 'scopeSplit', 'runItemLabel', 'runResultView']) assert.equal(typeof lib[name], 'function', `lib.js exports ${name} as a function`);
});
