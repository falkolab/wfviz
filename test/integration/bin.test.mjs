// Integration, the launcher: bin/wfviz.mjs as a child process with the REAL source, model and server
// (no WFVIZ_TEST_FAKE), reading a temp root that is changed while it runs.
//
//   --no-open --root <temp root> --idle 0 --port 0
//
// The temp root holds probe 2 (finished) and probe 1 (in progress). The test reads the printed URL,
// checks the HTTP API and the SSE stream, lets probe 1 finish while the stream is open, and ends the
// process with SIGINT. A second group proves that real mode never loads the demo source.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, it, test } from 'node:test';

import { createStore } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import {
  BIN, CAN_LOG_MODULE_LOADS, REPO, WEB_DIR, assertRunShape, connectionRefused, copyFileInto, copyRun, edgeKeys, eventually, findRun,
  getJson, httpGet, mkTmp, openSse, readLines, replayInto, runFiles, startWfviz,
} from './helpers.mjs';

const PROBE1 = findRun('wf_6509ce25-20a');
const PROBE2 = findRun('wf_26eb8d70-5c4');
const S1 = '33333333-3333-4333-8333-333333333331';
const S2 = '33333333-3333-4333-8333-333333333332';
const SLUG = '-integration-bin';
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./load-log-register.mjs', import.meta.url))).href;
const PRELOAD_ARGS = CAN_LOG_MODULE_LOADS ? ['--import', PRELOAD] : [];
const NO_LOG = CAN_LOG_MODULE_LOADS ? false : 'this Node has neither module.registerHooks nor module.register (before 20.6): module loads cannot be logged';
// bin/wfviz.mjs force-exits 3000 ms after the signal if the server has not closed by then. A graceful close
// takes milliseconds; anything near this bound means the close did not work and the timer ended the process.
const GRACEFUL_EXIT_MS = 1500;
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

const loadedModules = (logFile) => fs.readFileSync(logFile, 'utf8').split('\n').filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u));
const rel = (file) => path.relative(REPO, file);

// ---------------------------------------------------------------------------------------
// real mode, the whole way through

describe('bin/wfviz.mjs --no-open --root <temp root> --idle 0 --port 0', { timeout: 120_000 }, () => {
  let tmp;
  let root;
  let bin;
  let port;
  let sse;
  let loadLog;
  let dir1;
  let dir2;
  const state = {};

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-int-bin-'));
    root = path.join(tmp, 'projects');
    loadLog = path.join(tmp, 'modules-loaded.log');
    dir1 = path.join(root, SLUG, S1);
    dir2 = path.join(root, SLUG, S2);

    // probe 2: finished, everything there
    copyRun(PROBE2.sessionDir, PROBE2.runId, dir2, { final: true });

    // probe 1: script, the first three journal lines (launched, both reviewers started), the reviewers' files
    const src = runFiles(PROBE1.sessionDir, PROBE1.runId);
    copyFileInto(PROBE1.sessionDir, src.script, dir1);
    const journal = readLines(src.journal);
    state.journal = journal;
    state.src = src;
    const runDir = path.join(dir1, 'subagents', 'workflows', PROBE1.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${journal.slice(0, 3).join('\n')}\n`);
    const started = journal.map((l) => JSON.parse(l)).filter((r) => r.type === 'started');
    for (const r of started.slice(0, 2)) {
      const a = src.agents.find((x) => x.id === r.agentId);
      copyFileInto(PROBE1.sessionDir, a.meta, dir1);
      copyFileInto(PROBE1.sessionDir, a.jsonl, dir1);
    }
    state.runDir = runDir;

    bin = startWfviz(['--no-open', '--root', root, '--idle', '0', '--port', '0'], {
      nodeArgs: PRELOAD_ARGS,
      env: { WFVIZ_TEST_LOADLOG: loadLog },
    });
    ({ port } = await bin.ready);
  });

  after(() => {
    sse?.close();
    bin?.kill('SIGKILL');
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints one line, "wfviz listening on http://127.0.0.1:<port> (real)", with a port the OS chose', () => {
    assert.match(bin.stdout(), /^wfviz listening on http:\/\/127\.0\.0\.1:\d+ \(real\)\n$/);
    assert.ok(port > 0 && port < 65536);
  });

  it('GET /api/runs lists both runs, newest first, with the summary fields of contract section 4', async () => {
    // the first scan is still running when the URL is printed: wait until both runs are completely read
    const res = await eventually(async () => {
      const r = await getJson(port, '/api/runs');
      assert.equal(r.json.length, 2, `runs: ${JSON.stringify(r.json.map((x) => x.id))}`);
      assert.deepEqual(r.json.map((x) => x.agents).sort(), [2, 6], 'both runs read to the end of their files');
      assert.ok(r.json.every((x) => x.status.value !== null));
      return r;
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    const byId = Object.fromEntries(res.json.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), [PROBE1.runId, PROBE2.runId].sort());
    for (const r of res.json) {
      for (const k of ['id', 'name', 'status', 'project', 'startedAt', 'agents', 'running']) assert.ok(k in r, `summary has ${k}`);
      assert.equal(r.source, 'real');
      assert.equal(r.project, SLUG);
      assert.equal(typeof r.agents, 'number');
    }
    assert.deepEqual([byId[PROBE2.runId].status.value, byId[PROBE2.runId].status.prov], ['failed', 'final']);
    assert.equal(byId[PROBE2.runId].name.value, 'probe-edge-cases');
    assert.equal(byId[PROBE2.runId].agents, 6);
    assert.deepEqual([byId[PROBE1.runId].status.value, byId[PROBE1.runId].status.prov], ['running', 'inferred']);
    assert.equal(byId[PROBE1.runId].name.value, 'probe-event-format');
    assert.equal(byId[PROBE1.runId].agents, 2);
    assert.equal(byId[PROBE1.runId].running, 2);
    assert.ok(res.json.every((r) => !r.id.startsWith('demo-')), 'real mode lists no demo run');
    const starts = res.json.map((r) => r.startedAt.value);
    assert.ok(starts.every((v) => typeof v === 'number'));
    assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'newest first');
  });

  it('GET /api/runs/:id returns the Run; a finished run equals what the in-process pipeline builds from the same files', async () => {
    const live = await getJson(port, `/api/runs/${PROBE1.runId}`);
    assert.equal(live.status, 200);
    assertRunShape(live.json, 'probe 1 (running)');
    assert.equal(live.json.source, 'real');
    assert.equal(live.json.order.length, 2);
    assert.ok(live.json.order.every((id) => live.json.agents[id].state.value === 'running'));
    assert.deepEqual(live.json.edges, []);

    const done = await getJson(port, `/api/runs/${PROBE2.runId}`);
    assert.equal(done.status, 200);
    assertRunShape(done.json, 'probe 2');
    const { run } = await replayInto(createStore, readRunDir, dir2, PROBE2.runId);
    assert.deepEqual(done.json, JSON.parse(JSON.stringify(run)), 'served Run = replay of the same directory');

    const missing = await getJson(port, '/api/runs/wf_does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal((await getJson(port, `/api/runs/${PROBE2.runId}x`)).status, 404);
  });

  it('SSE: hello says mode real; then a run event arrives when a file of probe 1 changes', async () => {
    sse = await openSse(port);
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /^text\/event-stream/);
    const hello = await sse.waitFor((e) => e.event === 'hello');
    assert.deepEqual(hello.data, { mode: 'real', version: pkg.version });
    assert.equal(sse.events[0].event, 'hello', 'hello is the first event');

    // the rest of probe 1 happens now: the other agents' files, then the journal lines
    const { src, journal, runDir } = state;
    const lines = journal.map((l) => JSON.parse(l));
    const startedIds = lines.filter((r) => r.type === 'started').map((r) => r.agentId);
    for (const id of startedIds.slice(2)) {
      const a = src.agents.find((x) => x.id === id);
      copyFileInto(PROBE1.sessionDir, a.meta, dir1);
      copyFileInto(PROBE1.sessionDir, a.jsonl, dir1);
    }
    fs.appendFileSync(path.join(runDir, 'journal.jsonl'), `${journal.slice(3).join('\n')}\n`);

    const ev = await sse.waitFor((e) => e.event === 'run' && e.data.id === PROBE1.runId && e.data.totals.agents === 5 && e.data.totals.done === 5, 15_000);
    assertRunShape(ev.data, 'run event');
    assert.equal(ev.data.source, 'real');
    assert.deepEqual([ev.data.status.value, ev.data.status.prov], ['running', 'inferred'], 'no final file yet');
  });

  it('SSE: the final file arrives last and the stream says completed; the API agrees and there is no data-flow edge (contract 2)', async () => {
    copyFileInto(PROBE1.sessionDir, state.src.final, dir1);
    const ev = await sse.waitFor((e) => e.event === 'run' && e.data.id === PROBE1.runId && e.data.status.value === 'completed', 15_000);
    assert.equal(ev.data.status.prov, 'final');

    const served = await getJson(port, `/api/runs/${PROBE1.runId}`);
    assert.deepEqual(served.json, JSON.parse(JSON.stringify((await replayInto(createStore, readRunDir, dir1, PROBE1.runId)).run)));
    const label = (id) => served.json.agents[id].label.value;
    assert.deepEqual(
      [...edgeKeys(served.json, 'data-flow')].map((k) => k.split('>').map(label).join(' -> ')).sort(),
      [], // contract 2: the reviewer results have 37 chars, below the 64 an edge needs (contract 1: both reviewers -> judge)
    );
    assert.equal(served.json.registeredEdges.prov, 'unknown');

    const list = await getJson(port, '/api/runs');
    assert.deepEqual(list.json.find((r) => r.id === PROBE1.runId).status, { value: 'completed', prov: 'final', from: served.json.status.from });
    assert.ok(list.json.every((r) => !r.id.startsWith('demo-')));
  });

  it('GET /api/agents/:run/:agent/transcript returns the agent activity the model holds', async () => {
    const run = (await getJson(port, `/api/runs/${PROBE1.runId}`)).json;
    const a = Object.values(run.agents).find((x) => x.label.value === 'reviewer:A');
    const res = await getJson(port, `/api/agents/${PROBE1.runId}/${a.id}/transcript?tail=50`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, a.activity);
    assert.ok(res.json.length > 0);
    assert.ok(res.json.some((x) => x.tool === 'StructuredOutput'));
    assert.equal((await getJson(port, `/api/agents/${PROBE1.runId}/nobody/transcript`)).status, 404);
  });

  it('GET / serves web/index.html, and the files it names', async () => {
    const res = await httpGet(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.ok(res.body.equals(fs.readFileSync(path.join(WEB_DIR, 'index.html'))), '/ is exactly web/index.html');
    for (const [url, type] of [['/app.js', /javascript/], ['/style.css', /css/]]) {
      if (!res.text.includes(url.slice(1))) continue; // only what index.html refers to
      const asset = await httpGet(port, url);
      assert.equal(asset.status, 200, url);
      assert.match(asset.headers['content-type'], type);
      assert.ok(asset.body.equals(fs.readFileSync(path.join(WEB_DIR, url))), url);
    }
  });

  it('SIGINT: a graceful close (exit 0 well before the force timer, SSE response completed, port free), not a forced exit', async () => {
    const before = Date.now();
    bin.kill('SIGINT');
    const { code, signal } = await bin.exited;
    const elapsed = Date.now() - before;
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, 'exit code 0, not killed by the signal');
    assert.ok(elapsed < GRACEFUL_EXIT_MS, `exit took ${elapsed} ms: the 3000 ms force-exit timer, not the server close, ended the process`);

    // Process death alone also closes the client's socket. What only a server that ends its streams does is to
    // finish the response: the final chunk arrives ('end', res.complete) and nothing is reported as aborted.
    await eventually(() => assert.ok(sse.closed, 'the SSE connection is closed'), { ms: 2000 });
    assert.equal(sse.error, null, `the SSE response was not cut: ${sse.error?.message}`);
    assert.equal(sse.ended, true, 'the server finished the SSE response (end), it did not abort it');
    assert.equal(sse.complete, true, 'the SSE response is complete');

    assert.equal(await connectionRefused(port), true, 'port is free');
    assert.deepEqual(bin.stderr().split('\n').filter(Boolean), ['wfviz: SIGINT, shutting down'], 'no force-exit trace, nothing but the shutdown note');
    assert.equal(bin.stdout().split('\n').filter(Boolean).length, 1, 'stdout carries the listening line only');
  });

  it('real mode loaded the claude-fs source, the model and the server, and never the demo source', { skip: NO_LOG }, () => {
    const loaded = loadedModules(loadLog).map(rel);
    for (const must of ['src/source/claude-fs.mjs', 'src/model/reduce.mjs', 'src/server/server.mjs', 'src/server/args.mjs']) {
      assert.ok(loaded.includes(must), `${must} was loaded; got ${JSON.stringify(loaded.filter((m) => m.startsWith('src/')))}`);
    }
    assert.deepEqual(loaded.filter((m) => /demo/i.test(m)), [], 'no module with "demo" in its path was ever resolved');
  });
});

// ---------------------------------------------------------------------------------------
// demo isolation

const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n')
  .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
  .join('\n');

test('bin/wfviz.mjs mentions the demo source only inside one dynamic import() under `if (opts.demo)`', () => {
  const code = stripComments(fs.readFileSync(BIN, 'utf8'));
  assert.ok(!/^\s*import\b[^;\n]*demo/m.test(code), 'no static import of demo');
  assert.ok(!/^\s*export\b[^;\n]*from[^;\n]*demo/m.test(code), 'no re-export of demo');
  const open = [...code.matchAll(/if \(opts\.demo\) \{/g)];
  assert.equal(open.length, 1, 'exactly one `if (opts.demo) {` block');
  const start = open[0].index + open[0][0].length;
  let depth = 1;
  let end = start;
  for (; end < code.length && depth > 0; end++) {
    if (code[end] === '{') depth++;
    else if (code[end] === '}') depth--;
  }
  const block = code.slice(start, end - 1);
  const mentions = [...code.matchAll(/demo\.mjs/g)].map((m) => m.index);
  assert.ok(mentions.length > 0, 'the demo source is wired somewhere');
  for (const at of mentions) assert.ok(at >= start && at < end, `"demo.mjs" at offset ${at} is outside the demo block`);
  const dynamic = [...block.matchAll(/\bimport\(\s*(['"])(\.\.\/src\/source\/demo\.mjs)\1\s*\)/g)];
  assert.equal(dynamic.length, 1, 'one dynamic import() with a literal path');
});

test('no module under src/ other than demo.mjs refers to the demo source', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(path.join(REPO, 'src')).filter((f) => /\.m?js$/.test(f));
  assert.ok(files.length >= 8);
  for (const f of files) {
    if (path.basename(f) === 'demo.mjs') continue;
    assert.ok(!/demo\.mjs/.test(stripComments(fs.readFileSync(f, 'utf8'))), `${rel(f)} must not reference demo.mjs`);
  }
});

test('--demo (the control): loads the demo source and not claude-fs, lists only demo- runs, says mode demo', { timeout: 60_000 }, async (t) => {
  const tmp = mkTmp(t);
  const log = path.join(tmp, 'modules-loaded.log');
  const bin = startWfviz(['--demo', '--no-open', '--idle', '0'], { nodeArgs: PRELOAD_ARGS, env: { WFVIZ_TEST_LOADLOG: log } });
  t.after(() => bin.kill('SIGKILL'));
  const { port, mode } = await bin.ready;
  assert.equal(mode, 'demo');
  const sse = await openSse(port);
  t.after(() => sse.close());
  assert.deepEqual((await sse.waitFor((e) => e.event === 'hello')).data, { mode: 'demo', version: pkg.version });
  const runs = await eventually(async () => {
    const r = (await getJson(port, '/api/runs')).json;
    assert.ok(r.length > 0, 'the demo source has started a run');
    return r;
  }, { ms: 15_000 });
  assert.ok(runs.every((r) => r.id.startsWith('demo-') && r.source === 'demo'), JSON.stringify(runs.map((r) => [r.id, r.source])));
  const run = (await getJson(port, `/api/runs/${runs[0].id}`)).json;
  assertRunShape(run, 'demo run');
  assert.equal(run.source, 'demo');

  bin.kill('SIGINT');
  assert.deepEqual(await bin.exited, { code: 0, signal: null });
  if (!CAN_LOG_MODULE_LOADS) return; // the run above is the control; the module list is not available here
  const loaded = loadedModules(log).map(rel);
  assert.ok(loaded.includes('src/source/demo.mjs'));
  assert.ok(!loaded.includes('src/source/claude-fs.mjs'), 'demo mode never reads ~/.claude');
});
