// test/server/fake-page.mjs: the fake browser of the page tests of the run search (not a test file). It is the one of web-u4.test.mjs, which keeps its
// own copy: the real index.html parsed into elements that keep what is written to them and count every write, html written to an element kept as
// nodes, every node made, removed or moved recorded like a MutationObserver's records, a fetch that answers from a table (and keeps the init it was
// given), timers that are only recorded, an event stream that a test pushes into. Differences from that copy: an event whose listener calls
// stopPropagation goes no further (a listener of the document does not see it), and the fetch records its init (page.inits) so a test can see the
// signal of a request. The page code is not changed for the test: bootPage imports web/app.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';

const parseFragment = lib.parseHtml;
const WEB = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
const XHTML = 'http://www.w3.org/1999/xhtml';
// what esc() writes: the same five characters, so the html an element gives back is the html the page wrote
const escS = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function serialize(n) {
  if (n.nodeType === 3) return escS(n.data);
  const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escS(v)}"`).join('');
  return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${serializeKids(n)}</${n.tag}>`;
}
const serializeKids = (n) => n.childNodes.map(serialize).join('');

// the mutations of a document, like the records of a MutationObserver (kept only while a test asks: doc.mut is an array)
const recorder = (doc) => (type, parent, node) => {
  if (doc.mut) doc.mut.push({ type, parent, node, ser: type === 'add' || type === 'remove' ? serialize(node) : null });
};

// a text node: its own writes are counted, and a change of its data is a write of the node, not of an element
class TextNode {
  constructor(doc, data) {
    Object.assign(this, { doc, nodeType: 3, nodeName: '#text', tag: '#text', childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), writes: 0, moves: 0, htmlWrites: 0, _data: String(data) });
  }

  get data() { return this._data; }

  set data(v) { this.writes++; this._data = String(v); this.doc.note?.('text', this.parentNode, this); }

  get textContent() { return this._data; }

  get html() { return escS(this._data); }

  get ownerDocument() { return this.doc; }

  closest(sel) { return this.parentNode ? this.parentNode.closest(sel) : null; }

  contains(n) { return n === this; }

  matches() { return false; }
}

function matchesCompound(el, c) {
  if (c.tag && el.tag.toLowerCase() !== c.tag) return false;
  if (c.id && el.attrs.get('id') !== c.id) return false;
  if (c.classes.some((k) => !el.classes.has(k))) return false;
  return c.attrs.every((a) => el.attrs.has(a.name) && (a.value === null || el.attrs.get(a.name) === a.value));
}
function parseCompound(text) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else c.attrs.push({ name: m[4], value: m[5] ?? null });
  }
  if (re.lastIndex !== text.length) return null; // a selector the fake does not know matches nothing
  return c;
}
// "a, b c": a list of chains; a chain is compounds with the descendant combinator only (the page uses nothing else)
// (parsed once per selector text: the page asks the same few selectors thousands of times, and a test that feeds it 2000 events spent most of its time here)
const selectorCache = new Map();
const parseSelector = (sel) => {
  let parsed = selectorCache.get(sel);
  if (parsed === undefined) selectorCache.set(sel, (parsed = String(sel).split(',').map((part) => part.trim().split(/\s+/).map(parseCompound))));
  return parsed;
};
function elMatches(el, sel) {
  return parseSelector(sel).some((chain) => {
    if (chain.some((c) => c === null)) return false;
    if (!matchesCompound(el, chain.at(-1))) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i--) {
      while (node && !matchesCompound(node, chain[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class El {
  constructor(doc, tag, ns = null) {
    Object.assign(this, { doc, tag, ns, nodeType: 1, childNodes: [], parentNode: null, attrs: new Map(), classes: new Set(), props: new Map(), text: '', writes: 0, htmlWrites: 0, moves: 0, listeners: {} });
    Object.assign(this, { _hidden: false, value: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0, offsetWidth: 0, scrolledIntoView: 0 });
    const self = this;
    this.classList = {
      add(t) { self.writes++; self.classes.add(t); self.syncClass(); },
      remove(t) { self.writes++; self.classes.delete(t); self.syncClass(); },
      contains: (t) => self.classes.has(t),
      toggle(t, force) {
        const on = force === undefined ? !self.classes.has(t) : !!force;
        self.writes++;
        if (on) self.classes.add(t); else self.classes.delete(t);
        self.syncClass();
        return on;
      },
    };
    this.style = {
      setProperty(k, v) { self.writes++; self.props.set(k, v); },
      removeProperty(k) { self.writes++; self.props.delete(k); },
    };
  }

  syncClass() { this.attrs.set('class', [...this.classes].join(' ')); }

  // the box of an element: 0 unless a test sets it or gives the document a `layout(el) -> { top, height } | null` (the drawer's sections have no
  // real layout in a fake browser, and a click on a search result scrolls the drawer to one of them)
  get offsetTop() { return this._top ?? this.doc.layout?.(this)?.top ?? 0; }

  set offsetTop(v) { this._top = v; }

  get offsetHeight() { return this._height ?? this.doc.layout?.(this)?.height ?? 0; }

  set offsetHeight(v) { this._height = v; }

  get id() { return this.attrs.get('id') ?? ''; }

  get className() { return this.attrs.get('class') ?? ''; }

  set className(v) { this.setAttribute('class', v); }

  get hidden() { return this._hidden; }

  set hidden(v) { this.writes++; this._hidden = !!v; }

  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return out;
  }

  get ownerDocument() { return this.doc; }

  get namespaceURI() { return this.ns ?? XHTML; }

  get nodeName() { return this.ns ? this.tag : this.tag.toUpperCase(); }

  get textContent() { return this.childNodes.length ? this.childNodes.map((c) => c.textContent).join('') : this.text; }

  set textContent(v) {
    this.writes++;
    for (const c of this.childNodes) { this.doc.note?.('remove', this, c); c.parentNode = null; }
    this.childNodes = [];
    this.text = String(v);
  }

  // what the element holds, as the html a browser would give back: nodes, not the string that was written
  get html() { return serializeKids(this); }

  get innerHTML() { return serializeKids(this); }

  set innerHTML(v) {
    this.writes++;
    this.htmlWrites++;
    for (const c of this.childNodes) { this.doc.blurIfInside(c); this.doc.note?.('remove', this, c); c.parentNode = null; }
    this.childNodes = [];
    this.scrollTop = 0;
    this.text = '';
    const make = (n) => {
      if (typeof n === 'string') return new TextNode(this.doc, n);
      const el = new El(this.doc, n.tag, this.ns);
      for (const [k, x] of Object.entries(n.attrs)) el.setAttribute(k, x);
      for (const kid of n.kids) { const c = make(kid); c.parentNode = el; el.childNodes.push(c); }
      return el;
    };
    for (const n of parseFragment(v)) {
      const c = make(n);
      c.parentNode = this;
      this.childNodes.push(c);
      this.doc.note?.('add', this, c);
    }
  }

  setAttribute(k, v) {
    this.writes++;
    this.attrs.set(k, String(v));
    if (k === 'class') this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  removeAttribute(k) { this.writes++; this.attrs.delete(k); if (k === 'class') this.classes = new Set(); }

  hasAttribute(k) { return this.attrs.has(k); }

  insertBefore(node, ref) {
    this.doc.note?.(node.parentNode ? 'move' : 'add', this, node);
    if (node.parentNode) {
      this.doc.blurIfInside(node);
      node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    }
    node.parentNode = this;
    node.moves++;
    if (ref === null || ref === undefined) this.childNodes.push(node);
    else this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    assert.ok(i >= 0, 'removeChild: the element is a child of this parent');
    this.doc.blurIfInside(node);
    this.doc.note?.('remove', this, node);
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }

  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  matches(sel) { return elMatches(this, sel); }

  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (elMatches(n, sel)) return n;
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) { if (elMatches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }

  // an event that bubbles to the document, like the browser's
  dispatch(type, extra = {}) {
    const ev = { type, target: this, currentTarget: this, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (let n = this; n; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners[type] || [])]) fn(ev);
      if (ev.stopped) return ev;
    }
    for (const fn of [...(this.doc.listeners[type] || [])]) fn(ev);
    return ev;
  }

  // listeners of this element only (the pointer events of a handle, which has its own)
  fire(type, ev = {}) { for (const fn of [...(this.listeners[type] || [])]) fn(ev); }

  focus() { this.doc.activeElement = this; }

  blur() { if (this.doc.activeElement === this) this.doc.activeElement = null; }

  scrollIntoView() { this.scrolledIntoView++; }

  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

// index.html as elements: a small parser (tags, attributes, nesting; no text nodes, the page never reads them)
function parseHtml(doc, text) {
  const root = new El(doc, 'html');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/)?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const el = new El(doc, tag);
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (a[1] === 'hidden') el._hidden = true;
      else el.attrs.set(a[1], v);
      if (a[1] === 'class') el.classes = new Set(v.split(/\s+/).filter(Boolean));
    }
    const parent = stack.at(-1);
    el.parentNode = parent;
    parent.childNodes.push(el);
    if (!m[4] && !VOID.has(tag) && tag !== 'svg' && tag !== 'line') stack.push(el);
    else if (tag === 'svg' && !m[4]) stack.push(el);
  }
  return root;
}

const GLOBALS = ['document', 'window', 'location', 'history', 'localStorage', 'fetch', 'EventSource', 'ResizeObserver', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const setGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
let bootCount = 0;

// opts: runs (the list), runDocs (id -> Run), events (id -> UiEvent[], what the backlog answers), width, height, storage, layout (see offsetTop)
export async function bootPage({ runs = [], runDocs = {}, events = {}, width = 1228, height = 800, storage = {}, failEvents = null, hash = '', answer = null, layout = null } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const doc = { listeners: {}, title: 'wfviz', activeElement: null };
  const html = parseHtml(doc, read('index.html'));
  const body = html.querySelector('body');
  Object.assign(doc, {
    documentElement: new El(doc, 'html'), body, html,
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new El(doc, t), createElementNS: (ns, t) => new El(doc, t, ns), createTextNode: (d) => new TextNode(doc, d),
    mut: null,
    layout,
    note: recorder(doc),
    addEventListener: (t, fn) => { (doc.listeners[t] ||= []).push(fn); }, elementFromPoint: () => null,
    blurIfInside(node) { if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = null; },
  });
  html.querySelector('.grid').clientWidth = width;
  const timers = { intervals: new Map(), timeouts: new Map(), n: 0 };
  const windowListeners = {};
  const page = {
    doc, timers, storage, requests: [], inits: [], es: null, root: doc.documentElement, runs, runDocs, events, failEvents, answer, windowListeners,
    el: (s) => { const e = html.querySelector(s); assert.ok(e, `index.html has ${s}`); return e; },
    flush: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); },
    runTimeouts(ms) { for (const [id, t] of [...timers.timeouts]) if (t.ms === ms) { timers.timeouts.delete(id); t.fn(); } },
    emit(type, data) { for (const fn of page.es.listeners[type] || []) fn({ data: JSON.stringify(data) }); },
    async hello(mode) { page.emit('hello', { mode, version: '1' }); await page.flush(); },
    async snapshot(r) { page.emit('run', r); await page.flush(); },
    async event(e) { page.emit('event', e); await page.flush(); },
    eventRequests: () => page.requests.filter((u) => /\/events\?/.test(u)),
    // a click on an element: the page's one click handler, with the element as target
    async click(el) { el.dispatch('click'); await page.flush(); },
    async key(el, key, extra = {}) { const ev = el.dispatch('keydown', { key, ...extra }); await page.flush(); return ev; },
    async type(text) { const input = page.el('#rp-search'); input.value = text; input.dispatch('input'); await page.flush(); },
    // the text of the search box of the header: the input event, nothing more (the page waits its own delay)
    async typeSearch(text) { const input = page.el('#search-input'); input.value = text; input.dispatch('input'); await page.flush(); },
    restore() { for (const n of GLOBALS) { if (saved[n]) Object.defineProperty(globalThis, n, saved[n]); else delete globalThis[n]; } },
  };
  class FakeES {
    constructor() { this.listeners = {}; page.es = this; }

    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  }
  setGlobal('document', doc);
  setGlobal('window', { innerHeight: height, innerWidth: width, addEventListener(t, fn) { (windowListeners[t] ||= []).push(fn); } });
  // the page's address: the picker's filters live in location.hash (read at the start, written with history.replaceState)
  const location = { hash, pathname: '/', search: '' };
  setGlobal('location', location);
  setGlobal('history', { replaceState(_state, _title, url) { location.hash = String(url).startsWith('#') ? String(url) : ''; } });
  setGlobal('localStorage', { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } });
  setGlobal('getComputedStyle', () => ({ paddingLeft: '14px', paddingRight: '14px' }));
  setGlobal('CSS', { escape: (x) => String(x) });
  setGlobal('ResizeObserver', class { observe() {} });
  setGlobal('requestAnimationFrame', () => 0);
  setGlobal('EventSource', FakeES);
  setGlobal('setInterval', (fn, ms) => { timers.intervals.set(++timers.n, { fn, ms }); return timers.n; });
  setGlobal('clearInterval', (id) => { timers.intervals.delete(id); });
  setGlobal('setTimeout', (fn, ms) => { timers.timeouts.set(++timers.n, { fn, ms }); return timers.n; });
  setGlobal('clearTimeout', (id) => { timers.timeouts.delete(id); });
  setGlobal('fetch', async (url, init) => {
    const u = String(url);
    page.requests.push(u);
    page.inits.push({ url: u, init });
    // a test may answer a request itself: { ok, status, json } or a promise of it; undefined leaves the request to the rules below
    if (page.answer) {
      const given = await page.answer(u);
      if (given !== undefined) return given;
    }
    let m;
    let body;
    if (u === '/api/runs') body = page.runs;
    else if ((m = /^\/api\/runs\/([^/?]+)\/events\?since=(\d+)$/.exec(u))) {
      if (page.failEvents) return { ok: false, status: page.failEvents, json: async () => null };
      body = (page.events[decodeURIComponent(m[1])] ?? []).filter((e) => e.seq > Number(m[2]));
    } else if ((m = /^\/api\/runs\/([^/?]+)$/.exec(u))) body = page.runDocs[decodeURIComponent(m[1])];
    if (body === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });
  try {
    await import(`../../web/app.js?fake=${++bootCount}`);
    await page.flush();
    page.emit('hello', { mode: 'real', version: '1' });
    await page.flush();
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}


// every element of a region of the page, to count writes and to see what was made
export function allEls(page, regions) {
  const out = [];
  const walk = (n) => { out.push(n); n.childNodes.forEach(walk); };
  for (const r of regions) { const e = page.doc.querySelector(r); if (e) walk(e); }
  return out;
}
