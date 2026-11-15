// Node agent-tokens (P2), model part: Agent.usage, totals.usage and totals.byModel (docs/contract.md section 2).
// Claude Code writes one transcript record per content block of an API message and repeats the message's usage in each, so the sum is
// taken over unique message ids (the key the source copies to data.messageId), one record per id: the one with the greatest transcript line.
// Measured on 39 local runs: 28,259 records, 12,690 ids, 15,569 repeats (docs/guides/agent-tokens.md "Measured"). The events here are
// hand-built (helpers.mjs builder) and, for the anchors, the two real fixture runs read through the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reduceRun, createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { buildSchedule, locateRun } from '../../src/source/replay.mjs';
import { builder, probe1, P1, P2 } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = 1794200000000;
const A = 'a0000000000000001';
const B = 'a0000000000000002';

// usage as a transcript record has it
const u = (input, output, cacheRead, cacheWrite) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
});
const val = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });

// The source delivers only the assistant records with a tool call or text, so the methods say what the sum covers: records the source delivers.
const LIMIT = 'a message whose records have no tool call and no text is not delivered, so it is not counted';
const agentMethod = (messages, records, extra = '') => `sum-over-unique-message-id (${messages} in ${records} the source delivers${extra}; ${LIMIT})`;
const totalsMethod = (n, of) => `sum-of-agent-usage (${n} of ${of} agents; records the source delivers only: ${LIMIT})`;

// a run of the given agents; each record is { agent, line, messageId?, model?, usage? , tool?/text? }
function events(records, { started = [A, B], withFinal = null } = {}) {
  const b = builder({ runId: 'wf_tok' });
  const out = [b.script({ name: 'tok', phases: [] }, NOW), b.launched(1, NOW + 1)];
  started.forEach((id, i) => out.push(b.started(2 + i, NOW + 10 + i, id, `w:${id.slice(-1)}`, 'P')));
  for (const r of records) {
    const d = { text: 'x', ...(r.model !== undefined ? { model: r.model } : {}), ...(r.messageId !== undefined ? { messageId: r.messageId } : {}), ...(r.usage !== undefined ? { usage: r.usage } : {}) };
    out.push(b.activity(r.agent, d, NOW + 100 + (r.line ?? 0), r.line ?? null));
  }
  if (withFinal) out.push(b.final(withFinal, NOW + 9000));
  return out;
}
const run = (evs) => reduceRun(evs, { now: () => NOW + 20000, staleMs: Infinity });

// ---- the sum over unique messages ------------------------------------------------------------------------------------------------

// the measured shape: one message in three records (one per content block), usage equal except output_tokens, which grows along them
const threeRecords = (agent = A, id = 'msg_1') => [
  { agent, line: 3, messageId: id, model: 'claude-haiku-5-5', usage: u(2, 1, 100, 53536) },
  { agent, line: 4, messageId: id, model: 'claude-haiku-5-5', usage: u(2, 1, 100, 53536) },
  { agent, line: 5, messageId: id, model: 'claude-haiku-5-5', usage: u(2, 266, 100, 53536) },
];

test('records of one message id count once: the last record by line is the message, never the sum of its records', () => {
  const r = run(events([...threeRecords(), { agent: A, line: 6, messageId: 'msg_2', model: 'claude-haiku-5-5', usage: u(3, 40, 7, 9) }]));
  const a = r.agents[A].usage;
  assert.deepEqual(a.value, val(2 + 3, 266 + 40, 100 + 7, 53536 + 9), 'msg_1 from its last record (output 266), plus msg_2');
  assert.equal(a.prov, 'inferred');
  assert.equal(a.method, agentMethod('2 messages', '4 records'), 'the method names the key, says what was summed and that only records the source delivers are in it');
  assert.equal(a.from, undefined);
  // summing every record would give input 7, output 308, cacheRead 307, cacheWrite 160617: the overcount the dedup removes
  assert.notDeepEqual(a.value, val(2 + 2 + 2 + 3, 1 + 1 + 266 + 40, 307, 53536 * 3 + 9));
});

test('the order the events arrive in does not matter: the record with the greatest line wins, also when an earlier line arrives late', () => {
  const recs = [...threeRecords(), { agent: A, line: 6, messageId: 'msg_2', model: 'claude-haiku-5-5', usage: u(3, 40, 7, 9) }];
  const want = run(events(recs)).agents[A].usage;
  const orders = [
    [...recs].reverse(),
    [recs[2], recs[0], recs[1], recs[3]], // the last record first, then the earlier ones
    [recs[1], recs[3], recs[0], recs[2]],
  ];
  for (const o of orders) assert.deepEqual(run(events(o)).agents[A].usage, want, JSON.stringify(o.map((x) => x.line)));
  assert.equal(want.value.output, 266 + 40);
});

test('two records of one id that carry no line are told apart by arrival: the later one wins; a line read twice counts once', () => {
  const noLine = run(events([
    { agent: A, messageId: 'm', model: 'claude-haiku-5-5', usage: u(1, 5, 0, 0) },
    { agent: A, messageId: 'm', model: 'claude-haiku-5-5', usage: u(1, 9, 0, 0) },
  ]));
  assert.equal(noLine.agents[A].usage.value.output, 9);
  assert.match(noLine.agents[A].usage.method, /\(1 message in 2 records the source delivers;/);
  // a line the source emits again (same content) is the same record: it adds nothing, with or without a message id
  const once = events([{ agent: A, line: 3, model: 'claude-haiku-5-5', usage: u(1, 5, 0, 0) }, { agent: A, line: 4, messageId: 'm', model: 'claude-haiku-5-5', usage: u(2, 6, 0, 0) }]);
  const twice = [...once, ...once.slice(-2)];
  assert.deepEqual(run(twice).agents[A].usage, run(once).agents[A].usage);
  assert.deepEqual(run(once).agents[A].usage.value, val(3, 11, 0, 0));
});

test('a record with no message id counts once on its own, and the method says how many did', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'msg_1', model: 'claude-haiku-5-5', usage: u(1, 10, 0, 0) },
    { agent: A, line: 4, model: 'claude-haiku-5-5', usage: u(2, 20, 0, 0) },
    { agent: A, line: 5, model: 'claude-haiku-5-5', usage: u(2, 20, 0, 0) },
  ]));
  assert.deepEqual(r.agents[A].usage.value, val(5, 50, 0, 0), 'the two records with no id are two messages, as nothing says they are one');
  assert.equal(r.agents[A].usage.method, agentMethod('3 messages', '3 records', '; 2 records with no message id counted once each'));
  // the same id on two different agents is two messages of two agents (no id is shared by two agents in the files seen: 0 of 12,690)
  const two = run(events([...threeRecords(A, 'same'), ...threeRecords(B, 'same')]));
  assert.deepEqual(two.agents[A].usage.value, two.agents[B].usage.value);
  assert.equal(two.totals.usage.value.output, 266 * 2, 'each agent counts its own message');
});

test('a counter a record does not have adds nothing, and one that is not a number adds nothing: no NaN, no null, no string', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'm1', model: 'claude-haiku-5-5', usage: { input_tokens: 4, output_tokens: 6 } },
    { agent: A, line: 4, messageId: 'm2', model: 'claude-haiku-5-5', usage: { input_tokens: '7', output_tokens: null, cache_read_input_tokens: 5, cache_creation_input_tokens: undefined } },
  ]));
  assert.deepEqual(r.agents[A].usage.value, val(4, 6, 5, 0));
  for (const x of Object.values(r.agents[A].usage.value)) assert.ok(Number.isInteger(x));
  assert.deepEqual(r.totals.usage.value, val(4, 6, 5, 0));
  // a record whose usage object holds no counter at all is not a usage record
  const none = run(events([{ agent: A, line: 3, messageId: 'm1', model: 'claude-haiku-5-5', usage: { service_tier: 'standard' } }]));
  assert.equal(none.agents[A].usage.prov, 'unknown');
});

test('usage is inferred and never final, even when the final file has tokens for the agent; Agent.tokens and totals.tokens are as they were', () => {
  const p = probe1();
  const live = reduceRun(p.live, { now: () => 1794126725000 });
  const done = reduceRun(p.withFinal, { now: () => 1794126725000 });
  for (const r of [live, done]) {
    for (const id of r.order) {
      assert.equal(r.agents[id].usage.prov, 'inferred', id);
      assert.equal(r.agents[id].usage.from, undefined);
    }
    assert.equal(r.totals.usage.prov, 'inferred');
    assert.equal(r.totals.byModel.prov, 'inferred');
  }
  assert.deepEqual([done.agents[P1.A].tokens.value, done.agents[P1.A].tokens.prov], [56206, 'final'], 'the final file still gives tokens');
  assert.deepEqual([done.totals.tokens.value, done.totals.tokens.prov], [280755, 'final']);
  assert.deepEqual(live.agents[P1.A].tokens, { value: 56355, prov: 'inferred', method: 'latest-transcript-usage' });
  // the two quantities differ and are not derived from each other: A's usage sums to 56355 here too, but the final file says 56206
  assert.deepEqual(done.agents[P1.A].usage.value, val(2, 152, 0, 56201));
});

test('Agent.tokens keeps its method on an agent with repeated records: the latest usage record, not the sum', () => {
  const r = run(events(threeRecords()));
  assert.deepEqual(r.agents[A].tokens, { value: 2 + 266 + 100 + 53536, prov: 'inferred', method: 'latest-transcript-usage' });
  assert.equal(r.agents[A].usage.value.output, 266);
  assert.equal(r.totals.tokens.method, 'sum-of-agent-tokens (1 of 2 agents)');
});

test('the sum is taken over every record, not over the 50 of Agent.activity', () => {
  const recs = Array.from({ length: 120 }, (_, i) => ({ agent: A, line: 3 + i, messageId: `m${i}`, model: 'claude-haiku-5-5', usage: u(1, 2, 3, 4) }));
  const r = run(events(recs));
  assert.equal(r.agents[A].activity.length, 50, 'the activity list keeps the last 50');
  assert.deepEqual(r.agents[A].usage.value, val(120, 240, 360, 480));
  assert.equal(r.agents[A].usage.method, agentMethod('120 messages', '120 records'));
});

// ---- unknown, with its reason --------------------------------------------------------------------------------------------------

test('unknown has two reasons: no transcript seen for the agent, and a transcript with no record that has usage', () => {
  const b = builder({ runId: 'wf_tok' });
  const evs = [
    b.script({ name: 'tok', phases: [] }, NOW), b.launched(1, NOW + 1),
    b.started(2, NOW + 10, A, 'w:a', 'P'), b.started(3, NOW + 11, B, 'w:b', 'P'),
    b.prompt(B, 'task', NOW + 12, 1),
    b.activity(B, { text: 'no usage here', model: 'claude-haiku-5-5' }, NOW + 13, 2),
  ];
  const r = run(evs);
  assert.deepEqual([r.agents[A].usage.value, r.agents[A].usage.prov], [null, 'unknown']);
  assert.match(r.agents[A].usage.reason, /^no transcript seen for this agent; usage is read from transcript records only$/);
  assert.deepEqual([r.agents[B].usage.value, r.agents[B].usage.prov], [null, 'unknown']);
  assert.match(r.agents[B].usage.reason, /^transcript seen, but none of its assistant records the source delivered carries usage$/);
  assert.notEqual(r.agents[A].usage.reason, r.agents[B].usage.reason);
  // the unknown list of the Run names both, and the totals say no agent has usage
  assert.ok(r.unknowns.some((x) => x.field === `agents.${A}.usage`));
  assert.ok(r.unknowns.some((x) => x.field === `agents.${B}.usage`));
  assert.deepEqual([r.totals.usage.value, r.totals.usage.prov, r.totals.byModel.value, r.totals.byModel.prov], [null, 'unknown', null, 'unknown']);
  assert.equal(r.totals.usage.reason, 'no agent has a transcript record with usage yet');
  assert.equal(r.totals.byModel.reason, 'no agent has a transcript record with usage yet');
  assert.ok(r.unknowns.some((x) => x.field === 'totals.usage'));
  assert.ok(r.unknowns.some((x) => x.field === 'totals.byModel'));
});

test('a run with no agents: totals.usage and totals.byModel are unknown and say so', () => {
  const r = run(events([], { started: [] }));
  assert.equal(r.totals.agents, 0);
  assert.deepEqual([r.totals.usage.prov, r.totals.usage.reason], ['unknown', 'the run has no agents yet']);
  assert.deepEqual([r.totals.byModel.prov, r.totals.byModel.reason], ['unknown', 'the run has no agents yet']);
});

test('usage of an all-zero record is usage (zero), not unknown: the transcript did give it', () => {
  const r = run(events([{ agent: A, line: 3, messageId: 'm', model: '<synthetic>', usage: u(0, 0, 0, 0) }]));
  assert.deepEqual(r.agents[A].usage.value, val(0, 0, 0, 0));
  assert.equal(r.agents[A].usage.prov, 'inferred');
});

// ---- totals.usage and totals.byModel -------------------------------------------------------------------------------------------

test('totals.usage is the sum of the agents and says how many of them have usage; byModel splits by the model of each message', () => {
  const r = run(events([
    ...threeRecords(A, 'a1'),
    { agent: A, line: 8, messageId: 'a2', model: 'claude-opus-5', usage: u(5, 50, 500, 5000) },
    { agent: B, line: 3, messageId: 'b1', model: 'claude-sonnet-5-5', usage: u(7, 70, 700, 7000) },
  ], { started: [A, B, 'a0000000000000003'] }));
  assert.deepEqual(r.agents[A].usage.value, val(2 + 5, 266 + 50, 100 + 500, 53536 + 5000));
  assert.deepEqual(r.agents[B].usage.value, val(7, 70, 700, 7000));
  assert.deepEqual(r.totals.usage.value, val(2 + 5 + 7, 266 + 50 + 70, 100 + 500 + 700, 53536 + 5000 + 7000));
  assert.deepEqual([r.totals.usage.prov, r.totals.usage.method], ['inferred', totalsMethod(2, 3)], 'the third agent has no transcript');
  assert.deepEqual(r.totals.byModel.value, {
    'claude-haiku-5-5': val(2, 266, 100, 53536),
    'claude-opus-5': val(5, 50, 500, 5000),
    'claude-sonnet-5-5': val(7, 70, 700, 7000),
  });
  assert.deepEqual([r.totals.byModel.prov, r.totals.byModel.method], ['inferred', 'sum by transcript model'], 'every message names its model: nothing to add to the method');
  // the sum of byModel is totals.usage
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of Object.values(r.totals.byModel.value)) for (const k of Object.keys(sum)) sum[k] += m[k];
  assert.deepEqual(sum, r.totals.usage.value);
});

test('model ids are the transcript\'s own, as keys: "__proto__" and "constructor" are keys, not a prototype or a function', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'm1', model: '__proto__', usage: u(1, 2, 3, 4) },
    { agent: A, line: 4, messageId: 'm2', model: 'constructor', usage: u(10, 20, 30, 40) },
    { agent: A, line: 5, messageId: 'm3', model: 'claude-haiku-5-5', usage: u(100, 200, 300, 400) },
  ]));
  const by = r.totals.byModel.value;
  assert.deepEqual(Object.keys(by).sort(), ['__proto__', 'claude-haiku-5-5', 'constructor']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(by, '__proto__').value, val(1, 2, 3, 4));
  assert.deepEqual(Object.getOwnPropertyDescriptor(by, 'constructor').value, val(10, 20, 30, 40));
  assert.equal(Object.getPrototypeOf(by), Object.prototype, 'the object was not given another prototype');
  assert.equal(Object.hasOwn(by, 'toString'), false);
  assert.deepEqual(r.totals.usage.value, val(111, 222, 333, 444));
});

test('a message that names no model is in usage and not in byModel, and the method says how many', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'm1', model: 'claude-haiku-5-5', usage: u(1, 2, 3, 4) },
    { agent: A, line: 4, messageId: 'm2', usage: u(10, 20, 30, 40) },
    { agent: A, line: 5, usage: u(100, 200, 300, 400) }, // no id and no model
  ]));
  assert.deepEqual(r.agents[A].usage.value, val(111, 222, 333, 444));
  assert.deepEqual(r.totals.byModel.value, { 'claude-haiku-5-5': val(1, 2, 3, 4) });
  assert.equal(r.totals.byModel.method, 'sum by transcript model; 2 messages with no model id are in usage but not in byModel');
  // one message: singular
  const one = run(events([{ agent: A, line: 3, messageId: 'm1', model: 'claude-haiku-5-5', usage: u(1, 2, 3, 4) }, { agent: A, line: 4, messageId: 'm2', usage: u(1, 1, 1, 1) }]));
  assert.match(one.totals.byModel.method, /; 1 message with no model id is in usage but not in byModel$/);
  // no message names a model: byModel is unknown, with the reason; usage is known
  const none = run(events([{ agent: A, line: 3, messageId: 'm1', usage: u(1, 2, 3, 4) }]));
  assert.deepEqual(none.totals.usage.value, val(1, 2, 3, 4));
  assert.deepEqual([none.totals.byModel.value, none.totals.byModel.prov], [null, 'unknown']);
  assert.equal(none.totals.byModel.reason, 'no transcript record with usage names its model');
});

test('the model of a message is the one of its last record, so a record that adds the model later is not lost', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'm1', usage: u(1, 1, 0, 0) },
    { agent: A, line: 4, messageId: 'm1', model: 'claude-haiku-5-5', usage: u(1, 9, 0, 0) },
  ]));
  assert.deepEqual(r.totals.byModel.value, { 'claude-haiku-5-5': val(1, 9, 0, 0) });
});

// ---- Agent.byModel: the agent's usage split by the model of each counted message -----------------------------------------------------

test('Agent.byModel splits the agent\'s usage by the model of each counted message; the split adds up to Agent.usage, and totals.byModel is the sum of the agents\'', () => {
  const r = run(events([
    ...threeRecords(A, 'a1'),
    { agent: A, line: 8, messageId: 'a2', model: 'claude-opus-5', usage: u(5, 50, 500, 5000) },
    { agent: A, line: 9, messageId: 'a3', model: 'claude-opus-5', usage: u(1, 1, 1, 1) },
    { agent: B, line: 3, messageId: 'b1', model: 'claude-sonnet-5-5', usage: u(7, 70, 700, 7000) },
  ]));
  const a = r.agents[A].byModel;
  assert.deepEqual([a.prov, a.method], ['inferred', 'sum by transcript model']);
  assert.deepEqual(a.value, { 'claude-haiku-5-5': val(2, 266, 100, 53536), 'claude-opus-5': val(6, 51, 501, 5001) });
  assert.deepEqual(r.agents[B].byModel.value, { 'claude-sonnet-5-5': val(7, 70, 700, 7000) });
  for (const id of [A, B]) {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of Object.values(r.agents[id].byModel.value)) for (const k of Object.keys(sum)) sum[k] += m[k];
    assert.deepEqual(sum, r.agents[id].usage.value, `the split of ${id} adds up to its usage`);
  }
  // the Run shares nothing with the sums: changing a returned value changes no later Run
  a.value['claude-opus-5'].input = 999;
  assert.deepEqual(r.totals.byModel.value['claude-opus-5'], val(6, 51, 501, 5001));
});

test('Agent.byModel is the model of the counted messages, not Agent.model: a final-file model with a suffix, and a <synthetic> last record, change neither', () => {
  // (1) the final file names the model "claude-opus-4-8[1m]", the records say "claude-opus-4-8"
  const final = { status: 'completed', workflowProgress: [{ type: 'workflow_agent', index: 1, label: 'w:a', agentId: A, model: 'claude-opus-4-8[1m]', state: 'done', tokens: 1, toolCalls: 0 }] };
  const f = run(events([{ agent: A, line: 3, messageId: 'm1', model: 'claude-opus-4-8', usage: u(3, 4, 5, 6) }], { withFinal: final }));
  assert.equal(f.agents[A].model.value, 'claude-opus-4-8[1m]', 'Agent.model is the final file\'s');
  assert.deepEqual(f.agents[A].byModel.value, { 'claude-opus-4-8': val(3, 4, 5, 6) });
  // (2) the last record is a zero-usage placeholder: Agent.model is <synthetic>, the tokens are the real model's
  const s = run(events([
    { agent: A, line: 3, messageId: 'm1', model: 'claude-opus-5', usage: u(3, 4, 5, 6) },
    { agent: A, line: 4, messageId: 'm2', model: '<synthetic>', usage: u(0, 0, 0, 0) },
  ]));
  assert.equal(s.agents[A].model.value, '<synthetic>');
  assert.deepEqual(s.agents[A].byModel.value, { 'claude-opus-5': val(3, 4, 5, 6), '<synthetic>': val(0, 0, 0, 0) });
});

test('Agent.byModel is unknown with a reason where usage is, or when no counted message names its model, and is listed with the unknowns', () => {
  const b = builder({ runId: 'wf_tok' });
  const evs = [
    b.script({ name: 'tok', phases: [] }, NOW), b.launched(1, NOW + 1),
    b.started(2, NOW + 10, A, 'w:a', 'P'), b.started(3, NOW + 11, B, 'w:b', 'P'), b.started(4, NOW + 12, 'a0000000000000003', 'w:c', 'P'),
    b.prompt(B, 'task', NOW + 13, 1),
    b.activity(B, { text: 'no usage here', model: 'claude-haiku-5-5' }, NOW + 14, 2),
    b.activity('a0000000000000003', { text: 'x', messageId: 'm1', usage: u(1, 2, 3, 4) }, NOW + 15, 2),
  ];
  const r = run(evs);
  assert.deepEqual([r.agents[A].byModel.prov, r.agents[A].byModel.reason], ['unknown', r.agents[A].usage.reason], 'no transcript seen');
  assert.deepEqual([r.agents[B].byModel.prov, r.agents[B].byModel.reason], ['unknown', r.agents[B].usage.reason], 'transcript seen, no usage');
  const c = r.agents['a0000000000000003'];
  assert.deepEqual(c.usage.value, val(1, 2, 3, 4));
  assert.deepEqual([c.byModel.value, c.byModel.prov, c.byModel.reason], [null, 'unknown', 'no transcript record with usage names its model']);
  for (const id of [A, B, 'a0000000000000003']) assert.ok(r.unknowns.some((x) => x.field === `agents.${id}.byModel`), id);
});

test('Agent.byModel: a message with no model id is in usage and not in byModel, and the method says how many; "__proto__" is a key', () => {
  const r = run(events([
    { agent: A, line: 3, messageId: 'm1', model: '__proto__', usage: u(1, 2, 3, 4) },
    { agent: A, line: 4, messageId: 'm2', usage: u(10, 20, 30, 40) },
  ]));
  const by = r.agents[A].byModel;
  assert.equal(by.method, 'sum by transcript model; 1 message with no model id is in usage but not in byModel');
  assert.deepEqual(Object.keys(by.value), ['__proto__']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(by.value, '__proto__').value, val(1, 2, 3, 4));
  assert.equal(Object.getPrototypeOf(by.value), Object.prototype);
  assert.deepEqual(r.agents[A].usage.value, val(11, 22, 33, 44));
});

// ---- what the sum covers: only records the source delivers -------------------------------------------------------------------------------

test('the methods of Agent.usage and totals.usage say the sum covers records the source delivers, and that a message with none of them is not counted', () => {
  const r = run(events(threeRecords()));
  for (const m of [r.agents[A].usage.method, r.totals.usage.method]) {
    assert.match(m, /records the source delivers/);
    assert.match(m, /a message whose records have no tool call and no text is not delivered, so it is not counted/);
  }
  // a message of which the source delivered no record is not in the sum: the Run cannot know it exists, and says what it covers instead
  const r2 = run(events([{ agent: A, line: 3, messageId: 'seen', model: 'claude-haiku-5-5', usage: u(1, 1, 1, 1) }]));
  assert.deepEqual(r2.agents[A].usage.value, val(1, 1, 1, 1));
  assert.match(r2.agents[A].usage.method, /\(1 message in 1 record the source delivers;/);
});

test('totals.usage is one of the keys the listing and the stale reduce leave alone: a snapshot after the same events equals the reducer\'s', () => {
  const recs = [...threeRecords(), { agent: B, line: 3, messageId: 'b1', model: 'claude-opus-5', usage: u(7, 70, 700, 7000) }];
  const evs = events(recs);
  const store = createStore({ now: () => NOW + 20000, staleMs: Infinity });
  for (const ev of evs) store.apply(ev);
  assert.deepEqual(store.getRun('wf_tok'), run(evs));
});

// ---- the real fixtures (hand anchors) -------------------------------------------------------------------------------------------

async function fixtureRun(runId) {
  const where = await locateRun({ target: runId, root: path.join(REPO, 'fixtures', 'claude-projects') });
  const raw = await readRunDir(where.sessionDir, where.runId);
  const store = createStore({ now: () => 1794130000000, staleMs: Infinity });
  for (const x of buildSchedule(raw, 1)) store.apply(x.event);
  return store.getRun(runId);
}

test('fixture wf_26eb8d70-5c4 (repeated records): the usage of every agent and of the run equal the numbers worked out by hand from the transcripts', async () => {
  const r = await fixtureRun(P2.runId);
  const want = {
    [P2.a1]: val(4, 310, 56181, 58639),   // 4 records of 2 messages, 3 of them delivered by the source
    [P2.b1]: val(2, 79, 38912, 17229),
    [P2.g1]: val(2, 158, 38912, 17230),
    [P2.g2]: val(2, 158, 38912, 17246),
    [P2.a2]: val(2, 64, 38912, 17246),
    [P2.ok]: val(2, 71, 38912, 17226),
  };
  for (const [id, v] of Object.entries(want)) {
    assert.equal(r.agents[id].usage.prov, 'inferred', id);
    assert.deepEqual(r.agents[id].usage.value, v, id);
    assert.deepEqual(r.agents[id].byModel.value, { 'claude-haiku-5-5': v }, `${id}: one model, so the split is the usage`);
  }
  assert.equal(r.agents[P2.a1].usage.method, agentMethod('2 messages', '3 records'), 'the source delivers 3 of the 4 records of this agent (one has no text and no tool call)');
  assert.deepEqual(r.totals.usage.value, val(14, 840, 250741, 144816));
  assert.deepEqual(r.totals.byModel.value, { 'claude-haiku-5-5': val(14, 840, 250741, 144816) });
  assert.equal(r.totals.usage.method, totalsMethod(6, 6));
  // summing every delivered record instead would count a66894b94f6da9868's first message twice
  assert.ok(r.agents[P2.a1].usage.value.cacheWrite < 2 * 58639);
});

test('fixture wf_6509ce25-20a (one record per message): the run\'s usage', async () => {
  const r = await fixtureRun(P1.runId);
  assert.deepEqual(r.totals.usage.value, val(10, 656, 117046, 163685));
  assert.deepEqual(r.totals.byModel.value, { 'claude-haiku-5-5': val(10, 656, 117046, 163685) });
  for (const id of r.order) assert.equal(r.agents[id].usage.method, agentMethod('1 message', '1 record'));
});

test('the hand-built probe events (no message id in them) give the same run totals as the fixture they mirror', () => {
  const p = probe1();
  const r = reduceRun(p.live, { now: () => 1794126725000 });
  assert.deepEqual(r.totals.usage.value, val(10, 656, 117046, 163685));
  for (const id of r.order) assert.equal(r.agents[id].usage.method, agentMethod('1 message', '1 record', '; 1 record with no message id counted once each'));
});
