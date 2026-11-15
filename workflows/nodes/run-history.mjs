// Node P1 in graph.md: run history across projects and ages (user, 2026-11-11: default 24 h with a switch to all).
// Contract §4 GET /api/runs (every run, `loaded`) was changed for this before the node.
export default {
  code: 'P1',
  name: 'run history',
  risk: 'high',
  owns: [
    'src/source/claude-fs.mjs', 'src/server/server.mjs', 'bin/wfviz.mjs', 'web/',
    'test/source/', 'test/server/', 'test/integration/',
  ],
  spec: `Read docs/contract.md §4 GET /api/runs (the P1 paragraph is new), §1 and §5 (createClaudeFsSource), docs/plugin-stage-draft.md "P1", sources/event-sources.md. src/model/ is not yours: use reduce/createStore as they are; list needed model changes in your note.
Measure first (read-only, script under evidence/tmp/): on ~/.claude/projects count project dirs, session dirs, run dirs, and the time of (a) today's start with --since 24 h, (b) a start that lists every run from journal + final file + script only, (c) a start that loads every run in full. Record the numbers in the guide and your note. Also count the directories a watcher would need for (b).
1. Source (src/source/claude-fs.mjs): an index of every run under the root, any age, built from journal, final file and script file only (no transcript read), emitting the same RawEvents those files give today (no new event kinds, no invented values). Runs within sinceMs are loaded and watched as today. A new method loadRun(runId) -> Promise reads one listed run in full (transcripts), emits its events once, then watches it like a recent run; a second call is a no-op. New run dirs anywhere under the root are picked up as today. Keep the watcher cost bounded: do not watch transcripts of runs that are not loaded.
2. Server: GET /api/runs lists every run with loaded: true/false (contract §4). GET /api/runs/:id of a run not loaded awaits source.loadRun (one load at a time per run; errors -> 500 JSON with the reason) and then answers the Run. /api/stream sends run snapshots of loaded runs only (a listed-only run appears through the run list, which the UI refreshes on its existing triggers). Demo and replay modes unchanged.
3. Launcher: --since keeps its meaning (which runs are loaded at start); the help text says so. No new flag needed.
4. Web: the run picker shows the last 24 h by default and a switch "all"; filters by project (decoded dir name as on disk, never prettified), status, date range (from/to) and a text filter on name; the state lives in location.hash (survives reload; invalid hash values ignored with defaults). A listed-only run shows "not loaded - opens on click"; selecting it loads it (spinner text, errors shown as a line with the reason). Steady UI rules (docs/guides/common.md): picker updates by key, no whole-list rewrite on every event; escaping.
5. Tests: source index over fixtures with two project dirs and an old run (mtime set back): listed, not loaded, no transcript opened (spy on fs or count reads); loadRun emits the transcript events once; the server list and lazy GET; hash parsing; integration test universal.test.mjs green. Update tests that assert the old list (only runs within since) with the same intent.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs; your own background tab).
1. Open the page. Expected: the picker shows runs of the last 24 h; a switch "all" exists. Report the counts with 24 h and with all, and the time from click to the list on "all".
2. Switch to all, filter by one project and by status completed: only matching runs listed; reload: same filters (hash).
3. Click a run older than 24 h (not loaded). Expected: it opens with agents and log; report the time to open.
4. Type part of a run name in the text filter: the list narrows; clear it: the list returns.`,
  },
  lensA: 'source and server: every run listed with provenance kept, nothing read from transcripts for listed-only runs (show a read if there is one), loadRun idempotent and concurrent-safe, watcher cost (count watched dirs before/after on the real tree, read-only), /api/stream untouched for listed-only runs, lazy GET errors as JSON, demo/replay unchanged, read-only, universality.',
  lensB: 'web and behaviour: start wfviz read-only with --no-open on port 0 over the real runs; check /api/runs counts against a count of run dirs; GET an old run and compare it with a --since Infinity server answer for the same run (agents, status, recognised counts); picker filters, hash round-trip and invalid hash; no whole-list rewrite; escaping of project names. Do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs; stop only processes you started, by PID.',
};
