// test/server/web-run-history.test.mjs (node run-history): the pure part of the run picker's filters (web/lib.js): the hash that holds their
// state, the window and the filters, the options. The page itself (rows, controls, loading, escaping) is tested on the fake browser
// in web-u4.test.mjs, section "run history".

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAY_MS, HASH_VALUE_MAX, defaultPickerFilter, formatPickerHash, isCalendarDate, loadFailedText, parsePickerHash, pickerFilterOptions, pickerRow,
  runPassesFilter, sanitizePickerFilter,
} from '../../web/lib.js';

const def = defaultPickerFilter();
const f = (over) => ({ ...def, ...over });

test('an empty or missing hash is the last 24 h with nothing else set', () => {
  for (const h of ['', '#', undefined, null, 42, '#unknown=1']) assert.deepEqual(parsePickerHash(h), def, String(h));
  assert.equal(formatPickerHash(def), '');
});

test('hash round trip: every key, defaults left out, the order fixed', () => {
  const all = f({ range: 'all', project: '-Users-x-proj', status: 'failed', from: '2026-11-01', to: '2026-11-10', q: 'probe run' });
  const hash = formatPickerHash(all);
  assert.equal(hash, '#range=all&project=-Users-x-proj&status=failed&from=2026-11-01&to=2026-11-10&q=probe+run');
  assert.deepEqual(parsePickerHash(hash), all);
  assert.deepEqual(parsePickerHash(hash.slice(1)), all, 'with or without the #');
  assert.equal(formatPickerHash(f({ range: '24h' })), '');
  assert.equal(formatPickerHash(f({ q: '   ' })), '', 'a blank search is no search');
  // a project name as on disk, with the characters of a hash
  const odd = f({ project: '-Users-x-a&b=c#d%e f' });
  assert.deepEqual(parsePickerHash(formatPickerHash(odd)), odd);
});

test('invalid hash values are the default, one by one; unknown keys are dropped; the first of a repeated key counts', () => {
  assert.equal(parsePickerHash('#range=week').range, '24h', 'an unknown range');
  assert.equal(parsePickerHash('#range=ALL').range, '24h', 'the range is case-sensitive');
  assert.equal(parsePickerHash('#from=2026-02-30').from, null, 'not a calendar day');
  assert.equal(parsePickerHash('#to=2026-13-01').to, null);
  assert.equal(parsePickerHash('#from=2026-1-1').from, null, 'not YYYY-MM-DD');
  assert.equal(parsePickerHash('#from=yesterday').from, null);
  assert.equal(parsePickerHash('#from=2024-02-29').from, '2024-02-29', 'a leap day is a day');
  assert.equal(parsePickerHash('#from=2025-02-29').from, null);
  assert.equal(parsePickerHash('#project=').project, null, 'an empty value is no value');
  assert.equal(parsePickerHash(`#project=${'x'.repeat(HASH_VALUE_MAX + 1)}`).project, null, 'over 200 characters');
  assert.equal(parsePickerHash(`#project=${'x'.repeat(HASH_VALUE_MAX)}`).project, 'x'.repeat(HASH_VALUE_MAX));
  assert.equal(parsePickerHash(`#q=${'y'.repeat(300)}`).q, '');
  assert.equal(parsePickerHash('#status=failed&status=completed').status, 'failed', 'the first of a repeated key');
  assert.equal(parsePickerHash(`#status=${'z'.repeat(300)}&status=ok`).status, null, 'the first one is over the limit: the default, not the second');
  assert.deepEqual(parsePickerHash('#__proto__=x&constructor=y&foo=bar&range=all'), f({ range: 'all' }), 'unknown keys are dropped');
  // malformed percent encoding never throws and never gives a half-decoded value that breaks anything
  for (const h of ['#q=%E0%A4%A', '#project=%', '#status=%zz&range=all', '#q=%00']) {
    assert.doesNotThrow(() => parsePickerHash(h), h);
    assert.equal(typeof parsePickerHash(h).q, 'string');
  }
  assert.equal(parsePickerHash('#status=%zz&range=all').range, 'all', 'the rest of the hash is read');
  assert.equal(isCalendarDate('2026-11-11'), true);
  assert.equal(isCalendarDate(20261111), false);
});

test('what is typed in a hash is data: markup stays text', () => {
  const h = parsePickerHash('#project=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&q=%3Cb%3E');
  assert.equal(h.project, '<img src=x onerror=alert(1)>');
  assert.equal(h.q, '<b>');
});

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime(); // local noon, 11 Nov 2026
const run = (id, over = {}) => ({ id, project: 'p1', status: { value: 'completed', prov: 'final', from: 'x' }, startedAt: { value: NOW - 3600e3, prov: 'registered', from: 'x' }, ...over });
const started = (ms) => ({ value: ms, prov: 'registered', from: 'x' });

test('window and filters: last 24 h by default; all; an explicit date range replaces the window; unknown start only under all with no date', () => {
  const recent = run('recent');
  const old = run('old', { startedAt: started(NOW - 3 * DAY_MS) });
  const edge = run('edge', { startedAt: started(NOW - DAY_MS) });
  const unknownStart = run('unk', { startedAt: { value: null, prov: 'unknown', reason: 'no agent started' } });
  const none = run('none', { startedAt: undefined });
  const pass = (item, filter) => runPassesFilter(item, filter, NOW);
  assert.deepEqual([recent, old, edge, unknownStart, none].map((r) => pass(r, def)), [true, false, true, false, false], 'the last 24 h: the start 24 h ago is in');
  assert.deepEqual([recent, old, edge, unknownStart, none].map((r) => pass(r, f({ range: 'all' }))), [true, true, true, true, true]);
  // from / to are local days, both ends included, and replace the window
  const day = (d) => started(new Date(2026, 10, d, 9, 0, 0).getTime());
  assert.equal(pass(run('a', { startedAt: day(8) }), f({ from: '2026-11-08', to: '2026-11-08' })), true);
  assert.equal(pass(run('a', { startedAt: day(8) }), f({ from: '2026-11-09' })), false);
  assert.equal(pass(run('a', { startedAt: day(8) }), f({ to: '2026-11-07' })), false);
  assert.equal(pass(run('a', { startedAt: day(8) }), f({ range: '24h', from: '2026-11-01' })), true, 'a date range replaces the 24 h window');
  assert.equal(pass(run('a', { startedAt: started(new Date(2026, 10, 8, 23, 59, 59).getTime()) }), f({ to: '2026-11-08' })), true, 'the last second of the last day');
  assert.equal(pass(unknownStart, f({ range: 'all', from: '2026-01-01' })), false, 'an unknown start is outside any date range');
  // project (as on disk) and status (the list's own text)
  assert.equal(pass(run('a', { project: '-Users-x' }), f({ range: 'all', project: '-Users-x' })), true);
  assert.equal(pass(run('a', { project: '-Users-x' }), f({ range: 'all', project: '/Users/x' })), false, 'dashes are not turned into slashes');
  assert.equal(pass(run('a', { project: null }), f({ range: 'all', project: 'p1' })), false);
  assert.equal(pass(run('a', { status: { value: 'weird-status', prov: 'final', from: 'x' } }), f({ range: 'all', status: 'weird-status' })), true, 'a status text the page does not know is filterable');
  assert.equal(pass(run('a'), f({ range: 'all', status: 'failed' })), false);
  assert.equal(pass(run('a', { status: 'running' }), f({ range: 'all', status: 'running' })), true, 'a bare value, as an older list gives it');
});

test('options come from the list and nothing else; a project or status that is not in the list is reset to all', () => {
  const items = [run('a', { project: '-Users-b' }), run('b', { project: '-Users-a', status: { value: 'failed', prov: 'final', from: 'x' } }), run('c', { project: null }), run('d', { project: '-Users-a' })];
  const opts = pickerFilterOptions(items);
  assert.deepEqual(opts, { projects: ['-Users-a', '-Users-b'], statuses: ['completed', 'failed'] });
  assert.deepEqual(pickerFilterOptions(null), { projects: [], statuses: [] });
  const ok = sanitizePickerFilter(f({ project: '-Users-a', status: 'failed' }), opts);
  assert.equal(ok.changed, false);
  const bad = sanitizePickerFilter(f({ range: 'all', project: '-Users-gone', status: 'nope', q: 'x' }), opts);
  assert.equal(bad.changed, true);
  assert.deepEqual(bad.filter, f({ range: 'all', q: 'x' }), 'only the two values reset');
});

test('a picker row: the project as the list gives it, and loaded unless the list says false', () => {
  assert.equal(pickerRow({ id: 'a', project: '-Users-x-y' }).project, '-Users-x-y');
  assert.equal(pickerRow({ id: 'a', project: '' }).project, null);
  assert.equal(pickerRow({ id: 'a' }).project, null);
  assert.equal(pickerRow({ id: 'a' }).loaded, true, 'no `loaded` (demo, replay): loaded');
  assert.equal(pickerRow({ id: 'a', loaded: true }).loaded, true);
  assert.equal(pickerRow({ id: 'a', loaded: false }).loaded, false);
  assert.match(loadFailedText('wf_1', 'cannot read journal.jsonl'), /^could not load wf_1: cannot read journal\.jsonl$/);
  assert.match(loadFailedText('wf_1', ''), /no reason given/);
});
