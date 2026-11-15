// Integration, run history (contract section 4, P1): bin/wfviz.mjs as a child process with the REAL source, model and server on a temp
// root with two project dirs: the saved fixture runs, every file set back to 2025-11-01 (project A, two old runs) and a run written now
// (project B). GET /api/runs lists all three with `loaded`; GET /api/runs/:id of an old run loads it and answers the same Run as a
// --since Infinity server does for it; /api/stream has snapshots of the loaded run only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import { execFile } from 'node:child_process';
import os from 'node:os';
import { BIN, FIXTURES, eventually, getJson, openSse, startWfviz } from './helpers.mjs';

const FIX_SLUG = fs.readdirSync(path.join(FIXTURES, 'claude-projects'))[0];
const OLD_A = 'wf_6509ce25-20a';
const OLD_B = 'wf_26eb8d70-5c4';
const NEW_RUN = 'wf_fresh-b01';
const LONG_AGO = new Date('2025-11-01T00:00:00Z');

function setTimes(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) setTimes(p);
    fs.utimesSync(p, LONG_AGO, LONG_AGO);
  }
}

const line = (o) => `${JSON.stringify(o)}\n`;

describe('bin/wfviz.mjs on a root with old runs and a fresh one', { timeout: 120_000 }, () => {
  let tmp;
  let root;
  let bin;
  let port;
  let full;
  let fullPort;
  let sse;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-int-p1-'));
    root = path.join(tmp, 'projects');
    fs.cpSync(path.join(FIXTURES, 'claude-projects', FIX_SLUG), path.join(root, FIX_SLUG), { recursive: true });
    setTimes(path.join(root, FIX_SLUG));
    const runDir = path.join(root, '-Users-other-proj', '22222222-3333-4444-8555-666666666666', 'subagents', 'workflows', NEW_RUN);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), line({ type: 'launched' }) + line({ type: 'started', key: 'v2:b1', agentId: 'b1', label: 'x:A', phase: 'P' }));
    fs.writeFileSync(path.join(runDir, 'agent-b1.jsonl'), line({ type: 'user', message: { content: 'fresh prompt' } }));

    bin = startWfviz(['--no-open', '--root', root, '--idle', '0', '--port', '0']);
    ({ port } = await bin.ready);
    full = startWfviz(['--no-open', '--root', root, '--idle', '0', '--port', '0', '--since', 'Infinity']);
    ({ port: fullPort } = await full.ready);
  });

  after(() => {
    sse?.close();
    bin?.kill('SIGKILL');
    full?.kill('SIGKILL');
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /api/runs lists every run of both projects: the fresh one loaded, the old ones not', async () => {
    // the first scan is still running when the URL is printed: wait until both servers have read everything they read at start. The server with
    // --since Infinity lists the same runs, all loaded; an old run's list item (from journal, final file and script only) says what the loaded
    // one says: name, status with its provenance, agent count, project
    const { byId } = await eventually(async () => {
      const list = (await getJson(port, '/api/runs')).json;
      const all = (await getJson(fullPort, '/api/runs')).json;
      assert.equal(list.length, 3, JSON.stringify(list.map((x) => x.id)));
      assert.deepEqual(all.map((r) => r.id).sort(), list.map((r) => r.id).sort());
      assert.ok(all.every((r) => r.loaded === true));
      const byId = Object.fromEntries(list.map((r) => [r.id, r]));
      for (const ref of all) {
        const item = byId[ref.id];
        assert.deepEqual([item.name, item.status, item.agents, item.project], [ref.name, ref.status, ref.agents, ref.project], ref.id);
      }
      return { byId };
    });
    assert.deepEqual(Object.keys(byId).sort(), [NEW_RUN, OLD_A, OLD_B].sort());
    assert.equal(byId[NEW_RUN].loaded, true);
    assert.equal(byId[OLD_A].loaded, false);
    assert.equal(byId[OLD_B].loaded, false);
    assert.equal(byId[OLD_A].project, FIX_SLUG, 'the project is the directory name as on disk');
    assert.equal(byId[NEW_RUN].project, '-Users-other-proj');
    assert.equal(byId[OLD_B].status.prov, 'final');
  });

  it('/api/stream has snapshots of the loaded run only; the first GET of an old run loads it and a snapshot follows', async () => {
    sse = await openSse(port);
    await sse.waitFor((e) => e.event === 'run' && e.data.id === NEW_RUN);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual([...new Set(sse.events.filter((e) => e.event === 'run').map((e) => e.data.id))], [NEW_RUN], 'no snapshot of a listed-only run');

    const t0 = Date.now();
    const res = await getJson(port, `/api/runs/${OLD_A}`);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 10_000);
    const ref = (await getJson(fullPort, `/api/runs/${OLD_A}`)).json;
    const agents = (run) => Object.keys(run.agents).sort();
    assert.deepEqual(agents(res.json), agents(ref), 'the same agents as a server that loaded it at start');
    assert.equal(res.json.status.value, ref.status.value);
    assert.equal(res.json.name.value, ref.name.value);
    assert.deepEqual(res.json.recognized, ref.recognized);
    assert.equal(res.json.agents[agents(res.json)[0]].prompt.prov, ref.agents[agents(ref)[0]].prompt.prov, 'transcript facts are there');
    assert.notEqual(res.json.agents[agents(res.json)[0]].prompt.prov, 'unknown');

    const list = (await getJson(port, '/api/runs')).json;
    assert.equal(list.find((r) => r.id === OLD_A).loaded, true);
    assert.equal(list.find((r) => r.id === OLD_B).loaded, false, 'only the asked run');
    await sse.waitFor((e) => e.event === 'run' && e.data.id === OLD_A, 3000);
    assert.equal((await getJson(port, '/api/runs/wf_no-such-run')).status, 404, 'a run that is not listed is not loaded');
  });
});

test('--help says that --since chooses which runs are loaded at start and that every run is listed; the note adds only what the line does not say, and a usage error has the line alone', async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, [BIN, '--help'], { timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  // one statement about --since, on the --since line itself (a usage error prints usage() without the note, so the line must stand alone)
  const sinceLines = out.split('\n').filter((l) => l.includes('--since'));
  assert.equal(sinceLines.length, 1, 'one statement about --since, not two that could disagree');
  assert.match(sinceLines[0], /^ {2}--since <hours> {4}[^\n]*loaded at start[^\n]*every run is listed[^\n]*not used by --replay/);
  assert.doesNotMatch(out, /only runs changed|does not hide older runs/, 'the old meaning and the note that corrected it are gone');
  // the note keeps only what the line lacks, and follows it
  const note = out.split('\n').find((l) => /listed from its journal, final file and script only/.test(l));
  assert.ok(note, 'the note says how a run that was not loaded at start is read');
  assert.match(note, /loaded when it is opened/);
  assert.ok(out.indexOf(note) > out.indexOf(sinceLines[0]), 'the note follows the --since line');
  assert.doesNotMatch(note, /every run|--since/, 'the note does not say again what the line says');
  assert.match(out, /--offline /, '--offline is listed');
  // a usage error prints the usage text and not the note: the --since line is complete without it
  const err = await new Promise((resolve) => {
    execFile(process.execPath, [BIN, '--bogus'], { timeout: 10_000 }, (e, stdout, stderr) => resolve({ code: e?.code, stderr, stdout }));
  });
  assert.notEqual(err.code, 0);
  assert.match(err.stderr, /--since <hours>[^\n]*loaded at start[^\n]*every run is listed/);
  assert.doesNotMatch(err.stderr, /listed from its journal/, 'a usage error has no note: the line has to stand alone');
});
