// test/server/edit-inputs.test.mjs (node U1): the tracker that gives the transcript endpoint the full input of edit tools.

import assert from 'node:assert/strict';

import { createEditInputTracker, DEFAULT_MAX_PER_AGENT } from '../../src/server/edit-inputs.mjs';
import { test } from './helpers.mjs';

const RUN = 'wf_t';
const act = (agentId, ts, line, data = {}, extra = {}) => ({
  src: 'claude-fs', kind: 'agent.activity', runId: RUN, sessionId: null, project: null, ts,
  prov: { file: `/x/agent-${agentId}.jsonl`, line },
  data: { agentId, ...data },
  ...extra,
});
const edit = (agentId, ts, line, tool, input, more = {}) => act(agentId, ts, line, { tool, inputSummary: input.file_path ?? input.path ?? '', input, ...more });

test('the default per-agent limit is 200', () => {
  assert.equal(DEFAULT_MAX_PER_AGENT, 200);
});

test('only agent.activity events with an input object or inputTruncated are kept; nothing else changes anything', () => {
  const tr = createEditInputTracker();
  const input = { file_path: '/a.js', old_string: 'a', new_string: 'b' };
  tr.record(act('a1', 1, 1, { tool: 'Bash', inputSummary: 'ls' })); // no input
  tr.record(act('a1', 2, 2, { text: 'hello' }));
  tr.record({ ...edit('a1', 3, 3, 'Edit', input), kind: 'agent.result' }); // another kind
  tr.record({ ...edit('a1', 4, 4, 'Edit', input), runId: undefined });
  tr.record(act('a1', 5, 5, { tool: 'Edit', input: 'not an object' }));
  tr.record(act('a1', 6, 6, { tool: 'Edit', input: [1, 2] }));
  tr.record(act('a1', 7, 7, { tool: 'Edit', inputTruncated: false }));
  for (const junk of [null, undefined, 3, 'x', [], {}, { kind: 'agent.activity' }, { kind: 'agent.activity', runId: RUN }]) tr.record(junk);
  tr.record(act(undefined, 8, 8, { tool: 'Edit', input }, { prov: { file: '/x/other.txt', line: 8 } })); // no agent id anywhere
  const activity = [{ ts: 1, tool: 'Bash', inputSummary: 'ls' }];
  assert.equal(tr.attach(RUN, 'a1', activity), activity, 'nothing tracked: the very array comes back');
});

test('which tool it is does not matter: whatever the reader put an input on is kept, as the same object', () => {
  const tr = createEditInputTracker();
  const inputs = {
    Edit: { file_path: '/a.js', old_string: 'a', new_string: 'b', replace_all: false },
    Write: { path: '/w.js', file_text: 'x' },
    MultiEdit: { file_path: '/m.js', edits: [{ old_string: 'a', new_string: 'b' }] },
    NotebookEdit: { notebook_path: '/n.ipynb', new_source: 'print(1)', cell_id: 'c' },
    FutureTool: { whatever: { nested: true } },
  };
  const tools = Object.keys(inputs);
  tools.forEach((tool, i) => tr.record(edit('a1', 10 + i, i + 1, tool, inputs[tool])));
  const entries = tools.map((tool, i) => ({ ts: 10 + i, tool, inputSummary: edit('a1', 0, 0, tool, inputs[tool]).data.inputSummary }));
  const out = tr.attach(RUN, 'a1', entries);
  assert.equal(out.length, 5);
  out.forEach((e, i) => assert.equal(e.input, inputs[tools[i]], `${e.tool}: the same object, not a copy`));
});

test('inputTruncated without an input is kept as a marker; with an input both are served', () => {
  const tr = createEditInputTracker();
  tr.record(act('a1', 5, 1, { tool: 'MultiEdit', inputSummary: '/big.js', inputTruncated: true }));
  tr.record(edit('a1', 6, 2, 'Write', { path: '/cut.js', file_text: 'xxx' }, { inputTruncated: true }));
  const out = tr.attach(RUN, 'a1', [{ ts: 5, tool: 'MultiEdit', inputSummary: '/big.js' }, { ts: 6, tool: 'Write', inputSummary: '/cut.js' }]);
  assert.deepEqual(out, [
    { ts: 5, tool: 'MultiEdit', inputSummary: '/big.js', inputTruncated: true },
    { ts: 6, tool: 'Write', inputSummary: '/cut.js', input: { path: '/cut.js', file_text: 'xxx' }, inputTruncated: true },
  ]);
  assert.equal('input' in out[0], false, 'no input is made up');
});

test('an entry the store already holds with its input is served as it is; the store entries are not modified', () => {
  const tr = createEditInputTracker();
  tr.record(edit('a1', 5, 1, 'Edit', { file_path: '/a.js', old_string: 'tracked', new_string: 'x' }));
  const own = { ts: 5, tool: 'Edit', inputSummary: '/a.js', input: { file_path: '/a.js', old_string: 'store', new_string: 'y' } };
  const plain = { ts: 6, tool: 'Bash', inputSummary: 'ls' };
  const activity = [own, plain];
  const snapshot = JSON.parse(JSON.stringify(activity));
  const out = tr.attach(RUN, 'a1', activity);
  assert.equal(out[0], own);
  assert.equal(out[1], plain);
  assert.deepEqual(activity, snapshot);
});

test('an entry is matched on (ts, tool, inputSummary), and each tracked entry only once, in arrival order', () => {
  const tr = createEditInputTracker();
  tr.record(edit('a1', 5, 1, 'Edit', { file_path: '/same.js', old_string: 'first' }));
  tr.record(edit('a1', 5, 2, 'Edit', { file_path: '/same.js', old_string: 'second' }));
  const out = tr.attach(RUN, 'a1', [
    { ts: 5, tool: 'Edit', inputSummary: '/same.js' },
    { ts: 5, tool: 'Edit', inputSummary: '/same.js' },
    { ts: 5, tool: 'Edit', inputSummary: '/same.js' }, // a third one nothing was tracked for
    { ts: 5, tool: 'Write', inputSummary: '/same.js' }, // another tool
    { ts: 6, tool: 'Edit', inputSummary: '/same.js' }, // another time
  ]);
  assert.equal(out[0].input.old_string, 'first');
  assert.equal(out[1].input.old_string, 'second');
  assert.equal('input' in out[2], false);
  assert.equal('input' in out[3], false);
  assert.equal('input' in out[4], false);
});

test('tracked edits that left the store window are put in front, oldest first; others that match nothing are not', () => {
  const tr = createEditInputTracker();
  tr.record(edit('a1', 30, 3, 'Edit', { file_path: '/second.js' }));
  tr.record(edit('a1', 10, 1, 'Edit', { file_path: '/first.js' }));
  tr.record(edit('a1', 100, 9, 'Edit', { file_path: '/in-window.js' }));
  tr.record(edit('a1', 150, 10, 'Edit', { file_path: '/not-in-the-store.js' })); // newer than the window start, no entry: ignored
  tr.record(edit('a1', 100, 11, 'Edit', { file_path: '/same-time.js' })); // same ts as the first store entry, no match: ignored
  const out = tr.attach(RUN, 'a1', [{ ts: 100, tool: 'Edit', inputSummary: '/in-window.js' }, { ts: 120, text: 'x' }]);
  assert.deepEqual(out.map((e) => e.ts), [10, 30, 100, 120]);
  assert.deepEqual(out.map((e) => e.inputSummary ?? e.text), ['/first.js', '/second.js', '/in-window.js', 'x']);
  assert.equal(out[0].input.file_path, '/first.js');

  // the store holds nothing for the agent: every tracked entry with a time is shown
  const only = tr.attach(RUN, 'a1', []);
  assert.deepEqual(only.map((e) => e.ts), [10, 30, 100, 100, 150]);
});

test('the same transcript line read again is one entry; events without a line number are each their own', () => {
  const tr = createEditInputTracker();
  const e1 = edit('a1', 5, 7, 'Edit', { file_path: '/a.js', old_string: 'x' });
  tr.record(e1);
  tr.record(structuredClone(e1));
  tr.record(edit('a1', 6, null, 'Edit', { file_path: '/b.js' }));
  tr.record(edit('a1', 6, null, 'Edit', { file_path: '/b.js' }));
  const out = tr.attach(RUN, 'a1', []);
  assert.equal(out.filter((e) => e.inputSummary === '/a.js').length, 1);
  assert.equal(out.filter((e) => e.inputSummary === '/b.js').length, 2);
});

test('at most maxPerAgent entries per agent, the oldest go first; other agents and runs are separate', () => {
  const tr = createEditInputTracker({ maxPerAgent: 3 });
  for (let i = 1; i <= 5; i++) tr.record(edit('a1', i, i, 'Edit', { file_path: `/f${i}.js` }));
  tr.record(edit('a2', 1, 1, 'Edit', { file_path: '/other.js' }));
  tr.record({ ...edit('a1', 1, 1, 'Edit', { file_path: '/other-run.js' }), runId: 'wf_other' });
  assert.deepEqual(tr.attach(RUN, 'a1', []).map((e) => e.inputSummary), ['/f3.js', '/f4.js', '/f5.js']);
  assert.deepEqual(tr.attach(RUN, 'a2', []).map((e) => e.inputSummary), ['/other.js']);
  assert.deepEqual(tr.attach('wf_other', 'a1', []).map((e) => e.inputSummary), ['/other-run.js']);
  assert.deepEqual(tr.attach('wf_none', 'a1', []), []);
  assert.deepEqual(createEditInputTracker({ maxPerAgent: 0 }).attach(RUN, 'a1', []), [], 'a bad limit falls back to the default');
});

test('an agent without data.agentId is named by its transcript file, as the reader names it', () => {
  const tr = createEditInputTracker();
  tr.record({ ...edit('zz', 5, 1, 'Edit', { file_path: '/a.js' }), data: { tool: 'Edit', inputSummary: '/a.js', input: { file_path: '/a.js' } }, prov: { file: '/p/agent-abc123.jsonl', line: 4 } });
  assert.equal(tr.attach(RUN, 'abc123', []).length, 1);
  assert.equal(tr.attach(RUN, 'zz', []).length, 0);
});

test('an entry without a time is not matched by a time and is never put in front', () => {
  const tr = createEditInputTracker();
  tr.record({ ...edit('a1', 5, 1, 'Edit', { file_path: '/a.js' }), ts: undefined });
  assert.deepEqual(tr.attach(RUN, 'a1', [{ ts: 100, tool: 'Bash' }]), [{ ts: 100, tool: 'Bash' }]);
  const out = tr.attach(RUN, 'a1', [{ ts: null, tool: 'Edit', inputSummary: '/a.js' }]);
  assert.equal(out[0].input.file_path, '/a.js', 'a null time matches a null time');
});
