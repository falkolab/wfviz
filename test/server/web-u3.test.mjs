// test/server/web-u3.test.mjs (node web-steady): the pure part of the steady UI in web/lib.js. What changed between two drawings
// (planPatch, patchList), sizes of the columns and the log, the fallback matrix, the elapsed clock, the tests rows. The page has no
// test runner; the checks of the page itself are static (what app.js, index.html and style.css contain) plus a fake DOM that
// counts writes, so "an element that did not change is not touched" is checked on the real patch code.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CENTER_MIN, HANDLE_WIDTH, LAYOUT_DEFAULTS, appendItems, attrDiff, barEnd, captionOf, clampLayout, clearList, clockTick, countsFromNow, createListState,
  createNode, createSpecEl, dedupeKeys, dragLayout, dropItems, elapsedFact, entryKeys, fallbackRows, findingCounts, groupOf, keyOf, latestRecorded, matrixCell,
  matrixModel, matrixRows, notParsedNote, parseStoredSize, patchList, planPatch, rowTags, sameJson, specOf, testRows, unitState, updateNode, updateSpecEl,
} from '../../web/lib.js';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(REPO, 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

const reg = (value, from = 'f:1') => ({ value, prov: 'registered', from });
const inf = (value, method = 'label-pattern') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });

function agent(id, label, over = {}) {
  const m = /^([^:#]+)(?::([^#]+))?(?:#(.+))?$/.exec(label ?? '');
  return {
    id,
    label: label ? reg(label) : unk('no label'),
    role: m ? inf(m[1]) : unk(), unit: m && m[2] ? inf(m[2]) : unk('no unit'), round: unk('no round'), tag: m && m[3] ? inf(m[3]) : unk('no tag'),
    phase: reg('P1'), state: reg('done'), startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(), ...over,
  };
}
function run(agents, over = {}) {
  return {
    id: 'wf_x', status: { value: 'running', prov: 'inferred', method: 'no-final-file' },
    agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] }, ...over,
  };
}

// ---- a fake DOM: just enough of an element to run the patch code, counting every write --------------------------------

class FakeEl {
  constructor(tag, ns = null) {
    this.tag = tag;
    this.ns = ns;
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.classes = new Set();
    this.props = new Map();
    this.html = '';
    this.writes = 0;
    this.moves = 0;
    const self = this;
    this.classList = {
      add(t) { self.writes++; self.classes.add(t); },
      remove(t) { self.writes++; self.classes.delete(t); },
      contains: (t) => self.classes.has(t),
    };
    this.style = {
      setProperty(k, v) { self.writes++; self.props.set(k, v); },
      removeProperty(k) { self.writes++; self.props.delete(k); },
    };
  }

  setAttribute(k, v) {
    this.writes++;
    this.attrs.set(k, String(v));
    if (k === 'class') this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  removeAttribute(k) { this.writes++; this.attrs.delete(k); }

  set innerHTML(v) { this.writes++; this.html = v; }

  get innerHTML() { return this.html; }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    node.moves++;
    if (ref === null || ref === undefined) this.childNodes.push(node);
    else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    assert.ok(i >= 0, 'removeChild: the element is a child of this parent');
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
}
const DOC = { createElement: (t) => new FakeEl(t), createElementNS: (ns, t) => new FakeEl(t, ns) };
const created = [];
const mk = (spec) => { const el = createSpecEl(DOC, spec); created.push(el); return el; };
const textsOf = (parent) => parent.childNodes.map((c) => c.html);
const keyedSpec = (k, html = k, attrs = {}) => specOf(keyOf('i', k), attrs, html);

// ---- planPatch ----------------------------------------------------------------------------------------------------------

const KEY = (x) => x.k;
const it = (k, v = 0) => ({ k, v });

test('planPatch: the first drawing adds everything, in order; nothing is removed or updated', () => {
  const p = planPatch([], [it('a'), it('b'), it('c')], KEY);
  assert.deepEqual(p.add.map((x) => [x.key, x.index]), [['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual([p.update, p.remove, p.moves], [[], [], []]);
  assert.deepEqual(p.order, ['a', 'b', 'c']);
  assert.deepEqual(planPatch(undefined, undefined, KEY), { add: [], update: [], remove: [], order: [], moves: [] }, 'no list is an empty list');
});

test('planPatch: an item inserted in the middle is the only change; the others keep their place', () => {
  const p = planPatch([it('a'), it('b'), it('c')], [it('a'), it('x'), it('b'), it('c')], KEY);
  assert.deepEqual(p.add.map((x) => [x.key, x.index]), [['x', 1]]);
  assert.deepEqual([p.update, p.remove, p.moves], [[], [], []]);
  assert.deepEqual(p.order, ['a', 'x', 'b', 'c']);
});

test('planPatch: a removed key is reported with its item; a changed one is an update (compared by value, not identity)', () => {
  const prev = [it('a', 1), it('b', 2), it('c', 3)];
  const next = [it('a', 1), it('c', 30)]; // new objects with the same content for a: not an update
  const p = planPatch(prev, next, KEY);
  assert.deepEqual(p.remove, [{ key: 'b', item: prev[1] }]);
  assert.deepEqual(p.update.map((u) => [u.key, u.prev.v, u.item.v, u.index]), [['c', 3, 30, 1]]);
  assert.deepEqual([p.add, p.moves], [[], []]);
});

test('planPatch: a reorder moves only what has to move (the longest run in order stays)', () => {
  assert.deepEqual(planPatch([it('a'), it('b'), it('c')], [it('c'), it('a'), it('b')], KEY).moves, ['c']);
  assert.deepEqual(planPatch([it('a'), it('b'), it('c'), it('d')], [it('b'), it('c'), it('d'), it('a')], KEY).moves, ['a']);
  const rev = planPatch([it('a'), it('b'), it('c'), it('d')], [it('d'), it('c'), it('b'), it('a')], KEY);
  assert.equal(rev.moves.length, 3, 'a full reverse keeps one');
  assert.deepEqual(planPatch([it('a'), it('b')], [it('a'), it('b')], KEY).moves, []);
});

test('planPatch: a key twice in either list throws, a non-string key throws, neither input is changed', () => {
  assert.throws(() => planPatch([], [it('a'), it('a')], KEY), /duplicate key in nextItems/);
  assert.throws(() => planPatch([it('a'), it('a')], [], KEY), /duplicate key in prevItems/);
  assert.throws(() => planPatch([], [{ k: 5 }], KEY), /not a string/);
  assert.throws(() => planPatch([], [{}], KEY), /not a string/);
  const prev = [it('a', 1), it('b', 2)];
  const next = [it('b', 3), it('c', 4), it('a', 1)];
  const before = JSON.stringify([prev, next]);
  planPatch(prev, next, KEY);
  assert.equal(JSON.stringify([prev, next]), before);
});

test('planPatch: the equal function decides what an update is', () => {
  const prev = [it('a', 1)];
  const next = [it('a', 2)];
  assert.equal(planPatch(prev, next, KEY, () => true).update.length, 0);
  assert.equal(planPatch(prev, next, KEY, () => false).update.length, 1);
  assert.equal(sameJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(sameJson({ a: 1 }, { a: 2 }), false);
});

test('keys: parts are joined as JSON, so a name that holds a separator cannot collide; the unknown phase, a phase titled like it, a marker and a line are apart', () => {
  assert.notEqual(keyOf('a|b', 'c'), keyOf('a', 'b|c'));
  assert.notEqual(keyOf('phase-unknown'), keyOf('phase', 'phase unknown'));
  assert.notEqual(keyOf('missing', 5), keyOf('seq', 5), 'a marker from seq 5 is not the line of seq 5');
  assert.notEqual(keyOf('cell', 'u', 'r'), keyOf('cell', 'u,r'));
  const twice = dedupeKeys([keyedSpec('a'), keyedSpec('b'), keyedSpec('a'), keyedSpec('a')]);
  assert.equal(new Set(twice.map((x) => x.key)).size, 4, 'a repeated key gets a suffix and no item is lost');
  assert.equal(twice[0].key, keyOf('i', 'a'), 'the first keeps its key');
  assert.doesNotThrow(() => planPatch([], twice, (x) => x.key));
});

// ---- patchList on the fake DOM -------------------------------------------------------------------------------------------

function listOnFake(over = {}) {
  const parent = new FakeEl('div');
  const st = createListState();
  const updates = [];
  const opts = { create: mk, update: (el, prev, item) => { updates.push(item.key); updateSpecEl(el, prev, item); }, ...over };
  return { parent, st, updates, sync: (items) => patchList(parent, st, items, opts) };
}
const totalWrites = (els) => els.reduce((n, e) => n + e.writes, 0);

test('patchList: a second drawing of the same data does not touch any element (no attribute, class, style or text write, no move)', () => {
  const L = listOnFake();
  const make = () => [keyedSpec('a', 'A', { class: 'cell st-done', style: '--c:red', 'data-agent': 'a' }), keyedSpec('b', 'B', { class: 'cell' }), keyedSpec('c', 'C')];
  L.sync(make());
  const els = [...L.parent.childNodes];
  assert.deepEqual(textsOf(L.parent), ['A', 'B', 'C']);
  const writes = totalWrites(els);
  const moves = els.map((e) => e.moves);
  const plan = L.sync(make());
  assert.deepEqual([plan.add, plan.update, plan.remove, plan.moves], [[], [], [], []]);
  assert.equal(totalWrites(els), writes, 'no write on any element');
  assert.deepEqual(els.map((e) => e.moves), moves, 'no element was moved');
  assert.ok(els.every((e, i) => e === L.parent.childNodes[i]), 'the same element nodes, in the same place');
  assert.deepEqual(L.updates, []);
});

test('patchList: an insert in the middle creates one element and leaves the others untouched; a removal removes only its element', () => {
  const L = listOnFake();
  L.sync([keyedSpec('a'), keyedSpec('b'), keyedSpec('c')]);
  const [a, b, c] = L.parent.childNodes;
  const w = totalWrites([a, b, c]);
  L.sync([keyedSpec('a'), keyedSpec('x'), keyedSpec('b'), keyedSpec('c')]);
  assert.deepEqual(textsOf(L.parent), ['a', 'x', 'b', 'c']);
  assert.deepEqual([L.parent.childNodes[0], L.parent.childNodes[2], L.parent.childNodes[3]], [a, b, c], 'the old ones are the same nodes');
  assert.equal(totalWrites([a, b, c]), w);
  assert.equal([a, b, c].some((e) => e.moves > 1), false, 'an old element was moved although only one was inserted');
  L.sync([keyedSpec('a'), keyedSpec('x'), keyedSpec('c')]);
  assert.deepEqual(textsOf(L.parent), ['a', 'x', 'c']);
  assert.equal(L.parent.childNodes[2], c);
  assert.equal(b.parentNode, null, 'the removed element is out of the parent');
  assert.equal(L.st.els.size, 3, 'and out of the Map');
});

test('patchList: a changed item is updated in place: the same element, only the attributes and text that differ are written, a class the page added stays', () => {
  const L = listOnFake();
  L.sync([keyedSpec('a', 'one', { class: 'cell st-running', style: '--c:red;left:1%', title: 't' }), keyedSpec('b')]);
  const a = L.parent.childNodes[0];
  a.classList.add('flash'); // the page's own live highlight
  a.style.setProperty('--fd', '-300ms');
  const before = a.writes;
  L.sync([keyedSpec('a', 'two', { class: 'cell st-done', style: '--c:red;left:2%' }), keyedSpec('b')]);
  assert.equal(L.parent.childNodes[0], a, 'same element');
  assert.deepEqual(L.updates, [keyOf('i', 'a')], 'only the changed item');
  assert.equal(a.html, 'two');
  assert.ok(a.classes.has('flash'), 'the highlight class is not undone by a data update');
  assert.equal(a.props.get('--fd'), '-300ms', 'nor is the highlight delay');
  assert.equal(a.classes.has('st-running'), false);
  assert.equal(a.classes.has('st-done'), true);
  assert.equal(a.props.get('left'), '2%');
  assert.equal(a.attrs.has('title'), false, 'an attribute that is gone is removed');
  assert.ok(a.writes - before <= 6, 'a handful of writes, not a rebuild');
});

test('patchList: a reorder moves only the elements that have to move, and the final order is right', () => {
  const L = listOnFake();
  L.sync(['a', 'b', 'c', 'd', 'e'].map((k) => keyedSpec(k)));
  const els = Object.fromEntries(L.parent.childNodes.map((e) => [e.html, e]));
  const moves = Object.fromEntries(Object.entries(els).map(([k, e]) => [k, e.moves]));
  L.sync(['e', 'a', 'b', 'c', 'd'].map((k) => keyedSpec(k)));
  assert.deepEqual(textsOf(L.parent), ['e', 'a', 'b', 'c', 'd']);
  const movedNow = Object.entries(els).filter(([k, e]) => e.moves !== moves[k]).map(([k]) => k);
  assert.deepEqual(movedNow, ['e'], 'one element moved');
});

test('patchList: random lists in random order always end in the right order, with the same nodes for the keys that stayed', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = () => { const keys = [...'abcdefghij'].filter(() => rnd() < 0.6); for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; } return keys; };
  const L = listOnFake();
  let prev = [];
  for (let n = 0; n < 300; n++) {
    const next = pick();
    const before = new Map(L.parent.childNodes.map((e) => [e.html, e]));
    L.sync(next.map((k) => keyedSpec(k)));
    assert.deepEqual(textsOf(L.parent), next, `round ${n}`);
    for (const k of next) if (prev.includes(k)) assert.equal(L.parent.childNodes.find((e) => e.html === k), before.get(k), `${k} kept its node`);
    assert.equal(L.st.els.size, next.length);
    prev = next;
  }
});

test('appendItems / dropItems / clearList: lines are added at the bottom without comparing the rest, dropped by a rule, and cleared', () => {
  const L = listOnFake();
  const spec = (n) => ({ ...keyedSpec(`l${n}`, `line ${n}`), seq: n });
  L.sync([1, 2, 3].map(spec));
  const first = L.parent.childNodes[0];
  appendItems(L.parent, L.st, [4, 5].map(spec), { create: mk });
  assert.deepEqual(textsOf(L.parent), ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
  assert.equal(L.parent.childNodes[0], first);
  assert.throws(() => appendItems(L.parent, L.st, [spec(4)], { create: mk }), /duplicate key/);
  dropItems(L.parent, L.st, (s) => s.seq < 3);
  assert.deepEqual(textsOf(L.parent), ['line 3', 'line 4', 'line 5']);
  assert.equal(L.st.items.length, 3);
  // the Map and the items agree after the fast paths, so the next full drawing diffs against the real page
  const plan = L.sync([3, 4, 5, 6].map(spec));
  assert.deepEqual(plan.add.map((a) => a.key), [keyOf('i', 'l6')]);
  assert.deepEqual([plan.update, plan.remove, plan.moves], [[], [], []]);
  clearList(L.parent, L.st);
  assert.deepEqual([L.parent.childNodes.length, L.st.els.size, L.st.items.length], [0, 0, 0]);
});

// ---- elements as data ----------------------------------------------------------------------------------------------------

test('specOf: an attribute that is null, undefined or false is left out; true is an empty attribute; values are text', () => {
  const s = specOf('k', { a: 1, b: null, c: undefined, d: false, e: true, f: '' }, '<i>x</i>', 'span');
  assert.deepEqual(s, { key: 'k', tag: 'span', attrs: { a: '1', e: '', f: '' }, html: '<i>x</i>' });
});

test('attrDiff: class is a token list, style a property list; only what differs is named', () => {
  const d = attrDiff({ class: 'cell st-running sel', style: '--c:red;left:1%', title: 'a', 'data-n': '1' }, { class: 'cell st-done sel', style: '--c:red;left:2%;width:3%', 'data-n': '1', 'aria-label': 'x' });
  assert.deepEqual(d.classAdd, ['st-done']);
  assert.deepEqual(d.classRemove, ['st-running']);
  assert.deepEqual(d.styleSet, { left: '2%', width: '3%' });
  assert.deepEqual(d.styleRemove, []);
  assert.deepEqual(d.set, { 'aria-label': 'x' });
  assert.deepEqual(d.remove, ['title']);
  assert.deepEqual(attrDiff({ class: 'a', style: 'x:1' }, { class: 'a', style: 'x:1' }), { set: {}, remove: [], classAdd: [], classRemove: [], styleSet: {}, styleRemove: [] });
  assert.deepEqual(attrDiff({ style: 'a:1;b:2' }, { style: 'a:1' }).styleRemove, ['b']);
  assert.doesNotThrow(() => attrDiff(undefined, undefined));
});

test('createSpecEl: attributes are set as raw values (a quote or a tag in a label stays text); an svg spec gets its namespace', () => {
  const nasty = 'a"b<img src=x onerror=alert(1)>&\'';
  const el = createSpecEl(DOC, specOf('k', { 'data-agent': nasty, title: nasty }, '<b>x</b>'));
  assert.equal(el.attrs.get('data-agent'), nasty, 'the same text comes back out of data-agent, so a lookup by it works');
  assert.equal(el.html, '<b>x</b>');
  assert.equal(createSpecEl(DOC, { ...specOf('k', {}, '', 'path'), ns: 'http://www.w3.org/2000/svg' }).ns, 'http://www.w3.org/2000/svg');
  assert.equal(createSpecEl(DOC, specOf('k', {}, '')).writes, 0, 'an empty spec writes nothing');
});

// ---- sizes ---------------------------------------------------------------------------------------------------------------

const VP = { width: 1400, height: 800 };

test('layout: the defaults apply when nothing is wanted; a column is 160 px .. half the width, the log 80 px .. 60% of the height', () => {
  assert.deepEqual(clampLayout({}, VP), LAYOUT_DEFAULTS);
  assert.deepEqual(clampLayout(undefined, VP), LAYOUT_DEFAULTS);
  assert.equal(clampLayout({ left: 50 }, VP).left, 160);
  assert.equal(clampLayout({ left: 160 }, VP).left, 160);
  assert.equal(clampLayout({ left: 9999, right: 160 }, VP).left, 700, 'half of 1400');
  assert.equal(clampLayout({ right: 9999, left: 160 }, VP).right, 700);
  assert.equal(clampLayout({ log: 10 }, VP).log, 80);
  assert.equal(clampLayout({ log: 9999 }, VP).log, 480, '60% of 800');
  assert.equal(clampLayout({ log: 300 }, VP).log, 300);
  assert.equal(clampLayout({ left: -5, right: 0, log: -1 }, VP).left, 160, 'a negative wish is clamped, not forgotten');
});

test('layout: a wish that is not a finite number is the default', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'x', null, undefined, {}]) {
    assert.deepEqual(clampLayout({ left: bad, right: bad, log: bad }, VP), LAYOUT_DEFAULTS, String(bad));
  }
});

test('layout: two columns never take the centre: it keeps CENTER_MIN, in a window of any width above one column', () => {
  for (const width of [1101, 1200, 1400, 2000, 3000]) {
    for (const prefer of [null, 'left', 'right']) {
      const s = clampLayout({ left: 9999, right: 9999, log: 100 }, { width, height: 800 }, prefer);
      const centre = width - s.left - s.right - 2 * HANDLE_WIDTH;
      assert.ok(centre >= CENTER_MIN, `width ${width}, prefer ${prefer}: centre ${centre}`);
      assert.ok(s.left >= 160 && s.right >= 160 && s.left <= width / 2 && s.right <= width / 2);
    }
  }
  const dragged = clampLayout({ left: 9999, right: 600 }, { width: 1400, height: 800 }, 'left');
  assert.equal(dragged.right, 600, 'the column being dragged gives way to the limit, the other keeps its size');
  assert.equal(dragged.left, 1400 - 600 - CENTER_MIN - 2 * HANDLE_WIDTH);
  const other = clampLayout({ left: 600, right: 9999 }, { width: 1400, height: 800 }, 'right');
  assert.deepEqual([other.left, other.right], [600, 1400 - 600 - CENTER_MIN - 2 * HANDLE_WIDTH]);
  const both = clampLayout({ left: 700, right: 700 }, { width: 1400, height: 800 });
  assert.ok(Math.abs(both.left - both.right) <= 1, 'with no one dragging both shrink in proportion');
});

test('layout: a window with no size gives the minimums, not a crash', () => {
  assert.deepEqual(clampLayout({ left: 300, right: 300, log: 300 }, { width: 0, height: 0 }), { left: 160, right: 160, log: 80 });
  assert.doesNotThrow(() => clampLayout({}, undefined));
});

test('layout: a stored text is a size only when it is a positive finite number', () => {
  assert.equal(parseStoredSize('300'), 300);
  assert.equal(parseStoredSize('312.5'), 312.5);
  for (const bad of [null, undefined, '', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', '-5', '0', '12px', 7, {}]) assert.equal(parseStoredSize(bad), null, String(bad));
});

test('layout: dragging moves the left column with the pointer, the right column and the log against it; the result is clamped', () => {
  const w = { left: 240, right: 300, log: 190 };
  assert.equal(dragLayout(w, 'left', 240, { dx: 60, dy: 0 }, VP).left, 300);
  assert.equal(dragLayout(w, 'right', 300, { dx: -60, dy: 0 }, VP).right, 360);
  assert.equal(dragLayout(w, 'log', 190, { dx: 0, dy: -50 }, VP).log, 240);
  assert.equal(dragLayout(w, 'left', 240, { dx: -5000, dy: 0 }, VP).left, 160);
  assert.equal(dragLayout(w, 'right', 300, { dx: 5000, dy: 0 }, VP).right, 160);
  assert.equal(dragLayout(w, 'log', 190, { dx: 0, dy: 5000 }, VP).log, 80);
  assert.equal(dragLayout(w, 'log', 190, { dx: 0, dy: -5000 }, VP).log, 480);
  assert.deepEqual(dragLayout(w, 'nothing', 1, { dx: 9, dy: 9 }, VP), clampLayout(w, VP), 'an unknown handle changes nothing');
  assert.deepEqual(w, { left: 240, right: 300, log: 190 }, 'the wanted sizes are not changed');
});

// ---- the fallback matrix --------------------------------------------------------------------------------------------------

test('fallback matrix: when no label parses, rows are phases in order of first appearance and cells are the labels as they are, in start order', () => {
  const r = run([
    agent('a1', 'Plan the work', { phase: reg('Plan'), startedAt: inf(5000) }),
    agent('a2', 'Write it down', { phase: reg('Build'), startedAt: inf(3000) }),
    agent('a3', 'Check it', { phase: reg('Plan'), startedAt: inf(2000) }),
  ].map((a) => ({ ...a, role: unk('label has no role part'), unit: unk('label has no ":unit" part') })), {});
  r.order = ['a1', 'a2', 'a3']; // the Run's order: a1 appeared first, so Plan is the first row
  const m = matrixModel(r);
  assert.equal(m.mode, 'fallback');
  assert.deepEqual(m.roles, []);
  assert.deepEqual(m.fallback.map((row) => row.title), ['Plan', 'Build'], 'phases in order of first appearance');
  assert.deepEqual(m.fallback[0].cells.map((c) => c.id), ['a3', 'a1'], 'cells in start order, not in the order they came');
  assert.deepEqual(m.fallback[0].cells.map((c) => c.caption.text), ['Check it', 'Plan the work'], 'the label as it is');
  assert.equal(m.unparsed, 3);
  assert.equal(m.note, '3 labels do not parse as role:unit');
});

test('fallback matrix: a cell keeps the label\'s own prov and source; a missing label is the agentId with the Run\'s reason, never split into role and unit', () => {
  const withLabel = agent('a', 'role: not a unit', { label: fin('role: not a unit', '/p/wf_1.json#workflowProgress[2].label') });
  const cap = captionOf(withLabel);
  assert.deepEqual(cap, { text: 'role: not a unit', known: true, prov: 'final', tip: 'final, wf_1.json#workflowProgress[2].label' });
  const noLabel = agent('a77', null, { label: unk('not recorded live before 2.1.271') });
  assert.deepEqual(captionOf(noLabel), { text: 'a77', known: false, prov: 'unknown', tip: 'label unknown: not recorded live before 2.1.271' });
  assert.equal(captionOf(agent('b', 'x', { label: { prov: 'unknown' } })).tip, 'label unknown: not provided by the source');
  assert.equal(captionOf(agent('c', 'x', { label: inf('guessed', 'some-method') })).tip, 'inferred, some-method');
  assert.equal(captionOf(null).text, '');
});

test('fallback matrix: agents with no phase are one row "phase unknown", placed by first appearance, with the Run\'s reason; a phase titled like it is another row', () => {
  const none = (id, label, t) => agent(id, label, { phase: unk('journal "started" line carries no phase'), startedAt: inf(t) });
  const rows = fallbackRows([
    agent('a', 'one', { phase: reg('Build') }),
    none('b', 'two', 10),
    agent('c', 'three', { phase: reg('phase unknown') }),
    none('d', 'four', 5),
    agent('e', 'five', { phase: reg('Build') }),
  ]);
  assert.deepEqual(rows.map((x) => x.title), ['Build', 'phase unknown', 'phase unknown']);
  assert.deepEqual(rows.map((x) => x.phase), ['Build', null, 'phase unknown']);
  assert.equal(new Set(rows.map((x) => x.key)).size, 3, 'the unknown row and a phase of the same title have different keys');
  assert.deepEqual(rows[1].cells.map((c) => c.id), ['d', 'b'], 'in start order');
  assert.equal(rows[1].reason, 'journal "started" line carries no phase');
  assert.equal(rows[0].reason, null);
  assert.deepEqual(fallbackRows([]), []);
  assert.deepEqual(fallbackRows(null), []);
});

test('fallback matrix: when only some labels parse, the matrix shows those and fallback rows show the rest, under a note with the number', () => {
  const r = run([
    agent('a', 'impl:A'), agent('b', 'check:A'), agent('c', 'sentence one'), agent('d', null, { label: unk('older version') }),
  ].map((a) => (a.id === 'd' ? { ...a, role: unk(), unit: unk() } : a.id === 'c' ? { ...a, role: inf('sentence one'), unit: unk('no unit') } : a)));
  const m = matrixModel(r);
  assert.equal(m.mode, 'mixed');
  assert.deepEqual(m.roles, ['impl', 'check']);
  assert.deepEqual(m.rows.map((x) => x.unit), ['A']);
  assert.deepEqual(m.fallback.flatMap((row) => row.cells.map((c) => c.id)).sort(), ['c', 'd'], 'every agent outside the matrix, an agent with no label included');
  assert.equal(m.unparsed, 2);
  assert.equal(m.note, '2 labels do not parse as role:unit');
  assert.equal(notParsedNote(1), '1 label does not parse as role:unit', 'one reads as one');
  assert.equal(matrixModel(run([agent('a', 'impl:A'), agent('c', 'x', { role: unk(), unit: unk() })])).note, '1 label does not parse as role:unit');
});

test('fallback matrix: a run where everything parses has no note and no fallback rows; a run with no agent is empty', () => {
  const m = matrixModel(run([agent('a', 'impl:A'), agent('b', 'check:A')]));
  assert.deepEqual([m.mode, m.note, m.fallback, m.unparsed], ['matrix', null, [], 0]);
  assert.equal(matrixModel(run([])).mode, 'empty');
  assert.equal(matrixModel(null).mode, 'empty');
});

// ---- matrix rows: tags and agents of a cell in start order ----------------------------------------------------------------

test('matrix row: the tags next to a unit are in the order the agents started (not in the order of the role columns)', () => {
  // role columns come in the order impl, check, fix; their agents started in the order r1, r2, r3 = impl, fix, check
  const parsed = [
    agent('i', 'impl:slugify#r1', { startedAt: inf(1000) }),
    agent('c', 'check:slugify#r3', { startedAt: inf(3000) }),
    agent('f', 'fix:slugify#r2', { startedAt: inf(2000) }),
  ];
  const rows = matrixRows(parsed);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ['r1', 'r2', 'r3'], 'start order, not r1 r3 r2');
  assert.deepEqual(rows[0].cells.map((c) => c.role), ['impl', 'check', 'fix'], 'the columns keep their order');
  assert.deepEqual(rowTags([null, ...rows[0].cells]), ['r1', 'r2', 'r3'], 'an empty cell adds nothing');
  assert.deepEqual(rowTags(null), []);
  assert.deepEqual(rowTags([matrixCell([agent('a', 'x:y'), agent('b', 'x:y')])]), [], 'agents with no tag add none');
});

test('matrix cell: each agent of a cell is listed with its tag and its state, in start order, whatever order they come in', () => {
  const a = agent('a', 'fix:S#r1', { startedAt: inf(1000), state: reg('done') });
  const b = agent('b', 'fix:S#r2', { startedAt: inf(2000), state: reg('running') });
  const c = agent('c', 'fix:S', { startedAt: inf(3000), state: { ...reg('running'), interrupted: true, note: 'n' } });
  const cell = matrixCell([c, a, b]);
  assert.deepEqual(cell.members, [
    { id: 'a', tag: 'r1', state: 'done' },
    { id: 'b', tag: 'r2', state: 'running' },
    { id: 'c', tag: null, state: 'interrupted' },
  ]);
  assert.deepEqual(cell.tags, ['r1', 'r2'], 'tags keep their old meaning: the tags that exist');
  assert.equal(cell.count, 3);
  assert.deepEqual(matrixCell([agent('x', 'a:b#only')]).members, [{ id: 'x', tag: 'only', state: 'done' }]);
});

test('matrix rows: a unit shows its latest round and its state from its agents', () => {
  const rows = matrixRows([
    agent('a', 'impl:U#r1', { round: inf(1) }), agent('b', 'impl:U#r2', { round: inf(2), state: reg('running') }), agent('c', 'check:V', { state: reg('failed') }),
  ]);
  assert.deepEqual(rows.map((r) => [r.unit, r.maxRound, r.state, r.agents.length]), [['U', 2, 'running', 2], ['V', null, 'failed', 1]]);
  assert.equal(unitState([agent('a', 'x:y', { state: reg('done') })]), 'done');
  assert.equal(unitState([agent('a', 'x:y', { state: unk() })]), 'unknown');
  assert.equal(unitState([agent('a', 'x:y', { state: { ...reg('running'), interrupted: true } })]), 'interrupted');
});

test('finding counts: one pass, per agent', () => {
  const counts = findingCounts(run([], { recognized: { findings: [{ agentId: 'a' }, { agentId: 'b' }, { agentId: 'a' }], verdicts: [], tests: [] } }));
  assert.equal(counts.get('a'), 2);
  assert.equal(counts.get('b'), 1);
  assert.equal(counts.get('c'), undefined);
  assert.equal(findingCounts(null).size, 0);
});

// ---- the elapsed clock ------------------------------------------------------------------------------------------------------

test('clock: a running run with a start counts up; the tick says how many milliseconds to show', () => {
  const r = run([], { durationMs: unk('run is still running'), startedAt: inf(40000, 'script-file-time') });
  assert.equal(clockTick(r, 100000), 60000);
  assert.equal(clockTick(r, 101000), 61000, 'a second later');
});

test('clock: it stops (null) when the run is final, has its own duration, has no usable start, is not running, or there is no run', () => {
  assert.equal(clockTick(run([], { status: fin('completed'), durationMs: fin(5000), startedAt: inf(1000) }), 9999), null, 'final');
  assert.equal(clockTick(run([], { status: fin('killed'), durationMs: unk('x'), startedAt: inf(1000) }), 9999), null, 'final without a duration');
  assert.equal(clockTick(run([], { status: fin('running'), durationMs: unk('x'), startedAt: inf(1000) }), 9999), 8999, 'a final file that says running does not end the run');
  assert.equal(clockTick(run([], { durationMs: fin(5000), startedAt: inf(1000) }), 9999), null, 'the Run has its own duration: nothing to count');
  assert.equal(clockTick(run([], { durationMs: unk('x'), startedAt: unk('none') }), 9999), null, 'no start');
  assert.equal(clockTick(run([], { durationMs: unk('x'), startedAt: inf(50000) }), 9999), null, 'a start in the future says nothing');
  assert.equal(clockTick(run([], { status: unk('stale'), durationMs: unk('x'), startedAt: inf(1000) }), 9999), null, 'a stale run is not running');
  assert.equal(clockTick(null, 1), null);
  assert.equal(clockTick(undefined, 1), null);
});

// ---- the tests card -------------------------------------------------------------------------------------------------------

test('tests rows: rows of one agent say "label · summary k of n", with n counting every row of that agent, shown or not', () => {
  const a = agent('a', 'check:alpha');
  const b = agent('b', 'plain sentence', { role: inf('plain sentence'), unit: unk('no unit') });
  const tests = [
    { agentId: 'a', path: '$', passed: 1, failed: 0, skipped: 0, method: 'node-test-summary' },
    { agentId: 'b', path: '$', passed: 5, failed: 1, skipped: 0 },
    { agentId: 'a', path: '$', passed: 2, failed: 0, skipped: 0 },
    { agentId: 'a', path: '$.note', passed: 3, failed: 1, skipped: 1 },
  ];
  const rows = testRows(run([a, b], { recognized: { findings: [], verdicts: [], tests } }));
  assert.deepEqual(rows.map((r) => r.caption), ['check:alpha · summary 3 of 3', 'check:alpha · summary 2 of 3', 'plain sentence', 'check:alpha · summary 1 of 3'], 'newest first; an agent with one row has just its label');
  assert.deepEqual(rows.map((r) => [r.k, r.n]), [[3, 3], [2, 3], [1, 1], [1, 3]]);
});

test('tests rows: n and k count all the agent\'s rows even when only the last 8 are shown; the shown rows keep their k', () => {
  const tests = Array.from({ length: 12 }, (_, i) => ({ agentId: 'a', path: '$', passed: i, failed: 0, skipped: 0 }));
  const rows = testRows(run([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests } }));
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => r.k), [12, 11, 10, 9, 8, 7, 6, 5]);
  assert.ok(rows.every((r) => r.n === 12));
  assert.equal(testRows(run([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests } }), { max: 2 }).length, 2);
});

test('tests rows: several summaries of one string share agent and path, so the key adds the ordinal; every key is different', () => {
  const tests = [
    { agentId: 'a', path: '$', passed: 1 }, { agentId: 'a', path: '$', passed: 2 }, { agentId: 'a', path: '$.x', passed: 3 }, { agentId: 'b', path: '$', passed: 4 },
    { agentId: 'a', path: '$', passed: 5 },
  ];
  const rows = testRows(run([agent('a', 'x:y'), agent('b', 'z:w')], { recognized: { findings: [], verdicts: [], tests } }));
  assert.equal(new Set(rows.map((r) => r.key)).size, 5);
  assert.doesNotThrow(() => planPatch([], rows, (r) => r.key));
  const again = testRows(run([agent('a', 'x:y'), agent('b', 'z:w')], { recognized: { findings: [], verdicts: [], tests: [...tests, { agentId: 'b', path: '$', passed: 9 }] } }));
  const was = new Map(rows.map((r) => [r.k + ':' + r.agentId + r.passed, r.key]));
  for (const r of again) if (was.has(r.k + ':' + r.agentId + r.passed)) assert.equal(r.key, was.get(r.k + ':' + r.agentId + r.passed), 'a row keeps its key when a row is added');
});

test('tests rows: role and unit only when the Run has both; a count the summary does not have stays null, never 0 and never made up', () => {
  const both = agent('a', 'check:alpha');
  const roleOnly = agent('b', 'standalone');
  const noAgent = null;
  const rows = testRows(run([both, roleOnly], {
    recognized: { findings: [], verdicts: [], tests: [{ agentId: 'a', passed: 4 }, { agentId: 'b', passed: 1, failed: 0, skipped: 0 }, { agentId: 'gone', failed: 2 }] },
  }));
  const byAgent = Object.fromEntries(rows.map((r) => [r.agentId, r]));
  assert.deepEqual([byAgent.a.role, byAgent.a.unit], ['check', 'alpha']);
  assert.deepEqual([byAgent.b.role, byAgent.b.unit], [null, null], 'a role without a unit is not shown as one');
  assert.deepEqual([byAgent.a.passed, byAgent.a.failed, byAgent.a.skipped], [4, null, null]);
  assert.equal(byAgent.gone.label, 'gone', 'an agent the Run does not have is shown by its id');
  assert.equal(byAgent.gone.role, null);
  assert.deepEqual(testRows(run([])), []);
  assert.deepEqual(testRows(null), []);
});

// ---- the page itself: what can be checked without a browser ------------------------------------------------------------------

test('page: the three handles are in index.html, and app.js reads and writes the stored sizes only inside try/catch', () => {
  const html = read('index.html');
  for (const id of ['handle-left', 'handle-right', 'handle-log']) assert.match(html, new RegExp(`id="${id}"[^>]*role="separator"`), id);
  const app = read('app.js');
  for (const fn of ['localGet', 'localSet', 'localRemove']) {
    const body = new RegExp(`function ${fn}\\([^)]*\\) \\{([^\\n]*)\\}`).exec(app)?.[1] ?? '';
    assert.match(body, /try \{.*localStorage\.\w+\(.*\} catch/, `${fn} is a try/catch around one storage call`);
  }
  const outside = app.split('\n').filter((l) => /localStorage/.test(l) && !/^function local(Get|Set|Remove)\(/.test(l));
  assert.deepEqual(outside, [], 'every other line goes through the three functions');
  assert.match(app, /parseStoredSize\(localGet\(/, 'a stored size is validated before it is used');
  assert.match(app, /dblclick/);
  assert.match(app, /localRemove\(SIZES\[kind\]\.key\)/, 'a double click removes the stored size');
});

test('page: a drag lives from the press to the release; the size is saved on release and only if it changed, with no timer', () => {
  const app = read('app.js');
  const drag = /function startDrag\(kind, e\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.ok(drag, 'startDrag found');
  assert.match(drag, /setPointerCapture/);
  assert.match(drag, /addEventListener\('pointermove', move\)/);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) assert.match(drag, new RegExp(t), t);
  assert.match(drag, /removeEventListener\(t, move\)/);
  assert.match(drag, /if \(moved\)/, 'a press that did not move saves nothing');
  assert.doesNotMatch(drag, /setTimeout|setInterval|requestAnimationFrame\(/, 'nothing is debounced');
  assert.doesNotMatch(drag.split('const end')[0].split('const move')[1] ?? '', /localSet/, 'nothing is saved while moving');
});

test('page: the sizes are CSS variables (so the one-column rule still wins), the columns scroll inside themselves, the handles go in one column', () => {
  const css = read('style.css');
  const grid = /\n\.grid\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(grid, /var\(--left-w/);
  assert.match(grid, /var\(--right-w/);
  assert.match(css, /\.col\s*\{[^}]*overflow-y:\s*auto/, 'each column scrolls inside itself');
  assert.match(css, /\.col\s*\{[^}]*min-height:\s*0/);
  const media = /@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(media, /grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(media, /\.handle-v\s*\{\s*display:\s*none/);
  assert.match(css, /\.log-pane\s*\{[^}]*var\(--log-h/);
  const app = read('app.js');
  assert.doesNotMatch(app, /gridTemplateColumns|style\.cssText/, 'no inline grid-template-columns on the page grid');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'hidden wins over a display set by a class');
});

test('page: a unit name or a role is wrapped, never cut: no ellipsis on the matrix row labels and headers, break anywhere in a long word', () => {
  const css = read('style.css');
  for (const sel of ['\\.mhead', '\\.mrow-label', '\\.mrow-label \\.u']) {
    const rule = new RegExp(`(?:^|\\n)${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    assert.ok(rule, `${sel} has a rule`);
    assert.doesNotMatch(rule, /text-overflow:\s*ellipsis/, sel);
    assert.doesNotMatch(rule, /white-space:\s*nowrap/, sel);
  }
  assert.match(/(?:^|\n)\.mhead\s*\{([^}]*)\}/.exec(css)[1], /overflow-wrap:\s*anywhere/, 'a role of 40 characters wraps inside its column');
  assert.match(/(?:^|\n)\.mrow-label \.u\s*\{([^}]*)\}/.exec(css)[1], /overflow-wrap:\s*anywhere/);
});

test('page: every list is a keyed list; the only inner-HTML writes are one-string boxes, the run list and a lane head, each guarded (the drawer is a keyed list too)', () => {
  const app = read('app.js');
  const writes = app.split('\n').filter((l) => /\.innerHTML\s*=(?!=)/.test(l)).map((l) => l.trim().replace(/\s*\/\/.*$/, ''));
  // Since U4 (web polish) the only inner-HTML write left is the one-string box, and it goes through morphHtml first, which keeps
  // unchanged nodes; the run list became a keyed picker and the lane head a patched element.
  assert.deepEqual(writes, [
    'if (prev === undefined || !morphHtml(el, prev, html)) el.innerHTML = html;',
  ]);
  assert.match(app, /const prev = lastHtml\.get\(el\);\s*if \(prev === html\) return;/, 'a box is written only when its string changed');
  assert.match(app, /pickRows: listOf\(/, 'the run list (since U4 a picker) is a keyed list');
  assert.doesNotMatch(app, /drawerSig|trStamp|#drawer-body'\)\.innerHTML/, 'the drawer is not compared as one string and rewritten whole');
  assert.match(app, /lists\.drawer\.sync\(drawerItems\(/, 'the drawer is drawn through the patch');
  for (const list of ['status', 'steps', 'roles', 'facts', 'grid', 'fallback', 'lanes', 'rows', 'edges', 'counters', 'verdicts', 'tests', 'log', 'drawer']) {
    assert.match(app, new RegExp(`\\b${list}: listOf\\(`), `${list} is a keyed list`);
    assert.match(app, new RegExp(`lists\\.${list}\\.sync\\(|lists\\.${list}\\.st`), `${list} is drawn through the patch`);
  }
  assert.doesNotMatch(app, /insertAdjacentHTML|\.outerHTML\s*=|replaceChildren|textContent\s*=\s*''/, 'nothing is replaced wholesale');
});

test('page: a snapshot writes no class, style or highlight on an element that did not change; the live highlight is painted on new elements and on events only', () => {
  const app = read('app.js');
  assert.doesNotMatch(app, /paintAllFlashes/, 'no pass over every element after a snapshot');
  assert.match(app, /function makeEl\(spec\) \{[\s\S]*?paintFlashEl\(el\);/, 'a new element of a lit agent joins the highlight');
  assert.match(/function refreshSelection\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /renderView\(\)/, 'the selection is part of the specs, drawn through the patch');
  assert.doesNotMatch(/function refreshSelection\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /classList\.toggle/);
  assert.match(app, /function syncHover[\s\S]*?setHtml\(panel/, 'the hover panel is written only when its string changed');
});

test('page: the elapsed clock is one interval started by one function that clears the old handle; a tick writes only the text of the elapsed value', () => {
  const app = read('app.js');
  assert.match(/function startClock\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /stopClock\(\);[\s\S]*setInterval\(tick, 1000\)/);
  assert.match(/function stopClock\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /clearInterval\(state\.clock\)/);
  assert.match(/function syncClock\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /state\.clock === null\) startClock\(\)/, 'a snapshot does not restart a running clock');
  const tick = /function tick\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';
  assert.match(tick, /clockTick\(state\.run, Date\.now\(\)\)/);
  assert.match(tick, /setText\(el, fmtDur\(ms\)\)/);
  assert.doesNotMatch(tick, /innerHTML|setAttribute|classList|style|title|setHtml|\.sync\(/, 'no other write');
  const select = /async function selectRun\([\s\S]*?\n\}\n/.exec(app)?.[0] ?? '';
  assert.match(select, /stopClock\(\)/, 'selecting a run stops the clock');
  assert.match(/function render\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /syncClock\(\)/, 'a snapshot starts it when the run counts and stops it when it does not');
});

test('page: new text from data reaches the page through esc() (captions, notes, k of n, role, unit, the phase unknown tooltip)', () => {
  const app = read('app.js');
  for (const needle of [
    'esc(cap.text)', 'esc(cap.tip)', 'esc(cap.prov)', 'esc(row.title)', 'esc(`unknown: ${row.reason}`)', 'esc(t.caption)', 'esc(t.role)', 'esc(t.unit)', 'esc(x.tag)', 'esc(x.state)',
    'esc(r)', 'esc(g)', 'esc(u)', 'esc(item.missing)', 'esc(l.message)',
  ]) assert.ok(app.includes(needle), `app.js has ${needle}`);
  assert.match(app, /const who = l\.actor \? esc\(l\.actor\) : '';/);
  // the note is text, never HTML
  assert.match(app, /setText\(note, m\.note\)/);
});

test('page: nothing of this project\'s own method is named in the page code (the universal guard also runs over web/)', () => {
  for (const f of ['app.js', 'lib.js', 'index.html', 'style.css']) {
    const code = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /['"`](implement|review-a|review-b|verify|judge|fix|fixer|guide)['"`:]/, f);
    assert.doesNotMatch(code, /AGENTS\.md|graph\.md|docs\/guides|codex/i, f);
  }
});

// ---- review round: the rowTags of a row, the clock of a replay, groups of keyed children ------------------------------------

test('matrix row: the tags of a row come from every agent of the row, not only the agent each cell shows', () => {
  // the worker cell shows r2 (the latest round) but r1 is an agent of the row too
  const rows = matrixRows([
    agent('w1', 'worker:alpha#r1', { startedAt: inf(1000) }),
    agent('w2', 'worker:alpha#r2', { startedAt: inf(2000) }),
    agent('c3', 'checker:alpha#r3', { startedAt: inf(3000) }),
  ]);
  assert.deepEqual(rows[0].cells[0].tags, ['r1', 'r2']);
  assert.deepEqual(rows[0].tags, ['r1', 'r2', 'r3'], 'the first round is not dropped');
  assert.deepEqual(rows[0].cells[0].agents.map((a) => a.id), ['w1', 'w2'], 'a cell holds all its agents, in start order');
  // rounds that started in another order than the role columns, and a tag that two agents share
  const mixed = matrixRows([
    agent('c', 'check:U#r3', { startedAt: inf(3000) }), agent('i2', 'impl:U#r2', { startedAt: inf(2000) }),
    agent('i1', 'impl:U#r1', { startedAt: inf(1000) }), agent('i1b', 'impl:U#r1', { startedAt: inf(1500) }), agent('n', 'impl:U', { startedAt: inf(500) }),
  ]);
  assert.deepEqual(mixed[0].tags, ['r1', 'r2', 'r3'], 'start order, a tag once, an agent with no tag adds none');
  // the function accepts the cells of a row as before, and plain agents
  assert.deepEqual(rowTags(rows[0].cells), ['r1', 'r2', 'r3']);
  assert.deepEqual(rowTags([agent('x', 'a:b#t2', { startedAt: inf(2) }), agent('y', 'a:b#t1', { startedAt: inf(1) })]), ['t1', 't2']);
  assert.deepEqual(rowTags([null, undefined]), []);
});

test('elapsed: only a run whose times are on the clock of now counts up; a replay keeps its own times and stays unknown, with the reason', () => {
  const NOW = 100000;
  const base = { durationMs: unk('run is still running'), startedAt: inf(40000, 'script-file-time') };
  // Run.source is always set by the model (contract §2: real | demo | replay); U4 item 15 ticks only live sources.
  for (const source of ['real', 'demo']) {
    const f = elapsedFact(run([], { ...base, source }), NOW);
    assert.equal(f.value, 60000, String(source));
    assert.equal(f.prov, 'inferred');
    // U4 item 15: the 1 s clock ticks only for a live running run of source real
    assert.equal(clockTick(run([], { ...base, source }), NOW), source === 'real' ? 60000 : null);
  }
  const replay = run([], { ...base, source: 'replay' });
  const f = elapsedFact(replay, NOW);
  assert.deepEqual([f.value, f.prov], [null, 'unknown'], 'a replay started a day ago is not "a day elapsed"');
  // U4 item 15: a replay shows its own duration from its times; with none, it keeps the Run's own reason
  assert.ok(typeof f.reason === 'string' && f.reason.length > 0, 'the reason says why');
  assert.equal(clockTick(replay, NOW), null, 'its clock does not tick');
  assert.equal(clockTick(replay, NOW + 86400000), null);
  assert.equal(countsFromNow(replay), false);
  assert.equal(countsFromNow(run([], { source: 'something-new' })), false, 'a source the contract does not list is not read as live');
  // the Run\'s own duration still wins, and a replay that reached its final file shows it
  const own = fin(61000, 'wf.json#durationMs');
  assert.equal(elapsedFact(run([], { ...base, source: 'replay', durationMs: own }), NOW), own);
  const done = run([], { source: 'replay', status: fin('completed'), durationMs: own, startedAt: inf(1) });
  assert.equal(clockTick(done, NOW), null);
});

test('timeline: a running bar ends now only in a run on the clock of now; a replay ends it at the latest time the Run records', () => {
  const NOW = 1_000_000_000;
  const running = agent('r', 'impl:A', { state: reg('running'), startedAt: inf(5000), endedAt: unk('running') });
  const done = agent('d', 'check:A', { startedAt: inf(1000), endedAt: inf(4000) });
  const live = run([done, running], { source: 'real' });
  assert.equal(barEnd(running, live, NOW), NOW, 'a live run: now');
  assert.equal(barEnd(running, run([done, running], { source: 'demo' }), NOW), NOW);
  const replay = run([done, running], { source: 'replay' });
  assert.equal(latestRecorded(replay), 5000, 'start 5000 is the latest time any agent records');
  assert.equal(barEnd(running, replay, NOW), 5000, 'a replay is not stretched to the wall clock');
  const active = agent('r2', 'impl:B', { state: reg('running'), startedAt: inf(2000), endedAt: unk('running'), lastActivity: { value: { ts: 9000, tool: 'Edit' }, prov: 'registered', from: 'f:1' } });
  const replay2 = run([done, running, active], { source: 'replay' });
  assert.equal(latestRecorded(replay2), 9000, 'a last-activity time counts');
  assert.equal(barEnd(running, replay2, NOW), 9000, 'every running bar of a replay ends at the same recorded time');
  assert.equal(barEnd(done, replay2, NOW), 4000, 'an ended agent keeps its end');
  const stopped = agent('s', 'fix:A', { state: { ...reg('running'), interrupted: true }, startedAt: inf(3000), endedAt: unk('x'), lastActivity: { value: { ts: 3500 }, prov: 'registered', from: 'f:1' } });
  assert.equal(barEnd(stopped, replay2, NOW), 3500, 'an interrupted bar ends at its last activity');
  assert.equal(barEnd(agent('q', 'a:b', { state: reg('queued'), startedAt: inf(7000), endedAt: unk('x') }), live, NOW), 7000, 'a queued agent has no length');
  assert.equal(barEnd(agent('n', 'a:b', { startedAt: unk('no start') }), live, NOW), null, 'no start, no bar');
  assert.equal(latestRecorded(run([])), null);
  assert.equal(latestRecorded(null), null);
});

test('groups: a child that did not change is the same element with no write, however deep; a new child is inserted; the group itself is kept', () => {
  const kid = (k, html) => specOf(keyOf('k', k), {}, html, 'pre');
  const group = (kids, attrs = {}) => groupOf(keyOf('g'), attrs, kids, 'div');
  const parent = new FakeEl('body');
  const st = createListState();
  const opts = { create: (item) => createNode(DOC, item), update: updateNode };
  patchList(parent, st, [specOf(keyOf('t'), {}, 'title', 'h2'), group([kid('a', 'text a'), kid('b', 'text b')], { id: 'x' })], opts);
  const [h2, g] = parent.childNodes;
  assert.deepEqual(g.childNodes.map((c) => c.html), ['text a', 'text b']);
  const [a, b] = g.childNodes;
  a.scrollTop = 120;
  const before = [h2, g, a, b].map((e) => e.writes);
  // the same data drawn again: nothing is touched
  patchList(parent, st, [specOf(keyOf('t'), {}, 'title', 'h2'), group([kid('a', 'text a'), kid('b', 'text b')], { id: 'x' })], opts);
  assert.deepEqual([h2, g, a, b].map((e) => e.writes), before);
  // one child changes and one is new at the front: b is rewritten, a is untouched, the group and the title stay
  patchList(parent, st, [specOf(keyOf('t'), {}, 'title', 'h2'), group([kid('n', 'new'), kid('a', 'text a'), kid('b', 'text b2')], { id: 'x' })], opts);
  assert.equal(parent.childNodes[1], g);
  assert.deepEqual(g.childNodes.map((c) => c.html), ['new', 'text a', 'text b2']);
  assert.equal(g.childNodes[1], a);
  assert.equal(g.childNodes[2], b);
  assert.equal(a.writes, before[2], 'the unchanged child was not written');
  assert.equal(a.moves, 1, 'nor moved: only its creation placed it');
  assert.equal(a.scrollTop, 120);
  assert.equal(b.writes, before[3] + 1, 'the changed child is written once');
  assert.equal(h2.writes, before[0]);
  // a child that is gone is removed; an attribute of the group changes without touching its children
  patchList(parent, st, [specOf(keyOf('t'), {}, 'title', 'h2'), group([kid('a', 'text a')], { id: 'y' })], opts);
  assert.deepEqual(g.childNodes, [a]);
  assert.equal(g.attrs.get('id'), 'y');
  assert.equal(a.writes, before[2]);
  // a group inside a group
  const deep = groupOf(keyOf('outer'), {}, [groupOf(keyOf('inner'), {}, [kid('z', 'zz')], 'section')], 'div');
  const el = createNode(DOC, deep);
  const z = el.childNodes[0].childNodes[0];
  updateNode(el, deep, groupOf(keyOf('outer'), { class: 'c' }, [groupOf(keyOf('inner'), {}, [kid('z', 'zz'), kid('y', 'yy')], 'section')], 'div'));
  assert.equal(el.childNodes[0].childNodes[0], z, 'z is the same element');
  assert.equal(el.childNodes[0].childNodes[1].html, 'yy', 'the new child is after z');
  assert.equal(z.writes, 1, 'z was written once, when it was made');
});

test('entry keys: an entry keeps its key when the list grows at the end or loses its first entries; entries that share time and tool are told apart in order', () => {
  const list = [{ ts: 1, tool: 'Edit' }, { ts: 2, tool: 'Edit' }, { ts: 2, tool: 'Edit' }, { ts: 3 }, { ts: 3 }];
  const keys = entryKeys(list, 'x');
  assert.equal(new Set(keys).size, 5);
  assert.notEqual(keys[1], keys[2]);
  assert.deepEqual(entryKeys([...list, { ts: 4, tool: 'Read' }], 'x').slice(0, 5), keys, 'growing at the end keeps every key');
  assert.deepEqual(entryKeys(list.slice(2), 'x').slice(1), keys.slice(3), 'entries after the dropped ones keep theirs');
  assert.notEqual(entryKeys(list, 'a')[0], entryKeys(list, 'b')[0], 'the prefix keeps two lists apart');
  assert.deepEqual(entryKeys(null, 'x'), []);
  assert.doesNotThrow(() => entryKeys([null, undefined, {}], 'x'));
});

// ---- the page on a fake browser: app.js itself runs, against fake elements ---------------------------------------------------
// Enough of a browser for app.js to start: elements that keep what is written to them (and drop their children and their scroll
// when innerHTML is written, as a browser does), listeners that a test can fire, timers that are only recorded, a fetch that
// answers from a table and an event stream that a test pushes into. The page code is not changed for the test.

class PageEl extends FakeEl {
  constructor(tag, ns = null) {
    super(tag, ns);
    Object.assign(this, { listeners: {}, hidden: false, textContent: '', className: '', value: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0, offsetWidth: 0, offsetHeight: 0, dataset: {} });
    this.classList.toggle = (t, force) => {
      const on = force === undefined ? !this.classes.has(t) : !!force;
      this.writes++;
      if (on) this.classes.add(t); else this.classes.delete(t);
      return on;
    };
  }

  set innerHTML(v) {
    this.writes++;
    this.html = v;
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.scrollTop = 0;
  }

  get innerHTML() { return this.html; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }

  fire(type, ev = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(ev); }

  querySelector() { return null; }

  matches() { return false; }

  closest() { return null; }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  setPointerCapture() {}

  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
}

const GLOBALS = ['document', 'window', 'location', 'history', 'localStorage', 'fetch', 'EventSource', 'ResizeObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
let bootCount = 0;

async function bootPage({ storage = {}, width = 1228, height = 800, runs = [], runDocs = {}, events = {}, transcripts = {}, hash = '' } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const els = new Map();
  const el = (sel) => { if (!els.has(sel)) els.set(sel, new PageEl('div')); return els.get(sel); };
  el('.grid').clientWidth = width; // the grid has 14 px padding on both sides (getComputedStyle below)
  const docListeners = {};
  const doc = {
    querySelector: el, querySelectorAll: () => [], createElement: (t) => new PageEl(t), createElementNS: (ns, t) => new PageEl(t, ns),
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); }, documentElement: new PageEl('html'), body: new PageEl('body'), title: '', elementFromPoint: () => null,
  };
  const timers = { intervals: new Map(), timeouts: new Map(), n: 0 };
  const page = {
    el, doc, timers, storage, transcripts, root: doc.documentElement, es: null,
    flush: async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); },
    runTimeouts(ms) {
      for (const [id, t] of [...timers.timeouts]) if (t.ms === ms) { timers.timeouts.delete(id); t.fn(); }
    },
    async click(agentId) {
      const cell = { dataset: { agent: agentId }, classList: { contains: () => false } };
      for (const fn of docListeners.click || []) fn({ target: { closest: (s) => (s === '[data-agent]' ? cell : null) } });
      await page.flush();
    },
    restore() {
      for (const n of GLOBALS) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n]; }
    },
  };
  class FakeES {
    constructor() { this.listeners = {}; page.es = this; }

    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }

    emit(t, data) { for (const fn of this.listeners[t] || []) fn({ data: JSON.stringify(data) }); }
  }
  setGlobal('document', doc);
  setGlobal('window', { innerHeight: height, innerWidth: width, addEventListener() {} });
  // the page's address: the picker's filters live in location.hash (read at the start, written with history.replaceState)
  const location = { hash, pathname: '/', search: '' };
  setGlobal('location', location);
  setGlobal('history', { replaceState(_state, _title, url) { location.hash = String(url).startsWith('#') ? String(url) : ''; } });
  setGlobal('localStorage', {
    getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; },
  });
  setGlobal('getComputedStyle', () => ({ paddingLeft: '14px', paddingRight: '14px' }));
  setGlobal('CSS', { escape: (x) => String(x) });
  setGlobal('ResizeObserver', class { observe() {} });
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('EventSource', FakeES);
  setGlobal('setInterval', (fn, ms) => { timers.intervals.set(++timers.n, { fn, ms }); return timers.n; });
  setGlobal('clearInterval', (id) => { timers.intervals.delete(id); });
  setGlobal('setTimeout', (fn, ms) => { timers.timeouts.set(++timers.n, { fn, ms }); return timers.n; });
  setGlobal('clearTimeout', (id) => { timers.timeouts.delete(id); });
  setGlobal('fetch', async (url) => {
    const u = String(url);
    let m;
    let body;
    if (u === '/api/runs') body = runs;
    else if ((m = /^\/api\/runs\/([^/?]+)\/events\?/.exec(u))) body = events[m[1]] ?? [];
    else if ((m = /^\/api\/runs\/([^/?]+)$/.exec(u))) body = runDocs[m[1]];
    else if ((m = /^\/api\/agents\/[^/]+\/([^/?]+)\/transcript/.exec(u))) body = page.transcripts[decodeURIComponent(m[1])];
    if (body === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  try {
    await import(`../../web/app.js?boot=${++bootCount}`);
    await page.flush();
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}

const summaryOf = (r) => ({ id: r.id, name: r.name, status: r.status, project: null, startedAt: r.startedAt });
// an agent with the fields the drawer shows
const dagent = (id, label, over = {}) => agent(id, label, {
  prompt: reg('You are a worker.\n'.repeat(60)), result: reg('{"ok":true}'), tokens: reg(100), toolCalls: reg(3), model: reg('m'), agentType: reg('t'), ...over,
});
const editEntry = (ts, file) => ({ ts, tool: 'Edit', inputSummary: file, input: { file_path: file, old_string: 'a\n'.repeat(80), new_string: 'b\n'.repeat(80) } });
const readEntry = (ts) => ({ ts, tool: 'Read', inputSummary: '/r' });
const pageRun = (agents, over = {}) => run(agents, { id: 'wf_x', source: 'real', name: reg('a run'), startedAt: inf(1000), durationMs: unk('run is still running'), ...over });

test('page (fake browser): an open drawer is patched by key: a snapshot that changes one value leaves every other block, and its scroll, alone', async () => {
  const r1 = pageRun([dagent('a1', 'impl:S#r1', { state: reg('running') }), dagent('a2', 'check:S', { prompt: reg('other prompt') })]);
  const page = await bootPage({ runs: [summaryOf(r1)], runDocs: { wf_x: r1 }, transcripts: { a1: [editEntry(1100, '/a'), readEntry(1200)] } });
  try {
    await page.click('a1');
    const body = page.el('#drawer-body');
    const sec = (name) => body.childNodes.find((c) => c.attrs.get('data-sec') === name);
    const [prompt, result, changes, activity, facts] = ['prompt', 'result', 'changes', 'activity', 'facts'].map(sec);
    assert.ok(prompt && result && changes && activity && facts, 'the drawer is made of elements of its own, not one string');
    assert.equal(page.el('#drawer').hidden, false);
    assert.equal(prompt.html.split('\n').length, 61, 'the whole prompt');
    assert.equal(changes.childNodes.length, 1, 'one edit with a recorded input');
    assert.equal(activity.childNodes.length, 2);
    const diff = changes.childNodes[0];
    prompt.scrollTop = 100;
    result.scrollTop = 50;
    diff.scrollTop = 30;
    page.el('#drawer').scrollTop = 500;
    const quiet = [prompt, result, changes, activity, diff, ...activity.childNodes, ...body.childNodes.filter((c) => c.tag === 'h3')];
    const writes = quiet.map((e) => e.writes);
    assert.ok(facts.childNodes.some((c) => c.html.includes('>100<')), 'tokens 100 shown');
    const ddWrites = facts.childNodes.map((c) => c.writes);

    // a snapshot where only the tokens of the running agent changed: a new object, parsed from JSON again
    const r2 = structuredClone(r1);
    r2.agents.a1.tokens = reg(250);
    page.es.emit('run', r2);
    await page.flush();

    assert.deepEqual(body.childNodes.filter((c) => c.attrs.get('data-sec')).map((c) => c.attrs.get('data-sec')), ['title', 'facts', 'changes', 'deps', 'result', 'prompt', 'activity']);
    assert.deepEqual(['prompt', 'result', 'changes', 'activity', 'facts'].map(sec), [prompt, result, changes, activity, facts], 'the same elements, not rebuilt');
    assert.equal(changes.childNodes[0], diff);
    assert.deepEqual(quiet.map((e) => e.writes), writes, 'not one write to a block that did not change');
    assert.deepEqual([prompt.scrollTop, result.scrollTop, diff.scrollTop, page.el('#drawer').scrollTop], [100, 50, 30, 500], 'the scroll of every block is kept');
    assert.equal(facts.childNodes.some((c) => c.html.includes('>250<')), true, 'the changed value is shown');
    const rewritten = facts.childNodes.filter((c, i) => c.writes !== ddWrites[i]);
    assert.equal(rewritten.length, 1, 'and only that value was written');
    assert.ok(rewritten[0].html.includes('>250<'));

    // the agent has a new event: the transcript is read again, and a newer edit joins the list
    page.transcripts.a1 = [editEntry(1100, '/a'), readEntry(1200), editEntry(1300, '/c')];
    page.es.emit('event', { runId: 'wf_x', seq: 1, ts: 1300, kind: 'agent.activity', agentId: 'a1', message: 'edit /c', prov: 'registered' });
    await page.flush();
    page.runTimeouts(400);
    await page.flush();
    assert.equal(changes.childNodes.length, 2, 'the new edit is in the list');
    assert.equal(changes.childNodes[1], diff, 'the old edit is the same element (newest first, so it is second now)');
    assert.equal(activity.childNodes.length, 3);
    assert.equal(diff.writes, writes[4]);
    assert.equal(diff.moves, 1, 'the old edit was not moved either');
    assert.equal(sec('prompt'), prompt);
    assert.equal(prompt.writes, writes[0]);
    assert.deepEqual([prompt.scrollTop, result.scrollTop, diff.scrollTop], [100, 50, 30]);

    // another agent: nothing of the first one stays, so no scroll is inherited
    await page.click('a2');
    assert.notEqual(sec('prompt'), prompt);
    assert.equal(sec('prompt').html, 'other prompt');
    assert.equal(sec('prompt').scrollTop, 0);
  } finally {
    page.restore();
  }
});

test('page (fake browser): a drag starts from the sizes on show: the other column does not snap back to its saved size, and only the dragged size is stored', async () => {
  // saved in a bigger window: together they do not fit in this one, so both are shown narrower than saved
  const storage = { 'wfviz.layout.left': '540', 'wfviz.layout.right': '576' };
  const page = await bootPage({ storage, width: 1228, height: 800 });
  try {
    const vp = { width: 1200, height: 800 };
    const shown = clampLayout({ left: 540, right: 576 }, vp);
    assert.ok(shown.left < 540 && shown.right < 576, 'both are clamped');
    const css = (name) => page.root.props.get(name);
    assert.deepEqual([css('--left-w'), css('--right-w')], [`${shown.left}px`, `${shown.right}px`]);

    const handle = page.el('#handle-left');
    const press = (x) => handle.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: handle, pointerId: 1, clientX: x, clientY: 100 });
    // the pointer moves 20 px to the left: the left column is 20 px narrower than it is shown, the right one is exactly as shown
    press(500);
    handle.fire('pointermove', { clientX: 480, clientY: 100 });
    assert.equal(css('--left-w'), `${shown.left - 20}px`);
    assert.equal(css('--right-w'), `${shown.right}px`, 'not its saved 576 px');
    handle.fire('pointerup', {});
    assert.equal(storage['wfviz.layout.left'], String(shown.left - 20), 'the dragged size is stored');
    assert.equal(storage['wfviz.layout.right'], '576', 'the other saved size is left as it was');
    assert.deepEqual(handle.listeners.pointermove, [], 'the listeners are gone after the release');

    // a second press and a move to the right: the left column grows, the right one still does not jump
    press(480);
    handle.fire('pointermove', { clientX: 490, clientY: 100 });
    assert.ok(Number.parseInt(css('--left-w'), 10) >= shown.left - 20, 'the pointer moved right, so the column did not shrink');
    assert.equal(css('--right-w'), `${shown.right}px`);
    handle.fire('pointercancel', {});
    assert.deepEqual(handle.listeners.pointermove, []);

    // a press that moves nothing saves nothing
    const stored = JSON.stringify(storage);
    press(300);
    handle.fire('pointerup', {});
    assert.equal(JSON.stringify(storage), stored);

    // the right handle and the log handle work from what is shown as well
    const right = page.el('#handle-right');
    right.fire('pointerdown', { button: 0, preventDefault() {}, currentTarget: right, pointerId: 2, clientX: 900, clientY: 100 });
    const leftNow = css('--left-w');
    right.fire('pointermove', { clientX: 880, clientY: 100 }); // the right column grows by 20 when the pointer moves left
    assert.equal(css('--left-w'), leftNow, 'the left column is not touched');
    assert.ok(Number.parseInt(css('--right-w'), 10) >= shown.right, 'the right column did not shrink');
    right.fire('pointerup', {});

    // a double click resets one size and removes its key
    handle.fire('dblclick', {});
    assert.equal(storage['wfviz.layout.left'], undefined);
  } finally {
    page.restore();
  }
});

test('page (fake browser): the elapsed clock counts only a run that is on the clock of now; a replay starts no interval and shows the elapsed time as unknown', async () => {
  const stat = (page) => page.el('#run-status').childNodes.find((c) => c.html.startsWith('elapsed'))?.html ?? '';
  const started = Date.now() - 86_400_000; // a run of yesterday
  const replay = pageRun([agent('a', 'impl:S', { state: reg('running') })], { source: 'replay', startedAt: inf(started) });
  const p1 = await bootPage({ runs: [summaryOf(replay)], runDocs: { wf_x: replay } });
  try {
    assert.equal(p1.timers.intervals.size, 0, 'no clock for a replay');
    const html = stat(p1);
    assert.match(html, /prov-unknown/);
    assert.match(html, /<small>[^<]+<\/small>/, "the reason says why (U4: the run's own reason when its times give no duration)");
    assert.doesNotMatch(html, /prov-inferred|\d+m \d+s/, 'no "1440m 0s"');
    p1.es.emit('run', structuredClone(replay));
    await p1.flush();
    assert.equal(p1.timers.intervals.size, 0, 'a snapshot of a replay does not start one either');
  } finally {
    p1.restore();
  }
  const real = pageRun([agent('a', 'impl:S', { state: reg('running') })], { source: 'real', startedAt: inf(Date.now() - 5000) });
  const p2 = await bootPage({ runs: [summaryOf(real)], runDocs: { wf_x: real } });
  try {
    assert.equal(p2.timers.intervals.size, 1, 'a live run counts');
    assert.match(stat(p2), /prov-inferred/);
    p2.es.emit('run', structuredClone(real));
    await p2.flush();
    assert.equal(p2.timers.intervals.size, 1, 'a snapshot does not start a second clock');
    const final = structuredClone(real);
    final.status = fin('completed');
    final.durationMs = fin(5000);
    p2.es.emit('run', final);
    await p2.flush();
    assert.equal(p2.timers.intervals.size, 0, 'the clock stops when the run is final');
  } finally {
    p2.restore();
  }
});

// ---- the columns: nothing is cut off ---------------------------------------------------------------------------------------

test('page: a column never cuts its content off: it scrolls sideways, and the narrow cards wrap; no decoration scales outside its cell', () => {
  const css = read('style.css');
  const col = /(?:^|\n)\.col\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.doesNotMatch(col, /overflow-x:\s*hidden/, 'a matrix of many roles in a narrow centre is not clipped');
  assert.match(col, /overflow-x:\s*auto/);
  assert.match(col, /overflow-y:\s*auto/);
  assert.match(/\.fcard \.h\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /flex-wrap:\s*wrap/, 'the verdict tag of a finding card wraps instead of being cut');
  assert.match(/(?:^|\n)\.role\s*\{([^}]*)\}/.exec(css)?.[1] ?? '', /flex-wrap:\s*wrap/);
  // a transform: scale() on a running cell widens the scrollable area of a column that scrolls sideways: a scrollbar would flicker
  const keyframes = /@keyframes ripple\s*\{([^}]*\{[^}]*\}[^}]*\{[^}]*\}[^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(keyframes, 'the ripple keyframes are there');
  assert.doesNotMatch(keyframes, /scale\(/, 'the ripple does not scale beyond its cell');
});
