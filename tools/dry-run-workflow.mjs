// Dry-run a Dynamic Workflow script without Claude Code: agent()/parallel()/pipeline()/
// phase()/log() are replaced by local stubs, so tests can check the script's control flow
// (labels, phases, loop bounds, branching) deterministically. No model is called.
//
//   import { dryRun } from '../../tools/dry-run-workflow.mjs'
//   const r = await dryRun('workflows/x.js', { args: {...}, respond: ({prompt, opts, n}) => value })
//   r.meta, r.calls [{n, prompt, opts, label, phase}], r.phases, r.logs, r.result, r.error
//
// Semantics follow the workflow-authoring reference: parallel() resolves throwing thunks to
// null; pipeline() drops an item to null when a stage throws; Date.now()/Math.random()/argless
// new Date() throw, as in the real runtime.
import fs from 'node:fs';

export function extractMeta(text) {
  const start = text.indexOf('export const meta');
  if (start < 0) throw new Error('no `export const meta`');
  const open = text.indexOf('{', start);
  let depth = 0, i = open, inStr = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const literal = text.slice(open, i + 1);
  return { meta: Function(`"use strict"; return (${literal});`)(), end: i + 1, start };
}

export async function dryRun(scriptPath, { args, respond = () => null, maxAgents = 1000 } = {}) {
  const text = fs.readFileSync(scriptPath, 'utf8');
  const { meta, start, end } = extractMeta(text);
  const body = text.slice(0, start) + text.slice(end);
  const calls = [], logs = [], phases = [];
  let n = 0;

  const agent = async (prompt, opts = {}) => {
    if (typeof prompt !== 'string') throw new Error('agent(prompt) needs a string prompt');
    if (++n > maxAgents) throw new Error('agent cap exceeded');
    const call = { n, prompt, opts, label: opts.label ?? null, phase: opts.phase ?? phases.at(-1) ?? null };
    calls.push(call);
    return respond(call);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch((e) => {
    logs.push(`parallel failed: ${e.message}`); return null;
  })));
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev = item;
    try { for (const s of stages) prev = await s(prev, item, i); return prev; }
    catch (e) { logs.push(`pipeline[${i}] failed: ${e.message}`); return null; }
  }));
  const phase = (t) => { phases.push(t); };
  const log = (m) => { logs.push(String(m)); };
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  const workflow = async () => { throw new Error('workflow() not supported in dry run'); };
  const RealDate = Date;
  function FakeDate(...a) { if (!a.length) throw new Error('new Date() is unavailable in workflows'); return new RealDate(...a); }
  FakeDate.now = () => { throw new Error('Date.now() is unavailable in workflows'); };
  const FakeMath = Object.create(Math);
  FakeMath.random = () => { throw new Error('Math.random() is unavailable in workflows'); };

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'Date', 'Math', body);
  let result, error = null;
  try { result = await fn(agent, parallel, pipeline, phase, log, args, budget, workflow, FakeDate, FakeMath); }
  catch (e) { error = e; }
  return { meta, calls, phases, logs, result, error };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [script, argsJson] = process.argv.slice(2);
  const r = await dryRun(script, { args: argsJson ? JSON.parse(argsJson) : undefined });
  console.log(JSON.stringify({ meta: r.meta, phases: r.phases, calls: r.calls.map((c) => c.label), logs: r.logs, error: r.error?.message ?? null }, null, 2));
}
