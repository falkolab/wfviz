// Entry point for `node --test test/integration/`.
// Node >= 21 runs a directory argument as a module path, which resolves to this file; Node 20
// expands the directory itself, so there this file does nothing (else suites would run twice).
// Every *.test.mjs beside this file is loaded: a new test file runs without being listed here
// (an explicit list once left a new test silently unrun). Direct form: node --test "test/integration/*.test.mjs"
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) >= 21) {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
    await import(`./${name}`);
  }
}
