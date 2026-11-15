// V0 survey tool (tools/format-survey.mjs): groups runs by transcript version, counts record
// types and field shapes, and never writes record content.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { surveyRoot, renderMarkdown, compareVersions } from '../../tools/format-survey.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

test('real fixture runs: 2.1.317, two runs, journal types and final statuses counted', async () => {
  const s = await surveyRoot(path.join(repo, 'fixtures/claude-projects'));
  assert.deepEqual(s.versions.map((g) => g.version), ['2.1.317']);
  const g = s.versions[0];
  assert.equal(g.runs, 2);
  assert.deepEqual(g.agg.journal.types, { launched: 2, started: 11, result: 11 });
  assert.deepEqual(g.agg.final.status, { completed: 1, failed: 1 });
  assert.equal(g.agg.files.final, 2);
  assert.equal(g.agg.journal.shapes.started.fields.label.n, 11);
});

test('legacy synthetic run is grouped under its own version, without launched or label', async () => {
  const s = await surveyRoot(path.join(repo, 'fixtures/synthetic/legacy-2.1.206'));
  const g = s.versions.find((x) => x.version === '2.1.206');
  assert.ok(g);
  assert.equal(g.agg.journal.types.launched, undefined);
  assert.equal(g.agg.journal.shapes.started.fields.label, undefined);
});

test('no version field → unknown; failed type, frames, edit input shape; content never rendered', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfviz-survey-'));
  const runDir = path.join(root, '-p', 's1', 'subagents', 'workflows', 'wf_x');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"k","agentId":"a"}\n{"type":"failed","key":"k","agentId":"a"}\nnot json\n');
  const secret = 'SECRET-CONTENT-123';
  const lines = [
    { type: 'user', message: { role: 'user', content: `[Workflow harness — user request]\n  ${secret}` } },
    { type: 'user', message: { role: 'user', content: '[Workflow harness — computed task]\n  do it' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: secret, old_string: 'a', new_string: 'b' } }] } },
  ];
  await fsp.writeFile(path.join(runDir, 'agent-a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const s = await surveyRoot(root);
    assert.deepEqual(s.versions.map((g) => g.version), ['unknown']);
    const a = s.versions[0].agg;
    assert.equal(a.journal.types.failed, 1);
    assert.equal(a.journal.bad, 1);
    assert.equal(a.transcript.firstUser.relay, 1);
    assert.equal(a.transcript.firstUser.computed, 1);
    assert.deepEqual(Object.keys(a.transcript.editInputs.Edit.fields).sort(), ['file_path', 'new_string', 'old_string']);
    const md = renderMarkdown(s);
    assert.ok(!md.includes(secret));
    assert.ok(!md.includes('-p'), 'project slug must not appear');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('versions sort numerically', () => {
  assert.deepEqual(['2.1.317', '2.1.20', '2.1.187'].sort(compareVersions), ['2.1.20', '2.1.187', '2.1.317']);
});
