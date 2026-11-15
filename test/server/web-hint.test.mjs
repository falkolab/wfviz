// Tests of the tracking notice (web/index.html, web/style.css, web/app.js, and the pure parts in web/lib.js): the text that is copied, its
// agreement with the contract, when the notice is open, how it is copied, and that it stays out of the way of everything else. The page
// runs on a small fake DOM (a copy of the one web-lib.test.mjs keeps, with focus, selection and event stopping added); it boots app.js
// itself, so what is checked is the code the browser runs. Where the look matters (the corner, the height, the covered pane) only the
// rules are read here; the placement is measured in a real browser by the node's own check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';
import { parseLabel } from '../../src/model/labels.mjs';
import { test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readWeb = (f) => fs.readFileSync(path.join(REPO, 'web', f), 'utf8');
const readRepo = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// the text as the node spec gives it: its own copy, so a change to the constant is a failing test and not a quiet agreement
const SPEC_PROMPT = [
  `Optional conventions so wfviz (a local viewer of Dynamic Workflow runs) can show this workflow in more detail. Use what fits; skip what does not. None of this is required: the workflow must work the same without it.`,
  `- Agent labels: "<role>:<unit>", with "#r<n>" for a repeat round, e.g. "writer:intro", "writer:intro#r2". wfviz then draws a role x unit matrix.`,
  `- Phases: pass a phase to each agent, so agents group by stage.`,
  `- Results as JSON objects:`,
  `  - problems found: an array "findings", each item { "file", "line", "severity", "description", "input" } (any subset; "file" helps most);`,
  `  - a decision: a string field "verdict", with an optional "reason";`,
  `  - test counts: an object "tests" with numeric "passed", "failed", "skipped".`,
  `- The workflow's own return value: put the run totals there, e.g. one "tests" object, so wfviz shows them as the run total.`,
  `- log() a short line when a phase starts or ends.`,
].join('\n');

const NOTICE_LABEL = 'Better tracking (optional)';
const FAILED_LABEL = 'Copy failed \u2014 select the text';

// =====================================================================================================================
// the text
// =====================================================================================================================

test('tracking prompt: the exported constant is exactly the text of the spec (LF lines, nested bullets indented by two spaces, no edge whitespace, ASCII)', () => {
  assert.equal(lib.TRACKING_PROMPT, SPEC_PROMPT);
  assert.equal(typeof lib.TRACKING_PROMPT, 'string');
  assert.equal(lib.TRACKING_PROMPT.split('\n').length, 9);
  assert.doesNotMatch(lib.TRACKING_PROMPT, /^\s|\s$/, 'no newline or space at either end');
  assert.doesNotMatch(lib.TRACKING_PROMPT, /\r|\t/);
  assert.doesNotMatch(lib.TRACKING_PROMPT, /[^\x20-\x7e\n]/, 'plain ASCII: the text pastes into any prompt box unchanged');
  assert.match(lib.TRACKING_PROMPT, /\n {2}- problems found: /, 'the three result bullets are nested under "Results as JSON objects:"');
  assert.doesNotMatch(lib.TRACKING_PROMPT, /<(b|i|p|br|div|span)\b|&[a-z]+;/i, 'no HTML in it');
});

test('tracking prompt: lib.js holds the one copy of the text, and index.html holds none (a quote or <role> in it would break the markup)', () => {
  const html = readWeb('index.html');
  assert.doesNotMatch(html, /Optional conventions|<role>|<unit>|run totals|repeat round/);
  assert.equal([...readWeb('lib.js').matchAll(/Optional conventions so wfviz/g)].length, 1);
  assert.doesNotMatch(readWeb('app.js'), /Optional conventions/, 'app.js uses the constant');
  assert.doesNotMatch(readWeb('style.css'), /Optional conventions/);
});

const contractSection = (n) => {
  const text = readRepo('docs/contract.md');
  const from = text.indexOf(`## ${n}.`);
  assert.ok(from >= 0, `contract has section ${n}`);
  const to = text.indexOf(`## ${n + 1}.`, from);
  assert.ok(to > from, `contract has section ${n + 1}`);
  return text.slice(from, to);
};

test('tracking prompt agrees with the contract: every field it names is a recognised field of section 3, as a whole backticked name', () => {
  const section3 = contractSection(3);
  const mentioned = [...new Set([...lib.TRACKING_PROMPT.matchAll(/"([a-z]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(mentioned, ['description', 'failed', 'file', 'findings', 'input', 'line', 'passed', 'reason', 'severity', 'skipped', 'tests', 'verdict'].sort(),
    'the prompt names these fields and no others (a new one needs a place in section 3 and here)');
  for (const name of mentioned) assert.ok(section3.includes(`\`${name}\``), `section 3 of the contract has \`${name}\``);
  // the run total: section 3 takes it from exactly one run-scope tests item, which is what the prompt asks the workflow's return value to hold
  assert.match(section3, /exactly one run-scope tests item/);
  assert.match(lib.TRACKING_PROMPT, /return value: put the run totals there, e\.g\. one "tests" object/);
});

test('tracking prompt agrees with the contract: the label examples parse as the prompt says (role and unit, a round only from "#r<n>")', () => {
  const section2 = contractSection(2);
  assert.match(section2, /`role:unit#tag`/);
  assert.match(section2, /`round` comes only from `#r<n>`/);
  const intro = parseLabel('writer:intro');
  assert.equal(intro.role, 'writer');
  assert.equal(intro.unit, 'intro');
  assert.equal(intro.round, null, 'no marker: no round');
  const again = parseLabel('writer:intro#r2');
  assert.equal(again.role, 'writer');
  assert.equal(again.unit, 'intro');
  assert.equal(again.round, 2);
  // the examples are read from the prompt itself, so changing one without the parser agreeing is red
  const examples = [...lib.TRACKING_PROMPT.matchAll(/"(writer:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(examples, ['writer:intro', 'writer:intro#r2']);
  assert.equal(parseLabel('<role>:<unit>').role, '<role>', 'the pattern line is a template, not a label');
});

test('tracking prompt is universal: it names no role, verdict value, file or tool of how this project is developed', () => {
  assert.doesNotMatch(lib.TRACKING_PROMPT, /\b(implement\w*|review\w*|judge|fixer?|verify|accept\w*|guide|gate|codex|node)\b/i);
  assert.doesNotMatch(lib.TRACKING_PROMPT, /\b[\w-]+\.(md|mjs|js|json)\b/, 'no file name');
  assert.doesNotMatch(lib.TRACKING_PROMPT, /\b[UNSM]\d{1,2}\b/, 'no node code');
  assert.match(lib.TRACKING_PROMPT, /^Optional conventions[^\n]*None of this is required: the workflow must work the same without it\.\n/, 'it says at once that it is optional');
});

// =====================================================================================================================
// the pure decisions
// =====================================================================================================================

test('hintInitiallyOpen: closed only for the exact stored "1"; no value, a storage that gave nothing and any other text open it', () => {
  assert.equal(lib.hintInitiallyOpen('1'), false);
  for (const v of [null, undefined, '0', '', 'true', 'yes', ' 1', '1 ', 1, true, 'closed']) assert.equal(lib.hintInitiallyOpen(v), true, String(v));
});

test('copyPath: "clipboard" only where navigator.clipboard.writeText is a function; every other navigator, and none, selects the text', () => {
  assert.equal(lib.copyPath({ clipboard: { writeText() {} } }), 'clipboard');
  assert.equal(lib.copyPath({ clipboard: { writeText: async () => {} } }), 'clipboard');
  for (const nav of [undefined, null, {}, { clipboard: null }, { clipboard: {} }, { clipboard: { writeText: 'x' } }, 'navigator', 7]) assert.equal(lib.copyPath(nav), 'select', String(nav));
});

test('copyLabel: the button text for idle, copied and failed (a long dash and one space each side); an unknown status is the idle text', () => {
  assert.equal(lib.copyLabel('idle'), 'Copy prompt');
  assert.equal(lib.copyLabel('copied'), 'Copied');
  assert.equal(lib.copyLabel('failed'), FAILED_LABEL);
  assert.equal(FAILED_LABEL, 'Copy failed \u2014 select the text');
  for (const s of [undefined, null, '', 'toString', 'constructor', 'COPIED', 7]) assert.equal(lib.copyLabel(s), 'Copy prompt', String(s));
});

test('focusQuietly and selectAll: the focus is given without scrolling, a text is selected after it, and an element that cannot do either is left alone', () => {
  const calls = [];
  const el = { focus: (o) => calls.push(['focus', o]), select: () => calls.push(['select']) };
  lib.focusQuietly(el);
  assert.deepEqual(calls, [['focus', { preventScroll: true }]]);
  calls.length = 0;
  lib.selectAll(el);
  assert.deepEqual(calls, [['focus', { preventScroll: true }], ['select']], 'focus first, then the selection');
  for (const bad of [null, undefined, {}, { focus: 1 }]) { lib.focusQuietly(bad); lib.selectAll(bad); }
});

// =====================================================================================================================
// the markup and the rules
// =====================================================================================================================

test('index.html: the notice is a dialog that is not modal, hidden until the page opens it, with the title, the line, a read-only box, the copy button and a close button; the header has the button that reopens it', () => {
  const html = readWeb('index.html');
  const tag = (id) => new RegExp(`<[a-z0-9]+ [^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? '';
  const notice = tag('hint');
  assert.ok(notice, '#hint is in index.html');
  assert.match(notice, /role="dialog"/);
  assert.ok(notice.includes(`aria-label="${NOTICE_LABEL}"`), 'it has an accessible name');
  assert.match(notice, /\shidden(\s|>)/, 'hidden in the markup: the page shows it once at load');
  assert.doesNotMatch(notice, /aria-modal|tabindex/, 'not modal, and no stop of its own in the tab order');
  assert.ok(html.includes('>Better tracking (optional)</h2>'), 'the title');
  assert.ok(html.includes('wfviz shows any run as it is. If you write the workflow, these conventions let it show more.'), 'the line');
  const box = tag('hint-text');
  assert.match(box, /^<textarea /);
  assert.match(box, /\sreadonly(\s|>)/);
  assert.match(box, /aria-label="[^"]+"/, 'the box has an accessible name');
  assert.match(html, /<textarea [^>]*id="hint-text"[^>]*><\/textarea>/, 'the box is empty in the markup: the page sets its value');
  assert.match(html, /<button id="hint-copy"[^>]*type="button"[^>]*>Copy prompt<\/button>/);
  assert.match(html, /<button id="hint-close"[^>]*type="button"[^>]*aria-label="Close"[^>]*>(×|&times;|x)<\/button>/);
  assert.match(html, /<button id="hint-open"[^>]*type="button"[^>]*>(?:<svg [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>)?Tracking hint<\/button>/, 'the accessible name is the text; an icon before it is hidden from assistive technology');
  assert.match(tag('hint-open'), /aria-controls="hint"/);
  assert.match(tag('hint-open'), /aria-expanded="false"/);
  // the header button is in the page header; the notice is in the log pane's box, after the log
  const header = /<header class="top">[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
  assert.ok(header.includes('id="hint-open"'), 'the button is in the header');
  const footer = /<footer id="log-pane"[\s\S]*?<\/footer>/.exec(html)?.[0] ?? '';
  assert.ok(footer.indexOf('id="hint"') > footer.indexOf('id="log"'), 'the notice follows the log inside the pane that it stands over');
  // none of the page's click handler hooks is on the notice
  const noticeHtml = /<section id="hint"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.ok(noticeHtml.length > 200);
  assert.doesNotMatch(noticeHtml + header.match(/<button id="hint-open"[^>]*>/)[0], /data-(agent|unit|view|run|result|tests-toggle)/);
});

// the warning sign (user, 2026-11-10): a yellow triangle with a "!" in the header button and in the title of the notice
test('index.html and style.css: the header button and the title of the notice each carry a small warning sign (an inline svg, aria-hidden, 14 px, no title, no network); the names stay "Tracking hint" and "Better tracking (optional)"; the yellow is the --warn token', () => {
  const html = readWeb('index.html');
  const css = readWeb('style.css');
  const button = /<button id="hint-open"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
  const title = /<h2 class="hint-title">([\s\S]*?)<\/h2>/.exec(html)?.[1] ?? '';
  for (const [where, inner, name] of [['the header button', button, 'Tracking hint'], ['the notice title', title, NOTICE_LABEL]]) {
    const svgs = [...inner.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0]);
    assert.equal(svgs.length, 1, `${where} has one warning sign`);
    const svg = svgs[0];
    assert.match(svg, /^<svg [^>]*aria-hidden="true"/, `${where}: hidden from assistive technology`);
    assert.match(svg, /focusable="false"/, `${where}: not focusable`);
    assert.match(svg, /\swidth="14"/, `${where}: 14 px wide`);
    assert.match(svg, /\sheight="14"/, `${where}: 14 px high`);
    assert.match(svg, /class="warn icon"/, `${where}: its class`);
    assert.doesNotMatch(svg, /<title\b|\baria-label\b|\brole=|<image\b|<use\b|href=|https?:|url\(|<style\b|#[0-9a-fA-F]{3,8}\b/, `${where}: no title, label or role (they would change the name), nothing loaded, no colour of its own`);
    assert.ok(inner.startsWith('<svg'), `${where}: the sign comes before the text`);
    assert.equal(inner.replace(svg, ''), name, `${where}: the text without the sign is the name`);
  }
  assert.ok(html.includes('>Better tracking (optional)</h2>'), 'the text follows the sign with nothing between');
  assert.ok(html.includes(`aria-label="${NOTICE_LABEL}"`), 'the dialog keeps its accessible name');
  // the look: the triangle is --warn (a token already in :root), the "!" the page background, and no rule of the sign has a colour of its own
  assert.match(css, /:root\s*\{[^}]*--warn:\s*#[0-9a-fA-F]{6}/);
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.icon\.warn/.test(m[1])).map((m) => ({ selector: m[1].trim(), body: m[2] }));
  assert.ok(rules.length >= 3, 'the sign has rules of its own');
  assert.match(rules.find((r) => /\.tri$/.test(r.selector))?.body ?? '', /fill:\s*var\(--warn\)/, 'the triangle is the warning colour');
  assert.match(rules.find((r) => /\.bang$/.test(r.selector))?.body ?? '', /stroke:\s*var\(--bg\)/, 'the "!" is the page background, readable on the yellow');
  for (const r of rules) assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b/, `${r.selector}: tokens only`);
  assert.match(rules.find((r) => r.selector === '.icon.warn')?.body ?? '', /width:\s*14px[^}]*height:\s*14px|height:\s*14px[^}]*width:\s*14px/, 'about 14 px in the style too');
  // in the header button the sign takes no room in the line (measured in headless Chrome, a run on show: 19 px of it in the line moved the
  // button to a row of its own between about 796 and 815 px wide, 30 px more header): it is out of the flow, over the corner of the button
  const inButton = rules.find((r) => r.selector === '.hint-open > .icon.warn')?.body ?? '';
  assert.match(inButton, /position:\s*absolute/, 'out of the flow: the button is as wide as it was without the sign');
  assert.match(inButton, /margin:\s*0\s*[;}]|margin:\s*0\s*$/, 'and no margin that would count again');
  const buttonRule = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === '.hint-open')?.[2] ?? '';
  assert.match(buttonRule, /position:\s*relative/, 'the corner is the button\'s');
});

// the rules of the css that have `needle` in their selector: [{ selector, body }]
const cssRules = (needle) => {
  const css = readWeb('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(needle)).map((m) => ({ selector: m[1].trim(), body: m[2].trim() }));
};

test('style.css: the notice stands in the bottom-right corner above the log pane, under the drawer, at most 420 px wide and half the window high, scrolling inside itself; tokens only', () => {
  const rules = cssRules('.hint');
  assert.ok(rules.length >= 6);
  const own = rules.find((r) => r.selector === '.hint')?.body ?? '';
  assert.match(own, /position:\s*absolute/);
  assert.match(own, /right:\s*14px/);
  assert.match(own, /bottom:\s*calc\(100% \+ 10px\)/, 'its bottom edge is 10 px above the pane, open, dragged or collapsed');
  assert.match(own, /max-width:\s*420px/);
  assert.match(own, /width:\s*min\(420px,\s*calc\(100vw - 28px\)\)/);
  assert.match(own, /max-height:\s*min\(50vh,/);
  assert.match(own, /overflow-y:\s*auto/);
  const drawerZ = Number(/\.drawer\s*\{[^}]*z-index:\s*(\d+)/.exec(readWeb('style.css'))?.[1]);
  const z = Number(/z-index:\s*(\d+)/.exec(own)?.[1]);
  assert.ok(drawerZ > 0 && z > 2 && z < drawerZ, `z-index ${z} is above the columns and under the drawer (${drawerZ})`);
  for (const r of rules) assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b/, `${r.selector}: tokens only`);
  assert.match(rules.find((r) => r.selector === '.hint-text').body, /resize:\s*none/);
  assert.match(rules.find((r) => r.selector === '.hint-text').body, /font:\s*inherit/);
  assert.match(rules.find((r) => r.selector === '.hint-title').body, /overflow-wrap:\s*anywhere/);
  assert.match(rules.find((r) => r.selector === '.hint-line').body, /overflow-wrap:\s*anywhere/);
  assert.match(rules.find((r) => r.selector.includes('.hint-copy')).body, /font:\s*inherit/);
  assert.match(readWeb('style.css'), /textarea:focus-visible[^{]*\{[^}]*outline:/, 'the box shows where the keyboard is');
  assert.doesNotMatch(own, /display:/, 'no display rule on the notice itself: the hidden attribute alone hides it');
});

// =====================================================================================================================
// the page: app.js on a fake DOM
// =====================================================================================================================

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);

class FText {
  constructor(data) { Object.assign(this, { nodeType: 3, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), data: String(data) }); }

  get textContent() { return this.data; }

  closest(sel) { return this.parentNode?.closest(sel) ?? null; }

  matches() { return false; }
}

const compound = (text) => {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/y;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4], value: m[5] ?? null });
  }
  return re.lastIndex === text.length ? c : null;
};
const hit = (el, c) => c !== null && (!c.tag || el.tag === c.tag) && (!c.id || el.attrs.get('id') === c.id) && c.classes.every((k) => el.classes.has(k))
  && c.attrs.every((a) => el.attrs.has(a.name) && (a.value === null || el.attrs.get(a.name) === a.value));
function selMatch(el, sel) {
  return String(sel).split(',').some((part) => {
    const chain = part.trim().split(/\s+/).map(compound);
    if (!hit(el, chain.at(-1))) return false;
    let n = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (n && !hit(n, chain[i])) n = n.parentNode;
      if (!n) return false;
      n = n.parentNode;
    }
    return true;
  });
}

// An element. Every write is counted in `writes` (attributes, classes, hidden, text, html, style, value). Focus and selection are
// recorded in the document's `log`. An event bubbles from its target to the document and stops where a listener calls stopPropagation.
class FEl {
  constructor(doc, tag) {
    Object.assign(this, { doc, tag, nodeType: 1, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), listeners: {}, writes: 0, _hidden: false, _value: '', scrollTop: 0, props: new Map() });
    const self = this;
    this.classList = {
      add(t) { self.writes++; self.classes.add(t); self.attrs.set('class', [...self.classes].join(' ')); },
      remove(t) { self.writes++; self.classes.delete(t); self.attrs.set('class', [...self.classes].join(' ')); },
      contains: (t) => self.classes.has(t),
      toggle(t, force) { const on = force === undefined ? !self.classes.has(t) : !!force; if (on) this.add(t); else this.remove(t); return on; },
    };
    this.style = { setProperty(k, v) { self.writes++; self.props.set(k, v); }, removeProperty(k) { self.writes++; self.props.delete(k); } };
  }

  get hidden() { return this._hidden; }

  set hidden(v) { this.writes++; this._hidden = !!v; }

  get value() { return this._value; }

  set value(v) { this.writes++; this._value = String(v); }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }

  set textContent(v) { this.writes++; this.childNodes = []; if (String(v) !== '') this.insertBefore(new FText(v), null); }

  get innerHTML() {
    const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return this.childNodes.map((n) => (n.nodeType === 3 ? esc(n.data) : `<${n.tag}${[...n.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${VOID.has(n.tag) ? '' : `${n.innerHTML}</${n.tag}>`}`)).join('');
  }

  set innerHTML(v) {
    this.writes++;
    this.childNodes = [];
    const make = (n) => {
      if (typeof n === 'string') return new FText(n);
      const el = new FEl(this.doc, n.tag);
      for (const [k, x] of Object.entries(n.attrs)) el.setAttribute(k, x);
      for (const kid of n.kids) { const c = make(kid); c.parentNode = el; el.childNodes.push(c); }
      return el;
    };
    for (const n of lib.parseHtml(v)) this.insertBefore(make(n), null);
  }

  setAttribute(k, v) { this.writes++; this.attrs.set(k, String(v)); if (k === 'class') this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  removeAttribute(k) { this.writes++; this.attrs.delete(k); if (k === 'class') this.classes = new Set(); }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    if (ref === null || ref === undefined) this.childNodes.push(node); else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }

  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }

  matches(sel) { return selMatch(this, sel); }

  closest(sel) { for (let n = this; n; n = n.parentNode) if (n.nodeType === 1 && selMatch(n, sel)) return n; return null; }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1 && selMatch(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  // this element and everything under it
  subtree() {
    const out = [this];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }

  dispatch(type, extra = {}) {
    let stopped = false;
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...extra };
    for (let n = this; n && !stopped; n = n.parentNode) {
      for (const fn of [...(n.listeners?.[type] || [])]) fn(ev);
      if (n === this && this.onclick && type === 'click') this.onclick(ev);
    }
    if (!stopped) for (const fn of [...(this.doc.listeners[type] || [])]) fn(ev);
    return ev;
  }

  focus(opts) { this.doc.activeElement = this; this.doc.log.push(`focus ${this.attrs.get('id') ?? this.tag}${opts?.preventScroll ? ' (no scroll)' : ''}`); }

  blur() { if (this.doc.activeElement === this) this.doc.activeElement = null; }

  select() { this.doc.log.push(`select ${this.attrs.get('id') ?? this.tag}`); }

  scrollIntoView() {}

  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

// index.html as elements: tags, attributes and nesting (the page never reads text nodes of the markup)
function pageFromHtml(doc, text) {
  const root = new FEl(doc, 'html');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } continue; }
    const el = new FEl(doc, tag);
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (a[1] === 'hidden') el._hidden = true; else el.attrs.set(a[1], v);
      if (a[1] === 'class') el.classes = new Set(v.split(/\s+/).filter(Boolean));
    }
    const parent = stack.at(-1);
    el.parentNode = parent;
    parent.childNodes.push(el);
    if (!m[4] && !VOID.has(tag)) stack.push(el);
  }
  return root;
}

const GLOBALS = ['document', 'window', 'location', 'history', 'localStorage', 'navigator', 'fetch', 'EventSource', 'ResizeObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
let boots = 0;

const reg = (value, from = 'f:1') => ({ value, prov: 'registered', from });
const inf = (value, method = 'label-pattern') => ({ value, prov: 'inferred', method });
const unk = (reason = 'because') => ({ value: null, prov: 'unknown', reason });
const fin = (value, from = 'wf.json#status') => ({ value, prov: 'final', from });
function sampleRun(id = 'wf_h') {
  const a1 = {
    id: 'a1', label: reg('writer:intro'), role: inf('writer'), unit: inf('intro'), round: unk('no round'), tag: unk('no tag'),
    state: reg('done'), startedAt: inf(1000), endedAt: inf(2000), durationMs: inf(1000), lastActivity: unk(),
  };
  return {
    id, source: 'real', name: reg('a run'), status: fin('completed'), durationMs: fin(1000, 'wf.json#durationMs'),
    agents: { a1 }, order: ['a1'], totals: { agents: 1, running: 0, done: 1, failed: 0 },
    result: unk('none'), recognized: { findings: [], verdicts: [], tests: [] }, edges: [], phases: [], logs: unk('x'), error: unk('none'),
  };
}
const liveEvent = (runId, seq) => ({ runId, seq, ts: 1000 + seq, kind: 'agent.activity', agentId: 'a1', message: `event ${seq}`, prov: 'registered' });

// A storage that remembers what the page wrote (`kept`, shared between two boots to play a reload), and the sets it saw.
// `sets` and `removes` are only what concerns the notice (the page writes other keys of its own, such as the log's state).
function memoryStorage(kept = {}) {
  const sets = [];
  const removes = [];
  const ours = (k) => /hint/.test(k);
  return {
    kept, sets, removes,
    getItem: (k) => kept[k] ?? null,
    setItem: (k, v) => { if (ours(k)) sets.push([k, String(v)]); kept[k] = String(v); },
    removeItem: (k) => { if (ours(k)) removes.push(k); delete kept[k]; },
  };
}

// Boots app.js on index.html. `storage`: what localStorage is (an object with getItem/setItem/removeItem, or 'throws-on-access').
// `nav`: the navigator ('none' removes it). `exec`: what document.execCommand does (a function, or null for none).
async function bootPage({ storage = memoryStorage(), nav = {}, exec = () => true, mode = 'real', withRun = false, hash = '' } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const doc = { listeners: {}, title: 'wfviz', activeElement: null, log: [] };
  const html = pageFromHtml(doc, readWeb('index.html'));
  Object.assign(doc, {
    documentElement: new FEl(doc, 'html'), body: html.querySelector('body'),
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new FEl(doc, t), createElementNS: (ns, t) => new FEl(doc, t), createTextNode: (d) => new FText(d),
    addEventListener: (t, fn) => { (doc.listeners[t] ||= []).push(fn); }, elementFromPoint: () => null,
  });
  if (exec) doc.execCommand = (cmd) => { doc.log.push(`exec ${cmd}`); return exec(cmd); };
  html.querySelector('.grid').clientWidth = 1228;
  const timers = { pending: new Map(), cleared: [], n: 0, intervals: 0 };
  const runDoc = sampleRun();
  const summary = { id: runDoc.id, name: runDoc.name, status: runDoc.status, project: null, startedAt: null, agents: 1, running: 0, source: 'real' };
  const page = {
    doc, html, timers, storage, runDoc, es: null,
    el: (s) => { const e = html.querySelector(s); assert.ok(e, `the page has ${s}`); return e; },
    flush: async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); },
    emit(type, data) { for (const fn of page.es.listeners[type] || []) fn({ data: JSON.stringify(data) }); },
    async hello(m) { page.emit('hello', { mode: m, version: '1' }); await page.flush(); },
    async snapshot(r) { page.emit('run', r); await page.flush(); },
    async event(e) { page.emit('event', e); await page.flush(); },
    async click(el) { el.dispatch('click'); await page.flush(); },
    async key(el, key) { const ev = el.dispatch('keydown', { key }); await page.flush(); return ev; },
    // the timeouts the page asked for with this delay, still waiting
    waiting: (ms) => [...timers.pending].filter(([, t]) => t.ms === ms).map(([id]) => id),
    runTimeouts(ms) { for (const [id, t] of [...timers.pending]) if (ms === undefined || t.ms === ms) { timers.pending.delete(id); t.fn(); } },
    // the elements of the notice (the notice, what is in it, and the header button) and the writes they have taken so far
    hintEls: () => [...page.el('#hint').subtree(), page.el('#hint-open')],
    hintWrites: () => page.hintEls().map((e) => e.writes),
    restore() { for (const n of GLOBALS) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n]; } },
  };
  class FakeES {
    constructor() { this.listeners = {}; page.es = this; }

    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  }
  setGlobal('document', doc);
  setGlobal('window', { innerHeight: 800, innerWidth: 1228, addEventListener() {} });
  // the page's address: the picker's filters live in location.hash (read at the start, written with history.replaceState)
  const location = { hash, pathname: '/', search: '' };
  setGlobal('location', location);
  setGlobal('history', { replaceState(_state, _title, url) { location.hash = String(url).startsWith('#') ? String(url) : ''; } });
  if (storage === 'throws-on-access') Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('storage is denied'); }, configurable: true });
  else setGlobal('localStorage', storage);
  setGlobal('navigator', nav === 'none' ? undefined : nav);
  setGlobal('getComputedStyle', () => ({ paddingLeft: '14px', paddingRight: '14px' }));
  setGlobal('CSS', { escape: (x) => String(x) });
  setGlobal('ResizeObserver', class { observe() {} });
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('EventSource', FakeES);
  setGlobal('setInterval', () => { timers.intervals++; return 1; });
  setGlobal('clearInterval', () => {});
  setGlobal('setTimeout', (fn, ms) => { const id = ++timers.n; timers.pending.set(id, { fn, ms }); return id; });
  setGlobal('clearTimeout', (id) => { timers.cleared.push(id); timers.pending.delete(id); });
  setGlobal('fetch', async (url) => {
    const u = String(url);
    let body;
    if (u === '/api/runs') body = withRun ? [summary] : [];
    else if (/\/events\?since=/.test(u)) body = [];
    else if (withRun && u === `/api/runs/${runDoc.id}`) body = page.runDoc;
    if (body === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  try {
    await import(`../../web/app.js?hint=${++boots}`);
    await page.flush();
    await page.hello(mode);
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}

// a rejection nobody handled during `fn` fails the test: the copy must handle the refusal of the clipboard itself
async function noUnhandledRejection(fn) {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on('unhandledRejection', on);
  try {
    await fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  } finally { process.off('unhandledRejection', on); }
  assert.deepEqual(seen, [], 'no unhandled rejection');
}

test('page: at load the box holds exactly the prompt, the notice is shown, the header button says so, and nothing has taken the focus', async () => {
  const page = await bootPage();
  try {
    assert.equal(page.el('#hint-text').value, SPEC_PROMPT);
    assert.equal(page.el('#hint').hidden, false);
    assert.equal(page.el('#hint-open').getAttribute('aria-expanded'), 'true');
    assert.equal(page.el('#hint').getAttribute('role'), 'dialog');
    assert.equal(page.el('#hint').getAttribute('aria-label'), NOTICE_LABEL);
    assert.equal(page.el('#hint').getAttribute('aria-modal'), null);
    assert.deepEqual(page.doc.log, [], 'no focus and no selection at load: the notice does not take the keyboard');
    assert.equal(page.waiting(2000).length, 0, 'no timer at load');
  } finally { page.restore(); }
});

// ---- open or closed at load ---------------------------------------------------------------------------------------------------

test('storage: a stored "1" loads the notice closed; no value, "0", an empty value and any other text load it open', async () => {
  for (const [stored, open] of [['1', false], [null, true], ['0', true], ['', true], ['true', true], ['closed', true]]) {
    const storage = memoryStorage(stored === null ? {} : { 'wfviz.hint.closed': stored });
    const page = await bootPage({ storage });
    try {
      assert.equal(page.el('#hint').hidden, !open, `stored ${JSON.stringify(stored)}`);
      assert.equal(page.el('#hint-open').getAttribute('aria-expanded'), String(open));
      assert.equal(page.el('#hint-text').value, SPEC_PROMPT, 'the text is in the box either way, ready for the header button');
      assert.deepEqual(storage.sets, [], 'loading writes nothing');
    } finally { page.restore(); }
  }
});

test('storage: a storage that throws (on every call, or on the access itself) shows the notice at load, and closing and reopening still work and do not throw', async () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  for (const storage of [bad, 'throws-on-access']) {
    const page = await bootPage({ storage });
    try {
      assert.equal(page.el('#hint').hidden, false, 'shown on each load without a storage');
      await page.click(page.el('#hint-close'));
      assert.equal(page.el('#hint').hidden, true, 'closing hides it even where it cannot be remembered');
      assert.equal(page.el('#hint-open').getAttribute('aria-expanded'), 'false');
      await page.click(page.el('#hint-open'));
      assert.equal(page.el('#hint').hidden, false);
    } finally { page.restore(); }
  }
});

test('storage: closing remembers "1" under the key wfviz.hint.closed; a reload then loads it closed; the header button opens it and writes nothing, so the next reload is still closed', async () => {
  const kept = {};
  const first = await bootPage({ storage: memoryStorage(kept) });
  try {
    assert.equal(first.el('#hint').hidden, false);
    await first.click(first.el('#hint-close'));
    assert.equal(first.el('#hint').hidden, true);
    assert.deepEqual(first.storage.sets, [['wfviz.hint.closed', '1']]);
    assert.equal(kept['wfviz.hint.closed'], '1');
  } finally { first.restore(); }
  const second = await bootPage({ storage: memoryStorage(kept) });
  try {
    assert.equal(second.el('#hint').hidden, true, 'closed after a reload');
    await second.click(second.el('#hint-open'));
    assert.equal(second.el('#hint').hidden, false, 'the header button shows it again');
    assert.equal(second.el('#hint-open').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(second.storage.sets, [], 'reopening writes nothing');
    assert.deepEqual(second.storage.removes, [], 'and removes nothing');
  } finally { second.restore(); }
  const third = await bootPage({ storage: memoryStorage(kept) });
  try { assert.equal(third.el('#hint').hidden, true, 'a reload shows it as the last close left it'); } finally { third.restore(); }
});

test('header button: with the notice already open it keeps it open (it opens, it does not toggle); closing twice writes the same value twice', async () => {
  const page = await bootPage();
  try {
    await page.click(page.el('#hint-open'));
    assert.equal(page.el('#hint').hidden, false);
    await page.click(page.el('#hint-close'));
    await page.click(page.el('#hint-close'));
    assert.equal(page.el('#hint').hidden, true);
  } finally { page.restore(); }
});

// ---- the modes and the run data ---------------------------------------------------------------------------------------------

test('modes: the notice is the same in REAL, DEMO and REPLAY, with a run and with none, and its box holds the same text', async () => {
  for (const mode of ['real', 'demo', 'replay']) {
    for (const withRun of [false, true]) {
      const page = await bootPage({ mode, withRun });
      try {
        const label = `${mode}${withRun ? ' with a run' : ' with no run'}`;
        assert.equal(page.el('#hint').hidden, false, label);
        assert.equal(page.el('#hint-text').value, SPEC_PROMPT, label);
        assert.equal(page.el('#hint-open').getAttribute('aria-expanded'), 'true', label);
        if (withRun) assert.ok(page.html.querySelector('[data-agent="a1"]'), `${label}: the run is drawn`);
        await page.click(page.el('#hint-close'));
        assert.equal(page.el('#hint').hidden, true, label);
      } finally { page.restore(); }
    }
  }
});

test('steady: snapshots, live events, a reconnect and the timers of the page write nothing to the notice or the header button, and add no listener or timer', async () => {
  const page = await bootPage({ withRun: true });
  try {
    const els = page.hintEls();
    const before = page.hintWrites();
    const listeners = els.map((e) => JSON.stringify(Object.fromEntries(Object.entries(e.listeners).map(([k, v]) => [k, v.length]))));
    const docListeners = Object.fromEntries(Object.entries(page.doc.listeners).map(([k, v]) => [k, v.length]));
    const intervals = page.timers.intervals;
    const run = page.runDoc;
    for (let i = 1; i <= 20; i++) {
      await page.snapshot({ ...structuredClone(run), name: reg(`a run ${i}`) });
      await page.event(liveEvent(run.id, i));
    }
    await page.hello('real'); // a reconnect
    page.runTimeouts(); // the highlight and every other timeout of the page
    await page.flush();
    assert.deepEqual(page.hintWrites(), before, 'not one write to any element of the notice');
    assert.deepEqual(page.hintEls(), els, 'the same elements');
    assert.deepEqual(els.map((e) => JSON.stringify(Object.fromEntries(Object.entries(e.listeners).map(([k, v]) => [k, v.length])))), listeners, 'no listener added on them');
    assert.deepEqual(Object.fromEntries(Object.entries(page.doc.listeners).map(([k, v]) => [k, v.length])), docListeners, 'no listener added on the document');
    assert.equal(page.timers.intervals, intervals, 'no interval');
    assert.equal(page.el('#hint').hidden, false);
    assert.equal(page.el('#hint-text').value, SPEC_PROMPT);
    assert.equal(page.el('#hint-copy').textContent, '', 'the copy button was not written: nobody copied');
    assert.deepEqual(page.doc.log, [], 'and the focus was not moved by any of it');
  } finally { page.restore(); }
});

test('steady: a closed notice stays closed through snapshots and events (nothing in the stream opens it)', async () => {
  const page = await bootPage({ withRun: true, storage: memoryStorage({ 'wfviz.hint.closed': '1' }) });
  try {
    const before = page.hintWrites();
    for (let i = 1; i <= 5; i++) { await page.snapshot(structuredClone(page.runDoc)); await page.event(liveEvent(page.runDoc.id, i)); }
    page.runTimeouts();
    assert.equal(page.el('#hint').hidden, true);
    assert.deepEqual(page.hintWrites(), before);
  } finally { page.restore(); }
});

// ---- copying ------------------------------------------------------------------------------------------------------------------

test('copy with a clipboard: writeText gets exactly the prompt once, the button says "Copied", and after 2 s it says "Copy prompt" again; the box is not selected and no command is run', async () => {
  const written = [];
  const page = await bootPage({ nav: { clipboard: { writeText: async (t) => { written.push(t); } } } });
  try {
    await page.click(page.el('#hint-copy'));
    assert.deepEqual(written, [SPEC_PROMPT]);
    assert.equal(written[0], SPEC_PROMPT, 'the constant itself: no HTML, no change at either end');
    assert.equal(page.el('#hint-copy').textContent, 'Copied');
    assert.equal(page.waiting(2000).length, 1, 'one timer of 2000 ms');
    assert.ok(!page.doc.log.some((l) => l.startsWith('exec') || l.startsWith('select')), 'the clipboard is the whole path');
    page.runTimeouts(2000);
    assert.equal(page.el('#hint-copy').textContent, 'Copy prompt');
    assert.equal(page.waiting(2000).length, 0);
    assert.equal(page.el('#hint').hidden, false, 'copying does not close the notice');
  } finally { page.restore(); }
});

test('copy twice within the 2 s: the first timer is cleared and one stays, so the label does not go back early and nothing stacks', async () => {
  const page = await bootPage({ nav: { clipboard: { writeText: async () => {} } } });
  try {
    await page.click(page.el('#hint-copy'));
    const [first] = page.waiting(2000);
    await page.click(page.el('#hint-copy'));
    const now = page.waiting(2000);
    assert.equal(now.length, 1, 'one timer waiting');
    assert.notEqual(now[0], first);
    assert.ok(page.timers.cleared.includes(first), 'the first was cleared before the second was made');
    assert.equal(page.el('#hint-copy').textContent, 'Copied');
    page.runTimeouts(2000);
    assert.equal(page.el('#hint-copy').textContent, 'Copy prompt');
  } finally { page.restore(); }
});

test('copy without navigator.clipboard (an empty navigator, or none): the text is selected in the box, then the document is asked to copy; success says "Copied"', async () => {
  for (const nav of [{}, { clipboard: {} }, 'none']) {
    const page = await bootPage({ nav, exec: () => true });
    try {
      await page.click(page.el('#hint-copy'));
      assert.deepEqual(page.doc.log, ['focus hint-text (no scroll)', 'select hint-text', 'exec copy'], 'selected first, then the command');
      assert.equal(page.el('#hint-copy').textContent, 'Copied');
      assert.equal(page.el('#hint-text').value, SPEC_PROMPT, 'the box still holds the text the command copies');
      page.runTimeouts(2000);
      assert.equal(page.el('#hint-copy').textContent, 'Copy prompt');
    } finally { page.restore(); }
  }
});

test('copy that fails: a command that says no, throws, or is missing gives "Copy failed" with the text selected for a copy by hand, and the label comes back after 2 s', async () => {
  const cases = [['returns false', () => false], ['throws', () => { throw new Error('not allowed'); }], ['is missing', null]];
  for (const [what, exec] of cases) {
    const page = await bootPage({ nav: {}, exec });
    try {
      await noUnhandledRejection(() => page.click(page.el('#hint-copy')));
      assert.equal(page.el('#hint-copy').textContent, FAILED_LABEL, `the command ${what}`);
      assert.ok(page.doc.log.includes('select hint-text'), 'the text is selected');
      assert.equal(page.doc.activeElement, page.el('#hint-text'), 'and has the focus, so Ctrl+C takes it');
      assert.equal(page.waiting(2000).length, 1);
      page.runTimeouts(2000);
      assert.equal(page.el('#hint-copy').textContent, 'Copy prompt');
    } finally { page.restore(); }
  }
});

test('copy that the clipboard refuses (a rejected promise, or a throw): "Copy failed", the text selected, no unhandled rejection, and no second path through the command', async () => {
  const refusals = [['rejects', async () => { throw new Error('permission denied'); }], ['throws at once', () => { throw new Error('no'); }], ['rejects with nothing', () => Promise.reject(undefined)]];
  for (const [what, writeText] of refusals) {
    const page = await bootPage({ nav: { clipboard: { writeText } } });
    try {
      await noUnhandledRejection(() => page.click(page.el('#hint-copy')));
      assert.equal(page.el('#hint-copy').textContent, FAILED_LABEL, `writeText ${what}`);
      assert.deepEqual(page.doc.log, ['focus hint-text (no scroll)', 'select hint-text'], 'selected for a copy by hand; the command was not tried');
      page.runTimeouts(2000);
      assert.equal(page.el('#hint-copy').textContent, 'Copy prompt', 'the failure label goes back too');
    } finally { page.restore(); }
  }
});

test('copy after a failure: a second click that works says "Copied" and one timer is left', async () => {
  let ok = false;
  const page = await bootPage({ nav: { clipboard: { writeText: async () => { if (!ok) throw new Error('no'); } } } });
  try {
    await page.click(page.el('#hint-copy'));
    assert.equal(page.el('#hint-copy').textContent, FAILED_LABEL);
    ok = true;
    await page.click(page.el('#hint-copy'));
    assert.equal(page.el('#hint-copy').textContent, 'Copied');
    assert.equal(page.waiting(2000).length, 1);
  } finally { page.restore(); }
});

test('copy writes only the text of its own button: the timer\'s write after the label changed touches nothing else', async () => {
  const page = await bootPage({ nav: { clipboard: { writeText: async () => {} } } });
  try {
    await page.click(page.el('#hint-copy'));
    const others = page.hintEls().filter((e) => e.attrs.get('id') !== 'hint-copy').map((e) => e.writes);
    page.runTimeouts(2000);
    assert.deepEqual(page.hintEls().filter((e) => e.attrs.get('id') !== 'hint-copy').map((e) => e.writes), others);
  } finally { page.restore(); }
});

// ---- keys and focus ----------------------------------------------------------------------------------------------------------

test('Escape inside the notice closes it, remembers that, gives the focus to the header button, and goes no further: an open drawer stays', async () => {
  const storage = memoryStorage();
  const page = await bootPage({ withRun: true, storage });
  try {
    await page.click(page.html.querySelector('[data-agent="a1"]'));
    assert.equal(page.el('#drawer').hidden, false, 'the drawer is open');
    for (const inside of ['#hint-copy', '#hint-text', '#hint-close', '#hint']) {
      await page.click(page.el('#hint-open')); // the notice is open again (it also takes the focus)
      assert.equal(page.el('#hint').hidden, false);
      page.doc.log.length = 0;
      const ev = await page.key(page.el(inside), 'Escape');
      assert.equal(page.el('#hint').hidden, true, `Escape on ${inside}`);
      assert.equal(page.el('#drawer').hidden, false, 'the page\'s Escape did not also close the drawer');
      assert.equal(page.doc.activeElement, page.el('#hint-open'), 'the focus is back on the header button');
      assert.deepEqual(page.doc.log, ['focus hint-open (no scroll)']);
      assert.equal(ev.defaultPrevented, false, 'nothing is prevented');
    }
    assert.ok(storage.sets.every(([k, v]) => k === 'wfviz.hint.closed' && v === '1'));
    assert.ok(storage.sets.length >= 4, 'closing by Escape is a close: it is remembered');
    // the page's own Escape still works, from outside the notice, and leaves the notice alone
    await page.click(page.el('#hint-open'));
    await page.key(page.doc.body, 'Escape');
    assert.equal(page.el('#drawer').hidden, true, 'Escape outside closes the drawer');
    assert.equal(page.el('#hint').hidden, false, 'and leaves the notice open');
  } finally { page.restore(); }
});

test('Escape inside the notice leaves an open run picker open; other keys inside it do nothing (no trap, nothing prevented)', async () => {
  const page = await bootPage({ withRun: true });
  try {
    await page.click(page.el('#rp-trigger'));
    assert.equal(page.el('#rp-panel').hidden, false, 'the picker is open');
    for (const key of ['Tab', 'Enter', ' ', 'ArrowDown', 'a']) {
      const ev = await page.key(page.el('#hint-copy'), key);
      assert.equal(page.el('#hint').hidden, false, `${key} does not close it`);
      assert.equal(ev.defaultPrevented, false, `${key} is not prevented: no focus trap`);
    }
    await page.key(page.el('#hint-text'), 'Escape');
    assert.equal(page.el('#hint').hidden, true);
    assert.equal(page.el('#rp-panel').hidden, false, 'the picker stays open: the page\'s Escape did not run');
  } finally { page.restore(); }
});

test('focus: the header button takes it into the notice (the copy button, without scrolling); the close button gives it back to the header button', async () => {
  const page = await bootPage({ storage: memoryStorage({ 'wfviz.hint.closed': '1' }) });
  try {
    assert.deepEqual(page.doc.log, []);
    await page.click(page.el('#hint-open'));
    assert.deepEqual(page.doc.log, ['focus hint-copy (no scroll)']);
    assert.equal(page.doc.activeElement, page.el('#hint-copy'));
    page.doc.log.length = 0;
    await page.click(page.el('#hint-close'));
    assert.deepEqual(page.doc.log, ['focus hint-open (no scroll)']);
    assert.equal(page.doc.activeElement, page.el('#hint-open'));
  } finally { page.restore(); }
});

test('clicks: nothing on the notice or the header button is a hook of the page\'s click handler, so a click there opens no drawer and changes no view', async () => {
  const page = await bootPage({ withRun: true });
  try {
    const view = (id) => page.el(id).hidden;
    const before = ['#view-matrix', '#view-phases', '#view-timeline', '#drawer'].map(view);
    for (const id of ['#hint', '#hint-text', '#hint-close', '#hint-open', '#hint-copy', '#hint-open']) {
      for (const e of page.el(id).subtree()) for (const a of e.attrs.keys()) assert.ok(!/^data-(agent|unit|view|run|result|tests-toggle)$/.test(a), `${id} has ${a}`);
      await page.click(page.el(id));
    }
    assert.deepEqual(['#view-matrix', '#view-phases', '#view-timeline', '#drawer'].map(view), before);
  } finally { page.restore(); }
});

// ---- the code of the page ------------------------------------------------------------------------------------------------

test('app.js: the notice code reads no run, mode or run list, writes no HTML and touches no storage but through localGet and localSet; the listeners are on its own elements', () => {
  const app = readWeb('app.js');
  const from = app.indexOf('// ---------- the tracking notice ----------');
  const to = app.indexOf('// ---------- events ----------');
  assert.ok(from > 0 && to > from, 'the section is there');
  const section = app.slice(from, to);
  assert.doesNotMatch(section, /state\.(run|runs|runId|mode|log|view|picker)\b/, 'it reads nothing of the run, the mode or the list');
  assert.doesNotMatch(section, /innerHTML|setHtml|esc\(|insertAdjacent/, 'no HTML is written');
  assert.doesNotMatch(section, /localStorage|sessionStorage|document\.cookie/);
  assert.equal([...app.matchAll(/localGet\('hint\.closed'\)/g)].length, 1, 'read once, at load');
  assert.equal([...app.matchAll(/localSet\('hint\.closed', '1'\)/g)].length, 1, 'written once, on closing');
  assert.equal([...app.matchAll(/localRemove\('hint/g)].length, 0);
  assert.match(app, /\$\('#hint'\)\.addEventListener\('keydown'/);
  assert.equal([...app.matchAll(/document\.addEventListener\('keydown'/g)].length, 1, 'the page\'s one document-level key listener is untouched');
  assert.equal([...app.matchAll(/setInterval\(/g)].length, 1, 'no interval added');
  // the one timer of the notice: in the copy status, its handle in the state, cleared before a new one
  assert.equal([...section.matchAll(/setTimeout\(/g)].length, 1);
  assert.match(section, /clearTimeout\(state\.hintTimer\)/);
  assert.match(section, /state\.hintTimer = [^;]*setTimeout\(/);
  // every line of the page that mentions the notice is in the imports, the state field, its own section or its boot code at the end
  const lines = app.split('\n');
  const sectionStart = app.slice(0, from).split('\n').length;
  const sectionEnd = app.slice(0, to).split('\n').length;
  const bootStart = app.slice(0, app.indexOf("$('#hint-text').value = TRACKING_PROMPT;")).split('\n').length;
  const bootEnd = app.slice(0, app.indexOf('renderRunPicker();\nloadRuns();')).split('\n').length;
  assert.ok(bootStart > sectionEnd && bootEnd > bootStart, 'the notice\'s boot code is one block after the page\'s events');
  // the one exception: the run-level branch of openHit (the run search section) calls closeHintForHit(), the function of the notice's own section that
  // hides it (nothing stored) when a search hit's notice is shown, since in a narrow window it would cover that one
  const searchFrom = app.slice(0, app.indexOf('// ---------- run search ----------')).split('\n').length;
  const searchTo = app.slice(0, app.indexOf('// ---------- replay of a finished run ----------')).split('\n').length;
  assert.ok(searchFrom > 0 && searchTo > searchFrom, 'the run search section is there');
  const hitCalls = [];
  lines.forEach((line, k) => {
    const n = k + 1;
    if (!/hint/i.test(line) || /^\s*\/\//.test(line)) return;
    const own = (n >= sectionStart && n < sectionEnd) || (n >= bootStart && n < bootEnd)
      || /^import \{ TRACKING_PROMPT, /.test(line) || /hintTimer: null/.test(line);
    if (own) return;
    const hitCall = n >= searchFrom && n < searchTo && /\bcloseHintForHit\(\);/.test(line) && !/\bhint\w*\b/i.test(line.replace(/closeHintForHit/g, ''));
    if (hitCall) hitCalls.push(n);
    assert.ok(hitCall, `line ${n} mentions the notice outside its own code: ${line.trim()}`);
  });
  assert.equal(hitCalls.length, 1, 'the search section calls closeHintForHit() once (the run-level branch of openHit), and mentions the notice nowhere else');
});
