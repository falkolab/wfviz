// Node L3 in graph.md: wider side panels by default, and more of the page remembered locally (user, 2026-11-15/16).
export default {
  code: 'L3',
  name: 'layout memory',
  risk: 'low',
  owns: ['web/', 'test/server/'],
  spec: `Web only (web/app.js, web/lib.js, web/style.css, web/index.html). Server, model and source are not yours.
1. Default side panel widths: twice today's (left 240 -> 480 px, right 300 -> 600 px), keeping their 4:5 ratio, but the centre column never gets less than half of the grid's width: when 480 + 600 would leave the centre under 50%, both side panels shrink together in the same 4:5 ratio (at a 1440 px window: about 320 / 720 / 400; at 2560 px: 480 / centre / 600). This applies to the default only: a width the user dragged and that is stored (layout.left / layout.right) still wins, clamped by the existing limits. The narrow one-column layout (the existing @media rule) is unchanged. Recompute on window resize without a whole-page re-render.
2. Remember locally (localStorage, through localGet/localSet, every read and write wrapped as today, an untrusted stored value falls back to the default):
   a. the last opened run: on load, when the address has no run and the run is in the list, open it; a run that is gone is ignored silently;
   b. the run list filters (range, project, status, from, to, text): the address hash still wins; with no hash, the stored filters are applied and written to the hash;
   c. per run: expanded matrix rows, the tests card expanded, and the weak-edges switch; keep at most the 50 most recent runs (drop the oldest).
3. A "Reset layout" item (a small button in the header next to "Tracking hint", or inside an existing settings place if one exists) clears every wfviz.* key this page stores (layout sizes, log collapsed, view, replay speed, hint closed, and the new keys) after a confirm() and reloads the page.
4. Steady UI rules (docs/guides/common.md): no whole-region rewrite, escaping, no new timers beyond what is needed (resize handling may use one requestAnimationFrame).
Tests in test/server/: the default width function (pure, in lib.js) at 1440, 1920, 2560 and a width where the centre rule binds, ratio 4:5 kept, stored widths win; stored-state parse with bad values; filters from storage only when the hash is empty; per-run memory capped at 50; reset clears exactly the wfviz.* keys. Update shared tests that pin the old defaults or counts with the same intent and say which.
Work in short steps; run node --test test/server/ while working and npm test once at the end. Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 --since Infinity --root fixtures/claude-projects (your own background tab, fresh profile).
1. At 1440x900 and 2560x1440: report left / centre / right widths. Expected about 320/720/400 and 480/1480/600; centre >= 50% at both.
2. Open run probe-edge-cases, expand a matrix row, set the list filter to status failed. Reload the page with the bare address (no hash). Expected: the same run opens, the row is still expanded, the filter is back.
3. Drag the left panel to 300 px, reload: 300 px kept. Press Reset layout and confirm: widths back to the defaults of step 1, the hint shows again.`,
  },
  lensA: 'width rule exactly as the spec (give a window width where the centre falls under 50% or the 4:5 ratio breaks), stored widths win, narrow layout unchanged; remembered state read safely (bad values fall back), hash wins over stored filters, per-run memory capped, reset clears only wfviz.* keys; steady UI, escaping; tests real (fail on the old behaviour). Run pure functions in node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
