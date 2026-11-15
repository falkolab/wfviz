// Shared by the watch, edit-input and script-after-run tests: a temp root with one session and one
// run directory, a source that records its events, small waiting helpers. Not a test file: no
// `.test.` in the name, so test/source/index.js does not load it on its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClaudeFsSource } from '../../src/source/claude-fs.mjs';

export const SLUG = '-tmp-proj';
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const RUN = 'wf_test0001-abc';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const lines = (...objs) => objs.map((o) => `${JSON.stringify(o)}\n`).join('');

export async function waitFor(fn, timeoutMs = 5000, what = 'the condition') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// Waits until a real recursive fs.watch on `root` is live, so that a change made right after this
// returns is not lost. On macOS the FSEvents stream behind fs.watch needs a few ms after fs.watch()
// returns, and a change made in that gap is never reported (seen in 1 to 4 of 32 runs under 8-way CPU
// load, with no further change to recover it). Call it after source.start(): the probe below is
// opened after the source's own watcher, and the platform starts streams in the order they were
// opened, so a live probe means the source's watcher is live too. The probe creates a scratch
// directory under root (after the probe exists, so an event the platform replays from before cannot
// name it) and touches a file in it until an event names that directory, then closes and removes it.
export async function watcherIsLive(root, timeoutMs = 20_000) { // FSEvents can start late on a loaded machine
  const name = `.wfviz-live-probe-${process.pid}-${Date.now()}`;
  const scratch = path.join(root, name);
  let seen = false;
  const probe = fs.watch(root, { recursive: true }, (_type, filename) => {
    if (typeof filename === 'string' && filename.includes(name)) seen = true;
  });
  try {
    const t0 = Date.now();
    await fsp.mkdir(scratch, { recursive: true });
    for (let i = 0; !seen; i++) {
      if (Date.now() - t0 > timeoutMs) assert.fail('timed out waiting for fs.watch to become live');
      await fsp.writeFile(path.join(scratch, 'touch'), String(i));
      await sleep(20);
    }
  } finally {
    probe.close();
    await fsp.rm(scratch, { recursive: true, force: true });
  }
}

// A temp root with one session and one run directory (removed after the test). `runDirOf(id)` and
// `finalOf(id)` give the paths for further runs of the same session.
export async function setup(t, { slug = SLUG, session = SESSION, runId = RUN } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wfviz-s1-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, slug, session);
  const runDirOf = (id) => path.join(sessionDir, 'subagents', 'workflows', id);
  const runDir = runDirOf(runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(path.join(sessionDir, 'workflows'), { recursive: true }); // where the final files go
  return {
    root, slug, session, sessionDir, runDir, runId, runDirOf,
    journal: path.join(runDir, 'journal.jsonl'),
    journalOf: (id) => path.join(runDirOf(id), 'journal.jsonl'),
    agentFile: (id) => path.join(runDir, `agent-${id}.jsonl`),
    metaFile: (id) => path.join(runDir, `agent-${id}.meta.json`),
    scriptsDir: path.join(sessionDir, 'workflows', 'scripts'),
    finalFile: path.join(sessionDir, 'workflows', `${runId}.json`),
    finalOf: (id) => path.join(sessionDir, 'workflows', `${id}.json`),
    rel: (...parts) => path.join(slug, session, ...parts), // the path fs.watch reports: relative to root
  };
}

// A source that records its events; stopped when the test ends. `watch` is off unless a test says so.
export function track(t, root, opts = {}) {
  const events = [];
  const source = createClaudeFsSource({ root, pollMs: 60_000, watch: false, sinceMs: Infinity, onEvent: (e) => events.push(e), ...opts });
  t.after(() => source.stop());
  const kinds = (k) => events.filter((e) => e.kind === k);
  return { source, events, kinds };
}

export const started = (id, label, phase) => ({ type: 'started', key: `v2:${id}`, agentId: id, ...(label ? { label } : {}), ...(phase ? { phase } : {}) });
