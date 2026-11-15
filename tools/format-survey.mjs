#!/usr/bin/env node
// V0 version survey: reads every Dynamic Workflow run under a Claude Code projects root and
// reports, per Claude Code version, which files exist, which record types appear and which
// fields (with their JSON types) each record shape carries. Read-only.
//
// It writes only counts, field names, JSON types and a few enumerations (record `type`, run
// `status`, agent `state`, tool names). No prompt, result, path or project name leaves the
// files: other projects' runs are read in place and never copied (progress.md, decisions).
//
//   node tools/format-survey.mjs [--root <dir>] [--out <file>]
//   default root: ~/.claude/projects; default out: stdout
//
// Version of a run = the `version` field of its agent transcript records (AGENTS.md, learned
// rules). A run whose transcripts carry no `version` is grouped as "unknown".

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const RELAY_FRAME = '[Workflow harness — user request]';
const COMPUTED_FRAME = '[Workflow harness — computed task]';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const UNKNOWN = 'unknown';

// ---------- small helpers ----------

async function readdirSafe(dir) {
  try { return (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return []; }
}
async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// A shape counter: how many objects were seen and, per field, how often and with which types.
function newShape() { return { n: 0, fields: {} }; }
function addShape(shape, obj) {
  if (!isObj(obj)) return;
  shape.n += 1;
  for (const [k, v] of Object.entries(obj)) {
    const f = (shape.fields[k] ??= { n: 0, types: {} });
    f.n += 1;
    const t = jsonType(v);
    f.types[t] = (f.types[t] ?? 0) + 1;
  }
}
function mergeShape(into, from) {
  into.n += from.n;
  for (const [k, f] of Object.entries(from.fields)) {
    const g = (into.fields[k] ??= { n: 0, types: {} });
    g.n += f.n;
    for (const [t, c] of Object.entries(f.types)) g.types[t] = (g.types[t] ?? 0) + c;
  }
}
function bump(map, key, by = 1) { map[key] = (map[key] ?? 0) + by; }
function mergeCounts(into, from) { for (const [k, c] of Object.entries(from)) bump(into, k, c); }
function shapeMap(map, key) { return (map[key] ??= newShape()); }
function mergeShapeMaps(into, from) { for (const [k, s] of Object.entries(from)) mergeShape(shapeMap(into, k), s); }

function parseLines(text) {
  const out = { records: [], bad: 0 };
  if (text === null) return out;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { out.records.push(JSON.parse(line)); } catch { out.bad += 1; }
  }
  return out;
}
function messageText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

// ---------- one run ----------

function emptyRun() {
  return {
    versions: {},
    files: { journal: 0, meta: 0, transcript: 0, prefix: 0, other: 0, final: 0, scriptCopy: 0 },
    journal: { lines: 0, bad: 0, types: {}, shapes: {} },
    meta: { shapes: newShape() },
    transcript: {
      records: 0, bad: 0, types: {}, shapes: {}, messageShapes: {},
      firstUser: { relay: 0, computed: 0, plain: 0, none: 0 },
      tools: {}, editInputs: {},
    },
    final: { shape: newShape(), status: {}, progressShape: newShape(), progressState: {}, progressType: {}, phaseShape: newShape(), logs: 0 },
  };
}

function surveyTranscript(run, records) {
  const t = run.transcript;
  let firstUserSeen = false;
  let sawComputed = false;
  let sawRelay = false;
  for (const rec of records) {
    t.records += 1;
    if (!isObj(rec)) continue;
    const type = typeof rec.type === 'string' ? rec.type : '(none)';
    bump(t.types, type);
    addShape(shapeMap(t.shapes, type), rec);
    if (typeof rec.version === 'string') bump(run.versions, rec.version);
    if (isObj(rec.message)) addShape(shapeMap(t.messageShapes, type), rec.message);
    if (type === 'user' && (!firstUserSeen || (sawRelay && !sawComputed))) {
      const text = messageText(rec.message);
      if (text !== null) {
        if (text.startsWith(RELAY_FRAME)) sawRelay = true;
        else if (text.startsWith(COMPUTED_FRAME)) sawComputed = true;
        firstUserSeen = true;
      }
    }
    const content = rec.message?.content;
    if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        bump(t.tools, block.name);
        if (EDIT_TOOLS.has(block.name)) addShape(shapeMap(t.editInputs, block.name), block.input);
      }
    }
  }
  if (sawRelay) t.firstUser.relay += 1;
  if (sawComputed) t.firstUser.computed += 1;
  else if (firstUserSeen && !sawRelay) t.firstUser.plain += 1;
  if (!firstUserSeen) t.firstUser.none += 1;
}

function surveyFinal(run, obj) {
  const f = run.final;
  addShape(f.shape, obj);
  if (!isObj(obj)) return;
  bump(f.status, typeof obj.status === 'string' ? obj.status : `(${jsonType(obj.status)})`);
  if (Array.isArray(obj.workflowProgress)) {
    for (const p of obj.workflowProgress) {
      addShape(f.progressShape, p);
      if (!isObj(p)) continue;
      bump(f.progressState, typeof p.state === 'string' ? p.state : `(${jsonType(p.state)})`);
      bump(f.progressType, typeof p.type === 'string' ? p.type : `(${jsonType(p.type)})`);
    }
  }
  if (Array.isArray(obj.phases)) for (const p of obj.phases) addShape(f.phaseShape, p);
  if (Array.isArray(obj.logs)) f.logs += obj.logs.length;
}

export async function surveyRun(sessionDir, runId) {
  const run = emptyRun();
  const runDir = path.join(sessionDir, 'subagents', 'workflows', runId);
  for (const ent of await readdirSafe(runDir)) {
    if (!ent.isFile()) continue;
    const p = path.join(runDir, ent.name);
    if (ent.name === 'journal.jsonl') {
      run.files.journal += 1;
      const { records, bad } = parseLines(await readText(p));
      run.journal.lines += records.length + bad;
      run.journal.bad += bad;
      for (const rec of records) {
        const type = isObj(rec) && typeof rec.type === 'string' ? rec.type : '(none)';
        bump(run.journal.types, type);
        addShape(shapeMap(run.journal.shapes, type), rec);
      }
    } else if (/^agent-.+\.meta\.json$/.test(ent.name)) {
      run.files.meta += 1;
      try { addShape(run.meta.shapes, JSON.parse(await readText(p))); } catch { /* unreadable meta counts as a file only */ }
    } else if (/^agent-.+\.prefix\.json$/.test(ent.name)) {
      run.files.prefix += 1;
    } else if (/^agent-.+\.jsonl$/.test(ent.name)) {
      run.files.transcript += 1;
      const { records, bad } = parseLines(await readText(p));
      run.transcript.bad += bad;
      surveyTranscript(run, records);
    } else {
      run.files.other += 1;
    }
  }
  const finalText = await readText(path.join(sessionDir, 'workflows', `${runId}.json`));
  if (finalText !== null) {
    run.files.final = 1;
    try { surveyFinal(run, JSON.parse(finalText)); } catch { /* present but unparsable: counted as present */ }
  }
  const scripts = await readdirSafe(path.join(sessionDir, 'workflows', 'scripts'));
  if (scripts.some((e) => e.name.endsWith(`-${runId}.js`))) run.files.scriptCopy = 1;
  return run;
}

// The version label of a run: its transcript versions, joined if several.
export function runVersion(run) {
  const vs = Object.keys(run.versions).sort(compareVersions);
  return vs.length ? vs.join(' + ') : UNKNOWN;
}
export function compareVersions(a, b) {
  const pa = a.split(/[.+ ]/).map(Number);
  const pb = b.split(/[.+ ]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function mergeRun(into, run) {
  for (const k of Object.keys(into.files)) into.files[k] += run.files[k];
  into.journal.lines += run.journal.lines;
  into.journal.bad += run.journal.bad;
  mergeCounts(into.journal.types, run.journal.types);
  mergeShapeMaps(into.journal.shapes, run.journal.shapes);
  mergeShape(into.meta.shapes, run.meta.shapes);
  const a = into.transcript;
  const b = run.transcript;
  a.records += b.records;
  a.bad += b.bad;
  mergeCounts(a.types, b.types);
  mergeShapeMaps(a.shapes, b.shapes);
  mergeShapeMaps(a.messageShapes, b.messageShapes);
  mergeCounts(a.firstUser, b.firstUser);
  mergeCounts(a.tools, b.tools);
  mergeShapeMaps(a.editInputs, b.editInputs);
  mergeShape(into.final.shape, run.final.shape);
  mergeCounts(into.final.status, run.final.status);
  mergeShape(into.final.progressShape, run.final.progressShape);
  mergeCounts(into.final.progressState, run.final.progressState);
  mergeCounts(into.final.progressType, run.final.progressType);
  mergeShape(into.final.phaseShape, run.final.phaseShape);
  into.final.logs += run.final.logs;
}

// ---------- whole root ----------

export async function surveyRoot(root) {
  const groups = new Map(); // version -> { runs, runIds, agg }
  for (const slug of await readdirSafe(root)) {
    if (!slug.isDirectory()) continue;
    for (const session of await readdirSafe(path.join(root, slug.name))) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(root, slug.name, session.name);
      for (const r of await readdirSafe(path.join(sessionDir, 'subagents', 'workflows'))) {
        if (!r.isDirectory()) continue;
        const run = await surveyRun(sessionDir, r.name);
        const v = runVersion(run);
        if (!groups.has(v)) groups.set(v, { runs: 0, runIds: [], agg: emptyRun() });
        const g = groups.get(v);
        g.runs += 1;
        g.runIds.push(r.name);
        mergeRun(g.agg, run);
      }
    }
  }
  const versions = [...groups.keys()].sort((a, b) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : compareVersions(a, b)));
  return { versions: versions.map((v) => ({ version: v, ...groups.get(v) })) };
}

// ---------- markdown ----------

function fmtTypes(types) { return Object.keys(types).sort().join('\\|'); }
function shapeTable(shape, title) {
  if (!shape || shape.n === 0) return `${title}: none\n`;
  const rows = Object.entries(shape.fields).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, f]) => `| \`${k}\` | ${f.n}/${shape.n} | ${fmtTypes(f.types)} |`);
  return `${title} (${shape.n} objects)\n\n| field | present | JSON types |\n|---|---|---|\n${rows.join('\n')}\n`;
}
function countList(map) {
  const e = Object.entries(map).filter(([, c]) => c > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  return e.length ? e.map(([k, c]) => `\`${k}\` ${c}`).join(', ') : 'none';
}

export function renderMarkdown(survey, { root, date } = {}) {
  const out = [];
  out.push('# Format survey — Dynamic Workflow run files per Claude Code version (V0)');
  out.push('');
  out.push(`Generated by \`tools/format-survey.mjs\`${date ? ` on ${date}` : ''}${root ? ` over \`${root}\`` : ''}. Read-only.`);
  out.push('Only counts, field names, JSON types and enumerations are recorded; no content, paths or project names.');
  out.push('Version of a run = `version` field of its agent transcript records; `unknown` = no such field.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| version | runs | journal | meta | transcripts | final file | script copy | journal types | final status |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const g of survey.versions) {
    const a = g.agg;
    out.push(`| ${g.version} | ${g.runs} | ${a.files.journal} | ${a.files.meta} | ${a.files.transcript} | ${a.files.final} | ${a.files.scriptCopy} | ${countList(a.journal.types)} | ${countList(a.final.status)} |`);
  }
  out.push('');
  for (const g of survey.versions) {
    const a = g.agg;
    out.push(`## ${g.version}`);
    out.push('');
    out.push(`Runs (${g.runs}): ${g.runIds.map((id) => `\`${id}\``).join(', ')}`);
    out.push('');
    out.push(`Files: journal ${a.files.journal}, agent meta ${a.files.meta}, agent transcripts ${a.files.transcript}, prefix ${a.files.prefix}, other ${a.files.other}, final ${a.files.final}, script copy ${a.files.scriptCopy}.`);
    out.push('');
    out.push(`### journal.jsonl — ${a.journal.lines} lines, ${a.journal.bad} unparsable`);
    out.push('');
    out.push(`Types: ${countList(a.journal.types)}`);
    out.push('');
    for (const t of Object.keys(a.journal.shapes).sort()) out.push(shapeTable(a.journal.shapes[t], `\`${t}\``));
    out.push('### agent-*.meta.json');
    out.push('');
    out.push(shapeTable(a.meta.shapes, 'meta'));
    const t = a.transcript;
    out.push(`### agent-*.jsonl — ${t.records} records, ${t.bad} unparsable`);
    out.push('');
    out.push(`Record types: ${countList(t.types)}`);
    out.push('');
    out.push(`First user record per transcript: relayed user request ${t.firstUser.relay}, computed task ${t.firstUser.computed}, unframed ${t.firstUser.plain}, none ${t.firstUser.none}.`);
    out.push('');
    out.push(`Tool calls: ${countList(t.tools)}`);
    out.push('');
    for (const name of Object.keys(t.editInputs).sort()) out.push(shapeTable(t.editInputs[name], `\`${name}\` input`));
    for (const ty of Object.keys(t.shapes).sort()) out.push(shapeTable(t.shapes[ty], `record \`${ty}\``));
    for (const ty of Object.keys(t.messageShapes).sort()) out.push(shapeTable(t.messageShapes[ty], `\`${ty}.message\``));
    const f = a.final;
    out.push(`### workflows/<runId>.json — ${a.files.final} files`);
    out.push('');
    out.push(`Status: ${countList(f.status)}. Progress item type: ${countList(f.progressType)}. Item state: ${countList(f.progressState)}. log lines: ${f.logs}.`);
    out.push('');
    out.push(shapeTable(f.shape, 'final file'));
    out.push(shapeTable(f.progressShape, '`workflowProgress[]` item'));
    out.push(shapeTable(f.phaseShape, '`phases[]` item'));
  }
  return out.join('\n');
}

// ---------- CLI ----------

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } } });
  const root = values.root ?? path.join(os.homedir(), '.claude', 'projects');
  const survey = await surveyRoot(root);
  const shownRoot = root.startsWith(os.homedir()) ? `~${root.slice(os.homedir().length)}` : root;
  const md = renderMarkdown(survey, { root: shownRoot, date: new Date().toISOString().slice(0, 10) });
  if (values.out) await fsp.writeFile(values.out, `${md}\n`);
  else process.stdout.write(`${md}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
