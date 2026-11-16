// Tests of the layout fixes of the page (web/lib.js, web/app.js, web/style.css): the run the first page opens (a running one first), the centre
// column keeping at least half of the width for every stored or dragged width, the last run remembered only after its data arrived, and the
// matrix columns and phase lanes that do not stretch over the whole centre. The pure parts are called directly with good and bad values; the page
// runs on the fake browser of fake-page.mjs, which boots app.js itself. Where only a real browser can say (the look of the empty room on the right
// of a wide centre) the rules are read here and the numbers are measured by the node's own check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CENTER_MIN, HANDLE_WIDTH, chooseStartRun, clampLayout, defaultColumns, dragLayout, matrixColumns, wantedAfterDrag } from '../../web/lib.js';
import { bootPage } from './fake-page.mjs';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWeb = (f) => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');
const COLUMN_MIN = 160;
// what the two side columns may take together in a grid of `w`: half of the width less the two handles
const boundOf = (w) => Math.floor(w / 2) - 2 * HANDLE_WIDTH;
const centreOf = (w, c) => w - c.left - c.right - 2 * HANDLE_WIDTH;

// ---- builders: a list item and a Run, as the server gives them ----------------------------------------------------------------

const reg = (value) => ({ value, prov: 'registered', from: 'test:1' });
const inf = (value, method = 'label-pattern') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });

function agent(id, label) {
  const m = /^([^:#]+):([^#]+)$/.exec(label);
  return {
    id, label: reg(label), role: inf(m[1]), unit: inf(m[2]), round: unk('no round'), tag: unk('no tag'), phase: reg('P1'), state: reg('done'),
    startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(),
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
const running = (id, over = {}) => runOf(id, ['w:U1'], { status: reg('running'), ...over });
// the runs by id, and their list items in the order given
const docs = (...rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const K = (name) => `wfviz.${name}`;
const shownRun = (page) => page.requests.filter((u) => /^\/api\/runs\/[^/?]+$/.test(u)).map((u) => u.slice('/api/runs/'.length));
const css = (page, name) => page.root.props.get(name);
const widen = (page, gridWidth) => {
  page.el('.grid').clientWidth = gridWidth + 28;
  for (const fn of page.windowListeners.resize) fn();
};
const drag = async (page, id, from, to) => {
  const handle = page.el(id);
  handle.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: handle, pointerId: 1, clientX: from[0], clientY: from[1] });
  handle.fire('pointermove', { clientX: to[0], clientY: to[1] });
  handle.fire('pointerup', { clientX: to[0], clientY: to[1], pointerId: 1 });
  await page.flush();
};
// a page whose list is these runs (all loaded), in this order
const pageOf = (rs, over = {}) => bootPage({ runs: rs.map((r) => summary(r)), runDocs: docs(...rs), hash: '#range=all', ...over });

// =====================================================================================================================
// 1. the run the first page opens
// =====================================================================================================================

const item = (id, status, extra = {}) => ({ id, status: reg(status), ...extra });

test('chooseStartRun: a running loaded run beats the remembered run, the remembered run beats the first loaded run', () => {
  const list = [item('A', 'completed'), item('B', 'running'), item('C', 'completed')];
  assert.equal(chooseStartRun(list, 'C'), 'B', 'running first');
  assert.equal(chooseStartRun(list, 'A'), 'B', 'also when the remembered run is the first of the list');
  assert.equal(chooseStartRun(list, null), 'B');
  const none = [item('A', 'completed'), item('B', 'failed'), item('C', 'completed')];
  assert.equal(chooseStartRun(none, 'C'), 'C', 'no running run: the remembered one');
  assert.equal(chooseStartRun(none, 'B'), 'B', 'a failed one counts as a run of the list');
  assert.equal(chooseStartRun(none, null), 'A', 'nothing remembered: the first loaded run');
});

test('chooseStartRun: several running runs give the first in the order of the list, not the remembered one', () => {
  const list = [item('A', 'completed'), item('R1', 'running'), item('R2', 'running')];
  assert.equal(chooseStartRun(list, 'R2'), 'R1');
  assert.equal(chooseStartRun([item('R2', 'running'), item('R1', 'running')], 'R1'), 'R2', 'the order of the list decides, not the id');
});

test('chooseStartRun: a remembered run that is gone, or is not a text, is ignored', () => {
  const list = [item('A', 'completed'), item('B', 'completed')];
  assert.equal(chooseStartRun(list, 'gone'), 'A');
  for (const bad of [undefined, null, '', 0, 5, {}, [], ['B'], true, { id: 'B' }]) assert.equal(chooseStartRun(list, bad), 'A', String(JSON.stringify(bad)));
  assert.equal(chooseStartRun(list, '__proto__'), 'A', 'an id is compared, never looked up');
});

test('chooseStartRun: a run that is only listed is never "running", whatever its listed status says; it opens when it is the remembered one', () => {
  const list = [item('A', 'completed'), item('COLD', 'running', { loaded: false })];
  assert.equal(chooseStartRun(list, null), 'A', 'a listed-only run with the status running does not beat a loaded one');
  assert.equal(chooseStartRun(list, 'COLD'), 'COLD', 'but the remembered one opens, loaded or not');
  assert.equal(chooseStartRun([item('COLD', 'running', { loaded: false })], null), null, 'nothing is loaded and nothing remembered: none');
  assert.equal(chooseStartRun([item('COLD', 'completed', { loaded: false }), item('B', 'completed')], null), 'B', 'the first loaded run, not the first listed');
  // an item without `loaded` counts as loaded, as before; only the value false says it is not
  assert.equal(chooseStartRun([item('A', 'running')], null), 'A');
  assert.equal(chooseStartRun([item('A', 'running', { loaded: true })], null), 'A');
  for (const odd of [undefined, null, 0, 'false', 'no']) assert.equal(chooseStartRun([item('A', 'running', { loaded: odd })], null), 'A', `loaded: ${String(odd)} is not false`);
});

test('chooseStartRun: a status that is missing, unknown or not the text running is not running; a Fact is read by its value', () => {
  assert.equal(chooseStartRun([{ id: 'A' }, item('B', 'completed')], null), 'A', 'no status: not running, and the first loaded one');
  assert.equal(chooseStartRun([item('A', 'completed'), { id: 'B', status: { value: null, prov: 'unknown', reason: 'no data' } }], null), 'A', 'an unknown status is not running');
  assert.equal(chooseStartRun([item('A', 'completed'), { id: 'B', status: { value: 'Running', prov: 'final', from: 'x' } }], null), 'A', 'the text is compared whole and exactly');
  assert.equal(chooseStartRun([item('A', 'completed'), { id: 'B', status: 'running' }], null), 'B', 'a plain value (not a Fact) is read as it is: val() does so everywhere');
  assert.equal(chooseStartRun([item('A', 'completed'), { id: 'B', status: { value: 'running', prov: 'inferred', method: 'no-final-file' } }], 'A'), 'B', 'an inferred running status counts');
});

test('chooseStartRun: no loaded run and nothing remembered gives null; a list that is not a list, and entries that are not runs, give null or are skipped', () => {
  assert.equal(chooseStartRun([], null), null);
  assert.equal(chooseStartRun([], 'A'), null, 'a remembered run that the empty list does not have');
  for (const bad of [undefined, null, 'A', 5, {}, { length: 1, 0: item('A', 'completed') }, true]) assert.equal(chooseStartRun(bad, 'A'), null, String(JSON.stringify(bad)));
  const mixed = [null, undefined, 7, 'x', [], [item('Z', 'running')], { status: reg('running') }, { id: 5, status: reg('running') }, { id: '', status: reg('running') }, item('A', 'completed')];
  assert.equal(chooseStartRun(mixed, null), 'A', 'entries without a text id are skipped (a running one among them too)');
  assert.equal(chooseStartRun(mixed, 5), 'A');
  assert.doesNotThrow(() => chooseStartRun([null, undefined], 'A'));
});

test('chooseStartRun: it reads only id, status and loaded of an item (no label, role, name or project), and changes nothing', () => {
  const a = { id: 'A', status: reg('completed'), name: reg('the running one'), label: 'running', role: 'running', project: 'running', agents: 99, running: 3, startedAt: inf(1) };
  const b = { id: 'B', status: reg('completed'), name: unk('x') };
  const list = [a, b];
  const before = JSON.stringify(list);
  assert.equal(chooseStartRun(list, null), 'A', 'a `running` count or a word in another field does not make a run running');
  assert.equal(JSON.stringify(list), before);
  assert.equal(chooseStartRun.length, 2);
  // the function does not reach for the storage or the page
  const src = readWeb('lib.js');
  const body = /export function chooseStartRun[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
  assert.ok(body.length > 100, 'found the function');
  assert.doesNotMatch(body, /localStorage|localGet|document|window|fetch/);
});

const COLD = (id, status = 'completed') => ({ id, name: unk('not loaded'), status: reg(status), project: null, startedAt: inf(Date.now() - 90_000), agents: 3, running: 0, source: 'real', loaded: false });

test('start run (page): a running run opens first, the remembered run is the second choice, then the first loaded run', async () => {
  const mk = () => [runOf('wf_a', ['w:U1']), running('wf_b'), runOf('wf_c', ['w:U1'])];
  const withRunning = await pageOf(mk(), { storage: { [K('lastRun')]: 'wf_c' } });
  try {
    assert.deepEqual(shownRun(withRunning), ['wf_b'], 'running beats the remembered run');
    assert.equal(withRunning.storage[K('lastRun')], 'wf_b', 'and it is the last run now');
  } finally { withRunning.restore(); }
  const noRunning = [runOf('wf_a', ['w:U1']), runOf('wf_b', ['w:U1']), runOf('wf_c', ['w:U1'])];
  const remembered = await pageOf(noRunning, { storage: { [K('lastRun')]: 'wf_c' } });
  try { assert.deepEqual(shownRun(remembered), ['wf_c'], 'no running run: the remembered one'); } finally { remembered.restore(); }
  const gone = await pageOf(noRunning, { storage: { [K('lastRun')]: 'wf_gone' } });
  try {
    assert.deepEqual(shownRun(gone), ['wf_a'], 'a remembered run that is gone is ignored: the first loaded run');
    assert.equal(gone.storage[K('lastRun')], 'wf_a');
  } finally { gone.restore(); }
  const fresh = await pageOf(noRunning);
  try { assert.deepEqual(shownRun(fresh), ['wf_a'], 'nothing remembered: the first loaded run'); } finally { fresh.restore(); }
});

test('start run (page): a running run that the default filter hides (older than a day) still opens first; a listed-only run with the status running does not', async () => {
  const old = running('wf_old', { startedAt: inf(Date.now() - 10 * 86_400_000) });
  const page = await bootPage({ runs: [summary(runOf('wf_a', ['w:U1'])), summary(old)], runDocs: docs(runOf('wf_a', ['w:U1']), old), hash: '' });
  try {
    assert.deepEqual(shownRun(page), ['wf_old'], 'the choice reads the whole list, as before, not the rows the picker shows');
  } finally { page.restore(); }
  const w = runOf('wf_a', ['w:U1']);
  const cold = await bootPage({ runs: [summary(w), COLD('wf_cold', 'running')], runDocs: docs(w), hash: '#range=all' });
  try {
    assert.deepEqual(shownRun(cold), ['wf_a'], 'a run that is only listed is read on a click, not because its listed status says running');
  } finally { cold.restore(); }
});

test('start run (page): nothing loaded and nothing remembered opens no run and says so; a remembered run that is only listed still opens', async () => {
  const page = await bootPage({ runs: [COLD('wf_cold1'), COLD('wf_cold2', 'running')], runDocs: {}, hash: '#range=all' });
  try {
    assert.deepEqual(shownRun(page), [], 'no run was asked for');
    assert.match(page.el('#matrix-empty').html, /No run is loaded yet/);
    assert.equal(page.storage[K('lastRun')], undefined, 'and none is remembered');
  } finally { page.restore(); }
  const cold = runOf('wf_cold2', ['w:C1']);
  const remembered = await bootPage({ runs: [summary(runOf('wf_a', ['w:U1'])), COLD('wf_cold2')], runDocs: docs(runOf('wf_a', ['w:U1']), cold), hash: '#range=all', storage: { [K('lastRun')]: 'wf_cold2' } });
  try { assert.deepEqual(shownRun(remembered), ['wf_cold2']); } finally { remembered.restore(); }
});

test('start run (source and page): the choice is made only while no run is on show (the `!state.runId` guard); a run picked by hand afterwards is the last run once its data is here', async () => {
  const page = await pageOf([runOf('wf_a', ['w:U1']), running('wf_b')]);
  try {
    assert.deepEqual(shownRun(page), ['wf_b']);
    // the app's source: the choice is guarded by `!state.runId`; the run chosen from the picker is the one on show afterwards
    const src = readWeb('app.js');
    assert.match(src, /if \(!state\.runId && state\.runs\.length\) \{\s*const open = chooseStartRun\(state\.runs, parseLastRun\(localGet\('lastRun'\)\)\);/);
    await page.click(page.el('#rp-trigger'));
    const row = page.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === 'wf_a');
    await page.click(row);
    assert.equal(page.storage[K('lastRun')], 'wf_a', 'the run chosen is remembered once its data is here');
  } finally { page.restore(); }
});

// =====================================================================================================================
// 2. the centre keeps at least half of the width, for every width
// =====================================================================================================================

test('clampLayout: stored 700 and 800 at 1440 and at 1280 leave the centre at least half, and the two keep the ratio of the stored widths', () => {
  for (const w of [1440, 1280]) {
    const c = clampLayout({ left: 700, right: 800 }, { width: w, height: 800 });
    assert.ok(c.left + c.right <= boundOf(w), `${w}: ${c.left} + ${c.right} within ${boundOf(w)}`);
    assert.ok(centreOf(w, c) >= w / 2, `${w}: the centre is ${centreOf(w, c)}`);
    assert.ok(Math.abs(c.left / c.right - 700 / 800) < 0.01, `${w}: ratio ${c.left / c.right} against ${700 / 800}`);
    assert.ok(Number.isInteger(c.left) && Number.isInteger(c.right));
  }
  assert.deepEqual(clampLayout({ left: 700, right: 800 }, { width: 1440, height: 800 }), { left: 328, right: 375, log: 190 });
  assert.deepEqual(clampLayout({ left: 700, right: 800 }, { width: 1280, height: 800 }), { left: 291, right: 332, log: 190 });
  // the shrink is of the wishes together: it does not first cut each to half of the width (that would give 347 / 356 at 1440)
  assert.ok(clampLayout({ left: 700, right: 800 }, { width: 1440, height: 800 }).right - clampLayout({ left: 700, right: 800 }, { width: 1440, height: 800 }).left > 40);
});

test('clampLayout: a wish that fits the bound is shown as it is; a wide one one-sided is shrunk with the default of the other side', () => {
  const vp = { width: 1440, height: 800 };
  assert.deepEqual(clampLayout({ left: 300, right: 380 }, vp), { left: 300, right: 380, log: 190 }, '680 of 704: untouched');
  assert.deepEqual(clampLayout({ left: 352, right: 352 }, vp), { left: 352, right: 352, log: 190 }, 'exactly the bound: untouched');
  const over = clampLayout({ left: 353, right: 352 }, vp);
  assert.ok(over.left + over.right <= 704 && over.left >= 350 && over.right >= 350 && over.left + over.right < 705, `one over the bound shrinks both: ${over.left} ${over.right}`);
  assert.ok(over.left < 353 && over.right < 352, 'both give way, in proportion');
  // a stored right beside the missing left: the default left (312) is a wish like any other
  assert.deepEqual(clampLayout({ right: 450 }, vp), { left: 288, right: 415, log: 190 });
  // nothing stored: the defaults, which already fill the bound, are not changed
  assert.deepEqual(clampLayout({}, vp), { ...defaultColumns(1440), log: 190 });
});

test('clampLayout: a minimum raised after the shrink does not break the bound (9999 beside 160 at 1400 gives 524 and 160, not 556 and 160)', () => {
  const vp = { width: 1400, height: 800 };
  assert.deepEqual(clampLayout({ left: 9999, right: 160 }, vp), { left: 524, right: 160, log: 190 });
  assert.deepEqual(clampLayout({ left: 160, right: 9999 }, vp), { left: 160, right: 524, log: 190 });
  assert.deepEqual(clampLayout({ left: 50, right: 9999 }, vp), { left: 160, right: 524, log: 190 }, 'a wish under the minimum counts as the minimum');
  assert.deepEqual(clampLayout({ left: -5000, right: 9999 }, vp), { left: 160, right: 524, log: 190 });
  assert.deepEqual(clampLayout({ left: 9999, right: 9999 }, vp), { left: 342, right: 342, log: 190 }, 'two equal wishes share the bound');
});

test('clampLayout: the bound is a whole number, so a stored fractional width cannot put the sum one pixel over', () => {
  for (const w of [1440, 1441, 1442.5, 1300.25]) {
    const c = clampLayout({ left: 300.5, right: boundOf(w) - 300.5 }, { width: w, height: 800 });
    assert.ok(Number.isInteger(c.left) && Number.isInteger(c.right), `whole pixels at ${w}`);
    assert.ok(centreOf(w, c) >= w / 2, `the centre is half at ${w}: ${centreOf(w, c)}`);
  }
});

test('clampLayout: a drag stops where the centre would fall under half; the other column is unchanged when it fits', () => {
  const vp = { width: 1440, height: 800 };
  const shown = clampLayout({}, vp); // 312 / 391, as the page shows them
  assert.deepEqual([shown.left, shown.right], [312, 391]);
  const left = dragLayout(shown, 'left', shown.left, { dx: 500, dy: 0 }, vp);
  assert.deepEqual([left.left, left.right], [313, 391], 'the left column stops at the bound less the right one');
  assert.equal(centreOf(1440, left), 720, 'the centre is exactly half');
  const right = dragLayout(shown, 'right', shown.right, { dx: -500, dy: 0 }, vp);
  assert.deepEqual([right.left, right.right], [312, 392]);
  assert.equal(centreOf(1440, right), 720);
  // a narrower other column leaves room: the dragged one takes it, and the other does not move
  const narrow = { left: 300, right: 300, log: 190 };
  assert.deepEqual(dragLayout(narrow, 'left', 300, { dx: 900, dy: 0 }, vp), { left: 404, right: 300, log: 190 });
  assert.deepEqual(dragLayout(narrow, 'right', 300, { dx: -900, dy: 0 }, vp), { left: 300, right: 404, log: 190 });
  // a drag that does not reach the bound is exact
  assert.deepEqual(dragLayout(narrow, 'left', 300, { dx: 50, dy: 0 }, vp), { left: 350, right: 300, log: 190 });
  // dragging a column narrower is never held back by the bound
  assert.deepEqual(dragLayout(shown, 'left', 312, { dx: -100, dy: 0 }, vp).left, 212);
});

test('clampLayout: the 160 px minimum wins when the window is too narrow for the rule', () => {
  for (const w of [600, 500, 400, 320, 100]) {
    const none = clampLayout({ left: 700, right: 800 }, { width: w, height: 800 });
    assert.deepEqual([none.left, none.right], [160, 160], `width ${w}`);
    for (const prefer of ['left', 'right']) {
      const c = clampLayout({ left: 700, right: 800 }, { width: w, height: 800 }, prefer);
      assert.deepEqual([c.left, c.right], [160, 160], `width ${w}, prefer ${prefer}`);
    }
  }
  // the rule still holds where it can: from a width of 672 two minimums and the half fit
  const c = clampLayout({ left: 700, right: 800 }, { width: 700, height: 800 });
  assert.ok(c.left >= COLUMN_MIN && c.right >= COLUMN_MIN && centreOf(700, c) >= 350 - 1, `${c.left} / ${c.right}`);
  assert.ok(CENTER_MIN <= 240, 'CENTER_MIN is still there for the window narrower than 480');
});

test('clampLayout: a sweep of widths, wishes and drag sides never leaves the centre under half (the minimum trap included)', () => {
  const wishes = [undefined, 50, 160, 200, 300, 500, 700, 800, 1500, 9999];
  let n = 0;
  for (let width = 1101; width <= 2600; width++) {
    for (const prefer of [null, 'left', 'right']) {
      for (const l of wishes) {
        for (const r of wishes) {
          const wanted = {};
          if (l !== undefined) wanted.left = l;
          if (r !== undefined) wanted.right = r;
          const c = clampLayout(wanted, { width, height: 800 }, prefer);
          n++;
          if (centreOf(width, c) < width / 2 || c.left < COLUMN_MIN || c.right < COLUMN_MIN || !Number.isInteger(c.left) || !Number.isInteger(c.right)) {
            assert.fail(`width ${width} prefer ${prefer} wanted ${JSON.stringify(wanted)}: ${JSON.stringify(c)}, centre ${centreOf(width, c)}`);
          }
        }
      }
    }
  }
  assert.equal(n, 1500 * 3 * 100);
});

test('clampLayout: a wish near Number.MAX_VALUE (two of them add up to Infinity) gives whole finite widths, and the centre keeps its half', () => {
  // the stored text "1e308" is a number parseStoredSize accepts; before the limit on a wish two of them gave NaN and NaN (the page then wrote --left-w: NaNpx)
  assert.deepEqual(clampLayout({ left: 1e308, right: 1e308 }, { width: 1440, height: 900 }), { left: 352, right: 352, log: 190 }, 'two absurd wishes share the bound');
  assert.deepEqual(clampLayout({ left: 9e307, right: 9e307 }, { width: 1440, height: 900 }), { left: 352, right: 352, log: 190 }, 'their sum is the first to overflow');
  assert.deepEqual(clampLayout({ left: Number.MAX_VALUE, right: Number.MAX_VALUE }, { width: 1440, height: 900 }), { left: 352, right: 352, log: 190 });
  assert.deepEqual(clampLayout({ left: 1e308, right: 300 }, { width: 1440, height: 900 }), clampLayout({ left: 9999, right: 300 }, { width: 1440, height: 900 }), 'one absurd wish acts as a wide one');
  assert.deepEqual(clampLayout({ left: -1e308, right: -1e308 }, { width: 1440, height: 900 }), { left: 160, right: 160, log: 190 }, 'a huge negative wish is the minimum');
  const huge = [1e308, 9e307, Number.MAX_VALUE, 1e300, 2 ** 60, 2 ** 53, 2 ** 40 + 1, -1e308, -Number.MAX_VALUE];
  const others = [undefined, 50, 300, 800, ...huge];
  let n = 0;
  for (const width of [672, 700, 1101, 1280, 1440, 1920, 2560, 3200, 1e6]) {
    for (const prefer of [null, 'left', 'right']) {
      for (const l of huge) {
        for (const r of others) {
          for (const swap of [false, true]) {
            const wanted = {};
            wanted[swap ? 'right' : 'left'] = l;
            if (r !== undefined) wanted[swap ? 'left' : 'right'] = r;
            const c = clampLayout(wanted, { width, height: 900 }, prefer);
            n++;
            const finite = [c.left, c.right, c.log].every((x) => Number.isInteger(x));
            if (!finite || c.left < COLUMN_MIN || c.right < COLUMN_MIN || centreOf(width, c) < width / 2) {
              assert.fail(`width ${width} prefer ${prefer} wanted ${JSON.stringify(wanted)}: ${JSON.stringify(c)}`);
            }
          }
        }
      }
    }
  }
  assert.equal(n, 9 * 3 * 9 * 13 * 2);
  // a drag with a huge start still gives numbers (the drag adds a finite offset to a size the page measured)
  const d = dragLayout({ left: 1e308, right: 1e308 }, 'right', 1e308, { dx: -5, dy: 0 }, { width: 1440, height: 900 });
  assert.ok(Number.isInteger(d.left) && Number.isInteger(d.right) && centreOf(1440, d) >= 720, JSON.stringify(d));
});

test('clampLayout: it shrinks what is shown only; the wanted sizes it was given are not changed', () => {
  const wanted = { left: 700, right: 800, log: 300 };
  const before = JSON.stringify(wanted);
  clampLayout(wanted, { width: 1440, height: 800 });
  clampLayout(wanted, { width: 1440, height: 800 }, 'left');
  assert.equal(JSON.stringify(wanted), before);
  // a drag of the log at a width where the columns are shrunk wants the log only: the columns follow their stored wish (they are wishes already)
  const vp = { width: 1440, height: 800 };
  const sized = dragLayout(clampLayout({ left: 700, right: 800 }, vp), 'log', 190, { dx: 0, dy: -50 }, vp);
  assert.deepEqual(wantedAfterDrag({ left: 700, right: 800 }, sized, 'log', vp), { left: 328, right: 375, log: 240 }, 'a wish that was stored stays wanted, at the width on show (as before)');
});

test('page: a stored 700 and 800 are shown shrunk at 1440, shrunk less at 2560, as stored at 3200; the store keeps 700 and 800, and the one resize listener does it all', async () => {
  const page = await bootPage({ runs: [], runDocs: {}, width: 1468, storage: { [K('layout.left')]: '700', [K('layout.right')]: '800' } });
  try {
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['328px', '375px'], 'a grid of 1440');
    assert.equal(page.windowListeners.resize.length, 1, 'one resize listener, as before');
    const kept = () => [page.storage[K('layout.left')], page.storage[K('layout.right')]];
    assert.deepEqual(kept(), ['700', '800']);
    const mutations = [];
    page.doc.mut = mutations;
    const timers = page.timers.timeouts.size;
    widen(page, 1280);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['291px', '332px'], 'a grid of 1280');
    widen(page, 2560);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['589px', '674px'], 'a grid of 2560: still shrunk (700 + 800 is over 1264)');
    assert.deepEqual(kept(), ['700', '800'], 'the stored numbers are untouched');
    widen(page, 3032);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['700px', '800px'], 'from a grid of 3032 they show as stored');
    widen(page, 3200);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['700px', '800px']);
    widen(page, 1440);
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['328px', '375px'], 'and back: the shrink follows the window both ways');
    assert.deepEqual(kept(), ['700', '800']);
    assert.deepEqual(mutations, [], 'no node was added, removed or moved by a resize');
    assert.equal(page.timers.timeouts.size, timers, 'no timer was made');
  } finally { page.restore(); }
});

test('page: a window of 1228 and one of 1948 with the defaults keep the defaults (they already leave half)', async () => {
  for (const [width, want] of [[1228, [259, 324]], [1468, [312, 391]], [1948, [419, 524]]]) {
    const page = await bootPage({ runs: [], runDocs: {}, width });
    try {
      assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], [`${want[0]}px`, `${want[1]}px`], `window ${width}`);
    } finally { page.restore(); }
  }
});

test('page: a drag at 1440 stops where the centre would fall under half, and stores the dragged column only', async () => {
  const page = await bootPage({ runs: [], runDocs: {}, width: 1468 });
  try {
    await drag(page, '#handle-left', [500, 100], [1500, 100]); // a pull of 1000 px to the right
    assert.deepEqual([css(page, '--left-w'), css(page, '--right-w')], ['313px', '391px'], 'the left column stops, the right one stays');
    assert.equal(page.storage[K('layout.left')], '313');
    assert.equal(page.storage[K('layout.right')], undefined, 'the other side stays a default');
    widen(page, 2560);
    assert.equal(css(page, '--right-w'), '600px', 'and it follows the window');
  } finally { page.restore(); }
});

// =====================================================================================================================
// 3. the last run is remembered after it loaded
// =====================================================================================================================

test('last run (page): a run whose read failed is not remembered, and an older remembered run stays', async () => {
  const a = runOf('wf_a', ['w:U1']);
  const b = runOf('wf_b', ['w:U1']);
  // wf_a is listed and loaded, but the server has no document for it (a 404): it is the first loaded run, so the page asks for it
  const none = await bootPage({ runs: [summary(a), summary(b)], runDocs: docs(b), hash: '#range=all' });
  try {
    assert.deepEqual(shownRun(none), ['wf_a'], 'the page asked for the run');
    assert.equal(none.storage[K('lastRun')], undefined, 'it did not load: nothing is remembered');
  } finally { none.restore(); }
  // an older remembered run is not replaced by one that failed
  const kept = await bootPage({ runs: [summary(a), summary(b)], runDocs: docs(b), hash: '#range=all', storage: { [K('lastRun')]: 'wf_b' } });
  try {
    assert.deepEqual(shownRun(kept), ['wf_b'], 'the remembered run opens and loads');
    const row = async (id) => {
      if (kept.el('#rp-panel').hidden) await kept.click(kept.el('#rp-trigger'));
      await kept.click(kept.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === id));
    };
    await row('wf_a');
    assert.deepEqual(shownRun(kept), ['wf_b', 'wf_a']);
    assert.equal(kept.storage[K('lastRun')], 'wf_b', 'a click on a run that does not load leaves the older last run as it was');
  } finally { kept.restore(); }
  // a run that is only listed and cannot be read is not remembered either
  const cold = await bootPage({ runs: [COLD('wf_cold')], runDocs: {}, hash: '#range=all', storage: { [K('lastRun')]: 'wf_cold' } });
  try {
    assert.deepEqual(shownRun(cold), ['wf_cold']);
    assert.equal(cold.storage[K('lastRun')], 'wf_cold', 'the stored value is as it was');
    const empty = await bootPage({ runs: [COLD('wf_cold')], runDocs: {}, hash: '#range=all' });
    try { assert.equal(empty.storage[K('lastRun')], undefined); } finally { empty.restore(); }
  } finally { cold.restore(); }
});

test('last run (page): the run is written when its data arrived, not before; a late answer of a run that was left writes nothing', async () => {
  const a = runOf('wf_a', ['w:U1']);
  const b = runOf('wf_b', ['w:U1']);
  let release;
  const held = new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => structuredClone(a) }); });
  const answer = (u) => (u === '/api/runs/wf_a' ? held : undefined);
  const page = await bootPage({ runs: [summary(a), summary(b)], runDocs: docs(a, b), hash: '#range=all', answer });
  try {
    assert.deepEqual(shownRun(page), ['wf_a'], 'the first loaded run was asked for');
    assert.equal(page.storage[K('lastRun')], undefined, 'its answer is still out: nothing is remembered yet');
    await page.click(page.el('#rp-trigger'));
    await page.click(page.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === 'wf_b'));
    assert.equal(page.storage[K('lastRun')], 'wf_b', 'the run chosen is remembered when its data is here');
    release();
    await page.flush();
    assert.equal(page.storage[K('lastRun')], 'wf_b', 'the late answer of wf_a, which is no longer chosen, writes nothing');
  } finally { page.restore(); }
});

test('last run (page): a reconnect reads the run again and writes nothing; a run is written once its data is here (no write while the request is out)', async () => {
  const a = runOf('wf_a', ['w:U1']);
  let release;
  const held = new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => structuredClone(a) }); });
  const page = await bootPage({ runs: [summary(a)], runDocs: docs(a), hash: '#range=all', answer: (u) => (u === '/api/runs/wf_a' ? held : undefined) });
  try {
    const writes = [];
    const set = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = (k, v) => { writes.push(k); set(k, v); };
    assert.deepEqual(writes, [], 'nothing was written while the request was out');
    release();
    await page.flush();
    assert.deepEqual(writes.filter((k) => k === K('lastRun')), [K('lastRun')], 'written once, when the data arrived');
    page.emit('hello', { mode: 'real', version: '1' });
    await page.flush();
    assert.deepEqual(writes.filter((k) => k === K('lastRun')), [K('lastRun')], 'a reconnect writes nothing more');
  } finally { page.restore(); }
});

test('last run (source): selectRun does not write the run before its request, and its one write is guarded by the data and the replay', () => {
  const src = readWeb('app.js');
  const calls = [...src.matchAll(/rememberLastRun\(/g)];
  assert.equal(calls.length, 2, 'the definition and one call');
  const call = src.indexOf('rememberLastRun(id)');
  const fetched = src.lastIndexOf('await Promise.all([', call);
  assert.ok(fetched > 0 && fetched < call, 'the call comes after the requests');
  assert.match(src.slice(call - 120, call + 30), /if \(run && !replayOnShow\(\)\) rememberLastRun\(id\);/);
  const token = src.lastIndexOf('if (token !== state.sel) return;', call);
  assert.ok(token > fetched && call - token < 400, 'and after the check that the run is still the chosen one');
  const start = src.indexOf('async function selectRun');
  assert.equal(src.slice(start, fetched).includes('rememberLastRun'), false, 'nothing is written before the requests');
});

// =====================================================================================================================
// 4. the columns do not stretch over the whole centre
// =====================================================================================================================

test('matrixColumns: the unit column is at most 280 px, each role column at most 160 px, the minimums are as they were, and an empty last track takes the rest', () => {
  assert.equal(matrixColumns(1), 'minmax(120px, 280px) repeat(1, minmax(44px, 160px)) minmax(0, 1fr)', 'a run with one agent: one role, one unit');
  assert.equal(matrixColumns(3), 'minmax(120px, 280px) repeat(3, minmax(44px, 160px)) minmax(0, 1fr)');
  assert.equal(matrixColumns(15), 'minmax(120px, 280px) repeat(15, minmax(44px, 160px)) minmax(0, 1fr)');
  // no unit or role track grows without a limit: the one flexible track is the last, and no cell goes into it
  const tracks = matrixColumns(4).replace(/repeat\(4, ([^)]*\))\)/, '$1 x4').split(/ (?=minmax)/);
  assert.equal(tracks.length, 3, 'the unit track, the role tracks (repeated) and the last track');
  assert.deepEqual(tracks.slice(0, 2).map((t) => /fr/.test(t)), [false, false], 'the unit and role tracks have no fr');
  assert.equal(tracks[2], 'minmax(0, 1fr)', 'the last track holds nothing back from the others: its minimum is 0');
  assert.equal((matrixColumns(4).match(/fr/g) || []).length, 1, 'one flexible track only');
});

test('matrixColumns: a count that is 0, negative, not whole or not a number gives the unit track alone (repeat(0, ...) is not valid CSS)', () => {
  for (const bad of [0, -1, -3, NaN, Infinity, -Infinity, 2.5, undefined, null, '3', '', {}, [], [3], true]) {
    assert.equal(matrixColumns(bad), 'minmax(120px, 280px)', String(JSON.stringify(bad) ?? bad));
  }
});

test('matrix (page): the grid gets matrixColumns for the roles of the run, and a run with one role and one unit lays out at the maxima', async () => {
  const one = runOf('wf_1', ['solo:U']);
  const three = runOf('wf_3', ['a:U1', 'b:U1', 'c:U2']);
  const page = await bootPage({ runs: [summary(one), summary(three)], runDocs: docs(one, three), hash: '#range=all' });
  try {
    const grid = page.el('#matrix-grid');
    assert.equal(grid.props.get('grid-template-columns'), matrixColumns(1), 'one role');
    await page.click(page.el('#rp-trigger'));
    await page.click(page.el('#rp-list').childNodes.find((r) => r.attrs.get('data-run') === 'wf_3'));
    assert.equal(grid.props.get('grid-template-columns'), 'minmax(120px, 280px) repeat(3, minmax(44px, 160px)) minmax(0, 1fr)', 'three roles');
  } finally { page.restore(); }
});

test('style.css: the matrix grid and the phase lanes pack to the start; a lane is at most 360 px, with the minimum it had', () => {
  const style = readWeb('style.css');
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(style);
    assert.ok(m, `style.css has a ${sel} rule`);
    return new Map(m[1].split(';').map((d) => d.split(':').map((x) => x.trim())).filter((d) => d.length >= 2).map(([k, ...v]) => [k, v.join(':')]));
  };
  const lanes = rule('.lanes');
  assert.equal(lanes.get('grid-auto-columns'), 'minmax(180px, 360px)');
  assert.equal(lanes.get('justify-content'), 'start');
  assert.equal(lanes.get('overflow-x'), 'auto', 'a centre narrower than the minimums still scrolls');
  assert.equal(lanes.get('grid-auto-flow'), 'column');
  const matrix = rule('.matrix');
  assert.equal(matrix.get('justify-content'), 'start');
  assert.equal(matrix.get('display'), 'grid');
  assert.doesNotMatch(style, /minmax\(180px, 1fr\)/, 'the old lane width is gone');
  // the narrow one-column layout is as it was
  const media = /@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/.exec(style)?.[1] ?? '';
  assert.match(media, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(media, /\.col\s*\{[^}]*overflow:\s*visible/);
});

test('style.css and matrixColumns: the round history spans the whole grid, and the label of a row starts in the first column, so no cell goes into the last track', () => {
  const style = readWeb('style.css');
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(style);
    assert.ok(m, `style.css has a ${sel} rule`);
    return new Map(m[1].split(';').map((d) => d.split(':').map((x) => x.trim())).filter((d) => d.length >= 2).map(([k, ...v]) => [k, v.join(':')]));
  };
  // the two halves go together: the last track is empty only because every row starts in column 1; and the history is as wide as the grid
  // only because it spans every track, the last one included (with a grid of the capped tracks alone it would be 444 px wide for one role)
  assert.equal(rule('.mrow-label').get('grid-column'), '1', 'a row starts in the first column (auto-placement would put its label in the last track otherwise)');
  assert.equal(rule('.hist').get('grid-column'), '1 / -1', 'the history spans every track');
  assert.match(matrixColumns(1), / minmax\(0, 1fr\)$/, 'the template ends with the flexible track that makes the history as wide as the centre');
  // a template without that track would leave the history as wide as the capped columns
  assert.equal(matrixColumns(1).split(' ').filter((t) => t.includes('fr')).length, 1);
  // the head row and the rows are placed by order: the unit head, one head for each role, then a label and one cell for each role (no spacer)
  const app = readWeb('app.js');
  assert.match(app, /const specs = \[specOf\(keyOf\('head-unit'\)/);
  assert.doesNotMatch(app, /keyOf\('(?:spacer|filler|end)'/, 'no element is added to fill the last track');
});

test('app.js: the matrix template is not written in the page any more; it comes from matrixColumns', () => {
  const src = readWeb('app.js');
  assert.doesNotMatch(src, /minmax\(120px, 1\.4fr\)/);
  assert.doesNotMatch(src, /repeat\(\$\{m\.roles\.length\}/);
  assert.match(src, /setStyleProp\(grid, 'grid-template-columns', matrixColumns\(m\.roles\.length\)\);/);
  // the comments of the old behaviour are gone
  assert.doesNotMatch(src, /it beats the\s+running one/);
  assert.doesNotMatch(src, /the run opened last: written when it differs/);
  const lib = readWeb('lib.js');
  assert.doesNotMatch(lib, /so two columns at half the width each cannot leave no centre/);
});
