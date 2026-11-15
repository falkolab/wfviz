// agent.activity `input` (contract 2, section 1): the full tool_use input of Edit, Write, MultiEdit and
// NotebookEdit, as it is; any other tool keeps only inputSummary. An input whose JSON serialisation is
// above 256 KB (262144 bytes) is cut: same shape, the longest strings shortened until it fits,
// inputTruncated: true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { RUN, lines, setup, track } from './run-helpers.mjs';

const LIMIT = 256 * 1024;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const T = '2026-11-08T10:00:00.000Z';

const toolRec = (blocks, id = 'msg_1') => ({
  type: 'assistant', timestamp: T,
  message: { id, content: (Array.isArray(blocks) ? blocks : [blocks]).map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) },
});

// The activity events a transcript of the given assistant records gives, through readRunDir.
async function activities(t, ...records) {
  const f = await setup(t);
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: 'go' } }, ...records));
  const events = await readRunDir(f.sessionDir, RUN);
  return { f, acts: events.filter((e) => e.kind === 'agent.activity').map((e) => e.data), events };
}

const LONG = (n, ch = 'x') => ch.repeat(n);

// ---- which tools, which values ------------------------------------------------------------------------

test('Edit, Write, MultiEdit and NotebookEdit carry their whole input object unchanged; inputSummary stays', async (t) => {
  const inputs = [
    ['Edit', { file_path: '/a/b.js', old_string: 'const a = 1;\nreturn "x";', new_string: 'const a = 2;', replace_all: false }],
    ['Write', { file_path: '/a/new.js', content: 'line 1\nline 2\n' }],
    ['Write', { path: '/a/other.js', file_text: 'wrong field names, still recorded' }],
    ['MultiEdit', { file_path: '/a/c.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true }] }],
    ['NotebookEdit', { notebook_path: '/a/n.ipynb', cell_id: 'c1', new_source: 'print(1)', edit_mode: 'replace', some_future_field: { nested: [1, 2, 3] } }],
  ];
  const { acts } = await activities(t, ...inputs.map(([name, input], i) => toolRec({ name, input }, `m${i}`)));
  assert.equal(acts.length, inputs.length);
  inputs.forEach(([name, input], i) => {
    assert.equal(acts[i].tool, name);
    assert.deepEqual(acts[i].input, input, `${name}: the input as it is, field names not assumed`);
    assert.equal('inputTruncated' in acts[i], false, `${name}: not truncated`);
    assert.ok(acts[i].inputSummary.length <= 200);
  });
  assert.equal(acts[0].inputSummary, '/a/b.js');
  assert.equal(acts[2].inputSummary, '/a/other.js');
});

test('every other tool has no input, only inputSummary (≤ 200 characters)', async (t) => {
  const { acts } = await activities(t,
    toolRec({ name: 'Bash', input: { command: `echo ${LONG(500)}`, description: 'd' } }, 'm1'),
    toolRec({ name: 'Read', input: { file_path: '/a/b.js', offset: 3 } }, 'm2'),
    toolRec({ name: 'Grep', input: { pattern: 'foo', path: '/a' } }, 'm3'),
    toolRec({ name: 'StructuredOutput', input: { verdict: 'pass' } }, 'm4'),
    toolRec({ name: 'edit', input: { file_path: '/a' } }, 'm5'),          // another spelling is another tool
    toolRec({ name: 'mcp__x__Edit', input: { file_path: '/a' } }, 'm6'),
    toolRec({ name: 'Write2', input: { file_path: '/a' } }, 'm7'));
  assert.equal(acts.length, 7);
  for (const a of acts) {
    assert.equal('input' in a, false, `${a.tool}: no full input`);
    assert.equal('inputTruncated' in a, false);
    assert.ok(a.inputSummary.length <= 200);
  }
  assert.equal(acts[0].inputSummary.length, 200);
});

test('an Edit whose input is not an object (a string, null, an array, missing) gets no input field', async (t) => {
  const { acts } = await activities(t,
    toolRec({ name: 'Edit', input: 'just a string' }, 'm1'),
    toolRec({ name: 'Edit', input: null }, 'm2'),
    toolRec({ name: 'Write', input: ['a', 'b'] }, 'm3'),
    toolRec({ name: 'Edit' }, 'm4'));
  assert.equal(acts.length, 4);
  for (const a of acts) {
    assert.equal(a.tool === 'Edit' || a.tool === 'Write', true);
    assert.equal('input' in a, false);
    assert.equal('inputTruncated' in a, false);
  }
});

test('an edit tool after the first tool_use of a record keeps its input in moreTools; other tools stay summaries', async (t) => {
  const edit = { file_path: '/a/b.js', old_string: 'a', new_string: 'b' };
  const big = { file_path: '/a/c.js', content: LONG(LIMIT + 5000) };
  const { acts } = await activities(t, toolRec([
    { name: 'Read', input: { file_path: '/a/b.js' } },
    { name: 'Edit', input: edit },
    { name: 'Write', input: big },
    { name: 'Bash', input: { command: 'ls' } },
  ]));
  assert.equal(acts.length, 1);
  assert.equal('input' in acts[0], false, 'the first tool is Read');
  const [m1, m2, m3] = acts[0].moreTools;
  assert.deepEqual(m1, { tool: 'Edit', inputSummary: '/a/b.js', input: edit });
  assert.equal(m2.tool, 'Write');
  assert.equal(m2.inputTruncated, true);
  assert.ok(bytes(m2.input) <= LIMIT);
  assert.deepEqual(m3, { tool: 'Bash', inputSummary: 'ls' });
});

// ---- the 256 KB cut -----------------------------------------------------------------------------------

test('an input exactly at 262144 bytes is kept whole; one byte more is cut to fit', async (t) => {
  const base = { file_path: '/a/b.js', content: '' };
  const overhead = bytes(base);
  const atLimit = { ...base, content: LONG(LIMIT - overhead) };
  const over = { ...base, content: LONG(LIMIT - overhead + 1) };
  assert.equal(bytes(atLimit), LIMIT);
  assert.equal(bytes(over), LIMIT + 1);
  const { acts } = await activities(t, toolRec({ name: 'Write', input: atLimit }, 'm1'), toolRec({ name: 'Write', input: over }, 'm2'));
  assert.deepEqual(acts[0].input, atLimit);
  assert.equal('inputTruncated' in acts[0], false);
  assert.equal(acts[1].inputTruncated, true);
  assert.equal(bytes(acts[1].input), LIMIT, 'cut to exactly what fits');
  assert.equal(acts[1].input.content, LONG(LIMIT - overhead));
  assert.equal(acts[1].input.file_path, '/a/b.js');
});

test('a Write above 256 KB keeps its shape and its short fields; only the long string is cut, as a prefix', async (t) => {
  const content = Array.from({ length: 40_000 }, (_, i) => `line ${i}`).join('\n'); // ~ 400 KB, with newlines (2 bytes each in JSON)
  const input = { file_path: '/very/long/path/to/the/file.js', content };
  assert.ok(bytes(input) > LIMIT * 1.4);
  const { acts } = await activities(t, toolRec({ name: 'Write', input }));
  const a = acts[0];
  assert.equal(a.inputTruncated, true);
  assert.deepEqual(Object.keys(a.input), ['file_path', 'content']);
  assert.equal(a.input.file_path, input.file_path);
  assert.ok(content.startsWith(a.input.content) && a.input.content.length < content.length && a.input.content.length > 100_000);
  const size = bytes(a.input);
  assert.ok(size <= LIMIT, `fits: ${size}`);
  assert.ok(size > LIMIT - 8, `and is not cut more than needed: ${size}`);
  assert.equal(a.inputSummary, '/very/long/path/to/the/file.js');
  assert.deepEqual(JSON.parse(JSON.stringify(a.input)), a.input, 'plain JSON data');
});

test('several long strings: the longest are cut to one common length, shorter strings stay whole, nesting and other values stay', async (t) => {
  const input = {
    file_path: '/a/b.js',
    edits: [
      { old_string: LONG(300_000, 'o'), new_string: LONG(200_000, 'n'), replace_all: false },
      { old_string: 'short old', new_string: LONG(1000, 's'), replace_all: true },
    ],
    note: { deep: { deeper: [LONG(150_000, 'd'), 'tiny', 7, null, true] } },
    count: 3,
  };
  const { acts } = await activities(t, toolRec({ name: 'MultiEdit', input }));
  const a = acts[0];
  assert.equal(a.inputTruncated, true);
  const out = a.input;
  assert.equal(out.file_path, input.file_path);
  assert.equal(out.count, 3);
  assert.equal(out.edits.length, 2);
  assert.deepEqual(out.edits[1], input.edits[1], 'strings below the cut are untouched');
  assert.equal(out.edits[0].replace_all, false);
  assert.deepEqual(out.note.deep.deeper.slice(1), ['tiny', 7, null, true]);
  const cuts = [out.edits[0].old_string, out.edits[0].new_string, out.note.deep.deeper[0]];
  assert.ok(cuts.every((c) => c.length === cuts[0].length), 'one common length');
  assert.ok(cuts[0].length < 150_000, 'shorter than the shortest of the three long strings');
  assert.ok(input.edits[0].old_string.startsWith(cuts[0]) && input.edits[0].new_string.startsWith(cuts[1]) && input.note.deep.deeper[0].startsWith(cuts[2]));
  const size = bytes(out);
  assert.ok(size <= LIMIT && size > LIMIT - 3 * 4, `fits and nearly full: ${size}`);
});

test('two oversized inputs in one transcript are cut independently', async (t) => {
  const f = await setup(t);
  const input = { file_path: '/a', content: LONG(LIMIT * 2) };
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: 'go' } }, toolRec({ name: 'Write', input }, 'm1'), toolRec({ name: 'Write', input }, 'm2')));
  const events = (await readRunDir(f.sessionDir, RUN)).filter((e) => e.kind === 'agent.activity');
  assert.equal(events.length, 2);
  assert.equal(events[0].data.input.content, events[1].data.input.content);
  assert.equal(events[0].data.input.content.length, events[1].data.input.content.length);
  assert.notEqual(events[0].data.input, events[1].data.input);
});

test('multi-byte text and escapes count as serialised: CJK (3 bytes a character), emoji (4 bytes, 2 units), quotes and newlines', async (t) => {
  const cases = {
    cjk: '日本語のテキスト'.repeat(30_000),
    emoji: '😀x'.repeat(60_000),
    pureEmoji: '😀'.repeat(100_000),
    pureEmoji2: '😀'.repeat(100_001).slice(1) + '😀', // starts with a lone low surrogate
    escapes: '"quoted"\n\t\\'.repeat(40_000),
    mixed: 'abc "d" é 日 😀\n'.repeat(20_000),
  };
  const { acts } = await activities(t, ...Object.entries(cases).map(([k, content], i) => toolRec({ name: 'Write', input: { file_path: `/${k}`, content } }, `m${i}`)));
  Object.entries(cases).forEach(([k, content], i) => {
    const a = acts[i];
    assert.equal(a.inputTruncated, true, k);
    const size = bytes(a.input);
    assert.ok(size <= LIMIT, `${k}: fits (${size})`);
    assert.ok(size > LIMIT - 8, `${k}: nearly full (${size})`);
    assert.ok(content.startsWith(a.input.content), `${k}: a prefix`);
    assert.ok(!/\\ud[89ab]/i.test(JSON.stringify(a.input.content)), `${k}: no half of a surrogate pair`);
    assert.equal(a.input.file_path, `/${k}`);
  });
});

test('an input whose bulk is not strings cannot be cut to fit: no input, inputTruncated, inputSummary kept', async (t) => {
  const input = { file_path: '/a/b.js', edits: Array.from({ length: 20_000 }, () => ({ old_string: 'a', new_string: 'b' })) };
  assert.ok(bytes({ ...input, edits: input.edits.map(() => ({ old_string: '', new_string: '' })) }) > LIMIT);
  const { acts } = await activities(t, toolRec({ name: 'MultiEdit', input }));
  assert.equal(acts[0].inputTruncated, true);
  assert.equal('input' in acts[0], false);
  assert.equal(acts[0].inputSummary, '/a/b.js');
  assert.equal(acts[0].tool, 'MultiEdit');
});

test('a 6 MB Write is cut to 256 KB quickly', async (t) => {
  const content = `${LONG(1000, 'a')}\n`.repeat(6000);
  const t0 = Date.now();
  const { acts } = await activities(t, toolRec({ name: 'Write', input: { file_path: '/big', content } }));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(acts[0].inputTruncated, true);
  assert.ok(bytes(acts[0].input) <= LIMIT);
  assert.ok(bytes(acts[0].input) > LIMIT - 8);
});

test('live and readRunDir give the same activity events, input included', async (t) => {
  const f = await setup(t);
  const small = { file_path: '/a/b.js', old_string: 'a', new_string: 'b' };
  const big = { file_path: '/a/c.js', content: LONG(LIMIT + 1234, 'é') };
  await fsp.writeFile(f.journal, lines({ type: 'launched' }));
  await fsp.writeFile(f.agentFile('a1'), lines({ type: 'user', message: { content: 'go' } }, toolRec({ name: 'Edit', input: small }, 'm1'), toolRec({ name: 'Write', input: big }, 'm2')));
  const { source, events } = track(t, f.root);
  await source.start();
  const replay = await readRunDir(f.sessionDir, RUN);
  assert.deepEqual(events, replay);
  const acts = events.filter((e) => e.kind === 'agent.activity');
  assert.deepEqual(acts[0].data.input, small);
  assert.equal(acts[1].data.inputTruncated, true);
});
