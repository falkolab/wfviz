// test/integration/helpers.mjs (node I1): shared utilities of the integration tests. Not a test file.
//
// Nothing in here uses the code under test to decide what is right: the run files are read with
// plain fs + JSON, the expected edges come from a naive brute-force search, and the shape of a
// Run is checked against the field list written in docs/contract.md section 2.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import * as nodeModule from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(REPO, 'fixtures');
export const BIN = path.join(REPO, 'bin', 'wfviz.mjs');
export const WEB_DIR = path.join(REPO, 'web');
export const FIXTURE_ROOTS = [path.join(FIXTURES, 'claude-projects'), path.join(FIXTURES, 'synthetic')];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// load-log-register.mjs can see which modules a child resolves where Node has module.registerHooks (22.15 / 23.5+)
// or module.register (20.6+). Before that the module-load assertions have nothing to read.
export const CAN_LOG_MODULE_LOADS = typeof nodeModule.registerHooks === 'function' || typeof nodeModule.register === 'function';

// ---------------------------------------------------------------------------------------
// temp dirs and run files

export function mkTmp(t, prefix = 'wfviz-int-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

// Every run below `root`: a directory <session>/subagents/workflows/wf_*. The slug/session layout
// differs between the roots (synthetic/ has one more level), so the tree is searched, not indexed.
export function discoverRuns(root, depth = 7) {
  const found = [];
  const walk = (dir, level) => {
    if (level > depth) return;
    for (const name of subdirs(dir)) {
      const full = path.join(dir, name);
      if (name === 'workflows' && path.basename(dir) === 'subagents') {
        for (const runId of subdirs(full).filter((n) => n.startsWith('wf_'))) {
          const sessionDir = path.dirname(dir);
          found.push({ root, sessionDir, runId, session: path.basename(sessionDir), slug: path.basename(path.dirname(sessionDir)) });
        }
      } else walk(full, level + 1);
    }
  };
  walk(root, 0);
  return found;
}

export function allFixtureRuns() {
  return FIXTURE_ROOTS.flatMap((root) => discoverRuns(root));
}

// The files of one run: absolute paths, null where the run has none.
export function runFiles(sessionDir, runId) {
  const runDir = path.join(sessionDir, 'subagents', 'workflows', runId);
  const scriptDir = path.join(sessionDir, 'workflows', 'scripts');
  const scriptName = fs.existsSync(scriptDir) ? fs.readdirSync(scriptDir).find((n) => n.endsWith(`-${runId}.js`)) : undefined;
  const finalPath = path.join(sessionDir, 'workflows', `${runId}.json`);
  const names = fs.existsSync(runDir) ? fs.readdirSync(runDir).sort() : [];
  const agents = [];
  for (const name of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(name);
    if (m) agents.push({ id: m[1], meta: path.join(runDir, name), jsonl: path.join(runDir, `agent-${m[1]}.jsonl`) });
  }
  return {
    runDir,
    script: scriptName ? path.join(scriptDir, scriptName) : null,
    journal: fs.existsSync(path.join(runDir, 'journal.jsonl')) ? path.join(runDir, 'journal.jsonl') : null,
    agents,
    final: fs.existsSync(finalPath) ? finalPath : null,
  };
}

// Where a file of the source session lands in the copy.
const relIn = (sessionDir, file) => path.relative(sessionDir, file);

export function copyFileInto(srcSession, file, dstSession) {
  const dst = path.join(dstSession, relIn(srcSession, file));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
  return dst;
}

// Copies the files of ONE run (not the other runs of the same session). final: false leaves the
// end-of-run file out, which is what a run in progress looks like on disk.
export function copyRun(srcSession, runId, dstSession, { final = true } = {}) {
  const f = runFiles(srcSession, runId);
  fs.mkdirSync(dstSession, { recursive: true });
  if (f.script) copyFileInto(srcSession, f.script, dstSession);
  if (f.journal) copyFileInto(srcSession, f.journal, dstSession);
  for (const a of f.agents) {
    copyFileInto(srcSession, a.meta, dstSession);
    if (fs.existsSync(a.jsonl)) copyFileInto(srcSession, a.jsonl, dstSession);
  }
  if (final && f.final) copyFileInto(srcSession, f.final, dstSession);
  return runFiles(dstSession, runId);
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');

export function findRun(runId) {
  const hit = allFixtureRuns().find((r) => r.runId === runId);
  assert.ok(hit, `fixture run ${runId} not found under fixtures/`);
  return hit;
}

// ---------------------------------------------------------------------------------------
// replay into a store

// A store whose clock stands one minute after the last event: "the run was just seen". The
// default clock would make a replayed old run stale (no activity for 30 min, contract: unknown).
export function lastEventTs(events) {
  return Math.max(...events.map((e) => (typeof e.ts === 'number' ? e.ts : 0)));
}

export async function replayInto(createStore, readRunDir, sessionDir, runId, { staleMs } = {}) {
  const events = await readRunDir(sessionDir, runId);
  const store = createStore({ now: () => lastEventTs(events) + 60_000, ...(staleMs === undefined ? {} : { staleMs }) });
  for (const ev of events) store.apply(ev);
  return { events, store, run: store.getRun(runId) };
}

// ---------------------------------------------------------------------------------------
// contract section 2: shape of a Run

const PROVS = new Set(['registered', 'final', 'inferred', 'unknown']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function assertFact(fact, where) {
  assert.ok(isObj(fact), `${where}: a Fact is an object, got ${JSON.stringify(fact)}`);
  assert.ok(PROVS.has(fact.prov), `${where}: prov must be registered|final|inferred|unknown, got ${JSON.stringify(fact.prov)}`);
  assert.ok('value' in fact, `${where}: a Fact has a value (null when unknown)`);
  if (fact.prov === 'registered' || fact.prov === 'final') {
    assert.equal(typeof fact.from, 'string', `${where}: ${fact.prov} needs "from"`);
    assert.ok(fact.from.length > 0, `${where}: empty "from"`);
  } else if (fact.prov === 'inferred') {
    assert.equal(typeof fact.method, 'string', `${where}: inferred needs "method"`);
    assert.ok(fact.method.length > 0, `${where}: empty "method"`);
  } else {
    assert.equal(fact.value, null, `${where}: an unknown Fact holds null`);
    assert.equal(typeof fact.reason, 'string', `${where}: unknown needs "reason"`);
    assert.ok(fact.reason.length > 0, `${where}: empty "reason"`);
  }
}

const RUN_KEYS = [
  'id', 'source', 'sessionId', 'project', 'ccVersion', 'name', 'description', 'status', 'startedAt', 'endedAt',
  'durationMs', 'declaredPhases', 'phases', 'agents', 'order', 'edges', 'registeredEdges', 'logs', 'recognized',
  'totals', 'unknowns', 'warnings',
];
const RUN_FACTS = ['ccVersion', 'name', 'description', 'status', 'startedAt', 'endedAt', 'durationMs', 'logs'];
const AGENT_KEYS = [
  'id', 'label', 'phase', 'agentType', 'model', 'role', 'unit', 'round', 'state', 'startedAt', 'endedAt',
  'durationMs', 'prompt', 'result', 'lastActivity', 'toolCalls', 'tokens', 'usage', 'byModel', 'activity',
];
const AGENT_FACTS = AGENT_KEYS.filter((k) => k !== 'id' && k !== 'activity');
const TOTALS_KEYS = ['agents', 'running', 'done', 'failed', 'tokens', 'toolCalls', 'usage', 'byModel'];
const USAGE_COUNTERS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// P2 (contract section 2): a usage value holds the four counters as whole numbers >= 0 (nothing else); it is never registered or final.
function assertUsageValue(u, where) {
  assert.ok(isObj(u), `${where}: a usage value is an object`);
  assert.deepEqual(Object.keys(u).sort(), [...USAGE_COUNTERS].sort(), `${where}: the four counters and nothing else`);
  for (const k of USAGE_COUNTERS) assert.ok(Number.isInteger(u[k]) && u[k] >= 0, `${where}.${k} is a whole number >= 0, got ${u[k]}`);
}

// Every field the contract lists is there, every Fact is a well-formed Fact, and the lists agree
// with each other (order <-> agents, phases <-> agents, edges <-> agents, totals <-> agents).
export function assertRunShape(run, where = 'run') {
  assert.ok(isObj(run), `${where}: not an object`);
  for (const k of RUN_KEYS) assert.ok(k in run, `${where}: field "${k}" of contract section 2 is missing`);
  for (const k of RUN_FACTS) assertFact(run[k], `${where}.${k}`);
  assert.ok(['real', 'demo'].includes(run.source), `${where}.source`);
  assert.ok(['running', 'completed', 'failed', 'stopped', null].includes(run.status.value), `${where}.status value ${run.status.value}`);
  // the one unknown Fact whose value is [] and not null (contract section 2)
  assert.deepEqual([run.registeredEdges.value, run.registeredEdges.prov], [[], 'unknown'], `${where}.registeredEdges`);
  assert.ok(typeof run.registeredEdges.reason === 'string' && run.registeredEdges.reason !== '', `${where}.registeredEdges.reason`);

  assert.ok(Array.isArray(run.order) && Array.isArray(run.declaredPhases) && Array.isArray(run.phases));
  assert.deepEqual([...run.order].sort(), Object.keys(run.agents).sort(), `${where}: order lists exactly the agents`);
  for (const id of run.order) {
    const a = run.agents[id];
    const w = `${where}.agents.${id}`;
    for (const k of AGENT_KEYS) assert.ok(k in a, `${w}: field "${k}" of contract section 2 is missing`);
    assert.equal(a.id, id);
    for (const k of AGENT_FACTS) assertFact(a[k], `${w}.${k}`);
    if (a.usage.prov !== 'unknown') {
      assert.equal(a.usage.prov, 'inferred', `${w}.usage is inferred, never registered or final`);
      assertUsageValue(a.usage.value, `${w}.usage`);
    }
    // P2: the agent's usage split by the model of each counted message (a Fact; the split adds up to the usage unless a message names no model)
    if (a.byModel.prov === 'unknown') {
      if (a.usage.prov === 'unknown') assert.equal(a.byModel.reason, a.usage.reason, `${w}.byModel is unknown for the reason usage is`);
    } else {
      assert.equal(a.byModel.prov, 'inferred', `${w}.byModel is inferred`);
      assert.notEqual(a.usage.prov, 'unknown', `${w}: a split without a usage`);
      const parts = Object.entries(a.byModel.value);
      assert.ok(parts.length > 0, `${w}.byModel has a model`);
      const sum = Object.fromEntries(USAGE_COUNTERS.map((k) => [k, 0]));
      for (const [model, u] of parts) {
        assertUsageValue(u, `${w}.byModel[${model}]`);
        for (const k of USAGE_COUNTERS) sum[k] += u[k];
      }
      if (!/with no model id/.test(a.byModel.method)) assert.deepEqual(sum, a.usage.value, `${w}.byModel adds up to usage`);
    }
    assert.ok(['queued', 'running', 'done', 'failed', 'skipped', null].includes(a.state.value), `${w}.state value ${a.state.value}`);
    assert.ok(Array.isArray(a.activity) && a.activity.length <= 50, `${w}.activity is the last 50`);
    for (const k of ['role', 'unit', 'round']) {
      if (a[k].prov !== 'unknown') assert.deepEqual([a[k].prov, a[k].method], ['inferred', 'label-pattern'], `${w}.${k} is inferred from the label`);
    }
  }

  assert.deepEqual(run.phases.map((p) => p.index), run.phases.map((_, i) => i + 1), `${where}: phase indexes count from 1`);
  for (const p of run.phases) {
    for (const k of ['startedAt', 'endedAt', 'state']) assertFact(p[k], `${where}.phases[${p.title}].${k}`);
    for (const id of p.agentIds) {
      assert.ok(run.agents[id], `${where}: phase ${p.title} lists unknown agent ${id}`);
      assert.equal(run.agents[id].phase.value, p.title, `${where}: agent ${id} sits in phase ${p.title}`);
    }
  }
  for (const id of run.order) {
    const a = run.agents[id];
    if (a.phase.prov !== 'unknown') {
      assert.ok(run.phases.some((p) => p.title === a.phase.value && p.agentIds.includes(id)), `${where}: agent ${id} is in no phase`);
    }
  }

  for (const k of TOTALS_KEYS) assert.ok(k in run.totals, `${where}.totals.${k}`);
  assertFact(run.totals.tokens, `${where}.totals.tokens`);
  assertFact(run.totals.toolCalls, `${where}.totals.toolCalls`);
  assertFact(run.totals.usage, `${where}.totals.usage`);
  assertFact(run.totals.byModel, `${where}.totals.byModel`);
  // the total is the sum of the agents' usage, and unknown only when no agent has any
  if (run.totals.usage.prov !== 'unknown') {
    assert.equal(run.totals.usage.prov, 'inferred', `${where}.totals.usage is inferred`);
    assertUsageValue(run.totals.usage.value, `${where}.totals.usage`);
    const sum = Object.fromEntries(USAGE_COUNTERS.map((k) => [k, run.order.reduce((n, id) => n + (run.agents[id].usage.prov === 'unknown' ? 0 : run.agents[id].usage.value[k]), 0)]));
    assert.deepEqual(run.totals.usage.value, sum, `${where}.totals.usage is the sum of the agents' usage`);
  } else {
    assert.ok(run.order.every((id) => run.agents[id].usage.prov === 'unknown'), `${where}: totals.usage is unknown only when no agent has usage`);
  }
  if (run.totals.byModel.prov !== 'unknown') {
    assert.equal(run.totals.byModel.prov, 'inferred', `${where}.totals.byModel is inferred`);
    for (const [model, u] of Object.entries(run.totals.byModel.value)) assertUsageValue(u, `${where}.totals.byModel[${model}]`);
  }
  const states = run.order.map((id) => run.agents[id].state.value);
  assert.equal(run.totals.agents, run.order.length);
  for (const s of ['running', 'done', 'failed']) assert.equal(run.totals[s], states.filter((x) => x === s).length, `${where}.totals.${s}`);

  for (const e of run.edges) {
    assert.ok(run.agents[e.from] && run.agents[e.to] && e.from !== e.to, `${where}: edge ${e.from} -> ${e.to} joins two different agents`);
    assert.equal(e.prov, 'inferred', `${where}: every edge is inferred`);
    assert.ok(typeof e.evidence === 'string' && e.evidence.trim() !== '', `${where}: edge ${e.from} -> ${e.to} carries evidence`);
    assert.ok((e.kind === 'data-flow' && e.strength === 'strong') || (e.kind === 'time-order' && e.strength === 'weak'), `${where}: kind/strength ${e.kind}/${e.strength}`);
  }
  assert.ok(isObj(run.recognized) && ['findings', 'verdicts', 'tests'].every((k) => Array.isArray(run.recognized[k])), `${where}.recognized`);
  assert.ok(run.unknowns.every((u) => typeof u.field === 'string' && typeof u.reason === 'string' && u.reason !== ''), `${where}.unknowns carry a reason`);
  assert.ok(run.warnings.every((w) => typeof w === 'string'));
}

// ---------------------------------------------------------------------------------------
// brute-force dependency oracle (contract section 2, "Dependency inference")

const normalise = (s) => s.replace(/\s+/g, '');
const serialise = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const known = (f) => isObj(f) && f.prov !== 'unknown';
const num = (f) => (known(f) && typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);

// Contract 2: a common region of >= 64 normalised chars (a maximal run that the prompt of B and the result of A share).
export function sharesWindow(a, b, n = 64) {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i + n <= a.length; i++) if (b.includes(a.slice(i, i + n))) return true;
  return false;
}

// Every ordered pair (A, B) with a maximal common region S of >= 64 normalised chars between the prompt of B and
// the result of A, such that A ended strictly before B started, S is in the result of no other agent that ended
// before B started, and S is in the prompts of fewer than 2 other agents. The script text is not part of the Run
// and is not checked (the fixtures' results are not quoted in their scripts). Reads only the Facts of the served Run.
export function expectedDataFlow(run) {
  const out = new Set();
  const res = {}, pro = {};
  for (const id of run.order) {
    const a = run.agents[id];
    const text = known(a.result) ? serialise(a.result.value) : null;
    res[id] = typeof text === 'string' ? normalise(text) : null;
    pro[id] = known(a.prompt) && typeof a.prompt.value === 'string' ? normalise(a.prompt.value) : null;
  }
  const ended = (aId, bId) => num(run.agents[aId].endedAt) !== null && num(run.agents[bId].startedAt) !== null
    && num(run.agents[aId].endedAt) < num(run.agents[bId].startedAt);
  for (const aId of run.order) for (const bId of run.order) {
    if (aId === bId || res[aId] === null || pro[bId] === null || !ended(aId, bId)) continue;
    const x = res[aId], y = pro[bId];
    const regions = new Set();
    for (let i = 0; i + 64 <= y.length; i++) {
      const w = y.slice(i, i + 64);
      for (let j = x.indexOf(w); j !== -1; j = x.indexOf(w, j + 1)) {
        let back = 0, len = 64;
        while (i - back > 0 && j - back > 0 && y[i - back - 1] === x[j - back - 1]) back++;
        while (i + len < y.length && j + len < x.length && y[i + len] === x[j + len]) len++;
        regions.add(y.slice(i - back, i + len));
      }
    }
    for (const S of regions) {
      if (run.order.some((c) => c !== aId && c !== bId && res[c] !== null && ended(c, bId) && res[c].includes(S))) continue;
      if (run.order.filter((k) => k !== bId && pro[k] !== null && pro[k].includes(S)).length >= 2) continue;
      out.add(`${aId}>${bId}`);
      break;
    }
  }
  return out;
}

// B started 0..1500 ms after A ended, in a later phase, and no data-flow edge goes into B. Times
// that are only a journal file time are not precise enough and do not count.
export function expectedTimeOrder(run, dataFlow) {
  const out = new Set();
  const phaseNo = new Map(run.phases.map((p) => [p.title, p.index]));
  const intoB = new Set([...dataFlow].map((k) => k.split('>')[1]));
  const precise = (f) => (f?.method === 'journal-event-ts' ? null : num(f));
  const phaseOf = (a) => (known(a.phase) && phaseNo.has(a.phase.value) ? phaseNo.get(a.phase.value) : null);
  for (const bId of run.order) {
    if (intoB.has(bId)) continue;
    const bs = precise(run.agents[bId].startedAt);
    const pb = phaseOf(run.agents[bId]);
    if (bs === null || pb === null) continue;
    for (const aId of run.order) {
      if (aId === bId) continue;
      const ae = precise(run.agents[aId].endedAt);
      const pa = phaseOf(run.agents[aId]);
      if (ae === null || pa === null || pa >= pb) continue;
      if (bs - ae >= 0 && bs - ae <= 1500) out.add(`${aId}>${bId}`);
    }
  }
  return out;
}

export const edgeKeys = (run, kind) => new Set(run.edges.filter((e) => e.kind === kind).map((e) => `${e.from}>${e.to}`));

// ---------------------------------------------------------------------------------------
// waiting

// Retries `check` (which throws on failure) until it passes or `ms` is over; then throws the last error.
export async function eventually(check, { ms = 10_000, every = 25 } = {}) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      last = err;
    }
    if (Date.now() >= end) throw last;
    await sleep(every);
  }
}

// ---------------------------------------------------------------------------------------
// bin/wfviz.mjs as a child process

const LISTENING = /^wfviz listening on http:\/\/127\.0\.0\.1:(\d+) \((real|demo)\)$/m;

// Every wfviz child that is still alive is killed when this process ends, normally or by SIGINT/SIGTERM/SIGHUP.
// `--idle 0` means the child never stops by itself, so a runner that died before its after() hooks ran would
// otherwise leave it running for ever. (A SIGKILL of the runner cannot be caught; nothing can help then.)
const liveChildren = new Set();
let exitHooked = false;
function killLiveChildren() {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  liveChildren.clear();
}
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', killLiveChildren);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      killLiveChildren();
      process.off(signal, handler);
      process.kill(process.pid, signal); // the default action, now that the children are gone
    };
    process.on(signal, handler);
  }
}

// Runs `node [--import <preload>...] bin/wfviz.mjs ...args` with the real modules (WFVIZ_TEST_FAKE is
// removed) and with the browser opener replaced by `true`, so that no test can open a browser.
export function startWfviz(args, { env = {}, nodeArgs = [] } = {}) {
  const childEnv = { ...process.env, WFVIZ_OPEN_CMD: 'true' };
  delete childEnv.WFVIZ_TEST_FAKE;
  Object.assign(childEnv, env);
  const child = spawn(process.execPath, [...nodeArgs, BIN, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  hookExit();
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  let stdout = '';
  let stderr = '';
  const waiters = new Set();
  const poke = () => waiters.forEach((w) => w());
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; poke(); });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; poke(); });
  let done = false;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { done = true; resolve({ code, signal }); poke(); }));

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`wfviz did not print its URL within 15 s\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);
    const check = () => {
      const m = LISTENING.exec(stdout);
      if (m) {
        clearTimeout(timer);
        waiters.delete(check);
        resolve({ port: Number(m[1]), mode: m[2], url: `http://127.0.0.1:${m[1]}` });
      } else if (done) {
        clearTimeout(timer);
        waiters.delete(check);
        reject(new Error(`wfviz exited before it listened\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    };
    waiters.add(check);
    check();
  });
  ready.catch(() => {});

  return {
    child, ready, exited,
    stdout: () => stdout,
    stderr: () => stderr,
    hasExited: () => done,
    kill: (signal = 'SIGKILL') => { if (!done) child.kill(signal); },
  };
}

export function httpGet(port, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
  });
}

export async function getJson(port, urlPath) {
  const res = await httpGet(port, urlPath);
  return { ...res, json: res.text ? JSON.parse(res.text) : undefined };
}

// Minimal SSE client: events: [{ event, data }]. waitFor(pred, ms) resolves with the first event
// (from the start of the stream) that satisfies pred. After the stream is over, `ended` says whether the
// server finished the response normally (the final chunk arrived: 'end' fired and res.complete is true) and
// `error` holds the abort error otherwise (a socket that was cut shows up as an error, never as 'end').
export function openSse(port, urlPath = '/api/stream') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
      const client = {
        status: res.statusCode, headers: res.headers, events: [], closed: false, ended: false, complete: false, error: null,
        close: () => req.destroy(),
      };
      const waiters = new Set();
      client.waitFor = (pred, ms = 5000) => new Promise((ok, fail) => {
        const find = () => client.events.find(pred);
        const now = find();
        if (now) return ok(now);
        const timer = setTimeout(() => {
          waiters.delete(check);
          fail(new Error(`SSE: no matching event within ${ms} ms; got ${JSON.stringify(client.events.map((e) => e.event))}`));
        }, ms);
        const check = () => {
          const hit = find();
          if (!hit) return;
          clearTimeout(timer);
          waiters.delete(check);
          ok(hit);
        };
        waiters.add(check);
      });
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length) client.events.push({ event, data: JSON.parse(data.join('\n')) });
        }
        waiters.forEach((w) => w());
      });
      res.on('end', () => { client.ended = true; });
      res.on('close', () => { client.closed = true; client.complete = res.complete; });
      res.on('error', (err) => { client.error = err; });
      resolve(client);
    });
    req.on('error', reject);
  });
}

// True when nothing accepts connections on the port any more.
export function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (err) => resolve(err.code === 'ECONNREFUSED'));
  });
}
