// test/server/web-tokens.test.mjs (node agent-tokens, P2): the pure part of the page for usage and cost (web/lib.js). The cost is not in the Run: the
// page computes it from the Run's usage and GET /api/prices. The page on the fake browser is tested in web-u4.test.mjs, section "usage and cost".
// The prices below are the ones OpenRouter's list gave on 2026-11-11 for the five models of the local transcripts (USD per token).

import assert from 'node:assert/strict';

import {
  ENGINES_NOTE, USAGE_PARTS, agentCost, agentCostView, agentNeedsPrices, clockText, costOf, costView, isDemoRun, openRouterId, pricesAnswer, pricesFailText, priceFor,
  runCost, runCostView, runNeedsPrices, showsCost, usageParts, usageValue, usdText,
} from '../../web/lib.js';
import { test } from './helpers.mjs';

const PRICES = {
  source: 'openrouter',
  url: 'https://openrouter.ai/api/v1/models',
  fetchedAt: new Date(2026, 10, 12, 1, 7, 30).getTime(),
  models: {
    'anthropic/claude-haiku-5.5': { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001, cacheWrite: 0.000000125 },
    'anthropic/claude-opus-5': { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    'anthropic/claude-sonnet-5.5': { input: 0.000002, output: 0.00001, cacheRead: 0.0000001, cacheWrite: 0.0000025 },
    'anthropic/claude-opus-5.5': { input: 0.000004, output: 0.00002 }, // no cache prices
  },
};
const inf = (value, method = 'sum-over-unique-message-id (1 message in 1 record)') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const reg = (value) => ({ value, prov: 'registered', from: 'f:1' });
const use = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? ''} ${a} vs ${b}`);
// the run's usage is, by default, the sum of its byModel (no tokens of messages with no model): a test that wants some passes its own usage
const sumOf = (byModel) => Object.values(byModel ?? {}).reduce((t, u) => use(t.input + (u.input ?? 0), t.output + (u.output ?? 0), t.cacheRead + (u.cacheRead ?? 0), t.cacheWrite + (u.cacheWrite ?? 0)), use(0, 0, 0, 0));
const runOf = (byModel, usage = null) => ({ totals: { usage: usage ?? inf(sumOf(byModel), 'sum-of-agent-usage (1 of 1 agents)'), byModel: byModel === null ? unk('no usage') : inf(byModel, 'sum by transcript model') } });
// an agent as the Run gives it: Agent.model (the final file's or the last record's), Agent.usage and Agent.byModel (the usage split by the model of each counted message)
const agentOf = (byModel, { model = reg('claude-haiku-5-5'), usage = inf(HAIKU) } = {}) => ({ model, usage, byModel: byModel === null ? unk('no model') : inf(byModel, 'sum by transcript model') });
const HAIKU = use(14, 840, 250741, 144816); // wf_26eb8d70-5c4
// worked out by hand: 14 x 1e-7 + 840 x 5e-7 + 250741 x 1e-8 + 144816 x 1.25e-7 = 0.0000014 + 0.00042 + 0.00250741 + 0.018102
const HAIKU_USD = 0.02103081;

// ---- the OpenRouter id of a transcript model id ---------------------------------------------------------------------------------------

test('a transcript model id claude-<family>-<major>[-<minor>] is anthropic/claude-<family>-<major>[.<minor>]: the five ids of the local transcripts', () => {
  assert.equal(openRouterId('claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(openRouterId('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5.5');
  assert.equal(openRouterId('claude-haiku-5-5'), 'anthropic/claude-haiku-5.5');
  assert.equal(openRouterId('claude-opus-4-8'), 'anthropic/claude-opus-4.8');
  assert.equal(openRouterId('claude-opus-5-5'), 'anthropic/claude-opus-5.5');
});

test('any other spelling has no OpenRouter id: no fuzzy match, no alias, no dated id, no <synthetic>', () => {
  for (const id of ['<synthetic>', 'haiku', 'sonnet', 'opus', 'claude-haiku-4-5-20251001', 'claude-opus-4-8[1m]', '', ' claude-opus-5', 'claude-opus-5 ', 'CLAUDE-opus-5',
    'claude-opus-5-5-5', 'anthropic/claude-opus-5', 'claude--5', 'claude-opus-', 'claude-opus-x', '__proto__', 'constructor', 'gpt-5', null, undefined, 42, {}, ['claude-opus-5']]) {
    assert.equal(openRouterId(id), null, JSON.stringify(id));
  }
});

test('the price of a model id: found by the id, or the reason why not (the list lacks it, the list has no models, an inherited key is not a key)', () => {
  const hit = priceFor(PRICES, 'claude-haiku-5-5');
  assert.deepEqual([hit.id, hit.from, hit.price], ['anthropic/claude-haiku-5.5', 'claude-haiku-5-5', PRICES.models['anthropic/claude-haiku-5.5']]);
  assert.match(priceFor(PRICES, 'claude-fable-5-1').reason, /^anthropic\/claude-fable-5\.1 is not in the price list$/);
  assert.match(priceFor(PRICES, '<synthetic>').reason, /^<synthetic> has no OpenRouter id/);
  assert.match(priceFor(PRICES, 'haiku').reason, /^haiku has no OpenRouter id/);
  assert.match(priceFor({ models: null }, 'claude-opus-5').reason, /no models/);
  assert.match(priceFor(null, 'claude-opus-5').reason, /no models/);
  assert.match(priceFor({ models: Object.create({ 'anthropic/claude-opus-5': { input: 1, output: 1 } }) }, 'claude-opus-5').reason, /is not in the price list/);
  assert.match(priceFor({ models: { 'anthropic/claude-opus-5': 'free' } }, 'claude-opus-5').reason, /is not in the price list/);
});

// ---- the cost of one model's usage --------------------------------------------------------------------------------------------------

test('costOf: each counter times its own price; the cache read is never added to the input', () => {
  const c = costOf(use(10, 20, 1000, 100), { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 });
  assert.deepEqual(c, { usd: 10 * 1 + 20 * 2 + 1000 * 0.5 + 100 * 3 });
  // if the cache read were counted at the input price it would be 10 + 1000 times 1: the two prices differ on purpose
  assert.notEqual(c.usd, (10 + 1000) * 1 + 20 * 2 + 100 * 3);
});

test('costOf: a part with no tokens costs 0 whatever its price; a part with tokens and no price makes the cost unknown and names the part, never 0', () => {
  assert.deepEqual(costOf(use(10, 20, 0, 0), { input: 1, output: 2 }), { usd: 50 }, 'no cache tokens: the missing cache prices do not matter');
  const noRead = costOf(use(10, 20, 5, 0), { input: 1, output: 2, cacheWrite: 9 });
  assert.equal(noRead.usd, null);
  assert.match(noRead.reason, /^no price for cache read$/);
  assert.deepEqual(noRead.missing, ['cache read']);
  const both = costOf(use(1, 1, 5, 5), { input: 1, output: 2 });
  assert.equal(both.usd, null);
  assert.match(both.reason, /^no price for cache read and cache write$/);
  assert.equal(costOf(use(1, 1, 0, 0), { input: 1 }).usd, null, 'no output price');
  assert.deepEqual(costOf(use(0, 0, 0, 0), {}), { usd: 0 }, 'nothing used, nothing to price');
  // a price that is not a number is no price
  assert.equal(costOf(use(1, 0, 0, 0), { input: 'x' }).usd, null);
  assert.equal(costOf(use(1, 0, 0, 0), { input: NaN }).usd, null);
});

test('costOf of the hand anchor: the usage of fixture wf_26eb8d70-5c4 at the haiku prices is about $0.021031', () => {
  const c = costOf(HAIKU, PRICES.models['anthropic/claude-haiku-5.5']);
  near(c.usd, 14 * 1e-7 + 840 * 5e-7 + 250741 * 1e-8 + 144816 * 1.25e-7);
  assert.equal(c.usd.toFixed(6), '0.021031');
});

// ---- the cost of a run and of an agent -----------------------------------------------------------------------------------------------

test('runCost: byModel priced model by model; the method names every OpenRouter id used and says what the price is (5-minute cache write, base prices)', () => {
  const c = runCost(runOf({ 'claude-haiku-5-5': HAIKU, 'claude-opus-5': use(100, 10, 0, 0) }), PRICES);
  near(c.usd, HAIKU_USD + 100 * 0.000005 + 10 * 0.000025, 'haiku plus opus');
  assert.equal(c.reason, undefined);
  assert.match(c.method, /claude-haiku-5-5 -> anthropic\/claude-haiku-5\.5/);
  assert.match(c.method, /claude-opus-5 -> anthropic\/claude-opus-5/);
  assert.match(c.method, /5-minute rate/);
  assert.match(c.method, /base prices \(overrides are not applied\)/);
  assert.match(c.method, /tokens of the records the source delivers only \(a message with no tool call and no text is not counted\)/, 'the cost carries the limit of the usage it is made of');
});

test('runCost: a model with all-zero usage (<synthetic>) is not priced; a model with tokens and no OpenRouter price makes the whole cost unknown, with no partial sum', () => {
  const synthetic = runCost(runOf({ 'claude-haiku-5-5': HAIKU, '<synthetic>': use(0, 0, 0, 0) }), PRICES);
  assert.equal(synthetic.reason, undefined);
  near(synthetic.usd, HAIKU_USD, 'only the haiku part');
  const unmatched = runCost(runOf({ 'claude-haiku-5-5': HAIKU, haiku: use(1, 1, 0, 0), 'claude-fable-5-1': use(1, 1, 0, 0) }), PRICES);
  assert.equal(unmatched.usd, undefined, 'no usd at all, not the haiku part as if it were the total');
  assert.match(unmatched.reason, /^no OpenRouter price for haiku: haiku has no OpenRouter id/);
  assert.match(unmatched.reason, /claude-fable-5-1: anthropic\/claude-fable-5\.1 is not in the price list/);
  assert.doesNotMatch(unmatched.reason, /claude-haiku-5-5/, 'the model that did match is not named as a problem');
  // <synthetic> with tokens (never seen) is a model with tokens: unknown
  assert.match(runCost(runOf({ '<synthetic>': use(1, 0, 0, 0) }), PRICES).reason, /<synthetic>/);
});

test('runCost: a missing cache price makes that part unknown (not 0) and says which', () => {
  const c = runCost(runOf({ 'claude-opus-5-5': use(10, 10, 100, 0) }), PRICES);
  assert.equal(c.usd, undefined);
  assert.match(c.reason, /^no OpenRouter price for claude-opus-5-5 \(anthropic\/claude-opus-5\.5\): no price for cache read$/);
  // the same model with no cache tokens has a cost: the missing cache prices are not needed
  near(runCost(runOf({ 'claude-opus-5-5': use(10, 10, 0, 0) }), PRICES).usd, 10 * 0.000004 + 10 * 0.00002);
});

test('runCost: byModel that is unknown gives its reason; a run with no model that has tokens costs 0 and says no model has tokens', () => {
  assert.equal(runCost(runOf(null), PRICES).reason, 'no usage');
  assert.match(runCost({ totals: {} }, PRICES).reason, /no usage by model/);
  assert.match(runCost(null, PRICES).reason, /no usage by model/);
  const none = runCost(runOf({ '<synthetic>': use(0, 0, 0, 0) }), PRICES);
  assert.equal(none.usd, 0);
  assert.match(none.method, /no model has tokens/);
});

test('runCost: a model id that is "__proto__" or "constructor" is a model like any other: no match, named in the reason, nothing breaks', () => {
  const by = {};
  Object.defineProperty(by, '__proto__', { value: use(5, 5, 0, 0), enumerable: true, configurable: true, writable: true });
  by.constructor = use(1, 1, 0, 0);
  const c = runCost(runOf(by), PRICES);
  assert.equal(c.usd, undefined);
  assert.match(c.reason, /__proto__: __proto__ has no OpenRouter id/);
  assert.match(c.reason, /constructor: constructor has no OpenRouter id/);
});

test('agentCost: the agent\'s byModel priced model by model, as the run\'s cost is, and Agent.model plays no part', () => {
  const c = agentCost(agentOf({ 'claude-haiku-5-5': HAIKU }), PRICES);
  near(c.usd, HAIKU_USD, 'haiku');
  assert.match(c.method, /claude-haiku-5-5 -> anthropic\/claude-haiku-5\.5/);
  // two models in one agent: each priced by its own model
  const two = agentCost(agentOf({ 'claude-haiku-5-5': HAIKU, 'claude-opus-5': use(100, 10, 0, 0) }), PRICES);
  near(two.usd, HAIKU_USD + 100 * 0.000005 + 10 * 0.000025, 'two models');
  assert.match(two.method, /claude-opus-5 -> anthropic\/claude-opus-5/);
  // Agent.model is not the model of the counted messages: a suffix no record has ("[1m]"), a zero-usage placeholder, an alias, none at all
  // give the same cost (measured: 16 of 799 agents had a false "cost unknown" before)
  for (const model of [reg('claude-opus-4-8[1m]'), reg('<synthetic>'), reg('haiku'), reg('claude-fable-5-1'), unk('no meta'), undefined]) {
    near(agentCost({ ...agentOf({ 'claude-haiku-5-5': HAIKU }), model }, PRICES).usd, HAIKU_USD, JSON.stringify(model));
  }
  // a model of the split with tokens and no OpenRouter price: unknown, naming it, and never the run's other models tried instead
  for (const id of ['haiku', 'claude-fable-5-1']) {
    const a = agentCost(agentOf({ [id]: HAIKU }), PRICES);
    assert.equal(a.usd, undefined, id);
    assert.match(a.reason, new RegExp(`^no OpenRouter price for ${id}`));
  }
  // a zero-usage entry (<synthetic>) is not priced and spoils nothing
  near(agentCost(agentOf({ 'claude-haiku-5-5': HAIKU, '<synthetic>': use(0, 0, 0, 0) }), PRICES).usd, HAIKU_USD, 'synthetic skipped');
  // nonzero <synthetic> usage is a model with tokens and no price
  assert.match(agentCost(agentOf({ '<synthetic>': use(1, 0, 0, 0) }), PRICES).reason, /<synthetic>/);
  // a missing cache price makes that part unknown for the agent too
  assert.match(agentCost(agentOf({ 'claude-opus-5-5': use(10, 10, 100, 0) }), PRICES).reason, /no price for cache read/);
  // no split: its reason (an agent with usage but no model name in its records, an agent with no usage at all, a Run without the field)
  assert.equal(agentCost(agentOf(null), PRICES).reason, 'no model');
  assert.equal(agentCost({ model: reg('claude-haiku-5-5'), usage: unk('no transcript seen'), byModel: unk('no transcript seen') }, PRICES).reason, 'no transcript seen');
  assert.match(agentCost({}, PRICES).reason, /no usage by model/);
  assert.match(agentCost({ model: reg('claude-haiku-5-5'), usage: inf(HAIKU) }, PRICES).reason, /no usage by model/, 'Agent.model alone does not price an agent');
  // no tokens at all costs nothing
  assert.equal(agentCost(agentOf({ 'claude-haiku-5-5': use(0, 0, 0, 0) }), PRICES).usd, 0);
});

// ---- the cost line ------------------------------------------------------------------------------------------------------------------------

const hhmm = (ms) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`;

test('costView: the line "~ $X (OpenRouter prices, fetched HH:MM)" is an inferred Fact whose method names the OpenRouter id', () => {
  const run = runOf({ 'claude-haiku-5-5': HAIKU });
  const v = runCostView(run, { phase: 'ok', data: PRICES, reason: null });
  assert.equal(v.kind, 'known');
  assert.equal(v.text, `~ $0.0210 (OpenRouter prices, fetched ${hhmm(PRICES.fetchedAt)})`);
  assert.equal(hhmm(PRICES.fetchedAt), '01:07');
  assert.deepEqual([v.fact.prov, typeof v.fact.value], ['inferred', 'number']);
  near(v.fact.value, HAIKU_USD);
  assert.match(v.fact.method, /anthropic\/claude-haiku-5\.5/);
  assert.equal(v.fact.from, undefined);
  const a = agentCostView(agentOf({ 'claude-haiku-5-5': HAIKU }), { phase: 'ok', data: PRICES });
  assert.equal(a.kind, 'known');
  assert.equal(a.text, v.text);
});

test('costView: no usage is unknown with its reason and needs no price list; a list that is out says loading; a failure says why, with the server\'s reason', () => {
  const noUsage = runOf(null);
  for (const phase of ['idle', 'loading', 'ok', 'failed']) {
    assert.deepEqual(runCostView(noUsage, { phase, data: PRICES, reason: 'x' }), { kind: 'unknown', reason: 'no usage' }, phase);
  }
  const run = runOf({ 'claude-haiku-5-5': HAIKU });
  assert.deepEqual(runCostView(run, { phase: 'idle' }), { kind: 'loading' });
  assert.deepEqual(runCostView(run, { phase: 'loading' }), { kind: 'loading' });
  assert.deepEqual(runCostView(run, undefined), { kind: 'loading' });
  assert.deepEqual(runCostView(run, { phase: 'failed', reason: 'offline' }), { kind: 'unknown', reason: 'OpenRouter prices not available: offline' });
  assert.deepEqual(runCostView(run, { phase: 'failed', reason: null }), { kind: 'unknown', reason: 'OpenRouter prices not available: no reason given' });
  assert.equal(pricesFailText('timeout after 5 s'), 'OpenRouter prices not available: timeout after 5 s');
  // the list is there, the model is not in it
  const miss = runCostView(runOf({ 'claude-fable-5-1': HAIKU }), { phase: 'ok', data: PRICES });
  assert.equal(miss.kind, 'unknown');
  assert.match(miss.reason, /anthropic\/claude-fable-5\.1 is not in the price list/);
  // a list with no models
  assert.equal(runCostView(run, { phase: 'ok', data: { models: {} } }).kind, 'unknown');
  // an agent: no split gives its reason without a price list; one with a split waits for the list
  for (const phase of ['idle', 'loading', 'ok', 'failed']) {
    assert.deepEqual(agentCostView(agentOf(null), { phase, data: PRICES, reason: 'x' }), { kind: 'unknown', reason: 'no model' }, phase);
  }
  assert.deepEqual(agentCostView({ usage: unk('no transcript seen') }, { phase: 'ok', data: PRICES }), { kind: 'unknown', reason: 'no transcript seen' });
  assert.deepEqual(agentCostView({}, { phase: 'ok', data: PRICES }), { kind: 'unknown', reason: 'the agent has no usage by model' });
  assert.deepEqual(agentCostView(agentOf({ 'claude-haiku-5-5': HAIKU }), { phase: 'idle' }), { kind: 'loading' });
  assert.match(agentCostView(agentOf({ 'claude-fable-5-1': HAIKU }, { model: reg('claude-haiku-5-5') }), { phase: 'ok', data: PRICES }).reason, /anthropic\/claude-fable-5\.1 is not in the price list/);
});

test('costView: an unknown fetch time is said, not invented; the amount is shown to a useful precision', () => {
  const run = runOf({ 'claude-haiku-5-5': HAIKU });
  assert.match(runCostView(run, { phase: 'ok', data: { ...PRICES, fetchedAt: undefined } }).text, /fetched at an unknown time\)$/);
  assert.equal(clockText(undefined), '');
  assert.equal(clockText('x'), '');
  assert.equal(clockText(new Date(2026, 0, 2, 3, 4).getTime()), '03:04');
  assert.equal(usdText(0), '0.00');
  assert.equal(usdText(1), '1.00');
  assert.equal(usdText(12.3456), '12.35');
  assert.equal(usdText(0.021031), '0.0210');
  assert.equal(usdText(0.00005), '0.0001');
  assert.equal(usdText(0.00004), '<0.0001');
});

test('what needs the price list: a run or an agent that has usage, and nothing else', () => {
  assert.equal(runNeedsPrices(runOf({ 'claude-haiku-5-5': HAIKU })), true);
  assert.equal(runNeedsPrices(runOf(null)), false);
  assert.equal(runNeedsPrices({ totals: {} }), false);
  assert.equal(runNeedsPrices({}), false);
  const real = { source: 'real' }; // an agent is judged with its Run: the Run is required
  assert.equal(agentNeedsPrices(agentOf({ 'claude-haiku-5-5': HAIKU }), real), true);
  assert.equal(agentNeedsPrices(agentOf(null), real), false, 'usage the records give no model for has no price to look up');
  assert.equal(agentNeedsPrices({ usage: unk('none'), byModel: unk('none') }, real), false);
  assert.equal(agentNeedsPrices({ usage: inf(HAIKU) }, real), false, 'a Run without Agent.byModel has nothing to price');
  assert.equal(agentNeedsPrices({}, real), false);
  assert.equal(agentNeedsPrices(agentOf({ 'claude-haiku-5-5': HAIKU })), false, 'no Run given: nothing is known of it, so no price list is asked for');
  assert.deepEqual(usageValue(inf(HAIKU)), HAIKU);
  assert.equal(usageValue(unk('x')), null);
  assert.equal(usageValue(inf({})), null, 'a usage value with no counter is no usage');
});

// ---- tokens of messages with no model id: in the usage, not in byModel, so a cost shown as a total says what it leaves out ----------------------

const WITHOUT_7 = 'without 7 tokens of messages with no model';
const OK = { phase: 'ok', data: PRICES };
// the haiku split with 3 tokens more input and 4 more cache write in the usage: 7 tokens that no model of the split holds
const HAIKU_PLUS_7 = use(17, 840, 250741, 144820);

test('a cost with tokens of messages with no model: "~ $X, without N tokens of messages with no model (OpenRouter prices, fetched HH:MM)", and the same words end the method', () => {
  const run = runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7, 'sum-of-agent-usage (1 of 1 agents)'));
  const v = runCostView(run, OK);
  assert.equal(v.kind, 'known');
  assert.equal(v.text, `~ $0.0210, ${WITHOUT_7} (OpenRouter prices, fetched ${hhmm(PRICES.fetchedAt)})`);
  // the amount is the priced split only: the 7 tokens are never priced, never added to a model
  near(v.fact.value, HAIKU_USD, 'the 7 tokens add nothing');
  assert.equal(v.fact.prov, 'inferred', 'still inferred');
  assert.match(v.fact.method, /^tokens x OpenRouter prices per token of claude-haiku-5-5 -> anthropic\/claude-haiku-5\.5 /);
  assert.ok(v.fact.method.endsWith(`; ${WITHOUT_7} (they are in the usage and not in the split by model, so they are not priced)`), v.fact.method);
  assert.equal(runCost(run, PRICES).leftOut, 7);
  // the counters left out are summed over the four of them: 3 input + 4 cache write
  assert.equal(runCost(runOf({ 'claude-haiku-5-5': HAIKU }, inf(use(14, 841, 250741, 144816))), PRICES).leftOut, 1);
  assert.equal(runCost(runOf({ 'claude-haiku-5-5': HAIKU }, inf(use(14, 840, 250751, 144816))), PRICES).leftOut, 10);
  // the agent's cost says the same of the agent's usage and its own split
  const a = agentCostView(agentOf({ 'claude-haiku-5-5': HAIKU }, { usage: inf(HAIKU_PLUS_7) }), OK);
  assert.equal(a.kind, 'known');
  assert.equal(a.text, v.text);
  assert.ok(a.fact.method.endsWith(`; ${WITHOUT_7} (they are in the usage and not in the split by model, so they are not priced)`));
  assert.equal(agentCost(agentOf({ 'claude-haiku-5-5': HAIKU }, { usage: inf(HAIKU_PLUS_7) }), PRICES).leftOut, 7);
});

test('a cost with no tokens left out is as it was, byte for byte: no note, no leftOut, the method has no tail', () => {
  const plain = runCostView(runOf({ 'claude-haiku-5-5': HAIKU }), OK);
  assert.equal(plain.text, `~ $0.0210 (OpenRouter prices, fetched ${hhmm(PRICES.fetchedAt)})`);
  assert.doesNotMatch(plain.fact.method, /without/);
  assert.equal(Object.hasOwn(runCost(runOf({ 'claude-haiku-5-5': HAIKU }), PRICES), 'leftOut'), false, 'absent, not 0');
  assert.doesNotMatch(agentCostView(agentOf({ 'claude-haiku-5-5': HAIKU }), OK).text, /without/);
  // a split that adds up to more than the usage leaves nothing out; it never offsets another counter that is short
  const below = runCostView(runOf({ 'claude-haiku-5-5': HAIKU }, inf(use(10, 840, 250741, 144816))), OK);
  assert.equal(below.text, plain.text, 'usage input 10 is below the split 14: nothing left out');
  const offset = runCost(runOf({ 'claude-haiku-5-5': HAIKU }, inf(use(10, 845, 250741, 144816))), PRICES);
  assert.equal(offset.leftOut, 5, 'the 4 input tokens by which the split exceeds the usage do not cancel the 5 output tokens that no model holds');
  // two models: the split is summed over the models before it is taken from the usage
  const two = { 'claude-haiku-5-5': use(10, 0, 0, 0), 'claude-opus-5': use(5, 0, 0, 0) };
  assert.equal(runCost(runOf(two, inf(use(15, 0, 0, 0))), PRICES).leftOut, undefined);
  assert.equal(runCost(runOf(two, inf(use(18, 0, 0, 0))), PRICES).leftOut, 3);
  // a counter the usage lacks counts as 0 tokens, so it leaves nothing out
  assert.equal(runCost(runOf({ 'claude-haiku-5-5': use(10, 0, 0, 0) }, inf({ input: 10 })), PRICES).leftOut, undefined);
});

test('the number of tokens left out is a plain integer: no separator whatever the machine\'s locale', () => {
  const big = runCostView(runOf({ 'claude-haiku-5-5': use(1, 0, 0, 0) }, inf(use(1234568, 0, 0, 0))), OK);
  assert.match(big.text, /, without 1234567 tokens of messages with no model \(/);
  assert.doesNotMatch(big.text, /1,234,567|1 234 567|1\.234\.567/);
  assert.match(big.fact.method, /without 1234567 tokens of messages with no model/);
  // never a fraction either
  assert.match(runCostView(runOf({ 'claude-haiku-5-5': use(1, 0, 0, 0) }, inf(use(3.4, 0, 0, 0))), OK).text, /, without 2 tokens of messages/);
});

test('tokens left out are not priced, not guessed: a model with tokens and no price is still "cost unknown" with no note; a usage that is not a usage value says why', () => {
  const unpriced = runCostView(runOf({ 'claude-haiku-5-5': HAIKU, 'claude-fable-5-1': use(1, 1, 0, 0) }, inf(use(30, 900, 250741, 144816))), OK);
  assert.equal(unpriced.kind, 'unknown');
  assert.match(unpriced.reason, /^no OpenRouter price for claude-fable-5-1: anthropic\/claude-fable-5\.1 is not in the price list/);
  assert.doesNotMatch(unpriced.reason, /without/, 'no partial sum and no note: the cost is unknown');
  // byModel known and usage unknown: the cost cannot say what it leaves out, so it is unknown with the usage's reason
  const noUsage = runCostView(runOf({ 'claude-haiku-5-5': HAIKU }, unk('no agent has a transcript record with usage yet')), OK);
  assert.deepEqual(noUsage, { kind: 'unknown', reason: 'no agent has a transcript record with usage yet' });
  assert.deepEqual(agentCostView(agentOf({ 'claude-haiku-5-5': HAIKU }, { usage: unk('no transcript seen') }), OK), { kind: 'unknown', reason: 'no transcript seen' });
  // a usage Fact with no counter and no reason: unknown, with a reason of the page's own
  const empty = runCostView(runOf({ 'claude-haiku-5-5': HAIKU }, inf({})), OK);
  assert.equal(empty.kind, 'unknown');
  assert.match(empty.reason, /the usage is not a usage value/);
  // the leftover tokens are never taken for a model's: the cost is the same with or without them
  const a = runCost(runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7)), PRICES);
  const b = runCost(runOf({ 'claude-haiku-5-5': HAIKU }), PRICES);
  assert.equal(a.usd, b.usd);
});

test('the note names no model, role, label or engine: it says "messages with no model" and nothing else about them', () => {
  const v = runCostView(runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7)), OK);
  assert.doesNotMatch(v.text.replace('claude-haiku-5-5', ''), /synthetic|haiku|claude|codex|openai|gpt|gemini|role|label/i);
});

// ---- a cost that covers only some of the agents ("~ $X for k of n agents") ----------------------------------------------------------------------

// the same Run with agents: one per entry of `facts`, each the usage Fact of that agent (a1, a2, ...); the totals are the ones runOf gave
const withAgents = (run, facts) => ({ ...run, agents: Object.fromEntries(facts.map((u, i) => [`a${i + 1}`, { id: `a${i + 1}`, usage: u }])) });
const CLOCK = hhmm(PRICES.fetchedAt);
const ONE_OTHER = '; the other agent has no usage in the run files, so it is not priced';
const NOT_SUM = /for \d+ of \d+ agents?|no usage in the run files/;

test('a cost of some agents says "for k of n agents" right after the amount; the method says the other agents have no usage in the run files; the amount, the Fact and its provenance are as they were', () => {
  const base = runOf({ 'claude-haiku-5-5': HAIKU });
  // two agents with a usage (an all-zero one is known) and one whose usage is unknown
  const two = withAgents(base, [inf(HAIKU), inf(use(0, 0, 0, 0)), unk('no transcript seen')]);
  const v = runCostView(two, OK);
  assert.equal(v.kind, 'known');
  assert.equal(v.text, `~ $0.0210 for 2 of 3 agents (OpenRouter prices, fetched ${CLOCK})`);
  near(v.fact.value, HAIKU_USD, 'the amount is that of the agents that have usage, as before');
  assert.equal(v.fact.prov, 'inferred');
  assert.ok(v.fact.method.endsWith(ONE_OTHER), v.fact.method);
  // the sentence comes after the price basis and the limit of the records, the parts the method has always had
  assert.match(v.fact.method, /^tokens x OpenRouter prices per token of claude-haiku-5-5 -> anthropic\/claude-haiku-5\.5 .*base prices \(overrides are not applied\); tokens of the records the source delivers only .*; the other agent has no usage/);
  // the counts are the Run's own, not the words of totals.usage: runOf's usage method says "1 of 1 agents" and the Run has three
  assert.match(base.totals.usage.method, /\(1 of 1 agents\)/);
  assert.deepEqual(runCost(two, PRICES).agents, { known: 2, all: 3 });
  // one of three: two agents are left out, and the method says so in the plural
  const one = runCostView(withAgents(base, [inf(HAIKU), unk('a'), unk('b')]), OK);
  assert.equal(one.text, `~ $0.0210 for 1 of 3 agents (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(one.fact.method.endsWith('; the other 2 agents have no usage in the run files, so they are not priced'), one.fact.method);
  // none of two (a hand-built Run: a real one has no byModel then): "0 of 2 agents", with no case of its own
  const none = runCostView(withAgents(base, [unk('a'), unk('b')]), OK);
  assert.equal(none.text, `~ $0.0210 for 0 of 2 agents (OpenRouter prices, fetched ${CLOCK})`);
  // a figure of 10 or more is a plain integer
  const many = runCostView(withAgents(base, [inf(HAIKU), ...Array.from({ length: 11 }, () => unk('x'))]), OK);
  assert.match(many.text, /^~ \$0\.0210 for 1 of 12 agents \(/);
  assert.match(many.fact.method, /; the other 11 agents have no usage in the run files, so they are not priced$/);
});

test('n = 1: a cost of a Run with one agent that has no usage says "for 0 of 1 agent" (singular, whole text pinned), in the plain text and with tokens left out; the method says "the other agent ... it"', () => {
  const base = runOf({ 'claude-haiku-5-5': HAIKU });
  const v = runCostView(withAgents(base, [unk('no transcript seen')]), OK);
  assert.equal(v.kind, 'known');
  // the whole text: "includes('of 1 agent')" is also true of "of 1 agents", so the closing " (" is part of the pin
  assert.equal(v.text, `~ $0.0210 for 0 of 1 agent (OpenRouter prices, fetched ${CLOCK})`);
  assert.doesNotMatch(v.text, /agents/);
  near(v.fact.value, HAIKU_USD, 'the amount is as before');
  assert.equal(v.fact.prov, 'inferred');
  // the method is the sentence it has always had for one other agent; it holds no "k of n"
  assert.ok(v.fact.method.endsWith(ONE_OTHER), v.fact.method);
  assert.doesNotMatch(v.fact.method, /\d+ of \d+ agent/);
  assert.deepEqual(runCost(withAgents(base, [unk('no transcript seen')]), PRICES).agents, { known: 0, all: 1 });
  // an entry that is no agent is not counted, so it does not turn the one agent into two
  assert.equal(runCostView({ ...base, agents: { a1: { usage: unk('x') }, a2: null } }, OK).text, v.text);
  // with tokens left out the order stays "for k of n agent, without N tokens ..."
  const left = runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7, 'sum-of-agent-usage (0 of 1 agents)'));
  const lv = runCostView(withAgents(left, [unk('none')]), OK);
  assert.equal(lv.text, `~ $0.0210 for 0 of 1 agent, ${WITHOUT_7} (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(lv.fact.method.indexOf(ONE_OTHER) > 0 && lv.fact.method.indexOf(ONE_OTHER) < lv.fact.method.indexOf(WITHOUT_7), 'the agents sentence comes before the tail');
  // the only one agent has a usage: nothing is said, and never "1 of 1 agent"
  const full = runCostView(withAgents(base, [inf(HAIKU)]), OK);
  assert.equal(full.text, `~ $0.0210 (OpenRouter prices, fetched ${CLOCK})`);
  assert.doesNotMatch(full.text + full.fact.method, NOT_SUM);
});

test('n = 2: "of 2 agents" stays plural for k = 0 and k = 1 (the word follows n, not k and not the number left out); the method says "the other 2 agents ... they" for k = 0 and "the other agent ... it" for k = 1', () => {
  const base = runOf({ 'claude-haiku-5-5': HAIKU });
  const none = runCostView(withAgents(base, [unk('a'), unk('b')]), OK);
  assert.equal(none.text, `~ $0.0210 for 0 of 2 agents (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(none.fact.method.endsWith('; the other 2 agents have no usage in the run files, so they are not priced'), none.fact.method);
  // k = 1 of n = 2: one agent is left out, which is the singular of the sentence, but n is 2 so the text keeps "agents"
  const some = runCostView(withAgents(base, [inf(HAIKU), unk('b')]), OK);
  assert.equal(some.text, `~ $0.0210 for 1 of 2 agents (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(some.fact.method.endsWith(ONE_OTHER), some.fact.method);
  assert.deepEqual([runCost(withAgents(base, [unk('a'), unk('b')]), PRICES).agents, runCost(withAgents(base, [inf(HAIKU), unk('b')]), PRICES).agents], [{ known: 0, all: 2 }, { known: 1, all: 2 }]);
  // with tokens left out
  const left = runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7, 'sum-of-agent-usage (1 of 2 agents)'));
  assert.equal(runCostView(withAgents(left, [inf(HAIKU), unk('b')]), OK).text, `~ $0.0210 for 1 of 2 agents, ${WITHOUT_7} (OpenRouter prices, fetched ${CLOCK})`);
  assert.equal(runCostView(withAgents(left, [unk('a'), unk('b')]), OK).text, `~ $0.0210 for 0 of 2 agents, ${WITHOUT_7} (OpenRouter prices, fetched ${CLOCK})`);
});

test('a cost of every agent, or of a Run with no agents object, is as it was byte for byte: no "of n agents", no sentence in the method, no agents key', () => {
  const base = runOf({ 'claude-haiku-5-5': HAIKU });
  const plain = runCostView(base, OK);
  assert.equal(plain.text, `~ $0.0210 (OpenRouter prices, fetched ${CLOCK})`);
  const all = withAgents(base, [inf(HAIKU), inf(use(0, 0, 0, 0)), inf(use(1, 2, 3, 4))]);
  assert.deepEqual(runCostView(all, OK), plain, 'three of three: the same view');
  assert.equal(Object.hasOwn(runCost(all, PRICES), 'agents'), false, 'absent, not null');
  assert.doesNotMatch(runCostView(all, OK).text + runCostView(all, OK).fact.method, NOT_SUM);
  // no agent at all, no agents object, an agents value that is no object: nothing to say, and never "0 of 0"
  for (const agents of [{}, undefined, null, [], 'a1', 5]) {
    const v = runCostView({ ...base, agents }, OK);
    assert.deepEqual(v, plain, JSON.stringify(agents));
    assert.equal(Object.hasOwn(runCost({ ...base, agents }, PRICES), 'agents'), false);
  }
  // an entry that is no agent (null, text, a number, a list) is not counted, neither as one with usage nor as one without
  assert.deepEqual(runCostView({ ...base, agents: { a1: { usage: inf(HAIKU) }, a2: null, a3: 'x', a4: 7, a5: [] } }, OK), plain);
  assert.equal(runCostView({ ...base, agents: { a1: { usage: unk('x') }, a2: null, a3: 'x' } }, OK).text, `~ $0.0210 for 0 of 1 agent (OpenRouter prices, fetched ${CLOCK})`, 'an agent that is an object without usage is counted');
  // the same with tokens left out: the amount is the same and the words of both notes are there, "for k of n agents" first
  const left = runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7, 'sum-of-agent-usage (1 of 1 agents)'));
  assert.equal(runCostView(withAgents(left, [inf(HAIKU), inf(use(1, 1, 1, 1))]), OK).text, `~ $0.0210, ${WITHOUT_7} (OpenRouter prices, fetched ${CLOCK})`, 'every agent has one: as before');
});

test('a cost of some agents with tokens left out: "~ $X for k of n agents, without N tokens ... (OpenRouter prices, ...)", the sentence about the other agents before the tail the method ends with', () => {
  const left = withAgents(runOf({ 'claude-haiku-5-5': HAIKU }, inf(HAIKU_PLUS_7, 'sum-of-agent-usage (2 of 3 agents)')), [inf(HAIKU), inf(use(0, 0, 0, 0)), unk('none')]);
  const v = runCostView(left, OK);
  assert.equal(v.text, `~ $0.0210 for 2 of 3 agents, ${WITHOUT_7} (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(v.fact.method.endsWith(`; ${WITHOUT_7} (they are in the usage and not in the split by model, so they are not priced)`), v.fact.method);
  assert.ok(v.fact.method.indexOf(ONE_OTHER) > 0 && v.fact.method.indexOf(ONE_OTHER) < v.fact.method.indexOf(WITHOUT_7), 'the agents sentence comes before the tail');
  assert.equal(v.fact.method.split(ONE_OTHER).length, 2, 'said once');
  assert.deepEqual([runCost(left, PRICES).leftOut, runCost(left, PRICES).agents], [7, { known: 2, all: 3 }]);
});

test('a cost of some agents: an unknown cost stays unknown with its reason (no "of n agents" in it), and the agent\'s own cost does not change at all', () => {
  const base = runOf({ 'claude-haiku-5-5': HAIKU, 'claude-fable-5-1': use(1, 1, 0, 0) }, inf(use(15, 841, 250741, 144816)));
  const unpriced = runCostView(withAgents(base, [inf(HAIKU), unk('x')]), OK);
  assert.equal(unpriced.kind, 'unknown');
  assert.doesNotMatch(unpriced.reason, NOT_SUM);
  const failing = runCostView(withAgents(runOf({ 'claude-haiku-5-5': HAIKU }), [inf(HAIKU), unk('x')]), { phase: 'failed', reason: 'offline' });
  assert.deepEqual(failing, { kind: 'unknown', reason: 'OpenRouter prices not available: offline' });
  assert.deepEqual(runCostView(withAgents(runOf({ 'claude-haiku-5-5': HAIKU }), [inf(HAIKU), unk('x')]), { phase: 'loading' }), { kind: 'loading' });
  // an agent's cost is of that agent alone: the same text and method whether its Run has other agents with no usage or not
  const a = agentOf({ 'claude-haiku-5-5': HAIKU });
  const av = agentCostView(a, OK);
  assert.equal(av.text, `~ $0.0210 (OpenRouter prices, fetched ${CLOCK})`);
  assert.doesNotMatch(av.text + av.fact.method, NOT_SUM);
  assert.equal(Object.hasOwn(agentCost(a, PRICES), 'agents'), false);
});

test('the agents of a cost are counted as own keys: an id "__proto__" or "constructor" is an agent like any other; an id that is markup, an agent with no usage, is in no text and no method', () => {
  const evil = '<img src=x onerror=1>';
  const agents = JSON.parse(`{"__proto__": {"usage": {"value": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}, "prov": "inferred", "method": "m"}}, "constructor": {"usage": {"value": null, "prov": "unknown", "reason": "r"}}, ${JSON.stringify(evil)}: {"label": {"value": "writer:${evil}", "prov": "registered", "from": "f:1"}, "usage": {"value": null, "prov": "unknown", "reason": "r"}}}`);
  assert.equal(Object.keys(agents).length, 3, 'the three ids are own keys');
  const v = runCostView({ ...runOf({ 'claude-haiku-5-5': HAIKU }), agents }, OK);
  assert.equal(v.text, `~ $0.0210 for 1 of 3 agents (OpenRouter prices, fetched ${CLOCK})`);
  assert.ok(v.fact.method.endsWith('; the other 2 agents have no usage in the run files, so they are not priced'));
  for (const s of [v.text, v.fact.method]) assert.doesNotMatch(s, /<img|__proto__|constructor|writer|onerror/);
  // an inherited key is not an agent
  const inherited = Object.create({ ghost: { usage: unk('x') } });
  inherited.a1 = { usage: inf(HAIKU) };
  assert.equal(runCostView({ ...runOf({ 'claude-haiku-5-5': HAIKU }), agents: inherited }, OK).text, `~ $0.0210 (OpenRouter prices, fetched ${CLOCK})`);
});

test('the note names no engine, role, label or cause: "for k of n agents" and "no usage in the run files" are all it says about the others', () => {
  const v = runCostView(withAgents(runOf({ 'claude-haiku-5-5': HAIKU }), [inf(HAIKU), unk('still running'), unk('no transcript seen')]), OK);
  // what this node adds: the words after the amount in the text, and the sentence at the end of the method
  const added = [v.text.slice(v.text.indexOf('for '), v.text.indexOf(' (OpenRouter')), v.fact.method.slice(v.fact.method.indexOf('; the other'))];
  assert.deepEqual(added, ['for 1 of 3 agents', '; the other 2 agents have no usage in the run files, so they are not priced']);
  for (const s of added) assert.doesNotMatch(s, /synthetic|claude|codex|openai|gpt|gemini|role|label|running|transcript|still|reader|writer/i);
});

test('showsCost: a Run that is an object and no demo Run; the gate of the cost line and of the price list is one rule', () => {
  for (const run of [{ source: 'real' }, {}, { source: 'replay' }, { id: 'demo-1' }, runOf({ 'claude-haiku-5-5': HAIKU })]) assert.equal(showsCost(run), true, JSON.stringify(run));
  for (const run of [{ source: 'demo' }, undefined, null, 'real', 5, true, []]) assert.equal(showsCost(run), false, JSON.stringify(run));
  // what asks for the price list asks only where a cost is shown
  const withUsage = runOf({ 'claude-haiku-5-5': HAIKU });
  const agent = agentOf({ 'claude-haiku-5-5': HAIKU });
  for (const run of [withUsage, { ...withUsage, source: 'demo' }, { ...withUsage, source: 'real' }, undefined, null, 'x', []]) {
    if (runNeedsPrices(run)) assert.equal(showsCost(run), true, 'a Run that asks for prices shows a cost');
    if (agentNeedsPrices(agent, run)) assert.equal(showsCost(run), true, 'an agent that asks for prices belongs to a Run that shows a cost');
  }
  assert.equal(runNeedsPrices(undefined), false);
  assert.equal(runNeedsPrices(null), false);
  assert.equal(agentNeedsPrices(agent, undefined), false);
  assert.equal(agentNeedsPrices(agent, null), false);
  assert.equal(agentNeedsPrices(agent, { source: 'demo' }), false);
  assert.equal(agentNeedsPrices(agent, {}), true);
  assert.equal(agentNeedsPrices(agent, { source: 'real' }), true);
});

test('a demo Run needs no price list: only source "demo" counts, not an id that starts with demo-, not a missing source; an agent given no Run needs none either (a Run is required)', () => {
  const run = runOf({ 'claude-haiku-5-5': HAIKU });
  const agent = agentOf({ 'claude-haiku-5-5': HAIKU });
  assert.equal(isDemoRun({ ...run, source: 'demo' }), true);
  for (const bad of [{ ...run }, { ...run, source: 'real' }, { ...run, source: 'replay' }, { ...run, source: 'Demo' }, { ...run, source: 'demo ' }, { ...run, source: null }, { ...run, id: 'demo-1' }, { ...run, mode: 'demo' }]) {
    assert.equal(isDemoRun(bad), false, JSON.stringify(Object.keys(bad)) + ' ' + JSON.stringify(bad.source));
  }
  assert.equal(isDemoRun(undefined), false);
  assert.equal(isDemoRun(null), false);
  assert.equal(runNeedsPrices({ ...run, source: 'demo' }), false, 'a demo Run has usage and still asks for nothing');
  assert.equal(agentNeedsPrices(agent, { ...run, source: 'demo' }), false);
  assert.equal(runNeedsPrices({ ...run, source: 'real' }), true);
  assert.equal(runNeedsPrices({ ...run, id: 'demo-1' }), true, 'the id says nothing');
  assert.equal(agentNeedsPrices(agent, { ...run, source: 'real' }), true);
  assert.equal(agentNeedsPrices(agent, { ...run, id: 'demo-1' }), true);
  assert.equal(agentNeedsPrices(agent), false, 'no Run given: nothing is known of it, so no price list is asked for (it does not fail open as "not a demo")');
  assert.equal(agentNeedsPrices(agent, undefined), false);
  assert.equal(agentNeedsPrices(agent, null), false);
  assert.equal(agentNeedsPrices(agent, 'real'), false, 'a Run that is not an object is no Run');
  assert.equal(agentNeedsPrices(agent, [run]), false);
  assert.equal(agentNeedsPrices(agent, {}), true, 'a Run with no source is not a demo Run');
  // a thing with no usage still never asks, demo or not
  assert.equal(runNeedsPrices({ ...runOf(null), source: 'real' }), false);
  assert.equal(agentNeedsPrices(agentOf(null), { source: 'real' }), false);
});

// ---- the four counters ---------------------------------------------------------------------------------------------------------------------

test('usageParts: the four counters in the order of the page, each a Fact of its own that keeps the usage Fact\'s provenance and method; unknown gives null', () => {
  const parts = usageParts(inf(use(1, 2, 3, 4), 'sum-over-unique-message-id (2 messages in 3 records)'));
  assert.deepEqual(parts.map((p) => p.label), ['input tokens', 'output tokens', 'cache read tokens', 'cache write tokens']);
  assert.deepEqual(parts.map((p) => p.fact.value), [1, 2, 3, 4]);
  for (const p of parts) assert.deepEqual([p.fact.prov, p.fact.method], ['inferred', 'sum-over-unique-message-id (2 messages in 3 records)']);
  assert.deepEqual(USAGE_PARTS.map((p) => p.key), ['input', 'output', 'cacheRead', 'cacheWrite']);
  assert.equal(usageParts(unk('no transcript')), null);
  assert.equal(usageParts(undefined), null);
  // a counter the value lacks is unknown with a reason of its own, not 0
  const partial = usageParts(inf({ input: 5, output: 6 }));
  assert.deepEqual(partial.map((p) => p.fact.prov), ['inferred', 'inferred', 'unknown', 'unknown']);
  assert.match(partial[2].fact.reason, /no cacheRead counter/);
  assert.equal(partial[2].fact.value, null);
});

test('pricesAnswer: a list with a models map is one; anything else is not a price list', () => {
  assert.deepEqual(pricesAnswer(PRICES), { ok: true });
  assert.deepEqual(pricesAnswer({ models: {} }), { ok: true });
  for (const bad of [null, undefined, [], 'x', 5, {}, { models: null }, { models: [] }, { models: 'x' }]) {
    assert.deepEqual(pricesAnswer(bad), { ok: false, reason: 'the answer is not a price list' }, JSON.stringify(bad));
  }
});

test('the sentence about other engines says what is not counted and names no engine; costView is a pure function of its input', () => {
  assert.equal(ENGINES_NOTE, 'Tokens and cost cover Claude Code agents only; other engines called from an agent are not in Claude Code files and are not counted.');
  assert.doesNotMatch(ENGINES_NOTE, /codex|openai|gpt|gemini|llama|mistral/i);
  const args = [{ has: true, reason: 'r', compute: () => ({ usd: 1.5, method: 'm' }) }, { phase: 'ok', data: PRICES }];
  assert.deepEqual(costView(...args), costView(...args));
  assert.deepEqual(costView(...args).fact, { value: 1.5, prov: 'inferred', method: 'm' });
});
