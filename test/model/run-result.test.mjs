// Run.result (the final file's top-level "result") and the scope of what is recognised in it (docs/contract.md sections 2 and 3).
// Hand-built events from helpers.mjs for the cases, the saved real runs in fixtures/claude-projects for the counts that must not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceRun } from '../../src/model/reduce.mjs';
import { recognize } from '../../src/model/recognize.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { probe1, probe2 } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = 1794126730000;

// probe 1 with its final file changed: `edit(data)` returns the data of the run.final event
function probe1With(edit) {
  const p = probe1();
  const data = edit(JSON.parse(JSON.stringify(p.e.final.data)));
  return reduceRun([...p.live, { ...p.e.final, data }], { now: () => NOW });
}

// ---- Run.result

test('Run.result: the final file\'s "result" as it is, prov final, from the final file#result', () => {
  const p = probe1();
  const run = reduceRun(p.withFinal, { now: () => NOW });
  assert.equal(run.result.prov, 'final');
  assert.deepEqual(run.result.value, p.e.final.data.result);
  assert.equal(run.result.from, `${p.b.files.final}#result`);
  assert.match(run.result.from, /\/workflows\/wf_6509ce25-20a\.json#result$/);
  assert.equal('reason' in run.result, false);
});

test('Run.result: "result": null (a failed run) is unknown, and the reason says it is null', () => {
  const p = probe2();
  assert.equal(p.finalData.result, null, 'the probe 2 final file has "result": null');
  const run = reduceRun(p.withFinal, { now: () => 1794127800000 });
  assert.deepEqual(run.result, { value: null, prov: 'unknown', reason: 'final file has "result": null' });
  assert.ok(Object.values(run.agents).some((a) => a.result.prov !== 'unknown'), 'the agents have results; none of them stands in for the run\'s');
});

test('Run.result: a final file with no "result" key is unknown, and the reason says the key is missing', () => {
  const run = probe1With((d) => { delete d.result; return d; });
  assert.equal(run.status.prov, 'final');
  assert.deepEqual(run.result, { value: null, prov: 'unknown', reason: 'final file has no "result" field' });
  assert.equal(run.recognized.verdicts.some((v) => v.scope === 'run'), false);
});

test('Run.result: no final file is unknown; while the run runs the reason says the file is written only at the end, afterwards that there is no final file', () => {
  const p = probe1();
  const running = reduceRun(p.live, { now: () => NOW });
  assert.equal(running.status.value, 'running');
  assert.equal(running.result.prov, 'unknown');
  assert.match(running.result.reason, /written only at the end/);
  const gone = reduceRun(p.live, { now: () => NOW + 24 * 3600 * 1000 });
  assert.notEqual(gone.status.value, 'running');
  assert.equal(gone.result.prov, 'unknown');
  assert.match(gone.result.reason, /no final run file/);
  assert.equal(gone.result.value, null);
});

test('Run.result: any JSON passes through, an array and a falsy value included; a preview or the last agent result is never used', () => {
  for (const value of [[{ a: 1 }, 'x'], 'plain text', 0, false, '', {}, [], { nested: { list: [1, 2, 3] } }]) {
    const run = probe1With((d) => { d.result = value; return d; });
    assert.equal(run.result.prov, 'final', JSON.stringify(value));
    assert.deepEqual(run.result.value, value);
    assert.match(run.result.from, /#result$/);
  }
  const run = probe1With((d) => { d.result = null; return d; });
  assert.equal(run.result.value, null);
  assert.equal(run.result.prov, 'unknown', 'the previews of the agents in workflowProgress do not fill it');
});

test('Run.result: an unknown result is listed with the other unknowns of the run, with its reason', () => {
  const run = reduceRun(probe2().withFinal, { now: () => 1794127800000 });
  assert.deepEqual(run.unknowns.filter((u) => u.field === 'result'), [{ field: 'result', reason: 'final file has "result": null' }]);
  const known = reduceRun(probe1().withFinal, { now: () => NOW });
  assert.equal(known.unknowns.some((u) => u.field === 'result'), false);
});

// ---- scope of the recognised items

test('scope: probe 1 gives 3 verdicts of scope agent and 3 of scope run (agentId null, from the final file, path $.a, $.b, $.j)', () => {
  const run = reduceRun(probe1().withFinal, { now: () => NOW });
  const rec = run.recognized;
  for (const kind of ['findings', 'verdicts', 'tests']) assert.ok(rec[kind].every((x) => x.scope === 'agent' || x.scope === 'run'), `every ${kind} item has a scope`);
  const agent = rec.verdicts.filter((v) => v.scope === 'agent');
  const inRun = rec.verdicts.filter((v) => v.scope === 'run');
  assert.deepEqual(agent.map((v) => v.verdict), ['pass', 'fail', 'fail']);
  assert.ok(agent.every((v) => typeof v.agentId === 'string' && /journal\.jsonl:\d+$/.test(v.from)), 'the agents\' items come from the journal lines of their results');
  assert.deepEqual(inRun.map((v) => [v.path, v.verdict, v.agentId]), [['$.a', 'pass', null], ['$.b', 'fail', null], ['$.j', 'fail', null]]);
  assert.ok(inRun.every((v) => v.from === run.result.from && v.prov === 'inferred' && v.method === 'field-name:verdict'));
  assert.deepEqual([rec.findings.length, rec.tests.length], [0, 0]);
  assert.deepEqual(rec.verdicts.map((v) => v.scope), ['agent', 'agent', 'agent', 'run', 'run', 'run'], 'the agents\' items first, then the run\'s');
});

test('scope: the run result changes nothing about the agents\' items (they are what recognize gives without Run.result)', () => {
  const run = reduceRun(probe1().withFinal, { now: () => NOW });
  const withoutResult = recognize({ ...run, result: undefined });
  for (const kind of ['findings', 'verdicts', 'tests']) assert.deepEqual(run.recognized[kind].filter((x) => x.scope === 'agent'), withoutResult[kind], kind);
});

test('scope: a run whose result holds tests, findings and a verdict gets run-scope items of each kind in Run.recognized', () => {
  const run = probe1With((d) => {
    d.result = {
      verdict: 'fix', findings: [{ file: 'a.js', line: 1, severity: 'low' }], low: [{ file: 'b.js', description: 'd' }],
      tests: { passed: 9, failed: 1, skipped: 0 },
    };
    return d;
  });
  const own = (kind) => run.recognized[kind].filter((x) => x.scope === 'run');
  assert.deepEqual(own('verdicts').map((x) => [x.path, x.verdict]), [['$', 'fix']]);
  assert.deepEqual(own('findings').map((x) => [x.path, x.method]), [['$.findings[0]', 'field-name:findings'], ['$.low[0]', 'shape:file+description']]);
  assert.deepEqual(own('tests').map((x) => [x.path, x.passed, x.failed, x.skipped, x.from]), [['$.tests', 9, 1, 0, run.result.from]]);
});

// ---- the saved real runs: what the agents' items are must not change

function savedRuns() {
  const base = path.join(REPO, 'fixtures', 'claude-projects');
  const out = [];
  for (const slug of fs.readdirSync(base)) {
    for (const session of fs.readdirSync(path.join(base, slug))) {
      const wfs = path.join(base, slug, session, 'subagents', 'workflows');
      if (!fs.existsSync(wfs)) continue;
      for (const id of fs.readdirSync(wfs).filter((n) => n.startsWith('wf_'))) out.push({ dir: path.join(base, slug, session), id });
    }
  }
  return out;
}

test('saved real runs: the agents\' items are the same as without Run.result, and the counts of probe 1 and probe 2 are the known ones', async () => {
  const runs = savedRuns();
  assert.ok(runs.length >= 2, 'the fixtures hold at least the two probe runs');
  const seen = {};
  for (const { dir, id } of runs) {
    const run = reduceRun(await readRunDir(dir, id), { now: () => NOW });
    const rec = run.recognized;
    const agentOf = (kind) => rec[kind].filter((x) => x.scope !== 'run');
    const without = recognize({ ...run, result: undefined });
    for (const kind of ['findings', 'verdicts', 'tests']) {
      assert.ok(rec[kind].every((x) => x.scope === 'agent' || x.scope === 'run'), `${id}: every ${kind} item has a scope`);
      assert.deepEqual(agentOf(kind), without[kind], `${id}: agent-scope ${kind} are those of the agents alone`);
      assert.ok(rec[kind].filter((x) => x.scope === 'run').every((x) => x.agentId === null && run.result.prov === 'final' && x.from === run.result.from), `${id}: run-scope ${kind}`);
    }
    seen[id] = { findings: agentOf('findings').length, verdicts: agentOf('verdicts').length, tests: agentOf('tests').length, result: run.result.prov, inRun: rec.verdicts.length - agentOf('verdicts').length };
  }
  assert.deepEqual(seen['wf_6509ce25-20a'], { findings: 0, verdicts: 3, tests: 0, result: 'final', inRun: 3 });
  assert.deepEqual(seen['wf_26eb8d70-5c4'], { findings: 0, verdicts: 0, tests: 0, result: 'unknown', inRun: 0 });
});
