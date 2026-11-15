import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognize } from '../../src/model/recognize.mjs';

// Minimal Run: only what recognize reads (order + agents[].result Facts, and Run.result when given).
function runWith(results, runResult) {
  const agents = {};
  for (const [id, fact] of Object.entries(results)) agents[id] = { id, result: fact };
  const run = { order: Object.keys(results), agents };
  if (runResult !== undefined) run.result = runResult;
  return run;
}
const journal = (id, line, value) => ({ value, prov: 'registered', from: `/run/journal.jsonl:${line}` });
// the Run's own result: the final file's top-level "result"
const FINAL = '/run/workflows/wf_x.json#result';
const finalResult = (value) => ({ value, prov: 'final', from: FINAL });
const noResult = (reason) => ({ value: null, prov: 'unknown', reason });

test('verdict with reason / note / summary, keeps agentId and from', () => {
  const r = recognize(runWith({
    a1: journal('a1', 4, { verdict: 'pass', reason: 'tests green' }),
    a2: journal('a2', 5, { verdict: 'fail', note: 'B saw x=2' }),
    a3: journal('a3', 6, { verdict: 'accept', summary: 'ok overall' }),
    a4: journal('a4', 7, { verdict: 'fix' }),
  }));
  assert.deepEqual(r.verdicts.map((v) => [v.agentId, v.verdict, v.reason, v.from, v.path]), [
    ['a1', 'pass', 'tests green', '/run/journal.jsonl:4', '$'],
    ['a2', 'fail', 'B saw x=2', '/run/journal.jsonl:5', '$'],
    ['a3', 'accept', 'ok overall', '/run/journal.jsonl:6', '$'],
    ['a4', 'fix', undefined, '/run/journal.jsonl:7', '$'],
  ]);
  assert.ok(r.verdicts.every((v) => v.prov === 'inferred' && /^field-name/.test(v.method)));
  assert.ok(r.verdicts.every((v) => v.scope === 'agent'), 'an item found in an agent result has scope "agent"');
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.tests, []);
});

test('reason is taken in the order reason, note, summary', () => {
  const r = recognize(runWith({ a: journal('a', 1, { verdict: 'x', summary: 's', note: 'n', reason: 'r' }) }));
  assert.equal(r.verdicts[0].reason, 'r');
});

test('a non-string verdict is not a verdict', () => {
  const r = recognize(runWith({ a: journal('a', 1, { verdict: true }), b: journal('b', 2, { verdict: 3 }), c: journal('c', 3, { verdict: null }) }));
  assert.deepEqual(r.verdicts, []);
});

test('findings / issues / problems arrays; items need at least one recognised key', () => {
  const r = recognize(runWith({
    rev: journal('rev', 8, {
      findings: [
        { file: 'src/a.mjs', line: 3, input: 'sum([])', description: 'returns NaN', severity: 'high', category: 'logic' },
        { description: 'no file given' },
        { unrelated: 1 },
        'a bare string',
        null,
      ],
    }),
    iss: journal('iss', 9, { issues: [{ title: 'T', extra: 'x' }] }),
    prob: journal('prob', 10, { problems: [{ severity: 'low' }, { line: 0 }] }),
  }));
  assert.deepEqual(r.findings.map((f) => [f.agentId, f.path]), [
    ['rev', '$.findings[0]'], ['rev', '$.findings[1]'], ['iss', '$.issues[0]'], ['prob', '$.problems[0]'], ['prob', '$.problems[1]'],
  ]);
  const first = r.findings[0];
  assert.equal(first.file, 'src/a.mjs');
  assert.equal(first.line, 3);
  assert.equal(first.input, 'sum([])');
  assert.equal(first.description, 'returns NaN');
  assert.equal(first.severity, 'high');
  assert.equal(first.from, '/run/journal.jsonl:8');
  assert.equal('category' in first, false, 'only the recognised fields are copied');
  assert.equal(r.findings[2].title, 'T');
  assert.equal('extra' in r.findings[2], false);
  assert.equal(r.findings[4].line, 0, 'a falsy value is still a value');
});

// ---- findings by shape: an array under any other key, every item an object with `file` and one of line, severity, description, input

test('findings by shape: an array under another key ("missed", as in a judge result) is findings; the method names the keys of the item', () => {
  const r = recognize(runWith({
    j: journal('j', 1, { verdict: 'fix', approved: [0], missed: [{ file: 'a.js', line: 3, description: 'x', category: 'logic' }], dropped: [{ index: 1, reason: 'x' }] }),
  }));
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.deepEqual([f.scope, f.agentId, f.path, f.method, f.prov], ['agent', 'j', '$.missed[0]', 'shape:file+line+description', 'inferred']);
  assert.deepEqual([f.file, f.line, f.description], ['a.js', 3, 'x']);
  assert.equal('category' in f, false, 'only the recognised fields are copied, as for the arrays by name');
  assert.equal(f.from, '/run/journal.jsonl:1');
});

test('findings by shape: another key ("bugs"), with severity and input; the keys are those of the item, in a fixed order, and a key present counts whatever its value', () => {
  const r = recognize(runWith({
    a: journal('a', 1, { bugs: [{ input: 'f([])', severity: 'high', file: 'src/a.mjs' }, { file: null, input: 0 }, { file: 'b', description: '', line: 0, severity: null, input: undefined }] }),
  }));
  assert.deepEqual(r.findings.map((f) => [f.path, f.method]), [
    ['$.bugs[0]', 'shape:file+severity+input'],
    ['$.bugs[1]', 'shape:file+input'],
    ['$.bugs[2]', 'shape:file+line+severity+description+input'],
  ]);
  assert.deepEqual([r.findings[0].file, r.findings[0].severity, r.findings[0].input], ['src/a.mjs', 'high', 'f([])']);
  assert.equal(r.findings[1].file, null, 'a null value is still a value');
});

test('findings by shape: every item must match; items without file, with file only, a mixed array or an empty one are not findings', () => {
  const r = recognize(runWith({
    noFile: journal('noFile', 1, { list: [{ line: 1, description: 'd' }, { severity: 'low' }] }),
    fileOnly: journal('fileOnly', 2, { files: [{ file: 'a' }, { file: 'b' }] }),
    mixedObj: journal('mixedObj', 3, { list: [{ file: 'a', line: 1 }, { line: 2 }] }),
    mixedStr: journal('mixedStr', 4, { list: [{ file: 'a', line: 1 }, 'x'] }),
    mixedNull: journal('mixedNull', 5, { list: [{ file: 'a', line: 1 }, null] }),
    mixedArr: journal('mixedArr', 6, { list: [{ file: 'a', line: 1 }, [{ file: 'a', line: 1 }]] }),
    oneBad: journal('oneBad', 7, { list: [{ file: 'a' }] }),
    empty: journal('empty', 8, { list: [] }),
    strings: journal('strings', 9, { list: ['a.js:1', 'b.js:2'] }),
    other: journal('other', 10, { list: [{ name: 'a', path: 'b', note: 'c' }] }),
  }));
  assert.deepEqual(r.findings, []);
});

test('findings by shape: an array under findings / issues / problems is by name only and never also by shape; a top-level array and an array inside an array are not matched', () => {
  const r = recognize(runWith({
    byName: journal('byName', 1, { findings: [{ file: 'a', line: 1 }], Issues: [{ file: 'b', severity: 'low' }], problems: [{ title: 'only a title' }] }),
    top: journal('top', 2, [{ file: 'a', line: 1 }]),
    nested: journal('nested', 3, { list: [[{ file: 'a', line: 1 }]] }),
  }));
  assert.deepEqual(r.findings.map((f) => [f.agentId, f.path, f.method]), [
    ['byName', '$.findings[0]', 'field-name:findings'],
    ['byName', '$.Issues[0]', 'field-name:issues'],
    ['byName', '$.problems[0]', 'field-name:problems'],
  ], 'one item, one rule: no item is listed twice, and a title alone is a finding by name, not by shape');
});

test('findings by shape: found at any place the other kinds are found (three object levels, through arrays), with a bracket path for an odd key', () => {
  const at = (n, leaf) => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { wrap: v };
    return v;
  };
  const items = [{ file: 'a', line: 1 }];
  const r = recognize(runWith({
    d3: journal('d3', 1, at(3, { low: items })),
    d4: journal('d4', 2, at(4, { low: items })),
    arr: journal('arr', 3, { runs: [{ 'odd key': items }] }),
  }));
  assert.deepEqual(r.findings.map((f) => [f.agentId, f.path]), [['d3', '$.wrap.wrap.wrap.low[0]'], ['arr', '$.runs[0]["odd key"][0]']]);
});

test('findings by shape: the rule is the shape, not a key name; a key named like our own lists means nothing by itself', () => {
  const list = [{ file: 'a', line: 1, description: 'd' }];
  const names = ['missed', 'low', 'confirmed', 'bugs', 'x', 'Q-1', ''];
  const r = recognize(runWith(Object.fromEntries(names.map((n, i) => [`a${i}`, journal(`a${i}`, i + 1, { [n]: list })]))));
  assert.equal(r.findings.length, names.length);
  assert.ok(r.findings.every((f) => f.method === 'shape:file+line+description'));
});

test('field names match case-insensitively for the arrays, exactly for verdict', () => {
  const r = recognize(runWith({ a: journal('a', 1, { Findings: [{ file: 'f' }], Verdict: 'pass' }) }));
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.verdicts, []);
});

test('tests: object `tests` with numeric counts', () => {
  const r = recognize(runWith({ t: journal('t', 3, { tests: { passed: 5, failed: 1, skipped: 0, total: 6, tail: 'x' } }) }));
  assert.equal(r.tests.length, 1);
  const t = r.tests[0];
  assert.deepEqual([t.agentId, t.path, t.passed, t.failed, t.skipped, t.total], ['t', '$.tests', 5, 1, 0, 6]);
  assert.equal(t.from, '/run/journal.jsonl:3');
  assert.equal('tail' in t, false);
});

test('tests: top-level passed/failed/skipped, total optional', () => {
  const r = recognize(runWith({ t: journal('t', 3, { passed: 7, failed: 0 }), u: journal('u', 4, { skipped: 2 }) }));
  assert.deepEqual(r.tests.map((t) => [t.agentId, t.path, t.passed, t.failed, t.skipped, t.total]), [
    ['t', '$', 7, 0, undefined, undefined],
    ['u', '$', undefined, undefined, 2, undefined],
  ]);
});

test('tests: non-numeric or non-count shapes are not test results', () => {
  const r = recognize(runWith({
    a: journal('a', 1, { tests: { passed: '5', failed: '0' } }),
    b: journal('b', 2, { tests: 'ok' }),
    c: journal('c', 3, { tests: [1, 2] }),
    d: journal('d', 4, { exitCode: 0, outputTail: 'all 3 passed' }),
    e: journal('e', 5, { tests: { total: 4 } }),
    f: journal('f', 6, { nested: { passed: 3, failed: 0 } }),
  }));
  assert.deepEqual(r.tests, []);
});

// ---- contract 2, item 8: tests from a node --test summary inside a string

const SPEC_SUMMARY = ['ℹ tests 558', 'ℹ suites 1', 'ℹ pass 558', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 37038.4'].join('\n');
const TAP_SUMMARY = ['# tests 12', '# suites 2', '# pass 10', '# fail 2', '# cancelled 0', '# skipped 1', '# todo 3', '# duration_ms 912.1'].join('\n');

test('node --test summary: a string result with the spec reporter lines ("ℹ pass N") gives a tests item', () => {
  const r = recognize(runWith({ t: journal('t', 3, `> node --test test/\n...\n${SPEC_SUMMARY}\n`) }));
  assert.deepEqual(r.tests, [{
    scope: 'agent', agentId: 't', from: '/run/journal.jsonl:3', path: '$', passed: 558, failed: 0, skipped: 0, todo: 0,
    prov: 'inferred', method: 'node-test-summary',
  }]);
  assert.deepEqual([r.verdicts, r.findings], [[], []]);
});

test('node --test summary: the tap reporter lines ("# pass N") too, with fail, skipped and todo', () => {
  const r = recognize(runWith({ t: journal('t', 3, `TAP version 13\n${TAP_SUMMARY}`) }));
  assert.deepEqual(r.tests.map((t) => [t.passed, t.failed, t.skipped, t.todo, t.method, t.prov]), [[10, 2, 1, 3, 'node-test-summary', 'inferred']]);
});

test('node --test summary: a string field of an object result, with its path', () => {
  const r = recognize(runWith({
    f: journal('f', 4, { exitCode: 0, outputTail: SPEC_SUMMARY }),
    g: journal('g', 5, { run: { output: TAP_SUMMARY } }),
  }));
  assert.deepEqual(r.tests.map((t) => [t.agentId, t.path, t.passed, t.failed]), [['f', '$.outputTail', 558, 0], ['g', '$.run.output', 10, 2]]);
});

test('node --test summary: only the lines that are there are reported; "pass" starts a summary, the lines before it are not one', () => {
  const r = recognize(runWith({
    a: journal('a', 1, '# pass 7'),
    b: journal('b', 2, 'ℹ pass 4\nℹ fail 1'),
    c: journal('c', 3, 'ℹ fail 1\nℹ skipped 2'),
    d: journal('d', 4, 'ℹ todo 5'),
  }));
  assert.deepEqual(r.tests.map((t) => [t.agentId, t.passed, t.failed, t.skipped, t.todo]), [['a', 7, undefined, undefined, undefined], ['b', 4, 1, undefined, undefined]]);
  for (const t of r.tests) for (const k of ['failed', 'skipped', 'todo']) if (t[k] === undefined) assert.equal(k in t, false, `no ${k} key when the summary has no such line`);
});

test('node --test summary: two summaries in one string are two items; the first fail/skipped/todo after a pass belong to it', () => {
  const r = recognize(runWith({ t: journal('t', 3, `${SPEC_SUMMARY}\n...\n${TAP_SUMMARY}`) }));
  assert.deepEqual(r.tests.map((t) => [t.passed, t.failed, t.skipped, t.todo]), [[558, 0, 0, 0], [10, 2, 1, 3]]);
});

test('node --test summary: the line must be the whole line; prose, words, signs and non-numbers are not summaries', () => {
  const r = recognize(runWith({
    a: journal('a', 1, 'we had pass 5 and ℹ pass 5 tests'),
    b: journal('b', 2, 'ℹ passed 5'),
    c: journal('c', 3, 'ℹ pass five'),
    d: journal('d', 4, '- pass 5'),
    e: journal('e', 5, 'ℹ pass 5 of 6'),
    f: journal('f', 6, '## pass 5'),
  }));
  assert.deepEqual(r.tests, []);
});

test('node --test summary: indented lines and Windows line ends are read', () => {
  const r = recognize(runWith({ t: journal('t', 3, '  ℹ pass 3\r\n  ℹ fail 1\r\n') }));
  assert.deepEqual(r.tests.map((t) => [t.passed, t.failed]), [[3, 1]]);
});

test('node --test summary: depth is the same as for the other kinds (objects up to three levels below the result)', () => {
  const at = (n, leaf) => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { wrap: v };
    return v;
  };
  const r = recognize(runWith({
    d3: journal('d3', 1, at(3, { out: 'ℹ pass 1' })),
    d4: journal('d4', 2, at(4, { out: 'ℹ pass 2' })),
    arr: journal('arr', 3, { runs: [{ out: 'ℹ pass 3' }] }),
  }));
  assert.deepEqual(r.tests.map((t) => [t.agentId, t.path, t.passed]), [['d3', '$.wrap.wrap.wrap.out', 1], ['arr', '$.runs[0].out', 3]]);
});

test('node --test summary: a string inside an array is not a field; an unknown or non-text result gives nothing', () => {
  const r = recognize(runWith({
    arr: journal('arr', 1, ['ℹ pass 1']),
    inArr: journal('inArr', 2, { lines: ['ℹ pass 2'] }),
    unk: { value: null, prov: 'unknown', reason: 'agent has not produced a result yet' },
    num: journal('num', 4, 5),
  }));
  assert.deepEqual(r.tests, []);
});

test('node --test summary: a final-file preview (a string Fact with prov final) is recognised like a registered result', () => {
  const r = recognize(runWith({ t: { value: SPEC_SUMMARY, prov: 'final', from: '/run/final.json#workflowProgress[1].resultPreview' } }));
  assert.deepEqual(r.tests.map((t) => [t.agentId, t.from, t.passed]), [['t', '/run/final.json#workflowProgress[1].resultPreview', 558]]);
});

test('node --test summary: a result with both numeric counts and a summary string gives both items', () => {
  const r = recognize(runWith({ t: journal('t', 3, { passed: 2, failed: 0, outputTail: 'ℹ pass 2' }) }));
  assert.deepEqual(r.tests.map((t) => [t.path, t.method]), [['$', 'field-name:passed/failed/skipped'], ['$.outputTail', 'node-test-summary']]);
});

test('depth: found at three object levels below the result, not at four; arrays are transparent', () => {
  const at = (n, leaf) => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { wrap: v };
    return v;
  };
  const r = recognize(runWith({
    d0: journal('d0', 1, at(0, { verdict: 'v0' })),
    d3: journal('d3', 2, at(3, { verdict: 'v3' })),
    d4: journal('d4', 3, at(4, { verdict: 'v4' })),
    arr: journal('arr', 4, { items: [{ review: { verdict: 'va' } }] }),
  }));
  assert.deepEqual(r.verdicts.map((v) => [v.agentId, v.verdict]), [['d0', 'v0'], ['d3', 'v3'], ['arr', 'va']]);
  assert.equal(r.verdicts.find((v) => v.agentId === 'd3').path, '$.wrap.wrap.wrap');
  assert.equal(r.verdicts.find((v) => v.agentId === 'arr').path, '$.items[0].review');
});

test('findings and tests nested inside another object are found', () => {
  const r = recognize(runWith({
    n: journal('n', 1, { review: { findings: [{ file: 'a.js', line: 1 }], tests: { passed: 1, failed: 0 } }, verdict: 'fail' }),
  }));
  assert.deepEqual(r.findings.map((f) => f.path), ['$.review.findings[0]']);
  assert.deepEqual(r.tests.map((t) => t.path), ['$.review.tests']);
  assert.equal(r.verdicts[0].path, '$');
});

test('an array result is searched; string, number and null results and unknown facts are skipped', () => {
  const r = recognize(runWith({
    arr: journal('arr', 1, [{ verdict: 'pass' }, { verdict: 'fail' }]),
    str: journal('str', 2, 'verdict: pass'),
    num: journal('num', 3, 5),
    nul: journal('nul', 4, null),
    unk: { value: null, prov: 'unknown', reason: 'agent has not produced a result yet' },
    fin: { value: '{"verdict":"pass"}', prov: 'final', from: '/run/final.json#x' },
  }));
  assert.deepEqual(r.verdicts.map((v) => [v.agentId, v.path]), [['arr', '$[0]'], ['arr', '$[1]']]);
});

test('odd keys get bracket paths; empty or missing runs give empty lists', () => {
  const r = recognize(runWith({ a: journal('a', 1, { 'odd key': { verdict: 'v' } }) }));
  assert.equal(r.verdicts[0].path, '$["odd key"]');
  assert.deepEqual(recognize({}), { findings: [], verdicts: [], tests: [] });
  assert.deepEqual(recognize(null), { findings: [], verdicts: [], tests: [] });
  assert.deepEqual(recognize({ order: [], agents: {} }), { findings: [], verdicts: [], tests: [] });
});

test('items follow run.order', () => {
  const run = runWith({ x: journal('x', 1, { verdict: 'a' }), y: journal('y', 2, { verdict: 'b' }) });
  run.order = ['y', 'x'];
  assert.deepEqual(recognize(run).verdicts.map((v) => v.agentId), ['y', 'x']);
});

test('a self-referencing result does not hang', () => {
  const loop = { verdict: 'v' };
  loop.self = loop;
  const r = recognize(runWith({ a: journal('a', 1, loop) }));
  assert.ok(r.verdicts.length >= 1 && r.verdicts.length <= 5);
});

// ---- scope: the same rules over the Run's own result (the final file's "result")

test('run result: verdicts, findings and tests are recognised with scope "run", agentId null and from the final file; the agents\' items keep their scope', () => {
  const run = runWith({ a: journal('a', 1, { verdict: 'pass' }) }, finalResult({
    verdict: 'fail', note: 'overall',
    findings: [{ file: 'x.js', line: 2, severity: 'high' }],
    tests: { passed: 4, failed: 1, skipped: 0 },
  }));
  const r = recognize(run);
  assert.deepEqual(r.verdicts.map((v) => [v.scope, v.agentId, v.from, v.path, v.verdict, v.reason]), [
    ['agent', 'a', '/run/journal.jsonl:1', '$', 'pass', undefined],
    ['run', null, FINAL, '$', 'fail', 'overall'],
  ], 'the agents\' items come first, then the run\'s');
  assert.deepEqual(r.findings.map((f) => [f.scope, f.agentId, f.from, f.path, f.method, f.file, f.line, f.severity]), [['run', null, FINAL, '$.findings[0]', 'field-name:findings', 'x.js', 2, 'high']]);
  assert.deepEqual(r.tests.map((t) => [t.scope, t.agentId, t.from, t.path, t.method, t.passed, t.failed, t.skipped, t.prov]), [['run', null, FINAL, '$.tests', 'field-name:tests', 4, 1, 0, 'inferred']]);
});

test('run result: the same limits as an agent result (three object levels, arrays transparent), top-level counts and a node --test summary in a string', () => {
  const at = (n, leaf) => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = { wrap: v };
    return v;
  };
  const r = recognize(runWith({}, finalResult({
    d3: at(2, { verdict: 'v3', out: 'ℹ pass 7\nℹ fail 1' }),
    d4: at(3, { verdict: 'v4' }),
    list: [{ review: { verdict: 'va' } }],
    passed: 2, failed: 0,
  })));
  assert.deepEqual(r.verdicts.map((v) => [v.path, v.verdict]), [['$.d3.wrap.wrap', 'v3'], ['$.list[0].review', 'va']], 'three levels below the result (d3, wrap, wrap) yes, four (d4) no');
  assert.deepEqual(r.tests.map((t) => [t.path, t.method, t.passed, t.failed]), [
    ['$', 'field-name:passed/failed/skipped', 2, 0],
    ['$.d3.wrap.wrap.out', 'node-test-summary', 7, 1],
  ]);
  assert.ok([...r.verdicts, ...r.tests].every((x) => x.scope === 'run' && x.agentId === null && x.from === FINAL));
  // a string result is a text like an agent's
  const t = recognize(runWith({}, finalResult('> node --test\nℹ pass 12\nℹ fail 0\n'))).tests;
  assert.deepEqual(t.map((x) => [x.scope, x.path, x.passed, x.failed]), [['run', '$', 12, 0]]);
});

test('run result: the shape rule runs over it too ("low" and "missed" lists of a result)', () => {
  const r = recognize(runWith({}, finalResult({ rounds: [{ low: [{ file: 'a', line: 1, input: 'i', description: 'd', severity: 's' }] }], missed: [{ file: 'b', description: 'd' }] })));
  assert.deepEqual(r.findings.map((f) => [f.scope, f.path, f.method]), [
    ['run', '$.missed[0]', 'shape:file+description'],
    ['run', '$.rounds[0].low[0]', 'shape:file+line+severity+description+input'],
  ], 'the arrays of an object come before what is found inside its children');
});

test('run result: nothing is added for a Run without a result, with an unknown or null one, or with a number, a boolean or an empty object', () => {
  const agentOnly = { order: ['a'], agents: { a: { id: 'a', result: journal('a', 1, { verdict: 'v' }) } } };
  const want = recognize(agentOnly);
  for (const result of [undefined, noResult('final file has "result": null'), finalResult(null), finalResult(5), finalResult(true), finalResult({}), finalResult([]), null, 'text']) {
    const run = { ...agentOnly };
    if (result !== undefined) run.result = result;
    assert.deepEqual(recognize(run), want, JSON.stringify(result));
  }
  assert.deepEqual(recognize({ order: [], agents: {}, result: finalResult({ verdict: 'v' }) }).verdicts.map((v) => v.scope), ['run']);
  assert.deepEqual(recognize({ result: finalResult({ verdict: 'v' }) }).verdicts.map((v) => [v.scope, v.agentId]), [['run', null]], 'a Run with no agents field still has its result read');
  assert.deepEqual(recognize({ result: noResult('x') }), { findings: [], verdicts: [], tests: [] });
});

test('run result: the same findings in an agent and in the run result are two items, each in its scope; nothing is merged and Run.result is not changed', () => {
  const body = { findings: [{ file: 'a', line: 1 }], verdict: 'fix' };
  const value = JSON.parse(JSON.stringify(body));
  const frozen = Object.freeze(value);
  const r = recognize(runWith({ a: journal('a', 1, body) }, finalResult(frozen)));
  assert.deepEqual(r.findings.map((f) => f.scope), ['agent', 'run']);
  assert.deepEqual(r.verdicts.map((f) => f.scope), ['agent', 'run']);
  assert.deepEqual(frozen, body, 'the result is read, not written');
});

test('run result: a self-referencing result does not hang, and every item of it is of scope "run"', () => {
  const loop = { verdict: 'v' };
  loop.self = loop;
  const r = recognize(runWith({}, finalResult(loop)));
  assert.ok(r.verdicts.length >= 1 && r.verdicts.length <= 5);
  assert.ok(r.verdicts.every((v) => v.scope === 'run' && v.agentId === null));
});
