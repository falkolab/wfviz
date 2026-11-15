// Node RP1 in graph.md: replay a finished run from the main (real) wfviz page, without a separate
// `--replay` server (user, 2026-11-10). Contract §1 "Replay inside the real server" and §4
// `GET /api/runs/:id/replay` were approved by the user before this node.
// Runs after "tracking hint" (H1): both own web/.
export default {
  code: 'RP1',
  name: 'replay in app',
  risk: 'high',
  owns: [
    'src/server/server.mjs', 'bin/wfviz.mjs', 'web/',
    'test/server/replay-endpoint.test.mjs', 'test/server/web-replay.test.mjs', 'test/server/server.test.mjs',
    // shared tests that count timers, listeners, string writes or routes, or start the launcher (H1 and R1 were blocked by such):
    // change only an assertion the new feature makes stale, with the same intent, and say which in your note
    'test/server/web-lib.test.mjs', 'test/server/web-u3.test.mjs', 'test/server/web-u4.test.mjs', 'test/server/web-hint.test.mjs',
    'test/server/bin.test.mjs', 'test/server/live.test.mjs', 'test/integration/bin.test.mjs',
  ],
  spec: `Read docs/contract.md §1 "Replay" and "Replay inside the real server", and §4 (the new GET /api/runs/:id/replay). Source and model are not yours: use src/source/replay.mjs (locateRun, createReplaySource, normalizeSpeed) and src/model/reduce.mjs (createStore) as they are, read-only; list needed changes there in your note.
What to build:
1. Server (src/server/server.mjs): an optional injection createServer({ ..., replays }) where replays.open({ runId, speed, onRun, onEvent, onEnd, onError }) -> { stop() }. Route GET /api/runs/:id/replay?speed=<n> exactly as contract §4: SSE with hello {mode:"replay", version, runId}, run snapshots throttled like /api/stream, event objects in the /api/stream shape with seq from 1 without gaps, end {runId, events}; 404 when mode is not real or replays is absent or the run is unknown to the real store; 409 with the reason when the run is running; 400 for a speed that is not a number > 0; 429 when 3 replays are open. Closing the request stops the replay (stop() called once, timers cleared); server.close() stops every open replay. Heartbeats like /api/stream. Nothing the replay emits reaches /api/stream, /api/runs or the real store.
2. Launcher (bin/wfviz.mjs): in real mode only, build replays.open from locateRun({ target: runId, root }) with the same root as the real source, createReplaySource({ runDir, speed, onEvent }) and a new createStore({ staleMs: Infinity }) per replay. Demo and --replay modes pass no replays. The idle shutdown counts a replay stream as a client.
3. Web: on a finished run (status not running) of source real, a "Replay" control with speed 1x / 4x / 20x, and while replaying: Pause / Resume (client side: stop applying events, buffer them; resume applies the buffer in order), Stop (closes the stream, returns to the real view of the run). While replaying, the view shows the replayed Run from the replay stream, from empty to final, with a REPLAY mark next to the run name and the existing replay banner style; the run picker, other runs and the real stream keep updating; switching to another run stops the replay. At the end: "replay finished" and a button to replay again. A running run has no Replay control. Errors (409, 429, 404, stream lost) are shown as a line with the reason, never a silent stop.
4. Steady UI rules (docs/guides/common.md): the replay updates by key like the live view (no whole-region rewrite); every data string escaped; localStorage only for the chosen speed (wrapped).
5. Tests: replay-endpoint.test.mjs with a fake replays and with the real one over a saved run in fixtures/claude-projects (fake timers or speed 100): headers, hello/run/event/end order, seq without gaps, 404/409/400/429, stop on client close (no timer left), real stream untouched (a client on /api/stream gets no replay event), server.close() ends replays. web-replay.test.mjs for the pure web functions (control state by run status, pause buffer order, speed parse). Update server.test.mjs only where it asserts that unknown /api paths are 404 in a way the new route changes.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0); test/integration/universal.test.mjs green.`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs; your own background tab).
1. Select finished run wf_3e37ce7f-482 (or any finished run if it is not in the list; say which). Expected: a Replay control with 1x / 4x / 20x. Select a running run if there is one: no Replay control.
2. Back on the finished run, choose 20x and Replay. Expected: REPLAY mark next to the run name, the matrix and log start empty and fill in; the run picker still lists the real runs with their real status.
3. Pause for 5 s: the view stops changing (MutationObserver on the centre view: 0 mutations). Resume: it continues from where it stopped, no event lost (log line count at the end equals the real view's event count for that run, or report both numbers).
4. At the end: "replay finished" and a replay-again button. Stop: the real view of the run returns (no REPLAY mark).
5. Start a replay and select another run: the replay stops (no further network traffic on /api/runs/<id>/replay).`,
  },
  lensA: 'server and contract: route behaviour exactly as contract §4 (codes, event shapes, seq, end), replay isolation (nothing reaches /api/stream, /api/runs or the real store — show a failing input if it does), stop on close and on server.close (timers cleared), limit of 3, real mode only, read-only (no write, no endpoint that changes a run), the launcher uses the same root as the real source, idle shutdown counts replay clients.',
  lensB: 'web: controls by run status, pause buffer order and loss, stop and run switch close the stream, REPLAY mark only on the replayed view, errors shown with the reason, steady UI (no whole-region rewrite), escaping. Start wfviz read-only with --no-open on port 0 over the real runs and drive the endpoint with curl/node (not the browser pane): compare the replayed Run at end with GET /api/runs/<id> for the same run (agents, status, recognised counts). Write nothing to disk except under evidence/tmp/ and OS temp dirs; stop only processes you started, by PID.',
};
