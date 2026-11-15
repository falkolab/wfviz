// Integration, replay and run start (docs/contract.md section 1 "Replay" and section 2, Run startedAt): the two saved runs are replayed through
// the replay source (injected timers, no waiting) and the Run is reduced after every emitted event.
//
//   - the first events out are run.script and run.launched (their ts is only a file time: a script can be saved hours before the run);
//   - from the first transcript record on, the run start is the earliest agent start: never earlier than that record, never the script
//     file time, and the same Fact at every event until run.final (so a view never repaints it);
//   - at run.final the start is the final file's own (prov "final").
// Run directories with more events than these two are not replayed here: reducing every prefix is quadratic.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reduceRun } from '../../src/model/reduce.mjs';
import { readRunDir } from '../../src/source/claude-fs.mjs';
import { createReplaySource } from '../../src/source/replay.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSION_DIR = path.join(REPO, 'fixtures', 'claude-projects', '-Volumes-MacMiniExt-Documents-work-incubator-adversarial-review-loop', '331703e5-9ca1-4323-b4b8-fccdb8917c4e');
const RUNS = [['wf_6509ce25-20a', 31], ['wf_26eb8d70-5c4', 35]];
const TRANSCRIPT = new Set(['agent.prompt', 'agent.activity', 'agent.structured']);
const HEADS = new Set(['run.script', 'run.launched']);

// the replay source on injected timers: every wait is a queued callback, drained at once
async function replayEvents(runId) {
  const queue = [];
  const timers = { setTimeout: (fn) => (queue.push(fn), queue.length), clearTimeout() {} };
  const got = [];
  const source = createReplaySource({ root: path.dirname(path.dirname(SESSION_DIR)), runId, speed: 100, onEvent: (e) => got.push(e), timers });
  await source.start();
  while (queue.length) queue.shift()();
  source.stop();
  return got;
}

for (const [runId, total] of RUNS) {
  test(`replay of ${runId}: it begins with run.script and run.launched, values unchanged, and every event of the run is emitted once`, async () => {
    const read = await readRunDir(SESSION_DIR, runId);
    assert.equal(read.length, total);
    const got = await replayEvents(runId);
    assert.equal(got.length, total);
    const headsRead = read.filter((e) => HEADS.has(e.kind));
    assert.ok(headsRead.length >= 1, 'the saved run has a script or a journal');
    assert.deepEqual(got.slice(0, headsRead.length).map((e) => e.kind), headsRead.map((e) => e.kind), 'the heads first, in reader order');
    assert.equal(got.slice(headsRead.length).some((e) => HEADS.has(e.kind)), false, 'no head later');
    assert.ok(got.every((e) => e.src === 'replay'));
    const strip = ({ src, ...rest }) => rest;
    const key = (e) => JSON.stringify(strip(e));
    assert.deepEqual(got.map(key).sort(), read.map(key).sort(), 'every value is the one the files gave, ts included');
    for (const head of headsRead) assert.equal(got.find((e) => e.kind === head.kind).ts, head.ts, `${head.kind} keeps its file time`);
  });

  test(`replay of ${runId}: from the first transcript record the run start is the earliest agent start (not earlier than that record, not the script time), constant until run.final, then the final's`, async () => {
    const got = await replayEvents(runId);
    const opts = { now: () => 1e13, staleMs: Infinity };
    const first = got.findIndex((e) => TRANSCRIPT.has(e.kind));
    const fin = got.findIndex((e) => e.kind === 'run.final');
    assert.ok(first > 0 && fin > first, `transcript from ${first}, final at ${fin}`);
    const startAtFirst = reduceRun(got.slice(0, first + 1), opts).startedAt;
    for (let i = 0; i < got.length; i++) {
      const start = reduceRun(got.slice(0, i + 1), opts).startedAt;
      if (i >= first && i < fin) {
        assert.ok(start.value >= got[first].ts, `after event ${i} (${got[i].kind}) the start ${start.value} is earlier than the first transcript record ${got[first].ts}`);
        assert.notEqual(start.method, 'script-file-time', `after event ${i} the script file time won over an agent start`);
        assert.deepEqual(start, startAtFirst, `after event ${i} (${got[i].kind}) the start Fact changed`);
        assert.equal(start.method, 'earliest-agent-start');
      } else if (i === fin) {
        assert.equal(start.prov, 'final', 'at run.final the start is the final file\'s');
      }
    }
    // the event before the first transcript record may still be a file time (the journal's), never a start the run did not have
    for (let i = 0; i < first; i++) {
      const start = reduceRun(got.slice(0, i + 1), opts).startedAt;
      assert.ok(['script-file-time', 'earliest-agent-start (journal file times, coarse)'].includes(start.method) || start.prov === 'unknown', `event ${i}: ${JSON.stringify(start)}`);
    }
  });
}
