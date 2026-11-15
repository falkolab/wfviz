// Shared by claude-fs-replay.test.mjs and optional-legacy.mjs: an independent reader of the
// fixture / run-directory files (it does not use the source) and the checks that compare what
// readRunDir returns with them. Not a test file: no `.test.` in the name, so `node --test
// test/source/` does not pick it up on its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunDir } from '../../src/source/claude-fs.mjs';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));
export const ROOTS = {
  real: path.join(FIXTURES, 'claude-projects'),
  legacy: path.join(FIXTURES, 'synthetic', 'legacy-2.1.206'),
};

export const KINDS = [
  'run.script', 'run.launched', 'agent.started', 'agent.meta', 'agent.prompt',
  'agent.activity', 'agent.structured', 'agent.failed', 'agent.result', 'run.final', 'source.warning',
];

export const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

export function listRuns(root) {
  const runs = [];
  for (const slug of dirs(root)) {
    for (const session of dirs(path.join(root, slug))) {
      const sessionDir = path.join(root, slug, session);
      const wf = path.join(sessionDir, 'subagents', 'workflows');
      if (!fs.existsSync(wf)) continue;
      for (const runId of dirs(wf).filter((n) => n.startsWith('wf_'))) {
        runs.push({ root, slug, session, sessionDir, runId, runDir: path.join(wf, runId) });
      }
    }
  }
  return runs;
}

// Counts per kind that the files of a run must give. A journal record type other than launched,
// started, result and failed fails the test, since the fixtures hold none; a real run may hold
// some: pass a Set as `unknownTypes` to collect them instead (the source reports them as
// warnings, which are not counted here).
export function expectedCounts(run, unknownTypes = null) {
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const names = fs.readdirSync(run.runDir);
  for (const rec of readLines(path.join(run.runDir, 'journal.jsonl'))) {
    if (rec.type === 'launched') c['run.launched']++;
    else if (rec.type === 'started') c['agent.started']++;
    else if (rec.type === 'result') c['agent.result']++;
    else if (rec.type === 'failed') c['agent.failed']++;
    else if (unknownTypes) unknownTypes.add(rec.type);
    else assert.fail(`fixture journal has an unexpected record type ${rec.type}`);
  }
  c['agent.meta'] = names.filter((n) => /^agent-.+\.meta\.json$/.test(n)).length;
  for (const name of names.filter((n) => /^agent-.+\.jsonl$/.test(n))) {
    const recs = readLines(path.join(run.runDir, name));
    if (recs.some((r) => r.type === 'user')) c['agent.prompt']++;
    for (const r of recs) {
      if (r.type === 'assistant' && Array.isArray(r.message?.content) &&
          r.message.content.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== ''))) c['agent.activity']++;
      if (r.type === 'attachment' && r.attachment?.type === 'structured_output') c['agent.structured']++;
    }
  }
  const scripts = path.join(run.sessionDir, 'workflows', 'scripts');
  if (fs.existsSync(scripts)) c['run.script'] = fs.readdirSync(scripts).filter((n) => n.endsWith(`-${run.runId}.js`)).length;
  if (fs.existsSync(path.join(run.sessionDir, 'workflows', `${run.runId}.json`))) c['run.final'] = 1;
  return c;
}

export function countKinds(events) {
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const e of events) {
    assert.ok(e.kind in c, `unexpected kind ${e.kind}`);
    c[e.kind]++;
  }
  return c;
}

export function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.push(`${p}\0${s.size}\0${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort();
}

// The checks for a run directory <session>/subagents/workflows/<runId> made by a real Claude
// Code, or one that stands in for it (the synthetic legacy fixture): same counts as the fixtures,
// but record types this source does not know are allowed and must be reported as warnings.
// Read-only: the run directory must be unchanged afterwards.
export async function checkRealRun(runDir) {
  assert.ok(path.basename(runDir).startsWith('wf_'), 'the run directory must be a wf_* directory');
  const sessionDir = path.resolve(runDir, '..', '..', '..');
  const runId = path.basename(runDir);
  const before = snapshot(runDir);

  const events = await readRunDir(sessionDir, runId);
  assert.ok(events.length > 0);
  const run = { sessionDir, runId, runDir };
  const unknownTypes = new Set();
  const expected = expectedCounts(run, unknownTypes);
  const got = countKinds(events);
  // a real run may have things the fixtures do not (warnings for unknown records): compare the rest
  for (const k of KINDS.filter((k) => k !== 'source.warning')) assert.equal(got[k], expected[k], k);
  for (const type of unknownTypes) {
    assert.ok(events.some((e) => e.kind === 'source.warning' && e.data.message.includes(JSON.stringify(type))),
      `a warning names the unknown journal record type ${type}`);
  }
  for (const e of events) {
    assert.equal(e.runId, runId);
    assert.ok(Number.isFinite(e.ts));
    assert.ok(e.prov.file.startsWith(sessionDir));
  }
  // nothing is invented for old versions: no label/phase on started lines that did not have them
  const journal = readLines(path.join(runDir, 'journal.jsonl'));
  for (const e of events.filter((x) => x.kind === 'agent.started')) {
    const rec = journal[e.prov.line - 1];
    assert.equal('label' in e.data, 'label' in rec);
    assert.equal('phase' in e.data, 'phase' in rec);
  }

  assert.deepEqual(snapshot(runDir), before, 'the run directory was not modified');
  return { events, unknownTypes };
}
