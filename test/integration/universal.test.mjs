// wfviz is universal (AGENTS.md, Hard rules): its code must not depend on how this project is
// developed. This test scans src/, web/ and bin/ (code lines, comments skipped) for names of our
// development method. The demo source is exempt: demo data is a made-up example run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRS = ['src', 'web', 'bin'];
const EXEMPT = new Set(['src/source/demo.mjs']);

// Our method's files and tools, and the role names of our gate used as string literals.
const METHOD = [
  /dev-graph/, /AGENTS\.md/, /\bgraph\.md\b/, /docs\/guides/, /\bcodex\b/i,
  /['"`](implement|review-a|review-b|verify|judge|fix|fixer|guide)['"`:]/,
  /['"`](U[0-9]|S[0-9]|M[0-9]|N[0-9]{1,2})['"`]/,
];

function files(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel));
    else if (/\.(mjs|js|html|css)$/.test(e.name)) out.push(rel);
  }
  return out;
}

function codeLines(text) {
  // Drops // line comments, /* */ and <!-- --> blocks; good enough for a guard, not a parser.
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l));
}

test('wfviz code names nothing of this project\'s development method', () => {
  const hits = [];
  for (const dir of DIRS) {
    for (const rel of files(dir)) {
      if (EXEMPT.has(rel)) continue;
      codeLines(fs.readFileSync(path.join(ROOT, rel), 'utf8')).forEach((line, i) => {
        for (const re of METHOD) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(hits, [], `method-specific names in wfviz code:\n${hits.join('\n')}`);
});
