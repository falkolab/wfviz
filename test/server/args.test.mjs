// test/server/args.test.mjs (node N5): flag parsing of bin/wfviz.mjs.

import assert from 'node:assert/strict';

import { parseArgv, usage, UsageError, MAX_IDLE_SECONDS } from '../../src/server/args.mjs';
import { test } from './helpers.mjs';

// The result also carries `replay` and `speed` (both undefined unless given) and `offline` (false unless given, P2): the two deepEqual tests below say so.
test('defaults: real mode, no replay, port 0, open the browser, idle 120 s, prices may be fetched', () => {
  assert.deepEqual(parseArgv([]), {
    demo: false, replay: undefined, speed: undefined, port: 0, noOpen: false, root: undefined, sinceHours: undefined, idleSeconds: 120, offline: false, help: false,
  });
});

test('all flags together, in both value spellings', () => {
  // --demo and --replay exclude each other, so the two modes are checked in turn
  const a = parseArgv(['--demo', '--port', '8123', '--no-open', '--root', '/tmp/x', '--since', '6', '--offline', '--idle', '30']);
  assert.deepEqual(a, { demo: true, replay: undefined, speed: undefined, port: 8123, noOpen: true, root: '/tmp/x', sinceHours: 6, idleSeconds: 30, offline: true, help: false });
  const r = parseArgv(['--replay', 'wf_abc', '--speed', '8', '--port', '8123', '--no-open', '--root', '/tmp/x', '--since', '6', '--offline', '--idle', '30']);
  assert.deepEqual(r, { demo: false, replay: 'wf_abc', speed: 8, port: 8123, noOpen: true, root: '/tmp/x', sinceHours: 6, idleSeconds: 30, offline: true, help: false });
  const b = parseArgv(['--port=8124', '--root=/tmp/y', '--since=0.5', '--idle=0']);
  assert.equal(b.port, 8124);
  assert.equal(b.root, '/tmp/y');
  assert.equal(b.sinceHours, 0.5);
  assert.equal(b.idleSeconds, 0);
});

test('--port: 0 and 65535 are valid; everything else is a usage error', () => {
  assert.equal(parseArgv(['--port', '0']).port, 0);
  assert.equal(parseArgv(['--port', '65535']).port, 65535);
  for (const bad of ['65536', '-1', 'abc', '', '1.5', '08080x', '123456', ' 80']) {
    assert.throws(() => parseArgv(['--port', bad]), UsageError, `--port ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseArgv(['--port']), UsageError, 'missing value');
});

test('--since: positive hours, fractions and Infinity allowed', () => {
  assert.equal(parseArgv(['--since', '24']).sinceHours, 24);
  assert.equal(parseArgv(['--since', 'Infinity']).sinceHours, Infinity);
  for (const bad of ['0', '-3', 'abc', '', ' ', 'NaN']) {
    assert.throws(() => parseArgv(['--since', bad]), UsageError, `--since ${JSON.stringify(bad)}`);
  }
});

test('--idle: 0 means never; fractions allowed; negative, text and timer overflow rejected', () => {
  assert.equal(parseArgv(['--idle', '0']).idleSeconds, 0);
  assert.equal(parseArgv(['--idle', '0.5']).idleSeconds, 0.5);
  assert.equal(parseArgv(['--idle', String(MAX_IDLE_SECONDS)]).idleSeconds, MAX_IDLE_SECONDS);
  for (const bad of ['-1', 'abc', '', 'Infinity', String(MAX_IDLE_SECONDS + 1), '99999999999']) {
    assert.throws(() => parseArgv(['--idle', bad]), UsageError, `--idle ${JSON.stringify(bad)}`);
  }
});

test('--root must not be empty', () => {
  assert.throws(() => parseArgv(['--root', '']), UsageError);
  assert.throws(() => parseArgv(['--root']), UsageError);
});

test('unknown flags and positional arguments are usage errors', () => {
  assert.throws(() => parseArgv(['--nope']), UsageError);
  assert.throws(() => parseArgv(['somewhere']), UsageError);
  assert.throws(() => parseArgv(['--open']), UsageError);
});

test('--help and -h', () => {
  assert.equal(parseArgv(['--help']).help, true);
  assert.equal(parseArgv(['-h']).help, true);
  for (const flag of ['--demo', '--replay', '--speed', '--port', '--no-open', '--root', '--since', '--offline', '--idle']) {
    assert.ok(usage().includes(flag), `usage mentions ${flag}`);
  }
});

test('--replay takes a run directory or a run id as text and does not look at it (the parser is pure)', () => {
  assert.equal(parseArgv(['--replay', 'wf_6509ce25-20a']).replay, 'wf_6509ce25-20a');
  assert.equal(parseArgv(['--replay=/some/dir/subagents/workflows/wf_x']).replay, '/some/dir/subagents/workflows/wf_x');
  assert.equal(parseArgv(['--replay', '../x']).replay, '../x', 'whether it is a run is decided later');
  for (const bad of [[], [''], ['  ']]) {
    assert.throws(() => parseArgv(['--replay', ...bad]), UsageError, `--replay ${JSON.stringify(bad)}`);
  }
});

test('--replay and --demo exclude each other, in either order', () => {
  assert.throws(() => parseArgv(['--replay', 'wf_a', '--demo']), { name: 'UsageError', message: /--replay and --demo/ });
  assert.throws(() => parseArgv(['--demo', '--replay', 'wf_a']), { name: 'UsageError', message: /--replay and --demo/ });
});

test('--speed: a number above 0 and only with --replay; the replay source clamps the range, the parser does not', () => {
  const speed = (v) => parseArgv(['--replay', 'wf_a', '--speed', v]).speed;
  assert.equal(speed('8'), 8);
  assert.equal(speed('0.25'), 0.25);
  assert.equal(speed('100'), 100);
  assert.equal(speed('.5'), 0.5);
  assert.equal(speed('1e1'), 10);
  assert.equal(speed('0.001'), 0.001, 'below 0.25 is accepted here; the source clamps it');
  assert.equal(speed('5000'), 5000, 'above 100 is accepted here; the source clamps it');
  assert.equal(parseArgv(['--replay', 'wf_a', '--speed=2']).speed, 2);
  assert.equal(parseArgv(['--replay', 'wf_a']).speed, undefined, 'no --speed: the source default applies');
  for (const bad of ['0', 'abc', '', ' ', 'NaN', 'Infinity', '1e999', '0x10', '1,5', '4x', '+3', '0.0']) {
    assert.throws(() => parseArgv(['--replay', 'wf_a', '--speed', bad]), { name: 'UsageError', message: /--speed must be a number above 0/ }, `--speed ${JSON.stringify(bad)}`);
  }
  for (const bad of ['-1', '-Infinity', '--']) { // the option parser itself refuses a value that looks like a flag
    assert.throws(() => parseArgv(['--replay', 'wf_a', '--speed', bad]), UsageError, `--speed ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseArgv(['--speed']), UsageError, 'missing value');
  assert.throws(() => parseArgv(['--speed', '4']), { name: 'UsageError', message: /--speed only works with --replay/ });
  assert.throws(() => parseArgv(['--demo', '--speed', '4']), { name: 'UsageError', message: /--speed only works with --replay/ });
});

test('a bad --speed is echoed as one JSON string: a newline cannot start a second line of the message', () => {
  assert.throws(() => parseArgv(['--replay', 'wf_a', '--speed', 'x\nwfviz: forged']), (err) => {
    assert.ok(err instanceof UsageError);
    assert.ok(!err.message.includes('\n'), err.message);
    assert.ok(err.message.includes('x\\nwfviz: forged'));
    return true;
  });
});

test('usage text: --replay and --speed say what they take, the speed range and that --speed needs --replay; --root and --since say how replay uses them', () => {
  const text = usage();
  assert.match(text, /--replay <run>[^\n]*run directory\n[^\n]*or a run id/);
  assert.match(text, /--replay <run>[^\n]*\n[^\n]*or a run id[^\n]*\n[^\n]*first browser page connects/, 'the replay starts when a page connects, not when wfviz starts');
  assert.match(text, /--speed <n>[^\n]*default 4[^\n]*0\.25\.\.100[^\n]*only with --replay/);
  assert.match(text, /--root <dir>[^\n]*--replay/);
  assert.match(text, /--since <hours>[^\n]*not used by --replay/);
});

// ---- P2: --offline and the --since line ----------------------------------------------------------------------------

test('--offline: a boolean flag, off unless given, and it takes no value', () => {
  assert.equal(parseArgv([]).offline, false);
  assert.equal(parseArgv(['--offline']).offline, true);
  assert.equal(parseArgv(['--offline', '--no-open']).offline, true, 'with other flags, in either order');
  assert.equal(parseArgv(['--no-open', '--offline']).offline, true);
  assert.throws(() => parseArgv(['--offline=yes']), UsageError, 'a boolean flag with a value is refused');
  assert.throws(() => parseArgv(['--offline', 'yes']), UsageError, 'a positional argument after it is refused');
  assert.equal(parseArgv(['--replay', 'wf_a', '--offline']).offline, true, 'it combines with --replay (the replay is read from files, the prices are not)');
});

test('usage text: --offline says that no price list is fetched and what the page shows instead', () => {
  const line = usage().split('\n').find((l) => l.includes('--offline'));
  assert.ok(line, 'a --offline line');
  assert.match(line, /never fetch/);
  assert.match(line, /price/);
  assert.match(line, /unknown/);
});

test('usage text: the --since line says the new meaning once (every run is listed, --since chooses which are loaded at start) and the old one is gone', () => {
  const text = usage();
  const lines = text.split('\n').filter((l) => l.includes('--since'));
  assert.equal(lines.length, 1, 'one statement about --since');
  assert.match(lines[0], /^ {2}--since <hours> {4}/);
  assert.match(lines[0], /loaded at start/);
  assert.match(lines[0], /every run is listed/);
  assert.match(lines[0], /default: 24/);
  assert.match(lines[0], /Infinity = all/);
  assert.match(lines[0], /not used by --replay/);
  assert.doesNotMatch(text, /only runs changed/, 'the old meaning (a shorter list) is gone');
  assert.doesNotMatch(text, /does not hide/, 'and no note has to correct the line');
});
