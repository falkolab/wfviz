// Node RP2 in graph.md: after Pause, Resume plays the kept frames at the pace they arrived, not in one burst,
// and a stream failure while frames are kept loses none of them (user, 2026-11-10: "not small, do them").
// Contract §1 "Replay inside the real server" was changed for this before the node.
export default {
  code: 'RP2',
  name: 'replay pause pace and hint icon',
  risk: 'low',
  owns: [
    'web/', 'test/server/web-replay.test.mjs',
    // shared tests that count timers, listeners or string writes: change only an assertion this node makes stale, same intent, say which
    'test/server/web-lib.test.mjs', 'test/server/web-u3.test.mjs', 'test/server/web-u4.test.mjs', 'test/server/web-hint.test.mjs',
  ],
  spec: `Web only (web/app.js, web/lib.js, and index.html / style.css only if a label needs it). Server, source, model and bin are not yours. Read docs/contract.md §1 "Replay inside the real server" (the Pause / Resume sentences are new) and docs/guides/replay-in-app.md.
Today (web/app.js replay section, web/lib.js createReplayBuffer): a paused replay keeps every event, only the newest run snapshot and the end; Resume applies all of it at once; a stream failure while paused calls buffer.take() and drops what was kept.
What to build:
1. A frame queue in web/lib.js (pure, testable; clock and timers injected): every frame of the replay stream (run, event, end) is stamped with its arrival time. While playing with nothing kept, a frame is applied on arrival as today (no added delay, no timer). Pause: frames are kept in order, none applied. Resume: kept frames are applied in order, each at (its arrival time + the total paused time so far), so the gaps between them are the gaps they arrived with; frames arriving meanwhile go behind them with the same offset; a second Pause while catching up stops the queue again and adds to the offset. One timer at a time; none left after Stop, run switch, replay again, end, or page unload.
2. The run snapshots are frames like the others: a snapshot is applied at its place in the queue, not ahead of the events before it. Keeping only the newest snapshot is no longer right; a snapshot directly followed in the queue by a newer snapshot with no event between may be dropped.
3. end is applied after the last kept frame: "replay finished" appears only then. The stream closing after end must not cut the queue short.
4. Failure while frames are kept (paused or catching up): nothing kept is dropped. While paused they stay kept; on Resume (or while catching up) they are played, and the failure line with its reason is shown after the last of them. Pause / Resume stay usable until the queue is empty. Stop still drops everything and returns to the real view.
5. While catching up, the controls show the state truthfully (the Pause button is Pause, not Resume); the count of events applied stays the count applied, not received.
6. Also fix (low from RP1): after a replay that failed before it ever showed (never begun), state.replay must not keep a stale real Run (web/app.js near the rep.real use around line 201): show the current real run. And the flash-highlight timer must not mutate the centre view after Pause (cancel or hold pending flashes on Pause).
7. Tracking hint icon (user, 2026-11-10): the header button "Tracking hint" and the title of the notice "Better tracking (optional)" carry a small warning sign, a yellow triangle with "!" (inline SVG in index.html or CSS, aria-hidden, about 14 px, no network, readable on the dark header; the yellow comes from a CSS variable next to the existing colours). The button's accessible name stays "Tracking hint". A test in test/server/web-hint.test.mjs checks the icon is in both places and is aria-hidden.
8. Steady UI rules (docs/guides/common.md): update by key, no whole-region rewrite; data strings escaped.
9. Tests in test/server/web-replay.test.mjs with a fake clock: gaps kept after one pause (arrivals at 0, 100, 400 ms, pause at 50 for 1000 ms: applied at 0, 1100, 1400); two pauses add up; frames arriving during catch-up keep order; snapshot order relative to events; end last; failure while paused keeps all frames and the reason comes after them; Stop clears the timer; no timer while playing with an empty queue. Replace the tests of the old take() semantics.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0); test/integration/universal.test.mjs green.`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs; your own background tab).
1. Select finished run wf_3e37ce7f-482 (or another finished run; say which). Replay at 4x. After about 5 s press Pause; note the log line count N1. Wait 10 s: the centre view has 0 mutations (MutationObserver), the count stays N1.
2. Resume. Expected: the log count does not jump: sample it every 200 ms for 5 s and report the largest single step and the counts; a jump of more than about 20 lines in one sample, or reaching the end at once, is a failure.
3. Let it run to the end. Expected: "replay finished" appears only after the last line; the final log line count equals the count of an unpaused replay of the same run (run one at 20x and compare, or report both numbers).
4. Replay at 20x, Pause at once, wait until the network shows the stream finished, Resume. Expected: the run plays out (not instantly), then "replay finished".
5. Replay, Pause, then Stop: the real view returns, no further changes for 5 s.
6. The header button "Tracking hint" shows a yellow triangle with "!" before its text; open the notice: the same sign before its title. At 800 px width the header does not wrap because of it (report the header height before and after if you can).`,
  },
  lensA: 'behaviour of the frame queue: order of run/event/end frames, gaps kept (give a failing arrival sequence if not), offset across two pauses, no frame lost on failure while paused or catching up, reason shown after the last frame, timers cleared on Stop / run switch / replay again / end, no delay added to an unpaused replay, steady UI (no whole-region rewrite), escaping, tests real (fail on the old burst behaviour). Run the pure functions in node with a fake clock; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
