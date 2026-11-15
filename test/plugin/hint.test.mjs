// The SessionStart script run as a real child process: what it prints, the off switch, bad input,
// and the exit code.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import { test } from 'node:test';
import { EXPECTED_HINT, OPTION_ENV, cleanEnv, expectedStdout, run } from './helpers.mjs';

const ON_STDOUT = expectedStdout();

function parseOne(stdout) {
  assert.ok(stdout.endsWith('\n'), 'output ends with a line feed');
  assert.equal(stdout.split('\n').length, 2, 'exactly one line of output');
  return JSON.parse(stdout);
}

test('output: one JSON object with only the allowed fields and the exact text', async () => {
  const r = await run({ stdin: '{"hook_event_name":"SessionStart","source":"startup"}' });
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stderr, '');
  const out = parseOne(r.stdout);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(out.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
  assert.equal(out.hookSpecificOutput.additionalContext, EXPECTED_HINT);
  assert.equal(r.stdout, ON_STDOUT);
});

test('text: LF between lines, no leading or trailing newline, ASCII only, under the 10,000 character cap', () => {
  assert.ok(!EXPECTED_HINT.startsWith('\n') && !EXPECTED_HINT.endsWith('\n'));
  assert.ok(!EXPECTED_HINT.includes('\r'));
  assert.match(EXPECTED_HINT, /^[\x20-\x7e\n]+$/);
  const lines = EXPECTED_HINT.split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.slice(1).every((l) => l.startsWith('- ')), 'bullets start at column 0');
  assert.ok(EXPECTED_HINT.length < 10000);
});

// The text is written as factual statements, as the hooks page advises: no line starts with a command.
// The list is this test's own; whole words are compared, so "Labels" or "Passed" are not hits.
const IMPERATIVE_VERBS = ['Label', 'Pass', 'Return', 'Put', 'Use', 'Write', 'Add', 'Make'];

test('text: no line starts with an imperative verb (factual statements, not instructions)', async () => {
  // Both the test's own copy and what the script really prints are checked.
  const r = await run({ stdin: '{"source":"startup"}' });
  assert.equal(r.code, 0);
  const printed = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  for (const [where, text] of [['expected text', EXPECTED_HINT], ['script output', printed]]) {
    const lines = text.split('\n');
    assert.equal(lines.length, 6, `${where}: six lines`);
    for (const [i, line] of lines.entries()) {
      const first = line.replace(/^- /, '').split(' ')[0];
      const hit = IMPERATIVE_VERBS.find((verb) => verb.toLowerCase() === first.toLowerCase());
      assert.ok(!hit, `${where}: line ${i + 1} starts with the imperative verb "${first}": ${line}`);
    }
  }
});

test('the output stays the same for every kind of stdin', async () => {
  const inputs = {
    'valid startup input': '{"session_id":"s1","hook_event_name":"SessionStart","source":"startup","model":"m"}',
    'valid input with source resume': '{"hook_event_name":"SessionStart","source":"resume"}',
    'empty string': '',
    'closed at once': null,
    'invalid JSON': '{bad',
    'only whitespace': '  \n\t\n',
    'JSON null': 'null',
    'JSON array': '[1,2,3]',
    'text, not JSON': 'hello there',
    'a half-written object': '{"source":"start',
    'binary noise, 1 MB': crypto.randomBytes(1_000_000),
  };
  for (const [name, stdin] of Object.entries(inputs)) {
    const r = await run({ stdin });
    assert.equal(r.code, 0, `${name}: exit code`);
    assert.equal(r.signal, null, `${name}: signal`);
    assert.equal(r.stderr, '', `${name}: stderr`);
    assert.equal(r.stdout, ON_STDOUT, `${name}: stdout`);
  }
});

test('off switch: off, 0 and false (any case, with spaces) print nothing and exit 0', async () => {
  for (const value of ['off', 'OFF', 'Off', '0', 'false', 'FALSE', 'False', ' false ', '\toff\n', ' 0 ']) {
    const r = await run({ env: cleanEnv({ [OPTION_ENV]: value }), stdin: '{"source":"startup"}' });
    assert.equal(r.code, 0, `${JSON.stringify(value)}: exit code`);
    assert.equal(r.stdout, '', `${JSON.stringify(value)}: stdout is empty`);
    assert.equal(r.stderr, '', `${JSON.stringify(value)}: stderr is empty`);
  }
});

test('off switch: unset, empty, true, 1, on and other values keep the hint on', async () => {
  const unset = await run({ env: cleanEnv() });
  assert.equal(unset.stdout, ON_STDOUT, 'unset');
  assert.equal(unset.code, 0);
  for (const value of ['', ' ', 'true', 'TRUE', '1', 'on', 'yes', 'garbage', 'offf', 'false0', '00']) {
    const r = await run({ env: cleanEnv({ [OPTION_ENV]: value }) });
    assert.equal(r.code, 0, `${JSON.stringify(value)}: exit code`);
    assert.equal(r.stdout, ON_STDOUT, `${JSON.stringify(value)}: stdout`);
  }
});

test('off switch: the user option is the switch, a WFVIZ_TRACKING_HINT variable does nothing', async () => {
  for (const value of ['off', '0', 'false']) {
    const r = await run({ env: cleanEnv({ WFVIZ_TRACKING_HINT: value }) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, ON_STDOUT, `WFVIZ_TRACKING_HINT=${value} is ignored`);
  }
  // The option wins over the other variable in both directions.
  const off = await run({ env: cleanEnv({ [OPTION_ENV]: 'false', WFVIZ_TRACKING_HINT: 'on' }) });
  assert.equal(off.stdout, '');
});

test('off switch with bad stdin: still nothing and exit 0', async () => {
  const r = await run({ env: cleanEnv({ [OPTION_ENV]: 'false' }), stdin: crypto.randomBytes(200_000) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('exit code is 0 when the reader of stdout has gone away', async () => {
  const r = await run({ closeStdoutEarly: true, stdin: '{"source":"startup"}' });
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stderr, '');
});

test('exit code is 0 for an unusual environment and from another working directory', async () => {
  const r = await run({
    env: cleanEnv({ [OPTION_ENV]: 'x'.repeat(100_000), LANG: 'C', LC_ALL: 'C' }),
    cwd: os.tmpdir(),
    stdin: '{bad',
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, ON_STDOUT);
});
