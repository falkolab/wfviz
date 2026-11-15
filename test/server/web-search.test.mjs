// test/server/web-search.test.mjs (node run-search): the search box of the header. The pure part is in web/lib.js (searchUrl, searchAnswer, highlightParts,
// searchItems, searchStatus, notSearchedLine, createSearch) and is tested with plain data and a fake fetch, timer and controller. The page itself
// (rows, escaping, click, Esc, debounce, abort, patching) runs app.js on the fake browser of fake-page.mjs, which counts every write and records every
// node made or removed. The words of the test data are neutral (alpha, probe): the code asserts nothing about them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';
import { allEls, bootPage } from './fake-page.mjs';
import { test } from './helpers.mjs';

const {
  SEARCH_BUSY_TEXT, SEARCH_CUT_TEXT, SEARCH_DELAY_MS, SEARCH_MORE_TEXT, SEARCH_NONE_TEXT, createSearch, highlightParts, notSearchedLine, scrollToShow, searchAnswer, searchFieldText,
  searchFailedText, searchItems, searchSection, searchStatus, searchUrl,
} = lib;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWeb = (f) => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');

const reg = (value, from = 'f:1') => ({ value, prov: 'registered', from });
const inf = (value, method = 'test-rule') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });

const MARKUP = '<img src=x onerror=1></mark>&amp;"\'';

// =====================================================================================================================
// the pure part (web/lib.js)
// =====================================================================================================================

test('searchUrl: the text as typed, escaped, never trimmed', () => {
  assert.equal(searchUrl('alpha'), '/api/search?q=alpha');
  assert.equal(searchUrl(' a b&c=d#e '), '/api/search?q=%20a%20b%26c%3Dd%23e%20');
  assert.equal(searchUrl('\u00e9\u{1f600}'), '/api/search?q=%C3%A9%F0%9F%98%80');
  assert.equal(searchUrl(MARKUP), `/api/search?q=${encodeURIComponent(MARKUP)}`);
});

test('searchAnswer: the answer as the page keeps it; a result that cannot be shown is left out, more is true only when the server says true', () => {
  const good = { runId: 'wf_1', agentId: 'a1', field: 'prompt', excerpt: 'an alpha', start: 3, end: 8 };
  const run = { runId: 'wf_1', field: 'name', excerpt: 'alpha', start: 0, end: 5 };
  assert.deepEqual(searchAnswer({ results: [good, run], more: true }), { ok: true, results: [good, run], more: true });
  assert.equal('agentId' in searchAnswer({ results: [run], more: false }).results[0], false, 'a run field has no agentId, not a null');
  assert.deepEqual(searchAnswer({ results: [], more: false }), { ok: true, results: [], more: false });
  for (const odd of ['true', 1, null, undefined, 'yes', {}]) assert.equal(searchAnswer({ results: [], more: odd }).more, false, String(odd));
  const left = [
    { field: 'name', excerpt: 'x', start: 0, end: 1 }, // no run id
    { runId: '', field: 'name', excerpt: 'x' }, // an empty run id
    { runId: 'wf_1', excerpt: 'x' }, // no field
    { runId: 'wf_1', field: 'name' }, // no excerpt
    { runId: 'wf_1', field: 'name', excerpt: 5 },
    { runId: 'wf_1', agentId: 7, field: 'prompt', excerpt: 'x', start: 0, end: 1 }, // an agent id that is not text
    null, 'text', 4,
  ];
  assert.deepEqual(searchAnswer({ results: [...left, good], more: false }).results, [good]);
  for (const bad of [null, undefined, 'x', 5, {}, { results: 'a' }, { results: null }, []]) {
    const a = searchAnswer(bad);
    assert.equal(a.ok, false, String(JSON.stringify(bad)));
    assert.equal(typeof a.reason, 'string');
  }
  // an excerpt with markup is only text here
  assert.equal(searchAnswer({ results: [{ ...good, excerpt: MARKUP }], more: false }).results[0].excerpt, MARKUP);
});

test('highlightParts: before, match, after of one text; offsets that cannot be a match mark nothing and never throw', () => {
  assert.deepEqual(highlightParts('an alpha run', 3, 8), { before: 'an ', match: 'alpha', after: ' run' });
  assert.deepEqual(highlightParts('alpha', 0, 5), { before: '', match: 'alpha', after: '' });
  assert.deepEqual(highlightParts('alpha', 4, 5), { before: 'alph', match: 'a', after: '' });
  const whole = (text) => ({ before: text, match: '', after: '' });
  const t = 'an alpha run';
  for (const [s, e, why] of [
    [-1, 3, 'negative start'], [3, 3, 'empty'], [8, 3, 'reversed'], [3, 99, 'past the end'], [3, 13, 'one past the end'], [1.5, 4, 'fraction'], [3, 8.5, 'fraction end'],
    ['3', 8, 'text start'], [3, '8', 'text end'], [NaN, 4, 'NaN'], [0, NaN, 'NaN end'], [Infinity, 4, 'infinity'], [undefined, undefined, 'none'], [null, null, 'null'], [{}, [], 'objects'],
    [0, Infinity, 'infinite end'],
  ]) assert.deepEqual(highlightParts(t, s, e), whole(t), why);
  // inside a surrogate pair at either end
  const pair = 'a\u{1f600}b'; // a, high, low, b
  assert.deepEqual(highlightParts(pair, 1, 3), { before: 'a', match: '\u{1f600}', after: 'b' }, 'the whole pair is a match');
  assert.deepEqual(highlightParts(pair, 2, 4), whole(pair), 'starts at the low half');
  assert.deepEqual(highlightParts(pair, 0, 2), whole(pair), 'ends between the halves');
  assert.deepEqual(highlightParts(pair, 3, 4), { before: 'a\u{1f600}', match: 'b', after: '' });
  // not a text
  for (const odd of [undefined, null, 5, {}, []]) assert.deepEqual(highlightParts(odd, 0, 1), whole(''), String(odd));
  // markup is returned as the text it is
  assert.deepEqual(highlightParts(`x${MARKUP}y`, 1, 1 + MARKUP.length), { before: 'x', match: MARKUP, after: 'y' });
});

test('searchItems: one item per result, the run\'s name from the run list, an agent\'s label only for the run on show, keys that survive a longer list', () => {
  const runs = [{ id: 'wf_1', name: reg('First run') }, { id: 'wf_2', name: unk('no script meta') }, { id: 'wf_3' }];
  const shown = { id: 'wf_1', agents: { a1: { label: reg('reader:U1') }, a2: { label: unk('no label') }, a4: { id: 'a4' } } };
  const hits = [
    { runId: 'wf_1', field: 'name', excerpt: 'First', start: 0, end: 5 },
    { runId: 'wf_1', agentId: 'a1', field: 'prompt', excerpt: 'alpha', start: 0, end: 5 },
    { runId: 'wf_1', agentId: 'a2', field: 'result', excerpt: 'alpha', start: 0, end: 5 },
    { runId: 'wf_1', agentId: 'ghost', field: 'result', excerpt: 'alpha', start: 0, end: 5 },
    { runId: 'wf_2', agentId: 'a1', field: 'activity-text', excerpt: 'alpha', start: 0, end: 5 },
    { runId: 'wf_3', field: 'log', excerpt: 'alpha', start: 0, end: 5 },
    { runId: 'wf_9', field: 'brand-new-field', excerpt: 'alpha', start: 0, end: 5 },
  ];
  const items = searchItems(hits, runs, shown);
  assert.deepEqual(items.map((i) => i.runName), ['First run', 'First run', 'First run', 'First run', 'wf_2', 'wf_3', 'wf_9'], 'an unknown or missing name is the run id');
  assert.deepEqual(items.map((i) => i.agent), [null, 'reader:U1', 'a2', 'ghost', 'a1', null, null], 'a label for the run on show only; else the id; no agent on a run field');
  assert.deepEqual(items.map((i) => i.fieldText), ['run name', 'prompt', 'result', 'result', 'activity: text', 'log line', 'brand-new-field']);
  assert.equal(new Set(items.map((i) => i.key)).size, items.length, 'keys are different');
  assert.deepEqual(items.map((i) => i.hit), hits);
  // the same result keeps its key when the list grows at the end (so its row is kept)
  const longer = searchItems([...hits, { runId: 'wf_1', agentId: 'a1', field: 'result', excerpt: 'more', start: 0, end: 4 }], runs, shown);
  assert.deepEqual(longer.slice(0, 7).map((i) => i.key), items.map((i) => i.key));
  // two results of the same field of the same agent (two activity entries) still get different keys
  const twins = searchItems([hits[4], { ...hits[4], excerpt: 'beta alpha', start: 5 }], runs, null);
  assert.notEqual(twins[0].key, twins[1].key);
  // nothing to show, nothing to throw
  assert.deepEqual(searchItems(null, null, null), []);
  assert.deepEqual(searchItems([hits[1]], null, null).map((i) => [i.runName, i.agent]), [['wf_1', 'a1']]);
  assert.equal(searchItems([hits[1]], runs, { id: 'wf_1', agents: null })[0].agent, 'a1');
  assert.equal(searchItems([{ ...hits[1], agentId: '__proto__' }], runs, { id: 'wf_1', agents: {} })[0].agent, '__proto__');
  assert.equal(searchItems([{ ...hits[1], agentId: 'toString' }], runs, { id: 'wf_1', agents: {} })[0].agent, 'toString', 'an agent id is a key, not a method name');
});

test('the words of a row: the fields the server names, one it does not know as written, and the drawer section each opens', () => {
  assert.deepEqual(['name', 'description', 'log', 'prompt', 'result', 'activity-summary', 'activity-text'].map(searchFieldText), [
    'run name', 'run description', 'log line', 'prompt', 'result', 'activity: tool input', 'activity: text',
  ]);
  assert.equal(searchFieldText('x<b>y'), 'x<b>y');
  assert.equal(searchFieldText('constructor'), 'constructor');
  assert.equal(searchFieldText(undefined), 'undefined');
  assert.deepEqual(['prompt', 'result', 'activity-summary', 'activity-text'].map(searchSection), ['prompt', 'result', 'activity', 'activity']);
  for (const f of ['name', 'description', 'log', 'x', 'constructor', '__proto__', undefined]) assert.equal(searchSection(f), null, String(f));
});

test('searchStatus and notSearchedLine: what the page says when there is nothing, something pending, a failure, more than shown, or runs that are not read', () => {
  const view = (over) => ({ phase: 'done', text: 'a', results: [], more: false, reason: null, ...over });
  assert.equal(searchStatus(view({ phase: 'idle' })), '');
  assert.equal(searchStatus(view({ phase: 'waiting' })), SEARCH_BUSY_TEXT);
  assert.equal(searchStatus(view({ phase: 'loading' })), SEARCH_BUSY_TEXT);
  assert.equal(searchStatus(view({ results: [] })), SEARCH_NONE_TEXT);
  assert.equal(searchStatus(view({ results: [{}], more: false })), '');
  assert.equal(searchStatus(view({ results: [{}], more: true })), SEARCH_MORE_TEXT);
  // an empty answer that says `more` was cut short by the server's time budget: it is never "no results" (a scan that did not finish found nothing yet)
  assert.equal(searchStatus(view({ results: [], more: true })), SEARCH_CUT_TEXT);
  assert.notEqual(SEARCH_CUT_TEXT, SEARCH_NONE_TEXT);
  assert.doesNotMatch(SEARCH_CUT_TEXT, /no results/);
  assert.match(SEARCH_CUT_TEXT, /time limit/);
  assert.match(SEARCH_CUT_TEXT, /no result yet/);
  assert.equal(searchStatus(view({ results: [], more: false })), SEARCH_NONE_TEXT, 'a finished scan with nothing is "no results"');
  assert.equal(searchStatus(view({ phase: 'failed', reason: 'HTTP 500' })), 'search failed: HTTP 500');
  assert.equal(searchStatus(view({ phase: 'failed', reason: null })), 'search failed: no reason given');
  assert.equal(searchFailedText('boom'), 'search failed: boom');
  assert.equal(SEARCH_MORE_TEXT, 'more results not shown', 'no number: the server does not count what it did not look at');
  assert.doesNotMatch(SEARCH_MORE_TEXT, /\d/);
  assert.equal(searchStatus(undefined), '');
  // the runs that are only listed
  assert.equal(notSearchedLine([]), '');
  assert.equal(notSearchedLine(null), '');
  assert.equal(notSearchedLine([{ id: 'a' }, { id: 'b', loaded: true }]), '', 'no `loaded` counts as loaded');
  assert.match(notSearchedLine([{ id: 'a', loaded: false }]), /^1 run is not loaded and not searched/);
  assert.match(notSearchedLine([{ id: 'a', loaded: false }, { id: 'b', loaded: false }, { id: 'c' }]), /^2 runs are not loaded and not searched/);
});

// ---- createSearch: fake fetch, timer and controller ----------------------------------------------------------------

function rig({ makeController = () => new AbortController() } = {}) {
  const timers = new Map();
  let n = 0;
  const calls = []; // one per request: the url, its signal and a way to answer
  const views = [];
  const controllers = [];
  const clears = [];
  const search = createSearch({
    fetchJson: (url, signal) => new Promise((resolve, reject) => calls.push({ url, signal, resolve, reject })),
    setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearTimer: (h) => { clears.push(h); timers.delete(h); },
    makeController: () => { const c = makeController(); controllers.push(c); return c; },
    onChange: (v) => views.push(v),
  });
  const r = {
    search, timers, calls, views, controllers, clears,
    fire() { const [id, t] = [...timers][0]; timers.delete(id); t.fn(); },
    async answer(i, data) { calls[i].resolve({ data, error: null }); await Promise.resolve(); await Promise.resolve(); },
    last: () => views.at(-1),
  };
  return r;
}
const R = (runId, field = 'prompt', excerpt = 'alpha') => ({ runId, ...(field === 'name' ? {} : { agentId: 'a1' }), field, excerpt, start: 0, end: excerpt.length });

test('createSearch: typing waits the delay with one timer; a newer keystroke clears the older timer; nothing is asked and no controller made until it fires', () => {
  const t = rig();
  assert.equal(SEARCH_DELAY_MS, 250);
  t.search.input('a');
  t.search.input('al');
  t.search.input('alp');
  assert.equal(t.timers.size, 1, 'one timer at most');
  assert.equal([...t.timers.values()][0].ms, 250);
  assert.equal(t.clears.length, 2, 'the older timers were cleared');
  assert.equal(t.calls.length, 0, 'nothing asked yet');
  assert.equal(t.controllers.length, 0, 'no controller per keystroke');
  assert.deepEqual([t.last().phase, t.last().text], ['waiting', 'alp']);
  t.fire();
  assert.equal(t.timers.size, 0, 'the timer is released when it fires');
  assert.equal(t.calls.length, 1);
  assert.equal(t.controllers.length, 1, 'one controller per request');
  assert.equal(t.calls[0].url, searchUrl('alp'));
  assert.equal(t.calls[0].signal, t.controllers[0].signal, 'the request carries the controller\'s signal');
  assert.equal(t.last().phase, 'loading');
});

test('createSearch: the text sent is the text typed (not trimmed); empty or space-only text asks for nothing and clears', async () => {
  const t = rig();
  t.search.input('  alpha  beta ');
  t.fire();
  assert.equal(t.calls[0].url, '/api/search?q=%20%20alpha%20%20beta%20');
  await t.answer(0, { results: [R('wf_1')], more: false });
  assert.equal(t.last().phase, 'done');
  for (const blank of ['', '   ', '\t', '\n ', undefined, null, 5]) {
    const t2 = rig();
    t2.search.input('alpha');
    t2.search.input(blank);
    assert.equal(t2.timers.size, 0, `no timer for ${JSON.stringify(blank)}`);
    assert.equal(t2.calls.length, 0);
    assert.deepEqual(t2.last(), { phase: 'idle', text: '', results: [], more: false, reason: null });
  }
  // blank text while a request is out: the request is aborted and its answer is never drawn
  const t3 = rig();
  t3.search.input('alpha');
  t3.fire();
  t3.search.input('');
  assert.equal(t3.calls[0].signal.aborted, true);
  const seen = t3.views.length;
  await t3.answer(0, { results: [R('wf_1')], more: false });
  assert.equal(t3.views.length, seen, 'the late answer changes nothing');
  assert.equal(t3.last().phase, 'idle');
});

test('createSearch: a newer query aborts the older request, and the older answer is never drawn, even when the fetch ignores the signal', async () => {
  for (const [kind, makeController] of [
    ['a real AbortController', () => new AbortController()],
    ['a controller whose signal never says aborted', () => ({ signal: { aborted: false }, abort() {} })], // only the page's own turn count can tell
  ]) {
    const t = rig({ makeController });
    t.search.input('a');
    t.fire();
    t.search.input('ab');
    if (kind === 'a real AbortController') assert.equal(t.calls[0].signal.aborted, true, 'the older request is aborted at once');
    t.fire();
    assert.equal(t.calls.length, 2);
    assert.equal(t.calls[1].url, searchUrl('ab'));
    const seen = t.views.length;
    await t.answer(0, { results: [R('wf_old', 'prompt', 'stale a')], more: true }); // the fetch ignored the abort and answered
    assert.equal(t.views.length, seen, `${kind}: the stale answer is not drawn`);
    assert.equal(t.last().phase, 'loading');
    await t.answer(1, { results: [R('wf_new', 'prompt', 'fresh ab')], more: false });
    assert.deepEqual([t.last().phase, t.last().results.map((r) => r.runId), t.last().more, t.last().text], ['done', ['wf_new'], false, 'ab'], kind);
    // an answer that comes after a done one, for the older request, still changes nothing
    await t.answer(0, { results: [], more: false });
    assert.equal(t.last().results.length, 1, kind);
  }
});

test('createSearch: an abort is not a failure, whoever aborted; a failure says why, clears the results and is not "no results"', async () => {
  const t = rig();
  t.search.input('a');
  t.fire();
  t.search.input('ab');
  t.calls[0].resolve({ data: null, error: 'The operation was aborted.' }); // what fetchJson gives for an aborted fetch
  await Promise.resolve();
  await Promise.resolve();
  assert.notEqual(t.last().phase, 'failed');
  t.fire();
  // the request is aborted from outside (the browser, not the query logic): still not a failure
  t.controllers[1].abort();
  t.calls[1].resolve({ data: null, error: 'The operation was aborted.' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(t.views.some((v) => v.phase === 'failed'), false, 'no view ever said failed');
  // a real failure
  const f = rig();
  f.search.input('a');
  f.fire();
  await f.answer(0, { results: [R('wf_1')], more: false });
  f.search.input('ab');
  f.fire();
  assert.equal(f.last().results.length, 1, 'the last results stay while the next query is out');
  f.calls[1].resolve({ data: null, error: 'HTTP 503', reason: 'search is switched off' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([f.last().phase, f.last().reason, f.last().results, f.last().more], ['failed', 'search is switched off', [], false]);
  assert.equal(searchStatus(f.last()), 'search failed: search is switched off');
  // no reason in the body: the status text of the request; a rejected fetch: the error's message; a wrong answer: its own reason
  const g = rig();
  g.search.input('a');
  g.fire();
  g.calls[0].resolve({ data: null, error: 'HTTP 500', reason: null });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(g.last().reason, 'HTTP 500');
  g.search.input('b');
  g.fire();
  g.calls[1].reject(new Error('connection reset'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual([g.last().phase, g.last().reason], ['failed', 'connection reset']);
  g.search.input('c');
  g.fire();
  await g.answer(2, { nothing: 'here' });
  assert.deepEqual([g.last().phase, g.last().reason], ['failed', 'the answer is not a search result']);
  // after a failure, the next query works as usual
  g.search.input('d');
  g.fire();
  await g.answer(3, { results: [R('wf_2')], more: true });
  assert.deepEqual([g.last().phase, g.last().more, g.last().reason], ['done', true, null]);
});

test('createSearch: while a newer query waits or is out, the last results stay on show; cancel drops the timer, the request and the results', async () => {
  const t = rig();
  t.search.input('a');
  t.fire();
  await t.answer(0, { results: [R('wf_1'), R('wf_2')], more: false });
  t.search.input('ab');
  assert.deepEqual([t.last().phase, t.last().results.length], ['waiting', 2], 'waiting: the last results are still there');
  t.fire();
  assert.deepEqual([t.last().phase, t.last().results.length], ['loading', 2], 'out: the last results are still there');
  // Esc: nothing waits, nothing is out, nothing is shown
  t.search.cancel();
  assert.equal(t.calls[1].signal.aborted, true);
  assert.equal(t.timers.size, 0);
  assert.deepEqual(t.last(), { phase: 'idle', text: '', results: [], more: false, reason: null });
  assert.deepEqual(t.search.view, t.last());
  const seen = t.views.length;
  await t.answer(1, { results: [R('wf_3')], more: false });
  assert.equal(t.views.length, seen, 'the answer of the cancelled request is never drawn');
  // a timer that waits is cleared by cancel too
  t.search.input('x');
  assert.equal(t.timers.size, 1);
  t.search.cancel();
  assert.equal(t.timers.size, 0);
});

test('createSearch: a request that has settled is dropped: the next query does not abort it (no abort of a finished request)', async () => {
  const t = rig();
  t.search.input('a');
  t.fire();
  await t.answer(0, { results: [], more: false });
  t.search.input('b');
  t.search.cancel();
  assert.equal(t.controllers[0].signal.aborted, false, 'the controller of an answered request is left alone');
  assert.equal(t.controllers.length, 1);
});

// =====================================================================================================================
// the page (web/app.js on the fake browser)
// =====================================================================================================================

function agent(id, label, over = {}) {
  return {
    id, label: reg(label), role: inf('reader'), unit: inf('U1'), round: unk('no round'), tag: unk('no tag'), phase: reg('P1'), state: reg('done'),
    startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(), ...over,
  };
}
function run(agents, over = {}) {
  return {
    id: 'wf_x', source: 'real', name: reg('a run'), status: { value: 'running', prov: 'inferred', method: 'no-final-file' }, startedAt: inf(Date.now()), durationMs: unk('still running'),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] },
    totals: { agents: agents.length, running: 0, done: 0, failed: 0 }, ...over,
  };
}
const summary = (r, over = {}) => ({ id: r.id, name: r.name, status: r.status, project: null, startedAt: r.startedAt, agents: r.totals.agents, running: r.totals.running, source: r.source, ...over });

const SEC_LAYOUT = { prompt: 600, result: 1500, activity: 2400 };
// the drawer has no layout in the fake browser: its sections are at fixed offsets, 200 high, in a drawer 500 high
const layout = (el) => (SEC_LAYOUT[el.attrs.get('data-sec')] === undefined ? null : { top: SEC_LAYOUT[el.attrs.get('data-sec')], height: 200 });

function world() {
  const r1 = run([agent('a1', 'reader:U1', { prompt: reg('Read the alpha file'), result: reg('alpha found') })], { id: 'wf_1', name: reg('First run') });
  const r2 = run([agent('b1', 'writer:U2', { prompt: reg('Write alpha notes'), result: reg('done') })], {
    id: 'wf_2', name: reg('Second run'), status: fin('completed'), durationMs: fin(1000), startedAt: inf(Date.now() - 5000),
  });
  const cold = { id: 'wf_cold', name: unk('not loaded'), status: reg('completed'), project: null, startedAt: inf(Date.now() - 9000), agents: 3, running: 0, source: 'real', loaded: false };
  return { r1, r2, runs: [summary(r1, { loaded: true }), summary(r2, { loaded: true }), cold], runDocs: { wf_1: r1, wf_2: r2 } };
}

// the answers of /api/search are held until a test gives them
function server() {
  const s = { calls: [] };
  s.answer = (u) => {
    if (!u.startsWith('/api/search?')) return undefined;
    return new Promise((resolve, reject) => {
      s.calls.push({
        url: u,
        q: decodeURIComponent(u.slice('/api/search?q='.length)),
        ok: (body) => resolve({ ok: true, status: 200, json: async () => structuredClone(body) }),
        fail: (status, body) => resolve({ ok: false, status, json: async () => body }),
        reject,
      });
    });
  };
  return s;
}
async function boot(over = {}) {
  const w = world();
  const s = server();
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer: s.answer, layout, ...over });
  page.el('#drawer').clientHeight = 500;
  return { page, s, ...w };
}
// a boot with a storage object of its own, to read what the page wrote
async function boot2(over = {}) {
  const storage = {};
  const b = await boot({ storage, ...over });
  return { ...b, storage };
}
const searchInits = (page) => page.inits.filter((i) => i.url.startsWith('/api/search?'));
const rowsOf = (page) => page.el('#search-list').childNodes;
const txt = (el) => el.textContent;
const timers250 = (page) => [...page.timers.timeouts.values()].filter((t) => t.ms === 250).length;
// type, let the delay pass, and let the request go out
async function ask(page, text) {
  await page.typeSearch(text);
  page.runTimeouts(250);
  await page.flush();
}
const H = (runId, agentId, field, excerpt, start, end) => ({ runId, ...(agentId === null ? {} : { agentId }), field, excerpt, start, end });

test('the page: the search box is in the header, closed at first; typing waits 250 ms (one timer) and then asks with a signal; the status says "searching..." meanwhile', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    assert.equal(page.el('#search-panel').hidden, true);
    assert.ok(input.parentNode === page.el('#search'), 'the input is in the search box'); // identity of elements is compared with ===: a failed assert.equal would print two whole fake documents
    assert.ok(input.getAttribute('aria-label'));
    await page.typeSearch('alp');
    assert.equal(s.calls.length, 0, 'nothing asked before the delay');
    assert.equal(page.el('#search-panel').hidden, false, 'the panel opens as soon as there is something to say');
    assert.equal(txt(page.el('#search-status')), SEARCH_BUSY_TEXT);
    await page.typeSearch('alph');
    await page.typeSearch('alpha');
    assert.equal(timers250(page), 1, 'one timer, the older ones cleared');
    page.runTimeouts(250);
    await page.flush();
    assert.equal(timers250(page), 0);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].url, '/api/search?q=alpha');
    const inits = searchInits(page);
    assert.equal(inits.length, 1, 'one request, one controller');
    assert.ok(inits[0].init.signal instanceof AbortSignal, 'the request carries a signal');
    assert.equal(inits[0].init.signal.aborted, false);
    assert.equal(txt(page.el('#search-status')), SEARCH_BUSY_TEXT);
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14)], more: false });
    await page.flush();
    assert.equal(rowsOf(page).length, 1);
    assert.equal(txt(page.el('#search-status')), '', 'a list says it all: the status line says nothing');
    assert.equal(page.el('#search-status').hidden, false, 'and keeps its place: it is never taken out of the panel');
  } finally {
    page.restore();
  }
});

test('the page: a row shows the run, the agent, the field and the excerpt with the match in a mark; no row is an html string', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [
        H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14), // the run on show: the agent's label
        H('wf_2', 'b1', 'result', 'an alpha result', 3, 8), // another run: the agent's id
        H('wf_1', null, 'log', 'alpha first', 0, 5),
        H('wf_zzz', null, 'description', 'alpha', 0, 5), // a run the list does not know: its id
        H('wf_1', 'a1', 'activity-summary', 'grep alpha', 5, 10),
      ],
      more: true,
    });
    await page.flush();
    const rows = rowsOf(page);
    assert.equal(rows.length, 5);
    const cells = (row) => row.childNodes[0].childNodes.map((c) => c.textContent);
    assert.deepEqual(cells(rows[0]), ['First run', 'reader:U1', 'prompt']);
    assert.deepEqual(cells(rows[1]), ['Second run', 'b1', 'result'], 'the label of an agent of another run is not known: its id');
    assert.deepEqual(cells(rows[2]).map((c, i) => (i === 1 ? '' : c)), ['First run', '', 'log line']);
    assert.equal(rows[2].childNodes[0].childNodes[1].hidden, true, 'a run field has no agent cell');
    assert.deepEqual(cells(rows[3]).filter((c) => c !== ''), ['wf_zzz', 'run description']);
    assert.deepEqual(cells(rows[4]), ['First run', 'reader:U1', 'activity: tool input']);
    const ex = (row) => row.childNodes[1];
    assert.equal(ex(rows[0]).classes.has('srch-excerpt'), true);
    assert.deepEqual(ex(rows[0]).childNodes.map((n) => n.textContent), ['Read the ', 'alpha', ' file'], 'before, the match, after');
    assert.equal(ex(rows[0]).childNodes[1].tag, 'mark');
    assert.equal(ex(rows[0]).childNodes[0].nodeType, 3);
    assert.equal(ex(rows[0]).textContent, 'Read the alpha file');
    assert.equal(rows[0].getAttribute('title'), 'wf_1', 'the run id is the tooltip');
    assert.equal(txt(page.el('#search-status')), SEARCH_MORE_TEXT);
    assert.equal(page.el('#search-status').hidden, false);
    // every row is keyboard reachable and carries none of the page's own click targets
    for (const row of rows) {
      assert.equal(row.getAttribute('tabindex'), '0');
      for (const el of allEls(page, ['#search-list'])) {
        for (const k of el.attrs.keys()) assert.equal(k.startsWith('data-'), false, `no ${k} on ${el.tag}.${el.className}: the page's click handler would take it`);
      }
    }
  } finally {
    page.restore();
  }
});

test('the page: markup in an excerpt, an agent id, a run name or a field is text: no element is made from it, no html is written, one mark per row', async () => {
  const w = world();
  w.r2.name = reg(`Second ${MARKUP}`);
  const list = [w.runs[0], summary(w.r2, { loaded: true })];
  const s = server();
  const page = await bootPage({ runs: list, runDocs: w.runDocs, hash: '#range=all', answer: s.answer, layout });
  try {
    await ask(page, 'img');
    const excerpt = `a ${MARKUP} b`;
    s.calls[0].ok({
      results: [
        H('wf_2', `b${MARKUP}`, `f${MARKUP}`, excerpt, 2, 2 + MARKUP.length), // the run's name, the agent id and the field are markup
        H('wf_1', null, 'name', excerpt, 0, 2), // an offset pair that marks half of the text
        H('wf_1', null, 'log', excerpt, 3, 999), // offsets that cannot be a match: the whole text, no mark text
      ],
      more: false,
    });
    await page.flush();
    const panel = allEls(page, ['#search-panel']);
    const all = allEls(page, ['body']);
    assert.equal(all.filter((e) => e.tag === 'img').length, 0, 'no img element in the page');
    assert.equal(all.filter((e) => e.attrs.has('onerror')).length, 0, 'no attribute made from the text');
    assert.equal(panel.reduce((n, e) => n + e.htmlWrites, 0), 0, 'nothing in the panel was written as html');
    assert.equal(panel.filter((e) => e.tag === 'mark').length, 3, 'one mark element per row');
    const rows = rowsOf(page);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].childNodes[0].childNodes.map((c) => c.textContent), [`Second ${MARKUP}`, `b${MARKUP}`, `f${MARKUP}`], 'every word of the row, as text');
    assert.equal(rows[0].childNodes[1].textContent, excerpt, 'the excerpt as it came');
    assert.equal(rows[0].childNodes[1].childNodes[1].textContent, MARKUP, 'the mark holds the matched text');
    assert.equal(rows[0].childNodes[1].childNodes[0].data, 'a ');
    assert.equal(rows[0].childNodes[1].childNodes[2].data, ' b');
    assert.equal(rows[2].childNodes[1].textContent, excerpt);
    assert.equal(rows[2].childNodes[1].childNodes[1].hidden, true, 'bad offsets mark nothing');
    assert.equal(rows[2].childNodes[1].childNodes[1].textContent, '');
    assert.equal(rows[2].childNodes[1].childNodes[0].data, excerpt);
    // the tooltip is an attribute value: the run id as text
    assert.equal(rows[0].getAttribute('title'), 'wf_2');
    // the row of an unknown-looking field: the field text as written
    assert.equal(searchFieldText(`f${MARKUP}`), `f${MARKUP}`);
  } finally {
    page.restore();
  }
});

test('the section of the page that draws a result never builds html: no innerHTML, setHtml, insertAdjacent, outerHTML, html text, createRange or write (code lines only)', () => {
  const app = readWeb('app.js');
  const from = app.indexOf('// ---------- run search ----------');
  const to = app.indexOf('// ---------- replay of a finished run ----------');
  assert.ok(from > 0 && to > from, 'the section is there, between hover and replay');
  const lines = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, ''));
  const forbidden = /innerHTML|setHtml|insertAdjacent|outerHTML|\bhtml\b|\.html\b|createRange|document\.write|DOMParser|createContextualFragment|morphHtml|esc\(/i;
  for (const l of lines(app.slice(from, to))) assert.doesNotMatch(l, forbidden, l);
  const lib = readWeb('lib.js');
  const libFrom = lib.indexOf('// search of the loaded runs');
  assert.ok(libFrom > 0);
  for (const l of lines(lib.slice(libFrom))) assert.doesNotMatch(l, forbidden, l);
  // the section keeps the page's pins: no sixth setTimeout, no second document click or keydown listener
  assert.equal((app.match(/setTimeout\(/g) || []).length, 5);
  assert.equal((app.match(/document\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((app.match(/document\.addEventListener\('keydown'/g) || []).length, 1);
  assert.equal((app.match(/\.innerHTML =/g) || []).length, 1);
  // the four listeners of the box, in the events block
  const events = app.slice(app.indexOf('// ---------- events ----------'));
  for (const l of ["$('#search-input').addEventListener('input'", "$('#search-input').addEventListener('focus'", "$('#search').addEventListener('keydown'", "$('#search-list').addEventListener('click'"]) assert.ok(events.includes(l), l);
});

test('the page: a click on a result of the run on show opens the agent\'s drawer at the field\'s section (a scrollTop write on the drawer, never scrollIntoView) and hides the panel; the text and results stay', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [
        H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14),
        H('wf_1', 'a1', 'result', 'alpha found', 0, 5),
        H('wf_1', 'a1', 'activity-text', 'checking alpha', 9, 14),
        H('wf_1', 'a1', 'activity-summary', 'grep alpha', 5, 10),
      ],
      more: false,
    });
    await page.flush();
    assert.equal(page.el('#drawer').hidden, true);
    const requests = page.requests.length;
    const drawer = page.el('#drawer');
    const expectTop = (name) => scrollToShow({ top: SEC_LAYOUT[name], height: 200, scrollTop: 0, viewHeight: 500 });
    for (const [i, name] of [[0, 'prompt'], [1, 'result'], [2, 'activity']]) {
      drawer.scrollTop = 0;
      await page.click(rowsOf(page)[i]);
      assert.equal(drawer.hidden, false, `${name}: the drawer is open`);
      assert.equal(page.el('#drawer-body').querySelector('[data-sec="title"]').textContent, 'reader:U1', 'the agent of the result');
      assert.equal(drawer.scrollTop, expectTop(name), `${name}: scrolled to its section`);
      assert.notEqual(drawer.scrollTop, 0);
      assert.equal(page.el('#search-panel').hidden, true, 'the panel gives way to the drawer');
      assert.equal(input.value, 'alpha', 'the text stays');
      assert.equal(rowsOf(page).length, 4, 'the results stay');
      await page.click(input); // a click in the box brings the results back (the focus of a real click does)
      input.dispatch('focus');
      assert.equal(page.el('#search-panel').hidden, false, 'the results are there again');
    }
    assert.equal(allEls(page, ['body']).reduce((n, e) => n + (e.scrolledIntoView ?? 0), 0), 0, 'scrollIntoView is never used: it would scroll every box above');
    assert.equal(page.requests.slice(requests).filter((u) => u.startsWith('/api/runs/wf_1') && !u.includes('/events')).length, 0, 'the run on show is not read again');
    assert.equal(s.calls.length, 1, 'a click asks nothing of the search');
  } finally {
    page.restore();
  }
});

test('the page: a click on a result of another run opens that run first (read, then its drawer); a field of a run opens the run and shows the field in the notice, no drawer; an agent the run lacks does nothing', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [
        H('wf_2', 'b1', 'prompt', 'Write alpha notes', 6, 11),
        H('wf_1', 'ghost', 'result', 'alpha', 0, 5),
        H('wf_2', null, 'name', 'alpha', 0, 5),
        H('wf_1', null, 'log', 'alpha', 0, 5),
        H('wf_gone', 'z', 'result', 'alpha', 0, 5),
      ],
      more: false,
    });
    await page.flush();
    const cur = () => page.el('#rp-cur').childNodes[0].html;
    assert.match(cur(), /^First run/);
    // a result of another run: the run is read, its drawer opens at the section
    await page.click(rowsOf(page)[0]);
    assert.ok(page.requests.includes('/api/runs/wf_2'), 'the run was read');
    assert.match(cur(), /^Second run/);
    assert.equal(page.el('#drawer').hidden, false);
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="title"]').textContent, 'writer:U2');
    assert.equal(page.el('#drawer').scrollTop, scrollToShow({ top: SEC_LAYOUT.prompt, height: 200, scrollTop: 0, viewHeight: 500 }));
    // an agent the run does not have: nothing opens, nothing breaks (the other run's drawer is closed by the run change)
    await page.click(rowsOf(page)[1]);
    assert.match(cur(), /^First run/, 'the run of the result is on show');
    assert.equal(page.el('#drawer').hidden, true, 'no agent ghost: no drawer');
    // a field of a run: the run, no drawer, and the field with its excerpt in the notice (the click is not a silent dead end)
    assert.equal(page.el('#search-hit').hidden, true, 'no notice before a run field is opened');
    await page.click(rowsOf(page)[2]);
    assert.match(cur(), /^Second run/);
    assert.equal(page.el('#drawer').hidden, true);
    assert.equal(page.el('#search-hit').hidden, false);
    assert.equal(txt(page.el('#search-hit-where')), 'run name of Second run');
    await page.click(rowsOf(page)[3]);
    assert.match(cur(), /^First run/);
    assert.equal(page.el('#drawer').hidden, true);
    assert.equal(page.el('#search-hit').hidden, false);
    assert.equal(txt(page.el('#search-hit-where')), 'log line of First run', 'the notice is the one of the last click');
    // a run the server does not know: the page says so as it does for any run it cannot read, and does not throw
    await page.click(rowsOf(page)[4]);
    assert.equal(page.el('#drawer').hidden, true);
    assert.equal(page.el('#search-hit').hidden, true, 'a run that could not be opened shows no notice of its field');
  } finally {
    page.restore();
  }
});

test('the page: an agent the run lacks leaves an open drawer as it is (no scroll of another agent\'s drawer); a run chosen meanwhile is not overridden by a slow click', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'result', 'alpha found', 0, 5), H('wf_1', 'ghost', 'result', 'alpha', 0, 5)], more: false });
    await page.flush();
    await page.click(rowsOf(page)[0]);
    const drawer = page.el('#drawer');
    assert.equal(drawer.hidden, false);
    drawer.scrollTop = 7;
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[1]);
    assert.equal(drawer.scrollTop, 7, 'the drawer of the other agent is not scrolled to a section of nothing');
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="title"]').textContent, 'reader:U1', 'and it is still that agent\'s');
  } finally {
    page.restore();
  }
  // a click on a result of wf_2, whose read is slow; the user chooses wf_1 meanwhile: wf_2 must not open its drawer over it, even for an agent id that wf_1 has too
  const w = world();
  w.r2.agents.a1 = agent('a1', 'twin:U2', { prompt: reg('twin prompt'), result: reg('twin result') });
  w.r2.order.push('a1');
  const srv = server();
  let release = null;
  const slow = new Promise((resolve) => { release = resolve; });
  const answer = (u) => {
    if (u === '/api/runs/wf_2') return slow.then(() => ({ ok: true, status: 200, json: async () => structuredClone(w.r2) }));
    return srv.answer(u);
  };
  const page2 = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer, layout });
  try {
    await ask(page2, 'alpha');
    srv.calls[0].ok({ results: [H('wf_2', 'a1', 'prompt', 'twin prompt', 0, 4)], more: false });
    await page2.flush();
    await page2.click(rowsOf(page2)[0]); // wf_2 is being read
    assert.ok(page2.requests.includes('/api/runs/wf_2'));
    await page2.click(page2.el('#rp-trigger'));
    const wf1 = page2.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === 'wf_1');
    await page2.click(wf1); // the user goes back to wf_1
    release();
    await page2.flush();
    assert.match(page2.el('#rp-cur').childNodes[0].html, /^First run/, 'wf_1 is on show');
    assert.equal(page2.el('#drawer').hidden, true, 'wf_2\'s agent did not open over it');
  } finally {
    page2.restore();
  }
});

// the Changes group of the drawer sits above Result, Prompt and Activity: one "loading..." line until the transcript is read, then one block per edit.
// The fake browser has no layout, so the test gives it one that follows the DOM: every edit block of the group is 900 px, plus whatever `extra` holds.
function growingLayout(getPage, extra) {
  const edits = () => getPage().el('#drawer-body').querySelectorAll('.diff').length;
  return (el) => (SEC_LAYOUT[el.attrs.get('data-sec')] === undefined ? null : { top: SEC_LAYOUT[el.attrs.get('data-sec')] + edits() * 900 + extra.px, height: 200 });
}
const editEntry = (n) => ({ ts: 1000 + n, tool: 'Write', inputSummary: `file${n}.txt`, input: { file_path: `/x/file${n}.txt`, content: 'line\n'.repeat(60) } });
const onScreen = (page, name) => {
  const sec = page.el('#drawer-body').querySelector(`[data-sec="${name}"]`);
  const d = page.el('#drawer');
  return sec.offsetTop >= d.scrollTop && sec.offsetTop + sec.offsetHeight <= d.scrollTop + d.clientHeight;
};

test('the page: the section a click opened is a target kept across renders: the transcript read grows the Changes group above it and the section is scrolled to again; a scroll by the user ends it', async () => {
  const w = world();
  const srv = server();
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  const answer = (u) => {
    if (u.startsWith('/api/agents/wf_1/a1/transcript')) return held.then(() => ({ ok: true, status: 200, json: async () => [editEntry(1), editEntry(2)] }));
    return srv.answer(u);
  };
  const extra = { px: 0 };
  let page = null;
  page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer, layout: growingLayout(() => page, extra) });
  page.el('#drawer').clientHeight = 500;
  try {
    await ask(page, 'alpha');
    srv.calls[0].ok({
      results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14), H('wf_1', 'a1', 'result', 'alpha found', 0, 5), H('wf_1', 'a1', 'activity-text', 'checking alpha', 9, 14)],
      more: false,
    });
    await page.flush();
    const drawer = page.el('#drawer');
    // the click: the transcript is still out, the Changes group is one line, the prompt is where the fixed layout puts it
    await page.click(rowsOf(page)[0]);
    assert.equal(page.el('#drawer-body').querySelectorAll('.diff').length, 0, 'the transcript has not been read: no edit block yet');
    assert.equal(drawer.scrollTop, scrollToShow({ top: SEC_LAYOUT.prompt, height: 200, scrollTop: 0, viewHeight: 500 }));
    assert.equal(onScreen(page, 'prompt'), true);
    // the transcript arrives: two edit blocks open above the prompt, 1800 px; the target is applied again and the prompt is on screen
    release();
    await page.flush();
    assert.equal(page.el('#drawer-body').querySelectorAll('.diff').length, 2, 'the Changes group grew');
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="prompt"]').offsetTop, SEC_LAYOUT.prompt + 1800);
    assert.equal(onScreen(page, 'prompt'), true, 'the prompt is still on screen after the transcript read moved it');
    assert.equal(drawer.scrollTop, scrollToShow({ top: SEC_LAYOUT.prompt + 1800, height: 200, scrollTop: 300, viewHeight: 500 }));
    // a later render of the same drawer (a snapshot) with more above: the target holds
    extra.px = 700;
    await page.snapshot(w.r1);
    assert.equal(onScreen(page, 'prompt'), true, 'and after a snapshot that moved it again');
    // another result of the same agent: its section is the target now
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[1]);
    assert.equal(onScreen(page, 'result'), true);
    extra.px = 1500;
    await page.snapshot(w.r1);
    assert.equal(onScreen(page, 'result'), true, 'the new target follows the layout');
    // the user scrolls the drawer: the page does not take it back
    drawer.scrollTop = 40;
    extra.px = 3000;
    await page.snapshot(w.r1);
    assert.equal(drawer.scrollTop, 40, 'a drawer the user scrolled is left where it is');
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="result"]').offsetTop > 40 + 500, true, 'the section is off screen, by the user\'s choice');
    extra.px = 0;
    await page.snapshot(w.r1);
    assert.equal(drawer.scrollTop, 40, 'and it stays so for every later render');
    // a click on a result again sets the target again
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[2]);
    assert.equal(onScreen(page, 'activity'), true);
    // closing the drawer (the page's Esc) ends the target: the agent opened again later is not taken to it
    const kept = drawer.scrollTop;
    await page.key(page.el('#log'), 'Escape');
    assert.equal(drawer.hidden, true);
    extra.px = 900;
    await page.snapshot(w.r1);
    await page.click(allEls(page, ['body']).find((e) => e.attrs.get('data-agent') === 'a1'));
    assert.equal(drawer.hidden, false);
    assert.equal(drawer.scrollTop, kept, 'a drawer opened later starts where the drawer was, not at a target of a click before it was closed');
  } finally {
    page.restore();
  }
});

test('the page: a drawer opened for another agent, or the run result\'s drawer, ends the target of a search click: nothing scrolls it later, even when the first agent is opened again', async () => {
  const w = world();
  w.r1.agents.a2 = agent('a2', 'second:U2', { unit: inf('U2'), prompt: reg('another prompt'), result: reg('another result') });
  w.r1.order.push('a2');
  w.r1.totals.agents = 2;
  const srv = server();
  const extra = { px: 0 };
  let page = null;
  page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer: srv.answer, layout: growingLayout(() => page, extra) });
  page.el('#drawer').clientHeight = 500;
  try {
    await ask(page, 'alpha');
    srv.calls[0].ok({ results: [H('wf_1', 'a1', 'result', 'alpha found', 0, 5)], more: false });
    await page.flush();
    const drawer = page.el('#drawer');
    const title = () => page.el('#drawer-body').querySelector('[data-sec="title"]').textContent;
    const cell = (id) => allEls(page, ['body']).find((e) => e.attrs.get('data-agent') === id);
    assert.ok(cell('a1') && cell('a2'), 'both agents have an element to click');
    const openFromSearch = async () => {
      await page.click(page.el('#search-input'));
      page.el('#search-input').dispatch('focus');
      await page.click(rowsOf(page)[0]);
    };
    // the other agent: opened by the page, its drawer is not scrolled to the section the first click wanted, even if that section moved
    await openFromSearch();
    assert.equal(title(), 'reader:U1');
    const at = drawer.scrollTop;
    assert.equal(at, scrollToShow({ top: SEC_LAYOUT.result, height: 200, scrollTop: 0, viewHeight: 500 }));
    extra.px = 1000;
    await page.click(cell('a2'));
    assert.equal(title(), 'second:U2');
    assert.equal(drawer.scrollTop, at, 'the other agent\'s drawer is left as it was');
    await page.click(cell('a1'));
    assert.equal(title(), 'reader:U1');
    assert.equal(drawer.scrollTop, at, 'and the first agent opened again is not taken to the old target either');
    await page.snapshot(w.r1);
    assert.equal(drawer.scrollTop, at);
    // the run result's drawer
    extra.px = 0;
    await openFromSearch();
    assert.equal(onScreen(page, 'result'), true);
    const now = drawer.scrollTop;
    const resultItem = page.doc.createElement('div'); // an item of the run result: the page's click handler opens the result's drawer for it
    resultItem.attrs.set('data-result', '');
    resultItem.parentNode = page.el('#log');
    await page.click(resultItem);
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="run-result-title"]').textContent, 'Run result');
    extra.px = 1000;
    await page.click(cell('a1'));
    assert.equal(title(), 'reader:U1');
    assert.equal(drawer.scrollTop, now, 'the drawer of the agent is not taken to a target of the click before the run result');
  } finally {
    page.restore();
  }
});

test('the page: a result of a run\'s own field (name, description, log line) shows the field of that run and its excerpt in the notice, the match in a mark; the notice is text only, replaced by the next click, and goes with its close button, Esc in the box and another run', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    const hit = page.el('#search-hit');
    assert.equal(hit.hidden, true, 'nothing opened yet');
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [
        H('wf_1', null, 'log', 'a first alpha line', 8, 13),
        H('wf_1', null, 'description', MARKUP + 'alpha', MARKUP.length, MARKUP.length + 5),
        H('wf_2', null, 'name', 'alpha', 0, 5),
        H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14),
        H('wf_1', null, 'log', 'unmarked excerpt', 99, 120), // offsets that cannot be a match: the whole excerpt, no mark
      ],
      more: false,
    });
    await page.flush();
    const notice = () => ({ where: txt(page.el('#search-hit-where')), text: txt(page.el('#search-hit-text')), marks: allEls(page, ['#search-hit-text']).filter((e) => e.tag === 'mark') });
    // a run field of the run on show: no drawer, the panel gives way, the notice says what and where
    await page.click(rowsOf(page)[0]);
    assert.equal(page.el('#drawer').hidden, true);
    assert.equal(page.el('#search-panel').hidden, true);
    assert.equal(hit.hidden, false);
    let n = notice();
    assert.equal(n.where, 'log line of First run');
    assert.equal(n.text, 'a first alpha line');
    assert.equal(n.marks.length, 1);
    assert.equal(txt(n.marks[0]), 'alpha');
    assert.equal(n.marks[0].hidden, false);
    assert.equal(input.value, 'alpha', 'the text stays');
    // markup in the excerpt is text: no element is made from it
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[1]);
    n = notice();
    assert.equal(n.where, 'run description of First run');
    assert.equal(n.text, MARKUP + 'alpha');
    assert.equal(allEls(page, ['#search-hit']).filter((e) => e.tag === 'img').length, 0, 'no img element');
    assert.equal(n.marks.length, 1, 'one mark element, made by the page');
    assert.equal(txt(n.marks[0]), 'alpha');
    assert.equal(page.el('#search-hit').textContent.includes('<img'), true, 'the markup is on screen as text');
    // another run: the run is opened first, and the notice is that of the new click
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[2]);
    assert.match(page.el('#rp-cur').childNodes[0].html, /^Second run/);
    n = notice();
    assert.equal(n.where, 'run name of Second run');
    assert.equal(n.text, 'alpha');
    // offsets that cannot be a match: the excerpt whole, the mark hidden
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[4]);
    n = notice();
    assert.equal(n.text, 'unmarked excerpt');
    assert.equal(n.marks.every((m) => m.hidden === true || txt(m) === ''), true, 'nothing is marked');
    // a result of an agent opens the drawer and leaves no notice of an earlier field
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[3]);
    assert.equal(hit.hidden, true, 'an agent result has the drawer, the notice of a run field is gone');
    assert.equal(page.el('#drawer').hidden, false);
    // the close button
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[0]);
    assert.equal(hit.hidden, false);
    await page.click(page.el('#search-hit-close'));
    assert.equal(hit.hidden, true, 'closed');
    assert.equal(input.value, 'alpha', 'the search itself is left alone');
    assert.equal(rowsOf(page).length, 5);
    // Esc in the box clears the search and with it the notice
    await page.click(input);
    input.dispatch('focus');
    await page.click(rowsOf(page)[0]);
    assert.equal(hit.hidden, false);
    await page.click(input);
    await page.key(input, 'Escape');
    assert.equal(hit.hidden, true, 'Esc cleared the notice with the search');
    assert.equal(input.value, '');
    // choosing another run in the picker ends the notice
    await ask(page, 'alpha');
    s.calls.at(-1).ok({ results: [H('wf_1', null, 'name', 'First alpha', 6, 11)], more: false });
    await page.flush();
    await page.click(rowsOf(page)[0]);
    assert.equal(hit.hidden, false);
    await page.click(page.el('#rp-trigger'));
    const wf2 = page.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === 'wf_2');
    await page.click(wf2);
    assert.match(page.el('#rp-cur').childNodes[0].html, /^Second run/);
    assert.equal(hit.hidden, true, 'a notice belongs to the run it was opened for');
    // the code of the page never builds html for it
    assert.equal(s.calls.length > 0, true);
  } finally {
    page.restore();
  }
});

test('the page: a result of a run\'s own field on the run on show closes an open drawer (an agent\'s, after a search click, or the run result\'s), so the fixed drawer (z-index 10) never covers the notice', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    const drawer = page.el('#drawer');
    const hit = page.el('#search-hit');
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [
        H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14),
        H('wf_1', null, 'description', 'a long alpha description', 7, 12),
        H('wf_1', null, 'log', 'a first alpha line', 8, 13),
      ],
      more: false,
    });
    await page.flush();
    const reopen = async () => { await page.click(input); input.dispatch('focus'); };
    // the state right after a search click on an agent: the drawer is open on the run on show
    await page.click(rowsOf(page)[0]);
    assert.equal(drawer.hidden, false, 'the agent\'s drawer is open');
    assert.equal(page.el('#search-hit').hidden, true);
    // a click on a field of that same run: the run is not read again, the drawer goes, the notice shows
    await reopen();
    await page.click(rowsOf(page)[1]);
    assert.equal(drawer.hidden, true, 'the drawer would cover the notice: it is closed');
    assert.equal(hit.hidden, false, 'the notice is shown');
    assert.equal(txt(page.el('#search-hit-where')), 'run description of First run');
    assert.equal(txt(page.el('#search-hit-text')), 'a long alpha description');
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="title"]'), null, 'nothing of the agent is left in the drawer');
    assert.equal(input.value, 'alpha', 'the text stays');
    // the same with the run result's drawer open on the run
    const resultItem = page.doc.createElement('div'); // an item of the run result: the page's click handler opens the result's drawer for it
    resultItem.attrs.set('data-result', '');
    resultItem.parentNode = page.el('#log');
    await page.click(resultItem);
    assert.equal(drawer.hidden, false);
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="run-result-title"]').textContent, 'Run result');
    await reopen();
    await page.click(rowsOf(page)[2]);
    assert.equal(drawer.hidden, true, 'the run result\'s drawer is closed too');
    assert.equal(hit.hidden, false);
    assert.equal(txt(page.el('#search-hit-where')), 'log line of First run');
    assert.equal(page.el('#drawer-body').querySelector('[data-sec="run-result-title"]'), null);
    // a click on an agent's field still opens the drawer and takes the notice away
    await reopen();
    await page.click(rowsOf(page)[0]);
    assert.equal(drawer.hidden, false);
    assert.equal(hit.hidden, true);
  } finally {
    page.restore();
  }
});

test('the page: Esc in the box clears the text, the timer, the request and the results and stops there (the drawer stays); with an empty box it is the page\'s; an input method\'s Esc is its own', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'result', 'alpha found', 0, 5)], more: false });
    await page.flush();
    await page.click(rowsOf(page)[0]); // opens the drawer
    assert.equal(page.el('#drawer').hidden, false);
    await page.click(input);
    input.dispatch('focus');
    // an input method composing: Esc is the method's
    const composing = await page.key(input, 'Escape', { isComposing: true });
    assert.equal(composing.stopped, true, 'and it does not reach the page');
    assert.equal(input.value, 'alpha');
    assert.equal(rowsOf(page).length, 1);
    assert.equal(page.el('#drawer').hidden, false);
    // a text waits for its delay: Esc drops the timer and nothing is ever asked
    const asked = s.calls.length;
    await page.typeSearch('alphab');
    assert.equal(timers250(page), 1);
    const waiting = await page.key(input, 'Escape');
    assert.equal(waiting.stopped, true);
    assert.equal(timers250(page), 0, 'the timer is gone');
    assert.equal(input.value, '');
    assert.equal(s.calls.length, asked, 'nothing was asked');
    assert.equal(page.el('#search-panel').hidden, true);
    assert.equal(page.el('#drawer').hidden, false, 'the drawer stays open');
    // a request is out: Esc aborts it and drops the results
    await ask(page, 'alphabe');
    const out = searchInits(page).at(-1).init.signal;
    assert.equal(out.aborted, false);
    s.calls.at(-1).ok({ results: [H('wf_1', null, 'name', 'shown', 0, 5)], more: false });
    await page.flush();
    assert.equal(rowsOf(page).length, 1);
    await ask(page, 'alphabex');
    const out2 = searchInits(page).at(-1).init.signal;
    assert.equal(out2.aborted, false);
    const ev = await page.key(input, 'Escape');
    assert.equal(ev.stopped, true, 'it goes no further');
    assert.equal(input.value, '', 'the text is cleared');
    assert.equal(timers250(page), 0);
    assert.equal(out2.aborted, true, 'the request is aborted');
    assert.equal(rowsOf(page).length, 0, 'the results are gone');
    assert.equal(page.el('#search-panel').hidden, true);
    assert.equal(page.el('#drawer').hidden, false, 'the drawer stays open');
    // the answer of the aborted request is not drawn
    s.calls.at(-1).ok({ results: [H('wf_1', null, 'name', 'late', 0, 4)], more: false });
    await page.flush();
    assert.equal(rowsOf(page).length, 0);
    assert.equal(page.el('#search-panel').hidden, true);
    // nothing to clear: Esc is the page's and closes the drawer
    const next = await page.key(input, 'Escape');
    assert.equal(next.stopped, false);
    assert.equal(page.el('#drawer').hidden, true, 'the page\'s Esc closed the drawer');
  } finally {
    page.restore();
  }
});

test('the page: a newer query aborts the older request and its late answer is never drawn; the results of the last query stay while a newer one waits; "no results" and a failure are different lines', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'a');
    await ask(page, 'al');
    const inits = searchInits(page);
    assert.equal(s.calls.length, 2);
    assert.equal(inits[0].init.signal.aborted, true, 'the older request is aborted');
    assert.equal(inits[1].init.signal.aborted, false);
    // the fetch ignored the signal and answered: it is not drawn
    s.calls[0].ok({ results: [H('wf_1', null, 'name', 'stale', 0, 5)], more: true });
    await page.flush();
    assert.equal(rowsOf(page).length, 0);
    assert.equal(txt(page.el('#search-status')), SEARCH_BUSY_TEXT, 'still waiting for the newer one');
    // a real fetch rejects when it is aborted: that is not a failure either
    await ask(page, 'alp');
    s.calls[1].reject(new Error('The operation was aborted.'));
    await page.flush();
    assert.equal(txt(page.el('#search-status')), SEARCH_BUSY_TEXT);
    s.calls[2].ok({ results: [H('wf_1', null, 'name', 'First alpha', 6, 11), H('wf_2', null, 'name', 'Second alpha', 7, 12)], more: false });
    await page.flush();
    assert.equal(rowsOf(page).length, 2);
    assert.equal(txt(page.el('#search-status')), '', 'the list says it all: the line says nothing');
    assert.equal(page.el('#search-status').hidden, false, 'and it keeps its place');
    // a newer text waits: the rows stay, the status says searching
    await page.typeSearch('alph');
    assert.equal(rowsOf(page).length, 2);
    assert.equal(txt(page.el('#search-status')), SEARCH_BUSY_TEXT);
    page.runTimeouts(250);
    await page.flush();
    assert.equal(rowsOf(page).length, 2, 'and while it is out');
    // nothing found
    s.calls[3].ok({ results: [], more: false });
    await page.flush();
    assert.equal(rowsOf(page).length, 0);
    assert.equal(txt(page.el('#search-status')), SEARCH_NONE_TEXT);
    // nothing found and the server says `more`: its time budget ran out before a match (the first search on a large corpus); that is not "no results"
    await ask(page, 'alphx');
    s.calls[4].ok({ results: [], more: true });
    await page.flush();
    assert.equal(rowsOf(page).length, 0);
    assert.equal(txt(page.el('#search-status')), SEARCH_CUT_TEXT, 'cut short, not "no results"');
    assert.notEqual(txt(page.el('#search-status')), SEARCH_NONE_TEXT);
    assert.equal(page.el('#search-status').hidden, false);
    assert.equal(page.el('#search-panel').hidden, false, 'the line is on show');
    // a failure says why, and is not "no results"
    await ask(page, 'alpha');
    s.calls[5].fail(503, { error: 'search is switched off' });
    await page.flush();
    assert.equal(txt(page.el('#search-status')), 'search failed: search is switched off');
    assert.equal(rowsOf(page).length, 0);
    await ask(page, 'alphab');
    s.calls[6].fail(500, null);
    await page.flush();
    assert.equal(txt(page.el('#search-status')), 'search failed: HTTP 500');
    // an empty or space-only text asks nothing and clears
    const asked = s.calls.length;
    await page.typeSearch('   ');
    assert.equal(timers250(page), 0);
    assert.equal(page.el('#search-panel').hidden, true);
    assert.equal(s.calls.length, asked);
    // the text sent is the text typed
    await ask(page, ' x y ');
    assert.equal(s.calls.at(-1).url, '/api/search?q=%20x%20y%20');
  } finally {
    page.restore();
  }
});

test('the page: the status line is one element that keeps its place whatever it says (nothing, searching, no results, more, a failure): the same node, never hidden, and no node is inserted or removed in the panel, so the first row never moves for it', async () => {
  const { page, s } = await boot();
  try {
    const status = page.el('#search-status');
    const panel = page.el('#search-panel');
    const list = page.el('#search-list');
    const kids = panel.childNodes.slice();
    assert.deepEqual(kids.map((k) => k.attrs.get('id')), ['search-status', 'search-list', 'search-note'], 'the status line is above the list, always in the panel');
    const states = [];
    // what the panel shows after each step: the status node, its place, its text, hidden or not (and the first row, while there is one)
    const look = (step) => {
      assert.ok(page.el('#search-status') === status, `${step}: the same status element`);
      assert.equal(panel.hidden, false, `${step}: the panel is open`);
      assert.equal(status.hidden, false, `${step}: the status line is never taken out of the panel`);
      assert.deepEqual(panel.childNodes.map((k) => k), kids, `${step}: nothing inserted or removed beside the list`);
      assert.ok(status.parentNode === panel && list.parentNode === panel);
      assert.equal(status.getAttribute('role'), 'status', `${step}: it stays the live region`);
      states.push([step, txt(status)]);
    };
    page.doc.mut = [];
    await page.typeSearch('alp');
    look('waiting');
    page.runTimeouts(250);
    await page.flush();
    look('loading');
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14), H('wf_2', 'b1', 'result', 'an alpha result', 3, 8)], more: false });
    await page.flush();
    look('rows, nothing to say');
    const first = rowsOf(page)[0];
    const second = rowsOf(page)[1];
    assert.equal(rowsOf(page).length, 2);
    // a newer text: "searching..." comes while the rows stay, then goes when the answer is the same list
    await page.typeSearch('alph');
    look('newer text waits');
    assert.equal(txt(status), SEARCH_BUSY_TEXT);
    assert.ok(rowsOf(page)[0] === first && rowsOf(page)[1] === second, 'the rows stay while it waits');
    page.runTimeouts(250);
    await page.flush();
    look('newer request loading');
    assert.equal(txt(status), SEARCH_BUSY_TEXT);
    assert.ok(rowsOf(page)[0] === first, 'and while it loads');
    s.calls[1].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14), H('wf_2', 'b1', 'result', 'an alpha result', 3, 8)], more: false });
    await page.flush();
    look('rows again');
    assert.equal(txt(status), '');
    assert.ok(rowsOf(page)[0] === first && rowsOf(page)[1] === second, 'the same rows, the same elements');
    // more results than shown says so in the same line
    await ask(page, 'alpha');
    look('more asks');
    s.calls[2].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14)], more: true });
    await page.flush();
    look('more');
    assert.equal(txt(status), SEARCH_MORE_TEXT);
    // no results, then a failure: the line with the longest text of all is still that element (the rows are gone: no row to move)
    await ask(page, 'zzz');
    s.calls[3].ok({ results: [], more: false });
    await page.flush();
    look('none');
    assert.equal(txt(status), SEARCH_NONE_TEXT);
    await ask(page, 'zzzz');
    s.calls[4].fail(500, { error: 'a reason that is much longer than a line of the panel can hold, so that it wraps in a narrow window: ' + 'x'.repeat(80) });
    await page.flush();
    look('failure');
    assert.match(txt(status), /^search failed: a reason that is much longer/);
    await ask(page, 'alpha');
    s.calls[5].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14)], more: false });
    await page.flush();
    look('rows after a failure');
    assert.equal(txt(status), '');
    assert.deepEqual(states.map(([step]) => step), ['waiting', 'loading', 'rows, nothing to say', 'newer text waits', 'newer request loading', 'rows again', 'more asks', 'more', 'none', 'failure', 'rows after a failure']);
    // in the whole run nothing was inserted into or removed from the panel itself, and no row element beyond the ones the lists named
    const panelMoves = page.doc.mut.filter((m) => (m.type === 'add' || m.type === 'remove') && m.parent === panel);
    assert.deepEqual(panelMoves.map((m) => [m.type, m.ser]), [], 'the panel\'s own children never change: nothing added to it, nothing removed from it');
    page.doc.mut = null;
    // the row on show was written by no status change: it is the same element, with its own text
    assert.equal(first.childNodes[1].textContent, 'Read the alpha file');
  } finally {
    page.restore();
  }
});

test('style.css: the status line of the search panel keeps the room of one line also when it says nothing, so "searching..." does not move the rows; a long text is not clipped', () => {
  const css = readWeb('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].split(',').map((x) => x.trim()), body: m[2] }));
  const mine = rules.filter((r) => r.sels.includes('.srch-status'));
  assert.ok(mine.length >= 1, 'a rule for .srch-status');
  const decl = (prop) => mine.map((r) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(r.body)?.[1].trim()).filter((v) => v !== undefined);
  // the room of one line: the line height of its text in em (it follows the font) plus the 12 px of padding (6 px above and below; border-box)
  const lh = decl('line-height');
  const minH = decl('min-height');
  assert.equal(lh.length, 1, 'the line height of the text is set once');
  assert.equal(minH.length, 1, 'one min-height');
  const lhNum = /^(\d+(?:\.\d+)?)$/.exec(lh[0])?.[1];
  assert.ok(lhNum, `a unitless line height: ${lh[0]}`);
  assert.equal(minH[0], `calc(${lhNum}em + 12px)`, 'min-height is exactly one line of that text plus the padding');
  assert.equal(decl('padding').at(-1), '6px 10px', 'the padding the 12 px are made of');
  assert.match(css, /\*\s*\{[^}]*box-sizing:\s*border-box/, 'border-box: the min-height holds the padding');
  // the text may wrap and grow: no clip, no ellipsis, no fixed height, no nowrap on the line
  for (const prop of ['height', 'max-height', 'white-space', 'text-overflow', 'overflow', 'overflow-x', 'overflow-y']) assert.deepEqual(decl(prop).filter((v) => v !== 'visible' && v !== 'normal'), [], `${prop} is not set on the status line`);
  // and the line is never hidden by the page's code
  const app = readWeb('app.js');
  assert.doesNotMatch(app, /setShown\(\$\('#search-status'\)/, 'the page never takes the status line out of the panel');
  assert.doesNotMatch(app, /\$\('#search-status'\)\.hidden/);
});

test('the page: a result of a run\'s own field hides the tracking notice (it covers the hit\'s notice in a narrow window), stores nothing, is not reopened by the notice going, and leaves the focus; a result of an agent leaves it alone', async () => {
  const HINT_KEY = 'wfviz.hint.closed';
  const hintKeys = (page) => Object.keys(page.storage).filter((k) => /hint/i.test(k));
  const { page, s, storage } = await boot2();
  try {
    const hint = page.el('#hint');
    const opener = page.el('#hint-open');
    assert.equal(hint.hidden, false, 'a fresh profile: the notice is open');
    assert.equal(opener.getAttribute('aria-expanded'), 'true');
    await ask(page, 'alpha');
    s.calls[0].ok({
      results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14), H('wf_1', null, 'name', 'First alpha', 6, 11), H('wf_2', null, 'log', 'a log alpha', 6, 11)],
      more: false,
    });
    await page.flush();
    // an agent's result leaves the notice as it is (it shows no hit notice)
    await page.click(rowsOf(page)[0]);
    assert.equal(page.el('#search-hit').hidden, true);
    assert.equal(hint.hidden, false, 'an agent-level hit does not touch the tracking notice');
    assert.deepEqual(hintKeys(page), []);
    // a result of the run's own field: the hit's notice shows and the tracking notice gives way
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[1]);
    assert.equal(page.el('#search-hit').hidden, false, 'the hit\'s notice is shown');
    assert.equal(txt(page.el('#search-hit-where')), 'run name of First run');
    assert.equal(hint.hidden, true, 'the tracking notice is hidden');
    assert.equal(opener.getAttribute('aria-expanded'), 'false', 'and its button says so');
    assert.deepEqual(hintKeys(page), [], 'it is not the user\'s own close: nothing is stored');
    assert.ok(page.doc.activeElement !== opener, 'the focus is not taken to the header button (that is what a close by the user does)');
    // the hit's notice goes: the tracking notice stays hidden (it is not opened again behind the user's back)
    await page.click(page.el('#search-hit-close'));
    assert.equal(page.el('#search-hit').hidden, true);
    assert.equal(hint.hidden, true, 'not reopened when the hit\'s notice closes');
    assert.deepEqual(hintKeys(page), []);
    // the user opens it from the header, again as before: nothing written; a click on a run field hides it again
    await page.click(opener);
    assert.equal(hint.hidden, false);
    assert.deepEqual(hintKeys(page), [], 'opening writes nothing');
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[2]);
    assert.equal(txt(page.el('#search-hit-where')), 'log line of Second run');
    assert.equal(hint.hidden, true);
    assert.deepEqual(hintKeys(page), []);
    // the user's own close is stored, once, as it always was
    await page.click(opener);
    assert.equal(hint.hidden, false);
    await page.click(page.el('#hint-close'));
    assert.equal(hint.hidden, true);
    assert.equal(storage[HINT_KEY], '1', 'the user\'s own close is remembered');
    assert.deepEqual(hintKeys(page), [HINT_KEY]);
    // with it closed by the user already, a run-level hit writes nothing and changes nothing
    // (only the notice's own key is compared: a click on a result opens a run, and the page then keeps that run as the last one, which is not the notice)
    const hintStored = () => JSON.stringify(hintKeys(page).map((k) => [k, page.storage[k]]));
    const before = hintStored();
    await page.click(page.el('#search-input'));
    page.el('#search-input').dispatch('focus');
    await page.click(rowsOf(page)[1]);
    assert.equal(page.el('#search-hit').hidden, false);
    assert.equal(hint.hidden, true);
    assert.equal(hintStored(), before, 'nothing written to the notice\'s key');
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
  } finally {
    page.restore();
  }
  // a reload after a hit hid the notice shows it open again: only the user's own close is kept
  const w = world();
  const s2 = server();
  const fresh = {};
  const p1 = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer: s2.answer, layout, storage: fresh });
  try {
    await ask(p1, 'alpha');
    s2.calls[0].ok({ results: [H('wf_1', null, 'name', 'First alpha', 6, 11)], more: false });
    await p1.flush();
    await p1.click(rowsOf(p1)[0]);
    assert.equal(p1.el('#hint').hidden, true);
    assert.deepEqual(Object.keys(fresh).filter((k) => /hint/i.test(k)), []);
  } finally {
    p1.restore();
  }
  const p2 = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer: server().answer, layout, storage: fresh });
  try {
    assert.equal(p2.el('#hint').hidden, false, 'after a reload the notice is open as on a fresh profile');
    assert.equal(p2.el('#hint-open').getAttribute('aria-expanded'), 'true');
  } finally {
    p2.restore();
  }
});

test('the page: the tracking notice gives way when the hit\'s notice is shown, not at the click: while the other run is still being read both stay as they were, then the notice shows and the tracking notice is hidden', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = world();
  const s = server();
  const answer = (u) => (u === '/api/runs/wf_2' ? gate.then(() => ({ ok: true, status: 200, json: async () => structuredClone(w.r2) })) : s.answer(u));
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', answer, layout });
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_2', null, 'name', 'Second alpha', 7, 12)], more: false });
    await page.flush();
    assert.equal(page.el('#hint').hidden, false);
    await page.click(rowsOf(page)[0]);
    assert.equal(page.el('#search-hit').hidden, true, 'the run is still being read: no notice yet');
    assert.equal(page.el('#hint').hidden, false, 'and the tracking notice is as it was');
    release();
    await page.flush();
    assert.equal(page.el('#search-hit').hidden, false);
    assert.equal(txt(page.el('#search-hit-where')), 'run name of Second run');
    assert.equal(page.el('#hint').hidden, true, 'the notice is shown: the tracking notice gives way');
    assert.equal(page.el('#hint-open').getAttribute('aria-expanded'), 'false');
  } finally {
    page.restore();
  }
});

test('the page: a result that stays keeps its row, the scroll of the list and the focus; only what changed is written; nothing is removed and added again with the same content', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'alpha');
    const a = H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14);
    const b = H('wf_1', 'a1', 'result', 'alpha found', 0, 5);
    const c = H('wf_2', 'b1', 'prompt', 'Write alpha notes', 6, 11);
    s.calls[0].ok({ results: [a, b, c], more: false });
    await page.flush();
    const [rowA, rowB, rowC] = rowsOf(page);
    const list = page.el('#search-list');
    list.scrollTop = 40;
    rowA.focus();
    const keep = (row) => ({ moves: row.moves, writes: row.writes, before: row.childNodes[1].childNodes[0].writes, after: row.childNodes[1].childNodes[2].writes });
    const aBefore = keep(rowA);
    const bBefore = keep(rowB);
    page.doc.mut = [];
    await ask(page, 'alphab');
    // a second answer: A the same, B with another excerpt, C gone, D new
    const b2 = H('wf_1', 'a1', 'result', 'alpha found twice', 0, 5);
    const d = H('wf_2', 'b1', 'result', 'done alpha', 5, 10);
    s.calls[1].ok({ results: [a, b2, d], more: false });
    await page.flush();
    const now = rowsOf(page);
    assert.equal(now.length, 3);
    assert.ok(now[0] === rowA, 'the same element for the same result');
    assert.ok(now[1] === rowB, 'and for the second');
    assert.ok(now[2] !== rowC, 'a new result is a new row');
    assert.deepEqual(keep(rowA), aBefore, 'row A: not written at all');
    assert.equal(rowB.childNodes[1].childNodes[0].writes, bBefore.before, 'B: the text before the match did not change and was not written');
    assert.equal(rowB.childNodes[1].childNodes[2].writes, bBefore.after + 1, 'B: the text after the match changed and is the only node written');
    assert.equal(rowB.childNodes[1].textContent, 'alpha found twice');
    assert.equal(list.scrollTop, 40, 'the scroll of the list is kept');
    assert.ok(page.doc.activeElement === rowA, 'the focus is kept');
    const removed = page.doc.mut.filter((m) => m.type === 'remove');
    const added = page.doc.mut.filter((m) => m.type === 'add');
    assert.ok(removed.length === 1 && removed[0].node === rowC, `only the row that went is removed (${removed.length} removals)`);
    for (const m of removed) assert.equal(added.some((x) => x.ser === m.ser), false, 'nothing removed and added again with the same content');
    assert.equal(added.filter((m) => m.parent === list).length, 1, 'one new row');
    page.doc.mut = null;
  } finally {
    page.restore();
  }
});

test('the page: the line about runs that are only listed shows while the list has some, with the count, and goes when it has none', async () => {
  const { page, s, runs } = await boot();
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [], more: false });
    await page.flush();
    const note = page.el('#search-note');
    assert.equal(note.hidden, false);
    assert.match(txt(note), /^1 run is not loaded and not searched/);
    assert.equal(txt(page.el('#search-status')), SEARCH_NONE_TEXT, 'and the answer says no results');
    // a list with no such run: no line
    const w = world();
    const page2 = await bootPage({ runs: [w.runs[0]], runDocs: w.runDocs, hash: '#range=all', answer: s.answer, layout });
    try {
      await ask(page2, 'alpha');
      s.calls.at(-1).ok({ results: [], more: false });
      await page2.flush();
      assert.equal(page2.el('#search-note').hidden, true);
      assert.equal(txt(page2.el('#search-note')), '');
    } finally {
      page2.restore();
    }
    assert.equal(runs.length, 3);
  } finally {
    page.restore();
  }
});

test('the page: the query is not kept (not in the address, not in storage, not in the picker\'s own search), and a run snapshot does not ask again', async () => {
  const storage = {};
  const { page, s, r1 } = await boot({ storage });
  try {
    const before = { hash: globalThis.location.hash, storage: JSON.stringify(storage), picker: page.el('#rp-search').value };
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'prompt', 'Read the alpha file', 9, 14)], more: false });
    await page.flush();
    assert.equal(globalThis.location.hash, before.hash, 'the hash is not touched');
    assert.equal(JSON.stringify(storage), before.storage, 'nothing is stored');
    assert.equal(page.el('#rp-search').value, before.picker, 'the picker\'s search field is not the box');
    assert.doesNotMatch(globalThis.location.hash, /alpha/);
    const asked = s.calls.length;
    const writes = allEls(page, ['#search-panel']).reduce((n, e) => n + e.writes, 0);
    await page.snapshot({ ...r1, counter: 2 });
    await page.snapshot({ ...r1, counter: 3 });
    assert.equal(s.calls.length, asked, 'a snapshot asks nothing');
    assert.equal(timers250(page), 0);
    assert.equal(allEls(page, ['#search-panel']).reduce((n, e) => n + e.writes, 0), writes, 'and the results are not rewritten');
    assert.equal(page.el('#search-input').value, 'alpha', 'the text is never written back while the user types');
  } finally {
    page.restore();
  }
});

test('the page: a click outside the box closes the panel (the text and the results stay), a click in the box or on the panel does not; opening the picker leaves only one of them open', async () => {
  const { page, s } = await boot();
  try {
    const input = page.el('#search-input');
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_1', null, 'name', 'First alpha', 6, 11)], more: false });
    await page.flush();
    const panel = page.el('#search-panel');
    assert.equal(panel.hidden, false);
    await page.click(input);
    await page.click(page.el('#search-status'));
    assert.equal(panel.hidden, false, 'a click in the box and in the panel does not close it');
    await page.click(page.el('#log'));
    assert.equal(panel.hidden, true, 'a click outside');
    assert.equal(input.value, 'alpha');
    assert.equal(rowsOf(page).length, 1);
    // focus again: the last results come back
    input.dispatch('focus');
    assert.equal(panel.hidden, false);
    // the run picker opens by a click on its button: that click is outside the search box
    await page.click(page.el('#rp-trigger'));
    assert.equal(page.el('#rp-panel').hidden, false);
    assert.equal(panel.hidden, true, 'the search panel is not open together with the picker');
    // typing in the box with the picker open: the click that put the focus there closed the picker
    await page.click(input);
    assert.equal(page.el('#rp-panel').hidden, true);
    // with nothing typed the box has nothing to show
    input.value = '';
    input.dispatch('input');
    await page.flush();
    input.dispatch('focus');
    assert.equal(panel.hidden, true);
  } finally {
    page.restore();
  }
});

test('the page: Enter or Space on a focused row opens it as a click does', async () => {
  const { page, s } = await boot();
  try {
    await ask(page, 'alpha');
    s.calls[0].ok({ results: [H('wf_1', 'a1', 'result', 'alpha found', 0, 5)], more: false });
    await page.flush();
    const row = rowsOf(page)[0];
    const ev = await page.key(row, 'Enter');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(page.el('#drawer').hidden, false);
    assert.equal(page.el('#drawer').scrollTop, scrollToShow({ top: SEC_LAYOUT.result, height: 200, scrollTop: 0, viewHeight: 500 }));
    // another key is not an open
    page.el('#drawer-close').onclick();
    assert.equal(page.el('#drawer').hidden, true);
    await page.key(row, 'a');
    await page.key(row, 'Tab');
    assert.equal(page.el('#drawer').hidden, true);
    await page.key(row, ' ');
    assert.equal(page.el('#drawer').hidden, false);
  } finally {
    page.restore();
  }
});
