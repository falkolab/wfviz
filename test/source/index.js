// Entry point for `node --test test/source/`.
// Node >= 22 treats a directory argument as a module path and fails with MODULE_NOT_FOUND
// instead of scanning it (Node 20 scans it). A directory resolves to its index.js, so this file
// loads every *.test.mjs beside it and the directory form works on both. The test files can
// also be run directly: node --test test/source/*.test.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  await import(`./${name}`);
}
