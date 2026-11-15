// The gate template (workflows/gate/gate-template.js) is the reference implementation of the
// development gate in AGENTS.md. These tests generate a script with tools/make-dev-graph.mjs and
// dry-run it, so every rule of the gate is checked against code, not prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScript, loadNodes, checkNode } from '../../tools/make-dev-graph.mjs';
import { dryRun } from '../../tools/dry-run-workflow.mjs';

const node = (owns) => ({ name: 'demo node', owns, spec: 'do x', lensA: 'lens a', lensB: 'lens b' });
const OK = 'ℹ pass 10\nℹ fail 0\nℹ skipped 0\nℹ todo 0';
const F = (category, severity = 'medium') => ({ file: 'web/app.js', line: 3, input: 'x', description: 'd', severity, category });

async function run(nodes, respond, args = { judgeCmd: 'J', base: 'B' }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'g.js');
  fs.writeFileSync(file, buildScript({ n: 99, description: 'test', nodes }));
  return dryRun(file, { args, respond });
}

// respond helper: per-label answers, with defaults that make the gate pass.
const responder = (over = {}) => ({ opts }) => {
  const l = opts.label || '';
  for (const [prefix, v] of Object.entries(over)) if (l.startsWith(prefix)) return typeof v === 'function' ? v(l) : v;
  if (l.startsWith('test:')) return { exitCode: 0, outputTail: OK };
  if (l.startsWith('review-') || l.startsWith('verify:') || l.startsWith('ui-check:')) return { findings: [], low: [] };
  if (l.startsWith('judge:')) return { verdict: 'accept', approved: [], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '', usage: '[]' };
  return { files: [], note: 'n' };
};

test('clean node: guide, implement, test, two reviewers, judge, then pass', async () => {
  const r = await run({ a: node(['x/']) }, responder());
  assert.equal(r.error ?? null, null);
  assert.deepEqual(r.calls.map((c) => c.label), ['guide:a#prep', 'implement:a', 'test:a#impl', 'review-a:a#full', 'review-b:a#full', 'judge:a']);
  assert.equal(r.result.a.status, 'pass');
});

test('an implementer that returns nothing is retried once; twice nothing blocks the node before any review', async () => {
  const once = await run({ a: node(['x/']) }, responder({ 'implement:a#retry': { files: [], note: 'n' }, 'implement:a': null }));
  assert.deepEqual(once.calls.map((c) => c.label).slice(0, 4), ['guide:a#prep', 'implement:a', 'implement:a#retry', 'test:a#impl']);
  assert.equal(once.result.a.status, 'pass');
  const twice = await run({ a: node(['x/']) }, responder({ 'implement:a': null }));
  assert.deepEqual(twice.calls.map((c) => c.label), ['guide:a#prep', 'implement:a', 'implement:a#retry']);
  assert.equal(twice.result.a.status, 'blocked');
  assert.equal(twice.result.a.implement, 'implementer returned nothing twice');
});

test('judge always runs after the full review, even when reviewers agree on nothing', async () => {
  const r = await run({ a: node(['x/']) }, responder());
  assert.ok(r.calls.some((c) => c.label === 'judge:a'));
});

test('only judge-approved high/medium findings go to the fixer; low go to the report', async () => {
  const r = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('xss')], low: [F('wording', 'low')] },
    'judge:': { verdict: 'fix', approved: [0, 1], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
  }));
  const fix = r.calls.find((c) => c.label === 'fix:a#full');
  assert.ok(fix.prompt.includes('"category":"xss"'));
  assert.ok(!fix.prompt.includes('"category":"wording"'));
  assert.equal(r.result.a.low.length, 1);
});

test('findings without file, line or input are dropped by code before the judge', async () => {
  const r = await run({ a: node(['x/']) }, responder({ 'review-a': { findings: [{ ...F('xss'), input: '' }, { ...F('xss'), line: 0 }] } }));
  const judge = r.calls.find((c) => c.label === 'judge:a');
  assert.ok(judge.prompt.includes('Findings from two reviewers: []'));
});

test('test gate needs exit 0, fail 0, skipped 0, todo 0 and pass > 0', async () => {
  for (const tail of ['ℹ pass 10\nℹ fail 0\nℹ skipped 1\nℹ todo 0', 'ℹ pass 0\nℹ fail 0\nℹ skipped 0\nℹ todo 0', 'no summary']) {
    const r = await run({ a: node(['x/']) }, responder({ 'test:a#impl': { exitCode: 0, outputTail: tail } }));
    assert.ok(r.calls.some((c) => c.label === 'fix:a#full'), `should fix for: ${tail}`);
  }
  const hash = await run({ a: node(['x/']) }, responder({ 'test:': { exitCode: 0, outputTail: '# pass 3\n# fail 0\n# skipped 0\n# todo 0' } }));
  assert.equal(hash.result.a.status, 'pass');
});

test('the fixer owns the node guide and brings it in line with the fix; verification reads the guide', async () => {
  const r = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('guide-defect')] },
    'judge:': { verdict: 'fix', approved: [0], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
  }));
  const fix = r.calls.find((c) => c.label === 'fix:a#full');
  assert.ok(fix.prompt.includes('Files you own: x/, and the node guide docs/guides/a.md'));
  assert.match(fix.prompt, /bring docs\/guides\/a\.md in line with the code/);
  assert.match(fix.prompt, /Do not touch docs\/guides\/common\.md/);
  assert.ok(r.calls.find((c) => c.label === 'verify:a#v1').prompt.includes('the node guide docs/guides/a.md'));
});

test('at most two diff-only verifications, then blocked', async () => {
  const r = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('xss')] },
    'judge:': { verdict: 'fix', approved: [0], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
    'verify:': { findings: [F('leak')] },
  }));
  assert.deepEqual(r.calls.filter((c) => c.label.startsWith('verify:')).map((c) => c.label), ['verify:a#v1', 'verify:a#v2']);
  assert.equal(r.result.a.status, 'blocked');
});

test('a category approved twice adds a rule; once here and once in priorCategories also does', async () => {
  const twice = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('xss'), F('xss')] },
    'judge:': { verdict: 'fix', approved: [0, 1], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
  }));
  assert.ok(twice.calls.some((c) => c.label === 'guide:a#rule-full'));
  assert.deepEqual(twice.result.a.rulesAdded, ['xss']);

  const prior = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('Leak')] },
    'judge:': { verdict: 'fix', approved: [0], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
  }), { judgeCmd: 'J', base: 'B', priorCategories: ['leak'] });
  assert.deepEqual(prior.result.a.rulesAdded, ['leak']);

  const once = await run({ a: node(['x/']) }, responder({
    'review-a': { findings: [F('xss')] },
    'judge:': { verdict: 'fix', approved: [0], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '' },
  }));
  assert.ok(!once.calls.some((c) => c.label.startsWith('guide:a#rule')));
});

test('independent nodes run in one script; overlapping owned paths are refused', async () => {
  const r = await run({ a: node(['web/']), b: node(['src/model/']) }, responder());
  assert.equal(r.result.a.status, 'pass');
  assert.equal(r.result.b.status, 'pass');
  assert.throws(() => buildScript({ n: 1, description: 'x', nodes: { a: node(['web/']), b: node(['web/app.js']) } }), /both own/);
});

test('judge command and base are required; the command is used only in the judge prompt', async () => {
  const bad = await run({ a: node(['x/']) }, responder(), {});
  assert.match(bad.error.message, /judgeCmd and args.base/);
  const r = await run({ a: node(['x/']) }, responder(), { judgeCmd: 'SECRET-CMD', base: 'B' });
  assert.deepEqual(r.calls.filter((c) => c.prompt.includes('SECRET-CMD')).map((c) => c.label), ['judge:a']);
});

test('every prompt carries the universality rule; generated meta phases cover every label', async () => {
  const r = await run({ a: node(['x/']) }, responder());
  for (const c of r.calls.filter((c) => !c.label.startsWith('test:'))) assert.ok(c.prompt.includes('wfviz is universal'), c.label);
  const titles = new Set(r.meta.phases.map((p) => p.title));
  for (const c of r.calls) assert.ok(titles.has(c.phase), `${c.label} phase ${c.phase}`);
});

test('node files in workflows/nodes are valid', async () => {
  const dir = new URL('../../workflows/nodes/', import.meta.url);
  const slugs = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4));
  assert.ok(slugs.length > 0);
  const nodes = await loadNodes(slugs);
  for (const s of slugs) checkNode(s, nodes[s]);
});

test('risk low: one reviewer; the judge runs only when there is a blocking finding', async () => {
  const clean = await run({ a: { ...node(['x/']), risk: 'low' } }, responder());
  assert.deepEqual(clean.calls.map((c) => c.label), ['guide:a#prep', 'implement:a', 'test:a#impl', 'review-a:a#full']);
  assert.equal(clean.result.a.status, 'pass');
  assert.deepEqual(clean.result.a.judge, { skipped: 'risk low and no blocking finding' });

  const lowOnly = await run({ a: { ...node(['x/']), risk: 'low' } }, responder({ 'review-a': { findings: [], low: [F('wording', 'low')] } }));
  assert.ok(!lowOnly.calls.some((c) => c.label.startsWith('judge:')));
  assert.equal(lowOnly.result.a.low.length, 1);

  const blocking = await run({ a: { ...node(['x/']), risk: 'low' } }, responder({ 'review-a': { findings: [F('xss')], low: [] } }));
  assert.ok(blocking.calls.some((c) => c.label === 'judge:a'));
});

test('a ui node gets a ui-check step whose findings reach the judge', async () => {
  const r = await run({ a: { ...node(['web/']), ui: { scenario: '1. open the page; the log is visible' } } }, responder({
    'ui-check': { findings: [{ file: 'ui', line: 1, input: 'opened; log at y=3500', description: 'log must be visible', severity: 'medium', category: 'layout' }], low: [] },
  }));
  const ui = r.calls.find((c) => c.label === 'ui-check:a');
  assert.ok(ui && ui.prompt.includes('1. open the page; the log is visible'));
  assert.ok(ui.prompt.includes('new background tab'));
  assert.ok(r.calls.find((c) => c.label === 'judge:a').prompt.includes('"file":"ui"'));
  assert.equal(r.result.a.review.perCheck.find((c) => c.check === 'ui').blocking, 1);
});

test('low findings never use the blocking limit and never send work back', async () => {
  const r = await run({ a: node(['x/']) }, responder({ 'review-a': { findings: [], low: [F('a', 'low'), F('b', 'low')] }, 'review-b': { findings: [], low: [F('c', 'low')] } }));
  assert.equal(r.result.a.status, 'pass');
  assert.equal(r.result.a.low.length, 3);
  assert.ok(!r.calls.some((c) => c.label.startsWith('fix:')));
});

test('codex usage is kept in the report as given, apart from Claude tokens', async () => {
  const usage = '[{"type":"turn.completed","usage":{"input_tokens":10}}]';
  const r = await run({ a: node(['x/']) }, responder({ 'judge:': { verdict: 'accept', approved: [], dropped: [], missed: [], contractIssue: '', engine: 'codex-cli', note: '', usage } }));
  assert.equal(r.result.a.judge.codexUsage, usage);
  assert.ok(r.calls.find((c) => c.label === 'judge:a').prompt.includes('--json'));
});

test('node file checks risk and ui', () => {
  assert.throws(() => checkNode('a', { ...node(['x/']), risk: 'medium' }), /risk/);
  assert.throws(() => checkNode('a', { ...node(['x/']), ui: {} }), /ui.scenario/);
});

test('model trial: high risk puts reviewer a on opus and b on sonnet; low risk sonnet; judge wrapper haiku', async () => {
  const hi = await run({ a: node(['x/']) }, responder());
  const m = (r, l) => r.calls.find((c) => c.label === l).opts.model;
  assert.equal(m(hi, 'review-a:a#full'), 'opus');
  assert.equal(m(hi, 'review-b:a#full'), 'sonnet');
  assert.equal(m(hi, 'judge:a'), 'haiku');
  assert.deepEqual(hi.result.a.review.perCheck.map((c) => c.model), ['opus', 'sonnet']);
  const lo = await run({ a: { ...node(['x/']), risk: 'low' } }, responder());
  assert.equal(m(lo, 'review-a:a#full'), 'sonnet');
});
