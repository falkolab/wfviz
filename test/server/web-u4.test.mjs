// test/server/web-u4.test.mjs (node web-polish): the polish of the page. The pure decisions are in web/lib.js and are tested here with
// plain data. The page has no test runner of its own, so app.js itself runs on a small fake browser built below: the real
// index.html parsed into elements that keep what is written to them and count every write (an attribute, a class, a style property,
// a text, an innerHTML, a move), html written to an element is kept as nodes (elements and text nodes, as a browser keeps it) and can
// be patched node by node, every node made, removed or moved is recorded like a MutationObserver's records, a fetch that answers from
// a table, an event stream that a test pushes into, timers that are only recorded. Nothing of the page code is changed for the test.
// What cannot be seen without painting or layout (how a scrollbar, the dropdown or a focus ring looks, where the dropdown stands in a
// narrow window) is not checked here: the dropdown's place is held by its css rule (a test reads it) and was measured in headless
// Chrome (rects and the page's scroll offset at 400 to 1920 px).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lib from '../../web/lib.js';
import { createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { buildSchedule, locateRun } from '../../src/source/replay.mjs';
import { test } from './helpers.mjs';

const {
  countEvents, createEventLog, elapsedFact, clockTick, filterRunRows, groupHeading, logHeader, logOrder, markSegments, mergeRun, mergeRunList, modeInfo,
  orderOfAppearance, pickerRow, prependItems, runStatusClass, slotVar, specOf, keyOf, summaryOfRun, testsView, createListState, sortByShownTime,
  morphHtml, scrollToShow,
} = lib;
const parseFragment = lib.parseHtml; // the page's own html as data (the test has its own parseHtml for index.html)

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
    id: 'wf_x', source: 'real', name: reg('a run'), status: { value: 'running', prov: 'inferred', method: 'no-final-file' }, startedAt: inf(1000), durationMs: unk('run is still running'),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])), order: agents.map((a) => a.id), recognized: { findings: [], verdicts: [], tests: [] }, totals: { agents: agents.length, running: 0, done: 0, failed: 0 },
    ...over,
  };
}
const uev = (seq, over = {}) => ({ runId: 'wf_x', seq, ts: 9000 + seq, kind: 'agent.activity', agentId: 'a1', label: 'x:y', message: `m${seq}`, prov: 'registered', ...over });

// =====================================================================================================================
// the pure part (web/lib.js)
// =====================================================================================================================

// ---- the mode of the server (the REPLAY banner) -------------------------------------------------------------------

test('mode: real, demo and replay are told apart; a mode the page does not know is "?", never REAL, and its text is not a class name', () => {
  assert.deepEqual(modeInfo('real'), { text: 'REAL', cls: 'real', banner: null, title: 'wfviz', known: true });
  assert.deepEqual(modeInfo('demo'), { text: 'DEMO', cls: 'demo', banner: 'demo', title: 'wfviz — DEMO', known: true });
  assert.deepEqual(modeInfo('replay'), { text: 'REPLAY', cls: 'replay', banner: 'replay', title: 'wfviz — REPLAY', known: true });
  for (const odd of [undefined, null, '', 'Replay', 'live', 'real demo', 'constructor', '__proto__', 'toString', 7, {}]) {
    const m = modeInfo(odd);
    assert.deepEqual([m.text, m.cls, m.banner, m.title, m.known], ['?', 'unknown', null, 'wfviz', false], String(odd));
  }
});

// ---- the log: events are counted, markers are not -------------------------------------------------------------------

const ev = (seq, runId = 'wf_a') => ({ runId, seq, ts: 1000 + seq, kind: 'agent.activity', message: `m${seq}`, prov: 'registered' });
// a log with one marker of missing events: 1..from-1, then a live event `to` + 1 that the server cannot fill the gap before
function logWithMarker({ before, missing, cap }) {
  const log = createEventLog({ cap });
  log.reset('wf_a');
  log.load(Array.from({ length: before }, (_, i) => ev(i + 1)));
  log.push(ev(before + missing + 1));
  log.load([]);
  log.load([]);
  return log;
}

test('log cap: only event lines count, the marker of missing events does not (seq 1-2060 with 100-109 missing: the last 2000 events, "of 2060")', () => {
  const log = logWithMarker({ before: 99, missing: 10, cap: 2000 });
  assert.deepEqual(log.lines.filter((x) => x.missing !== undefined), [{ missing: 10, from: 100, to: 109 }], 'one marker');
  for (let i = 111; i <= 2060; i++) assert.equal(log.push(ev(i)).status, 'added');
  assert.equal(log.maxSeen, 2060);
  assert.equal(countEvents(log.lines), 2000, 'the cap is reached on 2000 event lines');
  assert.equal(log.eventCount, 2000);
  assert.equal(log.lines.length, 2001, 'the marker is a line besides them');
  assert.equal(logHeader({ shown: log.eventCount, cap: 2000, maxSeq: log.maxSeen }), 'showing the last 2000 of 2060 events');
  assert.equal(log.lines.filter((x) => x.missing !== undefined).length, 1, 'the marker is still inside the 2000 events');
  assert.equal(log.lines[0].seq, 51, 'the oldest 50 of the 2050 events went');
});

test('log header: below the cap it is the number of events, not of lines', () => {
  const log = logWithMarker({ before: 1989, missing: 5, cap: 2000 }); // 1989 events, a marker, then seq 1995
  assert.equal(log.eventCount, 1990);
  assert.equal(log.lines.length, 1991);
  assert.equal(logHeader({ shown: log.eventCount, cap: 2000, maxSeq: log.maxSeen }), '1990');
  assert.equal(countEvents(log.lines), 1990);
  assert.equal(countEvents(null), 0);
});

test('log cap: a marker that is left with no event before it goes with the events the cap drops; one inside the window stays', () => {
  const log = createEventLog({ cap: 3 });
  log.reset('wf_a');
  log.load([ev(1), ev(2)]);
  log.push(ev(5));
  log.load([]);
  log.load([]);
  assert.deepEqual(log.lines.map((x) => x.seq ?? `missing:${x.from}`), [1, 2, 'missing:3', 5]);
  log.push(ev(6));
  assert.deepEqual(log.lines.map((x) => x.seq ?? `missing:${x.from}`), [2, 'missing:3', 5, 6], 'three events and the marker between them');
  log.push(ev(7));
  assert.deepEqual(log.lines.map((x) => x.seq ?? `missing:${x.from}`), [5, 6, 7], 'the marker had no event before it any more: it went');
  assert.equal(log.eventCount, 3);
  // a marker at the very start of a log (the backlog began after seq 1, nothing was dropped) stays: it says what is missing
  const first = createEventLog({ cap: 3 });
  first.reset('wf_a');
  first.push(ev(5));
  first.load([]);
  first.load([]);
  assert.deepEqual(first.lines.map((x) => x.seq ?? `missing:${x.from}-${x.to}`), ['missing:1-4', 5]);
  assert.equal(first.eventCount, 1);
  first.reset('wf_b');
  assert.equal(first.eventCount, 0);
});

// ---- the elapsed time: own times for a replay and a final run, the clock for a live run of source real ------------------

// a run as the model reads it from a saved run: the agents' own times are 13 s apart; the events of its journal carry the file time,
// which is 18.6 minutes later (measured on wf_6509ce25-20a). The page must not use the time of an event as the end of the run.
const FILE_TIME = 1794127828009;
function savedRun(over = {}) {
  return run([
    agent('r1', 'reviewer:A', { startedAt: reg(1794126711299), endedAt: reg(1794126713181), state: reg('done') }),
    agent('f2', 'fixer:round2', { startedAt: reg(1794126722215), endedAt: reg(1794126724683), state: reg('done') }),
  ], { source: 'replay', startedAt: inf(1794126711269, 'earliest-agent-start'), durationMs: unk('run is still running'), ...over });
}

test('elapsed, replay: the run\'s own time, its end (else the latest time the Run records) minus its start; the file time of an event is not used', () => {
  const r = savedRun();
  const f = elapsedFact(r, 5);
  assert.equal(f.prov, 'inferred');
  assert.equal(f.value, 1794126724683 - 1794126711269, 'latest recorded time (the end of fixer:round2) minus the start');
  assert.match(f.method, /the latest time the run records minus the run start \(inferred, earliest-agent-start\)/);
  // the same whatever the clock says: no Date.now()
  assert.deepEqual(elapsedFact(r, 1), elapsedFact(r, 9e15));
  // the events carry a file time 18.6 minutes after the run; they are not in the Run, and a Run that has them as an agent record is not read from them
  assert.ok(FILE_TIME - 1794126724683 > 1.1e6);
  // the end of the run, when the Run has it, wins over the latest time
  const ended = savedRun({ endedAt: reg(1794126730000, 'wf.json#endTime') });
  assert.equal(elapsedFact(ended, 5).value, 1794126730000 - 1794126711269);
  assert.match(elapsedFact(ended, 5).method, /^the run end \(registered, wf\.json#endTime\) minus the run start/);
  // the Run's own duration (the final file) wins over both
  const own = fin(13408, 'wf.json#durationMs');
  assert.equal(elapsedFact(savedRun({ durationMs: own, status: fin('completed') }), 5), own);
  // nothing recorded: the Run's unknown Fact, with its reason, not a number made up
  const empty = run([], { source: 'replay', startedAt: inf(1000), durationMs: unk('run is still running') });
  assert.equal(elapsedFact(empty, 5), empty.durationMs);
  const noStart = savedRun({ startedAt: unk('nothing yet') });
  assert.equal(elapsedFact(noStart, 5), noStart.durationMs);
  // a time before the start says nothing
  assert.equal(elapsedFact(savedRun({ startedAt: inf(1794126730000) }), 5).prov, 'unknown');
});

test('elapsed, final run: with no duration of its own the run\'s times give it; with no end it stays the Run\'s unknown Fact', () => {
  const done = savedRun({ source: 'real', status: fin('completed'), endedAt: reg(1794126724683), durationMs: unk('final file has no durationMs') });
  assert.equal(elapsedFact(done, 5).value, 1794126724683 - 1794126711269);
  assert.equal(elapsedFact(done, 9e15).value, 1794126724683 - 1794126711269, 'not now minus the start');
  const noEnd = run([], { status: fin('killed'), durationMs: unk('x'), startedAt: inf(1000) });
  assert.equal(elapsedFact(noEnd, 9e15), noEnd.durationMs);
});

test('elapsed and clock: only a running run of source real ticks; a replay, a demo run, a final run and an unknown source do not', () => {
  const NOW = 100000;
  const base = { durationMs: unk('run is still running'), startedAt: inf(40000, 'script-file-time'), status: { value: 'running', prov: 'inferred', method: 'no-final-file' } };
  const mk = (source) => run([], { ...base, source });
  assert.equal(clockTick(mk('real'), NOW), 60000);
  assert.equal(clockTick(mk('real'), NOW + 1000), 61000);
  for (const source of ['demo', 'replay', 'something-new']) assert.equal(clockTick(mk(source), NOW), null, source);
  assert.equal(clockTick(run([], { ...base, source: 'real', status: fin('completed'), durationMs: fin(5000) }), NOW), null, 'final');
  assert.equal(clockTick(run([], { ...base, source: 'real', status: fin('killed') }), NOW), null, 'final without a duration');
  // a demo run is still shown as now minus its start (its times are on the clock of now), it is only not counted between snapshots
  assert.equal(elapsedFact(mk('demo'), NOW).value, 60000);
  assert.equal(elapsedFact(mk('real'), NOW).value, 60000);
  // an unlisted source is not on the clock of now: the Run's unknown Fact
  assert.equal(elapsedFact(mk('something-new'), NOW), base.durationMs);
});

// ---- colour slots: nothing named after a role ----------------------------------------------------------------------

test('slots: a role takes the slot of its place in the order of first appearance, past the ninth the colours come round, what has no place is --other', () => {
  const order = orderOfAppearance(['writer', 'checker', 'writer', null, undefined, 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10']);
  assert.deepEqual(order, ['writer', 'checker', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10']);
  assert.equal(slotVar(order, 'writer'), '--c1');
  assert.equal(slotVar(order, 'checker'), '--c2');
  assert.equal(slotVar(order, 'x9'), '--c9');
  assert.equal(slotVar(order, 'x10'), '--c1', 'the tenth role shares the first colour');
  assert.equal(slotVar(order, 'unseen'), '--other');
  assert.equal(slotVar(order, undefined), '--other');
  assert.equal(slotVar(null, 'writer'), '--other');
  // the colour depends on the order only: the same names in another order are given the slots the other way round
  assert.equal(slotVar(['checker', 'writer'], 'writer'), '--c2');
  // a number or a value with spaces is a value like any other
  assert.equal(slotVar(orderOfAppearance(['not ok', 'ok']), 'ok'), '--c2');
});

test('verdict status class: a fixed class for the statuses the page styles, none for any other text (and none for a name on Object.prototype)', () => {
  assert.deepEqual(['running', 'completed', 'failed', 'killed', 'stale', '', '__proto__', 'constructor'].map(runStatusClass), ['running', 'pass', 'fail', 'killed', '', '', '', '']);
});

// ---- the round history heading -----------------------------------------------------------------------------------

test('round heading: a group with neither round nor tag is "round unknown" once; a tag group keeps its note; a known round has none', () => {
  const groups = lib.roundHistory([
    agent('a', 'w:U', { round: reg(2), startedAt: inf(1) }),
    agent('b', 'w:U#r1', { startedAt: inf(2) }),
    agent('c', 'w:U', { startedAt: inf(3) }),
  ]);
  const headings = groups.map(groupHeading);
  assert.deepEqual(headings, [
    { title: 'round 2', note: null },
    { title: '#r1', note: 'round unknown' },
    { title: 'round unknown', note: null },
  ]);
  // the heading as the page writes it has the words once
  for (const [g, h] of groups.map((x) => [x, groupHeading(x)])) {
    const text = `${g.title}${h.note ? ` ${h.note}` : ''}`;
    assert.ok(text.split('round unknown').length <= 2, text);
  }
  assert.equal(groups[2].title, 'round unknown', 'roundHistory is unchanged');
});

// ---- the run picker: rows, search, the live list ------------------------------------------------------------------------

test('picker row: every value comes from the list item; one the item does not have is null with its reason, never 0 and never the mode of the page', () => {
  const full = pickerRow({ id: 'wf_1', name: reg('my run'), status: fin('completed'), startedAt: inf(1700000000000), agents: 5, running: 0, source: 'replay' });
  assert.deepEqual([full.id, full.name, full.status, full.startedAt, full.agents, full.source], ['wf_1', 'my run', 'completed', 1700000000000, 5, 'replay']);
  const bare = pickerRow({ id: 'wf_2', name: unk('no script meta'), status: undefined });
  assert.deepEqual([bare.name, bare.status, bare.startedAt, bare.agents, bare.source], [null, null, null, null, null]);
  assert.equal(bare.nameReason, 'no script meta');
  assert.match(bare.statusReason, /no status/);
  assert.match(bare.startedReason, /no start time/);
  // 0 agents is a number the list gave; a missing or odd count is not 0
  assert.equal(pickerRow({ id: 'wf_3', agents: 0 }).agents, 0);
  for (const odd of [undefined, null, '5', -1, 2.5, NaN]) assert.equal(pickerRow({ id: 'wf_3', agents: odd }).agents, null, String(odd));
  assert.equal(pickerRow({ id: 'wf_3', source: '' }).source, null);
  assert.equal(pickerRow(null).id, '');
});

test('search marks: case-insensitive, every occurrence, never a pattern, never HTML; the pieces always make the whole text', () => {
  const texts = (segs) => segs.map((x) => x.text).join('');
  assert.deepEqual(markSegments('Alpha beta ALPHA', 'alpha'), [{ text: 'Alpha', hit: true }, { text: ' beta ', hit: false }, { text: 'ALPHA', hit: true }]);
  assert.deepEqual(markSegments('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(markSegments('abc', '   '), [{ text: 'abc', hit: false }], 'a query of spaces is no query');
  assert.deepEqual(markSegments('abc', ' b '), [{ text: 'a', hit: false }, { text: 'b', hit: true }, { text: 'c', hit: false }], 'the query is trimmed');
  assert.deepEqual(markSegments('', 'x'), []);
  assert.deepEqual(markSegments('abc', 'zzz'), [{ text: 'abc', hit: false }]);
  // the query is text: a pattern character does not mean anything
  assert.deepEqual(markSegments('a.b a*b', '.*'), [{ text: 'a.b a*b', hit: false }]);
  assert.deepEqual(markSegments('a.b a*b', 'a.'), [{ text: 'a.', hit: true }, { text: 'b a*b', hit: false }]);
  assert.deepEqual(markSegments('x[y]z', '[y]'), [{ text: 'x', hit: false }, { text: '[y]', hit: true }, { text: 'z', hit: false }]);
  // the text is the pieces' text as it is: markup in a name is not touched here (the page escapes every piece)
  assert.deepEqual(markSegments('<b>x</b>', 'b>x'), [{ text: '<', hit: false }, { text: 'b>x', hit: true }, { text: '</b>', hit: false }]);
  // adjacent matches
  assert.deepEqual(markSegments('aaaa', 'aa'), [{ text: 'aaaa', hit: true }], 'two touching hits are one mark');
  assert.deepEqual(markSegments('aaaaa', 'aa'), [{ text: 'aaaa', hit: true }, { text: 'a', hit: false }]);
});

test('search marks: a letter that changes its length when lowered does not shift the marks (\'İ\' lowers to two units)', () => {
  assert.equal('İ'.toLowerCase().length, 2, 'the premise');
  const texts = (segs) => segs.map((x) => x.text).join('');
  const t = 'İstanbul İzmir';
  const m = markSegments(t, 'stan');
  assert.deepEqual(m, [{ text: 'İ', hit: false }, { text: 'stan', hit: true }, { text: 'bul İzmir', hit: false }], 'the marks are on "stan", not on "tanb"');
  assert.equal(texts(m), t);
  // a match that starts inside the lowered letter takes the whole letter, never half of it
  assert.deepEqual(markSegments('İz', 'i'), [{ text: 'İ', hit: true }, { text: 'z', hit: false }]);
  assert.deepEqual(markSegments(t, 'İzmir').map((x) => [x.text, x.hit]), [['İstanbul ', false], ['İzmir', true]]);
  assert.deepEqual(markSegments('İ', 'İ'), [{ text: 'İ', hit: true }]);
  assert.deepEqual(markSegments(t, 'izmir').map((x) => x.hit), [false], 'a plain i is not the lowered İ followed by its dot: no match, and no shifted one');
  assert.equal(texts(markSegments('xİİy', 'iy')), 'xİİy');
  // a character outside the BMP is one character
  const s = 'a😀b😀c';
  assert.deepEqual(markSegments(s, '😀b'), [{ text: 'a', hit: false }, { text: '😀b', hit: true }, { text: '😀c', hit: false }]);
  for (const q of ['a', 'b', 'c', '😀', 'ı', 'ß', 'ǅ']) assert.equal(texts(markSegments('Aß😀ıǅbc', q)), 'Aß😀ıǅbc', q);
});

test('search: rows are filtered by name and by id, case-insensitive; "(no name)" is a placeholder and never matches; an empty query is every row', () => {
  const rows = [
    pickerRow({ id: 'wf_alpha-01', name: reg('Review Loop') }),
    pickerRow({ id: 'wf_beta-02', name: unk('no meta') }),
    pickerRow({ id: 'wf_gamma-03', name: reg('other thing') }),
    pickerRow({ id: 'wf_with name-4', name: unk('x') }),
  ];
  const ids = (q) => filterRunRows(rows, q).map((m) => m.row.id);
  assert.deepEqual(ids(''), rows.map((r) => r.id));
  assert.deepEqual(ids('   '), rows.map((r) => r.id));
  assert.deepEqual(ids('review'), ['wf_alpha-01'], 'by name, any case');
  assert.deepEqual(ids('LOOP'), ['wf_alpha-01']);
  assert.deepEqual(ids('beta'), ['wf_beta-02'], 'by id, for a run that has no name');
  assert.deepEqual(ids('wf_'), rows.map((r) => r.id), 'every id has it');
  assert.deepEqual(ids('02'), ['wf_beta-02']);
  assert.deepEqual(ids('no name'), [], '"(no name)" is not the name of a run');
  assert.deepEqual(ids('(no'), []);
  assert.deepEqual(ids('name'), ['wf_with name-4'], 'only the id that has the word, not the nameless rows');
  assert.deepEqual(ids('nothing like it'), []);
  const [m] = filterRunRows(rows, 'LOOP');
  assert.deepEqual(m.nameSegs, [{ text: 'Review ', hit: false }, { text: 'Loop', hit: true }]);
  assert.deepEqual(m.idSegs, [{ text: 'wf_alpha-01', hit: false }]);
  assert.equal(filterRunRows(rows, 'beta')[0].nameSegs, null, 'a run with no name has no name pieces');
  assert.deepEqual(filterRunRows(null, 'x'), []);
});

test('live list: a snapshot is a list item with the fields it has; a known run keeps its place and takes the new fields; a new run goes first', () => {
  const snap = run([agent('a', 'x:y')], { id: 'wf_n', name: reg('new'), status: fin('completed'), project: '/p', totals: { agents: 3, running: 1, done: 2, failed: 0 } });
  const s = summaryOfRun(snap);
  assert.deepEqual(Object.keys(s).sort(), ['agents', 'id', 'loaded', 'name', 'project', 'running', 'source', 'startedAt', 'status']);
  assert.equal(s.agents, 3);
  assert.equal(s.loaded, true, 'a snapshot exists only for a run that is loaded');
  // a snapshot with no totals and no project leaves those fields out, so an older row keeps what it knew
  const partial = summaryOfRun({ id: 'wf_p', status: reg('running') });
  assert.deepEqual(partial, { id: 'wf_p', status: reg('running'), loaded: true });
  const list = [{ id: 'wf_1', name: reg('a'), status: reg('running'), agents: 2, source: 'real' }, { id: 'wf_2', name: reg('b'), status: reg('running'), agents: 1, source: 'real' }];
  const merged = mergeRun(list, { id: 'wf_1', status: fin('completed') });
  assert.deepEqual(merged.map((r) => r.id), ['wf_1', 'wf_2'], 'a change of status does not reorder the rows');
  assert.deepEqual(merged[0], { id: 'wf_1', name: reg('a'), status: fin('completed'), agents: 2, source: 'real' }, 'the fields the snapshot did not have stay');
  assert.deepEqual(mergeRun([{ id: 'wf_1', loaded: false }], summaryOfRun(snap)).find((r) => r.id === 'wf_1'), { id: 'wf_1', loaded: false }, 'another run: untouched');
  assert.equal(mergeRun([{ id: 'wf_n', loaded: false }], s)[0].loaded, true, 'a run that was only listed is loaded once its snapshot comes');
  assert.deepEqual(list[0].status, reg('running'), 'the list that was given is not changed');
  assert.deepEqual(mergeRun(list, { id: 'wf_3', source: 'demo' }).map((r) => r.id), ['wf_3', 'wf_1', 'wf_2'], 'a new run is the newest: first');
  assert.deepEqual(mergeRun(null, { id: 'wf_3' }), [{ id: 'wf_3' }]);
});

test('live list: the answer of GET /api/runs does not drop a run that only the stream told of meanwhile, and the stream is newer for the runs it touched', () => {
  const fetched = [{ id: 'wf_1', status: reg('running'), name: reg('one') }, { id: 'wf_2', status: reg('running'), name: reg('two') }];
  const current = [{ id: 'wf_9', status: reg('running') }, { id: 'wf_1', status: fin('completed') }];
  const out = mergeRunList(fetched, current, new Set(['wf_9', 'wf_1']));
  assert.deepEqual(out.map((r) => r.id), ['wf_9', 'wf_1', 'wf_2'], 'the run only the stream knew is kept, first');
  assert.deepEqual(out[1], { id: 'wf_1', status: fin('completed'), name: reg('one') }, 'the stream is newer for a run it touched; the answer fills in the rest');
  assert.deepEqual(mergeRunList(fetched, current, new Set()).find((r) => r.id === 'wf_1').status, reg('running'), 'a run the stream did not touch is as the answer says');
  // replay: GET /api/runs is [] until the first page connects; the run arrives only by the stream
  assert.deepEqual(mergeRunList([], [{ id: 'wf_r' }], new Set(['wf_r'])), [{ id: 'wf_r' }]);
  assert.deepEqual(mergeRunList(null, null), []);
});

// ---- the tests card: hidden rows ---------------------------------------------------------------------------------------

test('tests view: "showing N of M" when the card shows fewer rows than the run has; the rest on offer; M is every recognised result', () => {
  const tests = Array.from({ length: 12 }, (_, i) => ({ agentId: 'a', path: '$', passed: i, failed: 0, skipped: 0 }));
  const r = run([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests } });
  const v = testsView(r);
  assert.deepEqual([v.rows.length, v.shown, v.total, v.hidden, v.canCollapse], [8, 8, 12, 4, false]);
  assert.deepEqual(v.rows.map((x) => x.k), [12, 11, 10, 9, 8, 7, 6, 5], 'newest first, "summary k of n" is as testRows has it');
  const all = testsView(r, { expanded: true });
  assert.deepEqual([all.rows.length, all.shown, all.total, all.hidden, all.canCollapse], [12, 12, 12, 0, true]);
  assert.deepEqual(all.rows.slice(0, 8).map((x) => x.key), v.rows.map((x) => x.key), 'the rows that were shown keep their keys');
  assert.deepEqual(all.rows.map((x) => x.k), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  // few rows: nothing hidden, nothing to offer
  const few = testsView(run([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests: tests.slice(0, 3) } }), { expanded: true });
  assert.deepEqual([few.shown, few.total, few.hidden, few.canCollapse], [3, 3, 0, false]);
  assert.deepEqual(testsView(null), { rows: [], shown: 0, total: 0, hidden: 0, canCollapse: false });
});

// ---- lib helpers ---------------------------------------------------------------------------------------------------------

test('prependItems: new items go before the first one in the order given, nothing else is touched; a key twice throws', () => {
  const parent = { children: [], insertBefore(node, ref) { this.children.splice(ref === null ? this.children.length : this.children.indexOf(ref), 0, node); return node; } };
  const st = createListState();
  const make = (item) => ({ id: item.key });
  const a = specOf('a'); const b = specOf('b'); const n = specOf('n'); const m = specOf('m');
  prependItems(parent, st, [a], { create: make });
  prependItems(parent, st, [b], { create: make });
  assert.deepEqual(parent.children.map((c) => c.id), ['b', 'a']);
  prependItems(parent, st, [n, m], { create: make });
  assert.deepEqual(parent.children.map((c) => c.id), ['n', 'm', 'b', 'a']);
  assert.deepEqual(st.items.map((i) => i.key), ['n', 'm', 'b', 'a']);
  assert.throws(() => prependItems(parent, st, [specOf('a')], { create: make }), /duplicate key/);
  assert.deepEqual(parent.children.map((c) => c.id), ['n', 'm', 'b', 'a']);
});

// =====================================================================================================================
// the fake browser: the real index.html as elements that count their writes, and app.js running on it
// =====================================================================================================================

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
    Object.assign(this, { _hidden: false, value: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0, clientWidth: 0, offsetWidth: 0, offsetHeight: 0, scrolledIntoView: 0 });
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
    const ev = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (let n = this; n; n = n.parentNode) {
      ev.currentTarget = n;
      for (const fn of [...(n.listeners[type] || [])]) fn(ev);
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

// opts: runs (the list), runDocs (id -> Run), events (id -> UiEvent[], what the backlog answers), width, height, storage
async function bootPage({ runs = [], runDocs = {}, events = {}, width = 1228, height = 800, storage = {}, failEvents = null, hash = '', answer = null } = {}) {
  const saved = Object.fromEntries(GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  const doc = { listeners: {}, title: 'wfviz', activeElement: null };
  const html = parseHtml(doc, read('index.html'));
  const body = html.querySelector('body');
  Object.assign(doc, {
    documentElement: new El(doc, 'html'), body, html,
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    createElement: (t) => new El(doc, t), createElementNS: (ns, t) => new El(doc, t, ns), createTextNode: (d) => new TextNode(doc, d),
    mut: null,
    note: recorder(doc),
    addEventListener: (t, fn) => { (doc.listeners[t] ||= []).push(fn); }, elementFromPoint: () => null,
    blurIfInside(node) { if (doc.activeElement && node.contains(doc.activeElement)) doc.activeElement = null; },
  });
  html.querySelector('.grid').clientWidth = width;
  const timers = { intervals: new Map(), timeouts: new Map(), n: 0 };
  const windowListeners = {};
  const page = {
    doc, timers, storage, requests: [], es: null, root: doc.documentElement, runs, runDocs, events, failEvents, answer, windowListeners,
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
  setGlobal('fetch', async (url) => {
    const u = String(url);
    page.requests.push(u);
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
    await import(`../../web/app.js?u4=${++bootCount}`);
    await page.flush();
    page.emit('hello', { mode: 'real', version: '1' });
    await page.flush();
  } catch (err) {
    page.restore();
    throw err;
  }
  return page;
}

// every element below the static regions of the page, to count writes and to see what was made
const REGIONS = ['#run-status', '#steps', '#roles', '#facts', '#matrix-grid', '#matrix-fallback', '#lanes', '#tl-rows', '#tl-edges', '#tl-axis', '#counters', '#verdicts', '#tests', '#report', '#log', '#drawer-body', '#rp-cur', '#rp-list'];
function allEls(page, regions = REGIONS) {
  const out = [];
  const walk = (n) => { out.push(n); n.childNodes.forEach(walk); };
  for (const r of regions) { const e = page.doc.querySelector(r); if (e) walk(e); }
  return out;
}
const writesOf = (els) => new Map(els.map((e) => [e, e.writes]));
const changed = (before, els) => els.filter((e) => e.writes !== (before.get(e) ?? 0));

const summary = (r) => ({ id: r.id, name: r.name, status: r.status, project: null, startedAt: r.startedAt, agents: r.totals.agents, running: r.totals.running, source: r.source });
const textOf = (e) => e.html || e.text;
const logSeqs = (page) => page.el('#log').childNodes.map((c) => c.attrs.get('data-seq')).map(Number);

// =====================================================================================================================
// the page on the fake browser
// =====================================================================================================================

test('the fake browser itself: index.html is parsed with its nesting, ids, classes and hidden flags; selectors and closest work', async () => {
  const page = await bootPage();
  try {
    assert.equal(page.el('#rp-trigger').parentNode, page.el('#run-select'));
    assert.ok(page.el('#run-select').contains(page.el('#rp-search')));
    assert.equal(page.el('#rp-search').closest('#run-select'), page.el('#run-select'));
    assert.equal(page.el('#log-toggle .chev').tag, 'span');
    assert.ok(page.el('#replay-banner'));
    assert.equal(page.el('#rp-panel').hidden, true, 'the dropdown starts closed');
  } finally {
    page.restore();
  }
});

// ---- the stream of a saved run (the fixture), as the server would send it -----------------------------------------------------

const FIXTURE_ROOT = path.join(REPO, 'fixtures', 'claude-projects');
const FIXTURE_RUN = 'wf_6509ce25-20a';
// the raw events of the fixture run in the order a replay emits them, played into a real store: after every event the UiEvent and the
// snapshot of the Run, the pair a page receives
async function fixtureStream({ now = () => 1794130000000, source = 'replay' } = {}) {
  const where = await locateRun({ target: FIXTURE_RUN, root: FIXTURE_ROOT });
  const rawEvents = await readRunDir(where.sessionDir, where.runId);
  const raw = buildSchedule(rawEvents, 1).map((x) => ({ ...x.event, src: source }));
  const store = createStore({ now, staleMs: Infinity });
  const uis = [];
  store.onEvent((e) => uis.push(e));
  return {
    raw, store, uis,
    apply(i) { const before = uis.length; store.apply(raw[i]); return { ui: uis.slice(before), run: structuredClone(store.getRun(FIXTURE_RUN)) }; },
  };
}

// What an event may write besides the elements of its agent: the counters and summaries that count it (the stats, the steps and the
// roles, the facts, the heads of the matrix and of a lane, the axis, the cards of tests and findings)
const COUNTER_LIKE = '.stat, .step, .role, .counter, .mhead, .mrow-label, .fb-head, .fallback, .matrix, .hist-group, .lane, .tl-axis, .tests-row, .fcard, dl, dd, .report';

async function flickerCase(view, { expandUnits = false } = {}) {
  const fx = await fixtureStream();
  const FIRST = 8;
  for (let i = 0; i < FIRST; i++) fx.apply(i);
  const run0 = structuredClone(fx.store.getRun(FIXTURE_RUN));
  const page = await bootPage({ storage: { 'wfviz.view': view }, runs: fx.store.listRuns(), runDocs: { [FIXTURE_RUN]: run0 }, events: { [FIXTURE_RUN]: fx.uis.slice() } });
  try {
    assert.equal(page.el('#log').childNodes.length, fx.uis.length, 'the backlog is in the log');
    const shown = { matrix: '#matrix-grid', phases: '#lanes', timeline: '#tl-rows' }[view];
    assert.ok(page.el(shown).childNodes.length > 0, `${view} is drawn before the first event`);
    if (expandUnits) {
      for (const b of allEls(page).filter((e) => e.tag === 'button' && e.attrs.has('data-unit'))) await page.click(b);
      assert.ok(page.el('#matrix-grid').querySelectorAll('.hist').length > 0, 'a unit history is open');
    }
    const report = [];
    for (let i = FIRST; i < fx.raw.length; i++) {
      const { ui, run } = fx.apply(i);
      const before = allEls(page);
      const beforeWrites = writesOf(before);
      const beforeSet = new Set(before);
      for (const e of ui) page.emit('event', e);
      page.emit('run', run);
      await page.flush();
      const after = allEls(page);
      const afterSet = new Set(after);
      const touched = changed(beforeWrites, after.filter((e) => beforeSet.has(e)));
      const made = after.filter((e) => !beforeSet.has(e));
      const gone = before.filter((e) => !afterSet.has(e));
      const agentId = ui[0]?.agentId ?? null;
      const owner = (e) => e.closest('[data-agent]')?.attrs.get('data-agent') ?? null;
      report.push({ i, kind: fx.raw[i].kind, agentId, touched: touched.map((e) => `${e.tag}.${[...e.classes].join('.')}`), made: made.length, gone: gone.length });
      // no region was rewritten as a string
      for (const r of REGIONS) assert.equal(page.el(r).htmlWrites, 0, `${r} was not rewritten whole (event ${i}, ${view})`);
      // The end-of-run file (run.final) is an event of the run, not of an agent: it brings the final Facts of every agent, so every
      // agent's elements may change then; they are still the same elements.
      const runLevel = agentId === null;
      for (const e of touched) {
        const who = owner(e);
        const what = `${e.tag}.${[...e.classes]}`;
        if (who === agentId || runLevel) continue;
        if (who !== null) {
          // the bar and the row label of the timeline are placed by the scale of the axis, which an event can move
          if (e.closest('.tl-row')) continue;
          assert.fail(`event ${i} (${fx.raw[i].kind} of ${agentId}, ${view}) wrote an element of ${who}: ${what}`);
        }
        assert.ok(e.closest(COUNTER_LIKE) || e.id === 'tl', `event ${i} (${view}) wrote an element that is neither of its agent nor a counter: ${what}`);
      }
      // nothing of another agent is made again or removed, and the log gets the lines of the events only
      for (const e of [...made, ...gone]) {
        const who = owner(e);
        if (who !== null && who !== agentId && !e.closest('.ll')) assert.fail(`event ${i} (${view}) made or removed an element of ${who}: ${e.tag}.${[...e.classes]}`);
      }
      assert.equal(made.filter((e) => e.classes.has('ll')).length, ui.length, 'one log line per event');
    }
    if (process.env.WFVIZ_U4_DEBUG) console.log(view, JSON.stringify(report));
    return page.el('#log').childNodes.length;
  } finally {
    page.restore();
  }
}

test('flicker, matrix view (a unit history open): on a replayed stream an event writes the elements of its agent, one log line and the counters; no region is rewritten as a whole and no other agent\'s element is touched', async () => {
  assert.equal(await flickerCase('matrix', { expandUnits: true }), 31);
});

test('flicker, phases view: the same on the lanes and their cards', async () => {
  assert.equal(await flickerCase('phases'), 31);
});

test('flicker, timeline view: the same on the rows, the bars and the axis (the scale of the axis moves bars, never makes them again)', async () => {
  assert.equal(await flickerCase('timeline'), 31);
});

// ---- REPLAY: the badge, the banner and the title ----------------------------------------------------------------------------

test('page: hello.mode decides the badge, the banners and the title; REPLAY has a banner of its own, REAL and DEMO stay as they were, an unknown mode is "?"', async () => {
  const page = await bootPage(); // the boot sends "real"
  try {
    const badge = page.el('#mode');
    const banners = () => [page.el('#demo-banner').hidden, page.el('#replay-banner').hidden];
    assert.deepEqual([badge.text, badge.className, page.doc.title, ...banners()], ['REAL', 'badge real', 'wfviz', true, true]);
    await page.hello('replay');
    assert.deepEqual([badge.text, badge.className, page.doc.title, ...banners()], ['REPLAY', 'badge replay', 'wfviz — REPLAY', true, false]);
    await page.hello('demo');
    assert.deepEqual([badge.text, badge.className, page.doc.title, ...banners()], ['DEMO', 'badge demo', 'wfviz — DEMO', false, true]);
    await page.hello('real');
    assert.deepEqual([badge.text, badge.className, page.doc.title, ...banners()], ['REAL', 'badge real', 'wfviz', true, true]);
    for (const odd of ['live', 'REPLAY', 'x y"><b>']) {
      await page.hello(odd);
      assert.deepEqual([badge.text, badge.className, page.doc.title, ...banners()], ['?', 'badge unknown', 'wfviz', true, true], odd);
    }
  } finally {
    page.restore();
  }
  // the banner says what a replay is, in words of its own: a saved run played back at its own times; not the demo's "synthetic"
  const html = read('index.html');
  const banner = /<div id="replay-banner"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
  assert.match(banner, /^REPLAY/);
  assert.match(banner, /saved run/);
  assert.match(banner, /own times/);
  assert.doesNotMatch(banner, /synthetic|demo/i);
  assert.match(html, /<div id="replay-banner"[^>]* hidden>/);
  assert.match(html, /<div id="demo-banner"[^>]*>DEMO — synthetic data, not a real run</, 'the demo banner is as it was');
  const css = read('style.css');
  assert.match(css, /\.badge\.replay\s*\{[^}]*var\(--info\)/);
  assert.match(css, /#replay-banner\s*\{[^}]*var\(--info\)/);
  assert.doesNotMatch(/#replay-banner\s*\{([^}]*)\}/.exec(css)[1], /repeating-linear-gradient/, 'not the striped banner of the demo');
});

// ---- the run picker -----------------------------------------------------------------------------------------------------------

const DAY = 86400000;
function pickerRuns() {
  const r1 = run([agent('a1', 'w:U', { state: reg('running') })], {
    id: 'wf_1', name: reg('First run'), status: { value: 'running', prov: 'inferred', method: 'no-final-file' }, startedAt: inf(Date.now() - 5000), totals: { agents: 1, running: 1, done: 0, failed: 0 },
  });
  const r2 = run([agent('b1', 'w:V'), agent('b2', 'w:W')], {
    id: 'wf_2', name: reg('Second <b>run</b>'), status: fin('completed'), durationMs: fin(1000), startedAt: inf(Date.now() - 5 * DAY), source: 'replay', totals: { agents: 2, running: 0, done: 2, failed: 0 },
  });
  const r3 = run([], { id: 'wf_3', name: unk('no script meta'), status: fin('killed'), source: 'demo', startedAt: unk('no start yet'), totals: { agents: 0, running: 0, done: 0, failed: 0 } });
  return { r1, r2, r3, docs: { wf_1: r1, wf_2: r2, wf_3: r3 }, list: [summary(r1), summary(r2), summary(r3)] };
}
const rowsOf = (page) => page.el('#rp-list').childNodes;
const rowOf = (page, id) => rowsOf(page).find((r) => r.attrs.get('data-run') === id);
const open = async (page) => { await page.click(page.el('#rp-trigger')); };

test('picker: the dropdown is in the page\'s style, closed at first; the button shows the run on show; a row has name or id with "(no name)", status, start, agent count and source from the run list', async () => {
  const { docs, list } = pickerRuns();
  const page = await bootPage({ runs: list, runDocs: docs, hash: '#range=all' });
  try {
    assert.equal(page.el('#rp-panel').hidden, true);
    assert.equal(page.el('#rp-trigger').getAttribute('aria-expanded'), 'false');
    assert.equal(page.el('#rp-cur').childNodes[0].html, 'First run · running · wf_1', 'the run on show: the running one');
    assert.equal(page.el('#rp-cur').childNodes[0].getAttribute('title'), 'First run\nrun id: wf_1');
    await open(page);
    assert.equal(page.el('#rp-panel').hidden, false);
    assert.equal(page.el('#rp-trigger').getAttribute('aria-expanded'), 'true');
    assert.equal(page.doc.activeElement, page.el('#rp-search'), 'the search field has the focus');
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_1', 'wf_2', 'wf_3'], 'in the order of the list');
    const [a, b, c] = rowsOf(page);
    assert.equal(a.getAttribute('role'), 'option');
    assert.equal(a.getAttribute('aria-selected'), 'true');
    assert.equal(b.getAttribute('aria-selected'), 'false');
    assert.ok(a.classes.has('sel') && a.classes.has('active'), 'the run on show, with the keyboard on it');
    assert.match(a.html, /First run/);
    assert.match(a.html, /<span class="tag running">running<\/span>/);
    assert.match(a.html, /1 agent<span/, 'one agent, singular');
    assert.match(a.html, />real</, 'the source from the list');
    // a name is text: markup in it is escaped
    assert.match(b.html, /Second &lt;b&gt;run&lt;\/b&gt;/);
    assert.doesNotMatch(b.html, /<b>run/);
    assert.match(b.html, /<span class="tag pass">completed<\/span>/);
    assert.match(b.html, /2 agents/);
    assert.match(b.html, />replay</, 'the source of the run, from the list');
    assert.match(b.html, /wf_2/, 'the id is there too');
    // five days ago: the date is shown as well as the time
    assert.ok(b.html.includes(new Date(list[1].startedAt.value).toLocaleDateString()), 'the day of a run of another day');
    assert.ok(!a.html.includes(new Date(list[0].startedAt.value).toLocaleDateString()) || a.html.includes(new Date(list[0].startedAt.value).toLocaleTimeString()), 'today: the time');
    // no name: the id with "(no name)", the status, and "0 agents" because the list says 0
    assert.match(c.html, /wf_3 <small class="muted">\(no name\)<\/small>/);
    assert.match(c.html, /<span class="tag killed">killed<\/span>/);
    assert.match(c.html, /0 agents/);
    assert.match(c.html, />demo</);
    assert.match(c.html, /prov-unknown[^>]*>\?<\/span> start/, 'a start the list does not have is a "?"');
    assert.match(c.getAttribute('data-run'), /^wf_3$/);
  } finally {
    page.restore();
  }
});

test('picker: a value the run list does not have is "?" with its reason, never 0 and never the mode of the page', async () => {
  const bare = [{ id: 'wf_bare', name: unk('no meta'), status: reg('running'), project: null, startedAt: inf(Date.now()) }]; // no agents, no source
  const page = await bootPage({ runs: bare, runDocs: { wf_bare: run([], { id: 'wf_bare' }) } });
  try {
    await page.hello('replay'); // the mode of the page is not the source of the run
    await open(page);
    const row = rowOf(page, 'wf_bare');
    assert.match(row.html, /title="unknown: the run list has no agent count for this run">\?<\/span> agents/);
    assert.match(row.html, /title="unknown: the run list has no source for this run">\?<\/span> source/);
    assert.doesNotMatch(row.html, /0 agents|>replay<|>real</);
  } finally {
    page.restore();
  }
});

test('picker: keyboard - arrows move the row the keyboard is on (by run id), Enter chooses it, Escape closes it and leaves the drawer, a click outside closes it', async () => {
  const { docs, list } = pickerRuns();
  const page = await bootPage({ runs: list, runDocs: docs, hash: '#range=all' });
  try {
    const input = page.el('#rp-search');
    const active = () => rowsOf(page).filter((r) => r.classes.has('active')).map((r) => r.attrs.get('data-run'));
    // an arrow on the closed button opens the dropdown
    await page.key(page.el('#rp-trigger'), 'ArrowDown');
    assert.equal(page.el('#rp-panel').hidden, false);
    assert.deepEqual(active(), ['wf_1']);
    // the list has a layout: rows 50 high, 80 of the list in view; the list scrolls by itself, nothing above it (the page) is scrolled
    const list = page.el('#rp-list');
    rowsOf(page).forEach((r, i) => { r.offsetTop = i * 50; r.offsetHeight = 50; });
    list.clientHeight = 80;
    await page.key(input, 'ArrowDown');
    assert.deepEqual(active(), ['wf_2']);
    assert.equal(list.scrollTop, 20, 'the row is brought into view: its bottom at the bottom of the list');
    await page.key(input, 'ArrowDown');
    await page.key(input, 'ArrowDown');
    assert.deepEqual(active(), ['wf_3'], 'the last row: the keyboard stops there');
    assert.equal(list.scrollTop, 70);
    await page.key(input, 'ArrowUp');
    assert.deepEqual(active(), ['wf_2']);
    assert.equal(list.scrollTop, 50, 'a row above the view: its top at the top of the list');
    assert.equal(rowsOf(page).reduce((n, r) => n + r.scrolledIntoView, 0), 0, 'scrollIntoView scrolls every box above the row, the page too: it is not used');
    await page.key(input, 'ArrowUp');
    await page.key(input, 'ArrowUp');
    assert.deepEqual(active(), ['wf_1'], 'the first row: it stops there');
    assert.equal(input.getAttribute('aria-activedescendant'), rowOf(page, 'wf_1').getAttribute('id'));
    // Enter while an input method composes is the method's own
    await page.key(input, 'ArrowDown');
    await page.key(input, 'Enter', { isComposing: true });
    assert.equal(page.el('#rp-panel').hidden, false);
    assert.equal(page.requests.includes('/api/runs/wf_2'), false);
    // Enter chooses the row: the run is read, the dropdown closes, the focus goes back to the button
    const ev = await page.key(input, 'Enter');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(page.el('#rp-panel').hidden, true);
    assert.equal(page.doc.activeElement, page.el('#rp-trigger'));
    assert.ok(page.requests.includes('/api/runs/wf_2'));
    assert.equal(page.el('#rp-cur').childNodes[0].html.startsWith('Second &lt;b&gt;run'), true, 'the button shows the new run');

    // Escape: the picker closes first and the drawer stays; the next Escape closes the drawer
    const cell = allEls(page).find((e) => e.attrs.has('data-agent') && e.classes.has('cell'));
    assert.ok(cell, 'a cell to click');
    await page.click(cell);
    assert.equal(page.el('#drawer').hidden, false, 'the drawer is open');
    await open(page);
    assert.equal(page.el('#rp-panel').hidden, false);
    await page.key(input, 'Escape');
    assert.equal(page.el('#rp-panel').hidden, true);
    assert.equal(page.el('#drawer').hidden, false, 'Escape closed the picker, not the drawer');
    await page.key(page.doc.body, 'Escape');
    assert.equal(page.el('#drawer').hidden, true, 'with the picker closed it closes the drawer');

    // an outside click closes it; a click inside does not
    await open(page);
    await page.click(page.el('#rp-search'));
    assert.equal(page.el('#rp-panel').hidden, false, 'a click in the search field');
    await page.click(page.el('#rp-list'));
    assert.equal(page.el('#rp-panel').hidden, false, 'a click in the list (not on a row)');
    await page.click(page.el('#log'));
    assert.equal(page.el('#rp-panel').hidden, true, 'a click outside');
    // the button toggles it
    await open(page);
    await page.click(page.el('#rp-trigger'));
    assert.equal(page.el('#rp-panel').hidden, true);
    // Tab out of the picker closes it; focus that goes nowhere (a click on a row, the window losing it) does not
    await open(page);
    page.el('#run-select').dispatch('focusout', { relatedTarget: null });
    assert.equal(page.el('#rp-panel').hidden, false);
    page.el('#run-select').dispatch('focusout', { relatedTarget: page.el('#rp-trigger') });
    assert.equal(page.el('#rp-panel').hidden, false, 'focus stays inside the picker');
    page.el('#rp-search').dispatch('focusout', { relatedTarget: page.el('#log-toggle') });
    assert.equal(page.el('#rp-panel').hidden, true);
  } finally {
    page.restore();
  }
});

test('picker: a click on a row chooses it; the run on show chosen again changes nothing', async () => {
  const { docs, list } = pickerRuns();
  const page = await bootPage({ runs: list, runDocs: docs, hash: '#range=all' });
  try {
    await open(page);
    const before = page.requests.length;
    await page.click(rowOf(page, 'wf_1'));
    assert.equal(page.el('#rp-panel').hidden, true);
    assert.equal(page.requests.length, before, 'the run on show is not read again');
    await open(page);
    await page.click(rowOf(page, 'wf_3'));
    assert.ok(page.requests.includes('/api/runs/wf_3'));
    assert.match(page.el('#rp-cur').childNodes[0].html, /^wf_3 \(no name\) · killed$/);
    await open(page);
    assert.ok(rowOf(page, 'wf_3').classes.has('sel') && !rowOf(page, 'wf_1').classes.has('sel'));
  } finally {
    page.restore();
  }
});

test('picker: search filters by name and id, marks the match, says "no run matches", and keeps the typed text and the row through snapshots', async () => {
  const { docs, list, r1 } = pickerRuns();
  const page = await bootPage({ runs: list, runDocs: docs, hash: '#range=all' });
  try {
    await open(page);
    await page.type('SECOND');
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_2']);
    assert.match(rowOf(page, 'wf_2').html, /<mark>Second<\/mark> &lt;b&gt;run&lt;\/b&gt;/, 'the match is marked, the rest escaped');
    assert.deepEqual(rowsOf(page).filter((r) => r.classes.has('active')).map((r) => r.attrs.get('data-run')), ['wf_2'], 'the row the keyboard was on is gone: the first row has it');
    await page.type('wf_3');
    assert.match(rowOf(page, 'wf_3').html, /<mark>wf_3<\/mark> <small class="muted">\(no name\)/, 'by id, a run that has no name');
    await page.type('no name');
    assert.equal(rowsOf(page).length, 1);
    assert.match(rowsOf(page)[0].html, /no run matches/, '"(no name)" is not matched');
    await page.type('.*');
    assert.match(rowsOf(page)[0].html, /no run matches/, 'a pattern is text');
    await page.type('<b>');
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_2'], 'markup in a name is found as text');
    assert.match(rowOf(page, 'wf_2').html, /Second <mark>&lt;b&gt;<\/mark>run&lt;\/b&gt;/);
    // typed text, list and focus survive a snapshot (the list is patched, nothing is rebuilt)
    await page.type('run');
    const list0 = page.el('#rp-list');
    const row = rowOf(page, 'wf_1');
    assert.ok(row, 'wf_1 has "run" in its name');
    list0.scrollTop = 17;
    const inputWrites = page.el('#rp-search').writes;
    await page.snapshot(structuredClone(r1));
    assert.equal(page.el('#rp-search').value, 'run');
    assert.equal(page.el('#rp-search').writes, inputWrites, 'the search field is not written');
    assert.equal(rowOf(page, 'wf_1'), row, 'the same row element');
    assert.equal(list0.scrollTop, 17);
    assert.equal(page.doc.activeElement, page.el('#rp-search'));
    // closing and opening again keeps the search: the text filter is hash state (#...&q=run), not a draft of the dropdown
    await page.click(page.el('#rp-trigger'));
    await open(page);
    assert.equal(page.el('#rp-search').value, 'run');
    assert.equal(location.hash, '#range=all&q=run');
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_1', 'wf_2'], 'the rows that have "run" in the name');
  } finally {
    page.restore();
  }
});

test('picker: with no run at all it says "no runs yet", not "no run matches"', async () => {
  const page = await bootPage({ runs: [] });
  try {
    assert.match(page.el('#rp-cur').childNodes[0].html, /no runs yet/);
    await open(page);
    assert.equal(rowsOf(page).length, 1);
    assert.match(rowsOf(page)[0].html, /^no runs yet$/);
    await page.type('x');
    assert.match(rowsOf(page)[0].html, /^no runs yet$/);
  } finally {
    page.restore();
  }
});

test('picker, live list: a run that appears or changes status while the page is open is in the picker and its row updates, with no reload; the run on show never changes by itself', async () => {
  const { docs, list, r1, r2 } = pickerRuns();
  const page = await bootPage({ runs: [list[0]], runDocs: docs, hash: '#range=all' });
  try {
    await open(page);
    const timeoutsBefore = page.timers.timeouts.size;
    const intervalsBefore = page.timers.intervals.size;
    const listeners = () => JSON.stringify(Object.fromEntries(Object.entries(page.doc.listeners).map(([k, v]) => [k, v.length])));
    const listenersBefore = listeners();
    const requestsBefore = page.requests.length;
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_1']);
    const first = rowOf(page, 'wf_1');

    // a new run: a new row, first; the run on show stays
    await page.snapshot(structuredClone(r2));
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_2', 'wf_1']);
    assert.equal(rowOf(page, 'wf_1'), first, 'the row that was there is the same element');
    assert.match(rowOf(page, 'wf_2').html, /Second/);
    assert.match(rowOf(page, 'wf_2').html, /2 agents/, 'the agent count comes from the snapshot');
    assert.match(rowOf(page, 'wf_2').html, />replay</, 'the source too');
    assert.equal(page.el('#rp-cur').childNodes[0].html, 'First run · running · wf_1', 'the run on show did not change');
    assert.equal(page.requests.length, requestsBefore, 'no request: neither a reload of the list nor the new run read');

    // a status change: the row is updated in place, at the same place
    const done = structuredClone(r1);
    done.status = fin('completed');
    done.totals.running = 0;
    done.totals.agents = 4;
    await page.snapshot(done);
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_2', 'wf_1'], 'a change of status does not reorder the rows');
    assert.equal(rowOf(page, 'wf_1'), first);
    assert.match(first.html, /<span class="tag pass">completed<\/span>/);
    assert.match(first.html, /4 agents/);
    assert.equal(page.el('#rp-cur').childNodes[0].html, 'First run · completed · wf_1', 'the button follows the status of the run on show');

    // the same snapshot again writes nothing
    const writes = [first, rowOf(page, 'wf_2'), page.el('#rp-cur'), ...page.el('#rp-cur').childNodes].map((e) => e.writes);
    await page.snapshot(structuredClone(done));
    assert.deepEqual([first, rowOf(page, 'wf_2'), page.el('#rp-cur'), ...page.el('#rp-cur').childNodes].map((e) => e.writes), writes);

    // no timer and no listener was added by any of this
    assert.equal(page.timers.timeouts.size, timeoutsBefore);
    assert.ok(page.timers.intervals.size <= intervalsBefore, 'no interval was added (the clock of the run on show stopped, it is final now)');
    assert.equal(listeners(), listenersBefore);
    // a closed picker is brought up to date when it opens
    await page.click(page.el('#rp-trigger'));
    const third = structuredClone(r2);
    third.id = 'wf_new';
    third.name = reg('Newest');
    await page.snapshot(third);
    await open(page);
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_new', 'wf_2', 'wf_1']);
  } finally {
    page.restore();
  }
});

test('picker, live list: in a replay GET /api/runs is empty until a page connects; the run comes by the stream, is in the list and is the one on show', async () => {
  const { r2 } = pickerRuns();
  const page = await bootPage({ runs: [], hash: '#range=all' });
  try {
    assert.match(page.el('#rp-cur').childNodes[0].html, /no runs yet/);
    await page.snapshot(structuredClone(r2));
    assert.match(page.el('#rp-cur').childNodes[0].html, /^Second &lt;b&gt;run&lt;\/b&gt; · completed · wf_2$/);
    await open(page);
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_2']);
    // a second run does not take the page over
    await page.snapshot(structuredClone({ ...r2, id: 'wf_other' }));
    assert.match(page.el('#rp-cur').childNodes[0].html, /wf_2$/);
    assert.deepEqual(rowsOf(page).map((r) => r.attrs.get('data-run')), ['wf_other', 'wf_2']);
  } finally {
    page.restore();
  }
});

// ---- the log: the failed backlog, the count, the gap ------------------------------------------------------------------------

const wfEvents = (from, to, over = {}) => Array.from({ length: to - from + 1 }, (_, i) => uev(from + i, { runId: 'wf_1', ...over }));
const logOf = (page) => page.el('#log').childNodes;
const notices = (page) => logOf(page).filter((c) => c.classes.has('notice'));

test('failed backlog: "backlog not loaded: <error>" is a line in the log (no empty placeholder), it is in the head of a collapsed pane, and the next live event retries; success removes both', async () => {
  const { r1, list } = pickerRuns();
  const page = await bootPage({ runs: [list[0]], runDocs: { wf_1: r1 }, events: { wf_1: wfEvents(1, 3) }, failEvents: 500 });
  try {
    assert.equal(logOf(page).length, 1, 'one line: the notice (a child of the log, so the "waiting for events" placeholder is not shown)');
    assert.equal(notices(page).length, 1);
    assert.match(logOf(page)[0].html, /backlog not loaded: HTTP 500/);
    assert.equal(logOf(page)[0].getAttribute('role'), 'status');
    assert.equal(page.el('#log-notice').hidden, false, 'the head of the pane has it too');
    assert.equal(page.el('#log-notice').text, 'backlog not loaded: HTTP 500');
    assert.equal(page.el('#log-count').text, '', 'the notice is not an event: nothing is counted');
    assert.equal(page.eventRequests().length, 1);
    const css = read('style.css');
    assert.match(css, /\.log:empty::before/, 'the placeholder is the empty log');

    // collapsed: the log hides, its head says it
    page.el('#log-toggle').onclick();
    assert.ok(page.el('#log-pane').classes.has('collapsed'));
    assert.equal(page.el('#log-notice').hidden, false);
    assert.equal(page.el('#log-notice').text, 'backlog not loaded: HTTP 500');
    page.el('#log-toggle').onclick();
    assert.ok(!page.el('#log-pane').classes.has('collapsed'));

    // the next live event reads the backlog again: still failing, one more request, one notice, the same line
    const notice = notices(page)[0];
    const w = notice.writes;
    await page.event(uev(4, { runId: 'wf_1' }));
    assert.equal(page.eventRequests().length, 2, 'one request for the live event');
    assert.deepEqual(notices(page), [notice], 'the same line, nothing written');
    assert.equal(notice.writes, w);
    // a different error replaces the line, it does not add one
    page.failEvents = 503;
    await page.event(uev(5, { runId: 'wf_1' }));
    assert.equal(page.eventRequests().length, 3);
    assert.equal(notices(page).length, 1);
    assert.match(notices(page)[0].html, /HTTP 503/);
    assert.equal(page.el('#log-notice').text, 'backlog not loaded: HTTP 503');
    assert.equal(logOf(page)[0], notices(page)[0], 'first in the log');
    // it comes back: the lines are in, the notice is out of the log and of the head
    page.failEvents = null;
    page.events.wf_1 = wfEvents(1, 6);
    await page.event(uev(6, { runId: 'wf_1' }));
    assert.equal(page.eventRequests().length, 4);
    assert.equal(notices(page).length, 0);
    assert.equal(page.el('#log-notice').hidden, true);
    assert.equal(page.el('#log-notice').text, '');
    assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5, 6]);
    assert.equal(page.el('#log-count').text, '6');
    // no error, no request: a live event is just a line
    await page.event(uev(7, { runId: 'wf_1' }));
    assert.equal(page.eventRequests().length, 4);
    assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5, 6, 7]);
    // and the retry never used a timer
    assert.equal(page.timers.timeouts.size <= 1, true);
  } finally {
    page.restore();
  }
});

test('failed backlog: choosing the run on show again reads the backlog again - only while it did not load', async () => {
  const { r1, list } = pickerRuns();
  const page = await bootPage({ runs: [list[0]], runDocs: { wf_1: r1 }, events: { wf_1: wfEvents(1, 3) }, failEvents: 500, hash: '#range=all' });
  try {
    assert.equal(page.eventRequests().length, 1);
    await open(page);
    await page.click(rowOf(page, 'wf_1'));
    assert.equal(page.eventRequests().length, 2, 'retried');
    assert.equal(notices(page).length, 1);
    assert.equal(page.requests.filter((u) => u === '/api/runs/wf_1').length, 1, 'the run itself is not selected again');
    page.failEvents = null;
    await open(page);
    await page.click(rowOf(page, 'wf_1'));
    assert.equal(page.eventRequests().length, 3);
    assert.equal(notices(page).length, 0);
    assert.deepEqual(logSeqs(page), [1, 2, 3]);
    await open(page);
    await page.click(rowOf(page, 'wf_1'));
    assert.equal(page.eventRequests().length, 3, 'it loaded: choosing it again changes nothing');
    // selecting another run drops a notice that belonged to the first
    page.failEvents = 500;
    page.runDocs.wf_2 = pickerRuns().r2;
    page.runs.push(summary(pickerRuns().r2));
    await page.snapshot(structuredClone(pickerRuns().r2));
    await open(page);
    await page.click(rowOf(page, 'wf_2'));
    assert.equal(notices(page).length, 1);
    page.failEvents = null;
    await open(page);
    await page.click(rowOf(page, 'wf_1'));
    assert.equal(notices(page).length, 0, 'the other run has no notice');
  } finally {
    page.restore();
  }
});

test('log count: "showing the last 2000 of 2060 events" counts the event lines, not the marker of missing events', async () => {
  const { r1, list } = pickerRuns();
  const page = await bootPage({ runs: [list[0]], runDocs: { wf_1: r1 }, events: { wf_1: wfEvents(1, 99) } });
  try {
    assert.equal(page.el('#log-count').text, '99');
    // events 100-109 are gone from the server: a live event 110 shows the gap, the server has nothing to fill it with
    await page.event(uev(110, { runId: 'wf_1' }));
    assert.equal(logOf(page).filter((c) => c.classes.has('missing')).length, 1, 'one marker');
    assert.match(logOf(page).find((c) => c.classes.has('missing')).html, /10 events not available \(seq 100–109\)/);
    assert.equal(page.el('#log-count').text, '100', '99 events and 110: the marker is not counted');
    for (let i = 111; i <= 2060; i++) page.emit('event', uev(i, { runId: 'wf_1' }));
    await page.flush();
    assert.equal(page.el('#log-count').text, 'showing the last 2000 of 2060 events');
    assert.equal(logOf(page).length, 2001, '2000 events and the marker');
    assert.equal(logOf(page).filter((c) => c.classes.has('missing')).length, 1);
    assert.equal(logOf(page).filter((c) => !c.classes.has('missing')).length, 2000);
  } finally {
    page.restore();
  }
});

test('log after a gap: the events fetched to close it are merged in the order of the displayed time like the first backlog, not appended out of order; only the lines that must move move', async () => {
  // the agent g started at 100 (its startedAt), long before the events of the other lines (9000+): its agent.started lines are shown at 100
  const g = agent('g', 'w:G', { startedAt: reg(100), endedAt: reg(150) });
  const a1 = agent('a1', 'w:U', { state: reg('running'), startedAt: reg(8000), endedAt: unk('running') });
  const r = run([a1, g], { id: 'wf_1', name: reg('gap run'), totals: { agents: 2, running: 1, done: 1, failed: 0 } });
  const backlog = wfEvents(1, 10); // agent.activity of a1 at 9001..9010
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, events: { wf_1: backlog } });
  try {
    assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const old = logOf(page).slice();
    const el = page.el('#log');
    Object.assign(el, { scrollHeight: 1000, clientHeight: 190, scrollTop: 100 }); // the user has scrolled up to read

    // 11-14 are not seen live; 15 is. The server has them all.
    const gapEvents = [11, 12, 13, 14].map((n) => uev(n, { runId: 'wf_1', kind: 'agent.started', agentId: 'g', ts: 9000 + n }));
    const live15 = uev(15, { runId: 'wf_1' });
    page.events.wf_1 = [...backlog, ...gapEvents, live15];
    await page.event(live15);
    const all = page.events.wf_1;
    const expected = logOrder(all, r, 15).map(lib.lineSeq);
    assert.deepEqual(expected, [11, 12, 13, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15], 'the premise: the four events that were fetched are shown at 100, before the rest');
    assert.deepEqual(logSeqs(page), expected, 'the order of the displayed time');
    assert.deepEqual(logSeqs(page), lib.sortByShownTime(all, r).map(lib.lineSeq), 'as if the whole log had been the first backlog');
    for (const e of old) assert.equal(e.moves, 1, 'a line that was there is not moved (the new ones went in before it)');
    assert.deepEqual(logOf(page).slice(4, 14), old, 'the same elements');
    assert.equal(el.scrollTop, 100, 'the user was reading: the view stays where it is');
    assert.equal(page.el('#log-count').text, '15');

    // at the bottom the view follows
    Object.assign(el, { scrollHeight: 1000, clientHeight: 190, scrollTop: 810 });
    const tail = [16, 17, 18, 19].map((n) => uev(n, { runId: 'wf_1' }));
    page.events.wf_1 = [...all, ...tail];
    await page.event(tail[3]);
    assert.deepEqual(logSeqs(page), [11, 12, 13, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19]);
    assert.equal(el.scrollTop, 1000, 'at the bottom: the view follows the new lines');
  } finally {
    page.restore();
  }
});

test('log after a gap: the lines that were shown live between the two backlogs are sorted with the second one (the rule is "up to the last seq a backlog brought, by displayed time")', async () => {
  const g = agent('g', 'w:G', { startedAt: reg(100), endedAt: reg(150) });
  const a1 = agent('a1', 'w:U', { state: reg('running'), startedAt: reg(8000), endedAt: unk('running') });
  const r = run([a1, g], { id: 'wf_1', name: reg('gap run'), totals: { agents: 2, running: 1, done: 1, failed: 0 } });
  const backlog = wfEvents(1, 10);
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, events: { wf_1: backlog } });
  try {
    // 11 comes live in order and is shown at the end, in arrival order, though its displayed time is 100
    const live11 = uev(11, { runId: 'wf_1', kind: 'agent.started', agentId: 'g' });
    page.events.wf_1 = [...backlog, live11];
    await page.event(live11);
    assert.deepEqual(logSeqs(page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'a live line is not sorted');
    // then a gap: 12-13 are missed, 14 is live; the batch read is 12-14
    const batch = [12, 13, 14].map((n) => uev(n, { runId: 'wf_1', kind: 'agent.started', agentId: 'g' }));
    page.events.wf_1 = [...backlog, live11, ...batch];
    await page.event(batch[2]);
    const all = page.events.wf_1;
    assert.deepEqual(logSeqs(page), logOrder(all, r, 14).map(lib.lineSeq));
    assert.deepEqual(logSeqs(page), [11, 12, 13, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'the live line 11 is among those sorted with the batch');
    // a live event after that is again appended in arrival order
    const live15 = uev(15, { runId: 'wf_1', kind: 'agent.started', agentId: 'g' });
    page.events.wf_1.push(live15);
    await page.event(live15);
    assert.deepEqual(logSeqs(page).slice(-2), [10, 15]);
  } finally {
    page.restore();
  }
});

// ---- the matrix: the round history, the toggle, wide matrices ---------------------------------------------------------------------

const wfRun = (agents, over = {}) => run(agents, { id: 'wf_1', name: reg('a run'), totals: { agents: agents.length, running: 0, done: agents.length, failed: 0 }, ...over });
const toggleOf = (page, unit) => allEls(page).find((e) => e.tag === 'button' && e.attrs.get('data-unit') === unit);

test('round history: a group with neither round nor tag says "round unknown" once; a tag group says it once next to its tag; a known round says nothing', async () => {
  const r = wfRun([
    agent('a', 'w:U', { startedAt: inf(1) }),
    agent('b', 'w:U#r1', { startedAt: inf(2) }),
    agent('c', 'w:U', { round: reg(2), startedAt: inf(3) }),
  ]);
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r } });
  try {
    await page.click(toggleOf(page, 'U'));
    const heads = allEls(page).filter((e) => e.tag === 'h5').map((e) => e.html);
    assert.equal(heads.length, 3);
    const count = (s) => s.split('round unknown').length - 1;
    const unknownGroup = heads.find((h) => h.startsWith('round unknown'));
    assert.equal(count(unknownGroup), 1, `once: ${unknownGroup}`);
    assert.equal(unknownGroup, 'round unknown <small>1 agent</small>');
    const tagGroup = heads.find((h) => h.startsWith('#r1'));
    assert.equal(tagGroup, '#r1 <small>round unknown</small> <small>1 agent</small>');
    assert.equal(heads.find((h) => h.startsWith('round 2')), 'round 2 <small>1 agent</small>');
    // the history is a group of keyed groups and rows
    const hist = page.el('#matrix-grid').querySelector('.hist');
    assert.equal(hist.childNodes.length, 3);
    assert.deepEqual(hist.childNodes.map((g) => g.childNodes.length), [2, 2, 2], 'a heading and a row in each');
    assert.equal(hist.htmlWrites, 0);
  } finally {
    page.restore();
  }
});

test('keyboard focus: the toggle of a unit history keeps its element and its focus across toggles and snapshots; only its label text and attributes change', async () => {
  const r = wfRun([agent('a', 'w:U', { state: reg('running'), startedAt: inf(1) }), agent('b', 'x:U', { startedAt: inf(2) })]);
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r } });
  try {
    const toggle = toggleOf(page, 'U');
    assert.ok(toggle);
    const group = toggle.parentNode;
    const label = group.parentNode;
    assert.ok(label.classes.has('mrow-label'));
    const name = group.childNodes.find((c) => c.classes.has('u-name'));
    assert.equal(name.html, 'U');
    assert.equal(toggle.html, '▸');
    toggle.focus();
    const nameWrites = name.writes;
    const stays = () => {
      assert.equal(toggleOf(page, 'U'), toggle, 'the same element');
      assert.equal(toggle.parentNode, group);
      assert.equal(page.doc.activeElement, toggle, 'the focus is still on it');
    };
    await page.click(toggle);
    stays();
    assert.equal(toggle.html, '▾');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('data-unit'), 'U', 'a raw attribute');
    assert.ok(page.el('#matrix-grid').querySelector('.hist'), 'the history is open');
    await page.click(toggle);
    stays();
    assert.equal(toggle.html, '▸');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(page.el('#matrix-grid').querySelector('.hist'), null);
    await page.click(toggle);
    stays();
    // a snapshot: the unit finishes, a new agent with a tag joins it; the toggle is not touched
    const r2 = structuredClone(r);
    r2.agents.a.state = reg('done');
    r2.agents.c = agent('c', 'w:U#r2', { startedAt: inf(3) });
    r2.order.push('c');
    const writes = toggle.writes;
    await page.snapshot(r2);
    stays();
    assert.equal(toggle.writes, writes, 'not one write to the button');
    assert.ok(label.classes.has('st-done') || label.classes.has('st-unknown'), 'the row did change');
    assert.ok(group.childNodes.some((c) => c.classes.has('tag-i') && c.html === '#r2'), 'the new tag is a new element in the label');
    // the same snapshot again: nothing is written to the label at all
    const labelWrites = [label, group, toggle, name, ...group.childNodes].map((e) => e.writes);
    await page.snapshot(structuredClone(r2));
    assert.deepEqual([label, group, toggle, name, ...group.childNodes].map((e) => e.writes), labelWrites);
    assert.equal(name.writes, nameWrites, 'the name of the unit was never rewritten');
    // the control: a button that was removed and made again does lose the focus on this fake browser, as in a real one
    const copy = page.doc.createElement('button');
    group.insertBefore(copy, null);
    copy.focus();
    group.removeChild(copy);
    assert.equal(page.doc.activeElement, null);
  } finally {
    page.restore();
  }
});

test('wide matrix: many roles and a 40-character role name are not cut; the role is its own wrapping element; roles take the neutral slots in order of appearance', async () => {
  const long = 'x'.repeat(40);
  const agents = [];
  for (let i = 1; i <= 15; i++) agents.push(agent(`a${i}`, `${i === 7 ? long : `role${i}`}:U`, { startedAt: inf(i) }));
  const r = wfRun(agents);
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r } });
  try {
    const grid = page.el('#matrix-grid');
    assert.match(grid.props.get('grid-template-columns'), /repeat\(15, minmax\(44px, 1fr\)\)/, 'a column for every role');
    const heads = grid.childNodes.filter((c) => c.classes.has('mhead'));
    assert.equal(heads.length, 16, 'the unit head and 15 roles');
    assert.ok(heads.some((h) => h.html === long), 'the whole role name');
    const roles = page.el('#roles').childNodes;
    assert.equal(roles.length, 15);
    const longRole = roles.find((e) => e.html.includes(long));
    assert.match(longRole.html, new RegExp(`<span class="rname">${long}</span>`), 'the name is an element of its own');
    // slots: the first nine roles take --c1 .. --c9, the tenth starts again
    const dot = (e) => /background:var\((--c\d+)\)/.exec(e.html)?.[1];
    assert.deepEqual(roles.map(dot), ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--c9', '--c1', '--c2', '--c3', '--c4', '--c5', '--c6']);
    const cells = grid.childNodes.filter((c) => c.classes.has('cell'));
    assert.equal(cells.length, 15);
    assert.match(cells[0].attrs.get('style'), /^--c:var\(--c1\)$/);
    assert.match(cells[9].attrs.get('style'), /^--c:var\(--c1\)$/, 'the tenth role starts the slots again');
    // a role the run does not know (a fallback agent with none) has --other
    assert.doesNotMatch(read('app.js'), /--impl|--rev|--judge|--fix|--test\b/);
  } finally {
    page.restore();
  }
  const css = read('style.css');
  const col = /(?:^|\n)\.col\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(col, /overflow-x:\s*auto/, 'the centre column scrolls sideways when the matrix is wider than it');
  assert.doesNotMatch(col, /overflow-x:\s*hidden|overflow:\s*hidden/);
  assert.match(col, /min-width:\s*0/, 'a grid column that may be narrower than its content');
  assert.match(/\.grid\s*\{([^}]*)\}/.exec(css)[1], /minmax\(0, 1fr\)/, 'the centre is the shrinking column of the grid');
  const rname = /\.role \.rname\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rname, /min-width:\s*0/);
  assert.match(rname, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(rname, /text-overflow|white-space:\s*nowrap/, 'wrapped, never cut');
  assert.match(/(?:^|\n)\.role\s*\{([^}]*)\}/.exec(css)[1], /flex-wrap:\s*wrap/);
});

// ---- the tests card: hidden rows -----------------------------------------------------------------------------------------------

const twelveTests = () => Array.from({ length: 12 }, (_, i) => ({ agentId: 'a', path: '$', passed: i, failed: 0, skipped: 0 }));

test('tests card: "showing 8 of 12" with the rest on offer; expanding adds the older rows and leaves the first eight untouched; selecting another run starts collapsed again', async () => {
  const mk = (id) => wfRun([agent('a', 'x:y')], { id, name: reg(id), recognized: { findings: [], verdicts: [], tests: twelveTests() } });
  const r = mk('wf_1');
  const other = mk('wf_2');
  const page = await bootPage({ runs: [summary(r), summary(other)], runDocs: { wf_1: r, wf_2: other }, hash: '#range=all' });
  try {
    const rows = () => page.el('#tests').childNodes.filter((c) => c.classes.has('tests-row'));
    const more = () => page.el('#tests').childNodes.find((c) => c.classes.has('tests-more'));
    assert.equal(rows().length, 8);
    assert.equal(more().childNodes[0].html, 'showing 8 of 12');
    const button = more().childNodes[1];
    assert.equal(button.html, 'show all 12');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.match(rows()[0].html, /x:y · summary 12 of 12/);
    assert.match(rows()[7].html, /x:y · summary 5 of 12/);
    const first8 = rows().slice();
    const moreEl = more();
    const writes = first8.map((e) => e.writes);
    button.focus();

    await page.click(button);
    assert.equal(rows().length, 12);
    assert.deepEqual(rows().slice(0, 8), first8, 'the same elements, in the same places');
    assert.deepEqual(first8.map((e) => e.writes), writes, 'not written');
    assert.ok(first8.every((e) => e.moves === 1), 'not moved');
    assert.match(rows()[11].html, /x:y · summary 1 of 12/, 'the older rows are reachable');
    assert.equal(more(), moreEl);
    assert.equal(more().childNodes[0].html, 'showing 12 of 12');
    assert.equal(more().childNodes[1], button, 'the button is the same element');
    assert.equal(button.html, 'show fewer');
    assert.equal(page.doc.activeElement, button, 'and keeps the focus');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    // a snapshot keeps it expanded
    await page.snapshot(structuredClone(r));
    assert.equal(rows().length, 12);
    // back to the last eight
    await page.click(button);
    assert.equal(rows().length, 8);
    assert.deepEqual(rows(), first8);
    assert.equal(more().childNodes[0].html, 'showing 8 of 12');
    // expanded, then another run: collapsed
    await page.click(button);
    assert.equal(rows().length, 12);
    await open(page);
    await page.click(rowOf(page, 'wf_2'));
    assert.equal(rows().length, 8, 'the expansion belongs to the run it was made on');
    assert.equal(more().childNodes[0].html, 'showing 8 of 12');
  } finally {
    page.restore();
  }
  // a run with few results has nothing hidden: no offer
  const few = wfRun([agent('a', 'x:y')], { recognized: { findings: [], verdicts: [], tests: twelveTests().slice(0, 3) } });
  const p2 = await bootPage({ runs: [summary(few)], runDocs: { wf_1: few } });
  try {
    assert.equal(p2.el('#tests').childNodes.filter((c) => c.classes.has('tests-more')).length, 0);
    assert.equal(p2.el('#tests').childNodes.filter((c) => c.classes.has('tests-row')).length, 3);
  } finally {
    p2.restore();
  }
});

// ---- the elapsed time on the page -----------------------------------------------------------------------------------------------------

const elapsedStat = (page) => page.el('#run-status').childNodes.find((c) => c.html.startsWith('elapsed'));

test('page, elapsed: a replay shows the run\'s own time and starts no clock; two equal snapshots write nothing; a journal time later than the run is not used', async () => {
  const r = savedRun({ id: 'wf_1' });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r } });
  try {
    await page.hello('replay');
    const stat = elapsedStat(page);
    assert.match(stat.html, /class="fact prov-inferred"/);
    assert.match(stat.html, />13s</, '1794126724683 - 1794126711269 ms');
    assert.match(stat.html, /title="inferred: the latest time the run records minus the run start \(inferred, earliest-agent-start\)"/);
    assert.equal(page.timers.intervals.size, 0, 'no clock for a replay');
    const writes = stat.writes;
    await page.snapshot(structuredClone(r));
    await page.snapshot(structuredClone(r));
    assert.equal(stat.writes, writes, 'two equal snapshots: nothing written');
    // the journal events of a saved run carry the file time, 18.6 minutes after the run: an event does not move the elapsed time
    await page.event(uev(1, { runId: 'wf_1', kind: 'agent.started', agentId: 'r1', ts: FILE_TIME }));
    await page.snapshot(structuredClone(r));
    assert.equal(stat.writes, writes);
    assert.match(elapsedStat(page).html, />13s</);
    // the run goes on in its own time: an agent ends 5 s later, the elapsed time follows it at the next snapshot
    const later = structuredClone(r);
    later.agents.f2.endedAt = reg(1794126729683);
    await page.snapshot(later);
    assert.match(elapsedStat(page).html, />18s</);
    assert.equal(page.timers.intervals.size, 0);
    // the end of the replay: the final file's own duration, as for any final run
    const done = structuredClone(later);
    done.status = fin('completed');
    done.durationMs = fin(18415, 'wf.json#durationMs');
    await page.snapshot(done);
    assert.match(elapsedStat(page).html, /class="fact prov-final"[^>]*>18s</);
    assert.equal(page.timers.intervals.size, 0);
  } finally {
    page.restore();
  }
});

test('page, elapsed: only a running run of source real has the one 1 s clock; a final run, a demo run and a run that is not running have none', async () => {
  const mk = (source, over = {}) => wfRun([agent('a', 'x:y', { state: reg('running') })], { source, startedAt: inf(Date.now() - 5000), ...over });
  const real = mk('real');
  const p1 = await bootPage({ runs: [summary(real)], runDocs: { wf_1: real } });
  try {
    assert.equal(p1.timers.intervals.size, 1);
    assert.match(elapsedStat(p1).html, /prov-inferred/);
    const tick = [...p1.timers.intervals.values()][0];
    assert.equal(tick.ms, 1000);
    // a tick writes the text of the one value element of the elapsed stat and nothing else (the fake keeps the stat's html as a string,
    // so the value element is given to it)
    const stat = elapsedStat(p1);
    const value = p1.doc.createElement('span');
    stat.querySelector = (sel) => (sel === '.fact.prov-inferred' ? value : null);
    const statWrites = stat.writes;
    tick.fn();
    assert.match(value.text, /^[5-6]s$/);
    assert.equal(stat.writes, statWrites, 'the stat itself is not written by a tick');
    p1.emit('run', structuredClone(real));
    await p1.flush();
    assert.equal(p1.timers.intervals.size, 1, 'a snapshot does not add a second one');
    const final = structuredClone(real);
    final.status = fin('completed');
    final.durationMs = fin(5000);
    await p1.snapshot(final);
    assert.equal(p1.timers.intervals.size, 0, 'the clock stops when the run ends');
  } finally {
    p1.restore();
  }
  const demo = mk('demo');
  const p2 = await bootPage({ runs: [summary(demo)], runDocs: { wf_1: demo } });
  try {
    assert.equal(p2.timers.intervals.size, 0, 'a demo run is drawn with each snapshot, it has no timer');
    assert.match(elapsedStat(p2).html, /prov-inferred/);
    assert.match(elapsedStat(p2).html, /now minus the run start/);
  } finally {
    p2.restore();
  }
  // a final run with no duration of its own: its own times, no clock
  const ended = wfRun([agent('a', 'x:y')], { source: 'real', status: fin('completed'), durationMs: unk('final file has no durationMs'), startedAt: inf(Date.now() - 900000), endedAt: fin(Date.now() - 900000 + 61000) });
  const p3 = await bootPage({ runs: [summary(ended)], runDocs: { wf_1: ended } });
  try {
    assert.equal(p3.timers.intervals.size, 0);
    assert.match(elapsedStat(p3).html, />1m 1s</);
    assert.match(elapsedStat(p3).html, /the run end \(final, /);
  } finally {
    p3.restore();
  }
});

// ---- verdict tags are neutral, colours are slots ------------------------------------------------------------------------------------------

test('verdicts: a verdict value is a text on a neutral tag; its colour is a slot given in order of appearance; no value becomes a class name', async () => {
  const verdicts = [
    { agentId: 'a', path: '$.v', verdict: 'accept', method: 'field-name', reason: 'fine' },
    { agentId: 'b', path: '$.v', verdict: 'fix', method: 'field-name', reason: 'needs work' },
    { agentId: 'c', path: '$.v', verdict: 'two words "quoted" <b>', method: 'field-name', reason: '' },
    { agentId: 'd', path: '$.v', verdict: 'accept', method: 'field-name', reason: 'again' },
    { agentId: 'e', path: '$.v', verdict: 'pass', method: 'field-name', reason: 'a state word' },
  ];
  const r = wfRun(['a', 'b', 'c', 'd', 'e'].map((id, i) => agent(id, `w:U${i}`)), { recognized: { findings: [], verdicts, tests: [] } });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r } });
  try {
    const cards = page.el('#verdicts').childNodes;
    assert.equal(cards.length, 5);
    const tagOfCard = (card) => /<span class="(tag[^"]*)" style="([^"]*)" title="[^"]*">([^<]*(?:&[^<]*)?)<\/span>/.exec(card.html);
    const seen = new Map();
    for (const card of cards) {
      const m = tagOfCard(card);
      assert.ok(m, card.html);
      assert.equal(m[1], 'tag vt', 'a neutral tag: its class does not depend on the value');
      const [, , style, text] = m;
      assert.match(style, /^--c:var\(--c\d\)$/);
      assert.equal(card.attrs.get('style'), style, 'the card carries the same slot');
      if (seen.has(text)) assert.equal(seen.get(text), style, 'the same value, the same slot');
      seen.set(text, style);
    }
    assert.equal(seen.size, 4, 'four distinct values');
    assert.equal(new Set(seen.values()).size, 4, 'one slot each');
    const order = orderOfAppearance(verdicts.map((v) => v.verdict));
    for (const [text, style] of seen) {
      const value = text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      assert.equal(style, `--c:var(${slotVar(order, value)})`);
    }
    // no verdict word reaches a class attribute
    for (const card of cards) assert.doesNotMatch(card.html, /class="tag (accept|fix|pass|two)/);
    assert.match(cards.map((c) => c.html).join(''), /two words &quot;quoted&quot; &lt;b&gt;/, 'the text is escaped');
  } finally {
    page.restore();
  }
});

// =====================================================================================================================
// the page as files: no name of our method, scrollbars, banners, timers
// =====================================================================================================================

// ---- universality: no custom property, class or verdict style named after a role or a verdict of this project's gate ------------------

// The names are compared as whole words of a name split on - and _, so `.tests-row`, `#tests`, `--fail`, `.fcard` and `flash` pass and
// `--judge`, `.tag.accept`, `var(--impl)`, `'--rev'`, `tag fix` do not.
const ROLE_WORDS = new Set(['impl', 'rev', 'judge', 'fix', 'test', 'accept', 'implement', 'review', 'reviewer', 'fixer']);
const named = (name) => String(name).split(/[-_]/).some((w) => ROLE_WORDS.has(w.toLowerCase()));
const classWords = (text) => String(text).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);

// what in one file is a custom property or a class name that has a role or verdict word: [what] per hit
function roleNameHits(file, text) {
  const hits = [];
  const add = (kind, name) => { if (named(name)) hits.push(`${file}: ${kind}${name}`); };
  const body = file.endsWith('.css') ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text;
  // custom properties: var(--x), a declaration --x:, a whole quoted string '--x'
  for (const m of body.matchAll(/var\(\s*--([\w-]+)/g)) add('custom property --', m[1]);
  for (const m of body.matchAll(/(?<![\w-])--([\w-]+)\s*:/g)) add('custom property --', m[1]);
  for (const m of body.matchAll(/(['"`])--([\w-]+)\1/g)) add('custom property --', m[2]);
  if (file.endsWith('.css')) {
    // class selectors
    for (const m of body.matchAll(/\.([A-Za-z_][\w-]*)/g)) add('class .', m[1]);
  } else {
    // class attributes and properties, in html and in the strings of the page code
    for (const m of body.matchAll(/\bclass(?:Name)?\s*[=:]\s*(["'`])((?:(?!\1)[\s\S])*)\1/g)) for (const w of classWords(m[2])) add('class ', w);
    for (const m of body.matchAll(/class="([^"]*)"/g)) for (const w of classWords(m[1])) add('class ', w);
    for (const m of body.matchAll(/classList\.\w+\(\s*(['"])([^'"]+)\1/g)) for (const w of classWords(m[2])) add('class ', w);
    // a selector in a string: '.cell[data-agent], .tl-bar'
    for (const m of body.matchAll(/(['"`])((?:\.|#)[A-Za-z_][^'"`\n]*)\1/g)) for (const c of m[2].matchAll(/\.([A-Za-z_][\w-]*)/g)) add('class .', c[1]);
  }
  return [...new Set(hits)];
}

test('universal scan: the scanner finds a custom property or a class named after a role or a verdict, in css, in strings and in html, and nothing else', () => {
  const css = (t) => roleNameHits('x.css', t);
  const js = (t) => roleNameHits('x.js', t);
  const html = (t) => roleNameHits('x.html', t);
  assert.deepEqual(css(':root { --judge: #a37bff; }'), ['x.css: custom property --judge']);
  assert.deepEqual(css('.step { color: var(--impl); }'), ['x.css: custom property --impl']);
  assert.deepEqual(css('.tag.accept { color: red }'), ['x.css: class .accept']);
  assert.deepEqual(css('.tag.fix, .x-rev { color: red }').sort(), ['x.css: class .fix', 'x.css: class .x-rev']);
  assert.deepEqual(css('.a { background: var(--fix-color) }'), ['x.css: custom property --fix-color']);
  assert.deepEqual(js("const P = ['--impl', '--rev'];"), ['x.js: custom property --impl', 'x.js: custom property --rev']);
  assert.deepEqual(js("{ style: '--c:var(--judge)' }"), ['x.js: custom property --judge']);
  assert.deepEqual(js("`<span class=\"tag fix\">`"), ['x.js: class fix']);
  assert.deepEqual(js("{ class: 'tag accept', x: 1 }"), ['x.js: class accept']);
  assert.deepEqual(js("el.classList.add('review-me')"), ['x.js: class review-me']);
  assert.deepEqual(js("const S = '.cell[data-agent], .tag.judge';"), ['x.js: class .judge']);
  assert.deepEqual(html('<span class="tag accept other">'), ['x.html: class accept']);
  // not flagged: whole words only, and prose
  for (const ok of ['.tests-row { }', '.fcard { }', '#tests { }', '.tag.fail { color: var(--fail); }', ':root { --accent: #f90; --finding: #f05; --c1: #f90; --c9: #fff; }', '.tag.vt { color: var(--c); }', '.contest { }', '.prefix-testing { }']) assert.deepEqual(css(ok), [], ok);
  for (const ok of ["'a node --test summary'", "class: 'tests-row'", "el.classList.add('flash')", "const S = '.cell[data-agent]';", '`<div class="tag ${esc(x)}">`', "'--c:var(--other)'", "state.log.test(x)"]) assert.deepEqual(js(ok), [], ok);
  assert.deepEqual(html('<div id="tests" class="card tests-row">'), []);
});

test('universal scan: web/ has no custom property or class named after a role or a verdict of this project\'s method', () => {
  const hits = [];
  for (const f of ['app.js', 'lib.js', 'index.html', 'style.css']) hits.push(...roleNameHits(f, read(f)));
  assert.deepEqual(hits, []);
  const css = read('style.css');
  for (const slot of ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8', '--c9', '--other', '--accent']) assert.match(css, new RegExp(`${slot}:\\s*#[0-9a-f]{6}`), `${slot} is a token`);
  // the tokens are not spelled in the page code any more: a role has a slot, nothing else
  const app = read('app.js');
  assert.doesNotMatch(app, /PALETTE/);
  assert.doesNotMatch(app, /#[0-9a-fA-F]{6}\b/, 'no colour of its own in app.js');
  assert.doesNotMatch(app, /class="tag \$\{esc\(vv\(/, 'a verdict value is never a class');
  assert.match(app, /class="tag vt"/);
  // the verdict styling does not depend on the values accept or fix
  assert.doesNotMatch(css, /\.tag\.(accept|fix)\b/);
});

test('universal scan: no node code and no number of an item of a spec in a comment or a name of web/', () => {
  for (const f of ['app.js', 'lib.js', 'index.html', 'style.css']) {
    const text = read(f);
    assert.doesNotMatch(text, /\bNode U\d/i, `${f}: a node code`);
    assert.doesNotMatch(text, /\(items? \d+(?:\s*(?:and|,|-)\s*\d+)*\)/i, `${f}: a spec item number in a comment`);
    assert.doesNotMatch(text, /\bU\d\b/, `${f}: a node code (U2, U3)`);
    assert.doesNotMatch(text, /docs\/guides|graph\.md|AGENTS\.md|web-u\d/, `${f}: a file of this project's method`);
  }
});

// ---- scrollbars ------------------------------------------------------------------------------------------------------------------------------

// the rules of the css that have `needle` in their selector or body: [{ selector, body }]
function cssRules(text, needle) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[0].includes(needle)) out.push({ selector: m[1].trim(), body: m[2].trim() });
  return out;
}

test('scrollbars: every scrolling area uses scrollbar-color and scrollbar-width: thin and ::-webkit-scrollbar rules, all from the colour tokens (no hex), over the dark palette', () => {
  const css = read('style.css');
  const rules = cssRules(css, 'scrollbar');
  assert.ok(rules.length >= 5, 'the rules are there');
  const everywhere = rules.find((r) => r.selector === '*' && /scrollbar-color/.test(r.body));
  assert.ok(everywhere, 'one rule for every element, so every scrolling area (.col, .steps, .lanes, .log, .drawer, the pre blocks, the picker list, .grid in one column) is covered, scrollbar-width being not inherited');
  assert.match(everywhere.body, /scrollbar-width:\s*thin/);
  assert.match(everywhere.body, /scrollbar-color:\s*color-mix\(in srgb, var\(--muted\)[^;]*var\(--panel\)\)\s+transparent/);
  for (const part of ['*::-webkit-scrollbar', '*::-webkit-scrollbar-thumb', '*::-webkit-scrollbar-track', '*::-webkit-scrollbar-corner']) assert.ok(rules.some((r) => r.selector === part), part);
  assert.match(rules.find((r) => r.selector === '*::-webkit-scrollbar-thumb').body, /var\(--muted\)/);
  assert.match(rules.find((r) => r.selector === '*::-webkit-scrollbar-thumb:hover')?.body ?? '', /var\(--muted\)/);
  for (const r of rules) {
    assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b|\bblack\b/, `${r.selector}: a token, not a colour of its own`);
    for (const color of r.body.matchAll(/(?:scrollbar-color|background)\s*:\s*([^;]+)/g)) assert.match(color[1], /var\(--|transparent/, `${r.selector}: ${color[1]}`);
  }
  // the dark palette says so: native controls and scrollbars are not the system's white ones
  assert.match(/:root\s*\{([^}]*)\}/.exec(css)[1], /color-scheme:\s*dark/);
  // this style sheet has one palette (no light theme, no prefers-color-scheme, no toggle): a theme that sets the tokens sets the scrollbars
  assert.doesNotMatch(css, /prefers-color-scheme/);
  // the scrolling areas of the page that the rule has to cover are scrolling areas
  for (const sel of ['\\.col', '\\.steps', '\\.log', '\\.drawer', '\\.rp-list', '\\.lanes']) assert.match(css, new RegExp(`(?:^|\\n)${sel}\\s*\\{[^}]*overflow(?:-x|-y)?:\\s*auto`), sel);
  assert.match(css, /\.drawer pre\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.report \.err-more pre\s*\{[^}]*overflow:\s*auto/);
});

test('picker, banner and tests-card styles use the colour tokens only (no hex), and the keyboard focus is shown', () => {
  const css = read('style.css');
  const own = [...cssRules(css, '.rp'), ...cssRules(css, '#replay-banner'), ...cssRules(css, '.more-toggle'), ...cssRules(css, '.tests-more'), ...cssRules(css, 'mark')]
    .filter((r) => /^(\.rp|#replay-banner|\.more-toggle|\.tests-more|mark)/.test(r.selector));
  assert.ok(own.length >= 10);
  for (const r of own) assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b/, `${r.selector}: tokens only`);
  assert.match(/\.rp-search\s*\{([^}]*)\}/.exec(css)[1], /font:\s*inherit/);
  assert.match(/\.rp-trigger\s*\{([^}]*)\}/.exec(css)[1], /font:\s*inherit/);
  assert.match(/\.more-toggle\s*\{([^}]*)\}/.exec(css)[1], /font:\s*inherit/);
  assert.match(/(?:^|\n)mark\s*\{([^}]*)\}/.exec(css)[1], /color:\s*inherit/);
  assert.match(css, /button:focus-visible[^{]*\{[^}]*outline:/, 'a focused button shows a ring');
  assert.match(css, /\[tabindex\]:focus-visible/);
  assert.match(/\.rp-list\s*\{([^}]*)\}/.exec(css)[1], /overflow-y:\s*auto/);
  assert.match(/\.rp-list\s*\{([^}]*)\}/.exec(css)[1], /position:\s*relative/, 'the rows measure their place from the list');
  assert.match(css, /#replay-banner/);
  // the picker's own markup: a button, a dropdown, a search field and a listbox; the old select is gone
  const html = read('index.html');
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /<div id="run-select"[^>]*>/);
  assert.match(html, /<input id="rp-search"[^>]*role="combobox"/);
  assert.match(html, /<div id="rp-list"[^>]*role="listbox"/);
});

test('log notice css: the head of a collapsed pane shows it; an open pane shows the line in the log; the empty placeholder is the empty log', () => {
  const css = read('style.css');
  assert.match(css, /\.log-pane:not\(\.collapsed\) \.log-notice\s*\{\s*display:\s*none/);
  assert.match(css, /\.log-pane\.collapsed \.log\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /\.log-pane\.collapsed[^{]*\.log-notice/, 'a collapsed pane does not hide its head\'s notice');
  assert.match(css, /\.log \.ll\.notice/);
  assert.match(read('index.html'), /<div class="log-head">[\s\S]*<span id="log-notice"[^>]*hidden><\/span>[\s\S]*<\/div>\s*<div id="log" class="log"/, 'the notice is in the head, not between the head and the log');
});

// ---- the code of the page: what writes where, timers and listeners ------------------------------------------------------------------------------

test('page code: the whole-region rewrites are gone; the string writes that are left are guarded one-string boxes, and no timer or listener was added', () => {
  const app = read('app.js');
  const writes = app.split('\n').filter((l) => /\.innerHTML\s*=(?!=)/.test(l)).map((l) => l.trim().replace(/\s*\/\/.*$/, ''));
  assert.deepEqual(writes, ['if (prev === undefined || !morphHtml(el, prev, html)) el.innerHTML = html;'],
    'setHtml: guarded by the string it wrote last, patched against it, written whole only the first time or where a patch cannot be made');
  assert.match(app, /if \(prev === html\) return;/);
  const setHtmlCalls = [...app.matchAll(/(?<!function )setHtml\(([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(setHtmlCalls, ['$(\'#log-meta\')', '$(\'#registered-edges-note\')', 'e', 'empty', 'head', 'p.head', 'panel'].sort(), 'the notes, the empty states, the hover panel and the head of a lane: one string each');
  assert.doesNotMatch(app, /setHtml\(\$\('#report'\)|setHtml\(axis|setHtml\(\$\('#tl-axis'\)|state\.reportHtml|selectHtml|historyInner/);
  assert.match(app, /lists\.axis\.sync\(/);
  assert.match(app, /lists\.report\.sync\(/);
  assert.match(app, /grid: listOf\(\$\('#matrix-grid'\), \{ create: makeNode, update: updateNode \}\)/, 'the matrix takes groups: the label of a row holds its toggle as a keyed child');
  assert.equal([...app.matchAll(/setInterval\(/g)].length, 1);
  assert.equal([...app.matchAll(/setTimeout\(/g)].length, 5, 'H1: plus the one-shot reset of the copy button label; replay pause pace: plus the replay frame queue\'s timer; run search: plus the search debounce');
  assert.doesNotMatch(app, /setTimeout\([^)]*blur|onblur|#run-select'\)\.onchange/, 'the picker closes by focusout and clicks, not by a timer, and the select is gone');
  // one document-level listener for the click, one for the keys, added once at load
  assert.equal([...app.matchAll(/document\.addEventListener\('click'/g)].length, 1);
  assert.equal([...app.matchAll(/document\.addEventListener\('keydown'/g)].length, 1);
  assert.equal([...app.matchAll(/focusout/g)].length, 1);
});

test('page code: the data strings of the picker and the report reach the page through esc(); the picker never puts a value into a class name', () => {
  const app = read('app.js');
  for (const needle of ['esc(o.title)', 'esc(o.text)', 'esc(x.text)', 'esc(p.status)', 'esc(p.source)', 'esc(fmtStart(p.startedAt))', 'esc(p.rest)', 'esc(h.note)', 'esc(g.title)', 'esc(backlogNotice(state.backlogError))']) assert.ok(app.includes(needle), needle);
  assert.match(app, /class="tag \$\{runStatusClass\(p\.status\)\}"/, 'the status class is a fixed class from a table');
  assert.match(app, /'data-run': p\.id/, 'the run id is a raw attribute');
  assert.doesNotMatch(app, /data-agent[^\n]*data-run|data-run[^\n]*data-agent/, 'a row is not an agent, a unit or a view for the click handler');
});

// =====================================================================================================================
// flicker, the html inside an element: patched in place, never written again with the same pieces in it
// =====================================================================================================================

test('parseHtml: the html the page writes, as data - texts, elements, quoted attributes, the five entities of esc(), void tags; the line feed after <pre> goes as a browser drops it', () => {
  assert.deepEqual(parseFragment('a <b class="x y" title="q &amp; &quot;z&quot;">B &lt;1&gt; &#39;s&#39;</b> c<br>d<!-- note --><span></span>'), [
    'a ', { tag: 'b', attrs: { class: 'x y', title: 'q & "z"' }, kids: ["B <1> 's'"] }, ' c', { tag: 'br', attrs: {}, kids: [] }, 'd', { tag: 'span', attrs: {}, kids: [] },
  ]);
  assert.deepEqual(parseFragment(''), []);
  assert.deepEqual(parseFragment(undefined), []);
  assert.deepEqual(parseFragment('<pre>\nx\n</pre><pre>\n\ny</pre>'), [{ tag: 'pre', attrs: {}, kids: ['x\n'] }, { tag: 'pre', attrs: {}, kids: ['\ny'] }]);
  // an entity the page never writes stays as it is; a number is its character, unless it is no character
  assert.deepEqual(parseFragment('&nbsp;&#x41;&#66;&#0;&#1114112;'), ['&nbsp;AB&#0;&#1114112;']);
  // a line end is a line feed, as the browser reads it
  assert.deepEqual(parseFragment('a\r\nb\rc<i title="x\r\ny">d</i>'), ['a\nb\nc', { tag: 'i', attrs: { title: 'x\ny' }, kids: ['d'] }]);
  // a stray < is text; an element left open is closed at the end; a closing tag with no element is ignored
  assert.deepEqual(parseFragment('1 < 2</i><u>x'), ['1 < 2', { tag: 'u', attrs: {}, kids: ['x'] }]);
  // what esc() writes comes back as the data it was written from, in a text and in an attribute
  const data = `<a href="x">&amp; 'q' & "d" … \n tab\t`;
  assert.deepEqual(parseFragment(`<span title="${lib.esc(data)}">${lib.esc(data)}</span>`), [{ tag: 'span', attrs: { title: data }, kids: [data] }]);
});

// a small box (an element of the fake browser) that holds some html, and what is made, removed and written when it is patched
function box(html) {
  const doc = { listeners: {}, activeElement: null, blurIfInside() {}, mut: null };
  doc.note = recorder(doc);
  doc.createElement = (t) => new El(doc, t);
  doc.createTextNode = (d) => new TextNode(doc, d);
  const el = new El(doc, 'div');
  el.innerHTML = html;
  return { doc, el };
}
const nodesOf = (el) => {
  const out = [];
  const walk = (n) => { out.push(n); n.childNodes.forEach(walk); };
  el.childNodes.forEach(walk);
  return out;
};
// two lists of nodes are the very same nodes (deepEqual would take two nodes with the same content for one)
const sameNodes = (a, b, msg) => assert.ok(a.length === b.length && a.every((n, i) => n === b[i]), msg);
// the nodes of an element as data with sorted attributes (two attributes in another order are the same element), and the same for parsed html
const domTree = (el) => el.childNodes.map((n) => (n.nodeType === 3 ? n.data : { tag: n.tag, attrs: Object.fromEntries([...n.attrs].sort(([a], [b]) => a.localeCompare(b))), kids: domTree(n) }));
const sortedTree = (nodes) => nodes.map((n) => (typeof n === 'string' ? n : { tag: n.tag, attrs: Object.fromEntries(Object.entries(n.attrs).sort(([a], [b]) => a.localeCompare(b))), kids: sortedTree(n.kids) }));
function treeHtml(nodes) {
  return nodes.map((n) => {
    if (typeof n === 'string') return escS(n);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escS(v)}"`).join('');
    return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${treeHtml(n.kids)}</${n.tag}>`;
  }).join('');
}
// html patched from prev to next: the nodes before and after, which of them were made, are gone and were written
function morphed(prev, next) {
  const { doc, el } = box(prev);
  const before = nodesOf(el);
  const writes = new Map(before.map((n) => [n, n.writes]));
  doc.mut = [];
  assert.equal(morphHtml(el, prev, next), true);
  const after = nodesOf(el);
  return {
    el, doc, before, after,
    made: after.filter((n) => !writes.has(n)),
    gone: before.filter((n) => !after.includes(n)),
    written: after.filter((n) => writes.has(n) && n.writes !== writes.get(n)),
  };
}
// the nodes that a change took out and a rewrite put back as new ones with the same content: what a MutationObserver sees as flicker
function identicalReadds(records) {
  const out = [];
  for (const r of records) {
    if (r.type === 'remove' && records.some((a) => a.type === 'add' && a.parent === r.parent && a.node !== r.node && a.ser === r.ser)) out.push(r.ser);
  }
  return out;
}

test('morphHtml: one text that changed is the only write; an unchanged label, element or neighbour keeps its node', () => {
  const m = morphed('elapsed <span class="fact prov-inferred" title="t">13s</span> <small>why</small>', 'elapsed <span class="fact prov-inferred" title="t">14s</span> <small>why</small>');
  assert.equal(m.el.html, 'elapsed <span class="fact prov-inferred" title="t">14s</span> <small>why</small>');
  assert.equal(m.made.length + m.gone.length, 0, 'no node made, no node removed');
  assert.deepEqual(m.written.map((n) => n.data), ['14s'], 'the one text node that changed');
  assert.equal(m.el.htmlWrites, 1, 'only the creation wrote innerHTML');
  assert.deepEqual(identicalReadds(m.doc.mut), []);
});

test('morphHtml: a child added at the start or the end, or taken out of the middle, moves no other child and writes none', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => `<div class="r">row ${i}</div>`).join('');
  const add = morphed(rows(4), `<div class="r">new</div>${rows(4)}`);
  assert.equal(add.el.html, `<div class="r">new</div>${rows(4)}`);
  assert.equal(add.made.length, 2, 'the new row and its text');
  assert.equal(add.gone.length + add.written.length, 0, 'the four old rows are as they were');
  sameNodes(add.el.childNodes.slice(1), add.before.filter((n) => n.nodeType === 1), 'the same four elements, in order');
  const end = morphed(rows(4), `${rows(4)}<div class="r">last</div>`);
  assert.equal(end.made.length, 2);
  assert.equal(end.gone.length + end.written.length, 0);
  const mid = morphed(rows(4), `<div class="r">row 0</div><div class="r">row 1</div><div class="r">row 3</div>`);
  assert.equal(mid.gone.length, 2, 'the row that went, with its text');
  assert.equal(mid.made.length + mid.written.length, 0, 'the row after it is not rewritten to say what the removed one said');
  assert.deepEqual(mid.doc.mut.map((r) => r.type), ['remove']);
});

test('morphHtml: an attribute that changed or went is written to its element only; another tag is another element; empty and filled boxes', () => {
  const a = morphed('<span class="a" title="t1">x</span><i>y</i>', '<span class="a" title="t2">x</span><i>y</i>');
  assert.equal(a.made.length + a.gone.length, 0);
  assert.deepEqual(a.written.map((n) => n.tag), ['span']);
  assert.equal(a.written[0].getAttribute('title'), 't2');
  const b = morphed('<span class="a" title="t1">x</span>', '<span class="a">x</span>');
  assert.equal(b.written[0].hasAttribute('title'), false);
  assert.equal(b.el.html, '<span class="a">x</span>');
  const c = morphed('<span>x</span>', '<b>x</b>');
  assert.equal(c.el.html, '<b>x</b>');
  assert.deepEqual([c.gone.length, c.made.length], [2, 2], 'the element and its text were replaced');
  const d = morphed('<b>1</b> · <b>2</b>', '<b>1</b> · <b>2</b><i>3</i>');
  assert.deepEqual([d.made.length, d.gone.length, d.written.length], [2, 0, 0]);
  const e = morphed('', '<p>x</p>tail');
  assert.equal(e.el.html, '<p>x</p>tail');
  const f = morphed('<p>x</p>tail', '');
  assert.equal(f.el.html, '');
  assert.equal(f.el.childNodes.length, 0);
  const g = morphed('text', '<div>y</div>');
  assert.equal(g.el.html, '<div>y</div>', 'a text became an element');
  const h = morphed('<b>1</b>', '<b>1</b>');
  assert.deepEqual([h.made.length, h.gone.length, h.written.length], [0, 0, 0], 'the same html: nothing');
});

test('morphHtml: where the box holds something else than the html says, it is drawn again node by node and ends up as the new html; where it cannot patch it says so and writes nothing', () => {
  const { el } = box('<b>1</b>');
  assert.equal(morphHtml(el, '<i>1</i><u>2</u>', '<b>2</b>'), true);
  assert.equal(el.html, '<b>2</b>', 'drawn from what the new html says');
  assert.equal(el.htmlWrites, 1, 'not by innerHTML');
  const plain = { childNodes: [], innerHTML: 'kept' };
  assert.equal(morphHtml(plain, 'a', 'b'), false, 'a box of a document that makes no text nodes');
  assert.equal(plain.innerHTML, 'kept');
  const svg = new El({ createElement() {}, createTextNode() {}, note() {} }, 'path', 'http://www.w3.org/2000/svg');
  assert.equal(morphHtml(svg, '<title>a</title>', '<title>b</title>'), false, 'an element of SVG');
  assert.equal(morphHtml(box('x').el, undefined, 'y'), false, 'nothing was drawn before');
});

// a small generator of html, to try the patch on many pairs: the second html is the first one changed in a few places
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TEXTS = ['a', 'b ', ' · ', 'x & y', '<z>', '"q"', 'long text here'];
const TAGS = ['span', 'b', 'small', 'div'];
const pick = (r, list) => list[Math.floor(r() * list.length)];
function randKids(r, depth) {
  const out = [];
  for (let i = Math.floor(r() * 5); i > 0; i--) {
    if (depth >= 3 || r() < 0.4) { const t = pick(r, TEXTS); if (typeof out.at(-1) === 'string') out[out.length - 1] += t; else out.push(t); } else out.push(randEl(r, depth));
  }
  return out;
}
function randEl(r, depth) {
  const attrs = {};
  if (r() < 0.6) attrs.class = pick(r, ['c1', 'c2', 'c1 c2']);
  if (r() < 0.3) attrs.title = pick(r, TEXTS);
  return { tag: pick(r, TAGS), attrs, kids: randKids(r, depth + 1) };
}
function editOne(r, kids) {
  const p = r();
  if (!kids.length || p < 0.25) { kids.splice(Math.floor(r() * (kids.length + 1)), 0, r() < 0.5 ? pick(r, TEXTS) : randEl(r, 2)); return; }
  const i = Math.floor(r() * kids.length);
  const k = kids[i];
  if (p < 0.4) { kids.splice(i, 1); return; }
  if (typeof k === 'string') { kids[i] = pick(r, TEXTS); return; }
  if (p < 0.55) k.attrs.title = pick(r, TEXTS);
  else if (p < 0.65) delete k.attrs.class;
  else if (p < 0.72) k.tag = pick(r, TAGS);
  else editOne(r, k.kids);
}
function mergeText(kids) {
  const out = [];
  for (const k of kids) {
    const m = typeof k === 'string' ? k : { ...k, kids: mergeText(k.kids) };
    if (typeof m === 'string' && typeof out.at(-1) === 'string') out[out.length - 1] += m; else out.push(m);
  }
  return out;
}

test('morphHtml: for many pairs of html the box ends up as the new html, and the children in front of the first change keep their nodes', () => {
  const r = rng(20261109);
  let kept = 0;
  for (let n = 0; n < 400; n++) {
    const a = randKids(r, 0);
    const b = structuredClone(a);
    for (let e = 1 + Math.floor(r() * 3); e > 0; e--) editOne(r, b);
    const next = mergeText(b);
    const prevHtml = treeHtml(a);
    const nextHtml = treeHtml(next);
    const m = morphed(prevHtml, nextHtml);
    assert.deepEqual(domTree(m.el), sortedTree(parseFragment(nextHtml)), `pair ${n}: ${prevHtml}  ->  ${nextHtml}`);
    assert.equal(m.el.htmlWrites, 1, `pair ${n}: no innerHTML`);
    for (const node of nodesOf(m.el)) assert.ok(node.parentNode === m.el || nodesOf(m.el).includes(node.parentNode), 'every node hangs in the box');
    // the children in front of the first one that differs are the very nodes that were there
    const was = parseFragment(prevHtml);
    const now = parseFragment(nextHtml);
    let same = 0;
    while (same < was.length && same < now.length && JSON.stringify(was[same]) === JSON.stringify(now[same])) same++;
    for (let i = 0; i < same; i++) assert.equal(m.el.childNodes[i], m.before.filter((x) => x.parentNode === m.el)[i], `pair ${n}: child ${i} kept`);
    if (same > 0) kept++;
    if (prevHtml === nextHtml) assert.equal(m.doc.mut.length + m.written.length, 0, 'the same html is not written');
  }
  assert.ok(kept > 100, `the pairs did share their first children (${kept} of 400)`);
});

test('flicker detector: a rewrite that puts back the same pieces is found, a patch of one text is not', () => {
  const { doc, el } = box('<span>elapsed </span><b>1</b>');
  doc.mut = [];
  el.innerHTML = '<span>elapsed </span><b>2</b>';
  assert.deepEqual(identicalReadds(doc.mut), ['<span>elapsed </span>'], 'the label was taken out and put back');
  doc.mut = [];
  assert.equal(morphHtml(el, '<span>elapsed </span><b>2</b>', '<span>elapsed </span><b>3</b>'), true);
  assert.deepEqual(identicalReadds(doc.mut), []);
  // a node that only moves is not a new one
  const two = box('<i>1</i><u>2</u>');
  two.doc.mut = [];
  two.el.insertBefore(two.el.childNodes[1], two.el.childNodes[0]);
  assert.deepEqual(identicalReadds(two.doc.mut), []);
});

// ---- the page: a replayed stream, every mutation recorded -------------------------------------------------------------------

async function replayMutations(view, { expandUnits = false, drawer = false } = {}) {
  const fx = await fixtureStream();
  const FIRST = 8;
  for (let i = 0; i < FIRST; i++) fx.apply(i);
  const run0 = structuredClone(fx.store.getRun(FIXTURE_RUN));
  const page = await bootPage({ storage: { 'wfviz.view': view }, runs: fx.store.listRuns(), runDocs: { [FIXTURE_RUN]: run0 }, events: { [FIXTURE_RUN]: fx.uis.slice() } });
  try {
    if (expandUnits) for (const b of allEls(page).filter((e) => e.tag === 'button' && e.attrs.has('data-unit'))) await page.click(b);
    if (drawer) {
      const cell = allEls(page).find((e) => e.attrs.has('data-agent') && (e.classes.has('cell') || e.classes.has('acard') || e.classes.has('tl-bar')));
      assert.ok(cell, 'an agent to open');
      await page.click(cell);
      assert.equal(page.el('#drawer').hidden, false);
    }
    const regions = [...REGIONS, '#log-meta', '#log-count', '#matrix-note', '#matrix-empty', '#registered-edges-note', '#hover'];
    const readds = [];
    const rewrites = [];
    let records = 0;
    for (let i = FIRST; i < fx.raw.length; i++) {
      const { ui, run } = fx.apply(i);
      const els = allEls(page, regions);
      const htmlWrites = new Map(els.map((e) => [e, e.htmlWrites]));
      page.doc.mut = [];
      for (const e of ui) page.emit('event', e);
      page.emit('run', run);
      await page.flush();
      records += page.doc.mut.length;
      for (const x of identicalReadds(page.doc.mut)) readds.push(`event ${i}: ${x.slice(0, 120)}`);
      for (const e of els) if (e.htmlWrites !== htmlWrites.get(e) && htmlWrites.has(e)) rewrites.push(`event ${i}: ${e.tag}.${[...e.classes].join('.')} (${e.htmlWrites - htmlWrites.get(e)} innerHTML writes)`);
    }
    page.doc.mut = null;
    return { readds, rewrites, records, steps: fx.raw.length - FIRST };
  } finally {
    page.restore();
  }
}

for (const [name, opts] of [['matrix with a unit history open', { view: 'matrix', expandUnits: true }], ['matrix with the drawer of an agent open', { view: 'matrix', drawer: true }],
  ['phases', { view: 'phases' }], ['phases with the drawer open', { view: 'phases', drawer: true }], ['timeline', { view: 'timeline' }]]) {
  test(`flicker, ${name}: over a replayed stream no node is removed and put back with the same content, and no element has its innerHTML written again`, async () => {
    const { view, ...rest } = opts;
    const r = await replayMutations(view, rest);
    assert.ok(r.steps >= 20 && r.records > 100, `the stream did draw (${r.steps} steps, ${r.records} mutations)`);
    assert.deepEqual(r.readds, [], 'nodes taken out and put back identical');
    assert.deepEqual(r.rewrites, [], 'elements rewritten whole');
  });
}

test('header stat: when one value changes only its own text is written; the label, the element of the value and every other stat keep their nodes', async () => {
  const mk = (tokens, running) => wfRun([agent('a', 'w:U', { state: reg('running') })], { totals: { agents: 1, running, done: 0, failed: 0, tokens: reg(tokens) } });
  const r1 = mk(100, 1);
  const page = await bootPage({ runs: [summary(r1)], runDocs: { wf_1: r1 } });
  try {
    const stat = (name) => page.el('#run-status').childNodes.find((c) => c.html.startsWith(name));
    const tokens = stat('tokens');
    const kids = nodesOf(tokens);
    assert.deepEqual(kids.map((n) => n.nodeType), [3, 1, 3], 'the label, the fact, its number');
    const others = page.el('#run-status').childNodes.filter((c) => c !== tokens).flatMap((c) => [c, ...nodesOf(c)]);
    const othersWrites = others.map((n) => n.writes);
    const kidWrites = kids.map((n) => n.writes);
    page.doc.mut = [];
    await page.snapshot(mk(250, 1));
    assert.match(tokens.html, />250</);
    sameNodes(nodesOf(tokens), kids, 'the same nodes');
    assert.deepEqual(kids.map((n, i) => n.writes - kidWrites[i]), [0, 0, 1], 'the label "tokens " and the element of the value were not written, the text of the value was');
    assert.equal(tokens.htmlWrites, 1, 'the stat was not rewritten as html');
    assert.deepEqual(others.map((n) => n.writes), othersWrites, 'no other stat was written');
    assert.deepEqual(page.doc.mut.filter((m) => m.type !== 'text'), [], 'nothing was made or taken out');
    // a stat that comes (a count that was zero) is a new element; the rest stays
    const r3 = mk(250, 1);
    r3.totals.failed = 2;
    page.doc.mut = [];
    await page.snapshot(r3);
    assert.ok(stat('failed'), 'the new stat');
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove'), [], 'nothing was taken out for it');
  } finally {
    page.restore();
  }
});

test('log line: a line that is timed again when its snapshot arrives keeps its element and every cell of it; only the time cell is patched', async () => {
  const r0 = wfRun([]);
  const page = await bootPage({ runs: [summary(r0)], runDocs: { wf_1: r0 }, events: { wf_1: [] } });
  try {
    await page.event(uev(1, { runId: 'wf_1', kind: 'agent.started', agentId: 'a1', label: 'x:y', message: 'started' }));
    const [line] = page.el('#log').childNodes;
    assert.ok(line.classes.has('ll'));
    const cells = [...line.childNodes];
    const time = cells[0];
    assert.equal(time.getAttribute('title'), 'event time (may be a file time)', 'first: the time of the event');
    const first = time.html;
    const lineWrites = line.htmlWrites;
    page.doc.mut = [];
    // the snapshot that holds the agent (its own start time) comes after the event
    await page.snapshot(wfRun([agent('a1', 'x:y', { startedAt: inf(5000), state: reg('running') })]));
    assert.equal(page.el('#log').childNodes[0], line, 'the same line');
    sameNodes([...line.childNodes], cells, 'the same cells: the separators, the actor, the message');
    assert.notEqual(time.html, first, 'the time changed');
    assert.ok(time.classes.has('agent-time'));
    assert.match(time.getAttribute('title'), /^agent start time/);
    assert.equal(line.htmlWrites, lineWrites, 'the line was not written as html');
    assert.deepEqual(page.doc.mut.filter((m) => m.parent === line || m.parent === time && m.type !== 'text'), [], 'no cell of the line was taken out or made');
    assert.deepEqual(identicalReadds(page.doc.mut), []);
    // and once more, when the final file gives the time
    page.doc.mut = [];
    await page.snapshot(wfRun([agent('a1', 'x:y', { startedAt: reg(5000, 'wf.json#workflowProgress[0].startedAt'), state: reg('running') })]));
    sameNodes([...line.childNodes], cells, 'the same cells again');
    assert.match(time.getAttribute('title'), /agent start time \(registered/);
    assert.deepEqual(identicalReadds(page.doc.mut), []);
  } finally {
    page.restore();
  }
});

// ---- the picker dropdown stays in the window; its list scrolls by itself --------------------------------------------------------

test('scrollToShow: the least movement that brings a row into the view of a scrolled list; a list with no layout stays where it is', () => {
  const v = { height: 50, viewHeight: 80 };
  assert.equal(scrollToShow({ top: 0, scrollTop: 0, ...v }), 0);
  assert.equal(scrollToShow({ top: 20, scrollTop: 0, ...v }), 0, 'in view already');
  assert.equal(scrollToShow({ top: 50, scrollTop: 0, ...v }), 20, 'below: its bottom at the bottom');
  assert.equal(scrollToShow({ top: 100, scrollTop: 70, ...v }), 70, 'its bottom is the bottom of the view: in view');
  assert.equal(scrollToShow({ top: 50, scrollTop: 70, ...v }), 50, 'above: its top at the top');
  assert.equal(scrollToShow({ top: 10, height: 200, scrollTop: 40, viewHeight: 80 }), 10, 'a row taller than the view: its top');
  assert.equal(scrollToShow({ top: -5, height: 10, scrollTop: 40, viewHeight: 80 }), 0, 'never above the start');
  for (const bad of [undefined, NaN, Infinity, '12']) assert.equal(scrollToShow({ top: bad, height: 50, scrollTop: 33, viewHeight: 80 }), 33, `a row top of ${bad}`);
  assert.equal(scrollToShow({ top: 0, height: 50, scrollTop: 33, viewHeight: 0 / 0 }), 33);
});

test('picker dropdown: fixed to the window with 14 px at both sides and never wider than the window less both; no call scrolls a box above the list or the page', () => {
  const css = read('style.css');
  const app = read('app.js');
  const panel = /\.rp-panel\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(panel, /position:\s*fixed/, 'fixed to the window: it cannot make the page scroll sideways');
  assert.match(panel, /(?:^|[;\s])left:\s*14px/);
  assert.match(panel, /(?:^|[;\s])right:\s*14px/);
  assert.match(panel, /width:\s*min\(780px,\s*calc\(100vw - 28px\)\)/, 'the window less the two gutters');
  assert.match(panel, /margin:[^;]*auto/, 'centred when narrower than the window');
  assert.doesNotMatch(panel, /(?:^|[;\s])(?:top|bottom):/, 'its place below the button is the place it has in the flow');
  const code = app.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n'); // the comments say what is not done
  assert.doesNotMatch(code, /scrollIntoView/, 'it scrolls every box above the row, the page included');
  assert.equal([...code.matchAll(/\.focus\?\.\(\{ preventScroll: true \}\)/g)].length, 2, 'a focus that does not scroll');
  assert.doesNotMatch(code, /\.focus\?\.\(\)|\.focus\(\)/);
  assert.match(code, /scrollToShow\(\{ top: row\.offsetTop, height: row\.offsetHeight, scrollTop: list\.scrollTop, viewHeight: list\.clientHeight \}\)/);
});

// ---- run history: the picker's range, filters and the runs that are only listed ----------------------------------------------------------------

// a list item as GET /api/runs gives it in real mode, with `loaded`
const histItem = (id, over = {}) => ({
  id, source: 'real', name: reg(`run ${id}`), status: fin('completed'), project: '-Users-x-a', startedAt: inf(Date.now() - 3600e3), agents: 2, running: 0, loaded: true, ...over,
});
const histDoc = (id, over = {}) => run([agent(`${id}-a1`, 'w:U')], { id, name: reg(`run ${id}`), status: fin('completed'), startedAt: inf(Date.now() - 3600e3), totals: { agents: 1, running: 0, done: 1, failed: 0 }, ...over });
const rowIds = (page) => rowsOf(page).map((r) => r.attrs.get('data-run')).filter(Boolean); // (the line "no run matches" is no run)
const setControl = async (page, sel, value) => { const el = page.el(sel); el.value = value; el.dispatch('change'); await page.flush(); };
const switchAll = async (page, on) => { const el = page.el('#rp-all'); el.checked = on; el.dispatch('change'); await page.flush(); };
const optionValues = (page, sel) => page.el(sel).childNodes.map((o) => o.attrs.get('value'));

test('run history: the picker shows the last 24 h; the switch "all" shows every run and writes #range=all; a reload with that hash comes back as it was', async () => {
  const list = [histItem('wf_new'), histItem('wf_old', { startedAt: inf(Date.now() - 5 * DAY), loaded: false }), histItem('wf_nostart', { startedAt: unk('no agent started'), loaded: false })];
  const docs = { wf_new: histDoc('wf_new') };
  const page = await bootPage({ runs: list, runDocs: docs });
  try {
    await open(page);
    assert.deepEqual(rowIds(page), ['wf_new'], 'the last 24 h: the run of 5 days ago and the run with no known start are not there');
    assert.equal(page.el('#rp-count').text, '1 of 3 runs');
    assert.equal(page.el('#rp-all').checked, false);
    assert.equal(location.hash, '', 'the default state writes no hash');
    await switchAll(page, true);
    assert.deepEqual(rowIds(page), ['wf_new', 'wf_old', 'wf_nostart']);
    assert.equal(page.el('#rp-count').text, '3 of 3 runs');
    assert.equal(location.hash, '#range=all');
    await switchAll(page, false);
    assert.deepEqual(rowIds(page), ['wf_new']);
    assert.equal(location.hash, '', 'back to the default: the hash goes');
    await switchAll(page, true);
  } finally {
    page.restore();
  }
  const again = await bootPage({ runs: list, runDocs: docs, hash: '#range=all' }); // the reload
  try {
    await open(again);
    assert.deepEqual(rowIds(again), ['wf_new', 'wf_old', 'wf_nostart']);
    assert.equal(again.el('#rp-all').checked, true, 'the switch shows the state of the hash');
  } finally {
    again.restore();
  }
});

test('run history: project (the directory name as on disk), status, from and to filter the rows and the hash follows; each control offers the list\'s own values', async () => {
  const list = [
    histItem('a', { project: '-Users-x-a' }),
    histItem('b', { project: '-Users-x-b', status: fin('failed') }),
    histItem('c', { project: '-Users-x-b', startedAt: inf(new Date(2026, 0, 5, 10).getTime()) }),
  ];
  const page = await bootPage({ runs: list, runDocs: { a: histDoc('a') }, hash: '#range=all' });
  try {
    await open(page);
    assert.deepEqual(optionValues(page, '#rp-projects'), ['-Users-x-a', '-Users-x-b'], 'the names as on disk: dashes stay dashes');
    assert.deepEqual(optionValues(page, '#rp-statuses'), ['completed', 'failed']);
    await setControl(page, '#rp-project', '-Users-x-b');
    assert.deepEqual(rowIds(page), ['b', 'c']);
    assert.equal(location.hash, '#range=all&project=-Users-x-b');
    await setControl(page, '#rp-status', 'failed');
    assert.deepEqual(rowIds(page), ['b']);
    assert.equal(location.hash, '#range=all&project=-Users-x-b&status=failed');
    // something that is not one of the list's values is "all" again, and the field says so
    await setControl(page, '#rp-project', '-Users-nope');
    assert.equal(page.el('#rp-project').value, '');
    assert.equal(location.hash, '#range=all&status=failed');
    await setControl(page, '#rp-status', '');
    assert.deepEqual(rowIds(page), ['a', 'b', 'c']);
    await setControl(page, '#rp-from', '2026-01-05');
    await setControl(page, '#rp-to', '2026-01-05');
    assert.deepEqual(rowIds(page), ['c'], 'the local day, both ends included');
    assert.equal(location.hash, '#range=all&from=2026-01-05&to=2026-01-05');
    await setControl(page, '#rp-to', '2026-01-04');
    assert.deepEqual(rowIds(page), []);
    assert.match(rowsOf(page)[0].html, /no run matches the filters/);
    await setControl(page, '#rp-from', '');
    await setControl(page, '#rp-to', '');
    assert.equal(location.hash, '#range=all');
    assert.deepEqual(rowIds(page), ['a', 'b', 'c']);
  } finally {
    page.restore();
  }
});

test('run history: invalid hash values are ignored with the defaults; a project or status the list does not have is reset and the hash rewritten; a hash change is read', async () => {
  const list = [histItem('a', { project: '-Users-x-a' }), histItem('b', { project: '-Users-x-b', status: fin('failed') })];
  const page = await bootPage({ runs: list, runDocs: { a: histDoc('a') }, hash: '#range=week&from=2026-02-30&to=nope&project=-Users-gone&status=nope&foo=1' });
  try {
    await open(page);
    assert.deepEqual(rowIds(page), ['a', 'b'], 'the defaults: the last 24 h, nothing else');
    assert.equal(location.hash, '', 'what the list does not have is reset to all, and the hash rewritten');
    assert.equal(page.el('#rp-all').checked, false);
    // the hash is changed by hand
    location.hash = '#range=all&status=failed';
    for (const fn of page.windowListeners.hashchange) fn({});
    await page.flush();
    assert.deepEqual(rowIds(page), ['b']);
    assert.equal(page.el('#rp-all').checked, true);
    assert.equal(page.el('#rp-status').value, 'failed');
    location.hash = '#status=nope';
    for (const fn of page.windowListeners.hashchange) fn({});
    await page.flush();
    assert.equal(location.hash, '', 'a status that is not in the list is reset');
    assert.equal(page.windowListeners.hashchange.length, 1, 'one hashchange listener');
  } finally {
    page.restore();
  }
});

test('run history: the text filter is hash state (q); it is kept when the picker is closed and opened, and a reload shows it', async () => {
  const list = [histItem('wf_a', { name: reg('Alpha') }), histItem('wf_b', { name: reg('Beta') })];
  const page = await bootPage({ runs: list, runDocs: { wf_a: histDoc('wf_a') } });
  try {
    await open(page);
    await page.type('beta');
    assert.deepEqual(rowIds(page), ['wf_b']);
    assert.equal(location.hash, '#q=beta');
    await page.click(page.el('#rp-trigger'));
    await open(page);
    assert.equal(page.el('#rp-search').value, 'beta');
    assert.deepEqual(rowIds(page), ['wf_b']);
    await page.type('');
    assert.equal(location.hash, '', 'cleared: the default');
  } finally {
    page.restore();
  }
  const again = await bootPage({ runs: list, runDocs: { wf_a: histDoc('wf_a') }, hash: '#q=beta' });
  try {
    await open(again);
    assert.equal(again.el('#rp-search').value, 'beta');
    assert.deepEqual(rowIds(again), ['wf_b']);
  } finally {
    again.restore();
  }
});

test('run history: a run that is only listed says "not loaded - opens on click"; choosing it shows "loading...", asks for the run before its events, and the row becomes a loaded one; the other rows keep their nodes', async () => {
  const list = [histItem('wf_new'), histItem('wf_old', { startedAt: inf(Date.now() - 5 * DAY), loaded: false }), histItem('wf_other', { startedAt: inf(Date.now() - 2 * DAY) })];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const oldDoc = histDoc('wf_old', { startedAt: inf(Date.now() - 5 * DAY) });
  const page = await bootPage({
    runs: list, runDocs: { wf_new: histDoc('wf_new') }, events: { wf_old: wfEvents(1, 2, { runId: 'wf_old' }) }, hash: '#range=all',
    answer: (u) => (u === '/api/runs/wf_old' ? gate.then(() => ({ ok: true, status: 200, json: async () => structuredClone(oldDoc) })) : undefined),
  });
  try {
    assert.ok(!page.requests.includes('/api/runs/wf_old'), 'the first page opens a loaded run, never an unasked load');
    await open(page);
    assert.match(rowOf(page, 'wf_old').textContent, /not loaded - opens on click/);
    assert.ok(rowOf(page, 'wf_old').classes.has('unloaded'));
    assert.doesNotMatch(rowOf(page, 'wf_new').textContent, /not loaded|loading/);
    assert.doesNotMatch(rowOf(page, 'wf_other').textContent, /not loaded|loading/);
    const otherRow = rowOf(page, 'wf_other');
    const otherWrites = otherRow.writes;
    await page.click(rowOf(page, 'wf_old'));
    assert.match(page.el('#rp-note').textContent, /^loading\.\.\. wf_old$/);
    assert.equal(page.el('#rp-note').hidden, false);
    await open(page);
    assert.match(rowOf(page, 'wf_old').textContent, /loading\.\.\./);
    assert.doesNotMatch(rowOf(page, 'wf_old').textContent, /not loaded/);
    assert.equal(rowOf(page, 'wf_other'), otherRow, 'a row that has nothing to do with it is the same element');
    assert.equal(otherRow.writes, otherWrites, 'and was not written');
    assert.ok(!page.eventRequests().some((u) => /wf_old/.test(u)), 'the backlog is read after the run, not while it loads');
    release();
    await page.flush();
    assert.ok(page.eventRequests().some((u) => /wf_old\/events\?since=0/.test(u)));
    assert.equal(page.el('#rp-note').hidden, true);
    assert.doesNotMatch(rowOf(page, 'wf_old').textContent, /not loaded|loading/);
    assert.ok(!rowOf(page, 'wf_old').classes.has('unloaded'));
    assert.match(page.el('#rp-cur').textContent, /run wf_old/);
    assert.equal(rowOf(page, 'wf_other'), otherRow);
    assert.equal(otherRow.writes, otherWrites);
  } finally {
    page.restore();
  }
});

test('run history: a load that fails is a line with the reason (as text), the run stays listed-only, and choosing it again tries again', async () => {
  const list = [histItem('wf_new'), histItem('wf_old', { loaded: false })];
  let fail = true;
  const reason = '<img src=x onerror=alert(1)> cannot read journal.jsonl';
  const page = await bootPage({
    runs: list, runDocs: { wf_new: histDoc('wf_new') }, events: { wf_old: [] },
    answer: (u) => (u === '/api/runs/wf_old' && fail ? { ok: false, status: 500, json: async () => ({ error: reason }) } : undefined),
  });
  try {
    page.runDocs.wf_old = histDoc('wf_old');
    await open(page);
    await page.click(rowOf(page, 'wf_old'));
    assert.equal(page.el('#rp-note').textContent, `could not load wf_old: ${reason}`, 'the reason, verbatim, as text');
    assert.ok(page.el('#rp-note').classes.has('err'));
    assert.equal(page.el('#rp-note').hidden, false);
    const empty = page.el('#matrix-empty');
    assert.match(empty.html, /could not load wf_old: &lt;img src=x onerror=alert\(1\)&gt;/, 'in the view too, escaped');
    assert.doesNotMatch(empty.html, /<img/);
    assert.ok(!page.eventRequests().some((u) => /wf_old/.test(u)), 'no backlog of a run that did not load');
    await open(page);
    assert.match(rowOf(page, 'wf_old').textContent, /not loaded - opens on click/, 'still only listed');
    fail = false;
    await page.click(rowOf(page, 'wf_old'));
    assert.equal(page.requests.filter((u) => u === '/api/runs/wf_old').length, 2, 'asked again');
    assert.equal(page.el('#rp-note').hidden, true);
    assert.equal(page.el('#rp-note').classes.has('err'), false);
    assert.match(page.el('#rp-cur').textContent, /run wf_old/);
  } finally {
    page.restore();
  }
});

test('run history: with no run loaded the first page opens none and says so; the picker still lists them', async () => {
  const list = [histItem('wf_old', { loaded: false }), histItem('wf_older', { loaded: false })];
  const page = await bootPage({ runs: list });
  try {
    assert.deepEqual(page.requests.filter((u) => /^\/api\/runs\/wf_/.test(u)), [], 'no run was asked for');
    assert.match(page.el('#matrix-empty').html, /No run is loaded yet/);
    await open(page);
    assert.deepEqual(rowIds(page), ['wf_old', 'wf_older']);
  } finally {
    page.restore();
  }
  // a running loaded run is the one the page opens, else the first loaded one
  const mixed = await bootPage({ runs: [histItem('wf_old', { loaded: false }), histItem('wf_done'), histItem('wf_run', { status: inf('running', 'no-final-file') })], runDocs: { wf_done: histDoc('wf_done'), wf_run: histDoc('wf_run') } });
  try {
    assert.ok(mixed.requests.includes('/api/runs/wf_run'));
    assert.ok(!mixed.requests.includes('/api/runs/wf_old'));
  } finally {
    mixed.restore();
  }
});

test('run history: a project, a name and a hash value with markup are text everywhere: rows, options, the search field', async () => {
  const bad = '<img src=x onerror=alert(1)>';
  const list = [histItem('wf_a', { project: bad, name: reg(bad) }), histItem('wf_b', { project: '-Users-ok' })];
  const page = await bootPage({ runs: list, runDocs: { wf_a: histDoc('wf_a', { name: reg(bad) }) }, hash: `#q=${encodeURIComponent('<b>')}` });
  try {
    await open(page);
    assert.equal(page.el('#rp-search').value, '<b>', 'a value of the hash goes in as a value');
    assert.match(rowsOf(page)[0].html, /no run matches/);
    await page.type('');
    const row = rowOf(page, 'wf_a');
    assert.match(row.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(row.html, /<img/);
    assert.deepEqual(optionValues(page, '#rp-projects'), ['-Users-ok', bad].sort(), 'an option carries the name as an attribute value, not as markup');
    for (const o of page.el('#rp-projects').childNodes) assert.equal(o.childNodes.length, 0, 'no text or markup inside an option');
  } finally {
    page.restore();
  }
});

test('run history: a snapshot patches by key: the rows, the options and the controls keep their nodes, and what is typed in a control is not overwritten', async () => {
  const list = [histItem('wf_a'), histItem('wf_b', { project: '-Users-x-b' })];
  const page = await bootPage({ runs: list, runDocs: { wf_a: histDoc('wf_a'), wf_b: histDoc('wf_b') }, hash: '#range=all' });
  try {
    await open(page);
    const rows = rowsOf(page).slice();
    const opts = page.el('#rp-projects').childNodes.slice();
    const writes = [...rows, ...opts, page.el('#rp-project'), page.el('#rp-all'), page.el('#rp-count')].map((e) => e.writes);
    page.el('#rp-project').value = '-Users-x'; // being typed: no change event yet
    await page.snapshot(structuredClone(histDoc('wf_a', { status: fin('failed') })));
    assert.equal(page.el('#rp-project').value, '-Users-x', 'what is typed stays');
    assert.deepEqual(rowsOf(page).slice(), rows, 'the same row elements');
    assert.deepEqual(page.el('#rp-projects').childNodes.slice(), opts, 'the same options');
    assert.deepEqual([...rows, ...opts, page.el('#rp-project'), page.el('#rp-all'), page.el('#rp-count')].map((e) => e.writes).slice(2), writes.slice(2), 'options, controls and count were not written');
    assert.match(rowOf(page, 'wf_a').textContent, /failed/, 'the one value that changed is patched');
  } finally {
    page.restore();
  }
});

// =====================================================================================================================
// usage and cost (node agent-tokens, P2): the four token counters of a run and of an agent with their provenance, and a cost line the page
// computes from the usage and GET /api/prices
// =====================================================================================================================

const tokUse = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite });
const TOK_HAIKU = tokUse(14, 840, 250741, 144816); // fixture wf_26eb8d70-5c4; at the prices below about $0.02103081
const TOK_PRICES = {
  source: 'openrouter', url: 'https://openrouter.ai/api/v1/models', fetchedAt: new Date(2026, 10, 12, 1, 7, 30).getTime(),
  models: {
    'anthropic/claude-haiku-5.5': { input: 0.0000001, output: 0.0000005, cacheRead: 0.00000001, cacheWrite: 0.000000125 },
    'anthropic/claude-opus-5': { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    'anthropic/claude-opus-5.5': { input: 0.000004, output: 0.00002 }, // no cache prices
  },
};
const tokMethod = 'sum-over-unique-message-id (3 messages in 4 records)';
// an ended run (final status) with usage; `usage` and `byModel` are the totals. The agent has its own usage, its own Agent.model (`model`: the
// final file's or the last record's) and its own byModel (`agentByModel`, else all its usage under `recordsModel`: the model its counted messages name)
const tokNoTranscript = 'no transcript seen for this agent; usage is read from transcript records only';
function tokRun({ usage = TOK_HAIKU, byModel = { 'claude-haiku-5-5': TOK_HAIKU }, agentUsage = usage, model = 'claude-haiku-5-5', recordsModel = 'claude-haiku-5-5', agentByModel, status = fin('completed'), over = {} } = {}) {
  const a = agent('a1', 'w:U', {
    model: reg(model, 'f:3'), tokens: fin(100),
    usage: agentUsage === null ? unk(tokNoTranscript) : inf(agentUsage, tokMethod),
    byModel: agentUsage === null ? unk(tokNoTranscript) : inf(agentByModel ?? { [recordsModel]: agentUsage }, 'sum by transcript model'),
  });
  return wfRun([a], {
    status, endedAt: fin(5000), durationMs: fin(4000),
    totals: {
      agents: 1, running: 0, done: 1, failed: 0, tokens: fin(100),
      usage: usage === null ? unk('no agent has a transcript record with usage yet') : inf(usage, 'sum-of-agent-usage (1 of 1 agents)'),
      byModel: byModel === null ? unk('no agent has a transcript record with usage yet') : inf(byModel, 'sum by transcript model'),
    },
    ...over,
  });
}
// answers GET /api/prices from the table below; everything else is left to the fake browser's own rules
const pricesAnswering = (body = TOK_PRICES) => (u) => (u === '/api/prices' ? { ok: true, status: 200, json: async () => structuredClone(body) } : undefined);
const priceRequests = (page) => page.requests.filter((u) => u.startsWith('/api/prices'));
const reportCells = (page) => page.el('#report').childNodes.filter((c) => c.classes.has('cell-r'));
const cellOf = (page, label) => reportCells(page).find((c) => c.childNodes[0].textContent === label);
const cellText = (page, label) => cellOf(page, label)?.childNodes[1].textContent;
const drawerRow = (page, label) => { const dt = page.el('#drawer-body').querySelectorAll('dt').find((d) => d.textContent === label); return dt ? dt.parentNode.childNodes[dt.parentNode.childNodes.indexOf(dt) + 1] : null; };
const openAgentDrawer = async (page, id = 'a1') => { await page.click(page.el('#matrix-grid').querySelectorAll('.cell').find((c) => c.attrs.get('data-agent') === id)); };
const HHMM = `${String(new Date(TOK_PRICES.fetchedAt).getHours()).padStart(2, '0')}:${String(new Date(TOK_PRICES.fetchedAt).getMinutes()).padStart(2, '0')}`;

test('usage and cost, report card: an ended run shows the four counters with their provenance and the cost line "~ $X (OpenRouter prices, fetched HH:MM)"', async () => {
  const r = tokRun();
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    assert.equal(page.el('#report-card').hidden, false);
    for (const [label, n] of [['input tokens', '14'], ['output tokens', '840'], ['cache read tokens', '250,741'], ['cache write tokens', '144,816']]) {
      const v = cellOf(page, label)?.childNodes[1];
      assert.ok(v, label);
      assert.equal(v.textContent, n, label);
      const fact = v.querySelector('.fact');
      assert.ok(fact.classes.has('prov-inferred'), `${label} is an inferred value`);
      assert.match(fact.getAttribute('title'), /^inferred: sum-of-agent-usage \(1 of 1 agents\)$/, `${label}: the tooltip names the method`);
    }
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    const cost = cellOf(page, 'cost').childNodes[1].querySelector('.fact');
    assert.ok(cost.classes.has('prov-inferred'));
    assert.match(cost.getAttribute('title'), /^inferred: tokens x OpenRouter prices per token of claude-haiku-5-5 -> anthropic\/claude-haiku-5\.5/);
    assert.match(cost.getAttribute('title'), /5-minute rate/);
    assert.match(page.el('#report').textContent, /Tokens and cost cover Claude Code agents only; other engines called from an agent are not in Claude Code files and are not counted\./);
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'asked once, with no query');
    // another snapshot of the same run: not asked again
    await page.snapshot(structuredClone(r));
    await page.snapshot(structuredClone(r));
    assert.deepEqual(priceRequests(page), ['/api/prices']);
  } finally {
    page.restore();
  }
});

test('usage and cost: while the list is out the line says loading; when it comes only the cost text is patched, no node of the card is made or removed', async () => {
  let release;
  const held = new Promise((res) => { release = res; });
  const r = tokRun();
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: (u) => (u === '/api/prices' ? held : undefined) });
  try {
    assert.equal(cellText(page, 'cost'), 'loading OpenRouter prices…');
    assert.equal(priceRequests(page).length, 1);
    const els = allEls(page, ['#report']);
    const writes = writesOf(els);
    page.doc.mut = [];
    release({ ok: true, status: 200, json: async () => structuredClone(TOK_PRICES) });
    await page.flush();
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    const touched = changed(writes, els);
    assert.ok(touched.length > 0, 'something was written');
    const cost = cellOf(page, 'cost');
    for (const e of touched) assert.ok(cost.contains(e), `only the cost cell is written: ${e.tag}.${[...e.classes]}`);
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'add' || m.type === 'remove').filter((m) => !cost.childNodes[1].contains(m.parent) && m.parent !== cost.childNodes[1]), [],
      'nothing outside the value of the cost cell was made or taken out');
    // the report cells are the same elements as before
    sameNodes(reportCells(page), els.filter((e) => e.classes?.has('cell-r')), 'the same cells');
    assert.deepEqual(identicalReadds(page.doc.mut).filter((x) => !/OpenRouter|loading|\$/.test(x)), []);
  } finally {
    page.restore();
  }
});

test('usage and cost: a failure is shown as "cost unknown: <reason>" with the server\'s reason and kept: no second request, no timer', async () => {
  const r = tokRun();
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: (u) => (u === '/api/prices' ? { ok: false, status: 503, json: async () => ({ error: 'offline' }) } : undefined) });
  try {
    assert.equal(cellText(page, 'cost'), 'cost unknown: OpenRouter prices not available: offline');
    const fact = cellOf(page, 'cost').childNodes[1].querySelector('.fact');
    assert.ok(fact.classes.has('prov-unknown'));
    assert.match(fact.getAttribute('title'), /^unknown: OpenRouter prices not available: offline$/);
    const timersBefore = page.timers.timeouts.size;
    await page.snapshot(structuredClone(r));
    await openAgentDrawer(page);
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'remembered: no retry');
    assert.equal(drawerRow(page, 'cost').textContent, 'cost unknown: OpenRouter prices not available: offline', 'the drawer says the same');
    assert.equal(page.timers.timeouts.size, timersBefore, 'no timer for a retry');
  } finally {
    page.restore();
  }
  // a failure with no JSON body (HTTP status only) and a network error
  for (const [answer, want] of [
    [() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('x'); } }), /^cost unknown: OpenRouter prices not available: HTTP 502$/],
    [() => Promise.reject(new TypeError('Failed to fetch')), /^cost unknown: OpenRouter prices not available: Failed to fetch$/],
    [() => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }), /^cost unknown: OpenRouter prices not available: the answer is not a price list$/],
  ]) {
    const p = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: (u) => (u === '/api/prices' ? answer() : undefined) });
    try {
      assert.match(cellText(p, 'cost'), want);
    } finally {
      p.restore();
    }
  }
});

test('usage and cost: a model with no OpenRouter match, a model that is not in the list and a missing cache price each give "cost unknown" with the reason, never a partial sum', async () => {
  const cases = [
    [{ 'claude-haiku-5-5': TOK_HAIKU, haiku: tokUse(1, 1, 0, 0) }, /^cost unknown: no OpenRouter price for haiku: haiku has no OpenRouter id/],
    [{ 'claude-haiku-5-5': TOK_HAIKU, 'claude-fable-5-1': tokUse(1, 1, 0, 0) }, /^cost unknown: no OpenRouter price for claude-fable-5-1: anthropic\/claude-fable-5\.1 is not in the price list$/],
    [{ 'claude-opus-5-5': tokUse(10, 10, 100, 0) }, /^cost unknown: no OpenRouter price for claude-opus-5-5 \(anthropic\/claude-opus-5\.5\): no price for cache read$/],
  ];
  for (const [byModel, want] of cases) {
    const r = tokRun({ byModel });
    const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
    try {
      const text = cellText(page, 'cost');
      assert.match(text, want);
      assert.doesNotMatch(text, /~ \$/, 'no amount');
    } finally {
      page.restore();
    }
  }
  // <synthetic> records have all-zero usage: they are not a model to price
  const ok = tokRun({ byModel: { 'claude-haiku-5-5': TOK_HAIKU, '<synthetic>': tokUse(0, 0, 0, 0) } });
  const page = await bootPage({ runs: [summary(ok)], runDocs: { wf_1: ok }, answer: pricesAnswering() });
  try {
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
  } finally {
    page.restore();
  }
});

test('usage and cost: a run without usage shows why in one cell and never asks for the prices; neither does a page load of the list, a running run or an open drawer without usage', async () => {
  const none = tokRun({ usage: null, byModel: null, agentUsage: null });
  const page = await bootPage({ runs: [summary(none)], runDocs: { wf_1: none }, answer: pricesAnswering() });
  try {
    assert.equal(page.el('#report-card').hidden, false);
    assert.match(cellText(page, 'usage'), /^\? no agent has a transcript record with usage yet$/);
    assert.equal(cellOf(page, 'input tokens'), undefined, 'no counters of an unknown usage');
    assert.match(cellText(page, 'cost'), /^cost unknown: no agent has a transcript record with usage yet$/);
    assert.match(page.el('#report').textContent, /other engines called from an agent are not in Claude Code files/);
    await openAgentDrawer(page);
    assert.equal(page.el('#drawer').hidden, false);
    assert.match(drawerRow(page, 'usage').textContent, /no transcript seen for this agent/);
    assert.match(drawerRow(page, 'cost').textContent, /^cost unknown: no transcript seen for this agent/);
    assert.deepEqual(priceRequests(page), [], 'no usage anywhere: no request');
  } finally {
    page.restore();
  }
  // a running run with usage: the report card is not shown, no drawer is open: the page asks for nothing
  const running = tokRun({ status: { value: 'running', prov: 'inferred', method: 'no-final-file' } });
  const p2 = await bootPage({ runs: [summary(running)], runDocs: { wf_1: running }, answer: pricesAnswering() });
  try {
    assert.equal(p2.el('#report-card').hidden, true);
    assert.deepEqual(priceRequests(p2), [], 'the page load and the list do not ask');
    await openAgentDrawer(p2);
    assert.deepEqual(priceRequests(p2), ['/api/prices'], 'the first drawer with usage asks, once');
    assert.equal(drawerRow(p2, 'cost').textContent, `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
  } finally {
    p2.restore();
  }
});

test('usage and cost, drawer: the four counters of the agent with their provenance, the cost from the models of its counted messages, and the note about other engines', async () => {
  const r = tokRun({ byModel: { 'claude-haiku-5-5': TOK_HAIKU } });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    await openAgentDrawer(page);
    for (const [label, n] of [['input tokens', '14'], ['output tokens', '840'], ['cache read tokens', '250,741'], ['cache write tokens', '144,816']]) {
      const dd = drawerRow(page, label);
      assert.ok(dd, label);
      assert.equal(dd.textContent, n);
      assert.ok(dd.querySelector('.fact').classes.has('prov-inferred'));
      assert.match(dd.querySelector('.fact').getAttribute('title'), /^inferred: sum-over-unique-message-id \(3 messages in 4 records\)$/);
    }
    assert.equal(drawerRow(page, 'tokens').textContent, '100', 'the agent\'s own "tokens" row is as it was');
    assert.equal(drawerRow(page, 'cost').textContent, `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.match(drawerRow(page, 'other engines').textContent, /^Tokens and cost cover Claude Code agents only; other engines called from an agent are not in Claude Code files and are not counted\.$/);
    // Agent.model is not what prices an agent: a suffix no record has, or a <synthetic> placeholder, gives the same cost as the models of the counted messages
    for (const model of ['claude-opus-4-8[1m]', '<synthetic>', 'haiku']) {
      await page.snapshot(structuredClone(tokRun({ model })));
      assert.equal(drawerRow(page, 'cost').textContent, `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`, `Agent.model ${model}`);
      assert.equal(drawerRow(page, 'model').textContent, model, 'the model row still says the registered model');
    }
    // an agent whose counted messages name a model that has no OpenRouter match is unknown (the run's other models are not tried for it)
    await page.snapshot(structuredClone(tokRun({ recordsModel: 'haiku' })));
    assert.match(drawerRow(page, 'cost').textContent, /^cost unknown: no OpenRouter price for haiku: haiku has no OpenRouter id/);
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`, 'while the run, priced by its byModel, is known');
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'one request for the whole page');
  } finally {
    page.restore();
  }
});

test('usage and cost: a snapshot with the same numbers writes nothing; a changed number patches its own text node only', async () => {
  const r = tokRun();
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    await openAgentDrawer(page);
    const regions = ['#report', '#drawer-body'];
    const els = allEls(page, regions);
    const writes = writesOf(els);
    page.doc.mut = [];
    await page.snapshot(structuredClone(r));
    assert.deepEqual(changed(writes, els), [], 'nothing written');
    assert.deepEqual(page.doc.mut, [], 'nothing made or removed');
    // one counter grows (a live agent): the number of that counter, in the report and in the drawer
    const more = tokRun({ usage: tokUse(14, 900, 250741, 144816), byModel: { 'claude-haiku-5-5': tokUse(14, 900, 250741, 144816) }, agentUsage: TOK_HAIKU });
    page.doc.mut = [];
    await page.snapshot(structuredClone(more));
    assert.equal(cellText(page, 'output tokens'), '900');
    assert.equal(drawerRow(page, 'output tokens').textContent, '840', 'the agent\'s usage did not change in this run: 840');
    const touched = changed(writes, els);
    assert.ok(touched.every((e) => e.nodeType === 3 || e.tag === 'span'), `texts and value spans only: ${touched.map((e) => e.tag)}`);
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove' || m.type === 'add').map((m) => m.ser), [], 'no element was taken out or put back for it');
    assert.match(cellText(page, 'cost'), /^~ \$0\.0211 /, 'the cost moved by 60 output tokens x 5e-7 = $0.00003, from 0.021031 to 0.021061');
  } finally {
    page.restore();
  }
});

test('usage and cost: what comes from the run or the server is text, never markup (model ids, reasons)', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const r = tokRun({ byModel: { [evil]: tokUse(1, 1, 0, 0) } });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    const v = cellOf(page, 'cost').childNodes[1];
    assert.ok(v.textContent.includes(evil), 'the id is shown as text');
    assert.equal(v.querySelectorAll('img').length, 0, 'no element was made from it');
    assert.doesNotMatch(v.html, /<img/);
  } finally {
    page.restore();
  }
  const page2 = await bootPage({ runs: [summary(tokRun())], runDocs: { wf_1: tokRun() }, answer: (u) => (u === '/api/prices' ? { ok: false, status: 503, json: async () => ({ error: evil }) } : undefined) });
  try {
    const v = cellOf(page2, 'cost').childNodes[1];
    assert.ok(v.textContent.includes(evil));
    assert.equal(v.querySelectorAll('img').length, 0);
    assert.equal(v.querySelector('.fact').getAttribute('title').includes(evil), true, 'in the tooltip too, as an attribute value');
  } finally {
    page2.restore();
  }
});

// ---- a demo Run: its tokens are made up, so it shows no cost and never asks for prices (contract section 4, GET /api/prices) -----------------------

// elements of the fake page hold the whole document: a failing assert.equal on one would try to print it all, so identity is asserted on a boolean
const sameNode = (a, b, msg) => assert.ok(a === b, msg);
const reportLabels = (page) => reportCells(page).map((c) => c.childNodes[0].textContent);
const drawerLabels = (page) => page.el('#drawer-body').querySelectorAll('dt').map((d) => d.textContent);

test('usage and cost, demo Run: no cost cell and no cost row (not "$0.00", not "cost unknown"), no request for prices; the four counters and the note about other engines stay', async () => {
  const demo = tokRun({ over: { source: 'demo' } });
  let demoLabels;
  const page = await bootPage({ runs: [summary(demo)], runDocs: { wf_1: demo }, answer: pricesAnswering() });
  try {
    assert.equal(page.el('#report-card').hidden, false);
    for (const [label, n] of [['input tokens', '14'], ['output tokens', '840'], ['cache read tokens', '250,741'], ['cache write tokens', '144,816']]) assert.equal(cellText(page, label), n, label);
    sameNode(cellOf(page, 'cost'), undefined, 'no cost cell at all');
    assert.equal(page.el('#report').querySelectorAll('.cost').length, 0, 'no element with the cost class');
    assert.doesNotMatch(page.el('#report').textContent.replace(lib.ENGINES_NOTE, ''), /\$|cost|OpenRouter/i, 'no sentence about a cost, not even an unknown one (the note about other engines is the one sentence that has the word)');
    demoLabels = reportLabels(page);
    assert.match(page.el('#report').textContent, /Tokens and cost cover Claude Code agents only/, 'the note about other engines stays');
    await openAgentDrawer(page);
    assert.equal(page.el('#drawer').hidden, false);
    sameNode(drawerRow(page, 'cost'), null, 'no cost row in the drawer');
    assert.doesNotMatch(page.el('#drawer-body').textContent, /OpenRouter|\$\d|cost unknown/);
    for (const [label, n] of [['input tokens', '14'], ['output tokens', '840'], ['cache read tokens', '250,741'], ['cache write tokens', '144,816']]) assert.equal(drawerRow(page, label).textContent, n, `drawer ${label}`);
    assert.ok(drawerRow(page, 'other engines'), 'the note about other engines stays in the drawer');
    assert.deepEqual(page.el('#drawer-body').querySelectorAll('dt').map((d) => d.textContent).filter((l) => /cost/i.test(l)), []);
    // a later snapshot of the same demo Run does not start asking either
    await page.snapshot(structuredClone(demo));
    assert.deepEqual(priceRequests(page), [], 'a demo Run never asks for prices on its account');
  } finally {
    page.restore();
  }
  // the control: the same Run of source "real" asks once and shows a cost, so the gate is what keeps the demo Run quiet
  const real = tokRun({ over: { source: 'real' } });
  const p2 = await bootPage({ runs: [summary(real)], runDocs: { wf_1: real }, answer: pricesAnswering() });
  try {
    assert.equal(cellText(p2, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    await openAgentDrawer(p2);
    assert.equal(drawerRow(p2, 'cost').textContent, `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.deepEqual(priceRequests(p2), ['/api/prices']);
    assert.deepEqual(reportLabels(p2).filter((l) => l !== 'cost'), demoLabels, 'the real Run has the demo Run\'s cells and the cost cell: one cell more, nothing else');
    assert.ok(demoLabels.length > 0 && demoLabels.length < reportLabels(p2).length);
  } finally {
    p2.restore();
  }
});

test('usage and cost, demo Run: only source "demo" is a demo; an id with the prefix demo-, a missing source or another source keeps the cost line and asks once', async () => {
  for (const [name, over] of [['id demo-1, source real', { id: 'demo-1', source: 'real' }], ['no source', { source: undefined }], ['source replay', { source: 'replay' }], ['source something-new', { source: 'something-new' }]]) {
    const r = tokRun({ over });
    const page = await bootPage({ runs: [summary(r)], runDocs: { [r.id]: r }, answer: pricesAnswering() });
    try {
      assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`, name);
      assert.deepEqual(priceRequests(page), ['/api/prices'], name);
    } finally {
      page.restore();
    }
  }
});

test('usage and cost, demo Run: a Run that turns into a demo Run loses only its cost cell; every other cell of the report keeps its node and nothing is written to it', async () => {
  const real = tokRun({ over: { source: 'real' } });
  const page = await bootPage({ runs: [summary(real)], runDocs: { wf_1: real }, answer: pricesAnswering() });
  try {
    assert.ok(cellOf(page, 'cost'));
    const before = new Map(reportCells(page).map((c) => [c.childNodes[0].textContent, c]));
    const writes = writesOf(allEls(page, ['#report']));
    page.doc.mut = [];
    await page.snapshot(structuredClone(tokRun({ over: { source: 'demo' } })));
    sameNode(cellOf(page, 'cost'), undefined, 'the cost cell is gone');
    assert.deepEqual(reportLabels(page), [...before.keys()].filter((l) => l !== 'cost'), 'one cell fewer, the order of the others kept');
    for (const c of reportCells(page)) sameNode(c, before.get(c.childNodes[0].textContent), `${c.childNodes[0].textContent} is the same node`);
    assert.deepEqual(changed(writes, allEls(page, ['#report']).filter((e) => writes.has(e))), [], 'nothing of the cells that stay was written');
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove').length, 1, 'one node taken out: the cost cell');
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'asked once for the real Run, never again');
  } finally {
    page.restore();
  }
});

// ---- tokens of messages with no model id: the cost says what it leaves out ---------------------------------------------------------------------

const WITHOUT_7_PAGE = 'without 7 tokens of messages with no model';

test('usage and cost: tokens of messages with no model are in the counters and not in the cost; the cost says "without N tokens of messages with no model" in its text and in its method, in the report and in the drawer', async () => {
  // the run and the agent have 7 tokens (3 input, 4 cache write) that no model of their split holds
  const withExtra = tokUse(17, 840, 250741, 144820);
  const r = tokRun({ usage: withExtra, byModel: { 'claude-haiku-5-5': TOK_HAIKU }, agentUsage: withExtra, agentByModel: { 'claude-haiku-5-5': TOK_HAIKU } });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    assert.equal(cellText(page, 'input tokens'), '17', 'the counters hold every token of the usage');
    assert.equal(cellText(page, 'cache write tokens'), '144,820');
    const text = `~ $0.0210, ${WITHOUT_7_PAGE} (OpenRouter prices, fetched ${HHMM})`;
    assert.equal(cellText(page, 'cost'), text);
    const fact = cellOf(page, 'cost').childNodes[1].querySelector('.fact');
    assert.ok(fact.classes.has('prov-inferred'), 'still an inferred value');
    assert.ok(fact.getAttribute('title').includes(`; ${WITHOUT_7_PAGE} (they are in the usage and not in the split by model, so they are not priced)`), fact.getAttribute('title'));
    await openAgentDrawer(page);
    assert.equal(drawerRow(page, 'cost').textContent, text);
    assert.ok(drawerRow(page, 'cost').querySelector('.fact').getAttribute('title').includes(WITHOUT_7_PAGE), 'the agent\'s method says it too');
    // the same numbers without the extra tokens: the old line, no note
    const plain = tokRun();
    await page.snapshot(structuredClone(plain));
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.doesNotMatch(cellOf(page, 'cost').childNodes[1].querySelector('.fact').getAttribute('title'), /without/);
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'one request for all of it');
  } finally {
    page.restore();
  }
});

test('usage and cost: when the number of tokens left out changes, only the cost text is patched: the cost cell keeps its node and its key, no element is made or removed', async () => {
  const mk = (n) => tokRun({ usage: tokUse(14 + n, 840, 250741, 144816), byModel: { 'claude-haiku-5-5': TOK_HAIKU }, agentUsage: TOK_HAIKU, agentByModel: { 'claude-haiku-5-5': TOK_HAIKU } });
  const page = await bootPage({ runs: [summary(mk(7))], runDocs: { wf_1: mk(7) }, answer: pricesAnswering() });
  try {
    const cost = cellOf(page, 'cost');
    assert.match(cellText(page, 'cost'), /^~ \$0\.0210, without 7 tokens of messages with no model \(/);
    page.doc.mut = [];
    await page.snapshot(structuredClone(mk(8)));
    sameNode(cellOf(page, 'cost'), cost, 'the same cell node');
    assert.match(cellText(page, 'cost'), /^~ \$0\.0210, without 8 tokens of messages with no model \(/);
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove' || m.type === 'add').map((m) => m.ser), [], 'nothing made or removed for it');
    // gone when none is left out, and back again: still the same cell
    await page.snapshot(structuredClone(mk(0)));
    sameNode(cellOf(page, 'cost'), cost, 'the same cell node again');
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove' || m.type === 'add').map((m) => m.ser), []);
  } finally {
    page.restore();
  }
});

// a Run with several agents: [id, usage | null] each, the usage of an agent with null is unknown; the totals are the haiku usage (those of the agents that have one)
const EVIL_AGENT_ID = '<img src=x onerror=1>';
const ONE_OTHER_PAGE = '; the other agent has no usage in the run files, so it is not priced';
function tokRunSome(entries, over = {}) {
  const agents = entries.map(([id, usage]) => agent(id, 'w:U', {
    model: reg('claude-haiku-5-5', 'f:3'), tokens: fin(100),
    usage: usage === null ? unk(tokNoTranscript) : inf(usage, tokMethod),
    byModel: usage === null ? unk(tokNoTranscript) : inf({ 'claude-haiku-5-5': usage }, 'sum by transcript model'),
  }));
  return wfRun(agents, {
    status: fin('completed'), endedAt: fin(5000), durationMs: fin(4000),
    totals: {
      agents: agents.length, running: 0, done: agents.length, failed: 0, tokens: fin(100),
      usage: inf(TOK_HAIKU, 'sum-of-agent-usage (1 of 3 agents)'), byModel: inf({ 'claude-haiku-5-5': TOK_HAIKU }, 'sum by transcript model'),
    },
    ...over,
  });
}

test('usage and cost: when only some agents have a usage the cost cell says "for k of n agents" and its method says the others have no usage in the run files; an agent id is in neither; the agent\'s own cost is as it was; with every agent it is as it was', async () => {
  const some = tokRunSome([['a1', TOK_HAIKU], ['a2', null], [EVIL_AGENT_ID, null]]);
  const page = await bootPage({ runs: [summary(some)], runDocs: { wf_1: some }, answer: pricesAnswering() });
  try {
    const cost = cellOf(page, 'cost');
    assert.equal(cellText(page, 'cost'), `~ $0.0210 for 1 of 3 agents (OpenRouter prices, fetched ${HHMM})`);
    const fact = cost.childNodes[1].querySelector('.fact');
    assert.ok(fact.classes.has('prov-inferred'), 'still an inferred value');
    assert.ok(fact.getAttribute('title').endsWith('; the other 2 agents have no usage in the run files, so they are not priced'), fact.getAttribute('title'));
    assert.equal(cost.childNodes[1].querySelectorAll('img').length, 0);
    for (const s of [cost.childNodes[1].html, fact.getAttribute('title')]) assert.doesNotMatch(s, /<img|onerror/, 'the id of an agent is not in the text or the method, and nothing is markup');
    // the agent that has a usage: its own cost is of that agent alone
    await openAgentDrawer(page, 'a1');
    assert.equal(drawerRow(page, 'cost').textContent, `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.doesNotMatch(drawerRow(page, 'cost').textContent + drawerRow(page, 'cost').querySelector('.fact').getAttribute('title'), /of \d+ agents|no usage in the run files/);
    // a second agent gets a usage: "2 of 3", the same cell and the same nodes, only the text and the method are patched
    page.doc.mut = [];
    await page.snapshot(structuredClone(tokRunSome([['a1', TOK_HAIKU], ['a2', tokUse(0, 0, 0, 0)], [EVIL_AGENT_ID, null]])));
    assert.ok(cellOf(page, 'cost') === cost, 'the same cell node');
    assert.equal(cellText(page, 'cost'), `~ $0.0210 for 2 of 3 agents (OpenRouter prices, fetched ${HHMM})`);
    assert.ok(cost.childNodes[1].querySelector('.fact').getAttribute('title').endsWith(ONE_OTHER_PAGE));
    // the third one too: the old line, with no "of n agents" and no sentence, in the same cell
    await page.snapshot(structuredClone(tokRunSome([['a1', TOK_HAIKU], ['a2', tokUse(0, 0, 0, 0)], [EVIL_AGENT_ID, tokUse(0, 0, 0, 0)]])));
    assert.ok(cellOf(page, 'cost') === cost, 'the same cell node again');
    assert.equal(cellText(page, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
    assert.doesNotMatch(cost.childNodes[1].querySelector('.fact').getAttribute('title'), /no usage in the run files/);
    assert.deepEqual(page.doc.mut.filter((m) => m.type === 'remove' || m.type === 'add').filter((m) => m.parent === cost || m.parent === cost.childNodes[1]).map((m) => m.ser), [], 'the cost cell is not rebuilt');
    page.doc.mut = null;
    assert.deepEqual(priceRequests(page), ['/api/prices'], 'one request for the whole page');
  } finally {
    page.restore();
  }
  // a Run with one agent that has a usage is as it was, and so is a Run of one agent that has none and is not priced at all
  const one = tokRunSome([['a1', TOK_HAIKU]]);
  const p2 = await bootPage({ runs: [summary(one)], runDocs: { wf_1: one }, answer: pricesAnswering() });
  try {
    assert.equal(cellText(p2, 'cost'), `~ $0.0210 (OpenRouter prices, fetched ${HHMM})`);
  } finally {
    p2.restore();
  }
});

test('usage and cost: a model with tokens and no price gives "cost unknown", with no partial sum and no note, even when tokens were left out; a usage with no value gives the usage\'s reason', async () => {
  const extra = tokUse(30, 900, 250741, 144816);
  const r = tokRun({ usage: extra, byModel: { 'claude-haiku-5-5': TOK_HAIKU, 'claude-fable-5-1': tokUse(1, 1, 0, 0) } });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    assert.match(cellText(page, 'cost'), /^cost unknown: no OpenRouter price for claude-fable-5-1: anthropic\/claude-fable-5\.1 is not in the price list$/);
    assert.doesNotMatch(cellText(page, 'cost'), /without|\$/);
  } finally {
    page.restore();
  }
  // the split is known, the usage is not: "cost unknown" says why, and no list is asked for on the strength of the agent alone
  const unknownUsage = tokRun({ usage: null, byModel: { 'claude-haiku-5-5': TOK_HAIKU }, agentUsage: TOK_HAIKU });
  const p2 = await bootPage({ runs: [summary(unknownUsage)], runDocs: { wf_1: unknownUsage }, answer: pricesAnswering() });
  try {
    assert.match(cellText(p2, 'cost'), /^cost unknown: no agent has a transcript record with usage yet$/);
  } finally {
    p2.restore();
  }
});

test('usage and cost: a model id that is markup or "__proto__", with tokens left out, is text, and the note names no model', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const by = {};
  Object.defineProperty(by, '__proto__', { value: tokUse(1, 1, 0, 0), enumerable: true, configurable: true, writable: true });
  by[evil] = tokUse(1, 1, 0, 0);
  const r = tokRun({ usage: TOK_HAIKU, byModel: by });
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    const v = cellOf(page, 'cost').childNodes[1];
    assert.match(v.textContent, /^cost unknown: no OpenRouter price for __proto__: __proto__ has no OpenRouter id/);
    assert.ok(v.textContent.includes(evil), 'the id is shown as text');
    assert.equal(v.querySelectorAll('img').length, 0);
    assert.doesNotMatch(v.html, /<img/);
  } finally {
    page.restore();
  }
  // a priced model next to all-zero hostile ones: the known cost with its note carries none of their names
  const zero = {};
  Object.defineProperty(zero, '__proto__', { value: tokUse(0, 0, 0, 0), enumerable: true, configurable: true, writable: true });
  zero[evil] = tokUse(0, 0, 0, 0);
  zero['claude-haiku-5-5'] = TOK_HAIKU;
  const r2 = tokRun({ usage: tokUse(17, 840, 250741, 144820), byModel: zero });
  const p2 = await bootPage({ runs: [summary(r2)], runDocs: { wf_1: r2 }, answer: pricesAnswering() });
  try {
    const v = cellOf(p2, 'cost').childNodes[1];
    assert.equal(v.textContent, `~ $0.0210, ${WITHOUT_7_PAGE} (OpenRouter prices, fetched ${HHMM})`);
    assert.equal(v.querySelectorAll('img').length, 0);
  } finally {
    p2.restore();
  }
});

// ---- the style of the cost cell ------------------------------------------------------------------------------------------------------------------

test('usage and cost: the rule that sets the cost line\'s own type matches the value element of the cost cell, and only that one, in the report (also while it says loading or cost unknown)', async () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const costRules = rules.filter((x) => /font-size:\s*13px/.test(x.body) && /font-weight:\s*600/.test(x.body) && /^\.report\b/.test(x.sel));
  assert.equal(costRules.length, 1, 'one rule of the report sets 13px and 600');
  const { sel } = costRules[0];
  const generic = rules.filter((x) => /^\.report \.v$/.test(x.sel));
  assert.equal(generic.length, 1, 'the rule of every value stays');
  assert.match(generic[0].body, /font-size:\s*16px/);
  assert.match(generic[0].body, /font-weight:\s*700/);
  const r = tokRun();
  const page = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: pricesAnswering() });
  try {
    const hits = page.el('#report').querySelectorAll(sel);
    assert.equal(hits.length, 1, `${sel} matches exactly one element of the report`);
    sameNode(hits[0], cellOf(page, 'cost').childNodes[1], 'the value element of the cost cell');
    assert.equal(hits[0].classes.has('v'), true);
    assert.deepEqual([...cellOf(page, 'cost').classes].sort(), ['cell-r', 'cost', 'wide'], 'the cell keeps its classes: the ones that lay it over the whole card and the one the rule needs');
    // no usage cell and no note matches it, and the rule of every value still matches them
    for (const label of ['input tokens', 'output tokens', 'cache read tokens', 'cache write tokens', 'status', 'duration', 'agents']) {
      assert.equal(cellOf(page, label).childNodes[1].matches(sel), false, label);
      assert.equal(cellOf(page, label).childNodes[1].matches(generic[0].sel), true, label);
    }
  } finally {
    page.restore();
  }
  // the same selector holds while the line says "cost unknown: <reason>" and while it loads: the text sits in the same value element
  const failing = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: (u) => (u === '/api/prices' ? { ok: false, status: 503, json: async () => ({ error: 'offline' }) } : undefined) });
  try {
    const hits = failing.el('#report').querySelectorAll(sel);
    assert.equal(hits.length, 1);
    sameNode(hits[0], cellOf(failing, 'cost').childNodes[1], 'the cost value element');
    assert.match(hits[0].textContent, /^cost unknown: OpenRouter prices not available: offline$/);
  } finally {
    failing.restore();
  }
  let release;
  const loading = await bootPage({ runs: [summary(r)], runDocs: { wf_1: r }, answer: (u) => (u === '/api/prices' ? new Promise((res) => { release = res; }) : undefined) });
  try {
    { const h = loading.el('#report').querySelectorAll(sel); assert.equal(h.length, 1); sameNode(h[0], cellOf(loading, 'cost').childNodes[1], 'loading'); }
    release({ ok: true, status: 200, json: async () => structuredClone(TOK_PRICES) });
    await loading.flush();
    { const h = loading.el('#report').querySelectorAll(sel); assert.equal(h.length, 1); sameNode(h[0], cellOf(loading, 'cost').childNodes[1], 'loaded'); }
  } finally {
    loading.restore();
  }
});

test('usage and cost: the page code asks for prices in one place, builds no timer, listener or storage for it, and names no engine', () => {
  const app = read('app.js');
  assert.equal([...app.matchAll(/fetchJson\('\/api\/prices'\)/g)].length, 1, 'one request, in ensurePrices');
  // ensurePrices is called only where a cost is first shown, and only for a thing that has usage
  const calls = app.split('\n').filter((l) => /ensurePrices\(\)/.test(l) && !/^function ensurePrices/.test(l.trim()) && !/^\s*\/\//.test(l)).map((l) => l.trim());
  // an agent does not know the source of its Run, so the drawer hands the Run to agentNeedsPrices: a demo Run never asks (its tokens are made up)
  assert.deepEqual(calls, ['if (runNeedsPrices(run)) ensurePrices();', 'if (agentNeedsPrices(a, run)) ensurePrices();']);
  assert.doesNotMatch(app.slice(app.indexOf('function ensurePrices'), app.indexOf('function costHtml')), /setTimeout|setInterval|localStorage|addEventListener|innerHTML/);
  const engineWords = /\b(codex|openai|gpt|gemini|llama|mistral)\b/i;
  for (const f of ['app.js', 'lib.js', 'index.html']) assert.doesNotMatch(read(f).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n'), engineWords, `${f} names no engine`);
});
