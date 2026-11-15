// wfviz interface. Renders the Run model from docs/contract.md; knows nothing about
// specific workflows: roles, units, phases and labels all come from run data.
//
// Data flow (contract 2): the page reads a run with GET /api/runs/:id and its event backlog with
// GET /api/runs/:id/events?since=0, then follows two SSE feeds: `run` (a full snapshot, at most once a second) and
// `event` (one per store event, no delay). The event log and the highlights come from `event`, never from
// differences between snapshots. The views are brought up to date when a snapshot arrives (data changed).
// The decisions (matrix, report card, diff, log, hover, edges, sizes, patches) are in lib.js, which has no DOM.
//
// Steady drawing: nothing is rebuilt. Every list on the page is a keyed list (lib.js patchList): matrix cells and their row labels,
// phase cards, timeline rows, findings, log lines, the report cells, the picker rows and the rest are elements described as data (a
// spec, or a group of specs) and kept in a Map by key. A snapshot compares each spec with the one drawn before; an element whose spec
// did not change is not touched (not even an attribute or a text write), a changed one is updated in place, new ones are inserted,
// gone ones removed. The html inside an element, and a box whose content is one string (the hover panel, the head of a lane, the two
// notes under the legend and the log), is written only when its string changed, and then only the text or the attribute that differs
// is written (lib.js morphHtml): the nodes of what did not change are not removed and put back.
// The only interval is the 1 s clock of the elapsed time of a running run of source real; it writes the text of one element. The
// 1.5 s highlight, the transcript read and the log of a drag use no timer of their own.
// The label of the copy button in the tracking notice goes back after 2 s: one timer, and it writes only that button's text.
// The replay's frame queue (lib.js createReplayQueue) has one timer at a time, for the next kept frame; none while it holds nothing, while it
// is paused, or once the replay was left.
//
// Usage and cost (contract sections 2 and 4, P2): the report card of an ended run and the drawer of an agent show the four token counters of
// Agent.usage / totals.usage with their provenance, and a cost line computed here from them and GET /api/prices (see "usage and cost" below). The
// price list is asked for once per page, only when a cost is first shown; no timer, listener or storage is added for it. A Run whose source is
// "demo" has made-up tokens: its counters are shown, its cost is not (no cost cell, no cost row, no request for prices). A cost that leaves out
// the tokens of messages with no model says how many.
//
// Run search (contract section 4, GET /api/search): the box in the header asks the server, 250 ms after the last key, to look through the loaded runs;
// the results are a panel of rows (run, agent, field, an excerpt with the match marked as DOM nodes, never as html). A click opens the run and the
// agent drawer at the field. See the run search section.
//
// Replay of a finished run (contract sections 1 and 4): a run of source real that is not running has a Replay control. The replay stream
// is read with fetch (its own reader, never the page's EventSource): its events go to the same event log and highlight as live ones,
// its snapshots to the same views, and the replayed Run takes the place of the real one on show until Stop. Nothing of the replay reaches
// the run list, the run's own event log read from the server or the real stream's state, and nothing of the real stream's `run` and
// `event` for the run on show is drawn while the replay is on show.
import {
  val, esc, agentsOf, agentState, visualState, isInterrupted, isBusy, interruptNote, tagOf, barEnd,
  isFinalStatus, testsEmptyMessage, reportCard, editDiff, hasEditInput,
  createEventLog, isMarker, logLine, logOrder, lineSeq, retimedLines, logHeader, isNearBottom, roundHistory, groupHeading, edgeKey, edgeEmphasis, edgesOf,
  relatedIds, hoverInfo, lastEventOf, splitError, runOption, elapsedFact, fetchErrorText, backlogNotice, modeInfo,
  slotVar, orderOfAppearance, runStatusClass, pickerRow, filterRunRows, summaryOfRun, mergeRun, mergeRunList, scrollToShow,
  morphHtml, keyOf, dedupeKeys, sameJson, specOf, groupOf, createSpecEl, updateSpecEl, createNode, updateNode, entryKeys, createListState, patchList, appendItems, prependItems, dropItems, clearList,
  matrixModel, findingCounts, clockTick, testsView, clampLayout, dragLayout, parseStoredSize,
  scopeSplit, runItemLabel, runResultView,
} from './lib.js';
import { TRACKING_PROMPT, hintInitiallyOpen, copyPath, copyLabel, focusQuietly, selectAll } from './lib.js';
import {
  isCalendarDate, parsePickerHash, formatPickerHash, runPassesFilter, pickerFilterOptions, sanitizePickerFilter,
  NOT_LOADED_TEXT, LOADING_TEXT, loadFailedText,
} from './lib.js';
import {
  ENGINES_NOTE, usageParts, runCostView, agentCostView, runNeedsPrices, agentNeedsPrices, pricesAnswer, showsCost,
} from './lib.js';
import {
  createSearch, searchItems, searchStatus, notSearchedLine, highlightParts, searchSection, SEARCH_DELAY_MS,
} from './lib.js';
import {
  parseReplaySpeed, replayUrl, replayControl, replayFailure, replayHelloProblem, replayRunProblem, replayCutText, createSseParser, readReplayFrame,
  createReplayQueue, REPLAY_WAITING, REPLAY_SPEEDS,
} from './lib.js';

const $ = (s) => document.querySelector(s);
const FLASH_MS = 1500;
const LOG_CAP = 2000;
const MAX_SHOWN = 20000; // characters of one diff block drawn; the rest is announced, not hidden silently
const SVG_NS = 'http://www.w3.org/2000/svg';
const FLASH_SELECTOR = '.cell[data-agent], .tl-bar[data-agent], .acard[data-agent]';
// the sizes the user can drag, and where each is kept (CSS variable, storage key)
const SIZES = {
  left: { prop: '--left-w', key: 'layout.left' },
  right: { prop: '--right-w', key: 'layout.right' },
  log: { prop: '--log-h', key: 'layout.log' },
};

const state = {
  runs: [], runsTouched: new Set(), run: null, runId: null, runsLoaded: false, mode: null, view: localGet('view') || 'matrix', weak: false,
  drawn: new Set(), drawerAgent: null, drawerResult: false,
  log: createEventLog({ cap: LOG_CAP }), sel: 0, gotSnapshot: false, refetching: false, hellos: 0,
  flash: new Map(), flashEnds: new Map(), transcript: null, trToken: 0, trTimer: null,
  expanded: new Set(), testsExpanded: false, backlogSeq: 0, hover: null, pointer: null, backlogError: null, errOpen: false,
  clock: null, layout: {}, hoverPos: '', edgesQueued: false, hintTimer: null,
  // the replay of the run on show: null, or { runId, speed, phase, shown, begun, real, queue, abort, closed, over, endSeen, count, line } (see the replay section)
  replay: null, replaySpeed: parseReplaySpeed(localGet('replay.speed')),
  // the run picker: open or not, the text typed in its search field, the row the keyboard is on (a run id, not a position), the
  // run ids of the rows shown and the id each row has for the input's aria-activedescendant
  // `ctl`: what each filter control was last made to show (the control keeps what the user is typing until the filter itself changes)
  picker: { open: false, active: null, shown: [], optIds: new Map(), loading: new Set(), loadError: null, ctl: {} },
  // the picker's filters (run history): range, project, status, from, to and the search text q. Their only home is location.hash
  // (read at the start and on hashchange, written with history.replaceState); nothing is stored. See lib.js parsePickerHash.
  filter: parsePickerHash(readHash()),
  // the price list of GET /api/prices (usage and cost): { phase: 'idle' | 'loading' | 'ok' | 'failed', data, reason }. It is asked for once per
  // page, when a cost is first shown (see ensurePrices); a failure stays (no retry), the reason is the server's.
  prices: { phase: 'idle', data: null, reason: null },
  // the search box (see the run search section): whether its results panel is open, what the query logic last told (lib.js createSearch), and
  // the result of a run's own field (name, description, log line) that a click put on show in the notice under the header (null: none)
  search: { open: false, view: { phase: 'idle', text: '', results: [], more: false, reason: null }, hit: null },
  // the section of the agent's drawer that a click on a search result asked for, { agentId, name, at } (null: none): kept and applied again after
  // every render of that drawer, until the drawer is scrolled by anything but the page (see applyDrawerTarget)
  drawerTarget: null,
};

function readHash() { try { return location.hash; } catch { return ''; } }

function localGet(k) { try { return localStorage.getItem('wfviz.' + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem('wfviz.' + k, v); } catch { /* ignore */ } }
function localRemove(k) { try { localStorage.removeItem('wfviz.' + k); } catch { /* ignore */ } }
// { data, error }: a failed request says why (HTTP status or the error's message), it is never a silent null
// `reason`: the `error` text of the JSON body of a failed answer, when it has one (the server says why in { error })
async function fetchJson(url, signal) {
  try {
    const r = await fetch(url, signal ? { signal } : undefined);
    if (!r.ok) {
      let reason = null;
      try { const body = await r.json(); if (typeof body?.error === 'string' && body.error !== '') reason = body.error; } catch { /* no JSON body */ }
      return { data: null, error: fetchErrorText({ status: r.status }), reason };
    }
    return { data: await r.json(), error: null };
  } catch (err) { return { data: null, error: fetchErrorText({ error: err }) }; }
}
async function getJson(url) { return (await fetchJson(url)).data; }
const enc = encodeURIComponent;

// ---------- writes that leave an unchanged page alone ----------
const lastHtml = new WeakMap();
// a box whose whole content is one string: written only when the string is not the one drawn last, and then patched against that
// string (the first time, and where a patch cannot be made, the box is written whole)
function setHtml(el, html) {
  const prev = lastHtml.get(el);
  if (prev === html) return;
  lastHtml.set(el, html);
  if (prev === undefined || !morphHtml(el, prev, html)) el.innerHTML = html;
}
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setShown(el, shown) { if (el.hidden === shown) el.hidden = !shown; }
// a style property set from here is remembered per element, so the same value is not written again
const styleSet = new WeakMap();
function setStyleProp(el, prop, value) {
  let m = styleSet.get(el);
  if (!m) styleSet.set(el, (m = new Map()));
  if (m.get(prop) === value) return;
  m.set(prop, value);
  el.style.setProperty(prop, value);
}

// ---------- keyed lists ----------
// An element made from a spec. A new element of an agent that is lit up right now joins the highlight where it is.
function makeEl(spec) {
  const el = createSpecEl(document, spec);
  paintFlashEl(el);
  return el;
}
// An element made from a spec or from a group of specs (lib.js groupOf: an element with a keyed list of its own inside), joining the
// highlight like makeEl.
function makeNode(item) {
  const el = createNode(document, item);
  paintFlashEl(el);
  return el;
}
// A list of spec items in `parent`, which holds nothing else. `create` / `update` are given for items that are not plain specs.
function listOf(parent, { create = makeEl, update = updateSpecEl } = {}) {
  const st = createListState();
  return {
    st,
    sync: (items) => patchList(parent, st, dedupeKeys(items), { create, update }),
    clear: () => clearList(parent, st),
  };
}
const lists = {
  status: listOf($('#run-status')), steps: listOf($('#steps')), roles: listOf($('#roles')), facts: listOf($('#facts')),
  grid: listOf($('#matrix-grid'), { create: makeNode, update: updateNode }), fallback: listOf($('#matrix-fallback')),
  lanes: listOf($('#lanes'), { create: createLane, update: updateLane }),
  rows: listOf($('#tl-rows'), { create: createRow, update: updateRow }), edges: listOf($('#tl-edges'), { create: createEdge }),
  counters: listOf($('#counters')), verdicts: listOf($('#verdicts'), { create: makeNode, update: updateNode }), tests: listOf($('#tests'), { create: makeNode, update: updateNode }),
  axis: listOf($('#tl-axis')), report: listOf($('#report'), { create: makeNode, update: updateNode }),
  log: listOf($('#log')),
  // the picker: the run on show in the button, the rows of the dropdown
  pickCur: listOf($('#rp-cur')), pickRows: listOf($('#rp-list')),
  // the options of the project and status controls: keyed, so a value that stays keeps its option
  pickProject: listOf($('#rp-projects')), pickStatus: listOf($('#rp-statuses')),
  // the drawer: sections and groups of sections (the facts, the changes, the activity), each a keyed list inside
  drawer: listOf($('#drawer-body'), { create: (item) => createNode(document, item), update: updateNode }),
};

// ---------- provenance-aware rendering ----------
function fact(f, fmt = (x) => x) {
  if (f == null) return `<span class="fact prov-unknown" title="not in model">?</span>`;
  if (typeof f !== 'object' || !('prov' in f)) return esc(fmt(f));
  const tip = f.prov === 'unknown' ? `unknown: ${f.reason || 'not provided by the source'}`
    : f.prov === 'inferred' ? `inferred: ${f.method || ''}` : `${f.prov}${f.from ? ': ' + f.from : ''}`;
  if (f.prov === 'unknown' || f.value == null) {
    return `<span class="fact prov-unknown" title="${esc(tip)}">?</span>${f.reason ? ` <small>${esc(f.reason)}</small>` : ''}`;
  }
  return `<span class="fact prov-${f.prov}" title="${esc(tip)}">${esc(fmt(f.value))}</span>`;
}
// the same as fact(), but an unknown value is only a "?" with its reason as the tooltip (for narrow table columns)
function factShort(f, fmt) {
  if (f == null || f.prov === 'unknown' || (typeof f === 'object' && 'prov' in f && f.value == null)) {
    return `<span class="fact prov-unknown" title="${esc(`unknown: ${f?.reason || 'not provided by the source'}`)}">?</span>`;
  }
  return fact(f, fmt);
}
const fmtTime = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleTimeString() : '');
const fmtDur = (ms) => { if (ms == null) return ''; const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const fmtNum = (n) => (n == null ? '' : Number(n).toLocaleString());
// the class of the state tag: a finished agent passes, a failed one fails, any other state is its own class
const stateClass = (s) => (s === 'done' ? 'pass' : s === 'failed' ? 'fail' : s);

// ---------- roles / colours from data ----------
let roleCache = { run: null, order: [] };
function roleOrder(run) {
  if (roleCache.run === run) return roleCache.order;
  const seen = [];
  for (const id of run.order || Object.keys(run.agents || {})) {
    const r = val(run.agents[id]?.role);
    if (r && !seen.includes(r)) seen.push(r);
  }
  roleCache = { run, order: seen };
  return seen;
}
// A role takes the colour slot (--c1 .. --c9) of its place in the order of first appearance; a run with no role is --other.
function roleColor(run, role) {
  return `var(${slotVar(roleOrder(run), role)})`;
}
// "running" for an interrupted agent would be a lie: it says what the agent is shown as
const stateText = (a) => visualState(a);
const stateTip = (a) => (isInterrupted(a) ? interruptNote(a) : agentState(a)); // the model's note, or "interrupted (no note)"

// ---------- data ----------
async function loadRuns() {
  state.runsTouched = new Set(); // the runs the stream tells of while the list is read: their data is newer than the answer
  const list = (await getJson('/api/runs')) || [];
  state.runs = mergeRunList(list, state.runs, state.runsTouched);
  state.runsLoaded = true;
  // a project or status of the hash that the list does not have is reset to "all" (and the hash rewritten): checked now that the list is here
  const checked = sanitizePickerFilter(state.filter, pickerFilterOptions(state.runs));
  if (checked.changed) { state.filter = checked.filter; writeHash(); }
  renderRunPicker();
  // the first page opens a run that is loaded (a running one, else the first); a run that is only listed opens on a click, never unasked
  const isLoadedItem = (r) => r.loaded !== false;
  if (!state.runId && state.runs.length) {
    const open = state.runs.find((r) => isLoadedItem(r) && val(r.status) === 'running') || state.runs.find(isLoadedItem);
    if (open) selectRun(open.id);
    else renderEmpty(NONE_LOADED);
  } else if (!state.runs.length && !state.runId) renderEmpty();
}
async function selectRun(id, { keepDrawer = false } = {}) {
  // another run, or the real view asked for again, ends a replay that is on show; a replay that has not begun yet (its stream is still
  // being opened, or it was refused) lets the same run be read again
  if (state.replay && (state.replay.runId !== id || state.replay.shown)) dropReplay();
  const token = ++state.sel;
  state.runId = id; state.run = null; state.drawn = new Set(); state.gotSnapshot = false;
  state.backlogError = null;
  // (a replay that is still there is of this same run: another run dropped it above. The last real Run it holds stays until a newer one comes,
  // so a replay that shows before the answer of this read is here still has its Replay again and its speeds at the end or at a cut)
  stopClock(); // the clock belongs to the run on show: the first snapshot of this run starts it again if it counts
  if (!keepDrawer) { state.expanded = new Set(); state.testsExpanded = false; state.errOpen = false; closeDrawer(); clearSearchHit(); } // a reconnect keeps what the user opened
  syncHover();
  state.log.reset(id); state.backlogSeq = 0;
  renderLogNotice();
  if (!keepDrawer) renderReplayControls(); // a reconnect reads the same run again: its control stays where it is meanwhile
  // another run: its lines are not these. The same run read again (a reconnect) keeps the lines on the page until the backlog is
  // here, and the backlog is then drawn against them, so only what differs is written.
  if (!keepDrawer) renderLogAll();
  // a run that is only listed is loaded by the server on this first request (it can take a while): the picker row and the note say so, and the
  // backlog is read after it, so that it holds the events of the whole run and not only those the list was made from
  const listed = state.runs.find((r) => r.id === id);
  const toLoad = listed !== undefined && listed.loaded === false;
  state.picker.loadError = null;
  if (toLoad) state.picker.loading.add(id);
  renderRunPicker();
  let run;
  let events;
  if (toLoad) {
    const got = await fetchJson(`/api/runs/${enc(id)}`);
    state.picker.loading.delete(id);
    if (token !== state.sel) { renderRunPicker(); return; } // another run was selected meanwhile
    run = got.data;
    if (run) state.runs = mergeRun(state.runs, { id, loaded: true });
    else {
      state.picker.loadError = loadFailedText(id, got.reason ?? got.error);
      renderEmpty(esc(state.picker.loadError));
    }
    renderRunPicker();
    events = run ? await fetchJson(`/api/runs/${enc(id)}/events?since=0`) : { data: null, error: null }; // a run that did not load has no backlog to be missing
    if (token !== state.sel) return;
  } else {
    [run, events] = await Promise.all([
      getJson(`/api/runs/${enc(id)}`),
      fetchJson(`/api/runs/${enc(id)}/events?since=0`),
    ]);
  }
  if (token !== state.sel) return; // another run was selected meanwhile
  // a snapshot that arrived by SSE while the request was out is newer than the answer
  if (run && !state.gotSnapshot) applyRun(run);
  // events that failed to load are not made up: the log says so, and the next live event (or choosing the run again) reads the backlog again
  state.backlogError = events.error;
  renderLogNotice();
  loadEvents(events.data || []);
}
function applyRun(run) {
  state.run = run;
  // a replay that has not shown yet (refused, or still being opened) leaves the real view on screen: the Run it offers a new replay
  // from is the one on show now, not the one that was there at the click
  if (state.replay && !state.replay.shown) state.replay.real = run;
  render();
}
// A backlog (the first one, or the events fetched to close a gap): added to the log, never highlighted. A backlog is drawn in the order
// of the displayed time: up to the highest seq it brought, the log is sorted by that time (the new events are merged among the lines
// there, by their time), and the lines that came live after it stay in arrival order. So the live lines shown between two backlogs
// are sorted with the second one too; only the lines whose place changed are moved. A gap that is still open is read again.
function loadEvents(events) {
  const wasEmpty = state.log.lines.length === 0;
  const r = state.log.load(events);
  const read = new Set((Array.isArray(events) ? events : []).map((e) => e?.seq));
  const readMax = r.added.reduce((m, x) => (!isMarker(x) && read.has(x.seq) && x.seq > m ? x.seq : m), 0);
  if (readMax > state.backlogSeq) {
    state.backlogSeq = readMax;
    renderLogAll({ keepPosition: !wasEmpty }); // the first backlog follows the end of the log; a later one stays where the user is
  } else if (r.added.length) appendLog(r.added);
  if (r.gap) refetchEvents();
}
async function refetchEvents() {
  if (state.refetching || !state.runId) return;
  state.refetching = true;
  const token = state.sel;
  const { data, error } = await fetchJson(`/api/runs/${enc(state.runId)}/events?since=${state.log.last}`);
  state.refetching = false;
  if (token !== state.sel) return;
  state.backlogError = error;
  renderLogNotice();
  if (data) loadEvents(data); // a failed read leaves the gap open: the next live event tries again
}
function onLiveEvent(ev) {
  if (ev.runId !== state.runId || replayOnShow()) return; // a replay on show has its own events; the run's own are not drawn over it
  const r = state.log.push(ev);
  if (r.status === 'added') {
    appendLog(r.added);
    flashAgent(ev.agentId);
    if (ev.agentId && ev.agentId === state.drawerAgent) scheduleTranscript();
    if (ev.agentId && ev.agentId === state.hover) syncHover(true);
  }
  // a gap, or a backlog that could not be read: read it again now that a live event shows the server is there
  if (r.status === 'gap' || state.backlogError) refetchEvents();
}
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('hello', (e) => {
    const h = JSON.parse(e.data);
    state.mode = h.mode; renderMode(h);
    setShown($('#stream-note'), false);
    // A reconnect: the run snapshots follow at once. The events of the break are not known to have been all seen (or the
    // server was started again and counts from 1), so the selected run is read again from the start.
    if (state.hellos++ > 0 && state.runId && !replayOnShow()) selectRun(state.runId, { keepDrawer: true });
  });
  es.addEventListener('run', (e) => {
    const run = JSON.parse(e.data);
    setShown($('#stream-note'), false);
    // a run that appears, or whose status changes, is in the picker without a reload; the run on show never changes by itself
    state.runs = mergeRun(state.runs, summaryOfRun(run));
    state.runsTouched.add(run.id);
    renderRunPicker();
    if (!state.runId && state.runsLoaded) selectRun(run.id);
    else if (run.id === state.runId && !replayOnShow()) { state.gotSnapshot = true; applyRun(run); }
  });
  es.addEventListener('event', (e) => onLiveEvent(JSON.parse(e.data)));
  es.onerror = () => setShown($('#stream-note'), true);
}

// ---------- render ----------
// The mode of the server: REAL, DEMO or REPLAY in the badge, a banner for DEMO (synthetic data) and one for REPLAY (a saved real run
// played back), the document title. A mode the page does not know is "?" with no banner, never REAL.
function renderMode(h) {
  const m = modeInfo(h.mode);
  const badge = $('#mode');
  setText(badge, m.text);
  const cls = `badge ${m.cls}`;
  if (badge.className !== cls) badge.className = cls;
  setShown($('#demo-banner'), m.banner === 'demo');
  setShown($('#replay-banner'), m.banner === 'replay' || replayOnShow());
  if (document.title !== m.title) document.title = m.title;
}

// ---------- the run picker: a dropdown in the page's own style, in place of the native select ----------
// Rows come from the run list (state.runs: the server's list, kept up to date by the run snapshots of the stream) and nothing else.
// The keyboard is on a row by its run id, so a row that comes or goes, a snapshot or typing does not move it; the search text, the
// scroll of the list and the focus are not touched by a patch of the rows. The one outside-click listener is the page's click handler.
const fmtStart = (ms) => {
  const d = new Date(ms);
  const t = new Date();
  const today = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  return today ? d.toLocaleTimeString() : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`; // the date too for a run of another day
};
const unknownMark = (why) => `<span class="fact prov-unknown" title="${esc(`unknown: ${why}`)}">?</span>`;
const markedHtml = (segs) => segs.map((x) => (x.hit ? `<mark>${esc(x.text)}</mark>` : esc(x.text))).join('');
function optId(runId) {
  const ids = state.picker.optIds;
  if (!ids.has(runId)) ids.set(runId, `rp-opt-${ids.size + 1}`);
  return ids.get(runId);
}
function pickerRowSpec(m) {
  const p = m.row;
  const o = runOption(p.item);
  const name = p.name !== null ? markedHtml(m.nameSegs) : `${markedHtml(m.idSegs)} <small class="muted">(no name)</small>`;
  const status = p.status !== null ? `<span class="tag ${runStatusClass(p.status)}">${esc(p.status)}</span>` : unknownMark(p.statusReason);
  const loading = !p.loaded && state.picker.loading.has(p.id);
  const meta = [
    p.name !== null ? `<span class="rp-id">${markedHtml(m.idSegs)}</span>` : null,
    p.startedAt !== null ? esc(fmtStart(p.startedAt)) : `${unknownMark(p.startedReason)} start`,
    p.agents !== null ? `${p.agents} agent${p.agents === 1 ? '' : 's'}` : `${unknownMark('the run list has no agent count for this run')} agents`,
    p.source !== null ? esc(p.source) : `${unknownMark('the run list has no source for this run')} source`,
    p.project !== null ? `<span class="rp-proj">${esc(p.project)}</span>` : null,
    p.loaded ? null : `<span class="rp-state${loading ? ' loading' : ''}">${esc(loading ? LOADING_TEXT : NOT_LOADED_TEXT)}</span>`,
  ].filter(Boolean).join('<span class="sep"> · </span>');
  return specOf(keyOf('run', p.id), {
    class: `rp-row${p.id === state.runId ? ' sel' : ''}${p.id === state.picker.active ? ' active' : ''}${p.loaded ? '' : ' unloaded'}`,
    role: 'option', id: optId(p.id), 'aria-selected': String(p.id === state.runId), 'data-run': p.id,
  }, `<div class="rp-top"><span class="rp-name" title="${esc(o.title)}">${name}</span>${status}</div><div class="rp-meta">${meta}</div>`);
}
function renderPickerTrigger() {
  const cur = state.runs.find((r) => r.id === state.runId);
  const o = state.runId === null ? null : runOption(cur ?? { id: state.runId });
  lists.pickCur.sync([o
    ? specOf(keyOf('cur'), { class: 'rp-cur-in', title: o.title }, esc(o.text), 'span')
    : specOf(keyOf('none'), { class: 'muted' }, state.runsLoaded ? 'no runs yet' : 'loading runs…', 'span')]);
}
// The controls of the filters show the state: the options offered by the project and status controls are the list's own values (patched by
// key, so they are written only when that set of values changes). A control takes a value only when the filter it shows has changed
// since it was last written: a snapshot never overwrites what the user is typing in it.
function renderPickerControls() {
  const f = state.filter;
  const ctl = state.picker.ctl;
  const opts = pickerFilterOptions(state.runs);
  const optionSpecs = (values) => values.map((v) => specOf(keyOf('opt', v), { value: v }, '', 'option'));
  lists.pickProject.sync(optionSpecs(opts.projects));
  lists.pickStatus.sync(optionSpecs(opts.statuses));
  const put = (name, sel, prop, shown, shownNow) => {
    if (ctl[name] === shown) return;
    ctl[name] = shown;
    const el = $(sel);
    if (el[prop] !== shownNow) el[prop] = shownNow;
  };
  put('project', '#rp-project', 'value', f.project, f.project ?? '');
  put('status', '#rp-status', 'value', f.status, f.status ?? '');
  put('all', '#rp-all', 'checked', f.range === 'all', f.range === 'all');
  put('from', '#rp-from', 'value', f.from, f.from ?? '');
  put('to', '#rp-to', 'value', f.to, f.to ?? '');
}
function renderPickerList() {
  const pk = state.picker;
  renderPickerControls();
  const now = Date.now();
  const items = state.runs.filter((r) => runPassesFilter(r, state.filter, now));
  const rows = items.map((r) => ({ ...pickerRow(r), item: r }));
  const shown = filterRunRows(rows, state.filter.q);
  pk.shown = shown.map((m) => m.row.id);
  if (!pk.shown.includes(pk.active)) pk.active = pk.shown[0] ?? null; // the row the keyboard was on is gone (filtered out or removed)
  const none = rows.length ? 'no run matches' : state.runs.length ? `no run matches the filters${state.filter.range === 'all' ? '' : ' (the last 24 h; "all" shows older runs)'}` : 'no runs yet';
  lists.pickRows.sync(shown.length ? shown.map(pickerRowSpec)
    : [specOf(keyOf('none'), { class: 'rp-empty muted', role: 'status' }, none)]);
  setText($('#rp-count'), `${shown.length} of ${state.runs.length} runs`);
  const input = $('#rp-search');
  if (input.value !== state.filter.q) input.value = state.filter.q; // the text filter is hash state: the field shows it (it already holds what was typed)
  const at = pk.active === null ? null : optId(pk.active);
  if (at === null) { if (input.getAttribute('aria-activedescendant') !== null) input.removeAttribute('aria-activedescendant'); }
  else if (input.getAttribute('aria-activedescendant') !== at) input.setAttribute('aria-activedescendant', at);
}
// the button, always; the rows only while the dropdown is open (they are patched again when it opens)
function renderRunPicker() {
  renderPickerTrigger();
  renderLoadNote();
  if (state.picker.open) renderPickerList();
}
// beside the button: a run being loaded ("loading..." and its id) or the reason a load failed; nothing otherwise
function renderLoadNote() {
  const pk = state.picker;
  const text = pk.loadError ?? (pk.loading.size > 0 ? `${LOADING_TEXT} ${[...pk.loading][0]}` : '');
  const el = $('#rp-note');
  setText(el, text);
  setShown(el, text !== '');
  if (el.classList.contains('err') !== (pk.loadError !== null)) el.classList.toggle('err', pk.loadError !== null);
}
// A change of a filter: the hash is rewritten (replaceState: no history entry, no hashchange) and the rows are patched.
function setFilter(patch) {
  state.filter = { ...state.filter, ...patch };
  writeHash();
  renderRunPicker();
}
// The hash is the filters' only home. replaceState throws in a sandboxed frame: then the state stays in the page.
function writeHash() {
  try {
    const hash = formatPickerHash(state.filter);
    if (location.hash === hash) return;
    history.replaceState(null, '', hash === '' ? `${location.pathname}${location.search}` : hash);
  } catch { /* no history here */ }
}
// The hash was changed by hand (or by the back button): the filters are read again, checked against the list like at the start.
function onHashChange() {
  state.filter = parsePickerHash(readHash());
  if (state.runsLoaded) {
    const checked = sanitizePickerFilter(state.filter, pickerFilterOptions(state.runs));
    if (checked.changed) { state.filter = checked.filter; writeHash(); }
  }
  renderRunPicker();
}
function setPickerOpen(open, { focus = true } = {}) {
  const pk = state.picker;
  if (pk.open === open) return;
  pk.open = open;
  setShown($('#rp-panel'), open);
  $('#rp-trigger').setAttribute('aria-expanded', String(open));
  if (open) {
    pk.active = state.runId;
    renderPickerList();
    showActiveRow();
    $('#rp-search').focus?.({ preventScroll: true });
  } else if (focus) $('#rp-trigger').focus?.({ preventScroll: true });
}
// The list scrolls by itself to bring the row the keyboard is on into view: scrollIntoView would scroll every box above the list as
// well (the page too), and the page must not move.
function showActiveRow() {
  const row = lists.pickRows.st.els.get(keyOf('run', state.picker.active));
  const list = $('#rp-list');
  if (!row) return;
  const to = scrollToShow({ top: row.offsetTop, height: row.offsetHeight, scrollTop: list.scrollTop, viewHeight: list.clientHeight });
  if (to !== list.scrollTop) list.scrollTop = to;
}
function movePickerActive(step) {
  const pk = state.picker;
  if (!pk.shown.length) return;
  const i = pk.shown.indexOf(pk.active);
  pk.active = pk.shown[Math.min(Math.max(i < 0 ? (step > 0 ? 0 : pk.shown.length - 1) : i + step, 0), pk.shown.length - 1)];
  renderPickerList();
  showActiveRow();
}
function chooseRun(id) {
  setPickerOpen(false);
  if (id !== state.runId || state.picker.loadError !== null) selectRun(id); // the run whose load failed, chosen again, is loaded again
  else if (state.backlogError) refetchEvents(); // the run on show chosen again: a backlog that did not load is read again
}
// the search field: arrows move the row the keyboard is on, Enter chooses it (Escape is the page's: it closes the picker first)
function onPickerKey(e) {
  if (e.isComposing) return; // an input method is still composing: Enter is its own
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault?.();
    movePickerActive(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault?.();
    if (state.picker.active !== null) chooseRun(state.picker.active);
  }
}
// the button: an arrow opens the dropdown (Enter and Space click it, as for any button)
function onTriggerKey(e) {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !state.picker.open) {
    e.preventDefault?.();
    setPickerOpen(true);
  }
}

const NONE_LOADED = 'No run is loaded yet.<br>Open the run picker: every run is listed there, and an older one loads when you click it.';
const NO_RUNS = 'No workflow runs found in the watched directory yet.<br>Start a Dynamic Workflow in Claude Code; it appears here when its journal is written.';
function renderEmpty(message = NO_RUNS) {
  setShown($('#report-card'), false);
  for (const l of [lists.grid, lists.fallback]) l.clear();
  setShown($('#matrix-grid'), false); setShown($('#matrix-note'), false); setShown($('#matrix-fallback'), false);
  const e = $('#matrix-empty');
  setHtml(e, message);
  setShown(e, true);
}
function render() {
  const run = state.run;
  renderReplayControls();
  if (!run) return renderEmpty(replayOnShow() ? REPLAY_WAITING : undefined);
  renderStatus(run); syncClock(); renderSteps(run); renderRoles(run); renderFacts(run);
  renderLegend(run); renderReport(run); renderRight(run); renderTests(run); renderLogMeta(run);
  retimeLog(); // the lines drawn from an older snapshot are timed again from this one
  renderView();
  if (state.drawerAgent) renderDrawer(); else if (state.drawerResult) renderResultDrawer();
  syncHover(true); // the panel under a still pointer shows the new snapshot
}
const statSpec = (name, html) => specOf(keyOf('stat', name), { class: 'stat' }, html, 'span');
function renderStatus(run) {
  const t = run.totals || {};
  lists.status.sync([
    statSpec('status', `status ${fact(run.status)}`),
    statSpec('agents', `agents <b>${esc(t.agents ?? agentsOf(run).length)}</b>`),
    statSpec('running', `running <b>${esc(t.running ?? '')}</b>`),
    t.interrupted ? statSpec('interrupted', `interrupted <b>${esc(t.interrupted)}</b>`) : null,
    statSpec('done', `done <b>${esc(t.done ?? '')}</b>`),
    t.failed ? statSpec('failed', `failed <b>${esc(t.failed)}</b>`) : null,
    // the tooltip names the method the Run gives for the start; the clock changes only the text of the value
    statSpec('elapsed', `elapsed ${fact(elapsedFact(run, Date.now()), fmtDur)}`),
    statSpec('tokens', `tokens ${fact(t.tokens, fmtNum)}`),
  ].filter(Boolean));
}

// ---------- the elapsed clock: the one interval of the page ----------
// A running run counts up between events. One 1 s ticker sets the text of the elapsed value, nothing else. It runs only while
// the run on show counts (clockTick says so); a final run, a run with its own duration and another selected run stop it.
function stopClock() {
  if (state.clock !== null) clearInterval(state.clock);
  state.clock = null;
}
function startClock() {
  stopClock(); // never two handles, however often a run is selected again
  state.clock = setInterval(tick, 1000);
}
function syncClock() {
  if (clockTick(state.run, Date.now()) === null) stopClock();
  else if (state.clock === null) startClock();
}
function tick() {
  const ms = clockTick(state.run, Date.now());
  if (ms === null) return stopClock();
  // the value of the elapsed stat, only while it shows a computed (inferred) time: the text of that one element is all a tick writes
  const el = lists.status.st.els.get(keyOf('stat', 'elapsed'))?.querySelector('.fact.prov-inferred');
  if (el) setText(el, fmtDur(ms));
}
function currentPhase(run) {
  const running = agentsOf(run).filter(isBusy);
  return running.length ? val(running.at(-1).phase) : null;
}
function renderSteps(run) {
  const declared = (run.declaredPhases || []).map((p) => p.title);
  const seen = (run.phases || []).map((p) => p.title);
  const titles = [...declared, ...seen.filter((t) => !declared.includes(t))];
  const cur = currentPhase(run);
  const byTitle = Object.fromEntries((run.phases || []).map((p) => [p.title, p]));
  lists.steps.sync(titles.length ? titles.map((t, i) => {
    const p = byTitle[t];
    const ps = p ? val(p.state) : null;
    const cls = t === cur ? 'active' : ps === 'done' ? 'done' : ps === 'interrupted' ? 'interrupted' : '';
    const n = p ? p.agentIds.length : 0;
    const src = declared.includes(t) ? 'declared in script meta' : 'seen in agent records';
    return specOf(keyOf('step', t), { class: `step ${cls}`, title: src }, `<span class="n">${i + 1}</span>${esc(t)} <small>${n}</small>`, 'span');
  }) : [specOf(keyOf('no-phases'), { class: 'muted' }, `phases: ${fact({ value: null, prov: 'unknown', reason: 'no phase names in run data yet' })}`, 'span')]);
}
function renderRoles(run) {
  const roles = roleOrder(run);
  const ags = agentsOf(run);
  lists.roles.sync(roles.length ? roles.map((r) => {
    const mine = ags.filter((a) => val(a.role) === r);
    const busy = mine.filter(isBusy).length;
    const stopped = mine.filter(isInterrupted).length;
    return specOf(keyOf('role', r), { class: 'role' }, `<span class="dot" style="background:${roleColor(run, r)}"></span><span class="rname">${esc(r)}</span> <small>${mine.length}</small><span class="busy ${busy ? 'on' : ''}">${busy ? busy + ' busy' : 'idle'}${stopped ? ` · ${stopped} interrupted` : ''}</span>`);
  }) : [specOf(keyOf('no-roles'), { class: 'muted' }, 'labels do not follow role:unit — showing phases', 'span')]);
}
function renderFacts(run) {
  const rows = [
    ['name', fact(run.name)], ['run id', esc(run.id)], ['source', esc(run.source)],
    ['started', fact(run.startedAt, fmtTime)], ['ended', fact(run.endedAt, fmtTime)],
    ['Claude Code', fact(run.ccVersion)], ['project', esc(run.project || '')],
    ['tool calls', fact(run.totals?.toolCalls, fmtNum)],
  ];
  const runUnk = (run.unknowns || []).filter((u) => !String(u.field).startsWith('agents.'));
  const agentUnk = (run.unknowns || []).length - runUnk.length;
  const unk = runUnk.map((u) => `<div><span class="fact prov-unknown">?</span> ${esc(u.field)} <small>${esc(u.reason)}</small></div>`).join('') +
    (agentUnk ? `<div><span class="fact prov-unknown">?</span> ${agentUnk} agent fields <small>open an agent to see which and why</small></div>` : '');
  const warn = (run.warnings || []).slice(-5).map((w) => `<div class="muted">⚠ ${esc(w)}</div>`).join('');
  if (unk) rows.push(['unknown', unk]);
  if (warn) rows.push(['warnings', warn]);
  lists.facts.sync(rows.flatMap(([k, v]) => [specOf(keyOf('dt', k), {}, esc(k), 'dt'), specOf(keyOf('dd', k), {}, v, 'dd')]));
}
function renderLegend(run) {
  const r = run.registeredEdges || { value: [], prov: 'unknown', reason: 'no source registers dependencies' };
  setHtml($('#registered-edges-note'), `registered dependencies: ${r.value && r.value.length ? r.value.length : fact(r)}`);
}

// ---------- usage and cost ----------
// The usage of a run and of an agent (the four token counters of the Run) is shown with its provenance. The cost is not in the Run: the page
// computes it from the usage and the price list of GET /api/prices (lib.js runCostView, agentCostView), as an inferred Fact whose method names
// the OpenRouter ids it used. The list is asked for once per page, and only when a cost is first shown (the report card of an ended run that
// has usage, an open drawer of an agent that has usage): the page load, the run list, a run without usage and a Run of source "demo" never ask
// (a demo's tokens are made up: it shows the counters and no cost, and the price list stays idle). A failure is kept as it is (no timer, no
// retry) and shown as "cost unknown: <reason>"; while the list is out the line says so. A cost that is a total says what it leaves out: the
// tokens of messages with no model are in the usage and not in the split by model, so the text counts them ("without N tokens ...").
function ensurePrices() {
  if (state.prices.phase !== 'idle') return;
  state.prices = { phase: 'loading', data: null, reason: null };
  fetchJson('/api/prices').then(({ data, error, reason }) => {
    const answer = data === null ? { ok: false, reason: reason ?? error } : pricesAnswer(data);
    state.prices = answer.ok ? { phase: 'ok', data, reason: null } : { phase: 'failed', data: null, reason: answer.reason };
    // only the cost lines change: the report card and the drawer that show one are brought up to date
    if (state.run && isFinalStatus(state.run.status)) renderReport(state.run);
    if (state.drawerAgent) renderDrawer();
  });
}
// the cost line of a run or an agent: the one Fact (value, provenance, method in the tooltip), or why there is none
function costHtml(view) {
  if (view.kind === 'loading') return '<span class="muted">loading OpenRouter prices…</span>';
  if (view.kind === 'unknown') return `<span class="fact prov-unknown" title="${esc(`unknown: ${view.reason}`)}">cost unknown: ${esc(view.reason)}</span>`;
  return fact(view.fact, () => view.text);
}
// the rows of the usage of one thing (the run's totals, an agent): the four counters as Facts of their own, or the usage Fact itself when it
// is unknown (it says why)
function usageRows(usageFact) {
  const parts = usageParts(usageFact);
  return parts ? parts.map((p) => [p.label, fact(p.fact, fmtNum)]) : [['usage', fact(usageFact)]];
}

// ---------- report card (a run that has ended) ----------
// Every cell of the report is a keyed element (a group of the key, the value and a note), so a snapshot rewrites only the cell whose
// numbers changed. The details of a long error are a keyed child of the status cell: its open state is the element's own (the spec
// says open only when the user opened it), and its scrolled text is kept.
function reportCell(name, key, value, sub = null, extraClass = '') {
  return groupOf(keyOf('r', name), { class: extraClass ? `cell-r ${extraClass}` : 'cell-r' }, [
    specOf(keyOf('k'), { class: 'k' }, esc(key)),
    specOf(keyOf('v'), { class: 'v' }, value),
    ...(sub ? [sub] : []),
  ]);
}
const noteSpec = (name, text) => specOf(keyOf('note', name), { class: 'muted' }, esc(text));
const subSpec = (name, html) => specOf(keyOf('sub', name), { class: 'sub' }, html);
function errorSub(err) {
  const p = splitError(err.value);
  if (!p.rest) return subSpec('error', fact(err));
  return groupOf(keyOf('sub', 'error'), { class: 'sub' }, [
    specOf(keyOf('first'), {}, fact({ ...err, value: p.first }), 'span'),
    groupOf(keyOf('more'), { class: 'err-more', open: state.errOpen }, [
      specOf(keyOf('summary'), {}, `${p.restLines} more line${p.restLines === 1 ? '' : 's'}`, 'summary'),
      specOf(keyOf('text'), {}, esc(p.rest), 'pre'),
    ], 'details'),
  ]);
}
function renderReport(run) {
  const card = $('#report-card');
  if (!isFinalStatus(run.status)) { setShown(card, false); return; }
  const c = reportCard(run);
  const unk = (reason) => fact({ value: null, prov: 'unknown', reason });
  const states = c.agents.states.map((s) => `<span class="tag ${esc(stateClass(s.state))}">${esc(s.state)} ${s.count}</span>`).join(' ');
  const n = (x) => (typeof x === 'number' ? `<b>${x}</b>` : unk('not in the summary'));
  const reports = `${c.tests.reports} agent report${c.tests.reports === 1 ? '' : 's'}`;
  let tests;
  if (c.tests.total) {
    // the run's total is the one tests item of the run result; it opens the run result like every item from there
    const t = c.tests.total;
    tests = [`${n(t.passed)} pass · ${n(t.failed)} fail · ${n(t.skipped)} skipped${t.todo !== undefined ? ` · ${n(t.todo)} todo` : ''}`,
      specOf(keyOf('sub', 'tests'), { class: 'sub', 'data-result': '', title: t.from ? `from ${t.from}` : null }, `run total, from the run result in the final file (inferred: ${esc(t.method || '')}); ${esc(reports)}`)];
  } else tests = [esc(reports), subSpec('tests', `no run-level total: ${unk(c.tests.reason)}`)];
  const verdicts = Object.entries(c.verdicts.byValue).map(([k, v]) => `${esc(k)}:${v}`).join(' ');
  const inRun = c.inRunResult;
  setShown(card, true);
  lists.report.sync([
    reportCell('status', 'status', fact(c.status), c.error ? errorSub(c.error) : null),
    reportCell('duration', 'duration', fact(c.durationMs, fmtDur)),
    reportCell('agents', 'agents', String(c.agents.total), subSpec('agents', states || 'none')),
    reportCell('tests', 'tests', tests[0], tests[1]),
    reportCell('findings', 'findings', String(c.findings), subSpec('findings', 'recognised in agent results (by field name or array shape)')),
    reportCell('verdicts', 'verdicts', String(c.verdicts.total), subSpec('verdicts', verdicts || 'none recognised')),
    ...usageCells(run),
    // what the run result holds is counted apart from the agents' (a line over the whole card, only when it holds something)
    ...(inRun ? [specOf(keyOf('note', 'in-run-result'), { class: 'sub', 'data-result': '', style: 'grid-column: 1 / -1' },
      `in the run result: ${inRun.findings} findings, ${inRun.verdicts} verdicts, ${inRun.tests} tests`)] : []),
  ]);
}
// the report's cells for the tokens and the cost of the run: the four counters of totals.usage (or the unknown Fact, with its reason), the
// cost line over the whole card, and the one sentence about what these numbers do not cover
function usageCells(run) {
  if (runNeedsPrices(run)) ensurePrices();
  const rows = usageRows(run.totals?.usage);
  // a demo Run has no cost cell at all: its tokens are made up
  const cost = showsCost(run) ? [
    reportCell('cost', 'cost', costHtml(runCostView(run, state.prices)), subSpec('cost', 'tokens of the run x OpenRouter prices per token, by model; computed in this page, not in the run record'), 'wide cost'),
  ] : [];
  return [
    ...rows.map(([label, html]) => reportCell(`usage-${label}`, label, html)),
    ...cost,
    specOf(keyOf('note', 'engines'), { class: 'sub wide' }, esc(ENGINES_NOTE)),
  ];
}
const agentLabel = (run, id) => val(run.agents?.[id]?.label) || id;

// ---------- views ----------
function renderView() {
  for (const v of ['matrix', 'phases', 'timeline']) setShown($(`#view-${v}`), v === state.view);
  document.querySelectorAll('.view-tabs button').forEach((b) => {
    const on = b.dataset.view === state.view;
    if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
  });
  if (!state.run) return;
  if (state.view === 'matrix') renderMatrix(state.run);
  if (state.view === 'phases') renderPhases(state.run);
  if (state.view === 'timeline') renderTimeline(state.run);
}
function cellIcon(role) { return esc((role || '?').slice(0, 1).toUpperCase()); }
// The cell of one agent (matrix and fallback rows): its state, the selection, the badges. No title: the hover panel says
// what a title would (state, interrupted note, last activity).
function cellSpec(key, a, color, name, n, tags, inner, extra = '') {
  return specOf(key, {
    class: `cell${extra} st-${visualState(a)}${a.id === state.drawerAgent ? ' sel' : ''}`,
    style: `--c:${color}`, 'data-agent': a.id, 'data-n': n, 'data-tags': tags.join(', '), 'aria-label': name,
  }, inner);
}
// The label of a matrix row. The toggle of the unit history is a keyed element of its own inside it (data-unit is a raw attribute, the
// text of the button is only its arrow): a toggle or a snapshot changes its attributes and its arrow, so the button keeps its place in
// the page and its keyboard focus; the name, the tags and the counts are keyed elements too and are written only when they change.
function rowLabelGroup(row, u, open) {
  return groupOf(keyOf('row', u), { class: `mrow-label st-${row.state}` }, [
    groupOf(keyOf('u'), { class: 'u' }, [
      specOf(keyOf('toggle'), {
        type: 'button', class: 'hist-toggle', 'data-unit': u, 'aria-expanded': String(open), title: `${open ? 'hide' : 'show'} the agents of this unit by round`,
      }, open ? '▾' : '▸', 'button'),
      specOf(keyOf('name'), { class: 'u-name' }, esc(u), 'span'),
      ...row.tags.map((g) => specOf(keyOf('tag', g), { class: 'tag-i', title: 'inferred from the label: #tag' }, `#${esc(g)}`, 'span')),
    ]),
    specOf(keyOf('count'), {}, `${row.maxRound != null ? `round ${row.maxRound} <span class="prov-inferred fact" title="inferred: label-pattern">label</span>` : ''} · ${row.agents.length} agents`, 'small'),
  ]);
}
function matrixSpecs(run, m, counts) {
  const busyCounts = {};
  for (const row of m.rows) for (const a of row.agents) if (isBusy(a)) busyCounts[val(a.role)] = (busyCounts[val(a.role)] || 0) + 1;
  const busyRole = Object.entries(busyCounts).sort((x, y) => y[1] - x[1])[0]?.[0];
  const specs = [specOf(keyOf('head-unit'), { class: 'mhead' }, 'unit')];
  for (const r of m.roles) {
    specs.push(specOf(keyOf('head-role', r), { class: `mhead${r === busyRole ? ' colspot' : ''}`, style: r === busyRole ? `color:${roleColor(run, r)}` : null }, esc(r)));
  }
  for (const row of m.rows) {
    const u = row.unit;
    const open = state.expanded.has(u);
    specs.push(rowLabelGroup(row, u, open));
    for (const [i, c] of row.cells.entries()) {
      const key = keyOf('cell', u, m.roles[i]);
      if (!c) { specs.push(specOf(key, { class: 'cell empty' }, '')); continue; }
      const { role: r, shown: a, count: n, tags: cellTags, members } = c;
      const fc = counts.get(a.id);
      const g = tagOf(a);
      const name = `${val(a.label) ?? a.id}${g ? ` (#${g})` : ''} — ${stateTip(a)}${n > 1 ? `; ${n} agents in this cell${cellTags.length ? `, tags: ${cellTags.join(', ')}` : ''}` : ''}`;
      // several agents in one cell: each one's tag and state, in start order
      const each = n > 1 ? `<span class="cell-agents">${members.map((x) => `<span class="ca">${x.tag ? `#${esc(x.tag)}` : '<small>no tag</small>'} <span class="tag ${esc(stateClass(x.state))}">${esc(x.state)}</span></span>`).join('')}</span>` : '';
      specs.push(cellSpec(key, a, roleColor(run, r), name, n, cellTags,
        `<span class="ico" style="color:${roleColor(run, r)}">${cellIcon(r)}</span>${isInterrupted(a) ? '<span class="badge-i">⊘</span>' : ''}${n > 1 ? `<span class="badge-r">×${n}</span>` : ''}${each}${fc ? `<span class="badge-f">${fc}</span>` : ''}`));
    }
    if (open) specs.push(historyGroup(run, u, row.agents));
  }
  return specs;
}
// Rows for the agents outside the role x unit matrix: a phase, then its agents, each captioned with its label as the Run has it.
function fallbackSpecs(run, m, counts) {
  const specs = [];
  for (const row of m.fallback) {
    const head = row.phase === null ? `<span class="fact prov-unknown" title="${esc(`unknown: ${row.reason}`)}">${esc(row.title)}</span>` : esc(row.title);
    specs.push(specOf(keyOf('fb-head', row.key), { class: 'fb-head' }, `${head} <small>${row.cells.length}</small>`));
    for (const c of row.cells) {
      const a = c.agent;
      const cap = c.caption;
      const fc = counts.get(a.id);
      const role = val(a.role);
      specs.push(cellSpec(keyOf('fb-cell', a.id), a, role ? roleColor(run, role) : 'var(--other)', `${cap.text} — ${stateTip(a)}`, 1, [],
        `<span class="cap fact prov-${esc(cap.prov)}" title="${esc(cap.tip)}">${esc(cap.text)}</span><span class="tag ${esc(stateClass(c.state))}">${esc(c.state)}</span>${isInterrupted(a) ? '<span class="badge-i">⊘</span>' : ''}${fc ? `<span class="badge-f">${fc}</span>` : ''}`, ' fb-cell'));
    }
  }
  return specs;
}
function renderMatrix(run) {
  const m = matrixModel(run);
  const counts = findingCounts(run);
  const grid = $('#matrix-grid'), note = $('#matrix-note'), fb = $('#matrix-fallback'), empty = $('#matrix-empty');
  setHtml(empty, 'No agents in this run yet.');
  setShown(empty, m.mode === 'empty');
  setShown(grid, m.roles.length > 0);
  setShown(note, !!m.note);
  setShown(fb, m.fallback.length > 0);
  if (m.note) setText(note, m.note);
  setStyleProp(grid, 'grid-template-columns', `minmax(120px, 1.4fr) repeat(${m.roles.length}, minmax(44px, 1fr))`);
  lists.grid.sync(m.roles.length ? matrixSpecs(run, m, counts) : []);
  lists.fallback.sync(fallbackSpecs(run, m, counts));
}
// The agents of one unit, in start order, grouped by round (Agent.round when known, else #tag); an unknown round says so. The history
// is a group of the groups of the rounds, each with its heading and one keyed row per agent: a new agent adds a row, a change of
// state rewrites the cells of that row only.
function historyGroup(run, u, mine) {
  return groupOf(keyOf('hist', u), { class: 'hist' }, roundHistory(mine).map((g) => {
    const h = groupHeading(g);
    return groupOf(keyOf('round', g.key), { class: 'hist-group' }, [
      specOf(keyOf('h'), {}, `${esc(g.title)}${h.note ? ` <small>${esc(h.note)}</small>` : ''} <small>${g.agents.length} agent${g.agents.length === 1 ? '' : 's'}</small>`, 'h5'),
      ...g.agents.map((x) => specOf(keyOf('agent', x.id), { class: `hist-row st-${x.state}`, style: `--c:${roleColor(run, x.role)}`, 'data-agent': x.id },
        `<span>${factShort(x.agent.startedAt, fmtTime)}</span><span>${x.role ? esc(x.role) : factShort({ value: null, prov: 'unknown', reason: 'no role in the label' })}</span>
      <span class="lbl" title="${esc(x.note || x.label)}">${esc(x.label)} ${x.tag ? `<span class="tag-i">#${esc(x.tag)}</span>` : '<small>no tag</small>'}</span>
      <span><span class="tag ${esc(stateClass(x.state))}">${esc(x.state)}</span></span><span>${factShort(x.agent.durationMs, fmtDur)}</span>`)),
    ]);
  }));
}

// ---------- phases view: a lane per phase (a keyed list), its agent cards a keyed list inside it ----------
const laneParts = new WeakMap();
function createLane(item) {
  const el = createSpecEl(document, { tag: 'div', attrs: item.attrs, html: '' });
  const head = document.createElement('h4');
  setHtml(head, item.head);
  const body = document.createElement('div');
  body.className = 'lane-cards';
  el.append(head, body);
  const cards = listOf(body);
  laneParts.set(el, { head, cards });
  cards.sync(item.cards);
  return el;
}
function updateLane(el, prev, item) {
  const p = laneParts.get(el);
  updateSpecEl(el, { attrs: prev.attrs, html: '' }, { attrs: item.attrs, html: '' });
  setHtml(p.head, item.head); // written only when it changed
  p.cards.sync(item.cards);
}
function renderPhases(run) {
  const titles = [...(run.declaredPhases || []).map((p) => p.title)];
  for (const p of run.phases || []) if (!titles.includes(p.title)) titles.push(p.title);
  const cur = currentPhase(run);
  const ags = agentsOf(run);
  const noPhase = ags.filter((a) => !val(a.phase));
  const groups = titles.map((t) => ({ t, list: ags.filter((a) => val(a.phase) === t) }));
  if (noPhase.length) groups.push({ t: null, list: noPhase });
  lists.lanes.sync(groups.map(({ t, list }) => ({
    key: t === null ? keyOf('lane-unknown') : keyOf('lane', t),
    attrs: { class: `lane${t && t === cur ? ' active' : ''}` },
    head: `${t ? esc(t) : fact({ value: null, prov: 'unknown', reason: 'phase not recorded' })} <small>${list.length}</small>`,
    cards: list.map((a) => specOf(keyOf('acard', a.id), {
      class: `acard st-${visualState(a)}${a.id === state.drawerAgent ? ' sel' : ''}`, style: `--c:${roleColor(run, val(a.role))}`, 'data-agent': a.id, title: stateTip(a),
    }, `<div class="lbl">${fact(a.label)}</div><div class="meta">${esc(stateText(a))} · ${fact(a.model)} · ${fact(a.durationMs, fmtDur)}</div>`)),
  })));
}

// ---------- timeline: a row per agent (label and bar), the data-flow edges over them ----------
const rowParts = new WeakMap();
function createRow(item) {
  const el = createSpecEl(document, { tag: 'div', attrs: item.attrs, html: '' });
  const lbl = createSpecEl(document, item.lbl);
  const track = document.createElement('div');
  track.className = 'tl-track';
  const bar = makeEl(item.bar);
  track.append(bar);
  el.append(lbl, track);
  rowParts.set(el, { lbl, bar });
  return el;
}
// only the label and the bar are written, and only the parts of them that differ: a running bar that grows keeps its element
// (and its marching stripes)
function updateRow(el, prev, item) {
  const p = rowParts.get(el);
  updateSpecEl(p.lbl, prev.lbl, item.lbl);
  updateSpecEl(p.bar, prev.bar, item.bar);
}
// an edge draws itself once, when it first appears; later it is only moved or restyled
function createEdge(spec) {
  const el = createSpecEl(document, spec);
  if (!state.drawn.has(spec.key)) { state.drawn.add(spec.key); el.classList.add('draw'); }
  return el;
}
function renderTimeline(run) {
  const ags = agentsOf(run).filter((a) => val(a.startedAt));
  const empty = $('#tl-empty'), axis = $('#tl-axis'), tl = $('#tl');
  setShown(empty, !ags.length); setShown(axis, ags.length > 0); setShown(tl, ags.length > 0);
  if (!ags.length) { lists.rows.sync([]); lists.edges.sync([]); return; }
  const now = Date.now();
  // where each bar ends (barEnd): the end time; for a running agent, now (in a replay: the latest time the Run records, never the
  // wall clock); for an interrupted one, its last recorded activity (it is not running, so its bar does not grow)
  const endOf = (a) => barEnd(a, run, now) ?? val(a.startedAt);
  const t0 = Math.min(...ags.map((a) => val(a.startedAt)));
  const t1 = Math.max(...ags.map(endOf), t0 + 1000);
  const pct = (t) => ((t - t0) / (t1 - t0)) * 100;
  const rel = state.drawerAgent ? relatedIds(run, state.drawerAgent, drawnEdge) : new Set();
  lists.axis.sync([
    specOf(keyOf('pad'), {}, '', 'span'),
    specOf(keyOf('range'), {}, `${esc(fmtTime(t0))} → ${esc(fmtTime(t1))} (${esc(fmtDur(t1 - t0))})`, 'span'),
  ]);
  lists.rows.sync(ags.map((a) => {
    const s = val(a.startedAt), e = endOf(a);
    // no title on the bar: the hover panel says what it would (state, interrupted note, where the bar ends)
    const cls = a.id === state.drawerAgent ? ' sel' : rel.has(a.id) ? ' rel' : '';
    return {
      key: keyOf('tl', a.id),
      attrs: { class: 'tl-row', 'data-row': a.id },
      lbl: specOf('lbl', { class: 'lbl', 'data-agent': a.id, title: val(a.label) }, esc(val(a.label) || a.id)),
      bar: specOf('bar', {
        class: `tl-bar st-${visualState(a)}${cls}`, 'data-agent': a.id, 'aria-label': `${val(a.label) || a.id} — ${stateTip(a)}`,
        style: `--c:${roleColor(run, val(a.role))};left:${pct(s).toFixed(4)}%;width:${Math.max(pct(e) - pct(s), 0.4).toFixed(4)}%`,
      }, ''),
    };
  }));
  scheduleEdges();
}
// the timeline draws data-flow edges, and the weak time-order hints only when the user asks for them
const drawnEdge = (e) => e.kind === 'data-flow' || state.weak;
// the edges are measured from the bars as laid out, so they are drawn after the browser has laid the rows out
function scheduleEdges() {
  if (state.edgesQueued) return;
  state.edgesQueued = true;
  requestAnimationFrame(() => { state.edgesQueued = false; drawTimelineEdges(state.run); });
}
function drawTimelineEdges(run) {
  const tl = $('#tl');
  if (!run || state.view !== 'timeline' || tl.hidden) return;
  const box = tl.getBoundingClientRect();
  const barOf = (id) => tl.querySelector(`.tl-bar[data-agent="${CSS.escape(id)}"]`);
  const specs = [];
  for (const e of run.edges || []) {
    if (!drawnEdge(e)) continue;
    const a = barOf(e.from), b = barOf(e.to);
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x1 = ra.right - box.left, y1 = ra.top + ra.height / 2 - box.top;
    const x2 = rb.left - box.left, y2 = rb.top + rb.height / 2 - box.top;
    const mx = (x1 + x2) / 2;
    // the selected agent's edges (in and out) stand out, every other edge is dimmed
    const s = specOf(keyOf('edge', edgeKey(e)), {
      class: `edge ${e.strength === 'strong' ? 'strong' : 'weak'} ${edgeEmphasis(e, state.drawerAgent)}`,
      d: `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx.toFixed(1)},${y1.toFixed(1)} ${mx.toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`,
    }, `<title>${esc(e.kind)} (${esc(e.prov)}): ${esc(e.evidence)}</title>`, 'path');
    specs.push({ ...s, ns: SVG_NS });
  }
  lists.edges.sync(specs);
}
// The selected agent changed (a click opened its drawer, or the drawer closed): the views carry the selection in their specs, so
// drawing them again touches only the cells, bars, cards and edges whose selection changed.
function refreshSelection() {
  if (state.run) renderView();
}

// ---------- live highlight: the cell / bar / card of the agent of a live event, for 1.5 s ----------
function flashTargets(id) {
  const q = CSS.escape(id);
  return document.querySelectorAll(`.cell[data-agent="${q}"], .tl-bar[data-agent="${q}"], .acard[data-agent="${q}"]`);
}
// lights one element, carrying on where the highlight is (a new element of a lit agent joins it part-way)
function paintFlashEl(el, id = el.getAttribute?.('data-agent')) {
  const t0 = id ? state.flash.get(id) : undefined;
  if (t0 === undefined || !el.matches?.(FLASH_SELECTOR)) return;
  const elapsed = performance.now() - t0;
  if (elapsed >= FLASH_MS) return;
  el.classList.remove('flash');
  setStyleProp(el, '--fd', `-${Math.round(elapsed)}ms`);
  void el.offsetWidth; // restarts the animation when the same agent has another event
  el.classList.add('flash');
}
function paintFlash(id) {
  const t0 = state.flash.get(id);
  if (t0 === undefined) return;
  if (performance.now() - t0 >= FLASH_MS) { state.flash.delete(id); return; }
  for (const el of flashTargets(id)) paintFlashEl(el, id);
}
// The timer that ends the highlight of an agent: there is one per agent, kept in state.flashEnds. A new one cancels the one before it
// (two events of an agent at the same time would otherwise leave a timer that Pause cannot reach), so that a paused replay can hold
// every pending end: nothing in the views changes between Pause and Resume.
function armFlashEnd(id, t0, ms) {
  const before = state.flashEnds.get(id);
  if (before !== undefined) clearTimeout(before);
  state.flashEnds.set(id, setTimeout(() => {
    if (state.flash.get(id) !== t0) return; // a later event of the agent keeps it lit
    state.flashEnds.delete(id);
    state.flash.delete(id);
    for (const el of flashTargets(id)) el.classList.remove('flash');
  }, ms));
}
function flashAgent(id) {
  if (!id) return;
  const t0 = performance.now();
  state.flash.set(id, t0);
  paintFlash(id);
  armFlashEnd(id, t0, FLASH_MS + 30);
}
// Pause: the pending ends are cancelled (the lit elements stay as they are; the animation is the stylesheet's). Resume: a highlight that
// has run out meanwhile is taken off now, one that has not gets its end again for what is left of it.
function holdFlashes() {
  for (const handle of state.flashEnds.values()) clearTimeout(handle);
  state.flashEnds.clear();
}
function releaseFlashes() {
  const t = performance.now();
  for (const [id, t0] of [...state.flash]) {
    if (t - t0 >= FLASH_MS) {
      state.flash.delete(id);
      for (const el of flashTargets(id)) el.classList.remove('flash');
    } else if (!state.flashEnds.has(id)) armFlashEnd(id, t0, FLASH_MS + 30 - (t - t0));
  }
}
// the replay is left: no highlight of it is kept, lit or waiting
function endFlashes() {
  holdFlashes();
  for (const id of state.flash.keys()) for (const el of flashTargets(id)) el.classList.remove('flash');
  state.flash.clear();
}

// ---------- right column, tests ----------
const RUN_CARDS_MAX = 60; // the cards of the run result drawn at most (the agents' cards have the same limit)
function renderRight(run) {
  const by = scopeSplit(run);
  const vv = (v) => v.verdict ?? v.value;
  const verdictCounts = {};
  for (const v of by.agent.verdicts) verdictCounts[vv(v)] = (verdictCounts[vv(v)] || 0) + 1;
  // a verdict value takes a colour slot in order of first appearance; what the value says does not decide how it looks
  const slots = orderOfAppearance([...by.agent.verdicts, ...by.run.verdicts].map(vv));
  const slot = (v) => `--c:var(${slotVar(slots, vv(v))})`;
  // the counters are the agents' own; what the run result holds is added to them in words
  const inRun = (n) => (n ? ` + ${n} in the run result` : '');
  lists.counters.sync([
    specOf(keyOf('counter', 'findings'), { class: 'counter' }, `<div class="v">${by.agent.findings.length}</div><div class="k">findings in results${inRun(by.run.findings.length)}</div>`),
    specOf(keyOf('counter', 'verdicts'), { class: 'counter' }, `<div class="v">${by.agent.verdicts.length}</div><div class="k">verdicts ${Object.entries(verdictCounts).map(([k, n]) => `${esc(k)}:${n}`).join(' ')}${inRun(by.run.verdicts.length)}</div>`),
  ]);
  // a card is keyed by its agent and the place of the field in the agent's result, so it stays the same card as the list grows
  const items = [
    ...by.agent.verdicts.map((v) => ({ ts: val(run.agents?.[v.agentId]?.endedAt) || 0, spec: specOf(keyOf('verdict', v.agentId, v.path ?? null), { class: 'fcard', style: slot(v), 'data-agent': v.agentId }, `<div class="h"><span>${esc(agentLabel(run, v.agentId))}</span><span class="tag vt" style="${slot(v)}" title="inferred: ${esc(v.method || '')}">${esc(vv(v))}</span></div><div class="t">${esc(v.reason || '')}</div>`) })),
    ...by.agent.findings.map((f) => ({ ts: val(run.agents?.[f.agentId]?.endedAt) || 0, spec: specOf(keyOf('finding', f.agentId, f.path ?? null), { class: 'fcard', 'data-agent': f.agentId }, `<div class="h"><span>${esc(agentLabel(run, f.agentId))}</span><span>${esc(f.severity || '')}</span></div><div class="t"><b>${esc(f.file || '')}${f.line ? ':' + esc(f.line) : ''}</b> ${esc(f.title || f.description || '')}</div>${f.input ? `<div class="muted">input: ${esc(String(f.input).slice(0, 120))}</div>` : ''}`) })),
  ].sort((a, b) => b.ts - a.ts);
  // the cards of the run result: no agent owns them, so they stand in a group of their own before the agents' cards (keys in a space of
  // their own), say where they come from, and open the run result when clicked
  const runCards = [
    ...by.run.verdicts.map((v) => specOf(keyOf('run-verdict', v.path ?? null), { class: 'fcard', style: slot(v), 'data-result': '', title: v.from ? `from ${v.from}` : null }, `<div class="h"><span>${esc(runItemLabel(v))}</span><span class="tag vt" style="${slot(v)}" title="inferred: ${esc(v.method || '')}">${esc(vv(v))}</span></div><div class="t">${esc(v.reason || '')}</div>`)),
    ...by.run.findings.map((f) => specOf(keyOf('run-finding', f.path ?? null), { class: 'fcard', 'data-result': '', title: f.from ? `from ${f.from}` : null }, `<div class="h"><span>${esc(runItemLabel(f))}</span><span>${esc(f.severity || '')}</span></div><div class="t"><b>${esc(f.file || '')}${f.line ? ':' + esc(f.line) : ''}</b> ${esc(f.title || f.description || '')}</div>${f.input ? `<div class="muted">input: ${esc(String(f.input).slice(0, 120))}</div>` : ''}`)),
  ];
  const cards = runCards.length ? [groupOf(keyOf('run-result-items'), {}, [
    specOf(keyOf('head'), { class: 'muted' }, `in the run result${runCards.length > RUN_CARDS_MAX ? ` (first ${RUN_CARDS_MAX} of ${runCards.length})` : ''}`),
    ...runCards.slice(0, RUN_CARDS_MAX),
  ])] : [];
  const none = `no verdict or finding fields recognised in agent results ${runResultView(run).known ? 'or in the run result ' : ''}(yet)`;
  lists.verdicts.sync(items.length || cards.length ? [...cards, ...items.slice(0, 60).map((i) => i.spec)]
    : [specOf(keyOf('no-items'), { class: 'muted' }, none)]);
}
// a count the summary does not have: a "?" that says why, not a bare question mark
const countTag = (n, cls, word) => (n === null
  ? `<span class="tag ${cls}" title="unknown: not in the summary"><span class="fact prov-unknown">?</span> ${word}</span>`
  : `<span class="tag ${cls}">${n} ${word}</span>`);
function renderTests(run) {
  setShown($('#tests-card'), true);
  const view = testsView(run, { expanded: state.testsExpanded });
  const rows = view.rows;
  // a running run with no counts has not been heard from yet; saying "none recognised" would imply there are none
  if (!rows.length) { lists.tests.sync([specOf(keyOf('no-tests'), { class: 'muted' }, esc(testsEmptyMessage(run)), 'span')]); return; }
  const items = rows.map((t) => {
    const total = (t.passed || 0) + (t.failed || 0) + (t.skipped || 0);
    const w = total ? ((t.passed || 0) / total) * 100 : 0;
    const who = t.role !== null && t.unit !== null ? `<small class="ru" title="from the label (inferred)">${esc(t.role)} · ${esc(t.unit)}</small>` : '';
    // a row of the run result belongs to no agent: it says where in the result it was found and opens the run result, not an agent
    const owner = t.scope === 'run' ? { 'data-result': '', title: t.method ? `from the run result (inferred: ${t.method})` : 'from the run result' } : { 'data-agent': t.agentId };
    const place = t.scope === 'run' && t.path ? `<small class="muted">${esc(t.path)}</small>` : '';
    return specOf(t.key, { class: 'tests-row', ...owner },
      `<span>${esc(t.caption)}</span>${who}${place}${countTag(t.passed, 'pass', 'pass')}${countTag(t.failed, t.failed ? 'fail' : '', 'fail')}${countTag(t.skipped, '', 'skipped')}<div class="bar"><i style="width:${w}%"></i></div>`);
  });
  // fewer rows than the run has: the card says so and offers the rest; the button is its own keyed element (it keeps keyboard focus)
  if (view.hidden > 0 || view.canCollapse) {
    items.push(groupOf(keyOf('tests-more'), { class: 'tests-more' }, [
      specOf(keyOf('text'), { class: 'muted' }, `showing ${view.shown} of ${view.total}`, 'span'),
      specOf(keyOf('toggle'), { type: 'button', class: 'more-toggle', 'data-tests-toggle': '', 'aria-expanded': String(state.testsExpanded) },
        view.hidden > 0 ? `show all ${view.total}` : 'show fewer', 'button'),
    ]));
  }
  lists.tests.sync(items);
}

// ---------- event log (bottom pane): time · actor · message · status ----------
// The time shown is the agent's start / end time from the Run for the events that say when an agent began or ended (a journal
// line has no timestamp of its own: its event ts is the file time), else the event ts; the tooltip says which.
// The backlog is shown in the order of that time; live events are appended as they arrive. A live event reaches the page before
// the snapshot that holds its agent, so its line is timed again when that snapshot arrives (retimeLog).
function timeHtml(l) {
  return l.ts == null ? `<span class="t prov-unknown fact" title="${esc(l.timeTip)}">?</span>` : `<span class="t ${l.timeSource === 'agent' ? 'agent-time' : ''}" title="${esc(l.timeTip)}">${esc(fmtTime(l.ts))}</span>`;
}
// One log line as a spec. A line is keyed by its seq, the marker of missing events by the seq where it stands, in a key space of
// its own, so a marker from seq 5 is never the line of seq 5.
function lineSpec(item) {
  if (item.missing !== undefined) {
    return { ...specOf(keyOf('missing', item.from), { class: 'll missing', 'data-seq': item.from, title: 'the server no longer has these events' },
      `… ${esc(item.missing)} event${item.missing === 1 ? '' : 's'} not available (seq ${esc(item.from)}–${esc(item.to)})`), seq: lineSeq(item) };
  }
  const l = logLine(item, state.run);
  const st = l.status ? `<span class="sep">·</span><span class="st tag ${esc(stateClass(l.status))}">${esc(l.status)}</span>` : '';
  const who = l.actor ? esc(l.actor) : '';
  return {
    ...specOf(keyOf('seq', item.seq), { class: 'll', 'data-agent': item.agentId, 'data-seq': item.seq, 'data-tkey': l.timeKey },
      `${timeHtml(l)}<span class="sep">·</span><span class="who" title="${who}">${who}</span><span class="sep">·</span><span class="msg" title="${esc(l.message)}">${esc(l.message)}</span>${st}`),
    seq: item.seq, tkey: l.timeKey,
  };
}
// The notice that the backlog could not be read is a line of the log (first in it, never counted as an event, never sorted with the
// events), so the log is not an empty list that waits for events. It is keyed on its own.
const noticeKey = keyOf('notice');
const noticeSpec = () => specOf(noticeKey, { class: 'll notice', role: 'status' }, `<span class="msg">${esc(backlogNotice(state.backlogError))}</span>`);
const hasNotice = () => lists.log.st.items[0]?.key === noticeKey;
// The log as drawn: the notice (when there is one), then the backlog sorted by the displayed time, then the lines that came live
// after it in arrival order.
function logItems() {
  const items = logOrder(state.log.lines, state.run, state.backlogSeq).map(lineSpec);
  return state.backlogError ? [noticeSpec(), ...items] : items;
}
// A read of the log that was already there (a re-sort, a backlog after a gap) stays where the user was unless they were at the
// bottom; the lines that did not change are not touched and only the lines that must change place are moved.
function renderLogAll({ keepPosition = false } = {}) {
  const el = $('#log');
  const follow = !keepPosition || isNearBottom(el);
  lists.log.sync(logItems());
  if (follow) el.scrollTop = el.scrollHeight;
  renderLogCount();
}
// A run snapshot arrived: the line of an agent.started / agent.result event that came before the snapshot holding its agent was
// drawn with the event ts. When the time (or tooltip) of a line is different now, the log is brought up to date: that line is
// changed in place, and a line of the backlog changes its place too, when the backlog is no longer in the order of the displayed
// time; the live lines keep arrival order.
function retimeLog() {
  if (!state.run) return;
  const drawn = new Map();
  for (const s of lists.log.st.items) if (s.tkey !== undefined) drawn.set(s.seq, s.tkey);
  const changed = retimedLines(state.log.lines, state.run, (item) => drawn.get(item.seq));
  if (changed.length) renderLogAll({ keepPosition: true });
}
// New lines at the bottom, in arrival order. The view follows them unless the user has scrolled up to read.
function appendLog(items) {
  const el = $('#log');
  const follow = isNearBottom(el);
  const specs = items.map(lineSpec);
  // a line whose key is on the page already (the page kept the lines of a run that was read again, and the server counts from 1
  // again): the whole log is drawn against the page instead of adding a second element for a key
  if (specs.some((s) => lists.log.st.els.has(s.key))) return renderLogAll({ keepPosition: true });
  appendItems(el, lists.log.st, specs, { create: makeEl });
  // the model keeps the last LOG_CAP events by seq; the lines of the page go with it (the backlog is sorted by time, so by seq, not by position)
  if (lists.log.st.items.length - (hasNotice() ? 1 : 0) > state.log.lines.length) {
    const min = lineSeq(state.log.lines[0]);
    dropItems(el, lists.log.st, (s) => s.seq < min);
  }
  if (follow) el.scrollTop = el.scrollHeight;
  renderLogCount();
}
// "showing the last N of M events" counts the event lines only: the markers of missing events are not events
function renderLogCount() {
  setText($('#log-count'), logHeader({ shown: state.log.eventCount, cap: LOG_CAP, maxSeq: state.log.maxSeen }));
}
// A backlog that could not be read is a visible line of the log, and the same text is in the head of the pane, which stays when the
// log is collapsed (the line is in the log, and a collapsed log shows nothing of itself).
function renderLogNotice() {
  const n = $('#log-notice');
  setShown(n, !!state.backlogError);
  setText(n, state.backlogError ? backlogNotice(state.backlogError) : '');
  const el = $('#log');
  const st = lists.log.st;
  const now = hasNotice() ? st.items[0] : null;
  if (!state.backlogError) {
    if (now) dropItems(el, st, (s) => s.key === noticeKey);
    return;
  }
  const spec = noticeSpec();
  if (now && sameJson(now, spec)) return;
  if (now) dropItems(el, st, (s) => s.key === noticeKey);
  prependItems(el, st, [spec], { create: makeEl });
}
function setLogCollapsed(collapsed) {
  $('#log-pane').classList.toggle('collapsed', collapsed);
  $('#log-toggle').setAttribute('aria-expanded', String(!collapsed));
  setText($('#log-toggle .chev'), collapsed ? '▸' : '▾');
  localSet('logCollapsed', collapsed ? '1' : '0');
  if (!collapsed) $('#log').scrollTop = $('#log').scrollHeight;
}
// log() lines of the workflow script: written only at the end of the run, so a Fact that is unknown while it runs
function renderLogMeta(run) {
  const logs = run.logs;
  setHtml($('#log-meta'), logs && logs.prov !== 'unknown' && Array.isArray(logs.value)
    ? `log(): ${logs.value.slice(-3).map(esc).join(' · ')}`
    : `log(): ${fact(logs)}`);
}

// ---------- sizes of the columns and the log: dragged, clamped, remembered ----------
// the width the columns share (the page area inside the padding of the grid) and the height of the window
function viewport() {
  const grid = $('.grid');
  const cs = getComputedStyle(grid);
  return { width: grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0), height: window.innerHeight };
}
// the wanted sizes (stored, default or dragged) clamped to the window as it is now, and written as CSS variables
function applyLayout(prefer = null) {
  const sized = clampLayout(state.layout, viewport(), prefer);
  for (const [k, v] of Object.entries(sized)) setStyleProp(document.documentElement, SIZES[k].prop, `${v}px`);
  return sized;
}
function loadLayout() {
  for (const k of Object.keys(SIZES)) {
    const n = parseStoredSize(localGet(SIZES[k].key)); // a stored value is untrusted: a bad one is the default
    if (n !== null) state.layout[k] = n;
  }
  applyLayout();
}
function resetSize(kind) {
  delete state.layout[kind];
  localRemove(SIZES[kind].key);
  applyLayout();
  scheduleEdges();
}
// The pointer is captured by the handle, so its move and up events come to the handle itself. The listeners live from the press to
// the release (up, cancel or lost capture); the size is saved on release and only if it changed, so the first press of a
// double click saves nothing. The drag starts from the sizes on show (all three, as clamped to the window now), not from the sizes
// that were wanted: a column that is shown narrower than its saved size keeps the width the user sees while the other is dragged.
function startDrag(kind, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const shown = applyLayout();
  const start = shown[kind];
  const from = { x: e.clientX, y: e.clientY };
  let moved = false, over = false;
  try { handle.setPointerCapture(e.pointerId); } catch { /* the drag goes on while the pointer is over the handle */ }
  document.body.classList.add('resizing');
  handle.classList.add('drag');
  const move = (ev) => {
    const sized = dragLayout(shown, kind, start, { dx: ev.clientX - from.x, dy: ev.clientY - from.y }, viewport());
    if (sized[kind] !== start) moved = true;
    if (moved) Object.assign(state.layout, sized); // what is shown is now what is wanted; only the dragged size is stored below
    applyLayout(kind);
    scheduleEdges();
  };
  const end = () => {
    if (over) return;
    over = true;
    for (const t of ['pointermove']) handle.removeEventListener(t, move);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.removeEventListener(t, end);
    document.body.classList.remove('resizing');
    handle.classList.remove('drag');
    if (moved) { applyLayout(kind); localSet(SIZES[kind].key, String(state.layout[kind])); }
  };
  handle.addEventListener('pointermove', move);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(t, end);
}

// ---------- drawer ----------
// The drawer is a keyed list of sections (lib.js groupOf): the title, the facts, the changes, the dependencies, the result, the
// prompt, the activity. A section whose content did not change is not touched, so a text block the user scrolled (Result, Prompt,
// one edit of Changes) keeps its element and its scroll position through every snapshot and every transcript read; a change of
// one value (the tokens of a running agent) rewrites only that value.
function openDrawer(id) {
  if (!state.run?.agents?.[id]) return;
  if (state.drawerAgent !== id) { state.transcript = null; lists.drawer.clear(); } // another agent starts from nothing (so does the run result's drawer)
  state.drawerAgent = id; state.drawerResult = false;
  renderDrawer();
  refreshSelection();
  loadTranscript(id);
}
// The run result's own drawer: the raw result of the run and where it came from. It belongs to no agent, so no transcript is read and a
// read of an agent's transcript still on its way must not draw into it (the token moves on).
function openResultDrawer() {
  if (!state.run) return;
  if (!state.drawerResult) { lists.drawer.clear(); } // it starts from nothing when it replaces an agent's drawer
  state.drawerAgent = null; state.drawerResult = true; state.transcript = null; state.trToken++; state.drawerTarget = null;
  clearTimeout(state.trTimer);
  renderResultDrawer();
  refreshSelection();
}
function closeDrawer() {
  state.drawerAgent = null; state.drawerResult = false; state.transcript = null; state.trToken++; state.drawerTarget = null;
  clearTimeout(state.trTimer);
  lists.drawer.clear();
  setShown($('#drawer'), false);
  refreshSelection();
}
async function loadTranscript(id) {
  if (replayOnShow()) return; // the files of the real run hold what has not happened yet at the replay's time
  const runId = state.runId, token = ++state.trToken;
  const list = await getJson(`/api/agents/${enc(runId)}/${enc(id)}/transcript?tail=200`);
  if (token !== state.trToken || state.drawerAgent !== id || state.runId !== runId) return;
  state.transcript = { agentId: id, list };
  renderDrawer();
}
// a new event of the agent whose drawer is open: read its transcript again, so a new edit shows up as it happens
function scheduleTranscript() {
  clearTimeout(state.trTimer);
  state.trTimer = setTimeout(() => { if (state.drawerAgent) loadTranscript(state.drawerAgent); }, 400);
}
function blockHtml(b) {
  if (b.kind === 'flag') return `<span class="flag">${esc(b.name)}: ${esc(b.text)}</span>`;
  const shown = b.text.length > MAX_SHOWN ? b.text.slice(0, MAX_SHOWN) : b.text;
  const more = b.text.length - shown.length;
  const sign = b.kind === 'old' ? '− ' : b.kind === 'new' ? '+ ' : '';
  return `<div class="dblock ${b.kind}"><div class="dname">${sign}${esc(b.name)}</div><pre>${esc(shown)}</pre>${more > 0 ? `<small>… ${more} more characters not shown</small>` : ''}</div>`;
}
// the inside of one edit of the Changes list (its element, class diff, is a keyed child)
function diffHtml(entry) {
  const d = editDiff(entry);
  const file = d.file ? `<span class="file">${esc(d.file)}</span>` : `<span class="muted">${d.hasInput ? 'no file field in the input' : esc(d.summary || 'input not kept')}</span>`;
  const trunc = d.truncated ? ` <span class="tag trunc" title="the reader cut this input (inputTruncated): what is shown is not all of it">truncated</span>` : '';
  const body = d.hasInput
    ? d.blocks.map(blockHtml).join('') + d.edits.map((e, i) => `<div class="diff-edit"><div class="dname idx">edit ${i + 1} of ${d.edits.length}</div>${e.blocks.map(blockHtml).join('')}</div>`).join('')
    : `<div class="muted" style="padding:6px 8px">the input was too large to keep; nothing to show</div>`;
  return `<div class="diff-h"><b>${esc(d.tool || 'edit')}</b> ${file} <small>${esc(fmtTime(d.ts))}</small>${trunc}</div>${body}`;
}
// the edits of the transcript, newest first, each a child with its own key (the time, the tool and the place among equal ones)
function diffChildren() {
  const t = state.transcript;
  if (!t) return [replayOnShow() ? noteSpec('replay', 'edit inputs are not available in a replay') : noteSpec('loading', 'loading…')];
  if (!t.list) return [noteSpec('unread', 'the transcript could not be read')];
  const edits = t.list.filter(hasEditInput);
  if (!edits.length) return [noteSpec('none', 'no edit tool with a recorded input in this agent\'s activity')];
  const keys = entryKeys(edits, 'diff');
  return edits.map((e, i) => specOf(keys[i], { class: 'diff' }, diffHtml(e))).reverse();
}
// every edge of the agent with the fields as the Run has them (kind, strength, prov, method, evidence); the Run's edge has no
// method field, so it shows as unknown
const edgeSpec = (e) => specOf(keyOf('edge', e.dir, e.key), { class: `edge-row ${e.strength || ''}` },
  `<div class="meta">${e.dir === 'in' ? '←' : '→'} <b class="lk" data-agent="${esc(e.other)}">${esc(e.otherLabel)}</b> · kind <b>${esc(e.kind)}</b> · ${e.strength ? `strength <b>${esc(e.strength)}</b> · ` : ''}prov <b>${esc(e.prov)}</b> · method ${e.method ? `<b>${esc(e.method)}</b>` : '<span class="fact prov-unknown" title="unknown: the Run\'s edge has no method field">?</span>'}</div>
      <div class="ev">${esc(e.evidence)}</div>`);
function actHtml(x) {
  return `<small>${esc(fmtTime(x.ts))}</small> ${x.tool ? `<b>${esc(x.tool)}</b> ${esc(x.inputSummary || '')}` : esc(x.text || '')}`;
}
function activityChildren(a) {
  const list = state.transcript?.list || a.activity || [];
  const waiting = !state.transcript && !replayOnShow();
  if (!list.length) return [noteSpec(waiting ? 'loading' : 'none', waiting ? 'loading…' : 'no activity recorded')];
  const keys = entryKeys(list, 'act');
  return list.map((x, i) => specOf(keys[i], { class: 'act' }, actHtml(x))).reverse();
}
function drawerItems(run, id) {
  const a = run.agents[id];
  const { incoming: inE, outgoing: outE } = edgesOf(run, id);
  const result = val(a.result);
  const stateCell = isInterrupted(a)
    ? `<span class="tag interrupted" title="${esc(interruptNote(a))}">interrupted</span> <small>${esc(interruptNote(a))}</small>`
    : fact(a.state);
  const facts = [
    ['state', stateCell], ['phase', fact(a.phase)],
    ['role / unit / round / tag', `${fact(a.role)} / ${fact(a.unit)} / ${fact(a.round)} / ${fact(a.tag, (x) => '#' + x)}`],
    ['model', fact(a.model)], ['agent type', fact(a.agentType)],
    ['started', fact(a.startedAt, fmtTime)], ['ended', fact(a.endedAt, fmtTime)],
    ['duration', fact(a.durationMs, fmtDur)], ['tokens', fact(a.tokens, fmtNum)],
    ...usageRows(a.usage),
    ...(showsCost(run) ? [['cost', costHtml(agentCostView(a, state.prices))]] : []), // a demo Run shows no cost
    ['other engines', esc(ENGINES_NOTE)],
    ['tool calls', fact(a.toolCalls)], ['agent id', esc(a.id)],
  ];
  if (agentNeedsPrices(a, run)) ensurePrices();
  // a section is an element of its own (a keyed child of the drawer body); data-sec names it
  const sec = (name, html, tag, attrs = {}) => specOf(keyOf('drawer', name), { 'data-sec': name, ...attrs }, html, tag);
  const group = (name, children, tag, attrs = {}) => groupOf(keyOf('drawer', name), { 'data-sec': name, ...attrs }, children, tag);
  const heading = (name, html) => specOf(keyOf('drawer', `h-${name}`), {}, html, 'h3');
  const deps = [...inE, ...outE].map(edgeSpec);
  return [
    sec('title', fact(a.label), 'h2'),
    group('facts', facts.flatMap(([k, v]) => [specOf(keyOf('dt', k), {}, esc(k), 'dt'), specOf(keyOf('dd', k), {}, v, 'dd')]), 'dl'),
    heading('changes', 'Changes <small>edit tools with a recorded input</small>'),
    group('changes', diffChildren(), 'div', { id: 'diffs' }),
    heading('deps', 'Dependencies'),
    group('deps', deps.length ? deps : [noteSpec('none', 'no inferred dependencies; registered dependencies are not provided by the source')], 'div'),
    heading('result', `Result ${a.result ? `<small>${esc(a.result.prov)}</small>` : ''}`),
    sec('result', result == null ? esc(a.result?.reason || 'no result yet') : esc(typeof result === 'string' ? result : JSON.stringify(result, null, 2)), 'pre'),
    heading('prompt', 'Prompt'),
    sec('prompt', esc(val(a.prompt) ?? a.prompt?.reason ?? ''), 'pre'),
    heading('activity', 'Activity'),
    group('activity', activityChildren(a), 'div', { id: 'activity' }),
  ];
}
function renderDrawer() {
  const run = state.run; const id = state.drawerAgent;
  if (!run?.agents?.[id]) return;
  lists.drawer.sync(drawerItems(run, id));
  setShown($('#drawer'), true);
  applyDrawerTarget(); // what is above a section can have grown or shrunk (the Changes group when the transcript is read)
}
// the sections of the run result's drawer, each a keyed child like the agent's: the title, where the result came from, and the result
// itself (a text as it is, anything else as indented JSON, escaped like every string of the run's data)
function resultDrawerItems(run) {
  const v = runResultView(run);
  const facts = [
    ['provenance', fact(v.known ? { value: v.prov, prov: v.prov, from: v.from } : { value: null, prov: 'unknown', reason: v.reason })],
    ['from', v.from ? esc(v.from) : fact({ value: null, prov: 'unknown', reason: 'the Run gives no source for the result' })],
  ];
  return [
    specOf(keyOf('result-drawer', 'title'), { 'data-sec': 'run-result-title' }, 'Run result', 'h2'),
    groupOf(keyOf('result-drawer', 'facts'), { 'data-sec': 'run-result-facts' }, facts.flatMap(([k, x]) => [specOf(keyOf('dt', k), {}, esc(k), 'dt'), specOf(keyOf('dd', k), {}, x, 'dd')]), 'dl'),
    specOf(keyOf('result-drawer', 'json'), { 'data-sec': 'run-result' }, v.known ? esc(v.text) : esc(v.reason), 'pre'),
  ];
}
function renderResultDrawer() {
  if (!state.run) return;
  lists.drawer.sync(resultDrawerItems(state.run));
  setShown($('#drawer'), true);
}

// ---------- hover activity: a small panel for the matrix cell or timeline bar under the pointer ----------
// The panel follows the pointer and is read again when the pointer moves, when a run snapshot arrives (render) and when an event
// of the hovered agent arrives. The pointer position is kept and the element under it is looked up again each time. Everything
// shown comes from the Run and the event log; the panel is written only when what it shows or where it stands changed.
const HOVER_SELECTOR = '.cell[data-agent], .tl-bar[data-agent]';
function syncHover(force = false) {
  const panel = $('#hover');
  const p = state.pointer;
  const target = p && state.run ? document.elementFromPoint(p.x, p.y)?.closest(HOVER_SELECTOR) : null;
  const info = target ? hoverInfo(state.run, target.dataset.agent) : null;
  if (!info) { state.hover = null; setShown(panel, false); return; }
  if (force || state.hover !== info.id || panel.hidden) {
    state.hover = info.id;
    setHtml(panel, hoverHtml(info, target));
    setShown(panel, true);
  }
  placeHover(panel, p);
}
function hoverHtml(info, target) {
  const bar = target.classList.contains('tl-bar');
  const items = info.items.map((x) => `<div class="h-item"><small>${esc(fmtTime(x.ts))}</small>${x.tool ? `<b>${esc(x.tool)}</b> ${esc(x.inputSummary || '')}` : esc(x.text || '')}</div>`).join('');
  const n = Number(target.dataset.n || 1);
  const multi = n > 1 ? `<div class="muted">${n} agents in this cell; this is the latest${target.dataset.tags ? ` · tags: ${esc(target.dataset.tags)}` : ''}</div>` : '';
  const barNote = bar && info.interrupted
    ? `<div class="h-note">${typeof info.lastTs === 'number' ? `the bar ends at the last recorded activity (${esc(fmtTime(info.lastTs))})` : 'no activity was recorded, no end time is known'}</div>` : '';
  const ev = lastEventOf(state.log.lines, info.id);
  let evHtml = '';
  if (ev) { const l = logLine(ev, state.run); evHtml = `<div class="h-ev">latest event: <span title="${esc(l.timeTip)}">${esc(fmtTime(l.ts))}</span> ${esc(l.message)}</div>`; }
  return `<div class="h-title"><b>${esc(info.label)}</b><span class="tag ${esc(stateClass(info.state))}">${esc(info.state)}</span></div>
    ${info.note ? `<div class="h-note">${esc(info.note)}</div>` : ''}${barNote}${multi}
    ${items || `<div class="muted">no activity: ${esc(info.reason)}</div>`}${evHtml}`;
}
// beside the pointer; on the other side of it when the panel would run past the window
function placeHover(panel, p) {
  const gap = 14;
  const w = panel.offsetWidth, h = panel.offsetHeight;
  let x = p.x + gap, y = p.y + gap;
  if (x + w > window.innerWidth - 4) x = Math.max(4, p.x - gap - w);
  if (y + h > window.innerHeight - 4) y = Math.max(4, p.y - gap - h);
  const at = `${x}px ${y}px`;
  if (at === state.hoverPos && panel.style.left) return;
  state.hoverPos = at;
  panel.style.left = `${x}px`; panel.style.top = `${y}px`;
}

// ---------- run search ----------
// The box in the header (#search-input) asks GET /api/search, 250 ms after the last key, to look through the runs the server has loaded: their
// names, descriptions, log lines, and each agent's prompt, result and activity. The query logic is lib.js createSearch (one timer, one request
// out at a time, a newer query aborts the older one, a late answer of a superseded query is never drawn); this section only draws its view.
// The results are a panel of rows: the run (its name from the run list, else its id), the agent (its label when the run is the one on show,
// else its id), the field, and the excerpt with the match marked. Everything of a result is put in as text (createTextNode, textContent) and
// the match is a mark element made around its own text node: no html is ever built from a result. A row is kept while the list changes
// (lib.js patchList by key), so a row that stays is only patched, never rebuilt. A click on a row opens the run when it is not the one on show
// (or when a replay is on show) and then the agent's drawer at the field's section, which is a target kept until the drawer is scrolled (the
// transcript read changes the height above the section); a result of a run's own field (name, description, log line) opens the run, closes the
// drawer that is open on it (the drawer is fixed, z-index 10, and would cover the notice) and puts the field and its excerpt in the notice under
// the header (#search-hit): the answer names no place in the log, and the run's log() lines are shown only as the last few in the log's head. The query is not kept anywhere (not in the address, not in storage, not in the picker's own search
// text) and the results are not asked for again when a run snapshot arrives.
const hitEls = new WeakMap(); // the row of a result -> { item, run, agent, field, before, mark, after }: what the click opens, and the nodes to patch
function textNode(text) { return document.createTextNode(text); }
function createHitRow(item) {
  const row = document.createElement('div');
  row.className = 'srch-row';
  row.setAttribute('tabindex', '0');
  row.setAttribute('role', 'listitem');
  const head = document.createElement('div');
  head.className = 'srch-head';
  const part = (cls) => { const el = document.createElement('span'); el.className = cls; head.append(el); return el; };
  const run = part('srch-run');
  const agent = part('srch-agent');
  const field = part('srch-field');
  const excerpt = document.createElement('div');
  excerpt.className = 'srch-excerpt';
  const before = textNode('');
  const mark = document.createElement('mark');
  const after = textNode('');
  excerpt.append(before, mark, after);
  row.append(head, excerpt);
  hitEls.set(row, { item, run, agent, field, before, mark, after });
  updateHitRow(row, null, item);
  return row;
}
function updateHitRow(row, _prev, item) {
  const parts = hitEls.get(row);
  parts.item = item;
  const h = item.hit;
  const { before, match, after } = highlightParts(h.excerpt, h.start, h.end);
  setText(parts.run, item.runName);
  setText(parts.agent, item.agent ?? '');
  setShown(parts.agent, item.agent !== null);
  setText(parts.field, item.fieldText);
  if (parts.before.data !== before) parts.before.data = before;
  setText(parts.mark, match);
  setShown(parts.mark, match !== '');
  if (parts.after.data !== after) parts.after.data = after;
  if (row.getAttribute('title') !== h.runId) row.setAttribute('title', h.runId);
}
const hitList = listOf($('#search-list'), { create: createHitRow, update: updateHitRow });

const search = createSearch({
  fetchJson,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
  makeController: () => new AbortController(),
  onChange: (view) => { state.search.view = view; renderSearch(); },
  delay: SEARCH_DELAY_MS,
});

// the panel shows while it is open and there is something to say (a query is waiting, out or answered)
function syncSearchPanel() {
  setShown($('#search-panel'), state.search.open && state.search.view.phase !== 'idle');
}
function renderSearch() {
  const view = state.search.view;
  hitList.sync(searchItems(view.results, state.runs, state.run));
  const status = searchStatus(view);
  // the line is always there and keeps one line of room (style.css .srch-status): its text changes in place, so the rows below never move
  setText($('#search-status'), status);
  const note = notSearchedLine(state.runs);
  setText($('#search-note'), note);
  setShown($('#search-note'), note !== '');
  syncSearchPanel();
}
function onSearchInput(text) {
  state.search.open = true;
  search.input(text);
}
// the box is clicked or tabbed into again: the last results come back while the text is still there
function onSearchFocus() {
  if (state.search.view.phase === 'idle') return;
  state.search.open = true;
  syncSearchPanel();
}
function closeSearchPanel() {
  if (!state.search.open) return;
  state.search.open = false;
  syncSearchPanel();
}
// Esc in the box: the text, the waiting timer, the request out and the results all go, and the panel is hidden
function clearSearch() {
  $('#search-input').value = '';
  state.search.open = false;
  clearSearchHit();
  search.cancel();
}
// The scroll of the drawer (it is the scrolling box, not the page) brings a section into view: scrollIntoView would move every box above it.
function showDrawerSection(name) {
  const drawer = $('#drawer');
  const sec = $('#drawer-body').querySelector(`[data-sec="${name}"]`);
  if (!sec) return;
  const to = scrollToShow({ top: sec.offsetTop, height: sec.offsetHeight, scrollTop: drawer.scrollTop, viewHeight: drawer.clientHeight });
  if (to !== drawer.scrollTop) drawer.scrollTop = to;
}
// The section a click asked for is a target, not a one-time scroll: the Changes group above Result, Prompt and Activity is one "loading..." line until
// the transcript is read and then grows by thousands of px, which moves the section away from the scroll that was written. So the target (agent,
// section, and `at`, the scrollTop the page left the drawer at) is kept and applied again after every render of that drawer. It ends when the drawer
// is closed or shows another agent, and when its scrollTop is not the one the page left (the user scrolled it: the page does not scroll it back).
function applyDrawerTarget() {
  const t = state.drawerTarget;
  if (t === null) return;
  const drawer = $('#drawer');
  if (state.drawerAgent !== t.agentId || drawer.scrollTop !== t.at) { state.drawerTarget = null; return; }
  showDrawerSection(t.name);
  t.at = drawer.scrollTop;
}
// The notice under the header for a result of the run's own field (name, description, log line). The answer names no place in the log and the run's
// log() lines show only as the last few in the log's head, so the notice shows what the answer gives: which field of which run, and the excerpt with
// the match marked (text nodes and a mark element, never html). It stays until the run is changed, Esc clears the search, or it is closed.
let hitNote = null; // { before, mark, after }: the nodes of the excerpt, made the first time a notice is shown (a click), then only patched
function showSearchHit(item) {
  const h = item.hit;
  const { before, match, after } = highlightParts(h.excerpt, h.start, h.end);
  if (hitNote === null) {
    hitNote = { before: textNode(''), mark: document.createElement('mark'), after: textNode('') };
    $('#search-hit-text').append(hitNote.before, hitNote.mark, hitNote.after);
  }
  state.search.hit = h;
  setText($('#search-hit-where'), `${item.fieldText} of ${item.runName}`);
  if (hitNote.before.data !== before) hitNote.before.data = before;
  setText(hitNote.mark, match);
  setShown(hitNote.mark, match !== '');
  if (hitNote.after.data !== after) hitNote.after.data = after;
  setShown($('#search-hit'), true);
}
function clearSearchHit() {
  if (state.search.hit === null) return;
  state.search.hit = null;
  setShown($('#search-hit'), false);
}
async function openHit(item) {
  if (!item) return;
  const { runId, agentId, field } = item.hit;
  closeSearchPanel(); // the drawer it opens is not covered; the text and the results stay for the next look
  clearSearchHit();
  if (runId !== state.runId || replayOnShow()) await selectRun(runId); // the same run is not read again, a replay on show is left for the real view
  if (state.runId !== runId) return; // another run was chosen meanwhile
  if (agentId === undefined) { closeDrawer(); closeHintForHit(); showSearchHit(item); return; } // a field of the run itself: shown in the notice, there is no agent to open; an open drawer (fixed, z-index 10) would cover the notice, so it is closed, and so is the tracking notice (it covers this one in a narrow window)
  if (!Object.hasOwn(state.run?.agents ?? {}, agentId)) return; // the run has no such agent (in this version of it): nothing to open
  openDrawer(agentId);
  const section = searchSection(field);
  if (section !== null) {
    state.drawerTarget = { agentId, name: section, at: $('#drawer').scrollTop };
    applyDrawerTarget();
  }
}
function onSearchClick(e) {
  const row = e.target.closest?.('.srch-row');
  if (row) openHit(hitEls.get(row)?.item);
}
// Esc clears the box (and goes no further: the drawer stays open, as for the picker). With an empty box nothing is there to clear, and Esc is
// the page's. While an input method is composing, Esc is its own. Enter or Space on a focused row opens it, as a click does.
function onSearchKey(e) {
  if (e.key === 'Escape') {
    if (e.isComposing) { e.stopPropagation?.(); return; }
    if ($('#search-input').value === '' && state.search.view.phase === 'idle') return;
    e.stopPropagation?.();
    clearSearch();
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest?.('.srch-row');
  if (!row) return;
  e.preventDefault?.();
  openHit(hitEls.get(row)?.item);
}

// ---------- replay of a finished run ----------
// The control (lib.js replayControl) shows Replay for a run of source real that is not running, with the speed 1x / 4x / 20x. Replay opens
// GET /api/runs/:id/replay with fetch and reads it with its own reader: the page's EventSource is never used for it (it could not read the
// reason of a refusal, and it would open a finished stream again). The state is one object, state.replay:
//   phase    connecting (the request is out), playing, paused (frames are kept, none is applied), ended, failed
//   shown    the view on screen is a replayed one: the REPLAY mark, the banner and Stop belong to it, and the real stream's `run` and `event`
//            are not drawn over it. It is true from the stream's hello on, and from the click for a replay started on a replayed view
//            (Replay again): that view stays on screen, with its mark, until the new stream says hello or fails, so a refusal (409, 429,
//            404, a lost stream) leaves a replayed view with its mark and a way back, never a replayed view with no mark. A replay started
//            on the real view stays false until the hello: before that the real view stays.
//   begun    the stream has said its (right) hello: its frames are accepted, and the view is cleared for it
//   real     the last real Run of this run that the page had: the one on show at the click, replaced by each real snapshot while the replay
//            has not shown (a refused replay must not offer a Replay for a run that has started again), and kept while the run is read
//            again (a reconnect), until a newer one comes; line: why it failed; count: events APPLIED (never the number received)
//   queue    the frames of the stream (lib.js createReplayQueue): each is stamped with the time the page read it. Playing with nothing kept
//            it is applied at once; Pause keeps them in order; Resume plays them with the gaps they arrived with (so the view runs behind the
//            stream only by what the pause held back, and later frames queue behind the kept ones: see the queue's comment in lib.js). A
//            snapshot is a frame like the others, at its place.
//   over     the stream has nothing more to give: the end, a failure or a cut is queued behind the frames before it. endSeen: `end` came,
//            so a stream that closes after it is not cut short. The phase becomes ended only when the end frame is applied, and failed only
//            when the failure frame is applied (a failure never drops what was kept: the line comes after everything that was kept)
//   abort / closed   one AbortController per stream; `closed`: the replay was left (Stop, another run, Replay again, the page): every
//            callback of it is a no-op and the queue is empty
// The replayed Run is drawn by the same views as a live one (patched by key, never rewritten); its events go through the log's live path
// (state.log.push, appendLog, flashAgent) and never through onLiveEvent, whose gap path reads the real run's backlog.
function replayOnShow() { return state.replay !== null && state.replay.shown; }

// the speed choice: three buttons, the one pressed is the speed the next replay takes; only the control's own values are kept or read back
function renderReplaySpeed() {
  for (const n of REPLAY_SPEEDS) $(`#replay-s${n}`).setAttribute('aria-pressed', String(n === state.replaySpeed));
}
function chooseReplaySpeed(n) {
  state.replaySpeed = n;
  localSet('replay.speed', String(n));
  renderReplaySpeed();
}

function renderReplayControls() {
  const c = replayControl(state.run, state.replay);
  setShown($('#replay-speed'), c.speed);
  setShown($('#replay-go'), c.go !== null);
  if (c.go !== null) setText($('#replay-go'), c.go);
  setShown($('#replay-pause'), c.pause !== null);
  if (c.pause !== null) setText($('#replay-pause'), c.pause);
  setShown($('#replay-stop'), c.stop);
  const line = $('#replay-line');
  setShown(line, c.note !== null);
  setText(line, c.note ?? '');
  const bad = state.replay?.phase === 'failed';
  if (line.classList.contains('bad') !== bad) line.classList.toggle('bad', bad);
  setShown($('#replay-ctl'), c.speed || c.go !== null || c.pause !== null || c.stop || c.note !== null);
  setShown($('#replay-mark'), replayOnShow());
  setShown($('#replay-banner'), modeInfo(state.mode).banner === 'replay' || replayOnShow());
}

// Leaves the stream of a replay: nothing it still calls does anything, nothing it kept is played, no timer of it is left. Returns the
// replay that was left.
function dropReplay() {
  const rep = state.replay;
  if (!rep) return null;
  rep.closed = true;
  rep.abort.abort();
  rep.queue.clear();
  endFlashes();
  state.replay = null;
  return rep;
}

function startReplay() {
  const prev = state.replay;
  if (replayControl(state.run, prev).go === null || !state.runId) return;
  dropReplay();
  const rep = {
    runId: state.runId, speed: state.replaySpeed, phase: 'connecting', shown: prev?.shown === true, begun: false, real: prev?.shown ? prev.real : (state.run ?? prev?.real ?? null),
    queue: null, abort: new AbortController(), closed: false, over: false, endSeen: false, count: 0, line: null,
  };
  // the clock and the timer are looked up when they are used; one queue, so one offset and one timer, for one replay
  rep.queue = createReplayQueue({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    apply: (name, value) => applyReplayFrame(rep, name, value),
  });
  state.replay = rep;
  renderReplayControls();
  readReplay(rep).catch((err) => failStream(rep, replayFailure({ error: err }))); // whatever goes wrong is a line, never a silent stop
}

// The reason goes on the page as a line, with the Replay control, at once: a refusal (404, 409, 429, 400), a frame that is not what the
// contract says, a replay that cannot go on. Nothing that was kept is played after it. A failure that comes after the replayed view began
// leaves what was shown and a way back (Stop).
function failReplay(rep, line) {
  if (state.replay !== rep || rep.closed || rep.phase === 'failed') return;
  rep.over = true;
  rep.abort.abort();
  rep.queue.clear();
  rep.phase = 'failed';
  rep.line = line;
  renderReplayControls();
}

// A failure the page learns of while it reads the stream. Before the replayed view began nothing is kept, so it is shown at once. After
// that it is the last frame of the queue: what was kept is played first, and the line (made when the frame is applied, with the events
// played by then) comes after it. The reader stops: nothing more is taken from the stream.
function failStream(rep, line) {
  if (state.replay !== rep || rep.closed || rep.over || rep.endSeen) return; // after `end` everything has been received: a stream that breaks then is no failure
  if (!rep.begun) return failReplay(rep, line);
  rep.over = true;
  rep.abort.abort();
  rep.queue.push('fail', line);
}

async function readReplay(rep) {
  const left = () => state.replay !== rep || rep.closed;
  let res;
  try {
    res = await fetch(replayUrl(rep.runId, rep.speed), { signal: rep.abort.signal });
  } catch (err) {
    if (!left()) failStream(rep, replayFailure({ error: err }));
    return;
  }
  if (left()) return;
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!left()) failStream(rep, replayFailure({ status: res.status, body }));
    return;
  }
  const reader = res.body?.getReader?.();
  if (!reader) return failStream(rep, 'the browser gave no stream to read the replay from');
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (left() || rep.over) return;
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
        if (left() || rep.over) return;
        onReplayFrame(rep, frame);
      }
    }
  } catch (err) {
    if (!left() && !rep.over) failStream(rep, replayFailure({ error: err }));
    return;
  }
  // the stream closed: after `end` that is the normal close; before it the replay was cut, which is the last frame (its count is made then)
  if (!left() && !rep.over && !rep.endSeen) {
    if (!rep.begun) return failStream(rep, replayCutText(0)); // before the hello nothing was played or kept
    rep.over = true;
    rep.queue.push('cut');
  }
}

// A frame is stamped when the page reads it (the queue does it) and applied in its turn: on arrival when nothing is kept and nothing was
// ever paused, else at its place in the queue.
function onReplayFrame(rep, frame) {
  const f = readReplayFrame(frame);
  if (f.bad) return failStream(rep, `a frame of the replay stream could not be read (${f.name})`);
  if (f.name === 'hello') {
    if (rep.begun) return;
    const problem = replayHelloProblem(f.value, rep.runId);
    return problem ? failStream(rep, problem) : beginReplayView(rep);
  }
  if (f.name !== 'event' && f.name !== 'run' && f.name !== 'end') return; // a frame the page does not know is left alone
  if (!rep.begun) return failStream(rep, 'the replay stream did not start with its hello');
  if (rep.endSeen) return; // nothing follows `end`
  if (f.name === 'run') {
    const problem = replayRunProblem(f.value, rep.runId);
    if (problem) return failStream(rep, problem);
  }
  if (f.name === 'end') rep.endSeen = true; // known at arrival, so the stream that closes after it is not cut short; the phase waits for the frame
  rep.queue.push(f.name, f.value);
}

// The replayed view starts from empty: the real run's views and log are cleared, and a read of the real run that is still out is
// dropped (the token), so nothing of the real run is drawn over the replay.
function beginReplayView(rep) {
  rep.shown = true; rep.begun = true;
  if (rep.phase === 'connecting') rep.phase = 'playing';
  state.sel++;
  state.run = null; state.drawn = new Set(); state.gotSnapshot = false; state.backlogError = null;
  state.expanded = new Set(); state.testsExpanded = false; state.errOpen = false;
  stopClock();
  closeDrawer();
  syncHover();
  state.log.reset(rep.runId); state.log.load([]); state.backlogSeq = 0;
  renderLogNotice();
  renderLogAll();
  for (const k of ['status', 'steps', 'roles', 'facts', 'lanes', 'rows', 'edges', 'counters', 'verdicts', 'tests', 'axis']) lists[k].clear();
  renderEmpty(REPLAY_WAITING);
  renderReplayControls();
}

// What the queue gives out, one frame at a time, at the time the frame is due. A replay that was left does nothing.
function applyReplayFrame(rep, name, value) {
  if (state.replay !== rep || rep.closed) return;
  try {
    if (name === 'event') applyReplayEvent(rep, value);
    else if (name === 'run') applyReplayRun(rep, value);
    else if (name === 'end') endReplay(rep);
    else if (name === 'fail') failReplay(rep, value);
    else if (name === 'cut') failReplay(rep, replayCutText(rep.count));
  } catch (err) {
    failReplay(rep, replayFailure({ error: err })); // an error inside a drawing is a line too, and the timer's chain goes on
  }
}

function applyReplayEvent(rep, ev) {
  const r = state.log.push(ev);
  if (r.status === 'gap') return failReplay(rep, `replay events are out of order (seq ${ev?.seq} after ${state.log.last})`);
  if (r.status !== 'added') return;
  rep.count += 1;
  appendLog(r.added);
  flashAgent(ev.agentId);
  if (ev.agentId && ev.agentId === state.hover) syncHover(true);
}

function applyReplayRun(rep, run) {
  state.gotSnapshot = true;
  applyRun(run);
}

function endReplay(rep) {
  rep.phase = 'ended';
  renderReplayControls();
}

// Pause stops the queue: frames that arrive are kept, in order, and none is applied. Resume plays the kept frames with the gaps they
// arrived with (never in one burst), each at its arrival time plus how far the pause put the view behind (nothing, when nothing was
// held back); while they play the button says Pause. Both stay
// usable until the queue has played its last frame (the end, or the failure line).
function togglePause() {
  const rep = state.replay;
  if (!rep) return;
  if (rep.phase === 'playing' || rep.phase === 'connecting') {
    rep.phase = 'paused';
    rep.queue.pause();
    holdFlashes();
  } else if (rep.phase === 'paused') {
    rep.phase = rep.begun ? 'playing' : 'connecting';
    releaseFlashes();
    rep.queue.resume();
  }
  renderReplayControls();
}

// Stop, also after the end: the stream is left and the real view of the run is read again.
function stopReplay() {
  const rep = dropReplay();
  if (!rep) return;
  renderReplayControls();
  selectRun(rep.runId);
}

// ---------- the tracking notice ----------
// A service notice, apart from the run: it is written once at load and by its own controls, and nothing the stream brings reaches it
// (it reads no run, no mode and no run list), so it is the same in every mode, with runs or without. Closing it is remembered; opening it
// again from the header writes nothing, so a reload shows it as the last close left it. Focus: opening takes it to the copy button,
// closing gives it back to the header button; the notice is not modal and has no focus trap.
const HINT_RESET_MS = 2000;
function setHintOpen(open) {
  setShown($('#hint'), open);
  $('#hint-open').setAttribute('aria-expanded', String(open));
}
function openHint() {
  setHintOpen(true);
  focusQuietly($('#hint-copy'));
}
function closeHint() {
  setHintOpen(false);
  localSet('hint.closed', '1');
  focusQuietly($('#hint-open'));
}
// A search hit of a run's own field is shown in a notice under the header (#search-hit), in the page's flow; this notice is absolute above the log
// and in a narrow window (375 px) it covers that one, so the hit's notice could not be read or closed. The hit is what the user just asked for, so
// this notice gives way: it is only hidden. It is not the user's own close (closeHint): nothing is stored, the focus stays where it is, and it is
// not opened again when the hit's notice goes, so a reload shows it as the user last left it.
function closeHintForHit() {
  setHintOpen(false);
}
// the button says what happened for 2 s; a second copy inside the 2 s starts the 2 s again (one timer, never two)
function setCopyStatus(status) {
  const btn = $('#hint-copy');
  setText(btn, copyLabel(status));
  clearTimeout(state.hintTimer);
  state.hintTimer = status === 'idle' ? null : setTimeout(() => { state.hintTimer = null; setText(btn, copyLabel('idle')); }, HINT_RESET_MS);
}
// The constant is copied, not the text of an element. Without navigator.clipboard the text is selected in the box and the document is
// asked to copy it. A clipboard that refuses (a rejected promise) or a copy command that fails or throws is a failure: the label says so and
// the text stays selected for the user to copy by hand; there is no second try on another path.
async function copyHint() {
  let ok = false;
  try {
    if (copyPath(typeof navigator === 'undefined' ? undefined : navigator) === 'clipboard') {
      await navigator.clipboard.writeText(TRACKING_PROMPT);
      ok = true;
    } else {
      selectAll($('#hint-text'));
      ok = document.execCommand?.('copy') === true;
    }
  } catch { ok = false; }
  if (!ok) selectAll($('#hint-text'));
  setCopyStatus(ok ? 'copied' : 'failed');
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  // the search results: a click outside the search box and its panel closes the panel (its text and results stay)
  if (state.search.open && !e.target.closest?.('#search')) closeSearchPanel();
  // the run picker: a click outside it closes it, a click in it opens it or chooses a row (the page's one outside-click listener)
  const inPicker = e.target.closest?.('#run-select');
  if (state.picker.open && !inPicker) setPickerOpen(false, { focus: false });
  if (inPicker) {
    const row = e.target.closest('[data-run]');
    if (row) chooseRun(row.dataset.run);
    else if (e.target.closest('#rp-trigger')) setPickerOpen(!state.picker.open);
    return;
  }
  const more = e.target.closest('[data-tests-toggle]');
  if (more) { // the tests card: the rest of the rows, or back to the last few
    state.testsExpanded = !state.testsExpanded;
    if (state.run) renderTests(state.run);
    return;
  }
  const u = e.target.closest('[data-unit]');
  if (u) { // a matrix row: show or hide its agents by round
    const unit = u.dataset.unit;
    if (state.expanded.has(unit)) state.expanded.delete(unit); else state.expanded.add(unit);
    if (state.run) renderView();
    return;
  }
  if (e.target.closest('[data-result]')) { // an item of the run result (a card, a row, the run total): its drawer shows the result, never an agent
    openResultDrawer();
    return;
  }
  const t = e.target.closest('[data-agent]');
  if (t && !t.classList.contains('empty')) openDrawer(t.dataset.agent);
  const v = e.target.closest('[data-view]');
  if (v) { state.view = v.dataset.view; localSet('view', state.view); renderView(); }
});
document.addEventListener('mousemove', (e) => { state.pointer = { x: e.clientX, y: e.clientY }; syncHover(); });
document.documentElement.addEventListener('mouseleave', () => { state.pointer = null; syncHover(); });
window.addEventListener('scroll', () => syncHover(), { passive: true, capture: true }); // the element under a still pointer changes
document.addEventListener('toggle', (e) => { if (e.target.classList?.contains('err-more')) state.errOpen = e.target.open; }, true);
$('#drawer-close').onclick = closeDrawer;
// Escape closes the picker first (the drawer stays); with the picker closed it closes the drawer
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.picker.open) setPickerOpen(false); else closeDrawer();
});
// the search box: typing asks (after the delay), the panel is the box's own, Esc inside it clears it before it is the page's
$('#search-input').addEventListener('input', (e) => onSearchInput(e.target.value));
$('#search-input').addEventListener('focus', onSearchFocus);
$('#search').addEventListener('keydown', onSearchKey);
$('#search-list').addEventListener('click', onSearchClick);
$('#search-hit-close').addEventListener('click', clearSearchHit);
$('#rp-trigger').addEventListener('keydown', onTriggerKey);
$('#rp-search').addEventListener('keydown', onPickerKey);
$('#rp-search').addEventListener('input', (e) => setFilter({ q: e.target.value }));
// the filters of the run history: each writes the hash and patches the rows (no timer: nothing here waits)
$('#rp-all').addEventListener('change', (e) => setFilter({ range: e.target.checked ? 'all' : '24h' }));
// a project or status is one of the list's own values: anything else typed is "all" again (and the field says so)
for (const [name, sel, key] of [['project', '#rp-project', 'projects'], ['status', '#rp-status', 'statuses']]) {
  $(sel).addEventListener('change', (e) => {
    const v = pickerFilterOptions(state.runs)[key].includes(e.target.value) ? e.target.value : null;
    setFilter({ [name]: v });
    if (e.target.value !== (v ?? '')) e.target.value = v ?? '';
  });
}
$('#rp-from').addEventListener('change', (e) => setFilter({ from: isCalendarDate(e.target.value) ? e.target.value : null }));
$('#rp-to').addEventListener('change', (e) => setFilter({ to: isCalendarDate(e.target.value) ? e.target.value : null }));
window.addEventListener('hashchange', onHashChange);
// Tab out of the picker closes it (a focus that goes nowhere, a click on a row or the window losing focus, does not)
$('#run-select').addEventListener('focusout', (e) => {
  if (state.picker.open && e.relatedTarget && !$('#run-select').contains(e.relatedTarget)) setPickerOpen(false, { focus: false });
});
$('#weak-toggle').onchange = (e) => { state.weak = e.target.checked; if (state.view === 'timeline' && state.run) renderTimeline(state.run); };
$('#log-toggle').onclick = () => setLogCollapsed(!$('#log-pane').classList.contains('collapsed'));
for (const [id, kind] of [['#handle-left', 'left'], ['#handle-right', 'right'], ['#handle-log', 'log']]) {
  $(id).addEventListener('pointerdown', (e) => startDrag(kind, e));
  $(id).addEventListener('dblclick', () => resetSize(kind));
}
window.addEventListener('resize', () => { applyLayout(); scheduleEdges(); });
// the edges are measured from the bars: drawn again when the timeline changes size (a dragged column, the window)
if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleEdges).observe($('#view-timeline'));
// the replay control: its buttons have listeners of their own
renderReplaySpeed();
for (const n of REPLAY_SPEEDS) $(`#replay-s${n}`).addEventListener('click', () => chooseReplaySpeed(n));
$('#replay-go').addEventListener('click', startReplay);
$('#replay-pause').addEventListener('click', togglePause);
$('#replay-stop').addEventListener('click', stopReplay);
window.addEventListener('pagehide', () => { dropReplay(); }); // the page goes away: no replay keeps a timer or a stream
loadLayout();
setLogCollapsed(localGet('logCollapsed') === '1');
// the tracking notice: its text and its state are set here once; the listeners are on its own elements (Escape inside it closes it and
// goes no further, so the page's Escape does not also close the drawer or the run picker)
$('#hint-text').value = TRACKING_PROMPT;
setHintOpen(hintInitiallyOpen(localGet('hint.closed')));
$('#hint-open').addEventListener('click', openHint);
$('#hint-close').addEventListener('click', closeHint);
$('#hint-copy').addEventListener('click', () => { copyHint(); });
$('#hint').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeHint();
});

renderRunPicker();
loadRuns(); connect();
