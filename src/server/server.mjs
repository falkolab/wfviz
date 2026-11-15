// src/server/server.mjs (node N5, contract 2 section 4; U1)
//
//   GET /                                         static files from webDir
//   GET /api/runs                                 store.listRuns(), each item with `loaded` when the server has a `loader`
//   GET /api/runs/:id                             store.getRun(id); a run that is listed but not loaded is loaded first (see `loader`)
//   GET /api/runs/:id/events?since=<seq>          store.eventsSince(id, since): the backlog of UiEvents (since default 0)
//   GET /api/agents/:runId/:agentId/transcript    ?tail=200, the agent's activity with the full input of edit tools
//   GET /api/stream                               SSE: `hello`, `run` snapshots, `event` per UiEvent, `: heartbeat` comments
//   GET /api/runs/:id/replay?speed=<n>            SSE (real mode with `replays` only): the finished run played again, see below
//   GET /api/prices                               the OpenRouter price list (real and replay mode; a 404 in demo mode), see below
//   GET /api/search?q=<text>&limit=<n>            full-text search over the loaded runs' models, see below
//
// Read-only: GET and HEAD only. The server does not listen by itself; the caller does
// `server.listen(port, '127.0.0.1')`.
//
// SSE (what a client can rely on):
//   * `hello` {mode, version} is the first event of every connection, followed at once by one `run` snapshot of every run
//     the store has (so a client that reconnects is level again without a request).
//   * `run` carries a full Run snapshot. Per client and per run at most one is sent per throttle window (1 s): the first
//     change after a quiet window goes out at once, changes inside the window are coalesced, and the latest state is
//     always sent when the window ends - a change is never dropped, and the client is never starved by a steady stream
//     of changes.
//   * `event` carries one UiEvent (the store's `onEvent`), in the order the store emitted them, to every client, with no
//     throttle. `seq` counts per run from 1 without gaps; a client that sees a gap (or opens the page mid-run) reads
//     GET /api/runs/:id/events?since=<last seq>.
//
// Replay (contract section 4): `replays.open({ runId, speed, prepared, onRun, onEvent, onEnd, onError })` -> { stop() } is given by the
// caller (the launcher builds it; this file knows no source and no model). A replay stream has its own `hello` {mode: "replay",
// version, runId}, its own `run` snapshots (the same throttle as /api/stream, a Run whose source is "replay" only), the `event`
// objects the replay gives (the replay's own seq, from 1, never renumbered here) and one `end` {runId, events} after the last one.
// It is kept in a set of its own: nothing the replay gives goes to a client of /api/stream, and nothing of the real store goes to it.
// The replay stops once: when the client leaves, when it ends or fails, or when the server closes.
// `replays.prepare({ runId })` (optional) -> Promise runs BEFORE the stream starts: it finds and reads the run, so that a run that cannot
// be replayed (its files are not where they were, two places, nothing to play) is an ordinary JSON answer with the reason (404, or the
// `status` of the error it rejects with, else 500) and the page never sees a `hello`. What it resolves with goes to open() as `prepared`.
//
// Run history (contract section 4, P1): `loader` ({ isLoaded(runId) -> boolean, load(runId) -> Promise }) is given by the caller (the launcher
// builds it from its source; this file knows no source). With it, GET /api/runs adds `loaded` to a copy of every item, GET /api/runs/:id of a
// run that is not loaded awaits `loader.load(id)` first (one load at a time per run id, however many requests ask; an error is a 500 JSON
// { error: <the reason, one line> }) and then answers the Run, and /api/stream sends `run` snapshots of loaded runs only (a run that is only
// listed has none until it is loaded, and then gets one). HEAD, /events and /transcript start no load. Without a loader (demo, replay, the
// test stand-ins) the list items are as the store gives them and every run counts as loaded.
//
// Prices (contract section 4, P2): GET /api/prices answers { source: "openrouter", url, fetchedAt, models: { [openrouter id]: { input, output,
// cacheRead?, cacheWrite? } } } in USD per token, read from OpenRouter's public model list (GET <url>, a plain request: no headers, no
// cookies, no query, nothing about the user or the runs; Node's fetch keeps no cookies). The server fetches on the first request and keeps
// the answer in memory for one hour (an injected clock, no timer for the expiry); concurrent requests share one fetch; the fetch times out
// after 5 s; a failure is not kept, and a list that has expired is not served after a failed refetch: 503 { error: <one line> }. With
// `offline` the server never fetches (503 { error: "offline" }). In mode demo the answer is a 404 { error: "not found" } before anything
// else (the tokens of a demo run are made up, so a demo has no use for a price and never needs the network). GET only (HEAD and every other
// method start no fetch). Test hooks, none of them a flag: `fetchImpl`, `now`, `pricesTimeoutMs`.
//
// Search (contract section 4, P3): GET /api/search?q=<text>&limit=<n> answers { results: [{ runId, agentId?, field, excerpt, start, end }], more }
// from the Run models the store holds, never from a file: only runs that are visible in this mode and loaded (a run that is only listed has no
// transcripts read and is not searched; the scan never loads one). Fields searched, by `field`: "name" and "description" (the run's), "log" (each
// line of Run.logs), "prompt" and "result" (each agent's), "activity-summary" (inputSummary) and "activity-text" (text) of each entry of an agent's
// activity (the last 50 the Run keeps). The value of a Fact is searched only when its provenance is not "unknown" and it is not null: a string as
// it is, anything else as JSON.stringify(value, null, 2) (what the drawer shows); a Fact's reason and method are never searched. Labels, ids, tool
// names, Run.result and edit inputs are not searched. A result is one field and its FIRST match (a prompt with 500 hits is one result, so it
// cannot use up the limit); agentId is left out for the fields of the run. Results come in the order of the run list, then name, description,
// log lines, and per agent (in the keys of Run.agents) prompt, result and its activity entries. Matching is case-insensitive by Unicode case
// folding, one code point at a time (c.toUpperCase().toLowerCase(): sigma and final sigma, the sharp s and the capital sharp s as "ss", long s, ligatures and U+0130 fold);
// a match must start and end on a whole character of the text (the query "s" does not match inside the sharp s, "ss" matches it, "i" does not
// match U+0130), and `start` / `end` are UTF-16 offsets into `excerpt`, which slices the ORIGINAL text. Known limits: no locale rules (the
// dotless U+0131 folds to "i", which Unicode's default folding does not do) and no normalisation (precomposed and decomposed e-acute differ).
// The excerpt is about 120 characters around the match (longer when the match is), cut at characters, never inside a surrogate pair, with no
// ellipsis (it would move the offsets). `limit` is digits only, at least 1, default 50, above 200 it is 200; `q` is required, given once, not
// trimmed. `more` is true when a match beyond `limit` was found, or when the time budget (500 ms on `searchClock`, read before every run,
// agent, field and activity entry) ran out first: the results found stay. GET only; nothing is cached, no timer, no file read.
//
// The server never touches the file system outside webDir and never invents values: a Run, an agent, a transcript
// that the store does not have is a 404; the events of a run are the store's, untouched.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_THROTTLE_MS = 1000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 1000;
export const MAX_REPLAYS = 3; // replay streams open at the same time; the next one is a 429
export const PRICES_URL = 'https://openrouter.ai/api/v1/models';
export const PRICES_TTL_MS = 3_600_000;
export const PRICES_TIMEOUT_MS = 5000;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_BUDGET_MS = 500;
export const SEARCH_EXCERPT_CHARS = 120;

// A client that falls this far behind is dropped instead of buffering without bound.
const MAX_SSE_BUFFER_BYTES = 16 * 1024 * 1024;

const TEXT = 'text/plain; charset=utf-8';
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', TEXT],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
]);

// The `speed` of a replay is read as the --speed flag is (args.mjs): a decimal number, finite, above 0. The replay clamps it to its range.
const SPEED_DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function defaultOnError(err) {
  process.stderr.write(`wfviz: server error: ${err && err.message ? err.message : String(err)}\n`);
}

// ---- search: folding, matching, excerpts (pure; the handler is in createServer) ----------------------------------------------

const ASCII_ONLY = /^[\x00-\x7f]*$/;

// The fold of one character, remembered: a text uses a small alphabet, and the map of a text whose characters change length is built one
// character at a time.
const foldCache = new Map();
function foldChar(ch) {
  let folded = foldCache.get(ch);
  if (folded === undefined) {
    folded = ch.toUpperCase().toLowerCase();
    if (folded === '\u00df') folded = 'ss'; // the capital sharp s U+1E9E lowers to the sharp s, which folds to "ss": the one code point whose fold is not a fixed point
    if (foldCache.size >= 4096) foldCache.clear();
    foldCache.set(ch, folded);
  }
  return folded;
}

/**
 * The text folded for a case-insensitive comparison: every code point is folded by c.toUpperCase().toLowerCase(). The string methods do it for
 * the whole text at once with one exception, the final sigma (toLowerCase turns a capital sigma at the end of a word into U+03C2 where the
 * fold of a single character gives U+03C3), which is put right at the end: U+03C2 is only ever made that way, so every one of them is U+03C3.
 * A folded text can be longer than the text (the sharp s is "ss", U+0130 is "i" and a combining dot), so when it is the result remembers where
 * each unit came from: `from[i]` is the index in the original of the character the folded unit i belongs to, and `head[i]` is 1 when the
 * unit is the first one of that character's fold. When every character keeps its length (all ASCII text, most others) `from` and `head` are
 * null: index i is index i.
 * @returns {{ text: string, from: Uint32Array|null, head: Uint8Array|null }}
 */
export function foldText(text) {
  const t = String(text ?? '');
  if (ASCII_ONLY.test(t)) return { text: t.toLowerCase(), from: null, head: null };
  const folded = t.toUpperCase().toLowerCase().replaceAll('\u03c2', '\u03c3');
  // No character folds to fewer units than it has, so the same length means every character kept its length (a sharp s left in the result
  // comes from U+1E9E, which must still become "ss": that text takes the slow way)
  if (folded.length === t.length && !folded.includes('\u00df')) return { text: folded, from: null, head: null };
  // Some character changed its length: the text is rebuilt one character at a time (the same fold as above, by construction) with the map
  const out = [];
  const from = [];
  const head = [];
  for (let i = 0; i < t.length;) {
    const ch = String.fromCodePoint(t.codePointAt(i)); // a surrogate pair is one character, a lone surrogate is one
    const f = t.charCodeAt(i) < 128 ? ch.toLowerCase() : foldChar(ch);
    out.push(f);
    for (let j = 0; j < f.length; j++) {
      from.push(i);
      head.push(j === 0 ? 1 : 0);
    }
    i += ch.length;
  }
  return { text: out.join(''), from: Uint32Array.from(from), head: Uint8Array.from(head) };
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
// whether index i of the text is between the two halves of a surrogate pair
const splitsPair = (text, i) => i > 0 && i < text.length && isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1));

/** The first match of the folded query in `text`, as offsets into the ORIGINAL text, or null. The match starts and ends on whole characters. */
export function findFolded(text, foldedQuery) {
  if (typeof text !== 'string' || typeof foldedQuery !== 'string' || foldedQuery === '') return null;
  const f = foldText(text);
  let at = f.text.indexOf(foldedQuery);
  while (at >= 0) {
    const stop = at + foldedQuery.length;
    if (f.from === null) {
      if (!splitsPair(text, at) && !splitsPair(text, stop)) return { start: at, end: stop };
    } else if (f.head[at] === 1 && (stop === f.text.length || f.head[stop] === 1)) {
      return { start: f.from[at], end: stop === f.text.length ? text.length : f.from[stop] };
    }
    at = f.text.indexOf(foldedQuery, at + 1);
  }
  return null;
}

/**
 * About `size` characters of `text` around [start, end): the whole match always (a longer match makes a longer excerpt), the rest shared
 * before and after it, moved to one side at an edge of the text, and cut so that no surrogate pair is split. No ellipsis is added: the
 * excerpt is the original text and `start` / `end` slice it.
 * @returns {{ excerpt: string, start: number, end: number }} start and end are UTF-16 offsets into the excerpt
 */
export function excerptOf(text, start, end, size = SEARCH_EXCERPT_CHARS) {
  const total = Math.max(size, end - start);
  const extra = total - (end - start);
  let from = start - Math.floor(extra / 2);
  let to = end + (extra - Math.floor(extra / 2));
  if (from < 0) { to -= from; from = 0; }
  if (to > text.length) { from = Math.max(0, from - (to - text.length)); to = text.length; }
  if (from > 0 && from < start && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from += 1;
  if (to < text.length && to > end && isHigh(text.charCodeAt(to - 1)) && isLow(text.charCodeAt(to))) to -= 1;
  return { excerpt: text.slice(from, to), start: start - from, end: end - from };
}

// The text a Fact (or a plain value) gives to a search: nothing for an unknown Fact or a null; a string as it is; any other value as the
// indented JSON the drawer shows. A Fact's reason and method are wfviz's own words and are never searched.
function searchText(f) {
  let v = f;
  if (f !== null && typeof f === 'object' && 'prov' in f) {
    if (f.prov === 'unknown') return undefined;
    v = f.value;
  }
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  try {
    const json = JSON.stringify(v, null, 2);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

const STOP_TIME = Symbol('search: time budget spent');
const STOP_LIMIT = Symbol('search: a match beyond the limit');

/**
 * The scan of GET /api/search over Run models. `runIds()` gives the ids to scan (already filtered by the caller to the runs that are visible
 * and loaded), `getRun(id)` the Run (null for none; a throw skips the run and goes to onError). `clock()` is read once at the start and
 * before every run, agent, field and activity entry: when more than `budgetMs` has passed the scan stops and `more` is true.
 * @returns {{ results: object[], more: boolean }}
 */
export function searchRuns({ query, limit = SEARCH_DEFAULT_LIMIT, budgetMs = SEARCH_BUDGET_MS, clock = () => performance.now(), runIds, getRun, onError = () => {} }) {
  const t0 = clock();
  const results = [];
  let more = false;
  const needle = foldText(query).text;
  const tick = () => { if (clock() - t0 > budgetMs) throw STOP_TIME; };
  // one field: its first match is one result; the match after the last one the limit allows says there is more
  const field = (runId, agentId, name, text) => {
    tick();
    if (typeof text !== 'string' || text === '') return;
    const m = findFolded(text, needle);
    if (m === null) return;
    if (results.length >= limit) throw STOP_LIMIT;
    const e = excerptOf(text, m.start, m.end);
    results.push({ runId, ...(agentId === undefined ? {} : { agentId }), field: name, excerpt: e.excerpt, start: e.start, end: e.end });
  };
  try {
    for (const id of runIds()) {
      tick();
      let run = null;
      try {
        run = getRun(id);
      } catch (err) {
        onError(err);
      }
      if (run === null || typeof run !== 'object') continue;
      const runId = id;
      field(runId, undefined, 'name', searchText(run.name));
      field(runId, undefined, 'description', searchText(run.description));
      const lines = run.logs !== null && typeof run.logs === 'object' && run.logs.prov !== 'unknown' ? run.logs.value : undefined;
      if (Array.isArray(lines)) for (const line of lines) field(runId, undefined, 'log', searchText(line));
      const agents = run.agents !== null && typeof run.agents === 'object' ? run.agents : {};
      for (const [agentId, a] of Object.entries(agents)) { // own keys only: an agent id is data ("__proto__" is a key like any other)
        tick();
        if (a === null || typeof a !== 'object') continue;
        field(runId, agentId, 'prompt', searchText(a.prompt));
        field(runId, agentId, 'result', searchText(a.result));
        if (!Array.isArray(a.activity)) continue;
        for (const x of a.activity) {
          tick();
          if (x === null || typeof x !== 'object') continue;
          field(runId, agentId, 'activity-summary', x.inputSummary);
          field(runId, agentId, 'activity-text', x.text);
        }
      }
    }
  } catch (err) {
    if (err === STOP_TIME) more = true;
    else if (err === STOP_LIMIT) more = true;
    else throw err;
  }
  return { results, more };
}

function sendJson(res, status, value, headers) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sseFrame(event, data) {
  // JSON.stringify never emits a raw newline, so one `data:` line is always enough.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {object} options
 * @param {{ getRun(id: string): object|null, listRuns(): object[], onChange(cb: (runId: string) => void): () => void,
 *           onEvent(cb: (event: object) => void): () => void, eventsSince(runId: string, seq: number): object[] }} options.store
 * @param {string} [options.webDir] directory served at `/`; without it only /api answers
 * @param {'real'|'demo'|'replay'} options.mode
 * @param {string|null} [options.version] sent in the `hello` event
 * @param {(count: number) => void} [options.onClientCountChange] called with the new SSE client count (replay streams included)
 * @param {{ attach(runId: string, agentId: string, activity: object[]): object[] }} [options.editInputs]
 *        puts the full input of edit tools on the transcript entries (src/server/edit-inputs.mjs); without it the
 *        transcript is the store's activity as it is
 * @param {{ prepare?(request: { runId: string }): Promise<unknown>,
 *           open(request: { runId: string, speed: number|undefined, prepared: unknown, onRun(latest: object | (() => object|null)): void,
 *           onEvent(event: object): void, onEnd(): void, onError(err: unknown): void }): { stop(): void } }} [options.replays] real mode only:
 *        makes GET /api/runs/:id/replay work; without it (or in another mode) that route is a 404. `speed` is a number above 0 or
 *        undefined (the replay's own default). `onRun` is told that the Run changed: it gives the Run, or a function that gives the newest
 *        Run, called only when a snapshot is sent (at most one per throttle window), so a replay never builds a Run nobody asked for.
 *        `prepare` (optional) is awaited first; see the header.
 * @param {{ isLoaded(runId: string): boolean, load(runId: string): Promise<unknown> }} [options.loader] real mode: which runs are read in full
 *        and a way to read one more (the launcher gives the isLoaded / loadRun of its source); without it every run counts as loaded; see the header
 * @param {boolean} [options.offline] GET /api/prices never fetches: 503 { error: "offline" } (the launcher's --offline)
 * @param {(url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>} [options.fetchImpl]
 *        test hook: the fetch of the price list, default the global fetch; it is called as fetchImpl(PRICES_URL, { signal }) and nothing else
 * @param {() => number} [options.now] test hook: the clock of `fetchedAt` and of the one-hour keep, default Date.now
 * @param {number} [options.pricesTimeoutMs] test hook: the timeout of the price fetch, default 5000
 * @param {() => number} [options.searchClock] test hook: the clock (ms) of the 500 ms budget of GET /api/search, default performance.now; it is not the
 *        wall clock `now` and not the SSE throttle's clock
 * @param {number} [options.throttleMs] window of the `run` snapshot throttle, default 1000 (test hook)
 * @param {number} [options.debounceMs] deprecated name of throttleMs
 * @param {number} [options.heartbeatMs] test hook, default 15000
 * @param {(err: unknown) => void} [options.onError] default: one line on stderr
 * @returns {http.Server} not listening yet. `server.close()` also ends all SSE streams, so it completes.
 */
export function createServer(options = {}) {
  const {
    store,
    webDir,
    mode,
    version = null,
    onClientCountChange,
    editInputs = null,
    replays = null,
    loader = null,
    offline = false,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    pricesTimeoutMs = PRICES_TIMEOUT_MS,
    searchClock = () => performance.now(),
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    onError = defaultOnError,
  } = options;
  const throttleMs = options.throttleMs ?? options.debounceMs ?? DEFAULT_THROTTLE_MS;

  const storeMethods = ['getRun', 'listRuns', 'onChange', 'onEvent', 'eventsSince'];
  if (!store || storeMethods.some((m) => typeof store[m] !== 'function')) {
    throw new TypeError(`createServer: store must provide ${storeMethods.join(', ')}`);
  }
  if (mode !== 'real' && mode !== 'demo' && mode !== 'replay') {
    throw new TypeError(`createServer: mode must be "real", "demo" or "replay", got ${JSON.stringify(mode)}`);
  }
  if (replays !== null && typeof replays?.open !== 'function') throw new TypeError('createServer: replays must provide open()');
  if (loader !== null && (typeof loader?.isLoaded !== 'function' || typeof loader?.load !== 'function')) {
    throw new TypeError('createServer: loader must provide isLoaded() and load()');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('createServer: fetchImpl and now must be functions');
  if (typeof searchClock !== 'function') throw new TypeError('createServer: searchClock must be a function');
  if (!Number.isFinite(pricesTimeoutMs) || pricesTimeoutMs <= 0) throw new TypeError(`createServer: pricesTimeoutMs must be a number > 0, got ${JSON.stringify(pricesTimeoutMs)}`);
  if (!Number.isFinite(throttleMs) || throttleMs < 0) {
    throw new TypeError(`createServer: throttleMs must be a number >= 0, got ${JSON.stringify(throttleMs)}`);
  }

  const webRoot = webDir ? path.resolve(webDir) : null;
  // A demo or replayed run must never be shown in another mode and vice versa. The launcher feeds the store only
  // the matching source; this is the second lock. An object without `source` is not filtered.
  const expectedSource = mode;
  const visible = (obj) => obj != null && (obj.source == null || obj.source === expectedSource);
  // Whether a run is read in full. Without a loader every run is. A loader that throws counts as "not loaded" (the run then gets no snapshot).
  const isLoaded = (runId) => {
    if (!loader) return true;
    try {
      return loader.isLoaded(runId) === true;
    } catch (err) {
      onError(err);
      return false;
    }
  };

  // One SSE connection: its response and, per run, when a snapshot was last sent and the timer of the one due.
  /** @type {Set<{ res: http.ServerResponse, runs: Map<string, { last: number, timer: NodeJS.Timeout|null }> }>} */
  const clients = new Set();
  /** Replay streams: a set of its own, so that nothing the real store says (same run id, other seq) is ever written to one. */
  const replayClients = new Set();
  /** Replays whose `prepare` has not answered yet: they hold a slot, so that the limit holds while the runs are being read. */
  let replaysPreparing = 0;
  let closing = false;
  /** runId -> whether the run belongs to this mode; asked of the store once per run, on its first event */
  const eventVisible = new Map();
  /** runId -> the load in flight (one per run id); the entry goes when it settles, also when it fails */
  const loads = new Map();
  /** the price list: { at, body } kept for PRICES_TTL_MS; the fetch in flight (one at a time, shared by every request that comes meanwhile) */
  let pricesKept = null;
  let pricesJob = null;
  let heartbeatTimer = null;
  let unsubscribe = [];
  const clock = () => performance.now();

  const safe = (fn) => {
    try {
      fn();
    } catch (err) {
      onError(err);
    }
  };

  // ---- SSE -------------------------------------------------------------------------------------

  function writeTo(res, chunk) {
    if (res.destroyed || res.writableEnded) return;
    res.write(chunk);
    if (res.writableLength > MAX_SSE_BUFFER_BYTES) res.destroy();
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const c of clients) writeTo(c.res, ': heartbeat\n\n');
      for (const c of replayClients) writeTo(c.res, ': heartbeat\n\n');
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearTimers(client) {
    for (const st of client.runs.values()) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    }
  }

  const streamCount = () => clients.size + replayClients.size;

  function removeClient(client) {
    if (!(client.replay ? replayClients : clients).delete(client)) return;
    clearTimers(client);
    if (streamCount() === 0) stopHeartbeat();
    if (onClientCountChange) safe(() => onClientCountChange(streamCount()));
  }

  // The Run a client is due: the store's latest state of the run, or for a replay stream what the replay last gave (the server has no store
  // to ask for it): the Run, or a function that builds the newest Run, called here and so at most once per snapshot that goes out. A replay
  // stream sends a Run whose source is "replay" and nothing else: a real Run cannot leave by that route.
  function snapshotFor(client, runId) {
    const rep = client.replay;
    if (!rep) {
      const run = store.getRun(runId);
      return visible(run) ? run : null;
    }
    const run = typeof rep.latest === 'function' ? rep.latest() : rep.latest;
    if (run == null) return null;
    if (run.source !== 'replay') {
      safe(() => onError(new Error(`replay of ${runId}: a Run whose source is not "replay" was dropped`)));
      return null;
    }
    return run;
  }

  // One `run` snapshot to one client, now.
  function sendSnapshot(client, runId) {
    if (client.replay) client.replay.dirty = false; // the latest the replay gave is being dealt with now
    let st = client.runs.get(runId);
    if (!st) client.runs.set(runId, (st = { last: -Infinity, timer: null }));
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    safe(() => {
      const run = snapshotFor(client, runId);
      if (!run) return;
      st.last = clock();
      writeTo(client.res, sseFrame('run', run));
    });
  }

  // A change of a run, for one client: send at once when the last snapshot of this run is a full window old, else
  // make sure one goes out when the window ends. A send that is already due carries the latest state, so a change
  // that arrives while one is due needs nothing more.
  function queueSnapshot(client, runId) {
    let st = client.runs.get(runId);
    if (!st) client.runs.set(runId, (st = { last: -Infinity, timer: null }));
    if (st.timer) return;
    const wait = st.last + throttleMs - clock();
    if (wait <= 0) return sendSnapshot(client, runId);
    st.timer = setTimeout(sendSnapshot, wait, client, runId);
    st.timer.unref?.();
  }

  // One snapshot after the other, waiting whenever the connection is full: a Run can be megabytes (it holds every prompt),
  // and all of them at once would pass the buffer limit of writeTo and cost the client its connection - again on every
  // reconnect.
  async function sendInitialSnapshots(client, ids) {
    for (const id of ids) {
      if (!clients.has(client)) return;
      sendSnapshot(client, id);
      if (client.res.destroyed) return; // writeTo gave up on a full connection: nobody is left to wait for
      if (client.res.writableNeedDrain) await drainedOrClosed(client.res);
    }
  }

  // Resolves when the response has drained or has closed, and takes both listeners off whichever came first: a listener
  // left behind per wait would pile up on the response (Node warns from the 11th).
  function drainedOrClosed(res) {
    return new Promise((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.on('drain', done);
      res.on('close', done);
    });
  }

  function handleStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    const client = { res, runs: new Map() };
    res.on('error', () => {});
    res.on('close', () => removeClient(client));
    clients.add(client);
    res.flushHeaders();
    writeTo(res, sseFrame('hello', { mode, version }));
    // the current state of every run, so that a client that connects (or reconnects) is level without asking
    let ids = [];
    safe(() => {
      ids = store.listRuns().filter((summary) => visible(summary) && typeof summary.id === 'string' && isLoaded(summary.id)).map((summary) => summary.id);
    });
    sendInitialSnapshots(client, ids).catch((err) => safe(() => onError(err)));
    startHeartbeat();
    if (onClientCountChange) safe(() => onClientCountChange(streamCount()));
  }

  // ---- replay streams ----------------------------------------------------------------------------

  // Stops one replay stream, once however many of these come: the client leaves, the replay ends or fails, the server closes. It frees the
  // slot, clears the snapshot timers, calls the replay's stop() (at once when the handle is not there yet: open() has not returned) and,
  // for what the server ends itself, ends the response (and the connection: nothing waits for a reconnect).
  function stopReplay(client, { endResponse = true } = {}) {
    const rep = client.replay;
    if (rep.stopped) return;
    rep.stopped = true;
    removeClient(client);
    if (rep.handle) safe(() => rep.handle.stop());
    if (endResponse) {
      safe(() => {
        client.res.end();
        client.res.socket?.destroySoon();
      });
    }
  }

  // The replay's own callbacks for one stream. After stopReplay nothing a replay still calls writes anything.
  function replayCallbacks(client) {
    const rep = client.replay;
    const { res } = client;
    return {
      onRun(latest) {
        if (rep.stopped) return;
        rep.latest = latest;
        rep.dirty = true;
        queueSnapshot(client, rep.runId);
      },
      onEvent(event) {
        if (rep.stopped || event == null || typeof event !== 'object') return;
        rep.events += 1;
        writeTo(res, sseFrame('event', event));
      },
      onEnd() {
        if (rep.stopped) return;
        clearTimers(client);
        if (rep.dirty) sendSnapshot(client, rep.runId); // the last state, when the throttle still held a change back
        writeTo(res, sseFrame('end', { runId: rep.runId, events: rep.events }));
        stopReplay(client);
      },
      // The contract names no error event: a replay that fails ends the stream without `end`, and the reason goes to onError.
      onError(err) {
        if (rep.stopped) return;
        safe(() => onError(err));
        stopReplay(client);
      },
    };
  }

  // The answer when `prepare` rejects: the status the error carries (an integer 400..599), else 500; the reason is its message.
  function prepareFailure(err) {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const reason = typeof err?.message === 'string' && err.message !== '' ? err.message : 'the run cannot be replayed (no reason given)';
    return { status, reason };
  }

  function handleReplay(req, res, runId, search) {
    if (mode !== 'real' || !replays) return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const speed = parseSpeed(search);
    if (speed.error) return sendJson(res, 400, { error: speed.error });
    const run = visibleRun(runId);
    if (!run) return sendJson(res, 404, { error: 'run not found' });
    if (run.status?.value === 'running') {
      return sendJson(res, 409, { error: 'the run is still running: only a finished run can be replayed' });
    }
    if (replayClients.size + replaysPreparing >= MAX_REPLAYS) {
      return sendJson(res, 429, { error: `${MAX_REPLAYS} replays are already open: close one first` });
    }
    if (typeof replays.prepare !== 'function') return streamReplay(req, res, runId, speed.value, undefined);

    // The run is found and read before the stream says hello: a failure here is a JSON answer with its reason, and the page that asked
    // keeps the view it has. The slot is held meanwhile; a client that leaves, or a server that closes, meanwhile opens nothing.
    replaysPreparing += 1;
    let left = false;
    const leave = () => { left = true; };
    res.on('close', leave);
    const settle = () => {
      replaysPreparing -= 1;
      res.off('close', leave);
    };
    return Promise.resolve()
      .then(() => replays.prepare({ runId }))
      .then(
        (prepared) => {
          settle();
          if (left) return;
          if (closing) return sendJson(res, 503, { error: 'the server is closing' });
          streamReplay(req, res, runId, speed.value, prepared);
        },
        (err) => {
          settle();
          if (left) return;
          const { status, reason } = prepareFailure(err);
          if (status >= 500) safe(() => onError(err)); // a lookup that says "not found" is an answer; a read that fails is the server's to report
          sendJson(res, status, { error: reason });
        },
      );
  }

  function streamReplay(req, res, runId, speed, prepared) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    const client = { res, runs: new Map(), replay: { runId, latest: null, dirty: false, handle: null, stopped: false, events: 0 } };
    res.on('error', () => {});
    // registered before open(): a replay may call back at once, and the client may be gone before the handle exists
    res.on('close', () => stopReplay(client, { endResponse: false }));
    replayClients.add(client);
    res.flushHeaders();
    writeTo(res, sseFrame('hello', { mode: 'replay', version, runId }));
    startHeartbeat();
    if (onClientCountChange) safe(() => onClientCountChange(streamCount()));

    const callbacks = replayCallbacks(client);
    let handle = null;
    try {
      handle = replays.open({ runId, speed, prepared, ...callbacks });
    } catch (err) {
      return callbacks.onError(err);
    }
    if (client.replay.stopped) safe(() => handle?.stop?.()); // ended, failed or left while open() was running: stop it, once
    else client.replay.handle = handle ?? null;
  }

  function onStoreChange(runId) {
    if (typeof runId !== 'string' || clients.size === 0) return;
    if (!isLoaded(runId)) return; // a run that is only listed has no snapshot; it gets one when it is loaded
    for (const client of clients) queueSnapshot(client, runId);
  }

  function onStoreEvent(event) {
    if (clients.size === 0 || event == null || typeof event.runId !== 'string') return;
    safe(() => {
      let ok = eventVisible.get(event.runId);
      if (ok === undefined) {
        const run = store.getRun(event.runId);
        if (run == null) return; // the store does not know the run (yet): nothing to say about it
        ok = visible(run);
        eventVisible.set(event.runId, ok);
      }
      if (!ok) return;
      const frame = sseFrame('event', event);
      for (const client of clients) writeTo(client.res, frame);
    });
  }

  function endStreams() {
    for (const client of [...replayClients]) stopReplay(client);
    stopHeartbeat();
    for (const client of [...clients]) {
      clearTimers(client);
      safe(() => {
        client.res.end();
        client.res.socket?.destroySoon();
      });
    }
  }

  // ---- JSON API --------------------------------------------------------------------------------

  function visibleRun(id) {
    const run = store.getRun(id);
    return visible(run) ? run : null;
  }

  // One load per run id at a time: a request for a run that is being loaded waits for that load. The entry is dropped when the load
  // settles (a failure too), so a later request tries again.
  function loadOnce(runId) {
    let job = loads.get(runId);
    if (!job) {
      job = Promise.resolve()
        .then(() => loader.load(runId))
        .then((value) => {
          // the run is now loaded: the clients of the stream get its snapshot (none was sent while it was only listed)
          if (!closing && isLoaded(runId)) onStoreChange(runId);
          return value;
        })
        .finally(() => { if (loads.get(runId) === job) loads.delete(runId); });
      loads.set(runId, job);
    }
    return job;
  }

  // GET /api/runs/:id of a run that is listed and not loaded: load it, then answer the Run as the store has it. A failed load is a 500
  // with its reason; a client that left meanwhile gets nothing written, and its `close` listener goes when the load settles.
  function handleLoadAndSend(res, runId) {
    let left = false;
    const leave = () => { left = true; };
    res.on('close', leave);
    return loadOnce(runId).then(
      () => {
        res.off('close', leave);
        if (left) return;
        const run = visibleRun(runId);
        return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: 'run not found' });
      },
      (err) => {
        res.off('close', leave);
        safe(() => onError(err));
        if (left) return;
        const text = typeof err?.message === 'string' ? err.message.split('\n')[0].trim() : '';
        sendJson(res, 500, { error: text !== '' ? text : 'the run could not be loaded (no reason given)' });
      },
    );
  }

  // ---- prices ------------------------------------------------------------------------------------

  // A price of OpenRouter's list is a string (or a number) in USD per token. Only a finite number that is not negative counts: "-1" is
  // OpenRouter's "price varies" and a bad value must leave the key out, never become 0.
  const priceOf = (x) => {
    if (typeof x === 'string' && x.trim() === '') return null;
    const n = typeof x === 'string' || typeof x === 'number' ? Number(x) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  // The answer of GET <PRICES_URL> as { models } of the keys the page needs, or throws an Error whose message is the one-line reason.
  function modelsFrom(body) {
    const list = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.data : undefined;
    if (!Array.isArray(list)) throw new Error('answer is not a model list');
    // ids are network data: define own properties so that "__proto__" is a key, not a prototype
    const models = {};
    for (const m of list) {
      if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '' || Object.hasOwn(models, m.id)) continue;
      const p = m.pricing !== null && typeof m.pricing === 'object' ? m.pricing : {};
      const input = priceOf(p.prompt);
      const output = priceOf(p.completion);
      if (input === null || output === null) continue;
      const entry = { input, output };
      const cacheRead = priceOf(p.input_cache_read);
      const cacheWrite = priceOf(p.input_cache_write);
      if (cacheRead !== null) entry.cacheRead = cacheRead;
      if (cacheWrite !== null) entry.cacheWrite = cacheWrite;
      Object.defineProperty(models, m.id, { value: entry, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(models).length === 0) throw new Error('answer has no model with a price');
    return models;
  }

  const timeoutText = () => (pricesTimeoutMs % 1000 === 0 ? `${pricesTimeoutMs / 1000} s` : `${pricesTimeoutMs} ms`);

  /** the controller of the fetch in flight: the server closing aborts it */
  let pricesAbort = null;

  // One fetch of the list: resolves { fetchedAt, models }, rejects with an Error whose message is the reason (one line, never the upstream body).
  // The timer is cleared when the fetch settles; it is unref'd, so it never keeps the process alive. The race makes the timeout and the close
  // end the request even for a fetch that ignores its signal.
  function fetchPrices() {
    const controller = new AbortController();
    pricesAbort = controller;
    let timer = null;
    let onAbort = null;
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timeout after ${timeoutText()}`));
        controller.abort();
      }, pricesTimeoutMs);
      timer.unref?.();
      onAbort = () => reject(new Error('the server is closing'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    stopped.catch(() => {}); // settled by the race below, or never: no unhandled rejection either way
    const work = (async () => {
      let res;
      try {
        res = await fetchImpl(PRICES_URL, { signal: controller.signal });
      } catch (err) {
        const text = typeof err?.cause?.code === 'string' ? err.cause.code : typeof err?.message === 'string' ? err.message : '';
        throw new Error(`request failed${text !== '' ? `: ${text.split('\n')[0].trim().slice(0, 120)}` : ''}`);
      }
      if (!res || res.ok !== true) throw new Error(`HTTP ${Number.isInteger(res?.status) ? res.status : 'error'}`);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new Error('answer is not a model list');
      }
      return { fetchedAt: now(), models: modelsFrom(body) };
    })();
    return Promise.race([work, stopped]).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (pricesAbort === controller) pricesAbort = null;
      work.catch(() => {}); // a fetch that loses the race may still fail later: that is not unhandled
    });
  }

  // The kept list, or the one fetch in flight, or a new fetch. An expired list is dropped before the new fetch, so a failed refetch never
  // serves it; a failure is not kept.
  function pricesAnswer() {
    if (pricesKept !== null && now() - pricesKept.at < PRICES_TTL_MS) return Promise.resolve({ ok: true, body: pricesKept.body });
    pricesKept = null;
    if (pricesJob === null) {
      const job = fetchPrices().then(
        ({ fetchedAt, models }) => {
          const body = { source: 'openrouter', url: PRICES_URL, fetchedAt, models };
          pricesKept = { at: fetchedAt, body };
          return { ok: true, body };
        },
        (err) => ({ ok: false, reason: typeof err?.message === 'string' && err.message !== '' ? err.message.split('\n')[0] : 'the price list could not be fetched' }),
      ).finally(() => { if (pricesJob === job) pricesJob = null; });
      pricesJob = job;
    }
    return pricesJob;
  }

  // GET /api/prices. Nothing is written to a client that has left.
  function handlePrices(req, res) {
    if (mode === 'demo') return sendJson(res, 404, { error: 'not found' }); // made-up tokens have no price, and a demo never needs the network
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    if (offline) return sendJson(res, 503, { error: 'offline' });
    return pricesAnswer().then((answer) => {
      if (res.destroyed) return;
      if (answer.ok) return sendJson(res, 200, answer.body);
      return sendJson(res, 503, { error: answer.reason });
    });
  }

  // ---- search ------------------------------------------------------------------------------------

  // `q` is required, given once and not trimmed; `limit` is digits only, at least 1, absent is the default, above the maximum it is the maximum.
  function parseSearch(search) {
    const params = new URLSearchParams(search);
    const qs = params.getAll('q');
    if (qs.length > 1) return { error: 'q must be given once' };
    if (qs.length === 0 || qs[0] === '') return { error: 'q is required: the text to search for' };
    const limits = params.getAll('limit');
    if (limits.length > 1) return { error: 'limit must be given once' };
    let limit = SEARCH_DEFAULT_LIMIT;
    if (limits.length === 1) {
      if (!/^\d+$/.test(limits[0]) || Number(limits[0]) < 1) return { error: 'limit must be an integer >= 1' };
      limit = Math.min(Number(limits[0]), SEARCH_MAX_LIMIT);
    }
    return { q: qs[0], limit };
  }

  // GET /api/search: a read of the Run models the store holds (see the header); nothing is loaded, cached or written.
  function handleSearch(req, res, search) {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    const p = parseSearch(search);
    if (p.error) return sendJson(res, 400, { error: p.error });
    const answer = searchRuns({
      query: p.q,
      limit: p.limit,
      clock: searchClock,
      runIds: () => store.listRuns().filter((summary) => visible(summary) && typeof summary.id === 'string' && isLoaded(summary.id)).map((summary) => summary.id),
      getRun: visibleRun,
      onError: (err) => safe(() => onError(err)),
    });
    return sendJson(res, 200, answer);
  }

  // `speed` of a replay: absent is undefined (the replay's own default; the server invents none), else a decimal number above 0. A
  // repeated `speed` is refused (which one would be meant?).
  function parseSpeed(search) {
    const all = new URLSearchParams(search).getAll('speed');
    if (all.length === 0) return { value: undefined };
    if (all.length > 1) return { error: 'speed must be given once' };
    const n = SPEED_DECIMAL.test(all[0]) ? Number(all[0]) : NaN;
    if (!Number.isFinite(n) || n <= 0) return { error: 'speed must be a number above 0' };
    return { value: n };
  }

  function parseTail(search) {
    const raw = new URLSearchParams(search).get('tail');
    if (raw === null) return DEFAULT_TAIL;
    if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) return null;
    return Math.min(Number(raw), MAX_TAIL);
  }

  // `since` is a sequence number: digits only (no sign, no fraction, no exponent), at most 15 of them so that the
  // number is exact. Absent means 0, the whole backlog.
  function parseSince(search) {
    const raw = new URLSearchParams(search).get('since');
    if (raw === null) return 0;
    if (!/^\d{1,15}$/.test(raw)) return null;
    return Number(raw);
  }

  function handleApi(req, res, rawPath, search) {
    let parts;
    try {
      parts = rawPath.split('/').slice(1).map(decodeURIComponent);
    } catch {
      return sendJson(res, 400, { error: 'malformed URL encoding' });
    }
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // one trailing slash
    const [, resource, p1, p2, p3] = parts;

    if (resource === 'stream' && parts.length === 2) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleStream(req, res);
    }
    if (resource === 'prices' && parts.length === 2) return handlePrices(req, res);
    if (resource === 'search' && parts.length === 2) return handleSearch(req, res, search);
    if (resource === 'runs' && parts.length === 2) {
      const list = store.listRuns().filter(visible);
      return sendJson(res, 200, loader ? list.map((summary) => ({ ...summary, loaded: isLoaded(summary.id) })) : list);
    }
    if (resource === 'runs' && parts.length === 3 && p1) {
      const run = visibleRun(p1);
      if (!run) return sendJson(res, 404, { error: 'run not found' });
      if (req.method !== 'GET' || isLoaded(p1)) return sendJson(res, 200, run);
      return handleLoadAndSend(res, p1);
    }
    if (resource === 'runs' && parts.length === 4 && p1 && p2 === 'events') {
      const since = parseSince(search);
      if (since === null) return sendJson(res, 400, { error: 'since must be an integer >= 0' });
      if (!visibleRun(p1)) return sendJson(res, 404, { error: 'run not found' });
      return sendJson(res, 200, store.eventsSince(p1, since));
    }
    if (resource === 'runs' && parts.length === 4 && p1 && p2 === 'replay') return handleReplay(req, res, p1, search);
    if (resource === 'agents' && parts.length === 5 && p1 && p2 && p3 === 'transcript') {
      const tail = parseTail(search);
      if (tail === null) return sendJson(res, 400, { error: 'tail must be an integer >= 1' });
      const run = visibleRun(p1);
      if (!run) return sendJson(res, 404, { error: 'run not found' });
      const agents = run.agents && typeof run.agents === 'object' ? run.agents : {};
      const agent = Object.hasOwn(agents, p2) ? agents[p2] : null;
      if (!agent) return sendJson(res, 404, { error: 'agent not found' });
      const activity = Array.isArray(agent.activity) ? agent.activity : [];
      // entries of edit tools carry their full input (and inputTruncated) when the store or the tracker has it
      const entries = editInputs ? editInputs.attach(p1, p2, activity) : activity;
      return sendJson(res, 200, entries.slice(-tail));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // ---- static files ----------------------------------------------------------------------------

  async function serveStatic(req, res, rawPath) {
    if (!webRoot) return sendJson(res, 404, { error: 'not found' });

    let rel;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      return sendJson(res, 400, { error: 'malformed URL encoding' });
    }
    if (rel.includes('\0')) return sendJson(res, 400, { error: 'bad path' });
    // Any ".." segment, with either separator, is refused outright. The prefix check and the realpath
    // check below stay as the second and third lock.
    if (rel.split(/[\\/]+/).includes('..')) return sendJson(res, 403, { error: 'forbidden' });

    let file = path.join(webRoot, rel);
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return sendJson(res, 403, { error: 'forbidden' });

    let st = await fs.promises.stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fs.promises.stat(file).catch(() => null);
    }
    if (!st || !st.isFile()) return sendJson(res, 404, { error: 'not found' });

    // A symlink inside webDir must not lead out of it.
    const [realFile, realRoot] = await Promise.all([fs.promises.realpath(file), fs.promises.realpath(webRoot)]);
    if (!realFile.startsWith(realRoot + path.sep)) return sendJson(res, 403, { error: 'forbidden' });

    return sendFile(req, res, realFile);
  }

  // Opens the file first and takes the size from the open descriptor, so that the head and the body describe
  // the same file even when it changes while it is sent. Nothing is written before the open has succeeded:
  // an unreadable file is a 403, not a connection that dies after a 200 head.
  async function sendFile(req, res, file) {
    let handle;
    try {
      handle = await fs.promises.open(file, 'r');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return sendJson(res, 404, { error: 'not found' });
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        safe(() => onError(err));
        return sendJson(res, 403, { error: 'forbidden' });
      }
      throw err;
    }

    let stream = null;
    let size = 0;
    try {
      const st = await handle.stat();
      if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
      if (res.destroyed) return; // the client left while the file was being looked up
      size = st.size;
      res.writeHead(200, {
        'Content-Type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD' || size === 0) return res.end();
      // Never more than the announced length, even if the file grows. The stream owns the handle from here on.
      stream = handle.createReadStream({ start: 0, end: size - 1 });
    } finally {
      if (!stream) await handle.close().catch(() => {});
    }

    // All of this runs in the tick in which `res.destroyed` was checked, so a client that is gone cannot slip
    // between the check and the listeners: if it leaves later, `close` destroys the stream and so closes the
    // descriptor. The response is ended on the stream's `end`, not after the descriptor has been closed.
    res.on('error', () => {});
    res.on('close', () => stream.destroy());
    stream.on('error', (err) => {
      safe(() => onError(err));
      res.destroy();
    });
    stream.on('end', () => {
      // A file that shrank while it was sent: ending the response normally would leave the client waiting for
      // the missing bytes, so the connection is cut and the client sees an incomplete response.
      if (stream.bytesRead === size) res.end();
      else res.destroy();
    });
    stream.pipe(res, { end: false });
  }

  // ---- routing ---------------------------------------------------------------------------------

  function methodNotAllowed(res, allow = 'GET, HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { Allow: allow });
  }

  // DNS-rebinding guard: a page on another origin can make the browser send requests to 127.0.0.1 under
  // its own host name. Only loopback host names are served. The port is not checked, so tunnels work.
  function hostAllowed(req) {
    const header = req.headers.host;
    if (header === undefined) return true;
    const m = /^(\[[0-9a-f:.]+\]|[^:/\s]+)(?::\d+)?$/i.exec(header.trim());
    return m !== null && LOOPBACK_HOSTNAMES.has(m[1].toLowerCase());
  }

  async function route(req, res) {
    if (!hostAllowed(req)) return sendJson(res, 403, { error: 'host not allowed' });
    const target = req.url ?? '';
    if (!target.startsWith('/')) return sendJson(res, 400, { error: 'bad request target' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);

    const q = target.indexOf('?');
    const rawPath = q === -1 ? target : target.slice(0, q);
    const search = q === -1 ? '' : target.slice(q + 1);

    if (rawPath === '/api' || rawPath.startsWith('/api/')) return handleApi(req, res, rawPath, search);
    return serveStatic(req, res, rawPath);
  }

  function fail(res, err) {
    safe(() => onError(err));
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    else res.destroy();
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => fail(res, err));
  });

  server.on('listening', () => {
    if (unsubscribe.length > 0) return;
    for (const off of [store.onChange(onStoreChange), store.onEvent(onStoreEvent)]) {
      unsubscribe.push(typeof off === 'function' ? off : () => {});
    }
  });
  server.on('close', () => {
    stopHeartbeat();
    for (const client of clients) clearTimers(client);
    for (const client of [...replayClients]) stopReplay(client);
    for (const off of unsubscribe) safe(off);
    unsubscribe = [];
  });

  // http.Server#close waits for open connections and an SSE stream never ends by itself.
  const baseClose = server.close.bind(server);
  server.close = (callback) => {
    closing = true;
    if (pricesAbort) pricesAbort.abort(); // a price fetch in flight ends with the server
    endStreams();
    return baseClose(callback);
  };

  return server;
}
