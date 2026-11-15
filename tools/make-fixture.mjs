#!/usr/bin/env node
// Copy one real workflow run into fixtures/claude-projects/<slug>/<session>/, keeping the
// directory layout of ~/.claude/projects. Agent transcripts are trimmed to the record types
// the visualizer reads (user, assistant, structured_output attachments); bulky API blobs,
// thinking blocks and prompt snapshots are dropped. Read-only on the source.
// Usage: node tools/make-fixture.mjs <session-dir> <runId> [--keep-lines N]
import fs from 'node:fs';
import path from 'node:path';

const [sessionDir, runId, ...rest] = process.argv.slice(2);
if (!sessionDir || !runId) {
  console.error('usage: make-fixture.mjs <session-dir> <runId> [--keep-lines N]');
  process.exit(2);
}
const keepIdx = rest.indexOf('--keep-lines');
const keep = keepIdx >= 0 ? Number(rest[keepIdx + 1]) : Infinity;
const session = path.basename(sessionDir);
const slug = path.basename(path.dirname(sessionDir));
const out = path.join('fixtures', 'claude-projects', slug, session);
const SCRUB = [[/CODEX_HOME=\S+/g, 'CODEX_HOME=<redacted>']];
const scrub = (s) => SCRUB.reduce((a, [re, to]) => a.replace(re, to), s);

function copy(rel, transform) {
  const src = path.join(sessionDir, rel);
  if (!fs.existsSync(src)) return false;
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(dst, scrub(transform ? transform(text) : text));
  return true;
}

function trimTranscript(text) {
  const lines = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const keepIt = o.type === 'user' || o.type === 'assistant' ||
      (o.type === 'attachment' && o.attachment && o.attachment.type === 'structured_output');
    if (!keepIt) continue;
    if (o.message && Array.isArray(o.message.content)) {
      o.message.content = o.message.content.filter((c) => c.type !== 'thinking');
    }
    lines.push(JSON.stringify(o));
  }
  const kept = lines.length > keep * 2 ? [...lines.slice(0, keep), ...lines.slice(-keep)] : lines;
  return kept.join('\n') + '\n';
}

const sub = path.join('subagents', 'workflows', runId);
let n = 0;
for (const f of fs.readdirSync(path.join(sessionDir, sub))) {
  if (f.endsWith('.prefix.json')) continue;
  const isTranscript = f.startsWith('agent-') && f.endsWith('.jsonl');
  copy(path.join(sub, f), isTranscript ? trimTranscript : null);
  n++;
}
copy(path.join('workflows', `${runId}.json`));
const scripts = path.join(sessionDir, 'workflows', 'scripts');
if (fs.existsSync(scripts)) {
  for (const f of fs.readdirSync(scripts)) if (f.includes(runId)) copy(path.join('workflows', 'scripts', f));
}
console.log(`${runId}: ${n} files -> ${out}`);
