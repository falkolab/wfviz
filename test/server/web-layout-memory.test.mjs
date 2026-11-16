// Tests of what the page remembers and how wide it starts (web/lib.js and web/app.js, web/index.html, web/style.css): the default width of the two side
// columns (a pure function of the grid width), the stored state (the last run, the run filters, the matrix rows, the tests card and the weak-edges
// switch of each run, at most 50 runs), and "Reset layout". The pure parts are called directly with good and bad values; the page runs on the fake
// browser of fake-page.mjs, which boots app.js itself, so what is checked is the code the browser runs. Where only a real browser can say (the first
// paint, the header with the new button at 375, 800 and 1228 px) the rules are read here and the placement is measured by the node's own check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CENTER_MIN, HANDLE_WIDTH, LAYOUT_DEFAULTS, RESET_CONFIRM_TEXT, RUN_MEMORY_MAX, RUN_MEMORY_UNITS_MAX, STORED_FILTER_MAX, STORED_ID_MAX, STORED_KEYS,
  clampLayout, defaultColumns, defaultPickerFilter, dragLayout, formatPickerHash, initialFilter, parseLastRun, parseRunMemory, parseStoredSize, runMemoryOf, updateRunMemory,
  wantedAfterDrag,
} from '../../web/lib.js';
import { bootPage } from './fake-page.mjs';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWeb = (f) => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');
// the narrowest a column can be (web-u3.test.mjs pins the same 160)
const COLUMN_MIN = 160;

// =====================================================================================================================
// the default width of the side columns
// =====================================================================================================================

// The width given is the grid's inner width (what viewport() in app.js gives), so a window of 1440 px is a width of 1412 here; the function is tested
// at the numbers of the spec as widths. The rule: the two columns are 480 and 600 px, but the middle column (the grid's middle track, the two 8 px
// handles not part of it) keeps half of the width: below a width of 2 * (480 + 600 + 2 * 8) = 2192 both shrink together, in the ratio of 4:5.
const THRESHOLD = 2 * (LAYOUT_DEFAULTS.left + LAYOUT_DEFAULTS.right + 2 * HANDLE_WIDTH);
const centreOf = (w, c) => w - c.left - c.right - 2 * HANDLE_WIDTH;

test('defaults: the side columns of today are twice the first ones, 480 and 600 px (4:5), and the log keeps its 190', () => {
  assert.deepEqual(LAYOUT_DEFAULTS, { left: 480, right: 600, log: 190 });
  assert.equal(5 * LAYOUT_DEFAULTS.left, 4 * LAYOUT_DEFAULTS.right, 'a ratio of 4:5');
  assert.equal(THRESHOLD, 2192);
});

test('defaultColumns: at 1440, 1920 and 2560 px the numbers are those of the rule (the first two shrink, the third is the full 480 and 600)', () => {
  assert.deepEqual(defaultColumns(1440), { left: 312, right: 391 });
  assert.deepEqual(defaultColumns(1920), { left: 419, right: 524 });
  assert.deepEqual(defaultColumns(2560), { left: 480, right: 600 });
  assert.deepEqual(defaultColumns(4000), { left: 480, right: 600 }, 'a wider window gives the columns no more');
});

test('defaultColumns: the rule binds exactly below 2192 px: one pixel under, at, and one over', () => {
  assert.deepEqual(defaultColumns(THRESHOLD + 1), { left: 480, right: 600 });
  assert.deepEqual(defaultColumns(THRESHOLD), { left: 480, right: 600 }, 'at the width the full columns still leave half');
  const under = defaultColumns(THRESHOLD - 1);
  assert.deepEqual(under, { left: 479, right: 599 }, 'one pixel under: both give way, whole pixels, rounded down');
  assert.ok(centreOf(THRESHOLD - 1, under) >= (THRESHOLD - 1) / 2, 'and the centre still keeps half');
});

test('defaultColumns: where the rule binds the centre keeps at least half of the width and the columns keep 4:5 (checked at every width from 400 to 2191)', () => {
  for (let w = 400; w < THRESHOLD; w++) {
    const c = defaultColumns(w);
    assert.ok(Number.isInteger(c.left) && Number.isInteger(c.right), `whole pixels at ${w}`);
    assert.ok(centreOf(w, c) >= w / 2, `the centre is at least half at ${w}: ${centreOf(w, c)}`);
    assert.ok(Math.abs(5 * c.left - 4 * c.right) <= 5, `4:5 at ${w}: ${c.left} / ${c.right}`);
    assert.ok(c.left <= 480 && c.right <= 600, `never wider than the wide default at ${w}`);
    assert.ok(c.right >= c.left, `the right column is the wider one at ${w}`);
  }
  // not narrower than it needs to be: one more pixel for either column would take the centre under half
  for (const w of [1000, 1440, 1920, 2100, 2191]) {
    const c = defaultColumns(w);
    assert.ok(centreOf(w, { left: c.left + 1, right: c.right + 1 }) < w / 2 + 2, `at ${w} the columns are as wide as the rule allows (within a pixel each)`);
  }
});

test('defaultColumns: a width that is not a positive number gives 0 and 0 and never throws; clampLayout then holds each column to its minimum', () => {
  for (const bad of [0, -1, -1000, NaN, Infinity, -Infinity, undefined, null, 'x', '1440', {}, []]) {
    assert.deepEqual(defaultColumns(bad), { left: 0, right: 0 }, String(bad));
  }
  assert.deepEqual(defaultColumns(), { left: 0, right: 0 });
  // a very small width: no negative width
  for (const w of [1, 15, 16, 17, 32, 100]) {
    const c = defaultColumns(w);
    assert.ok(c.left >= 0 && c.right >= 0, `no negative column at ${w}`);
  }
  for (const bad of [0, NaN, undefined]) {
    const c = clampLayout({}, { width: bad, height: 800 });
    assert.deepEqual([c.left, c.right], [COLUMN_MIN, COLUMN_MIN], `a window with no size gives the minimums (${bad})`);
  }
});

test('clampLayout: only a missing side takes the width-dependent default; a stored or dragged side wins, and the existing limits still clamp it', () => {
  const vp = { width: 1440, height: 800 };
  const at = defaultColumns(1440);
  assert.deepEqual(clampLayout({}, vp), { left: at.left, right: at.right, log: 190 }, 'nothing stored: the width-dependent default');
  assert.deepEqual(clampLayout({ left: 300 }, vp), { left: 300, right: at.right, log: 190 }, 'a stored left wins, the right follows the window');
  // the stored sizes here fit beside the other side (the two together stay within half of the width minus the handles, 704 at 1440)
  assert.deepEqual(clampLayout({ right: 380 }, vp), { left: at.left, right: 380, log: 190 }, 'a stored right wins, the left follows the window');
  assert.deepEqual(clampLayout({ left: 300, right: 380 }, vp), { left: 300, right: 380, log: 190 });
  // a stored size that does not fit beside the other is shrunk with it (the next tests cover the rule): 450 beside the default 312 is over 704
  assert.deepEqual(clampLayout({ right: 450 }, vp), { left: 288, right: 415, log: 190 }, 'a stored right that is over the bound shares it with the default left');
  assert.deepEqual(clampLayout({ left: 300, right: 450 }, vp), { left: 281, right: 422, log: 190 }, 'two stored sizes over the bound shrink together');
  const wide = clampLayout({ left: 480, right: 600 }, vp);
  assert.equal(wide.left + wide.right <= 704, true, 'the stored wide pair leaves the centre half of the width');
  assert.equal(clampLayout({ left: 50 }, vp).left, COLUMN_MIN, 'a stored width under the minimum is clamped to it');
  assert.equal(clampLayout({ left: 99999 }, vp).left <= 704 - COLUMN_MIN, true, 'and one over the bound to the bound less the other column\'s minimum');
  // a window wide enough: the stored 300 still wins over the 480 the default would be
  assert.equal(clampLayout({ left: 300 }, { width: 2560, height: 800 }).left, 300);
  assert.deepEqual(clampLayout({}, { width: 2560, height: 800 }), { left: 480, right: 600, log: 190 });
});

// =====================================================================================================================
// what is stored: parse with bad values
// =====================================================================================================================

test('stored sizes: anything that is not a positive finite number is no size (abc, -5, NaN, {, empty, 0, Infinity)', () => {
  for (const bad of ['abc', '-5', 'NaN', '{', '', '0', 'Infinity', '-Infinity', '1e999', null, undefined, 5, {}, [], 'null', '[1]']) {
    assert.equal(parseStoredSize(bad), null, String(bad));
  }
  assert.equal(parseStoredSize('300'), 300);
  assert.equal(parseStoredSize('300.5'), 300.5);
});

test('stored last run: a text of 1 to 200 characters is the id; anything else is none', () => {
  assert.equal(parseLastRun('wf_2'), 'wf_2');
  assert.equal(parseLastRun('x'.repeat(STORED_ID_MAX)), 'x'.repeat(STORED_ID_MAX));
  for (const bad of [null, undefined, '', 'x'.repeat(STORED_ID_MAX + 1), 5, {}, [], ['wf_1'], true]) assert.equal(parseLastRun(bad), null, String(bad));
});

test('stored run memory: bad text, a wrong shape and bad entries give nothing (or only the good entries), never a throw', () => {
  for (const bad of [null, undefined, '', 'abc', '{', '{}', 'null', '5', '"x"', 'true', '[1]', '[null]', '[[]]', '[[1,{}]]', '[["",{"tests":true}]]', '{"wf_1":{"tests":true}}']) {
    assert.deepEqual(parseRunMemory(bad), [], String(bad));
  }
  // a good entry between bad ones survives; extra fields are dropped; a flag is a flag only when it is the boolean true; an entry equal to the
  // default has no place
  const text = JSON.stringify([
    7,
    ['wf_a', { expanded: 'U1', tests: 'true', weak: 1, extra: 'x' }],
    ['wf_b', { expanded: 'U1', tests: true, weak: true }],
    ['wf_c', 'bad'],
    ['wf_d', null],
    [5, { tests: true }],
    ['wf_e', { expanded: [], tests: false, weak: false }],
  ]);
  assert.deepEqual(parseRunMemory(text), [['wf_b', { expanded: [], tests: true, weak: true }]], 'only wf_b holds anything that counts');
  assert.deepEqual(parseRunMemory(JSON.stringify([['wf_a', { expanded: ['U1', 7, 'U1', 'U2'], tests: 'true', weak: 1, extra: 'x' }]])),
    [['wf_a', { expanded: ['U1', 'U2'], tests: false, weak: false }]], 'a row opened is a state of its own: the entry stays, the bad parts are dropped');
});

test('stored run memory: a unit name over 200 characters is dropped, at most 100 rows are kept, an id over 200 characters drops the entry', () => {
  const long = 'u'.repeat(STORED_ID_MAX + 1);
  const many = Array.from({ length: RUN_MEMORY_UNITS_MAX + 20 }, (_, i) => `U${i}`);
  const [[, m]] = parseRunMemory(JSON.stringify([['wf_a', { expanded: [long, ...many] }]]));
  assert.equal(m.expanded.length, RUN_MEMORY_UNITS_MAX);
  assert.equal(m.expanded.includes(long), false);
  assert.deepEqual(m.expanded.slice(0, 2), ['U0', 'U1']);
  assert.deepEqual(parseRunMemory(JSON.stringify([['i'.repeat(STORED_ID_MAX + 1), { tests: true }]])), []);
});

test('stored run memory: an id such as __proto__, constructor or toString is an id like any other (an array of entries, never an object keyed by id)', () => {
  let entries = [];
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) entries = updateRunMemory(entries, id, { tests: true });
  assert.deepEqual(entries.map(([k]) => k), ['__proto__', 'constructor', 'toString', 'hasOwnProperty']);
  const back = parseRunMemory(JSON.stringify(entries));
  assert.deepEqual(back.map(([k]) => k), ['__proto__', 'constructor', 'toString', 'hasOwnProperty']);
  assert.equal(runMemoryOf(back, '__proto__').tests, true);
  assert.equal(runMemoryOf(back, 'other').tests, false);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(runMemoryOf([], '__proto__'), { expanded: [], tests: false, weak: false });
});

test('run memory: the default state for a run with no entry; a state is a fresh object each time', () => {
  const a = runMemoryOf([], 'wf_1');
  assert.deepEqual(a, { expanded: [], tests: false, weak: false });
  a.expanded.push('U1');
  assert.deepEqual(runMemoryOf([], 'wf_1'), { expanded: [], tests: false, weak: false });
  const entries = updateRunMemory([], 'wf_1', { expanded: ['U1'] });
  runMemoryOf(entries, 'wf_1').expanded.push('U2');
  assert.deepEqual(runMemoryOf(entries, 'wf_1').expanded, ['U1'], 'what was read cannot change what is kept');
});

// =====================================================================================================================
// the run filters from storage
// =====================================================================================================================

test('initialFilter: with no hash the stored text is the filter and the caller is told to write it to the address', () => {
  const stored = '#status=failed&project=demo';
  assert.deepEqual(initialFilter('', stored), { filter: { ...defaultPickerFilter(), status: 'failed', project: 'demo' }, fromStorage: true });
  assert.deepEqual(initialFilter('#', stored).filter, { ...defaultPickerFilter(), status: 'failed', project: 'demo' }, 'a bare # is no hash');
  assert.equal(initialFilter(undefined, stored).fromStorage, true);
  assert.equal(initialFilter(null, stored).fromStorage, true);
  assert.deepEqual(initialFilter('', ''), { filter: defaultPickerFilter(), fromStorage: true }, 'a stored empty text is "every filter is the default" (clearing is remembered)');
});

test('initialFilter: any hash wins whole, no key is taken from the stored text', () => {
  const stored = '#range=all&project=demo&status=failed&from=2026-11-01&to=2026-11-10&q=abc';
  const got = initialFilter('#status=completed', stored);
  assert.deepEqual(got, { filter: { ...defaultPickerFilter(), status: 'completed' }, fromStorage: false });
  assert.deepEqual(initialFilter('#q=zz', stored).filter, { ...defaultPickerFilter(), q: 'zz' }, 'the stored range, project, status and dates are not merged in');
  assert.deepEqual(initialFilter('#range=all', stored).filter, { ...defaultPickerFilter(), range: 'all' });
  // a hash of a key the picker does not know is still a hash: the filters are the default, the stored ones do not come back
  assert.deepEqual(initialFilter('#other=1', stored), { filter: defaultPickerFilter(), fromStorage: false });
});

test('initialFilter: a stored value that is not a text of a sane length is no value; text that does not parse is the default', () => {
  for (const bad of [null, undefined, 5, {}, [], true, '#'.padEnd(STORED_FILTER_MAX + 1, 'a')]) {
    assert.deepEqual(initialFilter('', bad), { filter: defaultPickerFilter(), fromStorage: false }, String(bad).slice(0, 20));
  }
  assert.deepEqual(initialFilter('', 'nonsense&&=&range=weird&from=2026-02-30').filter, defaultPickerFilter());
  assert.deepEqual(initialFilter('', '#range=all&from=2026-13-01').filter, { ...defaultPickerFilter(), range: 'all' }, 'a bad date is the default, the rest stays');
});

test('initialFilter: what formatPickerHash gives is read back whole (the stored text is the hash text, no second format)', () => {
  const f = { range: 'all', project: 'my proj', status: 'failed', from: '2026-11-01', to: '2026-11-10', q: 'a&b=c #1' };
  assert.deepEqual(initialFilter('', formatPickerHash(f)).filter, f);
});

// =====================================================================================================================
// the per-run memory is capped at 50 runs
// =====================================================================================================================

test('run memory: at most 50 runs, the oldest dropped; the run changed last is the newest', () => {
  assert.equal(RUN_MEMORY_MAX, 50);
  let entries = [];
  for (let i = 0; i < 60; i++) entries = updateRunMemory(entries, `wf_${i}`, { tests: true });
  assert.equal(entries.length, 50);
  assert.equal(entries[0][0], 'wf_10', 'the ten oldest are gone');
  assert.equal(entries.at(-1)[0], 'wf_59');
  assert.equal(runMemoryOf(entries, 'wf_9').tests, false, 'a dropped run has the default');
  assert.equal(runMemoryOf(entries, 'wf_10').tests, true);
  // a run changed again moves to the end, so it is not the one dropped next
  entries = updateRunMemory(entries, 'wf_10', { weak: true });
  assert.equal(entries.at(-1)[0], 'wf_10');
  assert.deepEqual(runMemoryOf(entries, 'wf_10'), { expanded: [], tests: true, weak: true });
  entries = updateRunMemory(entries, 'wf_new', { tests: true });
  assert.equal(entries.length, 50);
  assert.equal(entries.some(([k]) => k === 'wf_11'), false, 'the oldest now is wf_11');
  assert.equal(entries.some(([k]) => k === 'wf_10'), true, 'wf_10 stayed');
  // the input is never changed
  const before = JSON.stringify(entries);
  updateRunMemory(entries, 'wf_other', { tests: true });
  assert.equal(JSON.stringify(entries), before);
});

test('run memory: a stored text of 60 runs is cut to the newest 50 on read', () => {
  const text = JSON.stringify(Array.from({ length: 60 }, (_, i) => [`wf_${i}`, { expanded: [], tests: true, weak: false }]));
  const got = parseRunMemory(text);
  assert.equal(got.length, 50);
  assert.deepEqual([got[0][0], got.at(-1)[0]], ['wf_10', 'wf_59']);
});

test('run memory: a state equal to the default removes the entry, so a run that holds nothing takes no place', () => {
  let entries = updateRunMemory([], 'wf_a', { expanded: ['U1', 'U2'], tests: true });
  entries = updateRunMemory(entries, 'wf_b', { weak: true });
  entries = updateRunMemory(entries, 'wf_a', { expanded: ['U2'] });
  assert.deepEqual(runMemoryOf(entries, 'wf_a'), { expanded: ['U2'], tests: true, weak: false });
  entries = updateRunMemory(entries, 'wf_a', { expanded: [], tests: false });
  assert.deepEqual(entries.map(([k]) => k), ['wf_b'], 'wf_a is the default again: no entry');
  assert.deepEqual(updateRunMemory([], 'wf_x', { tests: false }), [], 'a change to the default of a run with no entry writes nothing');
  assert.deepEqual(updateRunMemory([], '', { tests: true }), [], 'an id that is not a sane text changes nothing');
  assert.deepEqual(updateRunMemory([], 'x'.repeat(STORED_ID_MAX + 1), { tests: true }), []);
  assert.deepEqual(updateRunMemory(null, 'wf_x', { tests: true }).map(([k]) => k), ['wf_x'], 'bad entries are no entries');
  assert.deepEqual(updateRunMemory([['wf_a', { tests: true }]], 'wf_a', null).map(([k]) => k), ['wf_a'], 'a bad patch changes nothing');
});

// =====================================================================================================================
// the list of keys and what app.js stores
// =====================================================================================================================

test('STORED_KEYS: a fixed list of the keys the page stores; app.js stores no key that is not in it, and no key but hint.closed has "hint" in it', () => {
  assert.deepEqual([...STORED_KEYS].sort(), ['filters', 'hint.closed', 'lastRun', 'layout.left', 'layout.log', 'layout.right', 'logCollapsed', 'replay.speed', 'runState', 'view']);
  assert.equal(new Set(STORED_KEYS).size, STORED_KEYS.length, 'no key twice');
  const app = readWeb('app.js');
  const used = new Set();
  for (const m of app.matchAll(/local(?:Get|Set|Remove)\('([^']+)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/\{ prop: '--[a-z-]+', key: '([^']+)' \}/g)) used.add(m[1]); // the SIZES table: { prop, key }
  assert.ok(used.size >= 8, `app.js uses keys (${[...used]})`);
  for (const k of used) assert.ok(STORED_KEYS.includes(k), `app.js stores "${k}": it needs a place in STORED_KEYS (else Reset layout leaves it)`);
  for (const k of STORED_KEYS) assert.ok(used.has(k), `STORED_KEYS has "${k}" that app.js does not use`);
  for (const k of STORED_KEYS) assert.equal(/hint/i.test(k), k === 'hint.closed', k);
  assert.doesNotMatch(app, /localStorage\.(clear|key|length)|localStorage\[/, 'the page never clears or walks the whole storage, only its own keys');
});

// =====================================================================================================================
// the page
// =====================================================================================================================

const reg = (value, from = 'f:1') => ({ value, prov: 'registered', from });
const inf = (value, method = 'label-pattern') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });

function agent(id, label, over = {}) {
  const m = /^([^:#]+):([^#]+)$/.exec(label);
  return {
    id, label: reg(label), role: inf(m[1]), unit: inf(m[2]), round: unk('no round'), tag: unk('no tag'), phase: reg('P1'), state: reg('done'),
    startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(), ...over,
  };
}
function runOf(id, labels, over = {}) {
  const agents = labels.map((l, i) => agent(`${id}-a${i + 1}`, l));
  return {
    id, source: 'real', name: reg(`run ${id}`), status: fin('completed'), startedAt: inf(Date.now() - 60_000), durationMs: fin(5000),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] },
    totals: { agents: agents.length, running: 0, done: agents.length, failed: 0 }, ...over,
  };
}
const summary = (r, over = {}) => ({ id: r.id, name: r.name, status: r.status, project: null, startedAt: r.startedAt, agents: r.totals.agents, running: r.totals.running, source: r.source, loaded: true, ...over });
// ten summaries of one agent: more than the tests card shows at first (eight), so it has its "show all" button
const manyTests = (agentId) => Array.from({ length: 10 }, (_, i) => ({ scope: 'agent', agentId, path: `result.tests.${i}`, passed: i + 1, failed: 0, skipped: 0, method: 'test' }));

function world() {
  const a = runOf('wf_a', ['w:U1', 'w:U2'], { name: reg('First run') });
  a.recognized.tests = manyTests('wf_a-a1');
  const b = runOf('wf_b', ['w:V1', 'w:V2'], { name: reg('Second run') });
  b.recognized.tests = manyTests('wf_b-a1');
  const failed = runOf('wf_f', ['w:F1'], { name: reg('Failing run'), status: fin('failed') });
  const cold = { id: 'wf_cold', name: unk('not loaded'), status: reg('completed'), project: null, startedAt: inf(Date.now() - 90_000), agents: 3, running: 0, source: 'real', loaded: false };
  const all = [a, b, failed];
  return { a, b, failed, runs: [...all.map((r) => summary(r)), cold], runDocs: Object.fromEntries(all.map((r) => [r.id, r])) };
}
// a page on the world; `storage` is the object a later page can be started on (a reload)
async function boot(over = {}) {
  const w = world();
  const storage = over.storage ?? {};
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '', ...over, storage });
  return { page, storage, ...w };
}
const withPage = (fn, over) => async () => {
  const b = await boot(over);
  try { await fn(b); } finally { b.page.restore(); }
};
const K = (name) => `wfviz.${name}`;
const css = (page, name) => page.root.props.get(name);
const px = (page, name) => Number.parseFloat(css(page, name));
const shownRun = (page) => page.requests.filter((u) => /^\/api\/runs\/[^/?]+$/.test(u)).map((u) => u.slice('/api/runs/'.length));
const rowToggles = (page) => page.doc.querySelectorAll('.hist-toggle');
const toggleOf = (page, unit) => rowToggles(page).find((t) => t.attrs.get('data-unit') === unit);
const opened = (page) => rowToggles(page).filter((t) => t.attrs.get('aria-expanded') === 'true').map((t) => t.attrs.get('data-unit'));
const testsButton = (page) => page.doc.querySelector('[data-tests-toggle]');
// the rows of the run picker (they are patched while it is open): the ids listed, and a click on a run's row
const openPicker = async (page) => { if (page.el('#rp-panel').hidden) await page.click(page.el('#rp-trigger')); };
const listedRuns = async (page) => { await openPicker(page); return page.el('#rp-list').childNodes.map((r) => r.attrs.get('data-run')); };
const chooseRun = async (page, id) => {
  await openPicker(page);
  const row = page.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === id);
  assert.ok(row, `the picker has a row for ${id}`);
  await page.click(row);
};

// ---- the default width on the page ----------------------------------------------------------------------------------------------

test('page: the side columns start at the default width of the window (the grid width, not the window\'s)', async () => {
  for (const [width, grid] of [[1228, 1200], [1468, 1440], [1948, 1920], [2588, 2560], [3000, 2972]]) {
    const { page } = await boot({ width });
    try {
      const want = defaultColumns(grid);
      assert.deepEqual([px(page, '--left-w'), px(page, '--right-w')], [want.left, want.right], `a grid of ${grid}`);
      assert.equal(css(page, '--left-w'), `${want.left}px`);
      assert.equal(css(page, '--log-h'), '190px');
    } finally { page.restore(); }
  }
  const { page } = await boot({ width: 2588 });
  try {
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['480px', '600px'], 'the full twice-as-wide default in a wide window');
  } finally { page.restore(); }
});

test('page: a stored width wins over the default, is clamped by the existing limits, and the side that is not stored follows the window', async () => {
  const { page } = await boot({ width: 1468, storage: { [K('layout.left')]: '300' } });
  try {
    assert.equal(css(page, '--left-w'), '300px');
    assert.equal(css(page, '--right-w'), `${defaultColumns(1440).right}px`);
  } finally { page.restore(); }
  const small = await boot({ width: 1468, storage: { [K('layout.left')]: '20', [K('layout.right')]: '99999' } });
  try {
    const want = clampLayout({ left: 20, right: 99999 }, { width: 1440, height: 800 });
    assert.equal(css(small.page, '--left-w'), `${want.left}px`);
    assert.equal(want.left, COLUMN_MIN, 'a stored width under the minimum is clamped to it');
    assert.equal(css(small.page, '--right-w'), `${want.right}px`);
    assert.equal(want.right, 704 - COLUMN_MIN, 'and one over the bound to the bound (half of the width less the handles, 704) less the other column\'s minimum');
  } finally { small.page.restore(); }
});

test('page: a stored width that is not a number is the default (abc, -5, NaN, {, empty), and the page loads without an error', async () => {
  for (const bad of ['abc', '-5', 'NaN', '{', '', '0', 'Infinity', 'null']) {
    const { page } = await boot({ width: 1468, storage: { [K('layout.left')]: bad, [K('layout.right')]: bad, [K('layout.log')]: bad } });
    try {
      const want = defaultColumns(1440);
      assert.deepEqual([css(page, '--left-w'), css(page, '--right-w'), css(page, '--log-h')], [`${want.left}px`, `${want.right}px`, '190px'], JSON.stringify(bad));
    } finally { page.restore(); }
  }
});

test('page: a resize recomputes the default width from the new window, writes only the two CSS variables and rewrites no node of the page', withPage(async ({ page }) => {
  const grid = page.el('.grid');
  assert.deepEqual([px(page, '--left-w'), px(page, '--right-w')], [defaultColumns(1200).left, defaultColumns(1200).right]);
  assert.equal(page.windowListeners.resize.length, 1, 'the one resize listener of the page; no second one was added');
  const before = page.doc.mut;
  page.doc.mut = [];
  let rafs = 0;
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => { rafs++; return 0; };
  try {
    for (const w of [2588, 1468, 1228]) {
      grid.clientWidth = w;
      for (const fn of page.windowListeners.resize) fn();
      const want = defaultColumns(w - 28);
      assert.deepEqual([px(page, '--left-w'), px(page, '--right-w')], [want.left, want.right], `window ${w}`);
    }
  } finally {
    globalThis.requestAnimationFrame = raf;
  }
  assert.deepEqual(page.doc.mut, [], 'no node was added, removed or moved by the resizes');
  assert.ok(rafs <= 3, 'at most one frame request per resize (the edges of the timeline, only when it is on show)');
  page.doc.mut = before;
}, { width: 1228 }));

test('page: a resize keeps a stored width and moves the other side with the window', withPage(async ({ page }) => {
  const grid = page.el('.grid');
  assert.equal(css(page, '--left-w'), '250px');
  for (const w of [2588, 1468]) {
    grid.clientWidth = w;
    for (const fn of page.windowListeners.resize) fn();
    assert.equal(css(page, '--left-w'), '250px', `window ${w}`);
    assert.equal(css(page, '--right-w'), `${defaultColumns(w - 28).right}px`, `window ${w}`);
  }
}, { width: 1228, storage: { [K('layout.left')]: '250' } }));

test('page: a drag stores the side that was dragged and nothing else; the default side is not stored', withPage(async ({ page, storage }) => {
  const handle = page.el('#handle-left');
  const press = (x) => handle.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: handle, pointerId: 1, clientX: x, clientY: 100 });
  press(500);
  handle.fire('pointermove', { clientX: 400, clientY: 100 });
  handle.fire('pointerup', { clientX: 400, clientY: 100, pointerId: 1 });
  await page.flush();
  assert.equal(storage[K('layout.left')], String(defaultColumns(1440).left - 100));
  assert.equal(storage[K('layout.right')], undefined, 'the other side was only shown, not dragged');
}, { width: 1468 }));

// A drag moves one handle. The sizes of the columns that were only shown at their default are not a wish of the user: they keep following the
// window, in this session and after a reload. (Before this, a drag copied all three shown sizes into the wanted layout, so a log drag froze
// both columns at the width of the window it was made in.)
const drag = async (page, id, from, to) => {
  const handle = page.el(id);
  const [x0, y0] = from, [x1, y1] = to;
  handle.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: handle, pointerId: 1, clientX: x0, clientY: y0 });
  handle.fire('pointermove', { clientX: x1, clientY: y1 });
  handle.fire('pointerup', { clientX: x1, clientY: y1, pointerId: 1 });
  await page.flush();
};
const widen = (page, gridWidth) => {
  page.el('.grid').clientWidth = gridWidth + 28;
  for (const fn of page.windowListeners.resize) fn();
};

test('page: after a drag of the LOG handle only, both side columns still follow the window (480 and 600 in a grid of 2560) and only the log is stored', async () => {
  const b = await boot({ width: 1468 });
  try {
    const { page, storage } = b;
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], [`${defaultColumns(1440).left}px`, `${defaultColumns(1440).right}px`]);
    await drag(page, '#handle-log', [100, 400], [100, 350]); // the log grows by 50
    assert.equal(css(page, '--log-h'), '240px');
    assert.deepEqual(Object.keys(storage).filter((k) => k.startsWith('wfviz.layout.')).sort(), [K('layout.log')], 'only the dragged size is stored');
    widen(page, 2560);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w'), css(page, '--log-h')], ['480px', '600px', '240px'], 'the columns took the new default, the log kept the drag');
  } finally { b.page.restore(); }
  const again = await boot({ width: 2588, storage: b.storage });
  try {
    assert.deepEqual([css(again.page, '--left-w'), css(again.page, '--right-w'), css(again.page, '--log-h')], ['480px', '600px', '240px'], 'and after a reload');
  } finally { again.page.restore(); }
});

test('page: after a drag of the left handle only, the left column keeps the dragged width and the right column follows the window; the same for the right handle', async () => {
  const left = await boot({ width: 1468 });
  try {
    await drag(left.page, '#handle-left', [500, 100], [400, 100]);
    const dragged = defaultColumns(1440).left - 100;
    assert.equal(css(left.page, '--left-w'), `${dragged}px`);
    assert.equal(left.storage[K('layout.left')], String(dragged));
    assert.equal(left.storage[K('layout.right')], undefined, 'the right side was only shown, not dragged, so it is not stored');
    widen(left.page, 2560);
    assert.equal(css(left.page, '--left-w'), `${dragged}px`, 'the dragged column stays');
    assert.equal(css(left.page, '--right-w'), '600px', 'the right column took the default of the new window');
  } finally { left.page.restore(); }
  const right = await boot({ width: 1468 });
  try {
    // the right column gets 50 px narrower (the two defaults fill what half of the width allows, so it could not grow before the left one is narrowed)
    await drag(right.page, '#handle-right', [850, 100], [900, 100]);
    const dragged = defaultColumns(1440).right - 50;
    assert.equal(css(right.page, '--right-w'), `${dragged}px`);
    assert.equal(right.storage[K('layout.left')], undefined);
    assert.equal(right.storage[K('layout.right')], String(dragged));
    widen(right.page, 2560);
    assert.equal(css(right.page, '--right-w'), `${dragged}px`);
    assert.equal(css(right.page, '--left-w'), '480px', 'the left column took the default of the new window');
  } finally { right.page.restore(); }
});

test('page: a drag does not unset a size that was already wanted: a stored right keeps its width (as shown) while the left is dragged, and the default log follows the window height', async () => {
  const b = await boot({ width: 1468, storage: { [K('layout.right')]: '380' } });
  try {
    const { page, storage } = b;
    await drag(page, '#handle-left', [500, 100], [450, 100]);
    assert.equal(css(page, '--right-w'), '380px');
    assert.equal(storage[K('layout.right')], '380', 'the stored width stays as it was');
    widen(page, 2560);
    assert.equal(css(page, '--right-w'), '380px', 'a stored width wins over the window');
    assert.equal(css(page, '--left-w'), `${defaultColumns(1440).left - 50}px`);
  } finally { b.page.restore(); }
});

test('page: a column that is shown narrower than its default because of a stored wide one keeps that width while the other handle is dragged (the drag stays under the pointer)', async () => {
  // grid of 1000: a stored left of 700 is clamped to 500 and the default right (268) no longer fits next to it, so both are shown squeezed
  const vp = { width: 1000, height: 800 };
  const shown = clampLayout({ left: 700 }, vp);
  assert.ok(shown.right < defaultColumns(1000).right, 'the right column is shown narrower than its default');
  const b = await boot({ width: 1028, storage: { [K('layout.left')]: '700' } });
  try {
    const { page, storage } = b;
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], [`${shown.left}px`, `${shown.right}px`]);
    const want = dragLayout(shown, 'left', shown.left, { dx: -20, dy: 0 }, vp);
    await drag(page, '#handle-left', [500, 100], [480, 100]);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], [`${want.left}px`, `${want.right}px`], 'the right column did not jump to its default');
    assert.equal(want.right, shown.right);
    assert.equal(storage[K('layout.left')], String(want.left));
    assert.equal(storage[K('layout.right')], undefined, 'and it is not stored');
  } finally { b.page.restore(); }
});

test('wantedAfterDrag: the dragged size, a size already wanted and a size pushed off its default are wanted; a default size is left out', () => {
  const vp = { width: 1440, height: 800 };
  const base = clampLayout({}, vp);
  // a log drag at the defaults: the columns are shown at their default, so they are not wanted
  assert.deepEqual(wantedAfterDrag({}, { ...base, log: 240 }, 'log', vp), { log: 240 });
  assert.deepEqual(wantedAfterDrag({}, { ...base, left: 200 }, 'left', vp), { left: 200 });
  assert.deepEqual(wantedAfterDrag({}, { ...base, right: 500 }, 'right', vp), { right: 500 });
  // a size that was already wanted stays wanted, at the width on show
  assert.deepEqual(wantedAfterDrag({ right: 700 }, { ...base, right: 450, log: 240 }, 'log', vp), { right: 450, log: 240 });
  assert.deepEqual(wantedAfterDrag({ right: 391 }, { ...base, left: 200 }, 'left', vp), { left: 200, right: 391 }, 'wanted although equal to the default: it was a wish');
  // a size shown off its default (squeezed by a stored wide column) keeps the width it has
  const narrow = { width: 1000, height: 800 };
  const squeezed = clampLayout({ left: 700 }, narrow);
  assert.deepEqual(wantedAfterDrag({ left: 700 }, { ...squeezed, log: 240 }, 'log', narrow), { left: squeezed.left, right: squeezed.right, log: 240 });
  // nothing is changed in the arguments, nothing of the argument leaks in, and a missing `wanted` is no wish
  const wanted = { left: 300 };
  const out = wantedAfterDrag(wanted, { ...base, log: 240 }, 'log', vp);
  assert.deepEqual(wanted, { left: 300 });
  assert.notEqual(out, wanted);
  assert.deepEqual(wantedAfterDrag(undefined, { ...base, log: 240 }, 'log', vp), { log: 240 });
  assert.deepEqual(wantedAfterDrag(null, { ...base, log: 240 }, 'log', vp), { log: 240 });
});

test('page: a drag that goes away from the default and comes back leaves the other side unwanted (the wanted layout is built from the press, not from the last move)', async () => {
  const b = await boot({ width: 1468 });
  try {
    const { page, storage } = b;
    const handle = page.el('#handle-left');
    handle.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: handle, pointerId: 1, clientX: 500, clientY: 100 });
    for (const x of [450, 600, 500, 480]) handle.fire('pointermove', { clientX: x, clientY: 100 });
    handle.fire('pointerup', { clientX: 480, clientY: 100, pointerId: 1 });
    await page.flush();
    assert.equal(storage[K('layout.left')], String(defaultColumns(1440).left - 20));
    assert.equal(storage[K('layout.right')], undefined);
    widen(page, 2560);
    assert.equal(css(page, '--right-w'), '600px');
  } finally { b.page.restore(); }
});

// ---- CSS and markup ----------------------------------------------------------------------------------------------------------

test('style.css: the first paint (before app.js has run) gives the same widths as the default: 480 and 600 px, less where the centre would go under half; the narrow layout is unchanged', () => {
  const style = readWeb('style.css');
  const grid = /\n\.grid\s*\{([^}]*)\}/.exec(style)?.[1] ?? '';
  const cols = /grid-template-columns:\s*([^;]*);/.exec(grid)?.[1] ?? '';
  assert.match(cols, /var\(--left-w, min\(480px, calc\(([\d.]+)% - ([\d.]+)px\)\)\)/);
  assert.match(cols, /var\(--right-w, min\(600px, calc\(([\d.]+)% - ([\d.]+)px\)\)\)/);
  const [, lp, lpx] = /var\(--left-w, min\(480px, calc\(([\d.]+)% - ([\d.]+)px\)\)\)/.exec(cols);
  const [, rp, rpx] = /var\(--right-w, min\(600px, calc\(([\d.]+)% - ([\d.]+)px\)\)\)/.exec(cols);
  // the fallback at a width w is min(480, lp% of w - lpx): the same number as defaultColumns (up to the rounding down to whole pixels)
  for (const w of [800, 1200, 1440, 1920, 2100, 2191, 2300, 2560, 4000]) {
    const css = { left: Math.min(480, (Number(lp) / 100) * w - Number(lpx)), right: Math.min(600, (Number(rp) / 100) * w - Number(rpx)) };
    const js = defaultColumns(w);
    assert.ok(Math.abs(css.left - js.left) < 1.01 && Math.abs(css.right - js.right) < 1.01, `at ${w}: css ${css.left.toFixed(2)} / ${css.right.toFixed(2)}, js ${js.left} / ${js.right}`);
  }
  assert.match(cols, /8px minmax\(0, 1fr\) 8px/, 'the handles and the middle track are as they were');
  const media = /@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
  assert.match(media, /grid-template-columns:\s*minmax\(0, 1fr\)/, 'the one-column layout is unchanged');
  assert.match(style, /var\(--log-h, 190px\)/, 'the log height fallback is unchanged');
  assert.match(style, /\.reset-open\s*\{[^}]*flex:\s*none/, 'the header button does not shrink or grow in the wrapping header');
});

test('index.html: the "Reset layout" button is a static button of the header, after "Tracking hint" and inside the header', () => {
  const html = readWeb('index.html');
  const header = /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
  assert.match(header, /<button id="reset-layout"[^>]*type="button"[^>]*>Reset layout<\/button>/);
  assert.ok(header.indexOf('id="hint-open"') < header.indexOf('id="reset-layout"'), 'next to the tracking hint, after it');
  assert.equal([...html.matchAll(/id="reset-layout"/g)].length, 1);
});

// ---- the last run ------------------------------------------------------------------------------------------------------------

test('last run: the run opened last is opened on load when the address has no run and the list has it (it beats the first run of the list)', withPage(async ({ page }) => {
  assert.deepEqual(shownRun(page), ['wf_b']);
  assert.match(page.el('#run-status').textContent + page.el('#rp-cur').textContent, /Second run/);
}, { hash: '#range=all', storage: { [K('lastRun')]: 'wf_b' } }));

test('last run: without a stored run the first loaded run opens, as before; opening a run stores it, and only when it differs from the stored one', async () => {
  const { page, storage } = await boot({ hash: '#range=all' });
  try {
    assert.deepEqual(shownRun(page), ['wf_a']);
    assert.equal(storage[K('lastRun')], 'wf_a', 'the run on show is the last run');
    const writes = [];
    const set = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (k, v) => { writes.push(k); set(k, v); };
    page.emit('hello', { mode: 'real', version: '1' }); // a reconnect reads the same run again
    await page.flush();
    assert.deepEqual(writes.filter((k) => k === K('lastRun')), [], 'a reconnect writes nothing');
  } finally { page.restore(); }
});

test('last run: a run that is gone is ignored silently (the page opens what it opened before, shows no notice, and does not forget to store the one it opened)', async () => {
  const { page, storage } = await boot({ hash: '#range=all', storage: { [K('lastRun')]: 'wf_gone' } });
  try {
    assert.deepEqual(shownRun(page), ['wf_a'], 'the first loaded run');
    assert.equal(page.el('#rp-note').hidden, true, 'no notice in the picker');
    assert.equal(page.el('#matrix-empty').hidden, true, 'no empty-state message either');
    assert.equal(storage[K('lastRun')], 'wf_a');
  } finally { page.restore(); }
});

test('last run: a stored value that is not a usable id is ignored (empty, too long, a selector, html)', async () => {
  for (const bad of ['', 'x'.repeat(STORED_ID_MAX + 1), '"]; alert(1); ["', '<img src=x onerror=alert(1)>', '__proto__', 'wf_a" , x', '{']) {
    const { page } = await boot({ hash: '#range=all', storage: { [K('lastRun')]: bad } });
    try {
      assert.deepEqual(shownRun(page), ['wf_a'], JSON.stringify(bad).slice(0, 30));
    } finally { page.restore(); }
  }
});

test('last run: a run that is only listed (not loaded) is opened too when it was the last (its read is asked for, nothing else is shown first)', async () => {
  const w = world();
  w.runDocs.wf_cold = runOf('wf_cold', ['w:C1'], { name: reg('Cold run') });
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', storage: { [K('lastRun')]: 'wf_cold' } });
  try {
    assert.deepEqual(shownRun(page), ['wf_cold']);
    assert.match(page.el('#rp-cur').textContent, /wf_cold/, 'the picker shows the run that was opened');
  } finally { page.restore(); }
});

test('last run: a click on another run changes the stored run; reading storage that throws loses nothing (the page opens the first run)', async () => {
  const { page, storage } = await boot({ hash: '#range=all', storage: { [K('lastRun')]: 'wf_a' } });
  try {
    await chooseRun(page, 'wf_b');
    assert.equal(storage[K('lastRun')], 'wf_b');
  } finally { page.restore(); }
  const t = await bootPage({ ...(() => { const w = world(); return { runs: w.runs, runDocs: w.runDocs }; })(), hash: '#range=all', storage: 'throws-on-access' });
  try {
    assert.deepEqual(shownRun(t), ['wf_a']);
  } finally { t.restore(); }
});

// ---- the filters -------------------------------------------------------------------------------------------------------------

test('filters: with no hash the stored filters are applied and written to the address', async () => {
  const { page } = await boot({ hash: '', storage: { [K('filters')]: '#range=all&status=failed' } });
  try {
    assert.equal(page.location.hash, '#range=all&status=failed', 'the stored text is the address');
    assert.deepEqual(shownRun(page), ['wf_a'], 'the run list is the filtered one only for the picker; the first loaded run opens');
    assert.deepEqual(await listedRuns(page), ['wf_f'], 'the picker lists only the failed run');
  } finally { page.restore(); }
});

test('filters: an address with a hash wins whole; the stored filters are neither merged nor overwritten', async () => {
  const stored = '#range=all&status=failed';
  const { page, storage } = await boot({ hash: '#range=all', storage: { [K('filters')]: stored } });
  try {
    assert.equal(page.location.hash, '#range=all');
    const rows = await listedRuns(page);
    assert.equal(rows.includes('wf_a') && rows.includes('wf_f'), true, `no status filter: every run is listed (${rows})`);
    assert.equal(storage[K('filters')], stored, 'a hash read at the start is not stored');
  } finally { page.restore(); }
});

test('filters: a stored project or status the list does not have is reset by the existing check, and the address and the storage follow', async () => {
  const { page, storage } = await boot({ hash: '', storage: { [K('filters')]: '#range=all&status=nope&project=gone' } });
  try {
    assert.equal(page.location.hash, '#range=all', 'the unknown status and project are back to "all"');
    assert.equal(storage[K('filters')], '#range=all');
  } finally { page.restore(); }
});

test('filters: a change the user makes is stored as the hash text; clearing every filter stores the empty text, so the next bare load does not bring the old one back', async () => {
  const { page, storage } = await boot({ hash: '#range=all&status=failed', storage: {} });
  try {
    assert.equal(storage[K('filters')], undefined, 'the address alone stores nothing');
    await page.type('zz');
    assert.equal(storage[K('filters')], '#range=all&status=failed&q=zz');
    await page.type('');
    assert.equal(storage[K('filters')], '#range=all&status=failed');
    const status = page.el('#rp-status');
    status.value = '';
    status.dispatch('change');
    await page.flush();
    const all = page.el('#rp-all');
    all.checked = false;
    all.dispatch('change');
    await page.flush();
    assert.equal(storage[K('filters')], '', 'every filter is the default: the empty text is stored (not the old filter)');
    assert.equal(page.location.hash, '');
  } finally { page.restore(); }
  // a bare load takes what was stored: the default
  const again = await boot({ hash: '', storage });
  try {
    assert.equal(again.page.location.hash, '');
    assert.deepEqual(await listedRuns(again.page), ['wf_a', 'wf_b', 'wf_f', 'wf_cold'], 'the default filter (the last 24 h) lists the runs of the day');
  } finally { again.page.restore(); }
  // and a status that was set and stored comes back on a bare load
  const kept = await boot({ hash: '#range=all', storage: {} });
  try {
    const status = kept.page.el('#rp-status');
    status.value = 'failed';
    status.dispatch('change');
    await kept.page.flush();
    assert.equal(kept.storage[K('filters')], '#range=all&status=failed');
  } finally { kept.page.restore(); }
  const bare = await boot({ hash: '', storage: kept.storage });
  try {
    assert.equal(bare.page.location.hash, '#range=all&status=failed');
    assert.deepEqual(await listedRuns(bare.page), ['wf_f']);
  } finally { bare.page.restore(); }
});

test('filters: an address changed by hand (hashchange) is read as the filters on show and never stored', async () => {
  const { page, storage } = await boot({ hash: '', storage: { [K('filters')]: '#range=all&status=failed' } });
  try {
    assert.equal(storage[K('filters')], '#range=all&status=failed');
    page.location.hash = '#range=all&status=completed';
    assert.equal(page.windowListeners.hashchange.length, 1);
    for (const fn of page.windowListeners.hashchange) fn();
    await page.flush();
    assert.deepEqual(await listedRuns(page), ['wf_a', 'wf_b', 'wf_cold'], 'the address is what shows');
    assert.equal(storage[K('filters')], '#range=all&status=failed', 'but the stored filters are the ones the user set');
  } finally { page.restore(); }
});

test('filters: the filters are stored with the given hash text only through parsePickerHash (a stored text with junk keys is read as the filters it holds)', async () => {
  const { page } = await boot({ hash: '', storage: { [K('filters')]: '#bad=1&status=failed&range=all&bad2=%E0%A4%A' } });
  try {
    assert.equal(page.location.hash, '#range=all&status=failed', 'junk keys are dropped, the address is rewritten in the fixed order');
  } finally { page.restore(); }
});

// ---- the matrix rows, the tests card and the weak-edges switch of a run -------------------------------------------------------------

test('per-run state: an opened matrix row, the tests card and the weak-edges switch are restored for that run after a reload, and another run starts with none of them', async () => {
  const first = await boot({ hash: '#range=all' });
  const storage = first.storage;
  try {
    const page = first.page;
    assert.deepEqual(opened(page), [], 'a first visit: nothing opened');
    assert.equal(storage[K('runState')], undefined, 'merely selecting a run writes nothing');
    await page.click(toggleOf(page, 'U2'));
    assert.deepEqual(opened(page), ['U2']);
    await page.click(testsButton(page));
    assert.equal(testsButton(page).attrs.get('aria-expanded'), 'true');
    const weak = page.el('#weak-toggle');
    weak.checked = true;
    weak.onchange({ target: weak });
    await page.flush();
    assert.deepEqual(JSON.parse(storage[K('runState')]), [['wf_a', { expanded: ['U2'], tests: true, weak: true }]]);
  } finally { first.page.restore(); }

  const second = await boot({ hash: '#range=all', storage });
  try {
    const page = second.page;
    assert.deepEqual(opened(page), ['U2'], 'the row is open again');
    assert.equal(testsButton(page).attrs.get('aria-expanded'), 'true', 'the tests card shows all rows');
    assert.equal(page.el('#weak-toggle').checked, true);
    // another run starts with none of them, and the switch is cleared (the box keeps its own state from run to run)
    await chooseRun(page, 'wf_b');
    assert.deepEqual(opened(page), [], 'the other run has no row opened');
    assert.equal(testsButton(page).attrs.get('aria-expanded'), 'false');
    assert.equal(page.el('#weak-toggle').checked, false, 'the switch shows this run\'s state');
    assert.equal(JSON.parse(storage[K('runState')]).length, 1, 'looking at another run adds no entry');
    // and back
    await chooseRun(page, 'wf_a');
    assert.deepEqual(opened(page), ['U2']);
    assert.equal(page.el('#weak-toggle').checked, true);
  } finally { second.page.restore(); }
});

test('per-run state: closing the last open row, the card and the switch leaves no entry for the run', withPage(async ({ page, storage }) => {
  await page.click(toggleOf(page, 'U1'));
  assert.equal(JSON.parse(storage[K('runState')]).length, 1);
  await page.click(toggleOf(page, 'U1'));
  assert.deepEqual(JSON.parse(storage[K('runState')]), [], 'the run holds nothing: no entry');
}, { hash: '#range=all' }));

test('per-run state: a reconnect keeps what is on show (it neither restores from storage nor resets the rows)', withPage(async ({ page, storage }) => {
  await page.click(toggleOf(page, 'U1'));
  assert.deepEqual(opened(page), ['U1']);
  storage[K('runState')] = JSON.stringify([]); // storage says nothing is open
  page.emit('hello', { mode: 'real', version: '1' });
  await page.flush();
  assert.deepEqual(opened(page), ['U1'], 'what the user opened stays open across a reconnect');
}, { hash: '#range=all' }));

test('per-run state: bad stored values are no state (not JSON, an object, wrong types) and the page loads with every row closed', async () => {
  for (const bad of ['abc', '{', '{}', 'null', '5', '[1]', '[["wf_a","x"]]', '[["wf_a",{"expanded":"U1","tests":"yes","weak":1}]]', '{"wf_a":{"tests":true}}']) {
    const { page } = await boot({ hash: '#range=all', storage: { [K('runState')]: bad } });
    try {
      assert.deepEqual(opened(page), [], bad);
      assert.equal(testsButton(page).attrs.get('aria-expanded'), 'false', bad);
      assert.equal(page.el('#weak-toggle').checked, false, bad);
    } finally { page.restore(); }
  }
});

test('per-run state: a stored name is data: a unit name that is a selector or html opens no row of another name and breaks nothing', async () => {
  const mem = JSON.stringify([['wf_a', { expanded: ['"] [data-agent', '<b>U1</b>', 'U2'], tests: false, weak: false }]]);
  const { page } = await boot({ hash: '#range=all', storage: { [K('runState')]: mem } });
  try {
    assert.deepEqual(opened(page), ['U2'], 'only a unit that the run has is opened');
  } finally { page.restore(); }
});

test('per-run state: the memory holds at most 50 runs when the page writes it (51 runs, the oldest dropped), and the entries stay in order', async () => {
  const seeded = Array.from({ length: 50 }, (_, i) => [`old_${i}`, { expanded: [], tests: true, weak: false }]);
  const { page, storage } = await boot({ hash: '#range=all', storage: { [K('runState')]: JSON.stringify(seeded) } });
  try {
    await page.click(toggleOf(page, 'U1'));
    const got = JSON.parse(storage[K('runState')]);
    assert.equal(got.length, 50);
    assert.equal(got[0][0], 'old_1', 'old_0 was the oldest and is gone');
    assert.deepEqual(got.at(-1), ['wf_a', { expanded: ['U1'], tests: false, weak: false }]);
  } finally { page.restore(); }
});

test('per-run state: with storage that throws the page still opens, rows still open and close, and nothing breaks', async () => {
  const w = world();
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', storage: 'throws-on-access' });
  try {
    await page.click(toggleOf(page, 'U1'));
    assert.deepEqual(opened(page), ['U1']);
    await page.click(toggleOf(page, 'U1'));
    assert.deepEqual(opened(page), []);
  } finally { page.restore(); }
});

// ---- Reset layout ------------------------------------------------------------------------------------------------------------

const fullStorage = () => ({
  ...Object.fromEntries(STORED_KEYS.map((k) => [K(k), k.startsWith('layout.') ? '321' : k === 'runState' ? '[]' : k === 'filters' ? '#range=all' : '1'])),
  'other.app': 'keep', 'wfviz-not-ours': 'keep', [K('somebody.elses')]: 'keep', foreign: '1',
});

test('reset: after the confirm, exactly the keys the page stores are removed (a foreign key and a wfviz key that is not in the list stay) and the page is loaded again', async () => {
  const { page, storage } = await boot({ hash: '#range=all&status=failed', width: 1468, storage: fullStorage(), confirm: () => true });
  try {
    assert.deepEqual(Object.keys(storage).sort(), Object.keys(fullStorage()).sort(), 'every key is there before');
    await page.click(page.el('#reset-layout'));
    assert.deepEqual(page.confirms, [RESET_CONFIRM_TEXT], 'one confirm, with the fixed text');
    assert.deepEqual(Object.keys(storage).sort(), ['foreign', 'other.app', K('somebody.elses'), 'wfviz-not-ours'].sort(), 'only what the page stores is gone');
    assert.equal(page.reloads, 1, 'and the page loads again');
    assert.equal(page.location.hash, '', 'the filters of the address would come back after the reload: they are the default now');
    const want = defaultColumns(1440);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], [`${want.left}px`, `${want.right}px`], 'the sizes on show are the default at once');
  } finally { page.restore(); }
});

test('reset: a confirm that says no, throws, returns something else or is missing changes nothing and does not reload', async () => {
  for (const [name, confirm] of [['no', () => false], ['throws', 'throws'], ['undefined', () => undefined], ['a truthy text', () => 'yes'], ['missing', undefined]]) {
    const { page, storage } = await boot({ hash: '#range=all&status=failed', storage: fullStorage(), confirm });
    try {
      const before = JSON.stringify(storage);
      await page.click(page.el('#reset-layout'));
      assert.equal(JSON.stringify(storage), before, `${name}: nothing removed`);
      assert.equal(page.reloads, 0, `${name}: no reload`);
      assert.equal(page.location.hash, '#range=all&status=failed', `${name}: the filters stay`);
    } finally { page.restore(); }
  }
});

test('reset: a page whose location has no reload still resets (the keys go, nothing throws)', async () => {
  const { page, storage } = await boot({ storage: fullStorage(), confirm: () => true, reload: false });
  try {
    await page.click(page.el('#reset-layout'));
    assert.deepEqual(Object.keys(storage).sort(), ['foreign', 'other.app', K('somebody.elses'), 'wfviz-not-ours'].sort());
  } finally { page.restore(); }
});

test('reset: with storage that throws on every access the page loads and the button breaks nothing', async () => {
  const w = world();
  const page = await bootPage({ runs: w.runs, runDocs: w.runDocs, hash: '#range=all', storage: 'throws-on-access', confirm: () => true });
  try {
    await page.click(page.el('#reset-layout'));
    assert.equal(page.reloads, 1, 'the page is still loaded again');
    assert.equal(page.confirms.length, 1);
  } finally { page.restore(); }
});

test('reset: the button opens no panel and adds no listener of the document or the window; its own click is the one handler', () => {
  const app = readWeb('app.js');
  assert.equal([...app.matchAll(/\$\('#reset-layout'\)\.addEventListener\('click', resetLayout\)/g)].length, 1);
  assert.equal([...app.matchAll(/document\.addEventListener\('click'/g)].length, 1, 'still one click handler of the document');
  assert.equal([...app.matchAll(/document\.addEventListener\('keydown'/g)].length, 1);
  assert.equal([...app.matchAll(/window\.addEventListener\('resize'/g)].length, 1, 'still one resize handler');
  assert.equal([...app.matchAll(/setInterval\(/g)].length, 1);
  assert.equal([...app.matchAll(/setTimeout\(/g)].length, 5, 'no timer was added');
  assert.equal([...app.matchAll(/new EventSource\(/g)].length, 1);
  assert.equal([...app.matchAll(/\.innerHTML =/g)].length, 1, 'still the one guarded setHtml');
  assert.equal([...app.matchAll(/localStorage/g)].length, 3, 'storage is touched only inside localGet, localSet and localRemove');
  assert.match(app, /function resetLayout\(\)[\s\S]*?typeof confirm === 'function'/, 'a missing confirm is checked for');
  assert.match(app, /for \(const k of STORED_KEYS\) localRemove\(k\)/, 'the fixed list, never a walk of the storage');
});

test('reset: nothing of the page\'s data reaches confirm, a selector or html (the text is the fixed constant)', () => {
  assert.match(RESET_CONFIRM_TEXT, /^[\x20-\x7e]+$/, 'plain ASCII');
  assert.doesNotMatch(RESET_CONFIRM_TEXT, /[<>&"']/);
  const app = readWeb('app.js');
  assert.match(app, /confirm\(RESET_CONFIRM_TEXT\)/);
  assert.doesNotMatch(app, /confirm\([^R)]/, 'confirm is called with the constant only');
});
