// test/server/web-u5.test.mjs (node matrix-cells): the layout of the matrix cells and of the row labels.
// The page has no layout engine in the tests, so the rules that give the layout are read from web/style.css: the comments are cut,
// every rule whose selector list holds an element's selector counts (two `.cell {` rules, a comma list, a later rule that undoes an
// earlier one), the cascade is resolved by specificity and source order, and the shorthands are expanded. The numbers the rules
// stand on were measured in headless Chrome (an inline state tag of 9 px text with `gap: 1px; line-height: 1.15`: the next tag starts
// 0.6 to 0.7 px above the bottom of the one before; `display: inline-block` with its own line-height and `gap: 3px`: 3.0 px apart;
// the label's name beside the toggle at the 120 px track: 78.3 px of text in an 81 px box only with no gap in the label; a tag of
// 99.3 px in the 102 px column of that label with `flex-shrink: 1` and a 4 px margin: squeezed to 98 px and split at a hyphen, 30.8 px
// tall, against 99.3 x 15.4 px with `flex: 0 0 auto`; a tag of 23 characters with `white-space: nowrap`: 152.3 px wide, the label's
// scrollWidth 359 against a clientWidth of 118 and its end under the next cell, against 102 px wide in two lines and a scrollWidth
// of 118 with `max-width: 100%`).
// What a rule cannot say (how the page looks) is not tested here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyOf, matrixRoles, matrixRows } from '../../web/lib.js';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');

// ---- a small cascade over class selectors ----------------------------------------------------------------------------------------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Style rules in source order, one entry per selector of a comma list. At-rules (media queries, keyframes) are not the base cascade
// and are left out; a selector that holds a type, an id, an attribute or a state (:hover) is not a selector of a plain element and is
// left out too. A pseudo-element (::after) is kept with the last compound.
function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) continue;
    const decls = [];
    for (const d of body.split(';')) {
      const k = d.indexOf(':');
      if (k > 0) decls.push([d.slice(0, k).trim().toLowerCase(), d.slice(k + 1).trim().replace(/\s*!important$/, '')]);
    }
    for (const sel of prelude.split(',')) {
      const parts = parseSelector(sel.trim());
      if (parts) rules.push({ parts, decls, order: order++ });
    }
  }
  return rules;
}

function parseSelector(sel) {
  const parts = [];
  for (const token of sel.split(/\s*>\s*|\s+/).filter(Boolean)) {
    const m = /^((?:\.[A-Za-z0-9_-]+)+)(?:::([a-z-]+))?$/.exec(token);
    if (!m) return null;
    parts.push({ classes: m[1].slice(1).split('.'), pseudo: m[2] ?? null });
  }
  return parts.length ? parts : null;
}

// An element is a chain from the outermost known ancestor to itself, each with its class list: ['matrix', 'cell empty'] is a cell with
// the classes cell and empty inside the grid. { pseudo } marks the ::after of the last one.
const chainOf = (...specs) => specs.map((s) => ({ classes: s.split(/\s+/).filter(Boolean) }));
const hasAll = (el, classes) => classes.every((c) => el.classes.includes(c));

function matches(rule, chain, pseudo) {
  const parts = rule.parts;
  const last = parts[parts.length - 1];
  if (last.pseudo !== pseudo || !hasAll(chain[chain.length - 1], last.classes)) return false;
  let at = chain.length - 2;
  for (let p = parts.length - 2; p >= 0; p -= 1) {
    while (at >= 0 && !hasAll(chain[at], parts[p].classes)) at -= 1;
    if (at < 0) return false;
    at -= 1;
  }
  return true;
}

const specificity = (rule) => rule.parts.reduce((n, p) => n + p.classes.length * 10 + (p.pseudo ? 1 : 0), 0);

function expand(prop, value, into) {
  const v = value.split(/\s+/).filter(Boolean);
  if (prop === 'gap') { into.set('row-gap', v[0]); into.set('column-gap', v[1] ?? v[0]); return; }
  if (prop === 'padding') {
    const [t, r = t, b = t, l = r] = v;
    into.set('padding-top', t); into.set('padding-right', r); into.set('padding-bottom', b); into.set('padding-left', l);
    return;
  }
  if (prop === 'flex') {
    if (v[0] === 'none') { into.set('flex-grow', '0'); into.set('flex-shrink', '0'); into.set('flex-basis', 'auto'); return; }
    if (v[0] === 'auto') { into.set('flex-grow', '1'); into.set('flex-shrink', '1'); into.set('flex-basis', 'auto'); return; }
    into.set('flex-grow', v[0]); into.set('flex-shrink', v[1] ?? '1'); into.set('flex-basis', v[2] ?? '0%');
    return;
  }
  into.set(prop, value);
}

// The declared values of an element (or of its pseudo-element): every matching rule applied in order of specificity, then source.
function computed(rules, chain, pseudo = null) {
  const out = new Map();
  const mine = rules.map((r, k) => ({ r, k })).filter(({ r }) => matches(r, chain, pseudo));
  mine.sort((a, b) => specificity(a.r) - specificity(b.r) || a.r.order - b.r.order);
  for (const { r } of mine) for (const [p, v] of r.decls) expand(p, v, out);
  return out;
}

const px = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(v) ? Number(v.replace('px', '')) : NaN);

// ---- what the layout needs ------------------------------------------------------------------------------------------------------

// Returns the defects of a stylesheet as { item, text }: item 1 = the cells and the label of a row share its height, 2 = the agent
// lines of a cell are apart, 3 = the label's name and tags. An empty list means none.
function matrixCssDefects(css) {
  const rules = parseRules(css);
  const defects = [];
  const bad = (item, text) => defects.push({ item, text });

  // 1. one row, one height. A grid item with `normal` or `stretch` fills its row; `center` (or start, end) gives it its content's height.
  const alignOf = (own) => {
    const chain = chainOf('matrix', own);
    const self = computed(rules, chain).get('align-self');
    if (self && self !== 'auto') return self;
    return computed(rules, chainOf('matrix')).get('align-items') ?? 'normal';
  };
  const fills = (a) => a === 'stretch' || a === 'normal';
  for (const own of ['cell', 'cell empty', 'cell sel', 'cell st-running', 'cell st-interrupted', 'cell st-failed', 'mrow-label', 'mrow-label st-running', 'mrow-label st-done', 'mrow-label st-interrupted']) {
    const a = alignOf(own);
    if (!fills(a)) bad(1, `.${own.replace(/ /g, '.')} is aligned "${a}" in the grid: it is as tall as its content, not as its row`);
    const c = computed(rules, chainOf('matrix', own));
    for (const p of ['height', 'max-height']) {
      if (c.has(p) && c.get(p) !== 'auto' && c.get(p) !== 'none') bad(1, `.${own.replace(/ /g, '.')} has a fixed ${p}`);
    }
  }
  for (const own of ['mhead', 'mhead colspot']) {
    const a = alignOf(own);
    if (a !== 'center') bad(1, `.${own.replace(/ /g, '.')} is aligned "${a}": a header cell keeps its own centring`);
  }
  const cell = computed(rules, chainOf('matrix', 'cell'));
  if (cell.get('display') !== 'flex' || cell.get('flex-direction') !== 'column' || cell.get('justify-content') !== 'center') {
    bad(1, 'a cell keeps its content centred (a flex column with justify-content: center)');
  }

  // 2. the lines of a cell with several agents. Between two state tags: the gap of the list (at least 2 px of room between two
  // bordered tags), a tag that is a box of its own line (an inline tag's border bleeds above and below its line: measured -0.7 px with
  // gap 1px), its own inner padding like .tag elsewhere, a space between the agent tag and its state tag (a flex or grid `.ca`
  // drops the space of the markup).
  const list = computed(rules, chainOf('cell', 'cell-agents'));
  const gapPx = px(list.get('row-gap'));
  if (!(gapPx >= 2)) bad(2, `the agent lines of a cell are ${list.get('row-gap') ?? 'not'} apart: the borders of two state tags touch (2px at least)`);
  const line = computed(rules, chainOf('cell', 'cell-agents', 'ca'));
  if (/flex|grid/.test(line.get('display') ?? '')) bad(2, '.ca is a flex or grid box: the space between the agent tag and its state tag collapses');
  for (const cls of ['tag', 'tag pass', 'tag running', 'tag fail', 'tag interrupted']) {
    const t = computed(rules, chainOf('cell', 'cell-agents', 'ca', cls));
    if (!['inline-block', 'block', 'flex', 'inline-flex'].includes(t.get('display'))) bad(2, `the state tag (.${cls.replace(/ /g, '.')}) is ${t.get('display') ?? 'inline'}: its border reaches into the next line`);
    const base = computed(rules, chainOf(cls));
    if (!(px(t.get('padding-left')) >= px(base.get('padding-left'))) || !(px(t.get('padding-right')) >= px(base.get('padding-right')))) {
      bad(2, `the state tag has less inner padding (${t.get('padding-left')} / ${t.get('padding-right')}) than .tag elsewhere (${base.get('padding-left')})`);
    }
    if (!(Number(t.get('line-height')) >= 1.2)) bad(2, `the state tag has no line-height of its own of 1.2 or more (${t.get('line-height') ?? 'none'})`);
  }

  // 3. the label. .u is a wrapping flex line with no gap; the name keeps its own width (basis auto, so a name that does not fit beside
  // the toggle moves whole below it and breaks inside only when it fits no line) and can shrink; an empty box of the full width ends
  // the name's line and comes before the tags; a tag is a box as wide as its text that does not shrink below it (basis auto, no shrink:
  // a hyphen is a break opportunity and its own margin would squeeze a tag that fits the column) and is held to the column (max-width
  // 100%) so a tag wider than the column breaks inside as a last resort instead of running under the next column's cell (`nowrap`
  // would leave its end covered by that cell); it has no gap above it from the container, so a label with no tags does not grow.
  const u = computed(rules, chainOf('mrow-label', 'u'));
  if (u.get('display') !== 'flex' || u.get('flex-wrap') !== 'wrap') bad(3, '.u is not a wrapping flex box: the tags follow the name inline and the name breaks at a hyphen');
  if (px(u.get('column-gap') ?? '0') !== 0 || px(u.get('row-gap') ?? '0') !== 0) bad(3, `.u has a gap (${u.get('column-gap')} / ${u.get('row-gap')}): the name no longer fits beside the toggle at the 120 px track and an empty line adds its gap`);
  if (u.get('overflow-wrap') !== 'anywhere') bad(3, '.u lost overflow-wrap: anywhere: a word that fits no line would overflow');
  const name = computed(rules, chainOf('mrow-label', 'u', 'u-name'));
  if ((name.get('flex-basis') ?? 'auto') !== 'auto') bad(3, `.u-name has the flex-basis ${name.get('flex-basis')}: it takes what is left beside the toggle and breaks there`);
  if (px(name.get('min-width')) !== 0) bad(3, '.u-name has no min-width: 0: a name wider than the column cannot shrink to it');
  if (/nowrap|pre/.test(name.get('white-space') ?? '')) bad(3, '.u-name cannot wrap');
  const end = computed(rules, chainOf('mrow-label', 'u'), 'after');
  const tag = computed(rules, chainOf('mrow-label', 'u', 'tag-i'));
  const orderOf = (m) => Number(m.get('order') ?? 0);
  if (end.get('content') !== '""' || !/^100%$/.test(end.get('flex-basis') ?? '') || px(end.get('height')) !== 0) bad(3, '.u::after is not an empty box of the full width and no height: nothing sends the tags to their own line');
  if (!(orderOf(end) > orderOf(name)) || !(orderOf(tag) > orderOf(end))) bad(3, `the tags are not after the name's line (order: name ${orderOf(name)}, line end ${orderOf(end)}, tag ${orderOf(tag)})`);
  if (/nowrap|pre/.test(tag.get('white-space') ?? '')) bad(3, `a tag of the label cannot wrap (white-space: ${tag.get('white-space')}): one wider than the column runs into the next column, whose cell paints over its end`);
  if (tag.get('max-width') !== '100%') bad(3, `a tag of the label has no max-width: 100% (${tag.get('max-width') ?? 'none'}): one wider than the column is not held to it and its end is lost under the next cell`);
  if ((tag.get('flex-shrink') ?? '1') !== '0' || (tag.get('flex-basis') ?? 'auto') !== 'auto') {
    bad(3, `a tag of the label can break inside (flex-shrink: ${tag.get('flex-shrink') ?? 1}, flex-basis: ${tag.get('flex-basis') ?? 'auto'}) although it fits the column: "#rule-" / "full"`);
  }
  return defects;
}

const itemsOf = (defects) => [...new Set(defects.map((d) => d.item))].sort();
const show = (defects) => defects.map((d) => `${d.item}: ${d.text}`).join('\n');

// The rules as they were when the three defects were reported, for the check to fail on. Not read from git: a string of the rules.
const OLD_RULES = `
.tag { font-size: 10px; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.tag.pass { color: var(--done); border-color: var(--done); }
.tag-i { color: #c7b8ff; font-size: 11px; font-weight: 400; margin-left: 4px; }
.matrix { display: grid; gap: 4px; align-items: center; position: relative; }
.mhead { min-width: 0; color: var(--muted); font-size: 11px; text-align: center; text-transform: uppercase; padding-bottom: 4px; overflow-wrap: anywhere; }
.mrow-label { min-width: 0; padding: 6px 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 5px; min-height: 46px; }
.mrow-label .u { font-weight: 600; overflow-wrap: anywhere; }
.cell { min-height: 46px; padding: 2px 3px; border: 1px solid var(--line); border-radius: 6px; position: relative; display: flex; flex-direction: column; gap: 1px; align-items: center; justify-content: center; cursor: pointer; }
.cell { min-width: 0; }
.cell .cell-agents { display: flex; flex-direction: column; align-items: center; gap: 1px; max-width: 100%; font-size: 9px; line-height: 1.15; color: var(--muted); text-align: center; }
.cell .ca { max-width: 100%; overflow-wrap: anywhere; }
.cell .ca .tag { font-size: 9px; padding: 0 3px; }
.cell.empty { cursor: default; opacity: .45; }
`;

// ---- the tests ------------------------------------------------------------------------------------------------------------------

test('matrix cells: web/style.css gives every cell of a row and its label one height, apart agent lines, and a label that breaks only between tags', () => {
  const defects = matrixCssDefects(read('style.css'));
  assert.deepEqual(defects, [], show(defects));
});

test('matrix cells: the check reports each of the three defects on the rules that had them, and the right ones only', () => {
  const old = matrixCssDefects(OLD_RULES);
  assert.deepEqual(itemsOf(old), [1, 2, 3], show(old));
  const text = show(old);
  assert.match(text, /\.cell is aligned "center"/);
  assert.match(text, /\.mrow-label is aligned "center"/);
  assert.match(text, /agent lines of a cell are 1px apart/);
  assert.match(text, /state tag.*is inline/);
  assert.match(text, /less inner padding/);
  assert.match(text, /\.u is not a wrapping flex box/);
  assert.match(text, /can break inside/);
  assert.match(text, /no max-width: 100%/);
});

test('matrix cells: each defect, brought back alone into the current stylesheet, is found as that defect alone', () => {
  const css = read('style.css');
  const change = (from, to, item, why) => {
    assert.ok(css.includes(from), `the current stylesheet has: ${from}`);
    const defects = matrixCssDefects(css.replace(from, to));
    assert.deepEqual(itemsOf(defects), [item], `${why}\n${show(defects)}`);
  };
  change('align-items: stretch; position: relative;', 'align-items: center; position: relative;', 1, 'the grid centres its items again');
  change('overflow-wrap: anywhere; align-self: center; }', 'overflow-wrap: anywhere; }', 1, 'the header cell lost its own centring');
  change('gap: 3px; max-width: 100%', 'gap: 1px; max-width: 100%', 2, 'the agent lines are 1px apart');
  change('.cell .ca .tag { display: inline-block;', '.cell .ca .tag { display: inline;', 2, 'the state tag is inline');
  change('line-height: 1.3; padding: 0 4px; }', 'line-height: 1.3; padding: 0 3px; }', 2, 'the state tag has less padding than .tag');
  change('.mrow-label .tag-i { order: 2; flex: 0 0 auto;', '.mrow-label .tag-i { order: 2; flex: 0 1 auto;', 3, 'a tag of the label may shrink below its text and break at a hyphen although it fits the column');
  change('.mrow-label .tag-i { order: 2; flex: 0 0 auto;', '.mrow-label .tag-i { order: 2; flex: 0 0 0;', 3, 'a tag of the label has no width of its own');
  change('flex: 0 0 auto; max-width: 100%; margin: 2px 4px 0 0;', 'flex: 0 0 auto; margin: 2px 4px 0 0;', 3, 'a tag wider than the column is not held to it');
  change('.mrow-label .tag-i { order: 2; flex: 0 0 auto;', '.mrow-label .tag-i { order: 2; white-space: nowrap; flex: 0 0 auto;', 3, 'a tag of the label cannot wrap, so one wider than the column runs under the next cell');
  change('.mrow-label .u-name { flex: 0 1 auto;', '.mrow-label .u-name { flex: 1 1 0;', 3, 'the name takes what is left beside the toggle');
  change('.mrow-label .u::after { content: ""; flex: 0 0 100%; order: 1;', '.mrow-label .u::after { content: ""; flex: 0 0 100%; order: 3;', 3, 'the line end comes after the tags');
});

test('matrix cells: a later rule that undoes the stretch of an empty or running cell or of a label is found (the cascade is resolved, not the first rule read)', () => {
  const css = read('style.css');
  for (const [late, what] of [
    ['.cell.empty { align-self: center; }', 'cell empty'],
    ['.cell.st-running { align-self: flex-start; }', 'cell st-running'],
    ['.mrow-label.st-done { align-self: center; }', 'mrow-label st-done'],
    ['.cell, .mrow-label { align-self: end; }', 'cell'],
    ['.matrix > .cell { align-self: center; }', 'cell'],
  ]) {
    const defects = matrixCssDefects(`${css}\n${late}\n`);
    assert.deepEqual(itemsOf(defects), [1], `${late}\n${show(defects)}`);
    assert.match(show(defects), new RegExp(`\\.${what.replace(/ /g, '\\.')} is aligned`), late);
  }
  // a later rule that undoes the tag's width or its refusal to shrink is found, one with fewer classes than the label's rule is not
  for (const late of ['.mrow-label .tag-i { white-space: nowrap; }', '.mrow-label .u .tag-i { flex-shrink: 1; }', '.mrow-label .u .tag-i { max-width: none; }']) {
    assert.deepEqual(itemsOf(matrixCssDefects(`${css}\n${late}\n`)), [3], late);
  }
  assert.deepEqual(matrixCssDefects(`${css}\n.tag-i { flex-shrink: 1; max-width: none; }\n`), [], 'the base .tag-i has fewer classes than the rule of the label, which sets both');
  assert.deepEqual(itemsOf(matrixCssDefects(`${css}\n.tag-i { white-space: nowrap; }\n`)), [3], 'the label sets no white-space: a later base rule that does applies to its tags');
  // a rule that does not apply to the matrix (a fallback cell, a state, a media query) does not count against it
  for (const other of ['.fallback .cell { align-self: center; }', '@media (max-width: 700px) { .cell { align-self: center; } }', '.cell:hover { align-self: center; }']) {
    assert.deepEqual(matrixCssDefects(`${css}\n${other}\n`), [], other);
  }
  // the specificity wins over the order: a later rule with fewer classes does not undo an earlier one with more
  assert.deepEqual(matrixCssDefects(`${css}\n.matrix .cell { align-self: stretch; }\n.cell { align-self: center; }\n`), []);
  assert.deepEqual(itemsOf(matrixCssDefects(`${css}\n.cell { align-self: stretch; }\n.matrix .cell { align-self: center; }\n`)), [1]);
});

test('matrix cells: the rules that give the layout do not touch the shared tag, the history rows or the fallback cells', () => {
  const css = stripComments(read('style.css'));
  const rules = parseRules(css);
  // the base .tag, the history rows' .tag-i and the fallback cell keep their own rules
  const base = computed(rules, chainOf('tag'));
  assert.equal(base.get('display'), undefined, 'the shared .tag is not made a box');
  assert.equal(base.get('padding-left'), '4px');
  const hist = computed(rules, chainOf('hist-row', 'lbl', 'tag-i'));
  assert.equal(hist.get('white-space'), undefined, 'the tag in a history row is not made nowrap: its line is cut by the row');
  assert.equal(hist.get('order'), undefined);
  assert.equal(hist.get('flex-shrink'), undefined, 'the tag in a history row keeps its own shrinking');
  assert.equal(hist.get('max-width'), undefined);
  const fb = computed(rules, chainOf('fallback', 'cell fb-cell'));
  assert.equal(fb.get('align-self'), undefined, 'the fallback cell keeps the stretch of its own flex line');
  const fbLine = fs.readFileSync(path.join(REPO, 'web', 'style.css'), 'utf8').split('\n').find((l) => l.startsWith('.fallback {'));
  assert.match(fbLine, /align-items:\s*stretch/);
  // the cell centres its own content: no centring on the label (not asked)
  assert.equal(computed(rules, chainOf('matrix', 'mrow-label')).get('align-items'), undefined);
});

test('matrix markup: every cell, empty ones included, is keyed by its unit and its role, and the agent line is the tag, a space, the state tag', () => {
  const app = read('app.js');
  assert.match(app, /const key = keyOf\('cell', u, m\.roles\[i\]\);/, 'a cell is keyed by unit and role');
  assert.match(app, /if \(!c\) \{ specs\.push\(specOf\(key, \{ class: 'cell empty' \}, ''\)\); continue; \}/, 'an empty cell has that key too');
  assert.match(app, /keyOf\('row', u\)/, 'a row label is keyed by its unit');
  assert.match(app, /\$\{x\.tag \? `#\$\{esc\(x\.tag\)\}` : '<small>no tag<\/small>'\} <span class="tag \$\{esc\(stateClass\(x\.state\)\)\}">\$\{esc\(x\.state\)\}<\/span>/, 'tag, one space, state tag: the space is in the markup');
  assert.match(app, /<span class="cell-agents">/);

  // keys of units and roles that hold the separators of a key: no two cells share one
  const a = (id, role, unit, tag) => ({
    id, label: { value: `${role}:${unit}`, prov: 'registered', from: 'f:1' },
    role: { value: role, prov: 'inferred', method: 'label-pattern' }, unit: { value: unit, prov: 'inferred', method: 'label-pattern' },
    tag: tag ? { value: tag, prov: 'inferred', method: 'label-pattern' } : { value: null, prov: 'unknown', reason: 'no tag' },
    round: { value: null, prov: 'unknown', reason: 'no round' }, state: { value: 'done', prov: 'registered', from: 'f:2' },
    startedAt: { value: 1000, prov: 'inferred', method: 'x' },
  });
  const units = ['u,v', 'u', 'v|w', 'w:x', 'u|v,w'];
  const roles = ['a,b', 'a', 'b|c', 'c:d', 'a|b,c'];
  const agents = [a('1', roles[0], units[0], 't'), a('2', roles[1], units[1]), a('3', roles[2], units[2]), a('4', roles[3], units[3]), a('5', roles[4], units[4]), a('6', roles[4], units[0])];
  const rows = matrixRows(agents, matrixRoles(agents));
  assert.deepEqual(rows.map((r) => r.unit), units);
  const keys = [];
  for (const row of rows) for (const i of row.cells.keys()) keys.push(keyOf('cell', row.unit, roles[i]));
  assert.equal(keys.length, units.length * roles.length, 'a cell for every unit and role, empty ones included');
  assert.equal(new Set(keys).size, keys.length, 'no two cells share a key');
  assert.equal(rows.flatMap((r) => r.cells).filter((c) => c === null).length, units.length * roles.length - 6, 'the cells with no agent are the empty ones');
  assert.equal(new Set(rows.map((r) => keyOf('row', r.unit))).size, units.length, 'no two rows share a key');
});
