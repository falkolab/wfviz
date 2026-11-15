// Node RP3 in graph.md: a Pause pressed before any frame arrives (while the replay is connecting) delayed the
// whole replay by the paused time (judge's contract issue in workflow 14; user, 2026-11-11: fix). Contract §1
// "Replay inside the real server" was changed for this before the node. Also three lows from workflow 14.
export default {
  code: 'RP3',
  name: 'replay pause start',
  risk: 'low',
  owns: [
    'web/', 'bin/wfviz.mjs', 'src/source/replay.mjs',
    'test/server/web-replay.test.mjs', 'test/server/bin.test.mjs', 'test/server/replay-endpoint.test.mjs', 'test/source/replay.test.mjs',
    // shared tests that count timers, listeners or string writes: change only an assertion this node makes stale, same intent, say which
    'test/server/web-lib.test.mjs', 'test/server/web-u3.test.mjs', 'test/server/web-u4.test.mjs', 'test/server/web-hint.test.mjs',
  ],
  spec: `Read docs/contract.md §1 "Replay inside the real server" (the sentence "The view falls behind the stream only by what the pause held back" is new) and docs/guides/replay-pause-pace.md.
1. web/lib.js createReplayQueue, resume(): today the offset always grows by the whole paused time. New rule: at pause() remember whether a frame was kept. If one was: the offset grows by the paused time (as today: a waiting frame keeps the wait it had left). If none was: the offset grows by max(0, now - due(first kept frame)) when a frame arrived during the pause (so it is shown at Resume, or at its own due time if later), and by 0 when none arrived. The offset never shrinks. Update the comment above the function.
   Expected with a fake clock: pause at 100 with nothing kept, resume at 10100, a frame arriving at 10100 is applied at 10100 with no timer. Pause at 0 with nothing kept, a frame at 9900, resume at 10000: applied at 10000. Arrivals 0, 100, 400, pause at 50 (nothing kept), resume at 1050: applied at 0, 1050, 1350. Pause during catch-up (a frame waiting due at 1350, pause at 1200 for 500): that frame applied at 1850. Two pauses with frames kept still add up.
2. web/app.js:207 (low from workflow 14): selectRun sets state.replay.real = null; when the replay shows before a real snapshot restores it (real stream reconnect race), "Replay again" and the speed buttons are lost at 'ended' and 'failed'. Keep the last real Run of the same run id until a newer one comes, or have replayControl read canReplay from the run's status in the run list; test it.
3. bin/wfviz.mjs oncePerStep (low from workflow 14): fn() runs in a microtask outside the store's try/catch, so a throwing change listener would end the process. Catch it there and report it the way the store reports a failing listener (process.emitWarning or the launcher's warn), never rethrow; test with a listener that throws: the process stays up and the next step still notifies.
4. src/source/replay.mjs (low from workflow 14): with idOnly the duplicate-run error says "pass one of the run directories", which the endpoint refuses. With idOnly, say the run id is ambiguous under the root and list the places; keep the CLI wording without idOnly; test both.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0); test/integration/universal.test.mjs green.`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs; your own background tab).
1. Select finished run wf_3e37ce7f-482 (or another finished run; say which). Choose 4x, press Replay and Pause at once (same tick if you can). Wait 8 s. Resume. Expected: the first log lines appear within 1 s of Resume (report the time from Resume to the first line).
2. Pause again after about 3 s of play, wait 5 s, Resume: lines continue with their gaps, no burst (report the largest step in the log count sampled every 200 ms for 3 s).
3. Let it end: "replay finished" and Replay again are shown.`,
  },
  lensA: 'the queue rule exactly as contract §1 and the spec examples (give a failing arrival / pause sequence if not), offset never shrinks, one timer at a time, no timer while playing with nothing kept; the rest of the replay behaviour unchanged (gaps, order, end last, failure after kept frames); the app.js race fix; the launcher listener guard; the idOnly wording; tests real (fail on the old rule). Run the pure functions in node with a fake clock; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
