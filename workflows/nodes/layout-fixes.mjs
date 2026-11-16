// Node L4 in graph.md: three lows left by L3 layout memory (user, 2026-11-16: "Да, исправить").
export default {
  code: 'L4',
  name: 'layout fixes',
  risk: 'low',
  owns: ['web/', 'test/server/'],
  spec: `Web only (web/app.js, web/lib.js). Server, model and source are not yours. L3 (layout memory) is in place; fix three things it left.
1. Start run. Today the first page opens the run of the last visit before a running one (web/app.js, the block after renderRunPicker() in the
   run-list load, "it beats the running one"). New order: a loaded run whose status is running first (when several, the same one today's code
   picks among running runs); else the remembered last run when the list still has it; else the first loaded run. An address that names a run
   still wins over all of this. Put the choice in a pure function in lib.js (input: the run list items and the remembered id; output: the id or
   null) and use it in app.js.
2. Centre at least half, for every width, not only the default. Today clampLayout (web/lib.js) lets the two side columns take everything but
   CENTER_MIN (240 px), so a wide width stored on a big screen squeezes the centre to 240 px on a laptop. New rule in clampLayout: the two side
   columns together never take more than half of the width minus the two handles (the same bound defaultColumns uses), on top of the existing
   limits. Stored widths (no prefer) that exceed it shrink together in proportion to their own sizes; a drag (prefer = the dragged column) stops
   where the centre would fall under half, the other column unchanged when it fits. COLUMN_MIN (160) still wins when the window is too narrow
   for both rules (the narrow one-column layout under the existing @media rule is unchanged). Recomputed on window resize as today.
3. The last run is remembered only after it loaded: today selectRun writes lastRun before the request; write it when the run's data arrived
   (run not null) for the selection that is still current (token === state.sel), and never for a replay on show.
4. Columns do not stretch to the whole centre (user, 2026-11-16). With the wider centre, the matrix columns (web/app.js renderMatrix sets
   grid-template-columns "minmax(120px, 1.4fr) repeat(N, minmax(44px, 1fr))") and the phase lanes (web/style.css .lanes grid-auto-columns
   "minmax(180px, 1fr)") spread over the whole centre. New: each column has a maximum width and the grid packs to the left (justify-content:
   start), so spare room stays empty on the right: the unit column at most 280 px, each role column at most 160 px, each phase lane at most
   360 px. Minimums unchanged; a centre too narrow for the minimums scrolls as today. Put the matrix template string in a pure lib.js function
   (role count -> string) so it is testable. The narrow one-column layout keeps working.
Steady UI rules (docs/guides/common.md) hold. Update the comments that describe the old behaviour.
Tests in test/server/ (add to web-layout-memory.test.mjs or a new file): the start choice (running beats remembered; remembered beats first
loaded; a remembered run gone from the list is ignored; no loaded run gives null); clampLayout at 1440 and 1280 with stored 700/800 (centre >=
half, ratio of the stored widths kept), a drag at 1440 stopping at half, the 160 px minimum at a narrow width; lastRun not written for a run
whose load failed (a source-level or pure-function check is fine); the matrix template has the maxima and style.css .lanes has its maximum and
justify-content: start. Shared tests that pin the old start order or the old clamp: test/server/
web-layout-memory.test.mjs, web-u3.test.mjs, web-replay.test.mjs; update them with the same intent and say which.
Work in short steps; run node --test test/server/ while working and npm test once at the end. Keep every other test green (npm test: exit 0,
fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 --since Infinity --root fixtures/claude-projects (your own background tab, fresh profile).
1. At 2560x1440 open run probe-edge-cases. Report the centre width, the matrix width actually used (rightmost cell edge minus the first cell's left edge) and each matrix column width; expected: unit column <= 280, role columns <= 160, empty room on the right.
2. Switch to the phases view (or wherever lanes show): each lane <= 360 px, lanes packed to the left.
3. In localStorage set wfviz.layout.left = 700 and wfviz.layout.right = 800, resize to 1440x900, reload: the centre column is at least half of the grid width; report the three widths.
4. At 375x800: the one-column layout still shows the matrix without overlap.`,
  },
  lensA: 'columns of item 4 capped and packed left (give a role count or width where a column grows past its maximum); start choice exactly as the spec (give a run list where the wrong run opens); centre >= half of the width for stored and dragged widths at any width >= the narrow breakpoint (give a width and stored sizes that break it), COLUMN_MIN still wins when too narrow, stored ratio kept; lastRun written only after a successful load of the current selection; steady UI; tests real (fail on the old behaviour). Run pure functions in node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
