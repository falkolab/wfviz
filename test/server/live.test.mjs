// test/server/live.test.mjs (node U1): the launcher with the real source, model and server on a temp projects directory.
// A run is written to disk the way Claude Code writes one (journal, agent transcript); then
//   - the backlog endpoint and the SSE `event` frames carry the store's events,
//   - the transcript endpoint carries the full input of edit tools (which a Run does not keep), also for a line that is
//     appended while the page is open.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJson, openSse, sleep, startBin, test } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'wfviz.mjs');
const missing = ['src/source/claude-fs.mjs', 'src/model/reduce.mjs'].filter((p) => !fs.existsSync(path.join(REPO, p)));
const skip = missing.length ? `not present yet: ${missing.join(', ')}` : false;

const RUN = 'wf_live0001-abc';
const lines = (...objs) => objs.map((o) => `${JSON.stringify(o)}\n`).join('');
const tool = (ts, name, input, id) => ({
  type: 'assistant', timestamp: new Date(ts).toISOString(),
  message: { id: `m${id}`, content: [{ type: 'tool_use', id: `t${id}`, name, input }] },
});
const T0 = Date.parse('2026-11-08T10:00:00.000Z');

function makeProjects(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, '-tmp-proj', '11111111-2222-4333-8444-555555555555');
  const runDir = path.join(sessionDir, 'subagents', 'workflows', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'journal.jsonl'), lines({ type: 'launched' }, { type: 'started', key: 'v2:a1', agentId: 'a1', label: 'implement:S1', phase: 'Build' }));
  const agentFile = path.join(runDir, 'agent-a1.jsonl');
  return { root, runDir, agentFile };
}

const EDIT = { file_path: '/p/a.js', old_string: 'const a = 1;\n', new_string: 'const a = 2;\n', replace_all: false };
const WRITE = { path: '/p/new.js', file_text: 'export const x = 1;\n' };
const MULTI = { file_path: '/p/m.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] };

test('real modules: events backlog, SSE events and the transcript with full edit inputs, also for a line added later', { skip }, async (t) => {
  const p = makeProjects(t);
  fs.writeFileSync(p.agentFile, lines(
    { type: 'user', timestamp: new Date(T0).toISOString(), message: { content: 'go' } },
    tool(T0 + 1000, 'Read', { file_path: '/p/a.js' }, 1),
    tool(T0 + 2000, 'Edit', EDIT, 2),
    tool(T0 + 3000, 'Write', WRITE, 3),
    tool(T0 + 4000, 'MultiEdit', MULTI, 4),
  ));
  const bin = startBin(BIN, ['--no-open', '--idle', '0', '--root', p.root, '--since', 'Infinity'], { env: { WFVIZ_TEST_FAKE: undefined } });
  t.after(() => bin.kill('SIGKILL'));
  const { port } = await bin.ready;

  const deadline = Date.now() + 8000;
  let events = [];
  while (Date.now() < deadline) {
    const res = await getJson(port, `/api/runs/${RUN}/events`);
    events = Array.isArray(res.json) ? res.json : []; // a 404 object until the run has been read
    if (events.some((e) => e.kind === 'agent.activity' && /MultiEdit/.test(e.message))) break;
    await sleep(100);
  }
  assert.ok(events.length >= 5, `events: ${JSON.stringify(events.map((e) => e.kind))}`);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'seq from 1 without gaps');
  const started = events.find((e) => e.kind === 'agent.started');
  assert.deepEqual([started.agentId, started.label, started.role, started.unit, started.status], ['a1', 'implement:S1', 'implement', 'S1', 'running']);
  const tail = (await getJson(port, `/api/runs/${RUN}/events?since=${events.length - 2}`)).json;
  assert.deepEqual(tail.map((e) => e.seq), [events.length - 1, events.length]);

  const run = (await getJson(port, `/api/runs/${RUN}`)).json;
  assert.ok(run.agents.a1.activity.every((a) => !('input' in a)), 'a Run keeps no full inputs');

  const tr = await getJson(port, `/api/agents/${RUN}/a1/transcript`);
  assert.equal(tr.status, 200);
  const edits = tr.json.filter((a) => 'input' in a);
  assert.deepEqual(edits.map((a) => a.tool), ['Edit', 'Write', 'MultiEdit']);
  assert.deepEqual(edits.map((a) => a.input), [EDIT, WRITE, MULTI], 'the inputs as the transcript has them, field names not assumed');
  assert.equal(tr.json.find((a) => a.tool === 'Read').input, undefined, 'a tool that is not an edit has no input');
  assert.equal(tr.json.some((a) => a.inputTruncated), false);

  // a line appended while a client is connected: its event arrives, and its input is in the transcript right after
  const sse = await openSse(port);
  t.after(() => sse.close());
  await sse.waitFor((e) => e.event === 'run' && e.data.id === RUN);
  const seen = sse.events.length;
  const LATE = { file_path: '/p/late.js', old_string: 'x', new_string: 'y' };
  fs.appendFileSync(p.agentFile, lines(tool(T0 + 5000, 'Edit', LATE, 5)));
  const ev = await sse.waitFor((e) => e.event === 'event' && e.data.kind === 'agent.activity' && /late\.js/.test(e.data.message), 8000, seen);
  assert.equal(ev.data.agentId, 'a1');
  assert.equal(ev.data.seq, events.length + 1, 'the next seq of the run');
  const after = (await getJson(port, `/api/agents/${RUN}/a1/transcript`)).json;
  assert.deepEqual(after.filter((a) => 'input' in a).at(-1).input, LATE);
  await sleep(50);
});
