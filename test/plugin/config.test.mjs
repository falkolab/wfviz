// The plugin's files: manifest, hooks config, script source, README, and the rules that keep the
// text universal (no name from this project's own method) and in step with docs/contract.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import os from 'node:os';
import { EXPECTED_HINT, PLUGIN_DIR, ROOT, SCRIPT, expectedStdout, listFiles, run, cleanEnv } from './helpers.mjs';

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ...parts), 'utf8'));
const readText = (...parts) => fs.readFileSync(path.join(PLUGIN_DIR, ...parts), 'utf8');

test('plugin/ holds exactly the four planned files (no marketplace, no extra script)', () => {
  assert.deepEqual(listFiles(PLUGIN_DIR), [
    '.claude-plugin/plugin.json',
    'README.md',
    'hooks/hooks.json',
    'scripts/session-start.mjs',
  ]);
});

test('the file list ignores OS metadata (.DS_Store and the like) but still shows any other extra file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-plugin-list-'));
  try {
    const copy = path.join(tmp, 'plugin');
    fs.cpSync(PLUGIN_DIR, copy, { recursive: true });
    const planned = listFiles(copy);
    assert.deepEqual(planned, listFiles(PLUGIN_DIR));
    for (const rel of ['.DS_Store', 'scripts/.DS_Store', '.claude-plugin/.DS_Store', '._README.md', 'Thumbs.db', 'desktop.ini']) {
      fs.writeFileSync(path.join(copy, rel), 'metadata, not part of the plugin');
    }
    assert.deepEqual(listFiles(copy), planned, 'metadata files are not listed');
    for (const rel of ['marketplace.json', '.env', 'scripts/extra.mjs', 'DS_Store']) {
      fs.writeFileSync(path.join(copy, rel), 'an unplanned file');
      assert.ok(listFiles(copy).includes(rel), `${rel} is still listed`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manifest: name, description, version, the trackingHint option and the publication fields; nothing invented', () => {
  const manifest = readJson('.claude-plugin', 'plugin.json');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['author', 'description', 'homepage', 'license', 'name', 'repository', 'userConfig', 'version']);
  // author, license and links were given by the user when the project was published (2026-11-15); they follow package.json
  assert.deepEqual(manifest.author, { name: 'Andrey Tkachenko' });
  assert.equal(manifest.license, pkg.license);
  assert.equal(manifest.homepage, pkg.homepage);
  assert.equal(manifest.repository, 'https://github.com/falkolab/wfviz');
  assert.equal(manifest.name, 'wfviz');
  assert.equal(manifest.description, pkg.description);
  assert.equal(manifest.version, pkg.version);
  // userConfig options are strict objects: an unknown key stops the plugin from loading.
  assert.deepEqual(Object.keys(manifest.userConfig), ['trackingHint']);
  const option = manifest.userConfig.trackingHint;
  assert.deepEqual(Object.keys(option).sort(), ['default', 'description', 'title', 'type']);
  assert.equal(option.type, 'boolean');
  assert.equal(option.default, true);
  assert.equal(typeof option.title, 'string');
  assert.ok(option.title.length > 0);
  assert.equal(typeof option.description, 'string');
  assert.ok(option.description.length > 0);
});

test('manifest has no hooks key: the hooks file is loaded by itself, a second registration would run the hint twice', () => {
  const manifest = readJson('.claude-plugin', 'plugin.json');
  assert.ok(!('hooks' in manifest));
});

// The documented rule for a plain-word matcher: an exact string, or a list of exact strings
// separated by "|" or ",", with optional surrounding whitespace.
const matcherFires = (matcher, source) => matcher.split(/[|,]/).map((s) => s.trim()).includes(source);

test('hooks config: SessionStart only, one group with matcher "startup", one node command in exec form', () => {
  const config = readJson('hooks', 'hooks.json');
  assert.deepEqual(Object.keys(config), ['hooks'], 'top-level "hooks" wrapper');
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart']);
  const groups = config.hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.deepEqual(Object.keys(groups[0]).sort(), ['hooks', 'matcher']);
  assert.equal(groups[0].matcher, 'startup');
  assert.equal(groups[0].hooks.length, 1);
  const handler = groups[0].hooks[0];
  assert.deepEqual(Object.keys(handler).sort(), ['args', 'command', 'type']);
  assert.equal(handler.type, 'command');
  assert.equal(handler.command, 'node');
  assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs']);
});

test('hooks config: the matcher fires for a new session only', () => {
  const { matcher } = readJson('hooks', 'hooks.json').hooks.SessionStart[0];
  assert.ok(matcherFires(matcher, 'startup'));
  for (const other of ['resume', 'clear', 'compact', 'fork']) {
    assert.ok(!matcherFires(matcher, other), `must not fire on ${other}`);
  }
});

test('hooks config: the named script exists and, started the way the config says, prints the hint', async () => {
  const handler = readJson('hooks', 'hooks.json').hooks.SessionStart[0].hooks[0];
  const args = handler.args.map((a) => a.split('${CLAUDE_PLUGIN_ROOT}').join(PLUGIN_DIR));
  assert.ok(args.every((a) => !a.includes('${')), 'no other placeholder is left');
  assert.equal(path.resolve(args[0]), SCRIPT);
  assert.ok(fs.statSync(args[0]).isFile(), `${args[0]} exists`);
  const r = await run({ command: handler.command, args, env: cleanEnv({ CLAUDE_PLUGIN_ROOT: PLUGIN_DIR }), stdin: '{"source":"startup"}' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, expectedStdout());
});

test('script source: imports nothing, so no file, network or process access; never exit code 2', () => {
  const source = readText('scripts', 'session-start.mjs');
  const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  const banned = [
    /\bimport\b/, /\brequire\b/, /node:/, /\bfs\b/, /\bchild_process\b/, /\bnet\b/, /\bhttps?\b/, /\bdns\b/,
    /\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bprocess\.stdin\b/, /\bprocess\.exit\b/,
    /\breadFile/, /\bwriteFile/, /\bappendFile/, /\bspawn/, /\bexec/, /\beval\b/, /\bFunction\(/,
  ];
  for (const re of banned) assert.ok(!re.test(code), `script must not contain ${re}`);
  assert.ok(!/exitCode\s*=\s*[1-9]/.test(code), 'exit code is never set above 0');
  assert.ok(/process\.exitCode\s*=\s*0/.test(code), 'exit code is set to 0');
  // The only environment variable it reads.
  const vars = [...code.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(vars)], ['CLAUDE_PLUGIN_OPTION_TRACKINGHINT']);
  // Output: one write, no console.
  assert.equal((code.match(/process\.stdout\.write\(/g) ?? []).length, 1);
  assert.ok(!/console\./.test(code));
  // No other output field is ever set as an object key. (The word "decision" is in the text, as a
  // plain word; the output keys themselves are pinned in hint.test.mjs.)
  for (const field of ['decision', 'permission', 'permissionDecision', 'updatedInput', 'systemMessage', 'continue', 'stopReason', 'suppressOutput', 'sessionTitle', 'initialUserMessage', 'watchPaths', 'reloadSkills']) {
    assert.ok(!new RegExp(`\\b${field}\\s*:`).test(code), `script must not set ${field}`);
  }
});

// Names from this project's own way of working must not appear in what the plugin says or ships.
const METHOD_NAMES = [/guide/i, /judge/i, /fix/i, /reviewer/i, /implement/i, /dev-graph/i, /graph\.md/i, /AGENTS/, /docs\//i];
const NODE_CODE = /\b[A-Z][0-9]{1,2}\b/;

test('the text names no role, label, phase or file of this project', () => {
  for (const re of METHOD_NAMES) assert.ok(!re.test(EXPECTED_HINT), `text must not match ${re}`);
  assert.ok(!NODE_CODE.test(EXPECTED_HINT), 'text holds no node code');
  // "role" and "phase" appear only as generic words.
  assert.ok(/<role>:<unit>/.test(EXPECTED_HINT));
  assert.ok(/A phase passed to each agent/.test(EXPECTED_HINT));
});

test('no file under plugin/ names a role, label, phase or file of this project', () => {
  for (const rel of listFiles(PLUGIN_DIR)) {
    const text = readText(...rel.split('/'));
    for (const re of METHOD_NAMES) assert.ok(!re.test(text), `${rel} must not match ${re}`);
    assert.ok(!NODE_CODE.test(text), `${rel} holds no node code`);
  }
});

// Every field name the text mentions must be one that docs/contract.md section 3 recognises.
function contractSection(heading, next) {
  const md = fs.readFileSync(path.join(ROOT, 'docs', 'contract.md'), 'utf8');
  const start = md.indexOf(heading);
  const end = md.indexOf(next, start);
  assert.ok(start >= 0 && end > start, `contract has ${heading} and ${next}`);
  return md.slice(start, end);
}

test('every field name in the text appears in docs/contract.md section 3', () => {
  const resultLines = EXPECTED_HINT.split('\n').filter((l) => l.includes('"findings"'));
  assert.equal(resultLines.length, 1, 'exactly one line holds the result field names');
  const resultLine = resultLines[0];
  const quoted = [...resultLine.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const braced = [...resultLine.matchAll(/\{ ([^}]+) \}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const names = [...new Set([...quoted, ...braced])];
  assert.deepEqual(names.sort(), [
    'description', 'failed', 'file', 'findings', 'line', 'passed', 'reason', 'severity', 'skipped', 'tests', 'verdict',
  ]);
  const section3 = contractSection('## 3. Recognised result fields', '## 4.');
  for (const name of names) {
    assert.ok(section3.includes(`\`${name}\``), `contract section 3 lists \`${name}\``);
  }
});

test('the label convention matches docs/contract.md section 2 (role:unit, #r<n> for a round)', () => {
  const section2 = contractSection('## 2. Run', '## 3.');
  assert.ok(section2.includes('`role:unit#tag`'));
  assert.ok(section2.includes('`#r<n>`'));
  assert.ok(section2.includes('inferred, never required'));
});

test('README: what it does, install commands as the plugin pages give them, off switch, never blocks', () => {
  const readme = readText('README.md');
  for (const needle of [
    'claude --plugin-dir ./plugin',
    '/plugin marketplace add falkolab/wfviz',
    '/plugin install wfviz@falkolab',
    'claude plugin install wfviz@falkolab',
    '--config trackingHint=false',
    'trackingHint',
    'CLAUDE_PLUGIN_OPTION_TRACKINGHINT',
    '`startup`',
    'SessionStart',
    'additionalContext',
    'never blocks',
    'exit code is always 0',
  ]) {
    assert.ok(readme.toLowerCase().includes(needle.toLowerCase()), `README says: ${needle}`);
  }
  // The README says the option is the off switch, not an environment variable of the plugin's own.
  assert.ok(!readme.includes('WFVIZ_TRACKING_HINT'));
  // It does not promise that the model follows the note.
  assert.ok(/cannot promise/.test(readme));
});

// The plugin pages: `claude plugin configure <plugin>` alone only lists the options and whether each is
// set; saving from the shell needs --values-stdin with a JSON object of single-line strings. A README
// that offers the bare command as a way to set trackingHint changes nothing and leaves the hint on.
test('README off switch: every way to set trackingHint is one the plugin pages give and that saves', () => {
  const readme = readText('README.md');
  // In a session: the documented dialog command.
  assert.ok(readme.includes('/plugin configure wfviz@falkolab'));
  // From the shell: the command is named only with a flag, on the same line.
  const shellLines = readme.split('\n').filter((l) => l.includes('claude plugin configure'));
  assert.ok(shellLines.length >= 2, 'the shell command is shown');
  for (const line of shellLines) {
    assert.ok(/--values-stdin|--json/.test(line), `a line names claude plugin configure without a flag: ${line}`);
  }
  // The saving form: a JSON object of single-line strings, piped in.
  const saving = shellLines.find((l) => l.includes('--values-stdin') && l.includes('{'));
  assert.ok(saving, 'one line pipes the JSON object into --values-stdin');
  const json = saving.slice(saving.indexOf('{'), saving.lastIndexOf('}') + 1);
  const values = JSON.parse(json);
  assert.deepEqual(Object.keys(values), ['trackingHint']);
  assert.equal(typeof values.trackingHint, 'string', 'the plugin pages say values are strings');
  assert.ok(['off', '0', 'false'].includes(values.trackingHint), 'the value turns the hint off');
  // The README says the bare command saves nothing, and names the version that has the command.
  assert.ok(/saves nothing/.test(readme));
  assert.ok(/only lists/.test(readme));
  assert.ok(readme.includes('2.1.285'));
});

// The hooks page says additionalContext goes into a system reminder that is not shown as a chat message,
// and advises writing the text as factual statements. The hint text is written that way, and the README
// says so in one sentence, shows the text itself, and claims no delivery check.
test('README shows the text once, states what the hooks page says about additionalContext, and that the text is factual', () => {
  const raw = readText('README.md');
  // The text itself, character for character with its line breaks (the whitespace-normalised copy below
  // would hide a wrapped line), once, in a fenced block: outside code, "<role>" would be read as an HTML tag.
  assert.ok(raw.includes(EXPECTED_HINT), 'README holds the exact text, all six lines');
  assert.equal(raw.split(EXPECTED_HINT).length - 1, 1, 'the text is shown once');
  const at = raw.indexOf(EXPECTED_HINT);
  assert.ok(raw.slice(0, at).endsWith('```\n'), 'a code fence opens right before the text');
  assert.ok(raw.slice(at + EXPECTED_HINT.length).startsWith('\n```'), 'a code fence closes right after the text');
  const readme = raw.replace(/\s+/g, ' ');
  for (const needle of [
    'system reminder',
    'does not appear as a chat message',
    'debug log',
    'written as factual statements',
    'as the hooks page advises',
  ]) {
    assert.ok(readme.includes(needle), `README says: ${needle}`);
  }
  // The old paragraphs about the risk of imperative wording are gone: they contradict the new text.
  for (const gone of [
    'imperative system instructions',
    'prompt-injection',
    'instead of using it as context',
    'most of its lines are instructions',
    'approved as written',
    'show you the note instead of using it',
    'shows it to you',
  ]) {
    assert.ok(!readme.includes(gone), `README no longer says: ${gone}`);
  }
  // It names the debug log as the way to check delivery (asserted above) and claims no check of its own.
  assert.ok(!/delivery (was|is) (checked|verified)/i.test(readme));
});
