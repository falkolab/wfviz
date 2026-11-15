// test/server/search.test.mjs (node run-search): GET /api/search and the pure functions behind it in src/server/server.mjs (foldText, findFolded,
// excerptOf, searchRuns). Contract section 4: over the loaded runs' models only; one result per field, around its first match; case-insensitive
// by Unicode case folding; limit and a 500 ms budget, over either `more: true`; read-only. The words in the test data are neutral on purpose
// (alpha, probe, needle): the code asserts nothing about them.

import assert from 'node:assert/strict';

import {
  SEARCH_BUDGET_MS, SEARCH_DEFAULT_LIMIT, SEARCH_EXCERPT_CHARS, SEARCH_MAX_LIMIT, createServer, excerptOf, findFolded, foldText, searchRuns,
} from '../../src/server/server.mjs';
import { closeServer, createFakeStore, getJson, listenOnFreePort, makeAgent, makeRun, request, test } from './helpers.mjs';

const reg = (value) => ({ value, prov: 'registered', from: 'test:1' });
const fin = (value) => ({ value, prov: 'final', from: 'wf.json' });
const inf = (value) => ({ value, prov: 'inferred', method: 'test-rule' });
const unk = (reason = 'the source has none') => ({ value: null, prov: 'unknown', reason });

// An agent as the model gives it: label, prompt, result and the activity, each a Fact unless the test says otherwise.
function agentOf(id, { prompt = unk('no prompt'), result = unk('no result'), activity = [], label } = {}) {
  return { ...makeAgent(id, activity), ...(label === undefined ? {} : { label }), prompt, result };
}
function runOf(id, { agents = [], ...over } = {}) {
  return makeRun(id, { agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), ...over });
}

// what a test reads back: the text the offsets cut out of the excerpt
const cut = (r) => r.excerpt.slice(r.start, r.end);
// the first match of a query in a text, with the matched ORIGINAL text
function hit(text, query) {
  const m = findFolded(text, foldText(query).text);
  return m === null ? null : { ...m, text: text.slice(m.start, m.end) };
}

// =====================================================================================================================
// folding and matching (pure)
// =====================================================================================================================

test('foldText: ASCII is lower-cased in place; a text whose characters keep their length has no map; one whose characters change length has one', () => {
  const a = foldText('Hello WORLD 42');
  assert.deepEqual(a, { text: 'hello world 42', from: null, head: null });
  assert.equal(foldText(null).text, '');
  assert.equal(foldText(undefined).text, '');
  assert.equal(foldText(12).text, '12', 'a number is its text');
  const same = foldText('\u00c9COLE');
  assert.equal(same.text, '\u00e9cole');
  assert.equal(same.from, null);
  const sharp = foldText('\u00dfa');
  assert.equal(sharp.text, 'ssa', 'the sharp s is "ss"');
  assert.deepEqual([...sharp.from], [0, 0, 1], 'each folded unit knows its original character');
  assert.deepEqual([...sharp.head], [1, 0, 1], 'and whether it is the first unit of that character');
});

test('folding: sigma and final sigma are the same letter, whichever way round and wherever in the word', () => {
  assert.equal(foldText('\u039f\u0394\u039f\u03a3').text, foldText('\u03bf\u03b4\u03bf\u03c2').text, 'a capital at the end of a word and a final sigma');
  assert.equal(foldText('\u03bf\u03b4\u03bf\u03c2').text, foldText('\u03bf\u03b4\u03bf\u03c3').text, 'final sigma and sigma');
  assert.equal(hit('\u039f\u0394\u039f\u03a3 \u039a\u0391\u0399', '\u03bf\u03b4\u03bf\u03c2').text, '\u039f\u0394\u039f\u03a3');
  assert.equal(hit('\u03bf\u03b4\u03bf\u03c2', '\u039f\u0394\u039f\u03a3').text, '\u03bf\u03b4\u03bf\u03c2');
  assert.equal(hit('\u03bf\u03b4\u03bf\u03c2', '\u03bf\u03b4\u03bf\u03c3').text, '\u03bf\u03b4\u03bf\u03c2', 'a final sigma is found by a sigma');
  assert.equal(hit('\u03a3\u0391\u03a3', '\u03c3\u03b1\u03c2').text, '\u03a3\u0391\u03a3', 'a sigma in the middle and one at the end');
  assert.equal(hit('xx\u03a3', '\u03c3').text, '\u03a3', 'a lone capital sigma after other letters');
});

test('folding: the sharp s is "ss" in both directions, and a match starts and ends on a whole character of the text', () => {
  assert.deepEqual(hit('Stra\u00dfe', 'STRASSE'), { start: 0, end: 6, text: 'Stra\u00dfe' });
  assert.deepEqual(hit('STRASSE', 'stra\u00dfe'), { start: 0, end: 7, text: 'STRASSE' });
  assert.deepEqual(hit('Stra\u00dfe', 'ss'), { start: 4, end: 5, text: '\u00df' }, 'ss finds the whole sharp s');
  assert.deepEqual(hit('Ma\u00dfe', 'sse'), { start: 2, end: 4, text: '\u00dfe' });
  assert.deepEqual(hit('Ma\u00dfe', 'Ma\u00df'), { start: 0, end: 3, text: 'Ma\u00df' });
  // one s of the sharp s is half a character: no match inside it, at either end
  assert.equal(hit('Ma\u00dfe', 's'), null, 'a query of one s misses inside the sharp s');
  assert.equal(hit('Ma\u00dfe', 'mas'), null, 'a match that would end between its two s');
  // the first whole match: the s of the sharp s is skipped for the real one after it
  assert.deepEqual(hit('\u00dfs', 's'), { start: 1, end: 2, text: 's' });
  assert.deepEqual(hit('Stra\u00dfe', 's'), { start: 0, end: 1, text: 'S' });
  // the capital sharp s (U+1E9E) lowers to the sharp s, which is "ss": it is the same letter as both
  assert.deepEqual(hit('GRO\u1e9eE', 'gro\u00dfe'), { start: 0, end: 5, text: 'GRO\u1e9eE' });
  assert.deepEqual(hit('GRO\u1e9eE', 'grosse'), { start: 0, end: 5, text: 'GRO\u1e9eE' });
  assert.deepEqual(hit('Gro\u00dfe', 'GRO\u1e9eE'), { start: 0, end: 5, text: 'Gro\u00dfe' });
  assert.equal(hit('GRO\u1e9eE', 's'), null);
});

test('folding: ligatures and the long s fold to their letters and match as one character; U+0130 is "i" and a combining dot', () => {
  assert.deepEqual(hit('\ufb01sh', 'fish'), { start: 0, end: 3, text: '\ufb01sh' });
  assert.equal(hit('\ufb01sh', 'f'), null, 'half of a ligature is not a match');
  assert.equal(hit('\u017fs', 'ss').text, '\u017fs', 'the long s is s');
  // U+0130: the query "i" misses it (its fold is i plus U+0307: the dot would be cut off), "i" plus the dot finds it, and so does itself
  assert.equal(hit('\u0130stanbul', 'i'), null);
  assert.deepEqual(hit('\u0130stanbul', 'i\u0307s'), { start: 0, end: 2, text: '\u0130s' });
  assert.deepEqual(hit('\u0130stanbul', '\u0130'), { start: 0, end: 1, text: '\u0130' });
  assert.deepEqual(hit('\u0130stanbul', 'stanbul'), { start: 1, end: 8, text: 'stanbul' });
  assert.equal(hit('istanbul', '\u0130'), null, 'no locale rules: the capital dotted i is not the plain i');
  // known limit (contract section 4): the dotless i folds to i
  assert.deepEqual(hit('ISI', '\u0131s\u0131'), { start: 0, end: 3, text: 'ISI' });
  assert.deepEqual(hit('\u0131s\u0131', 'ISI'), { start: 0, end: 3, text: '\u0131s\u0131' });
});

test('folding: no normalisation (a precomposed and a decomposed e-acute differ: a known limit), and a query longer than the text finds nothing', () => {
  assert.equal(hit('caf\u00e9', 'cafe\u0301'), null);
  assert.equal(hit('cafe\u0301', 'caf\u00e9'), null);
  assert.equal(hit('caf\u00e9', 'CAF\u00c9').text, 'caf\u00e9');
  assert.equal(hit('ab', 'abc'), null);
  assert.equal(findFolded('abc', ''), null, 'an empty query is no match');
  assert.equal(findFolded(null, 'a'), null);
  assert.equal(findFolded('abc', null), null);
});

test('a match never starts or ends inside a surrogate pair, in the plain and in the mapped path', () => {
  assert.deepEqual(hit('a\u{1f600}b', '\u{1f600}'), { start: 1, end: 3, text: '\u{1f600}' });
  assert.deepEqual(hit('a\u{1f600}b', 'b'), { start: 3, end: 4, text: 'b' });
  assert.equal(hit('a\u{1f600}b', '\ud83d'), null, 'the high half alone');
  assert.equal(hit('a\u{1f600}b', '\ude00'), null, 'the low half alone');
  assert.equal(hit('a\u{1f600}b', '\ude00b'), null, 'a query that starts with the low half');
  assert.equal(hit('a\u{1f600}b', 'a\ud83d'), null, 'a query that ends with the high half');
  // the same with a sharp s in the text, which puts it on the mapped path
  assert.deepEqual(hit('\u00df\u{1f600}b', '\u{1f600}'), { start: 1, end: 3, text: '\u{1f600}' });
  assert.equal(hit('\u00df\u{1f600}b', '\ud83d'), null);
  assert.equal(hit('\u00df\u{1f600}b', '\ude00'), null);
  // a half that is alone in the text is a character like any other
  assert.deepEqual(hit('x\ude00y', 'y'), { start: 2, end: 3, text: 'y' });
  assert.deepEqual(hit('x\ud83dy', '\ud83d'), { start: 1, end: 2, text: '\ud83d' });
});

// =====================================================================================================================
// the excerpt (pure)
// =====================================================================================================================

test('excerpt: about 120 characters around the match, the whole text when it is short, the window moved at either end, no ellipsis', () => {
  assert.equal(SEARCH_EXCERPT_CHARS, 120);
  const mid = `${'a'.repeat(150)}NEEDLE${'b'.repeat(144)}`; // 300 characters
  const e = excerptOf(mid, 150, 156);
  assert.equal(e.excerpt.length, 120);
  assert.equal(e.excerpt.slice(e.start, e.end), 'NEEDLE');
  assert.equal(e.start, 57, 'half of the rest before the match');
  assert.equal(mid.includes(e.excerpt), true, 'the original text, cut: nothing added');
  assert.doesNotMatch(e.excerpt, /\.\.\.|\u2026/);
  // short text: all of it
  const short = excerptOf('a needle here', 2, 8);
  assert.deepEqual(short, { excerpt: 'a needle here', start: 2, end: 8 });
  // near the start the window moves right, near the end left: still 120 characters
  const text = `xxxNEEDLE${'y'.repeat(291)}`;
  const head = excerptOf(text, 3, 9);
  assert.equal(head.excerpt, text.slice(0, 120));
  assert.deepEqual([head.start, head.end], [3, 9]);
  const tail = `${'y'.repeat(291)}NEEDLExxx`;
  const last = excerptOf(tail, 291, 297);
  assert.equal(last.excerpt, tail.slice(-120));
  assert.equal(cut(last), 'NEEDLE');
  assert.equal(last.excerpt.length, 120);
  // a match at the very start and the very end of the text
  assert.deepEqual([excerptOf(text, 0, 3).start, excerptOf(text, 0, 3).end, excerptOf(text, 0, 3).excerpt.length], [0, 3, 120]);
  const atEnd = excerptOf(tail, 297, 300);
  assert.deepEqual([atEnd.start, atEnd.end, atEnd.excerpt.length], [117, 120, 120]);
});

test('excerpt: a match longer than the window is kept whole (the excerpt grows), and start and end slice it', () => {
  const long = 'q'.repeat(300);
  const text = `before ${long} after`;
  const e = excerptOf(text, 7, 307);
  assert.equal(e.excerpt, long);
  assert.deepEqual([e.start, e.end], [0, 300]);
  const exactly = excerptOf('z'.repeat(121), 0, 121);
  assert.deepEqual(exactly, { excerpt: 'z'.repeat(121), start: 0, end: 121 });
});

test('excerpt: never cut inside a surrogate pair, at either edge of the window, and start/end always read back the matched original text', () => {
  const emoji = '\u{1f600}';
  // the window starts at 93 and ends at 213 for a match at 150..156: a pair with its low half at 93, and one with its high half at 212
  const base = `${'a'.repeat(150)}NEEDLE${'b'.repeat(144)}`;
  const left = `${base.slice(0, 92)}${emoji}${base.slice(94)}`;
  const l = excerptOf(left, 150, 156);
  assert.equal(l.excerpt.isWellFormed(), true, 'no lone low half at the start');
  assert.equal(cut(l), 'NEEDLE');
  assert.equal(l.excerpt.charCodeAt(0) >= 0xdc00 && l.excerpt.charCodeAt(0) <= 0xdfff, false);
  const right = `${base.slice(0, 212)}${emoji}${base.slice(214)}`;
  const r = excerptOf(right, 150, 156);
  assert.equal(r.excerpt.isWellFormed(), true, 'no lone high half at the end');
  assert.equal(cut(r), 'NEEDLE');
  // for every position of the match in a text full of pairs
  const pairs = Array.from({ length: 200 }, (_, i) => (i % 7 === 3 ? emoji : 'k')).join('');
  for (let at = 0; at < pairs.length - 3; at++) {
    if (pairs.charCodeAt(at) >= 0xdc00 && pairs.charCodeAt(at) <= 0xdfff) continue; // inside a pair: the matcher never gives such a start
    let end = at + 3;
    if (pairs.charCodeAt(end) >= 0xdc00 && pairs.charCodeAt(end) <= 0xdfff) end += 1;
    const e = excerptOf(pairs, at, end);
    assert.equal(e.excerpt.isWellFormed(), true, `well formed at ${at}`);
    assert.ok(pairs.includes(e.excerpt), `the excerpt is a piece of the text at ${at}`);
    assert.equal(cut(e), pairs.slice(at, end), `the match reads back at ${at}`);
    assert.ok(e.excerpt.length >= SEARCH_EXCERPT_CHARS - 2 && e.excerpt.length <= SEARCH_EXCERPT_CHARS, `about 120 at ${at}: ${e.excerpt.length}`);
    assert.ok(0 <= e.start && e.start <= e.end && e.end <= e.excerpt.length);
  }
});

// =====================================================================================================================
// the scan (pure): fields, Facts, order, limit, budget
// =====================================================================================================================

// the runs of a scan, keyed by id; getRun and runIds as the handler gives them
function scan(runs, opts = {}) {
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
  return searchRuns({ runIds: () => runs.map((r) => r.id), getRun: (id) => byId[id] ?? null, ...opts });
}

function fullRun(id = 'wf_one') {
  return runOf(id, {
    name: reg('Alpha survey'),
    description: reg('a probe of alpha things'),
    logs: fin(['start', 'an alpha log line', 'done']),
    agents: [agentOf('a1', {
      label: reg('reader'),
      prompt: reg('Read the Alpha file, alpha again'),
      result: reg('found alpha twice'),
      activity: [{ ts: 1, tool: 'Bash', inputSummary: 'grep alpha file', text: 'checking alpha' }],
    })],
  });
}

test('the fields searched, in order: name, description, log lines, then per agent prompt, result and each activity entry; agentId only on an agent field', () => {
  const { results, more } = scan([fullRun()], { query: 'ALPHA' });
  assert.equal(more, false);
  assert.deepEqual(results.map((r) => [r.runId, r.agentId, r.field]), [
    ['wf_one', undefined, 'name'], ['wf_one', undefined, 'description'], ['wf_one', undefined, 'log'],
    ['wf_one', 'a1', 'prompt'], ['wf_one', 'a1', 'result'], ['wf_one', 'a1', 'activity-summary'], ['wf_one', 'a1', 'activity-text'],
  ]);
  for (const r of results) assert.equal('agentId' in r, r.field !== 'name' && r.field !== 'description' && r.field !== 'log', `agentId is left out, not null: ${r.field}`);
  // each excerpt slices to the text as the run wrote it (case kept)
  assert.deepEqual(results.map(cut), ['Alpha', 'alpha', 'alpha', 'Alpha', 'alpha', 'alpha', 'alpha']);
  assert.equal(results[2].excerpt, 'an alpha log line', 'a log line is one field');
  assert.deepEqual(Object.keys(results[3]).sort(), ['agentId', 'end', 'excerpt', 'field', 'runId', 'start']);
  assert.deepEqual(Object.keys(results[0]).sort(), ['end', 'excerpt', 'field', 'runId', 'start']);
});

test('one result per field, around its first match: a text with 500 hits is one result and cannot use up the limit', () => {
  const many = runOf('wf_m', { agents: [agentOf('a1', { prompt: reg(`${'alpha '.repeat(500)}`), result: reg('x alpha y') })] });
  const { results, more } = scan([many], { query: 'alpha', limit: 2 });
  assert.deepEqual(results.map((r) => r.field), ['prompt', 'result']);
  assert.equal(more, false, 'two results, limit 2, nothing beyond: not more');
  const first = results[0];
  assert.equal(first.start, 0, 'the first hit of the prompt');
  assert.equal(cut(first), 'alpha');
  // two log lines with the query are two results (each line is a field); the second hit in one line is not
  const lines = runOf('wf_l', { logs: fin(['alpha one alpha', 'none', 'alpha two']) });
  assert.deepEqual(scan([lines], { query: 'alpha' }).results.map((r) => r.excerpt), ['alpha one alpha', 'alpha two']);
});

test('an activity entry gives up to two fields (tool input summary and text); its tool name gives none', () => {
  const act = [{ ts: 1, inputSummary: 'alpha in the input' }, { ts: 2, text: 'alpha in the text' }, { ts: 3, inputSummary: 'alpha a', text: 'alpha b' }, { ts: 4, tool: 'alpha-tool' }];
  const { results } = scan([runOf('wf_a', { agents: [agentOf('a1', { activity: act })] })], { query: 'alpha' });
  assert.deepEqual(results.map((r) => [r.field, r.excerpt]), [
    ['activity-summary', 'alpha in the input'], ['activity-text', 'alpha in the text'],
    ['activity-summary', 'alpha a'], ['activity-text', 'alpha b'],
  ], 'a tool name is not searched');
});

test('unknown Facts are never searched, nor is a Fact\'s reason or method: the word "unknown" matches nothing', () => {
  const r = runOf('wf_u', {
    name: unk('unknown: no script meta for this run'),
    description: { value: 'alpha text under an unknown fact', prov: 'unknown', reason: 'alpha reason' }, // not a shape the model gives; the provenance rules
    logs: unk('unknown while running: no final file'),
    agents: [agentOf('a1', {
      prompt: unk('unknown prompt: the transcript has none'),
      result: { value: 'alpha', prov: 'inferred', method: 'alpha-rule' },
      activity: [{ ts: 1 }],
    })],
  });
  for (const q of ['unknown', 'reason', 'no script meta', 'the transcript']) assert.deepEqual(scan([r], { query: q }), { results: [], more: false }, q);
  assert.deepEqual(scan([r], { query: 'alpha text' }), { results: [], more: false }, 'a value under an unknown provenance is not used');
  assert.deepEqual(scan([r], { query: 'alpha-rule' }), { results: [], more: false }, 'the method of an inferred Fact is not text of the run');
  const inferred = scan([r], { query: 'alpha' });
  assert.deepEqual(inferred.results.map((x) => [x.field, x.excerpt]), [['result', 'alpha']], 'an inferred value is the run\'s value and is searched');
  // null and undefined values are no text
  // the provenance rules for the log lines too: an unknown Fact is no text, whatever it holds
  const unknownLog = runOf('wf_ul', { logs: { value: ['alpha in an unknown log'], prov: 'unknown', reason: 'no final file' } });
  assert.deepEqual(scan([unknownLog], { query: 'alpha' }), { results: [], more: false });
  const nulls = runOf('wf_n', { name: reg(null), description: undefined, logs: reg(null), agents: [agentOf('a1', { prompt: reg(null), result: undefined })] });
  assert.deepEqual(scan([nulls], { query: 'null' }), { results: [], more: false });
  assert.deepEqual(scan([nulls], { query: 'undefined' }), { results: [], more: false });
});

test('labels, ids, tool names, Run.result and edit inputs are not searched; a value that is not text is searched as the indented JSON the drawer shows', () => {
  const r = runOf('wf_zzzid', {
    name: reg('plain'),
    result: reg('zzzrunresult'),
    agents: [agentOf('zzzagentid', {
      label: reg('zzzlabel'),
      prompt: reg('p'),
      result: reg({ findings: [{ file: 'src/a.js', line: 3, severity: 'high' }], note: 'zzzin' }),
      activity: [{ ts: 1, tool: 'zzztool', input: { file_path: 'zzzedit' }, inputSummary: 'ok' }],
    })],
  });
  for (const q of ['zzzid', 'zzzagentid', 'zzzlabel', 'zzztool', 'zzzrunresult', 'zzzedit']) assert.deepEqual(scan([r], { query: q }), { results: [], more: false }, q);
  const j = scan([r], { query: 'src/a.js' }).results;
  assert.equal(j.length, 1);
  assert.equal(j[0].field, 'result');
  assert.equal(j[0].agentId, 'zzzagentid');
  const shown = JSON.stringify({ findings: [{ file: 'src/a.js', line: 3, severity: 'high' }], note: 'zzzin' }, null, 2);
  assert.ok(shown.includes(j[0].excerpt), 'the excerpt is a piece of the indented JSON');
  assert.equal(cut(j[0]), 'src/a.js');
  // a number, a boolean and an array are text too; an object that cannot be written (a cycle) is nothing and never a throw
  const cyc = {};
  cyc.self = cyc;
  const odd = runOf('wf_odd', { agents: [agentOf('a1', { prompt: reg(4242), result: reg(cyc) }), agentOf('a2', { prompt: reg(true), result: reg(['xx', 'yy']) })] });
  assert.deepEqual(scan([odd], { query: '4242' }).results.map((x) => x.field), ['prompt']);
  assert.deepEqual(scan([odd], { query: 'true' }).results.map((x) => [x.agentId, x.field]), [['a2', 'prompt']]);
  assert.deepEqual(scan([odd], { query: 'yy' }).results.map((x) => x.excerpt), ['[\n  "xx",\n  "yy"\n]']);
});

test('an agent id is a key like any other: "__proto__" is searched, and a Run with no agents, no logs or odd shapes is skipped without a throw', () => {
  const agents = JSON.parse('{"__proto__": {"prompt": {"value": "alpha in proto", "prov": "registered", "from": "x"}}, "plain": null, "text": "alpha"}');
  const r = makeRun('wf_p', { agents });
  const { results } = scan([r], { query: 'alpha' });
  assert.deepEqual(results.map((x) => [x.agentId, x.field]), [['__proto__', 'prompt']]);
  const odd = [makeRun('wf_1', { agents: null, logs: 'text' }), makeRun('wf_2', { agents: [], logs: fin('not an array') }), makeRun('wf_3', { agents: { a: { activity: 'x' } } }), makeRun('wf_4', { agents: { a: { activity: [null, 5, 'x'] } } })];
  assert.deepEqual(scan(odd, { query: 'alpha' }), { results: [], more: false });
});

test('the agents searched are the keys of Run.agents (own ones), not `order`: an agent that order lacks is searched, an id order lists alone is not', () => {
  const r = runOf('wf_o', { agents: [agentOf('a1', { prompt: reg('alpha one') }), agentOf('a2', { prompt: reg('alpha two') })], order: ['ghost', 'a2'] });
  assert.deepEqual(scan([r], { query: 'alpha' }).results.map((x) => x.agentId), ['a1', 'a2']);
  const inherited = Object.create({ borrowed: agentOf('borrowed', { prompt: reg('alpha borrowed') }) });
  inherited.own = agentOf('own', { prompt: reg('alpha own') });
  assert.deepEqual(scan([makeRun('wf_i', { agents: inherited })], { query: 'alpha' }).results.map((x) => x.agentId), ['own']);
});

test('a run that getRun does not have is skipped, and one that throws is skipped and reported; the others are still searched', () => {
  const errors = [];
  const good = runOf('wf_good', { name: reg('alpha good') });
  const out = searchRuns({
    query: 'alpha',
    runIds: () => ['wf_gone', 'wf_bad', 'wf_good'],
    getRun: (id) => { if (id === 'wf_bad') throw new Error('cannot read'); return id === 'wf_good' ? good : null; },
    onError: (e) => errors.push(e.message),
  });
  assert.deepEqual(out.results.map((r) => r.runId), ['wf_good']);
  assert.equal(out.more, false);
  assert.deepEqual(errors, ['cannot read']);
});

test('limit: exactly `limit` matches is not "more"; one beyond it is, and the results are the first `limit`', () => {
  const runs = [1, 2, 3, 4].map((i) => runOf(`wf_${i}`, { name: reg(`alpha ${i}`) }));
  assert.deepEqual(scan(runs, { query: 'alpha', limit: 4 }).more, false, 'four matches, limit 4');
  assert.equal(scan(runs, { query: 'alpha', limit: 4 }).results.length, 4);
  const three = scan(runs, { query: 'alpha', limit: 3 });
  assert.equal(three.more, true);
  assert.deepEqual(three.results.map((r) => r.runId), ['wf_1', 'wf_2', 'wf_3']);
  const one = scan(runs, { query: 'alpha', limit: 1 });
  assert.deepEqual([one.results.length, one.more], [1, true]);
  assert.equal(scan(runs.slice(0, 1), { query: 'alpha', limit: 1 }).more, false, 'one match, limit 1');
  assert.equal(scan(runs, { query: 'alpha' }).results.length, 4, 'the default limit is 50');
  assert.deepEqual([SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_BUDGET_MS], [50, 200, 500]);
  // a later field of the same run counts as a result too: the limit is about results, not runs
  const two = runOf('wf_two', { name: reg('alpha'), description: reg('alpha'), logs: fin(['alpha']) });
  assert.deepEqual([scan([two], { query: 'alpha', limit: 2 }).results.length, scan([two], { query: 'alpha', limit: 2 }).more], [2, true]);
});

test('budget: the clock is read from the start; exactly 500 ms is not over and 501 is; results found before the stop stay and more is true', () => {
  for (const [spent, expected, more] of [[500, ['r1', 'r2'], false], [501, ['r1'], true]]) {
    let now = 7000;
    const runs = { r1: runOf('r1', { name: reg('alpha 1') }), r2: runOf('r2', { name: reg('alpha 2') }) };
    const out = searchRuns({
      query: 'alpha', clock: () => now, runIds: () => ['r1', 'r2'],
      getRun: (id) => { if (id === 'r2') now += spent; return runs[id]; }, // reading the second run takes `spent` ms
    });
    assert.deepEqual(out.results.map((r) => r.runId), expected, `spent ${spent}`);
    assert.equal(out.more, more, `spent ${spent}`);
  }
  // the list of runs is read after the clock starts: its time counts
  for (const [spent, more] of [[500, false], [501, true]]) {
    let now = 0;
    const out = searchRuns({ query: 'alpha', clock: () => now, runIds: () => { now += spent; return ['r1']; }, getRun: () => runOf('r1', { name: reg('alpha') }) });
    assert.equal(out.more, more, `listing took ${spent}`);
    assert.equal(out.results.length, more ? 0 : 1);
  }
  // a budget of the caller's own
  let t = 0;
  assert.equal(searchRuns({ query: 'a', budgetMs: 10, clock: () => t, runIds: () => ['r1'], getRun: () => { t = 11; return runOf('r1', { name: reg('a') }); } }).more, true);
});

test('budget: it is checked inside a long run too (agents, fields and activity entries), not only between runs', () => {
  let now = 0;
  const activity = Array.from({ length: 1000 }, (_, i) => ({ ts: i, text: `alpha entry ${i}` }));
  const r = runOf('wf_big', { agents: [agentOf('a1', { activity })] });
  const out = scan([r], { query: 'alpha', limit: 200, clock: () => now++ }); // every read of the clock costs 1 ms
  assert.equal(out.more, true, 'the budget ran out in the middle of the activity');
  assert.ok(out.results.length > 0 && out.results.length < 200, `some results stay, and fewer than the limit would give: ${out.results.length}`);
  // the same scan with a clock that stands still reads all of it
  const all = scan([r], { query: 'alpha', limit: 200, clock: () => 0 });
  assert.equal(all.results.length, 200, 'limited by the limit, not the budget');
  assert.equal(all.more, true);
});

test('budget: the clock is read before every run, agent, field and activity entry, so a stop at any of those reads keeps exactly what came before it', () => {
  // The reads of one scan of fullRun, after the one at the start (read 0): 1 the run; 2 name; 3 description; 4, 5, 6 the three log lines;
  // 7 the agent; 8 its prompt; 9 its result; 10 the activity entry; 11 its tool input summary; 12 its text. A field is read (and its clock
  // looked at) whether or not it has text, so the numbers do not depend on what matches. The matches are name, description, the second log
  // line, prompt, result, summary and text, found after their reads 2, 3, 5, 8, 9, 11 and 12.
  const matchAfterRead = [2, 3, 5, 8, 9, 11, 12];
  const run = fullRun();
  for (let stopAt = 1; stopAt <= 13; stopAt++) {
    let reads = 0;
    const out = scan([run], { query: 'alpha', clock: () => (reads++ < stopAt ? 0 : SEARCH_BUDGET_MS + 1) }); // over the budget from read `stopAt` on
    const expected = matchAfterRead.filter((n) => n < stopAt).length;
    assert.equal(out.results.length, expected, `the clock ran out at read ${stopAt}`);
    assert.equal(out.more, stopAt <= 12, `more is true when a read was over the budget (read ${stopAt}); none is over from 13`);
  }
  let reads = 0;
  scan([run], { query: 'alpha', clock: () => { reads += 1; return 0; } });
  assert.equal(reads, 13, 'the start, then one read per run, name, description, log line, agent, prompt, result, entry, summary and text');
  // an agent and a run with nothing to search are still read once each
  reads = 0;
  scan([runOf('r_empty', { agents: [agentOf('a_empty')] })], { query: 'alpha', clock: () => { reads += 1; return 0; } });
  assert.equal(reads, 1 + 1 + 2 + 1 + 2, 'the start, the run, its name and description, the agent, its prompt and result');
});

test('an agent with no activity array, and an activity entry with no text, are skipped; many agents and runs keep their order', () => {
  const runs = [
    runOf('wf_b', { agents: [agentOf('b1', { prompt: reg('alpha b1') }), agentOf('b2', { result: reg('alpha b2') })] }),
    runOf('wf_a', { name: reg('alpha a'), agents: [{ ...agentOf('a1'), activity: undefined }] }),
  ];
  assert.deepEqual(scan(runs, { query: 'alpha' }).results.map((r) => [r.runId, r.agentId ?? null, r.field]), [
    ['wf_b', 'b1', 'prompt'], ['wf_b', 'b2', 'result'], ['wf_a', null, 'name'],
  ], 'in the order of the run list, then of the keys of Run.agents');
});

// =====================================================================================================================
// GET /api/search
// =====================================================================================================================

async function start(t, { runs = [], store = createFakeStore(runs), mode = 'real', ...rest } = {}) {
  const errors = [];
  const server = createServer({ store, mode, version: '9.9.9', onError: (e) => errors.push(e), ...rest });
  const address = await listenOnFreePort(server);
  t.after(() => closeServer(server));
  return { server, store, port: address.port, errors };
}
const search = (port, query, headers) => getJson(port, `/api/search${query}`, headers);

test('GET /api/search?q=: the results of the contract, case-insensitive, with the text cut out by start and end in the text\'s own case', async (t) => {
  const { port } = await start(t, { runs: [fullRun('wf_one'), runOf('wf_two', { name: reg('Another PROBE run'), logs: fin(['probe line']) })] });
  const a = await search(port, '?q=alpha');
  assert.equal(a.status, 200);
  assert.match(a.headers['content-type'], /^application\/json/);
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(a.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(Object.keys(a.json).sort(), ['more', 'results']);
  assert.equal(a.json.more, false);
  assert.equal(a.json.results.length, 7);
  assert.deepEqual(a.json.results.map((r) => r.field), ['name', 'description', 'log', 'prompt', 'result', 'activity-summary', 'activity-text']);
  assert.deepEqual(a.json.results.map(cut), ['Alpha', 'alpha', 'alpha', 'Alpha', 'alpha', 'alpha', 'alpha']);
  for (const r of a.json.results) assert.equal(r.runId, 'wf_one');
  const up = await search(port, '?q=ALPHA');
  assert.deepEqual(up.json, a.json, 'the case of the query changes nothing');
  const probe = await search(port, '?q=Probe');
  assert.deepEqual(probe.json.results.map((r) => [r.runId, r.field, cut(r)]), [['wf_one', 'description', 'probe'], ['wf_two', 'name', 'PROBE'], ['wf_two', 'log', 'probe']]);
  assert.deepEqual((await search(port, '?q=nothingmatchesthis')).json, { results: [], more: false });
});

test('GET /api/search: q is required, given once and not trimmed; limit is digits, at least 1, given once, above 200 it is 200', async (t) => {
  const { port } = await start(t, { runs: [runOf('wf_one', { name: reg('an alpha run') })] });
  for (const bad of ['', '?q=', '?limit=3', '?q=a&q=b', '?q=a&q=', '?q=a&limit=0', '?q=a&limit=x', '?q=a&limit=-1', '?q=a&limit=1.5', '?q=a&limit=', '?q=a&limit=1&limit=2', '?q=a&limit=1e2', '?q=a&limit=+5', '?q=a&limit=%205']) {
    const res = await search(port, bad);
    assert.equal(res.status, 400, bad);
    assert.equal(typeof res.json.error, 'string', bad);
    assert.ok(res.json.error.length > 0);
    assert.equal('results' in res.json, false, bad);
  }
  // not trimmed: the leading space is part of the query (and a space alone is a query, not an error)
  const spaced = await search(port, '?q=%20alpha');
  assert.equal(spaced.status, 200);
  assert.deepEqual(spaced.json.results.map((r) => [r.excerpt, r.start, r.end]), [['an alpha run', 2, 8]], 'the space is part of the match');
  assert.equal((await search(port, '?q=alpha%20')).json.results.length, 1, 'the trailing space matches the one after it');
  assert.deepEqual((await search(port, '?q=%20alpha%20%20')).json.results, [], 'two trailing spaces are not in the text');
  assert.equal((await search(port, '?q=%20')).status, 200);
  assert.equal((await search(port, '?q=alpha&limit=999')).status, 200, 'above the maximum is the maximum');
  assert.equal((await search(port, '?q=alpha&limit=007')).status, 200);
  assert.equal((await search(port, '?q=alpha&limit=99999999999999999999')).status, 200);
  assert.equal((await search(port, '?limit=5&q=alpha')).status, 200, 'the order of the parameters does not matter');
});

test('GET /api/search: limit and more over HTTP: the default is 50, the maximum 200, `more` only when a further match exists', async (t) => {
  const runs = Array.from({ length: 205 }, (_, i) => runOf(`wf_${String(i).padStart(3, '0')}`, { name: reg(`alpha ${i}`) }));
  const { port } = await start(t, { runs });
  const def = await search(port, '?q=alpha');
  assert.deepEqual([def.json.results.length, def.json.more], [50, true], 'default 50');
  const max = await search(port, '?q=alpha&limit=999');
  assert.deepEqual([max.json.results.length, max.json.more], [200, true], 'clamped to 200, five more exist');
  assert.deepEqual(max.json.results.slice(0, 3).map((r) => r.runId), ['wf_000', 'wf_001', 'wf_002'], 'in the order of the run list');
  const one = await search(port, '?q=alpha&limit=1');
  assert.deepEqual([one.json.results.length, one.json.more], [1, true]);
  const few = await search(port, '?q=alpha%2020&limit=5'); // "alpha 20" matches alpha 20, 200..204 (6 of them)
  assert.deepEqual([few.json.results.length, few.json.more], [5, true]);
  const exact = await search(port, '?q=alpha%20200&limit=1'); // exactly one match, limit 1
  assert.deepEqual([exact.json.results.length, exact.json.more], [1, false], 'exactly `limit` matches is not more');
  const exact200 = await start(t, { runs: runs.slice(0, 200) });
  const all = await search(exact200.port, '?q=alpha&limit=200');
  assert.deepEqual([all.json.results.length, all.json.more], [200, false], '200 matches, limit 200');
});

test('GET /api/search: the 500 ms budget on the injected clock, from before the list of runs is read; the results found stay', async (t) => {
  for (const [spent, runsFound, more] of [[500, 2, false], [501, 0, true]]) {
    let now = 100;
    const store = createFakeStore([runOf('wf_1', { name: reg('alpha 1') }), runOf('wf_2', { name: reg('alpha 2') })]);
    const listRuns = store.listRuns;
    store.listRuns = () => { now += spent; return listRuns(); }; // reading the list takes `spent` ms
    const { port } = await start(t, { store, searchClock: () => now });
    const res = await search(port, '?q=alpha');
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.results.length, res.json.more], [runsFound, more], `list took ${spent}`);
  }
  // a run that takes long to read stops the scan after the runs before it
  let now = 0;
  const store = createFakeStore([runOf('wf_1', { name: reg('alpha 1') }), runOf('wf_2', { name: reg('alpha 2') }), runOf('wf_3', { name: reg('alpha 3') })]);
  const getRun = store.getRun;
  store.getRun = (id) => { if (id === 'wf_2') now += 501; return getRun(id); };
  const { port } = await start(t, { store, searchClock: () => now });
  const res = await search(port, '?q=alpha');
  assert.deepEqual(res.json.results.map((r) => r.runId), ['wf_1']);
  assert.equal(res.json.more, true);
  assert.throws(() => createServer({ store: createFakeStore(), mode: 'real', searchClock: 5 }), TypeError);
});

test('GET /api/search: GET only (HEAD and POST are 405 with Allow), exactly two path parts, the Host check applies and a foreign Host gets no run data', async (t) => {
  const { port } = await start(t, { runs: [runOf('wf_one', { name: reg('alpha run') })] });
  for (const [method, allow] of [['POST', 'GET, HEAD'], ['PUT', 'GET, HEAD'], ['DELETE', 'GET, HEAD'], ['HEAD', 'GET']]) { // the server refuses a write method for every route; a HEAD is refused by the search itself
    const res = await request(port, { method, path: '/api/search?q=alpha' });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, allow, method);
    assert.doesNotMatch(res.body, /alpha/, method);
  }
  assert.equal((await request(port, { path: '/api/search/x?q=alpha' })).status, 404);
  assert.equal((await request(port, { path: '/api/search/alpha/x?q=alpha' })).status, 404);
  assert.equal((await request(port, { path: '/api/search/?q=alpha' })).status, 200, 'one trailing slash, as for every route');
  const foreign = await request(port, { path: '/api/search?q=alpha', headers: { host: 'evil.example.com' } });
  assert.equal(foreign.status, 403);
  assert.doesNotMatch(foreign.body, /alpha run/);
  const odd = await search(port, '?q=%ZZ');
  assert.deepEqual([odd.status, odd.json], [200, { results: [], more: false }], 'a malformed escape in the query is only text, never a crash');
});

test('GET /api/search: only runs that are visible in this mode and loaded; a run that is only listed is never loaded by a search', async (t) => {
  const loads = [];
  const loader = {
    isLoaded: (id) => { if (id === 'wf_throws') throw new Error('loader broke'); return id !== 'wf_cold'; },
    load: async (id) => { loads.push(id); },
  };
  const runs = [
    runOf('wf_warm', { name: reg('alpha warm') }),
    runOf('wf_cold', { name: reg('alpha cold') }),
    runOf('wf_demo', { source: 'demo', name: reg('alpha demo') }),
    runOf('wf_replay', { source: 'replay', name: reg('alpha replay') }),
    runOf('wf_bare', { source: undefined, name: reg('alpha bare') }), // no `source`: counts as visible
    runOf('wf_throws', { name: reg('alpha throws') }),
  ];
  const { port, errors } = await start(t, { runs, loader });
  const res = await search(port, '?q=alpha');
  assert.deepEqual(res.json.results.map((r) => r.runId), ['wf_warm', 'wf_bare']);
  assert.deepEqual(loads, [], 'a search never loads a run');
  assert.ok(errors.some((e) => e instanceof Error && e.message === 'loader broke'), 'a loader that throws is reported and the run counts as not loaded');
  // without a loader every visible run counts as loaded
  const plain = await start(t, { runs });
  assert.deepEqual((await search(plain.port, '?q=alpha')).json.results.map((r) => r.runId), ['wf_warm', 'wf_cold', 'wf_bare', 'wf_throws']);
  // the same runs in demo mode: only the demo run
  const demo = await start(t, { runs, mode: 'demo' });
  assert.deepEqual((await search(demo.port, '?q=alpha')).json.results.map((r) => r.runId), ['wf_demo', 'wf_bare']);
});

test('GET /api/search: both the list entry and the run the store gives must be visible in this mode (two locks): a source that disagrees with the mode on either is not searched', async (t) => {
  const store = createFakeStore([runOf('wf_ok', { name: reg('alpha ok') }), runOf('wf_run_flipped', { name: reg('alpha run') }), runOf('wf_list_flipped', { name: reg('alpha list') })]);
  const getRun = store.getRun;
  const listRuns = store.listRuns;
  store.getRun = (id) => (id === 'wf_run_flipped' ? { ...getRun(id), source: 'demo' } : getRun(id));
  store.listRuns = () => listRuns().map((r) => (r.id === 'wf_list_flipped' ? { ...r, source: 'demo' } : r));
  const { port } = await start(t, { store });
  assert.deepEqual((await search(port, '?q=alpha')).json.results.map((r) => r.runId), ['wf_ok']);
});

test('GET /api/search: a run that disappears or breaks is skipped (never a 500), and the other runs are answered', async (t) => {
  const store = createFakeStore([runOf('wf_ok', { name: reg('alpha ok') }), runOf('wf_gone', { name: reg('alpha gone') }), runOf('wf_bad', { name: reg('alpha bad') }), runOf('wf_last', { name: reg('alpha last') })]);
  const getRun = store.getRun;
  store.getRun = (id) => {
    if (id === 'wf_gone') return null;
    if (id === 'wf_bad') throw new Error('store broke');
    return getRun(id);
  };
  const { port, errors } = await start(t, { store });
  const res = await search(port, '?q=alpha');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.results.map((r) => r.runId), ['wf_ok', 'wf_last']);
  assert.deepEqual(errors.map((e) => e.message), ['store broke']);
});

test('GET /api/search is read-only: it calls only listRuns and getRun, changes no run, adds no listener or timer, and loads nothing', async (t) => {
  const store = createFakeStore([fullRun('wf_one'), runOf('wf_two', { name: reg('alpha two') })]);
  const calls = [];
  for (const name of Object.keys(store)) {
    if (typeof store[name] !== 'function') continue;
    const f = store[name];
    store[name] = (...a) => { calls.push(name); return f(...a); };
  }
  const loads = [];
  const { port } = await start(t, { store, loader: { isLoaded: () => true, load: async (id) => { loads.push(id); } } });
  const before = JSON.stringify([...store.runs.values()]);
  const listeners = [store.listenerCount(), store.eventListenerCount()];
  calls.length = 0;
  for (const q of ['?q=alpha', '?q=zzz', '?q=alpha&limit=1']) await search(port, q);
  assert.deepEqual([...new Set(calls)].sort(), ['getRun', 'listRuns']);
  assert.equal(JSON.stringify([...store.runs.values()]), before, 'no run changed');
  assert.deepEqual([store.listenerCount(), store.eventListenerCount()], listeners, 'no listener left behind');
  assert.deepEqual(loads, []);
});

test('GET /api/search: markup in the text comes back as data (JSON, nosniff), cut at its match, never changed', async (t) => {
  const markup = '<img src=x onerror=alert(1)></mark>&amp;"\'';
  const { port } = await start(t, { runs: [runOf('wf_x', { name: reg(`before ${markup} after needle`), agents: [agentOf('a1', { result: reg(`${markup}needle`) })] })] });
  const res = await search(port, '?q=needle');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.json.results.map((r) => [r.field, r.excerpt, cut(r)]), [['name', `before ${markup} after needle`, 'needle'], ['result', `${markup}needle`, 'needle']]);
  assert.equal((await search(port, `?q=${encodeURIComponent('<img src=x')}`)).json.results.length, 2, 'markup in the query is only text');
});

test('GET /api/search: Unicode folding and offsets over HTTP (sigma, sharp s, U+0130, a surrogate pair), each read back against the original text', async (t) => {
  const runs = [runOf('wf_u', { agents: [
    agentOf('s', { prompt: reg('\u039f\u0394\u039f\u03a3') }),
    agentOf('g', { prompt: reg('Gro\u00dfe Stra\u00dfe') }),
    agentOf('t', { prompt: reg('\u0130stanbul') }),
    agentOf('e', { prompt: reg('smile \u{1f600} done') }),
  ] })];
  const { port } = await start(t, { runs });
  const q = async (text) => (await search(port, `?q=${encodeURIComponent(text)}`)).json.results.map((r) => [r.agentId, cut(r)]);
  assert.deepEqual(await q('\u03bf\u03b4\u03bf\u03c2'), [['s', '\u039f\u0394\u039f\u03a3']]);
  assert.deepEqual(await q('STRASSE'), [['g', 'Stra\u00dfe']]);
  assert.deepEqual(await q('ss'), [['g', '\u00df']], 'the first sharp s, whole');
  assert.deepEqual(await q('s'), [['g', 'S'], ['t', 's'], ['e', 's']], 'the s of "Stra", the s of "stanbul", the first s of "smile"; never half of a sharp s');
  assert.deepEqual(await q('i'), [['e', 'i']], 'only the i of "smile": U+0130 is not a plain i');
  assert.deepEqual(await q('\u{1f600}'), [['e', '\u{1f600}']]);
});
