import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferEdges, MIN_SHARED_CHARS, MAX_GAP_MS, MAX_SHARING_PROMPTS } from '../../src/model/infer.mjs';
import { reduceRun } from '../../src/model/reduce.mjs';
import { probe1, probe2, legacy } from './helpers.mjs';

// ---- a minimal Run for isolating the rules of inferEdges
const fact = (value, method = 'final') => (value === undefined ? { value: null, prov: 'unknown', reason: 'x' } : { value, prov: 'inferred', method });
function mkRun(agentSpecs, phaseTitles = ['P1', 'P2']) {
  const agents = {};
  const order = [];
  for (const s of agentSpecs) {
    order.push(s.id);
    agents[s.id] = {
      id: s.id,
      label: s.label === undefined ? fact(s.id, 'x') : fact(s.label, 'x'),
      phase: s.phase === undefined ? fact(undefined) : fact(s.phase, 'x'),
      startedAt: s.start === undefined ? fact(undefined) : fact(s.start, s.startMethod ?? 'first-transcript-record'),
      endedAt: s.end === undefined ? fact(undefined) : fact(s.end, s.endMethod ?? 'last-transcript-record'),
      prompt: s.prompt === undefined ? fact(undefined) : { value: s.prompt, prov: 'registered', from: 'f:1' },
      result: s.result === undefined ? fact(undefined) : { value: s.result, prov: 'registered', from: 'f:2' },
    };
  }
  return { order, agents, phases: phaseTitles.map((title, i) => ({ title, index: i + 1 })) };
}
const N = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars
// 64 distinct-looking chars (letters and digits, no whitespace), and a longer text with spaces
const R64 = `${N}0123456789${N.toUpperCase()}-_`; // 64 chars
const strong = (edges) => edges.filter((e) => e.kind === 'data-flow');
const weak = (edges) => edges.filter((e) => e.kind === 'time-order');
// a sentence-like text of at least 64 normalised chars that nothing else in these tests contains
const T1 = 'The vendor price page lists alpha at 12 credits per unit, valid from March 2026 onwards.';
const T2 = 'Beta was discontinued in March 2026 and replaced by gamma, which costs 20 credits per unit.';
const T3 = 'Delta is still in private preview; the vendor will publish its price list sometime next quarter.';
const norm = (t) => t.replace(/\s+/g, '');

test('constants follow the contract', () => {
  assert.equal(MIN_SHARED_CHARS, 64);
  assert.equal(MAX_GAP_MS, 1500);
  assert.equal(MAX_SHARING_PROMPTS, 2);
  assert.ok(norm(T1).length >= 64 && norm(T2).length >= 64 && norm(T3).length >= 64);
});

test('data-flow: exactly 64 shared chars is an edge, 63 is not', () => {
  const at = (res, prompt) => inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: res },
    { id: 'b', start: 20, end: 30, prompt },
  ]));
  assert.equal(strong(at(R64, `x ${R64} y`)).length, 1);
  assert.equal(strong(at(R64.slice(0, 63), `x ${R64.slice(0, 63)} y`)).length, 0);
  // 64 normalised chars, but 100 raw ones: whitespace is not counted
  const spaced = R64.split('').join(' ');
  assert.equal(strong(at(spaced, `x ${R64} y`)).length, 1, 'whitespace is removed from both sides');
  assert.equal(strong(at(R64, `x ${R64.slice(0, 40)} ${R64.slice(40, 63)}`)).length, 0, '... so 63 plus a gap is still 63');
});

test('data-flow: a result shorter than 64 normalised chars never makes an edge, even when repeated verbatim', () => {
  for (const short of ['gamma fast done', '{"verdict":"pass","note":"A saw x=1"}', R64.slice(0, 63)]) {
    const edges = inferEdges(mkRun([
      { id: 'a', start: 0, end: 10, result: short },
      { id: 'b', start: 20, end: 30, prompt: `Previous stage said: ${short}. Reply with "x".` },
    ]));
    assert.deepEqual(edges, [], short);
  }
});

test('data-flow: whitespace does not matter (pretty-printed JSON, indented lines)', () => {
  const result = { verdict: 'pass', note: T1 };
  const edges = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result },
    { id: 'b', start: 20, end: 30, prompt: `Review:\n  ${JSON.stringify(result, null, 2).split('\n').join('\n  ')}\nEnd.` },
  ]));
  assert.equal(strong(edges).length, 1);
});

test('data-flow: objects are compared by JSON.stringify, strings as they are', () => {
  const obj = { angle: 'alpha', summary: T1 };
  const edges = inferEdges(mkRun([
    { id: 'o', start: 0, end: 5, result: obj },
    { id: 's', start: 0, end: 5, result: T2 },
    { id: 'b', start: 10, end: 20, prompt: `have: ${JSON.stringify(obj)} and: ${T2}` },
  ]));
  assert.deepEqual(strong(edges).map((e) => e.from).sort(), ['o', 's']);
});

test('data-flow: a partial copy of a long result is enough, evidence reports the shared length', () => {
  const shared = 'SHARED-PART-OF-THE-RESULT-1234-AND-IT-GOES-ON-FOR-A-WHILE-LONGER-THAN-64-CHARS';
  const long = `${'0123456789'.repeat(5)}${shared}${'abcdefghij'.repeat(5)}`;
  const edges = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: long },
    { id: 'b', start: 20, end: 30, prompt: `see >>> ${shared} <<< ok` },
  ]));
  assert.equal(strong(edges).length, 1);
  assert.match(edges[0].evidence, new RegExp(`repeats ${shared.length} non-space chars`));
  assert.ok(edges[0].evidence.includes(shared));
});

test('data-flow: the match must be one run of 64 chars, not 64 scattered ones', () => {
  const part = (c) => c.repeat(22);
  const res = `${part('a')}-${part('b')}-${part('c')}`; // dashes keep the pieces apart
  const edges = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: res },
    { id: 'b', start: 20, end: 30, prompt: `${part('a')} x ${part('b')} x ${part('c')}` },
  ]));
  assert.deepEqual(edges, []);
});

test('data-flow needs A to end before B starts', () => {
  const mk = (aEnd, bStart, extra = {}) => inferEdges(mkRun([
    { id: 'a', start: 0, end: aEnd, result: R64, ...extra },
    { id: 'b', start: bStart, end: bStart + 10, prompt: `uses ${R64}` },
  ]));
  assert.equal(strong(mk(10, 20)).length, 1, 'A ended before B started');
  assert.equal(strong(mk(25, 20)).length, 0, 'A ended after B started');
  assert.equal(strong(mk(undefined, 20)).length, 0, 'A has no known end (still running)');
  assert.equal(strong(mk(19, 20)).length, 1, 'one tick before is enough');
  assert.equal(strong(mk(20, 20)).length, 0, 'equal clocks: no order is known, so no edge');
});

test('data-flow with equal clocks gives no edge whatever the agent order (run.order is not a time)', () => {
  for (const ids of [['a', 'b'], ['b', 'a']]) {
    const specs = {
      a: { id: 'a', start: 20, end: 20, result: R64 },
      b: { id: 'b', start: 20, end: 20, prompt: `uses ${R64}` },
    };
    assert.deepEqual(inferEdges(mkRun(ids.map((id) => specs[id]))), [], ids.join(','));
  }
});

test('data-flow: A ends exactly when B starts (A start 1000, end 2000, B start 2000), A listed first: no edge', () => {
  const run = mkRun([
    { id: 'a', start: 1000, end: 2000, result: T1 },
    { id: 'b', start: 2000, end: 3000, prompt: `Reviewer said: ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run), []);
});

test('data-flow: B without a known start, an agent never feeds itself', () => {
  const noStart = mkRun([
    { id: 'a', start: 0, end: 10, result: R64 },
    { id: 'b', end: 30, prompt: `uses ${R64}` },
  ]);
  assert.deepEqual(inferEdges(noStart), []);
  const self = mkRun([{ id: 'a', start: 0, end: 10, result: R64, prompt: `echo ${R64}` }]);
  assert.deepEqual(inferEdges(self), []);
});

test('data-flow: unknown prompt or result gives nothing; null/undefined results are skipped', () => {
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result: null },
    { id: 'c', start: 0, end: 10 },
    { id: 'b', start: 20, end: 30, prompt: 'null undefined' },
    { id: 'd', start: 20, end: 30 },
  ]);
  assert.deepEqual(inferEdges(run), []);
});

test('data-flow: one edge per (A, B); many sources feeding one agent', () => {
  const edges = inferEdges(mkRun([
    { id: 'a1', start: 0, end: 10, result: `${R64}-first-result` },
    { id: 'a2', start: 0, end: 10, result: T2 },
    { id: 'a3', start: 0, end: 10, result: T3 },
    { id: 'b', start: 20, end: 30, prompt: `${R64}-first-result | ${T2} | ${T3}` },
  ]));
  assert.equal(strong(edges).length, 3);
  assert.deepEqual(edges.map((e) => e.from), ['a1', 'a2', 'a3']);
  assert.ok(edges.every((e) => e.to === 'b'));
});

test('data-flow: long shared runs are measured once, not quadratically', () => {
  const big = 'x'.repeat(5) + 'y'.repeat(50000);
  const t0 = Date.now();
  const edges = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: big },
    { id: 'b', start: 20, end: 30, prompt: big },
  ]));
  assert.equal(strong(edges).length, 1);
  assert.match(edges[0].evidence, /repeats 50005 non-space chars/);
  assert.ok(Date.now() - t0 < 1000, 'took too long');
});

test('evidence names the agents by label, or by id when the label is unknown', () => {
  const run = mkRun([
    { id: 'idA', label: 'reviewer:A', start: 0, end: 10, result: R64 },
    { id: 'idB', start: 20, end: 30, prompt: `x ${R64}` },
  ]);
  const [e] = inferEdges(run);
  assert.equal(e.evidence, `prompt of "idB" repeats 64 non-space chars of the result of "reviewer:A": ${R64}`);
});

test('evidence: the first 80 chars of the shared text (whitespace collapsed) and its length; a longer text ends in "..."', () => {
  const long = `${T1} ${T2} ${T3}`;
  const [e] = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: long },
    { id: 'b', start: 20, end: 30, prompt: `quote:\n    ${long.replace(/ /g, '\n    ')}` },
  ]));
  assert.equal(e.evidence, `prompt of "b" repeats ${norm(long).length} non-space chars of the result of "a": ${long.slice(0, 80)}...`);
  const eighty = `${'0123456789 '.repeat(7)}012`; // 80 chars, 73 of them not whitespace
  assert.equal(eighty.length, 80);
  const [f] = inferEdges(mkRun([
    { id: 'a', start: 0, end: 10, result: eighty },
    { id: 'b', start: 20, end: 30, prompt: `x ${eighty} y` },
  ]));
  assert.equal(f.evidence, `prompt of "b" repeats 73 non-space chars of the result of "a": ${eighty}`, 'exactly 80 chars: nothing cut, no "..."');
});

// ---- contract 2: the shared text must be distinctive (rules 3 and 4)

test('rule 3: two agents with the same result that both ended before B started feed nobody', () => {
  const run = mkRun([
    { id: 'a1', start: 0, end: 10, result: T1 },
    { id: 'a2', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `report: ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run), []);
});

test('rule 3: two identical reviewers do not feed the judge that quotes both (contract 1 linked both)', () => {
  const same = { verdict: 'pass', findings: [], summary: T1 };
  const run = mkRun([
    { id: 'A', label: 'reviewer:A', start: 0, end: 10, result: same },
    { id: 'B', label: 'reviewer:B', start: 0, end: 10, result: same },
    { id: 'J', label: 'judge', start: 20, end: 30, prompt: `A said ${JSON.stringify(same)}\nB said ${JSON.stringify(same)}` },
  ]);
  assert.deepEqual(inferEdges(run), []);
});

test('rule 3: a copy that ended after B started is not "another result that ended before B started"', () => {
  const run = mkRun([
    { id: 'A', label: 'rev:A', phase: 'P1', start: 0, end: 1500, result: T1 },
    { id: 'C', label: 'rev:C', phase: 'P1', start: 0, end: 3000, result: T1 },
    { id: 'B', label: 'judge', phase: 'P2', start: 2000, end: 2500, prompt: `Reviewer said: ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run).map((e) => [e.from, e.to, e.kind]), [['A', 'B', 'data-flow']], 'A -> B only: no edge from C, no weak hint into B');
});

test('rule 3: a copy with no known end has not "ended before B started" either', () => {
  const run = mkRun([
    { id: 'A', start: 0, end: 10, result: T1 },
    { id: 'C', start: 0, result: T1 },
    { id: 'B', start: 20, end: 30, prompt: `Reviewer said: ${T1}` },
  ]);
  assert.deepEqual(strong(inferEdges(run)).map((e) => e.from), ['A']);
});

test('rule 3: the same text inside a longer result of another agent that ended before B started: neither is an edge', () => {
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'a2', start: 0, end: 10, result: `${T2} Also: ${T1}` },
    { id: 'b', start: 20, end: 30, prompt: `report - ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run), [], 'a2 holds the text too, so a is not the unique source; a2 shares nothing longer with the prompt than a does');
  const later = mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'a2', start: 0, end: 25, result: `${T2} Also: ${T1}` },
    { id: 'b', start: 20, end: 30, prompt: `report - ${T1}` },
  ]);
  assert.deepEqual(inferEdges(later).map((e) => e.from), ['a'], 'a2 ended after B started: it does not count');
});

test('rule 3: a skeleton shared with other results is no edge by itself, but a region with a unique quotation is', () => {
  const skeleton = '{"verdict":"fail","severity":"high","category":"correctness","findings":[{"file":"';
  assert.ok(skeleton.length >= 64);
  const resA = `${skeleton}slugify.js","line":14,"description":"drops the trailing hyphen when the input ends with punctuation"}]}`;
  const resB = `${skeleton}sum.js","line":3,"description":"returns NaN for an empty list instead of zero"}]}`;
  const run = mkRun([
    { id: 'revA', start: 0, end: 10, result: JSON.parse(resA) },
    { id: 'revB', start: 0, end: 10, result: JSON.parse(resB) },
    { id: 'quoteA', start: 20, end: 30, prompt: `Findings of the first reviewer:\n${resA}\nDecide.` },
    { id: 'skeletonOnly', start: 20, end: 30, prompt: `Reply in this shape: ${skeleton}other.js","line":1}]}` },
  ]);
  const edges = inferEdges(run);
  assert.deepEqual(edges.map((e) => [e.from, e.to]), [['revA', 'quoteA']], 'the skeleton alone is in two results: unique to neither');
  assert.match(edges[0].evidence, new RegExp(`repeats ${norm(resA).length} non-space chars`), 'the whole of resA, skeleton included');
});

test('rule 3: only the groups that hold the region are searched, but every one of them counts', () => {
  // ten other results that hold different parts of the prompt text; one of them holds all of the region
  const region = `${T1} ${T2}`;
  const specs = [{ id: 'a', start: 0, end: 10, result: region }];
  for (let i = 0; i < 10; i++) specs.push({ id: `o${i}`, start: 0, end: 10, result: i === 7 ? `prefix ${region} suffix` : `${T3} ${i}` });
  specs.push({ id: 'b', start: 20, end: 30, prompt: `quote: ${region}` });
  assert.deepEqual(inferEdges(mkRun(specs)).map((e) => e.from), [], 'o7 holds the region');
  specs[8] = { id: 'o7', start: 0, end: 10, result: `prefix ${T1} suffix` }; // o7 holds only the first half now
  assert.deepEqual(inferEdges(mkRun(specs)).map((e) => e.from), ['a']);
});

test('rule 4: a region that is in the script text is no edge; without the script text it is', () => {
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1}` },
  ]);
  assert.equal(strong(inferEdges(run)).length, 1, 'no script text given');
  assert.equal(strong(inferEdges(run, { scriptText: null })).length, 1);
  assert.equal(strong(inferEdges(run, { scriptText: 'const guide = `\n  ' + T1.replace(/ /g, '\n  ') + '`;' })).length, 0, 'whitespace does not matter here either');
  assert.equal(strong(inferEdges(run, { scriptText: 'const guide = `something else entirely`;' })).length, 1);
});

test('rule 4: a region that is in the prompts of two other agents is boilerplate; one other agent is fine', () => {
  // the other agents start before A ended: they are not fed by A themselves
  const mk = (...others) => mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1}` },
    ...others.map((p, i) => ({ id: `o${i}`, start: 5, end: 50, prompt: p })),
  ]);
  assert.equal(strong(inferEdges(mk())).length, 1, 'no other prompt');
  assert.equal(strong(inferEdges(mk(`also ${T1}`))).length, 1, 'one other prompt holds it');
  assert.equal(strong(inferEdges(mk(`also ${T1}`, `and ${T1}`))).length, 0, 'two other prompts hold it');
  assert.equal(strong(inferEdges(mk(`also ${T1}`, 'unrelated'))).length, 1, 'a prompt without it does not count');
  assert.equal(strong(inferEdges(mk(`quote: ${T1}`, 'unrelated'))).length, 1, 'a prompt identical to the prompt of B is one other agent');
  assert.equal(strong(inferEdges(mk(`quote: ${T1}`, `quote: ${T1}`))).length, 0, '... two of them are two');
});

test('rule 4: the prompt of A itself and of an agent that started earlier count as other prompts too', () => {
  const run = mkRun([
    { id: 'a', start: 0, end: 10, prompt: `Task: ${T1}`, result: T1 },
    { id: 'early', start: 0, end: 5, prompt: `Early: ${T1}` },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run), [], 'a and early both have it in their prompts');
});

test('rule 4: the prompt of B itself does not count', () => {
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1} and again ${T1}` },
  ]);
  assert.equal(strong(inferEdges(run)).length, 1);
});

test('rules 3 and 4 are judged per region: a shorter unique region is found when the longest one is shared', () => {
  const guide = `${T3} ${T2}`; // in the script, and also echoed in the result of a
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result: `${guide} --- ${T1}` },
    { id: 'b', start: 20, end: 30, prompt: `guide: ${guide}\nand: ${T1}` },
  ]);
  const edges = inferEdges(run, { scriptText: `const GUIDE = "${guide}"` });
  assert.equal(strong(edges).length, 1);
  assert.match(edges[0].evidence, new RegExp(`repeats ${norm(T1).length} non-space chars`), 'the unique quotation, not the guide');
  assert.deepEqual(inferEdges(run, { scriptText: `const GUIDE = "${guide} --- ${T1}"` }), [], 'both regions are in the script now');
});

test('contract: an agent that passes its input through is a source of data for the next agent', () => {
  const given = 'The relayed request says: refactor the parser and keep the public API stable.';
  const run = mkRun([
    { id: 'fmt', label: 'fmt:A', phase: 'P1', start: 0, end: 1000, prompt: `Task. ${given}`, result: `You asked: ${given}` },
    { id: 'sum', label: 'sum:B', phase: 'P2', start: 1200, end: 2000, prompt: `Context. You asked: ${given}` },
  ]);
  assert.deepEqual(inferEdges(run).map((e) => [e.from, e.to, e.kind, e.strength]), [['fmt', 'sum', 'data-flow', 'strong']]);
});

test('contract: a single agent with that result is linked, an agent with other text is not', () => {
  const run = mkRun([
    { id: 'a1', start: 0, end: 10, result: T1 },
    { id: 'a2', start: 0, end: 10, result: T2 },
    { id: 'b', start: 20, end: 30, prompt: `report: ${T1}` },
  ]);
  assert.deepEqual(inferEdges(run).map((e) => [e.from, e.to]), [['a1', 'b']]);
});

test('contract: a chain where a later agent quotes an earlier result: every earlier source whose text is not found elsewhere', () => {
  const r1 = T1;
  const r2 = `Confirmed (${r1}) and the discount applies from March onwards.`;
  const run = mkRun([
    { id: 'a1', start: 0, end: 10, prompt: 'Find the price.', result: r1 },
    { id: 'a2', start: 20, end: 30, prompt: `Check this: ${r1}`, result: r2 },
    { id: 'b', start: 40, end: 50, prompt: `Summarise: ${r2}` },
  ]);
  // b quotes r2, which holds r1: r1 is also in the result of a2 (ended before b started) and in the prompt of a2
  assert.deepEqual(inferEdges(run).map((e) => `${e.from}>${e.to}`), ['a1>a2', 'a2>b']);
});

// ---- cost and limits

// deterministic filler text without repeated 24-grams across calls (mulberry32)
function filler(seed, words) {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Array(words);
  for (let i = 0; i < words; i++) out[i] = Array.from({ length: 6 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)]).join('');
  return out.join(' ');
}

test('cost: a chain where each prompt is the previous result (42 KB texts) is linear, not quadratic in the prompt', () => {
  const specs = [];
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(filler(100 + i, 6000)); // about 42 KB each, unrelated to one another
    specs.push({ id: `s${i}`, start: i * 1000, end: i * 1000 + 900, prompt: i === 0 ? 'Start.' : results[i - 1], result: results[i] });
  }
  const t0 = Date.now();
  const edges = inferEdges(mkRun(specs));
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.deepEqual(strong(edges).map((e) => `${e.from}>${e.to}`), Array.from({ length: 9 }, (_, i) => `s${i}>s${i + 1}`));
  assert.ok(strong(edges).every((e) => /repeats \d{5} non-space chars/.test(e.evidence)));
});

test('cost: a refining chain (each result holds the one before, plus 20 new words) keeps only the edges whose text is found nowhere else', () => {
  const specs = [];
  let text = filler(1, 6000); // about 42 KB
  const results = [];
  for (let i = 0; i < 10; i++) {
    const prompt = i === 0 ? 'Start.' : results[i - 1];
    text = `${text} ${filler(100 + i, 20)}`;
    results.push(text);
    specs.push({ id: `s${i}`, start: i * 1000, end: i * 1000 + 900, prompt, result: text });
  }
  const t0 = Date.now();
  const edges = inferEdges(mkRun(specs));
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`);
  // prompt i holds result i-1, which holds every earlier result: the text of result k < i-1 is also in the result of
  // s(i-1), which ended before s(i) started, so only s(i-1) -> s(i) can be unique; and the prompts of all later
  // agents hold result i-1 as well: only the last two prompts have fewer than two other prompts holding it
  assert.deepEqual(strong(edges).map((e) => `${e.from}>${e.to}`), ['s7>s8', 's8>s9']);
});

test('cost: 100 agents with the same 10 KB result and a judge that quotes it once: a text with no unique source gives no edge, quickly', () => {
  const same = filler(7, 1500);
  const specs = [];
  for (let i = 0; i < 100; i++) specs.push({ id: `r${i}`, start: 0, end: 10, result: same });
  specs.push({ id: 'judge', start: 20, end: 30, prompt: `Reviews: ${same}` });
  const t0 = Date.now();
  const edges = inferEdges(mkRun(specs));
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(strong(edges), []);
});

test('cost: 300 agents, each prompt quotes the previous result (7 KB) and a shared 20 KB guide, with a 20 KB script', () => {
  const guide = filler(3, 3000);
  const specs = [];
  let prev = null;
  for (let i = 0; i < 300; i++) {
    const result = filler(1000 + i, 1000);
    specs.push({ id: `w${i}`, start: i * 100, end: i * 100 + 50, prompt: `${guide}\nTask ${i}.${prev ? `\nPrevious: ${prev}` : ''}`, result });
    prev = result;
  }
  const t0 = Date.now();
  const edges = inferEdges(mkRun(specs), { scriptText: `const GUIDE = ${JSON.stringify(guide)};` });
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.equal(strong(edges).length, 299, 'the guide is in every prompt and in the script: only the quoted result is distinctive');
  assert.ok(strong(edges).every((e, i) => e.from === `w${i}` && e.to === `w${i + 1}`));
  assert.ok(strong(edges).every((e) => /repeats 6\d\d\d non-space chars/.test(e.evidence)), 'the result, not the guide');
});

// a fan-in run: every agent k quotes `quotes` earlier results verbatim (4000 random chars each) after 500 chars of its own.
// Returns the specs and the data-flow edges the contract asks for, worked out from who quotes whom: A -> B when B quotes
// A's result (A ended before B started, the result is unique) and at most one other prompt quotes it too (rule 4).
function fanIn(seed, n, quotes) {
  const r = rng(seed);
  const text = (len) => Array.from({ length: len }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(r() * 36)]).join('');
  const results = Array.from({ length: n }, () => text(4000));
  const quoted = Array.from({ length: n }, () => new Set()); // k -> the agents it quotes
  const quoters = Array.from({ length: n }, () => new Set()); // j -> the agents that quote it
  const specs = [];
  for (let k = 0; k < n; k++) {
    let prompt = text(500);
    for (let q = 0; q < quotes && k > 0; q++) quoted[k].add(Math.floor(r() * k));
    for (const j of quoted[k]) { prompt += `\n${results[j]}`; quoters[j].add(k); }
    specs.push({ id: `a${k}`, start: k * 10, end: k * 10 + 5, prompt, result: results[k] });
  }
  const want = [];
  for (let k = 0; k < n; k++) for (const j of quoted[k]) if (quoters[j].size - 1 < MAX_SHARING_PROMPTS) want.push(`a${j}>a${k}`);
  return { specs, want: want.sort() };
}

test('cost: 300 agents, each prompt quotes 5 earlier results (4000 chars): a fan-in run keeps its data-flow edges under the default limits', () => {
  const { specs, want } = fanIn(42, 300, 5);
  const total = specs.reduce((sum, s) => sum + s.prompt.length, 0);
  assert.ok(total > 5_000_000, `${total} chars of prompts`);
  assert.ok(want.length > 50 && want.length < 600, `${want.length} expected edges: some results are quoted by too many prompts, some are not`);
  const warnings = [];
  const t0 = Date.now();
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m) });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `took ${ms} ms`);
  assert.deepEqual(warnings, [], 'the work limit is not reached, so nothing is left out');
  assert.deepEqual([...dataFlow(edges)].sort(), want);
  // the same answer as with a work limit that cannot be reached
  assert.deepEqual([...dataFlow(inferEdges(mkRun(specs), { limits: { maxWork: 4e9 } }))].sort(), want);
});

test('rule 4 counts the same region quoted by many prompts once for all of them: 40 prompts quote one result, one prompt quotes another', () => {
  const popular = filler(61, 600);
  const rare = filler(62, 600);
  const specs = [{ id: 'pop', start: 0, end: 10, result: popular }, { id: 'rare', start: 0, end: 10, result: rare }];
  for (let i = 0; i < 40; i++) specs.push({ id: `q${i}`, start: 20 + i, end: 30 + i, prompt: `Task ${i}.\n${popular}${i === 7 ? `\n${rare}` : ''}` });
  assert.deepEqual(strong(inferEdges(mkRun(specs))).map((e) => `${e.from}>${e.to}`), ['rare>q7'], 'the popular text is boilerplate for every one of its 40 prompts');
});

test('long texts: 30 reviewers with 12 KB results are all linked from a 250 KB judge prompt (no cut at 200,000 raw chars)', () => {
  const specs = [];
  const parts = [];
  for (let i = 0; i < 30; i++) {
    const result = `${filler(1000 + i, 1700)}`; // about 12 KB
    parts.push(result);
    specs.push({ id: `rev${i}`, start: 0, end: 10, result });
  }
  const prompt = `Aggregate all reviews:\n${parts.join('\n')}`;
  assert.ok(prompt.length > 200_000, 'longer than the old per-text cap');
  specs.push({ id: 'judge', start: 20, end: 30, prompt });
  const warnings = [];
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m) });
  assert.equal(strong(edges).length, 30);
  assert.deepEqual(edges.map((e) => e.from), specs.slice(0, 30).map((s) => s.id));
  assert.deepEqual(warnings, [], 'nothing was cut, so nothing is reported');
});

const MARK = 'END-MARKER-AFTER-THE-LIMIT-WHICH-IS-LONG-ENOUGH-TO-BE-A-SHARED-REGION-OF-64-CHARS';

test('limits: a result or prompt cut by a limit is reported through warn, never silently', () => {
  const big = filler(5, 400); // about 2.8 KB, 2400 non-space chars
  const run = mkRun([
    { id: 'a', label: 'writer', start: 0, end: 10, result: `${big} ${MARK}` },
    { id: 'b', label: 'reader', start: 20, end: 30, prompt: `quote: ${MARK}` },
  ]);
  const warnings = [];
  const edges = inferEdges(run, { warn: (m) => warnings.push(m), limits: { maxTextChars: 1000 } });
  assert.deepEqual(edges, [], 'the text after the cut is not examined');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /results of "writer" were examined only in part or not at all/);
  assert.match(warnings[0], /may be missing/);
  // without the limit the same run links a -> b
  const w2 = [];
  assert.equal(strong(inferEdges(run, { warn: (m) => w2.push(m) })).length, 1);
  assert.deepEqual(w2, []);
  // prompts too
  const run2 = mkRun([
    { id: 'a', start: 0, end: 10, result: MARK },
    { id: 'b', label: 'reader', start: 20, end: 30, prompt: `${big} ${MARK}` },
  ]);
  const w3 = [];
  inferEdges(run2, { warn: (m) => w3.push(m), limits: { maxTextChars: 1000 } });
  assert.equal(w3.length, 1);
  assert.match(w3[0], /prompts of "reader" were examined only in part/);
});

test('limits: when all results together exceed the index limit the rest is reported and nothing throws', () => {
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push({ id: `w${i}`, label: `worker:${i}`, start: 0, end: 10, result: filler(300 + i, 300) });
  specs.push({ id: 'j', start: 20, end: 30, prompt: specs.map((s) => s.result).join('\n') });
  const warnings = [];
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m), limits: { maxIndexChars: 5000 } });
  const linked = strong(edges).map((e) => e.from);
  assert.ok(linked.length >= 2 && linked.length < 10, `linked ${linked.length}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"worker:\d", "worker:\d", "worker:\d" and \d+ more were examined only in part or not at all/);
  assert.ok(!linked.includes('w9'), 'the last results were the ones left out');
});

test('limits: the work limit stops the scan with a warning that names where it stopped', () => {
  const same = filler(9, 300);
  const words = same.split(' ');
  const specs = [{ id: 'a', start: 0, end: 10, result: same }];
  // each reader quotes its own 40 words of the result: unique to it, so each is an edge when the work allows
  for (let i = 0; i < 5; i++) specs.push({ id: `b${i}`, label: `reader:${i}`, start: 20 + i, end: 30, prompt: words.slice(i * 50, i * 50 + 40).join(' ') });
  const all = inferEdges(mkRun(specs));
  assert.equal(strong(all).length, 5, 'unlimited: every reader is linked');
  const warnings = [];
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m), limits: { maxWork: 2000 } });
  assert.ok(strong(edges).length >= 1 && strong(edges).length < 5, `linked ${strong(edges).length}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^edge inference stopped after 2000 steps \(work limit\); data-flow edges into "reader:\d" and into agents after it may be missing$/);
});

test('limits: when the check against all prompts does not fit the work limit, the edges found but not checked are left out, and it is said', () => {
  const same = filler(9, 300);
  const words = same.split(' ');
  const specs = [{ id: 'a', start: 0, end: 10, result: same }];
  for (let i = 0; i < 5; i++) specs.push({ id: `b${i}`, label: `reader:${i}`, start: 20 + i, end: 30, prompt: words.slice(i * 50, i * 50 + 40).join(' ') });
  const warnings = [];
  // the scan of the five prompts (about 1.4 KB) fits in 2000 steps; one pass over all prompts (1.4 KB more) does not
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m), limits: { maxWork: 1000, maxTextChars: 4_000_000 } });
  assert.deepEqual(strong(edges), []);
  assert.ok(warnings.some((m) => /^edge inference stopped after 1000 steps \(work limit\)/.test(m)), warnings.join(' | '));
});

test('limits: when the check against all prompts is stopped, the edges whose text is already known to be shared are not counted as left out; the others are, by number', () => {
  const words = filler(21, 300).split(' ');
  const piece = (i) => words.slice(i * 60, i * 60 + 40).join(' ');
  const specs = [
    // the first two prompts are scanned before the work runs out, and both hold the first piece: boilerplate for good
    { id: 'f0', start: 0, end: 5, prompt: `Notes: ${piece(0)}` },
    { id: 'f1', start: 0, end: 5, prompt: `More notes: ${piece(0)}` },
  ];
  for (let i = 0; i < 8; i++) specs.push({ id: `pad${i}`, start: 0, end: 5, prompt: filler(100 + i, 290) }); // 2 KB each, quote nothing
  specs.push({ id: 'a', start: 0, end: 10, result: words.join(' ') });
  for (let i = 0; i < 3; i++) specs.push({ id: `b${i}`, label: `reader:${i}`, start: 20 + i, end: 30, prompt: `Quote: ${piece(i)}` });
  assert.deepEqual(strong(inferEdges(mkRun(specs))).map((e) => `${e.from}>${e.to}`), ['a>b1', 'a>b2'], 'unlimited: the first piece is in two other prompts');
  const warnings = [];
  const edges = inferEdges(mkRun(specs), { warn: (m) => warnings.push(m), limits: { maxWork: 5000 } });
  assert.deepEqual(strong(edges), []);
  assert.deepEqual(warnings, [
    'edge inference stopped after 5000 steps (work limit) while checking the shared text against all prompts; 2 data-flow edges that were found but not checked are left out, so data-flow edges may be missing',
  ]);
});

// B's prompt repeats `count` separated pieces of A's result (each piece of `wordsPer` words, 6 chars a word, so
// 6 * wordsPer normalised chars); the gaps differ on the two sides, so every piece is a region of its own.
function manyRegions(seed, count, wordsPer, gapWords = 100) {
  const words = filler(seed, count * gapWords + wordsPer).split(' ');
  const pieces = Array.from({ length: count }, (_, i) => words.slice(i * gapWords, i * gapWords + wordsPer).join(' '));
  return {
    pieces,
    result: pieces.map((p, i) => `${p} gap${i}A`).join(' '),
    prompt: pieces.map((p, i) => `${p} different${i}B`).join(' '),
  };
}

test('regions: no cap on the regions of a pair; 20 regions all in the script are all examined, none is left over, nothing is reported', () => {
  const { pieces, result, prompt } = manyRegions(11, 20, 15);
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result },
    { id: 'b', start: 20, end: 30, prompt },
  ]);
  const warnings = [];
  const edges = inferEdges(run, { warn: (m) => warnings.push(m), scriptText: pieces.join('\n') });
  assert.deepEqual(edges, []);
  assert.deepEqual(warnings, []);
  // without the script every region is distinctive: the first one tested makes the edge
  const w2 = [];
  assert.equal(strong(inferEdges(run, { warn: (m) => w2.push(m) })).length, 1);
  assert.deepEqual(w2, []);
});

test('regions: a pair whose only distinctive regions are shorter than 17 boilerplate ones still gets its edge (wf_89d391f0-ded: find:steelman-survival -> synthesis)', () => {
  // 20 separate regions of A's result sit in B's prompt: 17 of 13 words (78 chars) that two other agents' prompts also
  // hold (rule 4 drops them) and 3 of 11 words (66 chars) that nobody else holds. Longest first, the passing ones rank 18 to 20.
  const words = filler(12, 2200).split(' ');
  const pieces = Array.from({ length: 20 }, (_, i) => words.slice(i * 100, i * 100 + (i < 17 ? 13 : 11)).join(' '));
  const boiler = pieces.slice(0, 17).join(' | ');
  const run = mkRun([
    { id: 'a', label: 'find:steelman-survival', start: 0, end: 10, result: pieces.map((p, i) => `${p} gap${i}A`).join(' ') },
    { id: 'b', label: 'synthesis', start: 20, end: 30, prompt: pieces.map((p, i) => `${p} different${i}B`).join(' ') },
    { id: 'o1', start: 5, end: 50, prompt: `Guide one: ${boiler}` },
    { id: 'o2', start: 5, end: 50, prompt: `Guide two: ${boiler}` },
  ]);
  const warnings = [];
  const edges = strong(inferEdges(run, { warn: (m) => warnings.push(m) }));
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}`), ['a>b']);
  assert.match(edges[0].evidence, /repeats 66 non-space chars of the result of "find:steelman-survival"/);
  assert.ok(edges[0].evidence.includes(pieces[17]), 'the first of the three distinctive pieces is the evidence');
  assert.deepEqual(warnings, [], 'nothing was left unexamined');
  // the same boilerplate in only ONE other prompt does not make the long regions boilerplate: the longest one is the evidence
  const one = mkRun([
    { id: 'a', start: 0, end: 10, result: pieces.map((p, i) => `${p} gap${i}A`).join(' ') },
    { id: 'b', start: 20, end: 30, prompt: pieces.map((p, i) => `${p} different${i}B`).join(' ') },
    { id: 'o1', start: 5, end: 50, prompt: `Guide one: ${boiler}` },
  ]);
  assert.match(strong(inferEdges(one))[0].evidence, /repeats 78 non-space chars/);
});

test('regions: the 16 longest regions are not the only ones tested, at any rank', () => {
  // the distinctive piece sits at every rank from 1 to 40 among 40 regions that the other agents' prompts also hold
  for (const rank of [1, 16, 17, 40]) {
    const words = filler(13, 4200).split(' ');
    const pieces = Array.from({ length: 40 }, (_, i) => words.slice(i * 100, i * 100 + (i === rank - 1 ? 11 : 13)).join(' '));
    const boiler = pieces.filter((_, i) => i !== rank - 1).join(' | ');
    const run = mkRun([
      { id: 'a', start: 0, end: 10, result: pieces.map((p, i) => `${p} gap${i}A`).join(' ') },
      { id: 'b', start: 20, end: 30, prompt: pieces.map((p, i) => `${p} different${i}B`).join(' ') },
      { id: 'o1', start: 5, end: 50, prompt: `Guide one: ${boiler}` },
      { id: 'o2', start: 5, end: 50, prompt: `Guide two: ${boiler}` },
    ]);
    const edges = strong(inferEdges(run));
    assert.equal(edges.length, 1, `rank ${rank}`);
    assert.ok(edges[0].evidence.includes(pieces[rank - 1]), `rank ${rank}`);
  }
});

test('cost: a pair with 2000 separate shared regions is examined in full, fast, and without a warning', () => {
  const { pieces, result, prompt } = manyRegions(14, 2000, 11, 12);
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result },
    { id: 'b', start: 20, end: 30, prompt },
  ]);
  for (const scriptText of [undefined, pieces.join('\n')]) {
    const warnings = [];
    const t0 = Date.now();
    const edges = strong(inferEdges(run, { warn: (m) => warnings.push(m), scriptText }));
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `took ${ms} ms`);
    assert.deepEqual(warnings, []);
    assert.equal(edges.length, scriptText === undefined ? 1 : 0);
  }
});

test('limits: the region tests have a work budget; when it runs out the stop is reported, not silent, and nothing throws', () => {
  // each of the 20 regions costs one search of the script (about 5000 steps), so a budget of 20000 steps covers about 4 of them
  const { result, prompt } = manyRegions(15, 20, 15);
  const run = mkRun([
    { id: 'a', start: 0, end: 10, result },
    { id: 'b', label: 'reader', start: 20, end: 30, prompt },
  ]);
  const scriptText = filler(16, 56000);
  const warnings = [];
  const edges = strong(inferEdges(run, { warn: (m) => warnings.push(m), scriptText, limits: { maxWork: 20000 } }));
  assert.equal(edges.length, 1, 'what was tested before the stop stands');
  assert.deepEqual(warnings, [
    'edge inference stopped after 20000 steps (work limit); data-flow edges into "reader" and into agents after it may be missing',
  ]);
  const w2 = [];
  assert.equal(strong(inferEdges(run, { warn: (m) => w2.push(m), scriptText })).length, 1);
  assert.deepEqual(w2, [], 'the default limits cover the same run');
});

test('memo: the edges are reused while the inputs are unchanged, recomputed when one changes, and callers get copies', () => {
  const mk = (extra = {}) => mkRun([
    { id: 'a', label: 'writer', start: 0, end: 10, result: `${T1}-and-more` },
    { id: 'b', label: 'reader', start: 20, end: 30, prompt: `quote: ${T1}-and-more`, ...extra },
  ]);
  const memo = {};
  const first = inferEdges(mk(), { memo });
  assert.equal(first.length, 1);
  const stored = memo.edges;
  const second = inferEdges(mk(), { memo }); // a new Run object with the same inputs
  assert.deepEqual(second, first);
  assert.equal(memo.edges, stored, 'same inputs: the stored edges were not rebuilt');
  second[0].evidence = 'changed by the caller';
  assert.notEqual(memo.edges[0].evidence, 'changed by the caller');
  assert.notEqual(second[0], memo.edges[0]);
  assert.equal(inferEdges(mk(), { memo })[0].evidence, first[0].evidence);
  assert.deepEqual(inferEdges(mk({ end: 99 }), { memo }), first, 'an unrelated agent field changed: same edges');
  assert.notEqual(memo.edges, stored, '... but the inputs differ, so they were recomputed');
  assert.deepEqual(inferEdges(mk({ start: 5 }), { memo }), [], 'B now starts before A ended: the memo does not hold on to the old edge');
});

test('memo: the script text is an input of the inference', () => {
  const run = () => mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1}` },
  ]);
  const memo = {};
  assert.equal(inferEdges(run(), { memo, scriptText: 'nothing' }).length, 1);
  const stored = memo.edges;
  assert.equal(inferEdges(run(), { memo, scriptText: 'nothing' }).length, 1);
  assert.equal(memo.edges, stored, 'same script: answered from the memo');
  assert.deepEqual(inferEdges(run(), { memo, scriptText: T1 }), [], 'the script holds the text now');
  assert.notEqual(memo.edges, stored);
  assert.equal(inferEdges(run(), { memo }).length, 1, 'no script text again');
});

test('memo: another agent\'s prompt is an input too (rule 4 counts them all)', () => {
  const mk = (...others) => mkRun([
    { id: 'a', start: 0, end: 10, result: T1 },
    { id: 'b', start: 20, end: 30, prompt: `quote: ${T1}` },
    ...others.map((p, i) => ({ id: `o${i}`, start: 5, end: 50, prompt: p })),
  ]);
  const memo = {};
  assert.equal(inferEdges(mk(`x ${T1}`), { memo }).length, 1);
  assert.equal(inferEdges(mk(`x ${T1}`, `y ${T1}`), { memo }).length, 0);
});

test('memo: the notes of a limited inference are reported again every time the memo answers', () => {
  const big = filler(5, 400);
  const mk = () => mkRun([
    { id: 'a', label: 'writer', start: 0, end: 10, result: `${big} ${MARK}` },
    { id: 'b', label: 'reader', start: 20, end: 30, prompt: `${big} ${MARK}` },
  ]);
  const memo = {};
  const limits = { maxTextChars: 1000 };
  const w1 = [];
  const first = inferEdges(mk(), { memo, limits, warn: (m) => w1.push(m) });
  const stored = memo.edges;
  const w2 = [];
  const second = inferEdges(mk(), { memo, limits, warn: (m) => w2.push(m) });
  assert.equal(memo.edges, stored, 'answered from the memo');
  assert.deepEqual(second, first);
  assert.ok(w1.length > 0);
  assert.deepEqual(w2, w1);
  const w3 = [];
  inferEdges(mk(), { memo, limits: { maxTextChars: 2000 }, warn: (m) => w3.push(m) });
  assert.notEqual(memo.edges, stored, 'other limits: recomputed');
});

// ---- time-order
const pair = (aEnd, bStart, { aPhase = 'P1', bPhase = 'P2', aMethod, bMethod, bPrompt, aResult } = {}) =>
  mkRun([
    { id: 'a', phase: aPhase ?? undefined, start: 0, end: aEnd, endMethod: aMethod, result: aResult },
    { id: 'b', phase: bPhase ?? undefined, start: bStart, end: bStart + 50, startMethod: bMethod, prompt: bPrompt },
  ]);

test('time-order: gap of exactly 1500 ms is a weak edge, 1501 is not', () => {
  const edges = inferEdges(pair(1000, 2500));
  assert.deepEqual(edges.map((e) => [e.from, e.to, e.kind, e.strength, e.prov]), [['a', 'b', 'time-order', 'weak', 'inferred']]);
  assert.match(edges[0].evidence, /started 1500 ms after .* ended, in a later phase \(P1 -> P2\)/);
  assert.deepEqual(inferEdges(pair(1000, 2501)), []);
});

test('time-order: B must start after A ended (gap >= 0) and in a strictly later phase', () => {
  assert.equal(weak(inferEdges(pair(1000, 1000))).length, 1, 'gap 0');
  assert.equal(weak(inferEdges(pair(1000, 900))).length, 0, 'B started before A ended');
  assert.equal(weak(inferEdges(pair(1000, 1100, { bPhase: 'P1' }))).length, 0, 'same phase');
  assert.equal(weak(inferEdges(pair(1000, 1100, { aPhase: 'P2', bPhase: 'P1' }))).length, 0, 'earlier phase');
});

test('time-order: unknown phase on either side, unknown end, or a phase the run does not list gives nothing', () => {
  assert.equal(weak(inferEdges(pair(1000, 1100, { aPhase: null }))).length, 0);
  assert.equal(weak(inferEdges(pair(1000, 1100, { bPhase: null }))).length, 0);
  assert.equal(weak(inferEdges(pair(undefined, 1100))).length, 0);
  assert.equal(weak(inferEdges(pair(1000, 1100, { bPhase: 'Elsewhere' }))).length, 0);
});

test('time-order: not drawn into B when a data-flow edge already goes into B', () => {
  const edges = inferEdges(pair(1000, 1100, { aResult: R64, bPrompt: `uses ${R64}` }));
  assert.deepEqual(edges.map((e) => e.kind), ['data-flow']);
});

test('time-order: data-flow into B hides weak edges from every agent, not only from the data source', () => {
  const run = mkRun([
    { id: 'src', phase: 'P1', start: 0, end: 500, result: R64 },
    { id: 'other', phase: 'P1', start: 0, end: 1000 },
    { id: 'b', phase: 'P2', start: 1100, end: 1200, prompt: `uses ${R64}` },
  ]);
  assert.deepEqual(inferEdges(run).map((e) => [e.from, e.kind]), [['src', 'data-flow']]);
});

test('time-order: several parallel agents that just ended all get a weak edge; slower ones do not', () => {
  const run = mkRun([
    { id: 'a1', phase: 'P1', start: 0, end: 1000 },
    { id: 'a2', phase: 'P1', start: 0, end: 1400 },
    { id: 'a3', phase: 'P1', start: 0, end: 100 },
    { id: 'b', phase: 'P2', start: 2000, end: 2100 },
  ]);
  assert.deepEqual(inferEdges(run).map((e) => e.from), ['a1', 'a2']);
});

test('time-order ignores journal file times (coarse), data-flow still uses them', () => {
  assert.equal(weak(inferEdges(pair(1000, 1100, { aMethod: 'journal-event-ts' }))).length, 0);
  assert.equal(weak(inferEdges(pair(1000, 1100, { bMethod: 'journal-event-ts' }))).length, 0);
  const df = inferEdges(pair(1000, 1100, { aMethod: 'journal-event-ts', bMethod: 'journal-event-ts', aResult: R64, bPrompt: R64 }));
  assert.deepEqual(df.map((e) => e.kind), ['data-flow']);
});

test('edges are ordered by target, data-flow before time-order, and every edge is inferred with evidence', () => {
  const run = mkRun([
    { id: 'a', phase: 'P1', start: 0, end: 100, result: R64 },
    { id: 'b', phase: 'P2', start: 200, end: 300, prompt: R64 },
    { id: 'c', phase: 'P3', start: 400, end: 500 },
  ], ['P1', 'P2', 'P3']);
  const edges = inferEdges(run);
  assert.deepEqual(edges.map((e) => `${e.from}>${e.to}:${e.kind}`), ['a>b:data-flow', 'a>c:time-order', 'b>c:time-order']);
  for (const e of edges) {
    assert.equal(e.prov, 'inferred');
    assert.ok(typeof e.evidence === 'string' && e.evidence.length > 10);
    assert.equal(e.strength, e.kind === 'data-flow' ? 'strong' : 'weak');
  }
});

test('empty or odd input gives no edges and does not throw', () => {
  assert.deepEqual(inferEdges(null), []);
  assert.deepEqual(inferEdges({}), []);
  assert.deepEqual(inferEdges({ order: ['ghost'], agents: {} }), []);
  assert.deepEqual(inferEdges(mkRun([])), []);
});

// ---- an independent, naive reference implementation of the contract rules, for comparison

const squash = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, '');
// The data-flow edges "a>b" the contract asks for, by brute force: every maximal common region of >= 64 chars of
// the prompt of b and the result of a, tested against rules 1 to 4 with plain substring searches.
function oracle(run, scriptText = null) {
  const ids = run.order;
  const has = (f) => f && f.prov !== 'unknown';
  const res = {}, pro = {};
  for (const id of ids) {
    const a = run.agents[id];
    res[id] = has(a.result) && a.result.value !== null && a.result.value !== undefined ? squash(a.result.value) : null;
    pro[id] = has(a.prompt) && typeof a.prompt.value === 'string' ? squash(a.prompt.value) : null;
  }
  const num = (f) => (has(f) && typeof f.value === 'number' ? f.value : null);
  const ended = (a, b) => num(run.agents[a].endedAt) !== null && num(run.agents[b].startedAt) !== null && num(run.agents[a].endedAt) < num(run.agents[b].startedAt);
  const script = scriptText === null ? null : squash(scriptText);
  const out = new Set();
  for (const b of ids) for (const a of ids) {
    if (a === b || !ended(a, b) || res[a] === null || pro[b] === null) continue;
    const x = res[a], y = pro[b];
    const regions = new Set();
    for (let i = 0; i + 64 <= y.length; i++) {
      const w = y.slice(i, i + 64);
      for (let j = x.indexOf(w); j !== -1; j = x.indexOf(w, j + 1)) {
        let back = 0, len = 64;
        while (i - back > 0 && j - back > 0 && y[i - back - 1] === x[j - back - 1]) back++;
        while (i + len < y.length && j + len < x.length && y[i + len] === x[j + len]) len++;
        regions.add(y.slice(i - back, i + len));
      }
    }
    for (const S of regions) {
      if (script !== null && script.includes(S)) continue;
      if (ids.some((c) => c !== a && c !== b && ended(c, b) && res[c] !== null && res[c].includes(S))) continue;
      if (ids.filter((k) => k !== b && pro[k] !== null && pro[k].includes(S)).length >= 2) continue;
      out.add(`${a}>${b}`);
      break;
    }
  }
  return out;
}
const dataFlow = (edges) => new Set(strong(edges).map((e) => `${e.from}>${e.to}`));
const sorted = (set) => [...set].sort();

// deterministic random numbers
function rng(seed) {
  let x = seed;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: on random runs of overlapping quotations the edges are exactly those of the naive reference', () => {
  let withEdges = 0;
  let totalEdges = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const pick = (n) => Math.floor(r() * n);
    const pool = Array.from({ length: 8 }, (_, i) => filler(seed * 31 + i, 12)); // about 80 chars each
    const piece = () => {
      const t = pool[pick(pool.length)];
      const k = pick(4);
      if (k === 0) return t; // the whole sentence
      if (k === 1) return t.slice(pick(8), t.length - pick(8)); // most of it
      if (k === 2) return t.slice(0, 40 + pick(40)); // a part, about the 64-char limit
      return `${t} ${pool[pick(pool.length)]}`; // two sentences
    };
    const text = () => Array.from({ length: 1 + pick(3) }, piece).join(pick(2) ? ' ' : ' - ');
    const specs = [];
    const n = 5 + pick(6);
    for (let i = 0; i < n; i++) {
      const start = pick(60) * 10;
      specs.push({
        id: `g${i}`, start, end: start + 5 + pick(120),
        prompt: pick(5) === 0 ? undefined : `Task ${i}. ${text()}${pick(2) ? ` ${text()}` : ''}`,
        result: pick(6) === 0 ? undefined : pick(3) === 0 ? { note: text(), n: i }
          : specs.length && pick(5) === 0 ? specs[pick(specs.length)].result // the same result as an earlier agent
            : text(),
      });
    }
    const scriptText = pick(2) ? `const GUIDE = ${JSON.stringify(pool[pick(pool.length)])};` : null;
    const run = mkRun(specs);
    const got = sorted(dataFlow(inferEdges(run, { scriptText })));
    const want = sorted(oracle(run, scriptText));
    assert.deepEqual(got, want, `seed ${seed}`);
    if (want.length) withEdges++;
    totalEdges += want.length;
  }
  assert.ok(withEdges >= 40 && totalEdges >= 60, `the random runs must exercise the rules: ${withEdges} runs with edges, ${totalEdges} edges`);
});

// ---- on reduced runs (hand-built events mirroring the real journals)

function checkAgainstReference(run, scriptText = null) {
  assert.deepEqual(sorted(dataFlow(run.edges)), sorted(oracle(run, scriptText)));
  for (const e of strong(run.edges)) assert.ok(run.agents[e.from].endedAt.value < run.agents[e.to].startedAt.value, 'source must end before the target starts');
  for (const e of run.edges) assert.ok(e.evidence && run.agents[e.from] && run.agents[e.to], 'no edge without evidence and known endpoints');
}

test('probe 1: the reviewers\' results are shorter than 64 chars, so no data-flow edge; a weak hint into the judge only while live', () => {
  const p = probe1();
  const live = reduceRun(p.live, { now: () => 1794126730000 });
  const done = reduceRun(p.withFinal, { now: () => 1794126730000 });
  for (const run of [live, done]) {
    assert.deepEqual(strong(run.edges), [], '{"verdict":"pass","note":"A saw x=1"} has 37 non-space chars');
    checkAgainstReference(run, 'export const meta = {}');
  }
  // live times are transcript records: B ended 1361 ms before the judge started, in the previous phase; A 2715 ms
  assert.deepEqual(live.edges.map((e) => [e.from, e.to, e.kind, e.strength]), [[p.ids.B, p.ids.J, 'time-order', 'weak']]);
  // the final file's times are coarser (start + duration): 2622 ms, too long for a hint
  assert.deepEqual(done.edges, []);
});

test('probe 2: short stage results leave no data-flow edge; one weak hint into the Errors phase', () => {
  const p = probe2();
  for (const events of [p.live, p.withFinal]) {
    const run = reduceRun(events, { now: () => 1794127740000 });
    assert.deepEqual(strong(run.edges), [], '"gamma fast done" etc. are shorter than 64 chars');
    assert.deepEqual(run.edges.map((e) => [e.from, e.to, e.kind]), [[p.ids.a2, p.ids.ok, 'time-order']]);
    checkAgainstReference(run, 'export const meta = {}');
  }
});

test('legacy: both findings feed the synthesis even while labels and phases are unknown', () => {
  const p = legacy();
  const live = reduceRun(p.live, { now: () => 1783754110000 });
  assert.deepEqual(live.edges.map((e) => [e.from, e.to, e.kind]), [[p.ids.a1, p.ids.a3, 'data-flow'], [p.ids.a2, p.ids.a3, 'data-flow']]);
  assert.ok(live.edges[0].evidence.includes(p.ids.a3), 'unknown labels: the agent id names the agent');
  checkAgainstReference(live, 'export const meta = {}');
  const done = reduceRun(p.withFinal, { now: () => 1783754110000 });
  assert.deepEqual(done.edges.map((e) => [e.from, e.to, e.kind]), [[p.ids.a1, p.ids.a3, 'data-flow'], [p.ids.a2, p.ids.a3, 'data-flow']]);
  assert.equal(weak(done.edges).length, 0, 'a2 ended 1000 ms before a3 started, but data-flow already explains a3');
  checkAgainstReference(done, 'export const meta = {}');
});

// ---- the same rules on reduced runs built from journal and transcript events

const edgeList = (run) => run.edges.map((e) => [e.from, e.to, e.kind, e.strength]);

test('reduced run: a second agent with the same result that ends after B started does not hide the one that fed B', () => {
  const { b } = probe1();
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'rev:A', 'P1'),
    b.started(3, 1000, 'C', 'rev:C', 'P1'),
    b.result(4, 1500, 'A', T1),
    b.started(5, 2000, 'B', 'judge', 'P2'),
    b.prompt('B', `Reviewer said: ${T1}`, 2000),
    b.result(6, 3000, 'C', T1),
    b.result(7, 3100, 'B', 'ok, noted'),
  ], { now: () => 4000 });
  assert.deepEqual(edgeList(run), [['A', 'B', 'data-flow', 'strong']], 'no edge from C, no weak hint into B');
  assert.equal(run.edges[0].evidence, `prompt of "judge" repeats ${norm(T1).length} non-space chars of the result of "rev:A": ${T1.slice(0, 80)}...`);
});

test('reduced run: two identical reviewers feed nobody, the judge quotes both; one different reviewer still does', () => {
  const { b } = probe1();
  const same = { verdict: 'pass', findings: [], summary: T1 };
  const other = { verdict: 'fail', findings: [], summary: T2 };
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'reviewer:A', 'Fanout'),
    b.started(3, 1000, 'B', 'reviewer:B', 'Fanout'),
    b.started(4, 1000, 'C', 'reviewer:C', 'Fanout'),
    b.result(5, 1500, 'A', same),
    b.result(6, 1600, 'B', same),
    b.result(7, 1700, 'C', other),
    b.started(8, 2000, 'J', 'judge', 'Judge'),
    b.prompt('J', `Reviews:\nA: ${JSON.stringify(same)}\nB: ${JSON.stringify(same)}\nC: ${JSON.stringify(other)}`, 2000),
    b.result(9, 2500, 'J', { verdict: 'pass' }),
  ], { now: () => 4000 });
  assert.deepEqual(edgeList(run), [['C', 'J', 'data-flow', 'strong']]);
  checkAgainstReference(run);
});

test('reduced run: the script text of the run is part of rule 4', () => {
  const { b, e } = probe1();
  const script = (text) => ({ ...e.script, data: { ...e.script.data, text } });
  const events = (text) => [
    script(text),
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'rev:A', 'P1'),
    b.result(3, 1500, 'A', T1),
    b.started(4, 2000, 'B', 'judge', 'P2'),
    b.prompt('B', `Reviewer said: ${T1}`, 2000),
    b.result(5, 3100, 'B', 'ok, noted'),
  ];
  assert.deepEqual(edgeList(reduceRun(events('export const meta = {}'), { now: () => 4000 })), [['A', 'B', 'data-flow', 'strong']]);
  const inScript = reduceRun(events(`const guide = ${JSON.stringify(T1)};`), { now: () => 4000 });
  assert.deepEqual(strong(inScript.edges), [], 'the quoted text is in the script');
  assert.equal(inScript.warnings.some((w) => /script text was not read/.test(w)), false);
});

test('reduced run: the script text of rule 4 is the final file\'s `script` (the text that ran), the script read from disk only without it', () => {
  const { b, e } = probe1();
  const onDisk = (text) => ({ ...e.script, data: { ...e.script.data, text } });
  const journal = [
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'rev:A', 'P1'),
    b.result(3, 1500, 'A', T1),
    b.started(4, 2000, 'B', 'judge', 'P2'),
    b.prompt('B', `Reviewer said: ${T1}`, 2000),
    b.result(5, 3100, 'B', 'ok, noted'),
  ];
  const final = (script) => b.final({ status: 'completed', workflowProgress: [], ...(script === undefined ? {} : { script }) }, 4000);
  const ran = `const GUIDE = ${JSON.stringify(T1)};`; // the text that ran holds the quoted sentence
  const other = 'export const meta = { name: "edited later" };';
  const scriptNotRead = (run) => run.warnings.some((w) => /script text was not read/.test(w));
  const run = (events) => reduceRun(events, { now: () => 5000 });

  // the finding's input: no script file event, the text is only in the final file
  const finalOnly = run([...journal, final(ran)]);
  assert.deepEqual(strong(finalOnly.edges), [], 'the quoted text is in the script that ran: boilerplate, not data flow');
  assert.equal(scriptNotRead(finalOnly), false, 'the script text was read, from the final file');
  // the same run without any script text: the edge stands and the warning says it was not checked
  const none = run([...journal, final()]);
  assert.deepEqual(edgeList(none), [['A', 'B', 'data-flow', 'strong']]);
  assert.equal(scriptNotRead(none), true);

  // the script file on disk was edited after the run and no longer holds the text: the final file decides
  const edited = run([onDisk(other), ...journal, final(ran)]);
  assert.deepEqual(strong(edited.edges), []);
  // ... and the other way round: the disk copy holds the sentence only after an edit, the script that ran did not
  const addedLater = run([onDisk(ran), ...journal, final(other)]);
  assert.deepEqual(edgeList(addedLater), [['A', 'B', 'data-flow', 'strong']], 'the run\'s own script did not hold the text');
  assert.equal(scriptNotRead(addedLater), false);
  // while the run is live there is no final file: the script read from disk is the text
  const live = run([onDisk(ran), ...journal]);
  assert.deepEqual(strong(live.edges), []);
  // a final file without a script text (or with an empty one) falls back to the script file
  assert.deepEqual(strong(run([onDisk(ran), ...journal, final()]).edges), []);
  assert.deepEqual(strong(run([onDisk(ran), ...journal, final('')]).edges), []);
});

test('reduced run: without a script text the edges are reported as not checked against it', () => {
  const { b } = probe1();
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'rev:A', 'P1'),
    b.result(3, 1500, 'A', T1),
    b.started(4, 2000, 'B', 'judge', 'P2'),
    b.prompt('B', `Reviewer said: ${T1}`, 2000),
    b.result(5, 3100, 'B', 'ok, noted'),
  ], { now: () => 4000 });
  assert.deepEqual(edgeList(run), [['A', 'B', 'data-flow', 'strong']]);
  assert.ok(run.warnings.some((w) => /^edge inference: the script text was not read, so the data-flow edges were not checked against it/.test(w)));
  const none = reduceRun([b.launched(1, 100), b.started(2, 1000, 'A', 'rev:A', 'P1')], { now: () => 4000 });
  assert.equal(none.warnings.some((w) => /script text was not read/.test(w)), false, 'no edges: nothing to say');
});

test('reduced run: an agent that passes its input through feeds the next one (no weak hint instead)', () => {
  const { b } = probe1();
  const given = 'The relayed request says: refactor the parser and keep the public API stable.';
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'F', 'fmt:A', 'P1'),
    b.prompt('F', `Task. ${given}`, 1000),
    b.activity('F', { text: `You asked: ${given}` }, 2000, 2),
    b.result(3, 2100, 'F', `You asked: ${given}`),
    b.started(4, 2400, 'S', 'sum:B', 'P2'),
    b.prompt('S', `Context. You asked: ${given}`, 2400),
    b.activity('S', { text: 'done' }, 3000, 2),
    b.result(5, 3100, 'S', 'done'),
  ], { now: () => 4000 });
  assert.deepEqual(run.agents.F.endedAt, { value: 2000, prov: 'inferred', method: 'last-transcript-record' });
  assert.deepEqual(edgeList(run), [['F', 'S', 'data-flow', 'strong']], 'a weak hint would be there too (400 ms, later phase), but data-flow explains S');
});

test('reduced run: A ends exactly when B starts: no edge, whatever run.order says', () => {
  const { b } = probe1();
  const run = reduceRun([
    b.launched(1, 100),
    b.started(2, 1000, 'A', 'rev:A'),
    b.result(3, 2000, 'A', T1),
    b.started(4, 2000, 'B', 'judge'),
    b.prompt('B', `Reviewer said: ${T1}`, 2000),
    b.result(5, 2500, 'B', 'ok'),
  ], { now: () => 4000 });
  assert.deepEqual(run.order, ['A', 'B']);
  assert.deepEqual([run.agents.A.endedAt.value, run.agents.B.startedAt.value], [2000, 2000]);
  assert.deepEqual(run.edges, []);
});
