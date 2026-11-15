// Shared helpers for the plugin tests: paths, the expected hint (an own literal copy, not imported
// from the script), and a runner that starts the real script as a child process.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PLUGIN_DIR = path.join(ROOT, 'plugin');
export const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'session-start.mjs');
export const OPTION_ENV = 'CLAUDE_PLUGIN_OPTION_TRACKINGHINT';

// The text approved by the user, line by line, LF between lines, no leading or trailing newline.
export const EXPECTED_HINT = [
  'wfviz, a local viewer of Dynamic Workflow runs, is installed. It shows any workflow run as it is, and shows more detail when a workflow follows these optional conventions; a workflow that ignores them works the same.',
  '- Agent labels of the form "<role>:<unit>", with "#r2" for a repeat round, give a role x unit matrix.',
  '- A phase passed to each agent groups agents by stage.',
  '- JSON results are recognised: an array "findings" of { file, line, severity, description }, a "verdict" with a "reason", and "tests" { passed, failed, skipped }.',
  "- Run totals in the workflow's return value are shown as the run total.",
  '- log() lines at phase starts and ends appear in the log.',
].join('\n');

// A child environment without any variable that could change the result, plus the given ones.
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('CLAUDE_PLUGIN_OPTION_') || key === 'WFVIZ_TRACKING_HINT') {
      if (!(key in extra)) delete env[key];
    }
  }
  // `node` in a hooks command resolves on PATH: make sure it is the node that runs these tests.
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`;
  return env;
}

// Runs `command args` and resolves { code, signal, stdout, stderr }.
// stdin: undefined or null -> closed at once; a string or Buffer -> written, then closed.
// An error on the child's stdin (EPIPE when the script exits without reading) is not a failure here.
export function run({ command = process.execPath, args = [SCRIPT], env = cleanEnv(), stdin = null, closeStdoutEarly = false, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    if (closeStdoutEarly) child.stdout.destroy();
    if (stdin === null || stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

// The exact stdout of an "on" run: one JSON object and one line feed.
export function expectedStdout(hint = EXPECTED_HINT) {
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: hint } })}\n`;
}

// File names that an operating system or file manager adds to any folder on its own (.gitignore lists
// .DS_Store). They are not part of the plugin and must not turn a test red, or be read as text by a scan.
// Any other file, a dotfile such as .env included, is still listed.
export const OS_METADATA = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/;

export function listFiles(dir, base = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (OS_METADATA.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, base));
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found.sort();
}
