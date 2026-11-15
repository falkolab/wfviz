// Source "claude-fs": reads Claude Code Dynamic Workflow runs from the session directories
// under ~/.claude/projects and emits RawEvents (docs/contract.md section 1).
//
//   root/<slug>/<session>/subagents/workflows/<runId>/journal.jsonl
//                                                     /agent-<id>.meta.json
//                                                     /agent-<id>.jsonl
//   root/<slug>/<session>/workflows/<runId>.json                (only at the end of a run)
//   root/<slug>/<session>/workflows/scripts/<name>-<runId>.js   (written at launch)
//   <scriptPath named by the final file>                        (only when there is no copy above)
//
// Read-only. Polls with fs.stat (fs.watch is unreliable on external volumes). Append-only
// files are tailed by byte offset and only complete (newline-terminated) lines are emitted; a
// partial last line waits for its newline. Whole-file JSON is re-read when mtime/size change.
// On top of that the root is watched with fs.watch(root, { recursive: true }): a change polls the
// run it belongs to at once (a change outside any run looks for new runs). The watcher is only a
// trigger and only an accelerator; stat polling at pollMs always continues, and is the whole
// mechanism when `watch` is false, when fs.watch throws or when the watcher reports an error.
// Every format here is undocumented and version-dependent (sources/event-sources.md), so
// nothing is assumed: unreadable lines, unknown record types, unparsable files and files that
// cannot be opened become `source.warning` events, never an exception, and a value the files do
// not carry stays absent.
//
// The same RunPoller code backs both the live source and the one-shot readRunDir(), so a
// replay yields exactly the events a live source would have emitted.
//
// Run history (contract section 4, P1): every run under the root is listed, of any age. A run whose
// files changed within sinceMs is "loaded": read in full and watched, as always. An older run is
// "indexed": only its journal, its final file and its script are read (the same events those files
// give when a run is loaded, no new kinds, no `loaded` flag in an event); its agent files are neither
// listed nor opened, and a change under them is dropped by the watcher. loadRun(runId) reads the rest
// of one listed run with the same per-run state (offsets, hashes), so no line is emitted twice;
// isLoaded(runId) says which depth a run has. A run indexed and then changed within the window
// (its journal, final file or script delivers a new event) is loaded the same way.
//
// Delivery and state go together: events are handed to onEvent one by one while a file is
// read, and a file's read position (or "already emitted" mark) moves past a line only when its
// event was delivered. stop() therefore never loses anything: whatever was not delivered is
// read again after start().

import { createHash } from 'node:crypto';
import fs from 'node:fs'; // only fs.watch is used, and called as fs.watch so a test can replace it
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScriptMeta } from './script-meta.mjs';

export { parseScriptMeta };

const SRC = 'claude-fs';
const INPUT_SUMMARY_MAX = 200;
const TEXT_MAX = 500;
const MAX_READ_BYTES = 64 * 1024 * 1024; // one read window; a single line longer than this is not read
const MAX_BAD_LINE_WARNINGS = 20;        // per file; beyond that one "suppressed" note
const HOT_RUN_MS = 60_000;               // a run with no new events for this long is polled only on full scans
const SCAN_CONCURRENCY = 16;
const MAX_TIMER_MS = 2 ** 31 - 1;        // the longest delay setTimeout accepts; anything above is clamped to 1 ms
const WATCH_GAP_MS = 50;                 // change-triggered passes start at least this far apart (the first one at once)
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']); // the only tools whose full input is emitted
const MAX_INPUT_BYTES = 256 * 1024;      // longest JSON serialisation of an emitted tool input
const SCRIPT_MODIFIED_WARNING = 'script modified after the run';
const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'prompt', 'description'];

// The first lines of an agent transcript when a workflow was launched in a turn: the harness first
// relays the user's own message (RELAY_FRAME), then gives the task the script computed
// (COMPUTED_FRAME). Each is one frame line followed by the text with every line indented by two
// spaces (sources/event-sources.md, "Found later by a reviewer"; 421 of 421 real records checked).
const RELAY_FRAME = '[Workflow harness — user request]';
const COMPUTED_FRAME = '[Workflow harness — computed task]';
const FRAME_INDENT = '  ';

// Record types seen in untrimmed agent transcripts (Claude Code 2.1.317, a live workflow run)
// that carry nothing this source reads. They are skipped silently; any other unknown type
// yields one source.warning per file and type. Without this list every agent file would
// produce a dozen warnings. `attachment` is listed because only structured_output is read;
// its other subtypes (environment, skill_listing, prompt_snapshot, ...) are harness internals.
const IGNORED_TRANSCRIPT_TYPES = new Set(['attachment', 'api-request', 'api-request-shape', 'api-request-blob']);

// ---------------------------------------------------------------------------------------
// small helpers

async function readdirSafe(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // fs order is not guaranteed
  } catch {
    return [];
  }
}

async function statSafe(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

async function isDirEntry(dir, ent) {
  if (ent.isDirectory()) return true;
  if (ent.isSymbolicLink()) return (await statSafe(path.join(dir, ent.name)))?.isDirectory() === true;
  return false;
}

async function listSubdirs(dir) {
  const ents = await readdirSafe(dir);
  const names = [];
  for (const ent of ents) if (await isDirEntry(dir, ent)) names.push(ent.name);
  return names.sort();
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return `${cut}…`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function recordTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

function summarizeInput(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return truncate(input, INPUT_SUMMARY_MAX);
  if (isPlainObject(input)) {
    for (const k of SUMMARY_KEYS) {
      if (typeof input[k] === 'string' && input[k] !== '') return truncate(input[k], INPUT_SUMMARY_MAX);
    }
  }
  try {
    return truncate(JSON.stringify(input), INPUT_SUMMARY_MAX);
  } catch {
    return undefined;
  }
}

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// The first n UTF-16 units of s, without half of a surrogate pair at the end.
function cutString(s, n) {
  if (n >= s.length) return s;
  const cut = s.slice(0, n);
  const last = n > 0 ? cut.charCodeAt(n - 1) : 0;
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// A tool_use input as it goes into the event: the object as it is when its JSON serialisation is
// at most MAX_INPUT_BYTES. Above that the object keeps its shape (keys, arrays, other values) and
// its longest strings are cut to one common length, the longest that makes the serialisation fit;
// shorter strings stay whole. Returns { input, truncated }. When even all strings cut to nothing
// do not fit (the rest of the object is the bulk), `input` is undefined.
function limitInput(input) {
  const size = jsonBytes(input);
  if (size <= MAX_INPUT_BYTES) return { input, truncated: false };

  const copy = JSON.parse(JSON.stringify(input)); // the record's own object stays as it was read
  const slots = [];                               // every string value: where it is, how long, how big in JSON
  const stack = [copy];
  while (stack.length > 0) {
    const holder = stack.pop();
    for (const key of Object.keys(holder)) {
      const value = holder[key];
      if (typeof value === 'string') slots.push({ holder, key, value, bytes: jsonBytes(value) });
      else if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  // serialisation size when every string longer than `cap` is cut to `cap`; never grows with cap
  const sizeAt = (cap) => {
    let total = size;
    for (const s of slots) if (s.value.length > cap) total += jsonBytes(cutString(s.value, cap)) - s.bytes;
    return total;
  };
  if (sizeAt(0) > MAX_INPUT_BYTES) return { input: undefined, truncated: true };

  let lo = 0;                                                  // sizeAt(lo) fits
  let hi = slots.reduce((m, s) => Math.max(m, s.value.length), 0); // sizeAt(hi) = size does not fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sizeAt(mid) <= MAX_INPUT_BYTES) lo = mid;
    else hi = mid;
  }
  for (const s of slots) if (s.value.length > lo) s.holder[s.key] = cutString(s.value, lo);
  return { input: copy, truncated: true };
}

// The `input` / `inputTruncated` fields of an agent.activity record for one tool_use block: only
// for the tools in EDIT_TOOLS, and only when the input is an object; {} otherwise.
function editInputFields(block) {
  if (!EDIT_TOOLS.has(block?.name) || !isPlainObject(block.input)) return {};
  const { input, truncated } = limitInput(block.input);
  const fields = {};
  if (input !== undefined) fields.input = input;
  if (truncated) fields.inputTruncated = true;
  return fields;
}

// Text of a user message: a string, or the text blocks of a content array. null if none.
function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// per-run state and one polling pass

function makeRun(sessionDir, runId) {
  return {
    key: `${sessionDir}\0${runId}`,
    sessionDir,
    runId,
    sessionId: path.basename(sessionDir) || null,
    project: path.basename(path.dirname(sessionDir)) || null,
    runDir: path.join(sessionDir, 'subagents', 'workflows', runId),
    finalPath: path.join(sessionDir, 'workflows', `${runId}.json`),
    scriptPath: null,
    finalScriptPath: null,  // `scriptPath` named by the final file, if it has one (only used when no copy exists)
    endMs: undefined,       // when the run ended, if the final file says so (see runEndMs)
    files: new Map(),       // absolute path -> file state
    agentOrder: new Map(),  // agentId -> index of first appearance in the journal
    lastActiveAt: Date.now(),
    loaded: true,           // false = listed only (index mode: journal, final file and script, no agent file); see loadRun
    indexed: false,         // an index pass has been made (a change after it can promote the run)
  };
}

function fileState(run, file) {
  let st = run.files.get(file);
  if (!st) {
    st = {
      file,
      offset: 0,         // bytes consumed: everything up to and including the last newline read
      line: 0,           // newline-terminated lines consumed (1-based prov.line of the next is line + 1)
      sig: null,         // "mtimeMs:size" of a whole file already handled
      hash: null,        // sha1 of the whole-file text last emitted, so a mere touch does not repeat the event
      pendingSig: null,  // whole file that failed to parse once; warned only if it stays unchanged
      readError: null,   // error code of the last failed read of this file, so it is reported once
      pendingWarnings: [], // warnings that go out right after the event they belong to; kept here when stop() comes in between
      warned: new Set(),
      badLines: 0,
      promptDone: false,
      heldPrompt: null,  // the relayed user request, kept until the computed task follows (or it is the fallback)
      partialTail: false, // the last pass ended in a partial line (bytes after the last newline): more is being written
      dead: false,
    };
    run.files.set(file, st);
  }
  return st;
}

function mkEvent(run, kind, file, line, ts, data) {
  return { src: SRC, kind, runId: run.runId, sessionId: run.sessionId, project: run.project, ts, prov: { file, line }, data };
}

function warn(ctx, st, line, ts, message) {
  ctx.emit(mkEvent(ctx.run, 'source.warning', st.file, line, ts, { message }));
}

function warnOnce(ctx, st, key, line, ts, message) {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  warn(ctx, st, line, ts, message);
}

// A file that stat found but that could not be read (permissions, an I/O error, ...): say why,
// once per error code. A file that vanished between stat and read is simply tried again.
function reportReadError(ctx, st, err, mtime) {
  const code = err?.code ?? 'unknown';
  if (code === 'ENOENT' || ctx.stopped() || st.readError === code) return;
  st.readError = code;
  warn(ctx, st, null, mtime, `cannot read ${path.basename(st.file)}: ${err?.message ?? err}`);
}

// Tail an append-only JSONL file: emit only complete new lines. st.offset and st.line move past
// a line just before it is handled, and handling delivers its (at most one) event at once, so
// a stop() between two lines leaves the position exactly after the last delivered line.
async function pollJsonl(ctx, st, handleRecord) {
  if (st.dead) return;
  const stat = await statSafe(st.file);
  if (!stat || !stat.isFile()) return;
  if (ctx.stopped()) return;
  const mtime = Math.floor(stat.mtimeMs);

  if (stat.size < st.offset) {
    warn(ctx, st, null, mtime, `file shrank from ${st.offset} to ${stat.size} bytes; re-reading it from the start, earlier events may repeat`);
    st.offset = 0;
    st.line = 0;
    st.promptDone = false;
    st.heldPrompt = null;
    st.warned.clear();
    st.badLines = 0;
  }
  let readFailed = false;
  if (stat.size > st.offset) {
    let fh;
    try {
      fh = await fsp.open(st.file, 'r');
      while (st.offset < stat.size) {
        const base = st.offset;
        const len = Math.min(stat.size - base, MAX_READ_BYTES);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, base);
        if (bytesRead === 0) break;
        if (ctx.stopped()) return; // nothing of this window is consumed
        const window = buf.subarray(0, bytesRead);
        const lastNl = window.lastIndexOf(0x0a);
        if (lastNl < 0) {
          if (bytesRead === MAX_READ_BYTES) {
            st.dead = true;
            warn(ctx, st, st.line + 1, mtime, `line ${st.line + 1} is longer than ${MAX_READ_BYTES} bytes; file not read further`);
          }
          break; // partial last line: wait for its newline
        }
        let start = 0;
        while (start <= lastNl) {
          if (ctx.stopped()) return; // the lines before this one were delivered; this one is read again
          const nl = window.indexOf(0x0a, start);
          const lineNo = ++st.line;
          let text = window.toString('utf8', start, nl);
          start = nl + 1;
          st.offset = base + start;
          if (text.endsWith('\r')) text = text.slice(0, -1);
          if (text.trim() === '') continue;
          handleLine(ctx, st, text, lineNo, mtime, handleRecord);
        }
      }
      st.readError = null;
    } catch (err) {
      // vanished or unreadable between stat and read: report it (unless it just vanished) and try again on the next poll
      readFailed = true;
      reportReadError(ctx, st, err, mtime);
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  st.partialTail = !readFailed && st.offset < stat.size && !st.dead;
  if (ctx.oneShot && !readFailed && st.offset < stat.size && !st.dead) {
    warn(ctx, st, st.line + 1, mtime, `last line (${stat.size - st.offset} bytes) has no terminating newline; not emitted`);
  }
}

function handleLine(ctx, st, text, lineNo, mtime, handleRecord) {
  let rec;
  try {
    rec = JSON.parse(text);
  } catch (err) {
    st.badLines++;
    if (st.badLines <= MAX_BAD_LINE_WARNINGS) warn(ctx, st, lineNo, mtime, `unreadable JSON on line ${lineNo}: ${err.message}`);
    else if (st.badLines === MAX_BAD_LINE_WARNINGS + 1) warn(ctx, st, lineNo, mtime, 'further unreadable lines in this file are not reported');
    return;
  }
  if (!isPlainObject(rec)) {
    warn(ctx, st, lineNo, mtime, `line ${lineNo} is not a JSON object`);
    return;
  }
  handleRecord(ctx, st, rec, lineNo, recordTs(rec.timestamp) ?? mtime);
}

// journal.jsonl: launched / started / result / failed. A `failed` line is an agent that failed
// (no `result` line follows for it); it becomes agent.failed with the record's fields.
const JOURNAL_AGENT_KINDS = { started: 'agent.started', result: 'agent.result', failed: 'agent.failed' };

function handleJournalRecord(ctx, st, rec, line, ts) {
  const { type, ...rest } = rec;
  switch (type) {
    case 'launched':
      ctx.emit(mkEvent(ctx.run, 'run.launched', st.file, line, ts, rest));
      break;
    case 'started':
    case 'result':
    case 'failed': {
      if (typeof rest.agentId !== 'string' || rest.agentId === '') {
        warn(ctx, st, line, ts, `journal "${type}" record on line ${line} has no agentId; skipped`);
        break;
      }
      if (type === 'started' && !ctx.run.agentOrder.has(rest.agentId)) ctx.run.agentOrder.set(rest.agentId, ctx.run.agentOrder.size);
      ctx.emit(mkEvent(ctx.run, JOURNAL_AGENT_KINDS[type], st.file, line, ts, rest));
      break;
    }
    default:
      if (typeof type !== 'string') warnOnce(ctx, st, 'type:<none>', line, ts, `journal record without a type on line ${line}`);
      else warnOnce(ctx, st, `type:${type}`, line, ts, `unknown journal record type ${JSON.stringify(type)} (first seen on line ${line})`);
  }
}

// The text of a computed-task record without its harness frame: the first line (the frame) is
// dropped and the two-space indentation the harness put on every following line is removed.
// Only that indentation goes; whatever the task text itself indents stays.
function unframe(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) return '';
  return text.slice(nl + 1).split('\n').map((l) => (l.startsWith(FRAME_INDENT) ? l.slice(FRAME_INDENT.length) : l)).join('\n');
}

// One agent.prompt per agent file. `p` is { line, ts, text, version } of the user record it comes
// from. framed: true = `p.text` is a computed-task record and is unframed; false = the first user
// record, text as it stands. The Claude Code version of that record is copied into the data
// (additive; absent when the record has none): as `ccVersion`, and as `version`, the key
// src/model/reduce.mjs reads.
function emitPrompt(ctx, st, p, framed) {
  const data = { agentId: st.agentId, text: framed ? unframe(p.text) : p.text, framed };
  if (typeof p.version === 'string' && p.version !== '') {
    data.ccVersion = p.version;
    data.version = p.version;
  }
  ctx.emit(mkEvent(ctx.run, 'agent.prompt', st.file, p.line, p.ts, data));
}

// The first user record, held because it is the relayed user request and the computed task is
// expected right after it: emit it as the fallback prompt (framed: false). Does nothing, and keeps
// holding it, once stop() has come.
function releasePrompt(ctx, st) {
  const held = st.heldPrompt;
  if (!held || ctx.stopped()) return;
  st.heldPrompt = null;
  st.promptDone = true;
  emitPrompt(ctx, st, held, false);
}

// End of a pass over a transcript. The computed task is written right after the relayed request,
// so a poll that sees only the request waits one more poll for it (and as long as a line is being
// written); a one-shot read has no later poll and falls back at once. A transcript with the
// request, no computed task and later records gets its fallback prompt after those records'
// events in the same pass: one event per line keeps stop() lossless, and that case is not in the
// documented format.
function settlePrompt(ctx, st) {
  const held = st.heldPrompt;
  if (!held || ctx.stopped()) return;
  if (!ctx.oneShot && (st.partialTail || !ctx.regular || held.polls++ < 1)) return;
  releasePrompt(ctx, st);
}

// agent-<id>.jsonl: prompt -> agent.prompt (the computed-task user record, else the first user
// record); assistant tool_use/text -> activity; attachment structured_output -> structured
function handleTranscriptRecord(ctx, st, rec, line, ts) {
  const agentId = st.agentId;
  switch (rec.type) {
    case 'user': {
      if (st.promptDone) break; // later user records are tool results / follow-ups, not the prompt
      const text = messageText(rec.message);
      const p = { line, ts, text, version: rec.version, polls: 0 };
      if (text !== null && text.startsWith(COMPUTED_FRAME)) {
        st.heldPrompt = null;
        st.promptDone = true;
        emitPrompt(ctx, st, p, true);
        break;
      }
      if (st.heldPrompt) { // the record after the relayed request is not the computed task: the request is the prompt
        releasePrompt(ctx, st);
        break;
      }
      if (text === null) {
        st.promptDone = true;
        warn(ctx, st, line, ts, `first user record on line ${line} has no text content; no prompt emitted`);
      } else if (text.startsWith(RELAY_FRAME)) {
        st.heldPrompt = p;
      } else {
        st.promptDone = true;
        emitPrompt(ctx, st, p, false);
      }
      break;
    }
    case 'assistant': {
      const msg = rec.message;
      const content = isPlainObject(msg) && Array.isArray(msg.content) ? msg.content : [];
      const tools = content.filter((b) => b?.type === 'tool_use');
      const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '');
      if (tools.length === 0 && texts.length === 0) break; // thinking-only or empty
      const data = { agentId };
      if (tools.length > 0) {
        if (typeof tools[0].name === 'string') data.tool = tools[0].name;
        const summary = summarizeInput(tools[0].input);
        if (summary !== undefined) data.inputSummary = summary;
        Object.assign(data, editInputFields(tools[0]));
        if (tools.length > 1) {
          data.moreTools = tools.slice(1).map((b) => {
            const o = {};
            if (typeof b.name === 'string') o.tool = b.name;
            const s = summarizeInput(b.input);
            if (s !== undefined) o.inputSummary = s;
            return Object.assign(o, editInputFields(b));
          });
        }
      }
      if (texts.length > 0) data.text = truncate(texts.map((b) => b.text).join('\n'), TEXT_MAX);
      if (typeof msg.model === 'string') data.model = msg.model;
      if (msg.usage !== undefined) data.usage = msg.usage;
      // One API message is split over several records that repeat the same usage: keep its id
      // so a consumer can count usage once per message.
      if (typeof msg.id === 'string') data.messageId = msg.id;
      ctx.emit(mkEvent(ctx.run, 'agent.activity', st.file, line, ts, data));
      break;
    }
    default: {
      if (rec.type === 'attachment' && isPlainObject(rec.attachment) && rec.attachment.type === 'structured_output') {
        const { type: _t, data: payload, ...others } = rec.attachment;
        const data = { ...others, agentId };
        if ('data' in rec.attachment) data.data = payload;
        ctx.emit(mkEvent(ctx.run, 'agent.structured', st.file, line, ts, data));
        break;
      }
      if (typeof rec.type !== 'string') {
        warnOnce(ctx, st, 'type:<none>', line, ts, `record without a type on line ${line}`);
      } else if (!IGNORED_TRANSCRIPT_TYPES.has(rec.type)) {
        warnOnce(ctx, st, `type:${rec.type}`, line, ts, `unknown transcript record type ${JSON.stringify(rec.type)} (first seen on line ${line})`);
      }
    }
  }
}

// Whole files (script, agent meta, final run file): re-read when mtime/size change.
async function pollWhole(ctx, st, kind) {
  flushMetaWarning(ctx, st);
  const stat = await statSafe(st.file);
  if (!stat || !stat.isFile() || stat.size === 0) return; // absent, or not written yet
  const sig = `${stat.mtimeMs}:${stat.size}`;
  if (sig === st.sig) return;
  const mtime = Math.floor(stat.mtimeMs);
  let text;
  try {
    text = await fsp.readFile(st.file, 'utf8');
  } catch (err) {
    reportReadError(ctx, st, err, mtime);
    return;
  }
  st.readError = null;
  if (ctx.stopped()) return; // nothing is committed before this point; the next pass reads the file again
  const hash = createHash('sha1').update(text).digest('hex');
  if (hash === st.hash) { // same content, new mtime: nothing to say
    st.sig = sig;
    st.pendingSig = null;
    return;
  }

  if (kind === 'run.script') {
    const meta = parseScriptMeta(text);
    // A script caught mid-write has no readable meta yet: give it one more poll before settling.
    // A pass started by a file change is no such poll: the writer's next change comes with its own.
    if (meta === null && !ctx.oneShot) {
      if (!ctx.regular) return;
      if (st.pendingSig !== sig) {
        st.pendingSig = sig;
        return;
      }
    }
    st.sig = sig;
    st.hash = hash;
    st.pendingSig = null;
    // The warnings are delivered right after the script event; if stop() comes in between, they
    // stay pending and go out at the start of the next pass.
    if (meta === null) st.pendingWarnings.push({ ts: mtime, message: 'could not read the meta literal of the script (missing or not a pure literal); meta is null' });
    if (st.runEndMs !== undefined && mtime > st.runEndMs) st.pendingWarnings.push({ ts: mtime, message: SCRIPT_MODIFIED_WARNING });
    ctx.emit(mkEvent(ctx.run, 'run.script', st.file, null, mtime, { scriptPath: st.file, text, meta }));
    flushMetaWarning(ctx, st);
    return;
  }

  let value;
  let problem = null;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!isPlainObject(value)) problem = 'is not a JSON object';
  } catch (err) {
    problem = `is not valid JSON (${err.message})`;
  }
  if (problem) {
    // A file caught mid-write fails to parse: give it one more poll before warning (a pass started
    // by a file change does not count as that poll).
    if (!ctx.oneShot) {
      if (!ctx.regular) return;
      if (st.pendingSig !== sig) {
        st.pendingSig = sig;
        return;
      }
    }
    st.sig = sig;
    st.pendingSig = null;
    warn(ctx, st, null, mtime, `${path.basename(st.file)} ${problem}`);
    return;
  }
  st.sig = sig;
  st.hash = hash;
  st.pendingSig = null;
  if (kind === 'run.final') {
    ctx.run.finalScriptPath = typeof value.scriptPath === 'string' && value.scriptPath !== '' ? value.scriptPath : null;
    ctx.run.endMs = runEndMs(value);
  }
  ctx.emit(mkEvent(ctx.run, kind, st.file, null, recordTs(value.timestamp) ?? mtime, value));
}

// When the run ended, as its final file says: `endedAt`, else the start (`startTime`, or `startedAt`)
// plus `durationMs`. undefined when the file carries neither (nothing is guessed).
function runEndMs(fin) {
  const ended = recordTs(fin.endedAt);
  if (ended !== undefined) return ended;
  const started = recordTs(fin.startTime) ?? recordTs(fin.startedAt);
  if (started !== undefined && typeof fin.durationMs === 'number' && Number.isFinite(fin.durationMs)) return started + fin.durationMs;
  return undefined;
}

// A run started from a script file gets no copy under workflows/scripts/ (sources/event-sources.md);
// the final file's `scriptPath` is then the only pointer to the script. It is read once, after the
// final file has named it: that file may be edited later, and the run did not use the edit.
// Only an absolute path is read; one that is not is reported, not resolved against the cwd.
// The script file may have been edited after the run ended (mtime later than the run's end): then
// the read is followed by a source.warning, since the text is not what the run used.
async function pollNamedScript(ctx, run) {
  const p = run.finalScriptPath;
  if (p === null || run.scriptPath) return;
  const st = fileState(run, p);
  if (st.sig !== null) { // already read
    flushMetaWarning(ctx, st);
    return;
  }
  if (!path.isAbsolute(p)) {
    const fin = fileState(run, run.finalPath);
    warnOnce(ctx, fin, 'script-path', null, Date.now(), `${path.basename(run.finalPath)} names scriptPath ${JSON.stringify(p)}, which is not an absolute path; script not read`);
    return;
  }
  st.runEndMs = run.endMs;
  await pollWhole(ctx, st, 'run.script');
}

// Delivers the warnings that belong to a script event already emitted (see pollWhole), in order.
function flushMetaWarning(ctx, st) {
  while (st.pendingWarnings.length > 0 && !ctx.stopped()) {
    const w = st.pendingWarnings.shift();
    warn(ctx, st, null, w.ts, w.message);
  }
}

// One polling pass over a run. Events go to `sink` as they are read, in a fixed order: script,
// journal, agents (in journal order; meta before transcript), final file, and after it the script
// the final file names when the run has no copy of it. `stopped()` is asked
// before anything is consumed: once it is true the pass ends and leaves the rest unread.
// Resolves to the number of events delivered. Each file is handled on its own, so a failure
// in one (a bug, not bad data) is reported as a warning and does not silence the others.
//
// `regular`: the pass counts as one of the polls that "wait for one more poll" rules count (a file
// caught mid-write, a relayed request awaiting its computed task). False for a pass that was
// started by a file change: a burst of change events must not use up that grace at once.
//
// `index`: the run is only listed (not loaded): the agent files are neither listed nor opened, the script, the journal,
// the final file and the script it names are read as above.
async function pollRun(run, { oneShot = false, sink, stopped = () => false, regular = true, index = false }) {
  const ctx = {
    run, oneShot, regular, stopped, count: 0,
    emit(ev) {
      if (stopped()) return;
      sink(ev);
      ctx.count++;
    },
  };
  const guarded = async (fn) => {
    if (stopped()) return;
    try {
      await fn();
    } catch (err) {
      const st = fileState(run, run.runDir);
      warnOnce(ctx, st, `internal:${err?.message}`, null, Date.now(), `internal error while reading run ${run.runId}: ${err?.message ?? err}`);
    }
  };

  if (run.scriptPath) await guarded(() => pollWhole(ctx, fileState(run, run.scriptPath), 'run.script'));

  await guarded(() => pollJsonl(ctx, fileState(run, path.join(run.runDir, 'journal.jsonl')), handleJournalRecord));

  const agents = new Map(); // agentId -> { meta?, jsonl? }
  let ids = [];
  if (!index) await guarded(async () => {
    for (const ent of await readdirSafe(run.runDir)) {
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      let m = /^agent-(.+)\.meta\.json$/.exec(ent.name);
      if (m) { (agents.get(m[1]) ?? agents.set(m[1], {}).get(m[1])).meta = ent.name; continue; }
      m = /^agent-(.+)\.jsonl$/.exec(ent.name);
      if (m) (agents.get(m[1]) ?? agents.set(m[1], {}).get(m[1])).jsonl = ent.name;
    }
    ids = [...agents.keys()].sort((a, b) => {
      const ia = run.agentOrder.get(a) ?? Infinity;
      const ib = run.agentOrder.get(b) ?? Infinity;
      return ia === ib ? (a < b ? -1 : a > b ? 1 : 0) : ia - ib;
    });
  });
  for (const id of ids) {
    const { meta, jsonl } = agents.get(id);
    if (meta) await guarded(() => pollWhole(ctx, fileState(run, path.join(run.runDir, meta)), 'agent.meta'));
    if (jsonl) {
      await guarded(async () => {
        const st = fileState(run, path.join(run.runDir, jsonl));
        st.agentId = id;
        await pollJsonl(ctx, st, handleTranscriptRecord);
        settlePrompt(ctx, st);
      });
    }
  }

  await guarded(() => pollWhole(ctx, fileState(run, run.finalPath), 'run.final'));
  await guarded(() => pollNamedScript(ctx, run));
  return ctx.count;
}

// ---------------------------------------------------------------------------------------
// discovery

// What one session directory holds: runId -> { scriptPath }.
async function scanSession(sessionDir) {
  const found = new Map();
  const touch = (runId) => found.get(runId) ?? found.set(runId, { scriptPath: null }).get(runId);

  const wfDir = path.join(sessionDir, 'subagents', 'workflows');
  for (const ent of await readdirSafe(wfDir)) {
    if (ent.name.startsWith('wf_') && (await isDirEntry(wfDir, ent))) touch(ent.name);
  }
  const wDir = path.join(sessionDir, 'workflows');
  for (const ent of await readdirSafe(wDir)) {
    const m = /^(wf_.+)\.json$/.exec(ent.name);
    if (m && !ent.isDirectory()) touch(m[1]);
  }
  const sDir = path.join(wDir, 'scripts');
  for (const ent of await readdirSafe(sDir)) {
    const m = /^.+-(wf_.+)\.js$/.exec(ent.name);
    if (m && !ent.isDirectory()) {
      const r = touch(m[1]);
      r.scriptPath ??= path.join(sDir, ent.name);
    }
  }
  return found;
}

// Newest mtime among the files of a run that has not been tracked yet (0 if it has none).
// cheap: only the run directory, journal, script and final file (what a freshly launched run
// touches first), not every agent file; used on the frequent look at active sessions.
async function newestMtime(sessionDir, runId, scriptPath, cheap) {
  const runDir = path.join(sessionDir, 'subagents', 'workflows', runId);
  const candidates = [runDir, path.join(runDir, 'journal.jsonl'), path.join(sessionDir, 'workflows', `${runId}.json`)];
  if (scriptPath) candidates.push(scriptPath);
  if (!cheap) for (const ent of await readdirSafe(runDir)) candidates.push(path.join(runDir, ent.name));
  let newest = 0;
  for (const p of candidates) {
    const s = await statSafe(p);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

// Where in the tree a path reported by fs.watch (relative to root; null/'' when the platform gave
// none) points. A file of a run (its directory, journal, agents, final file or script) gives
// { scope: 'run', sessionDir, runId, script, file }, `file` being the name of the entry inside the run
// directory (journal.jsonl, agent-<id>.jsonl, ...; undefined for the directory itself and for the final
// file and the script, which live elsewhere); anything else the closest directory that can hold
// runs: { scope: 'session' | 'slug', dir } or { scope: 'root' }. The session transcript
// <slug>/<session>.jsonl, which grows all the time, belongs to the session directory <slug>/<session>.
function classifyChange(rootDir, filename) {
  const parts = typeof filename === 'string' ? filename.split(path.sep).filter((x) => x !== '') : [];
  if (parts.length === 0) return { scope: 'root' };
  const slugDir = path.join(rootDir, parts[0]);
  if (parts.length === 1) return { scope: 'slug', dir: slugDir };
  const sessionDir = path.join(slugDir, parts.length === 2 ? parts[1].replace(/\.jsonl$/, '') : parts[1]);
  const [, , a, b, c, d] = parts;
  if (a === 'subagents' && b === 'workflows' && c?.startsWith('wf_')) return { scope: 'run', sessionDir, runId: c, script: false, file: d };
  if (a === 'workflows' && c === undefined) {
    const m = /^(wf_.+)\.json$/.exec(b ?? '');
    if (m) return { scope: 'run', sessionDir, runId: m[1], script: false };
  }
  if (a === 'workflows' && b === 'scripts' && d === undefined) {
    const m = /^.+-(wf_.+)\.js$/.exec(c ?? '');
    if (m) return { scope: 'run', sessionDir, runId: m[1], script: true };
  }
  return { scope: 'session', dir: sessionDir };
}

// ---------------------------------------------------------------------------------------
// public API

// pollMs: how often the followed runs are read by stat polling, the fallback that always runs.
// Above 2147483647 ms (the longest delay a timer takes), and so for Infinity, the source does not
// poll at all: it reads on start() and rescan() only (and on file changes, if `watch` is on).
// watch: also watch `root` with fs.watch (recursive) and read the run whose files changed at once.
// Polling alone is used when watch is false, when fs.watch throws (no such root, no recursive
// watching on this platform) and after the watcher reports an error.
export function createClaudeFsSource({
  root = path.join(os.homedir(), '.claude', 'projects'),
  pollMs = 2000,
  watch = true,
  sinceMs = 24 * 3600e3,
  onEvent,
  now = () => Date.now(),
  scanMs = Math.max(pollMs * 6, 2000), // how often the whole tree is re-listed for new sessions
} = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('createClaudeFsSource: onEvent must be a function');
  if (!(pollMs > 0)) throw new RangeError('createClaudeFsSource: pollMs must be > 0');
  if (!(sinceMs >= 0)) throw new RangeError('createClaudeFsSource: sinceMs must be >= 0 (or Infinity)');
  const rootDir = path.resolve(root);
  const autoPoll = pollMs <= MAX_TIMER_MS;

  const tracked = new Map(); // run.key -> run
  const byRunId = new Map(); // run id -> the runs (one per session directory that holds it) of that id
  const loading = new Map(); // run id -> the promise of the loadRun in flight
  let started = false;
  let stopped = false;
  let timer = null;
  let loop = 0;              // generation of the poll loop: stop() and start() each end the previous one
  let startPromise = null;
  let queue = Promise.resolve();
  let lastFullScanAt = -Infinity;

  // file watching: what changed since the last change-triggered pass, and the pass's timing
  let watcher = null;
  let flushQueued = false;   // a change-triggered pass is waiting in the queue
  let flushing = false;      // ... or is running
  let flushTimer = null;     // ... or is waiting out WATCH_GAP_MS
  let lastFlushEnd = -Infinity;
  const changed = { full: false, slugs: new Set(), sessions: new Set(), runs: new Map() };

  // Hands one event to onEvent (pollRun asks `stopped` first, so nothing follows a stop()).
  function deliverOne(ev) {
    try {
      onEvent(ev);
    } catch (err) {
      process.emitWarning(`wfviz claude-fs: onEvent threw: ${err?.message ?? err}`);
    }
  }

  // Whether the files of a run changed within the window: such a run is loaded, any other is only listed.
  async function inWindow(sessionDir, runId, scriptPath, cheap) {
    if (sinceMs === Infinity) return true;
    return (await newestMtime(sessionDir, runId, scriptPath, cheap)) >= now() - sinceMs;
  }

  // Look at one session directory (or only at its run `onlyRunId`): returns the untracked runs (every
  // one of any age, with `loaded` from the window test, made once per run, here), and fills in script
  // paths of tracked runs.
  async function discoverSession(sessionDir, cheap = false, onlyRunId = null) {
    const found = await scanSession(sessionDir);
    const fresh = [];
    for (const [runId, info] of found) {
      if (onlyRunId !== null && runId !== onlyRunId) continue;
      const run = tracked.get(`${sessionDir}\0${runId}`);
      if (run) {
        run.scriptPath ??= info.scriptPath;
      } else {
        fresh.push({ sessionDir, runId, scriptPath: info.scriptPath, loaded: await inWindow(sessionDir, runId, info.scriptPath, cheap) });
      }
    }
    return fresh;
  }

  // Starts following the candidates that are not followed yet; returns the new runs.
  function track(candidates) {
    const fresh = [];
    for (const c of candidates) {
      const key = `${c.sessionDir}\0${c.runId}`;
      if (tracked.has(key)) continue;
      const run = makeRun(c.sessionDir, c.runId);
      run.scriptPath = c.scriptPath;
      run.loaded = c.loaded !== false;
      tracked.set(key, run);
      (byRunId.get(c.runId) ?? byRunId.set(c.runId, new Set()).get(c.runId)).add(run);
      fresh.push(run);
    }
    return fresh;
  }

  async function sessionDirsOf(slugDir) {
    return (await listSubdirs(slugDir)).map((session) => path.join(slugDir, session));
  }

  async function fullScan() {
    const sessions = [];
    for (const slug of await listSubdirs(rootDir)) sessions.push(...await sessionDirsOf(path.join(rootDir, slug)));
    const perSession = await mapLimit(sessions, SCAN_CONCURRENCY, (dir) => discoverSession(dir, false));
    return track(perSession.flat());
  }

  async function hotScan(nowReal) {
    const sessions = new Set();
    for (const run of tracked.values()) if (nowReal - run.lastActiveAt < HOT_RUN_MS) sessions.add(run.sessionDir);
    const perSession = await mapLimit([...sessions], SCAN_CONCURRENCY, (dir) => discoverSession(dir, true));
    return track(perSession.flat());
  }

  async function tick(full) {
    if (stopped) return;
    const nowReal = Date.now();
    const doFull = full || nowReal - lastFullScanAt >= scanMs;
    if (doFull) {
      await fullScan();
      lastFullScanAt = Date.now();
    } else {
      await hotScan(nowReal);
    }
    for (const run of [...tracked.values()]) {
      if (stopped) return;
      if (!doFull && nowReal - run.lastActiveAt >= HOT_RUN_MS) continue;
      const delivered = await pollTracked(run, { sink: deliverOne, stopped: () => stopped });
      if (delivered > 0) run.lastActiveAt = Date.now();
    }
  }

  // One pass over a tracked run: a loaded run is read in full; a listed-only run through its index files. An indexed
  // run that delivers something after its first index pass has changed: when the window test now says so, it is
  // loaded and read in full (the old runs of the window rule come back to life when they are written to).
  async function pollTracked(run, opts) {
    if (run.loaded) return pollRun(run, opts);
    const first = !run.indexed;
    run.indexed = true;
    let delivered = await pollRun(run, { ...opts, index: true });
    if (!first && delivered > 0 && !stopped && await inWindow(run.sessionDir, run.runId, run.scriptPath, false)) {
      run.loaded = true;
      delivered += await pollRun(run, opts);
    }
    return delivered;
  }

  function exclusive(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  // `gen` is the loop that asks: a timer callback that was already running when stop() and
  // start() came by belongs to an older loop and must not schedule another timer.
  function schedule(gen) {
    if (stopped || !started || !autoPoll || gen !== loop) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try { await exclusive(() => tick(false)); } catch { /* a failed pass is retried on the next one */ }
      schedule(gen);
    }, pollMs);
    timer.unref?.();
  }

  // ---- file watching

  function closeWatcher() {
    const w = watcher;
    watcher = null;
    try { w?.close(); } catch { /* already closed */ }
  }

  // `gen` is the loop that opened the watcher: a change reported after stop() (or by a watcher of
  // an older start()) is not acted upon.
  function openWatcher(gen) {
    if (!watch || watcher) return;
    let w;
    try {
      w = fs.watch(rootDir, { recursive: true }, (_type, filename) => onChange(gen, filename));
    } catch {
      return; // no such root, no recursive watching here, ...: stat polling does the work
    }
    w.on?.('error', () => { // the watcher broke: drop it and keep polling
      try { w.close(); } catch { /* already closed */ }
      if (watcher === w) watcher = null;
    });
    w.unref?.(); // like the poll timer, a watcher must not keep the process alive
    watcher = w;
  }

  // Remember what changed (fs.watch gives a path relative to root, or nothing) and schedule a pass.
  function onChange(gen, filename) {
    if (stopped || gen !== loop) return;
    const c = classifyChange(rootDir, filename);
    // an agent file of a run that is only listed is not read: no pass for it (the journal, the final file and the
    // script of that run still are)
    if (c.scope === 'run' && c.file !== undefined && c.file !== 'journal.jsonl' && tracked.get(`${c.sessionDir}\0${c.runId}`)?.loaded === false) return;
    if (c.scope === 'root') changed.full = true;
    else if (c.scope === 'slug') changed.slugs.add(c.dir);
    else if (c.scope === 'session') changed.sessions.add(c.dir);
    else {
      const key = `${c.sessionDir}\0${c.runId}`;
      const known = changed.runs.get(key);
      if (known) known.script ||= c.script;
      else changed.runs.set(key, { sessionDir: c.sessionDir, runId: c.runId, script: c.script });
    }
    queueFlush();
  }

  // The first change starts a pass at once; changes that come while it runs, or within WATCH_GAP_MS
  // after it, are collected into the next one (a busy run must not keep the source reading flat out).
  function queueFlush() {
    if (flushQueued || flushing || flushTimer) return; // a running pass queues the next one itself when it ends
    const wait = WATCH_GAP_MS - (Date.now() - lastFlushEnd);
    if (wait <= 0) {
      flushQueued = true;
      exclusive(flushChanges).catch(() => {}); // a failed pass is not retried: the poll timer is the fallback
    } else {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        queueFlush();
      }, wait);
      flushTimer.unref?.();
    }
  }

  function dropChanges() {
    changed.full = false;
    changed.slugs.clear();
    changed.sessions.clear();
    changed.runs.clear();
  }

  // One change-triggered pass: look for new runs where something changed outside any known run,
  // then read every run whose files changed (and the runs just found), each once. Not a "regular"
  // poll in the sense of pollRun.
  async function flushChanges() {
    flushQueued = false;
    flushing = true;
    try {
      if (stopped) return;
      const full = changed.full;
      const slugs = [...changed.slugs];
      const sessions = [...changed.sessions];
      const runs = [...changed.runs.values()];
      dropChanges();

      const toRead = new Map(); // run.key -> run
      const add = (list) => { for (const run of list) toRead.set(run.key, run); };
      if (full) {
        add(await fullScan());
        lastFullScanAt = Date.now();
      } else {
        for (const dir of slugs) {
          const found = await mapLimit(await sessionDirsOf(dir), SCAN_CONCURRENCY, (d) => discoverSession(d, true));
          add(track(found.flat()));
        }
        for (const dir of sessions) add(track(await discoverSession(dir, true)));
      }
      for (const { sessionDir, runId, script } of runs) {
        const key = `${sessionDir}\0${runId}`;
        // an unknown run, or a script that may be this run's: find out what the session has for it
        if (!tracked.has(key) || script) add(track(await discoverSession(sessionDir, false, runId)));
        const run = tracked.get(key);
        if (run) toRead.set(key, run);
      }
      for (const run of toRead.values()) {
        if (stopped) return;
        const delivered = await pollTracked(run, { sink: deliverOne, stopped: () => stopped, regular: false });
        if (delivered > 0) run.lastActiveAt = Date.now();
      }
    } finally {
      flushing = false;
      lastFlushEnd = Date.now();
      if (!stopped && (changed.full || changed.slugs.size > 0 || changed.sessions.size > 0 || changed.runs.size > 0)) queueFlush();
    }
  }

  return {
    // Replays every run inside the window, then keeps polling (and watching). Resolves after the first pass.
    start() {
      if (started && !stopped) return startPromise;
      started = true;
      stopped = false;
      const gen = ++loop;
      openWatcher(gen); // before the first pass: what changes meanwhile is read right after it
      startPromise = exclusive(() => tick(true)).then(() => schedule(gen));
      return startPromise;
    },
    // No event is delivered after stop() returns. What a pass had not delivered yet stays unread
    // and is picked up by start(). The watcher and every timer are closed.
    stop() {
      stopped = true;
      loop++;
      if (timer) clearTimeout(timer);
      timer = null;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      closeWatcher();
      dropChanges();
    },
    // Re-list the whole tree and poll every run now. Resolves when the pass is done.
    rescan() {
      if (stopped) return Promise.resolve();
      return exclusive(() => tick(true));
    },
    // Whether the run is read in full (every entry of the id) and no load of it is under way: a run being loaded is
    // not loaded yet. A run that is not listed is not loaded.
    isLoaded(runId) {
      const entries = typeof runId === 'string' ? byRunId.get(runId) : undefined;
      return entries !== undefined && !loading.has(runId) && [...entries].every((r) => r.loaded);
    },
    // Reads a listed run in full (its agent files: meta, prompt, activity, structured output), emits what that adds
    // once, and follows it like a recent run from then on. A loaded run resolves at once; a call while a load is under
    // way returns that load's promise, which resolves when the load is done. A run that is not listed (or a source that
    // is not running) rejects. A load that fails or is cut by stop() leaves the run listed only, and can be tried again.
    // The id is only looked up in the source's own map: it never makes a path.
    loadRun(runId) {
      if (typeof runId !== 'string') return Promise.reject(new TypeError('loadRun: the run id must be a string'));
      const going = loading.get(runId);
      if (going) return going; // resolves when that load is done, never earlier
      const known = byRunId.get(runId);
      if (known !== undefined && [...known].every((r) => r.loaded)) return Promise.resolve();
      if (!started || stopped) return Promise.reject(new Error('loadRun: the source is not running'));
      const job = exclusive(async () => {
        const entries = byRunId.get(runId);
        if (entries === undefined) throw new Error(`loadRun: no run ${JSON.stringify(runId)} is listed`);
        for (const run of entries) {
          if (run.loaded) continue;
          if (stopped) throw new Error('loadRun: the source was stopped');
          run.loaded = true; // the pass below is the one load; nothing else polls this run meanwhile (exclusive)
          let delivered = 0;
          try {
            delivered = await pollRun(run, { sink: deliverOne, stopped: () => stopped });
          } catch (err) {
            run.loaded = false;
            throw err;
          }
          if (stopped) {
            run.loaded = false;
            throw new Error('loadRun: the source was stopped');
          }
          if (delivered > 0) run.lastActiveAt = Date.now();
        }
      }).finally(() => { if (loading.get(runId) === job) loading.delete(runId); });
      loading.set(runId, job);
      return job;
    },
  };
}

// One-shot replay of a run: the events a live source would have emitted for it, in order.
// Resolves to [] when the run has no files. Does not apply a time window.
export async function readRunDir(sessionDir, runId) {
  const dir = path.resolve(sessionDir);
  const run = makeRun(dir, runId);
  const found = await scanSession(dir);
  run.scriptPath = found.get(runId)?.scriptPath ?? null;
  const events = [];
  await pollRun(run, { oneShot: true, sink: (ev) => events.push(ev) });
  return events;
}
