// Node L1 in graph.md: four small page defects left as lows by P3a and P3 (user, 2026-11-15: "доделай мелочи").
export default {
  code: 'L1',
  name: 'ui lows',
  risk: 'low',
  owns: ['web/', 'test/server/'],
  spec: `Web only (web/app.js, web/lib.js, web/style.css, web/index.html). Server, model and source are not yours. Read docs/guides/run-search.md and docs/guides/cost-leftovers.md.
1. Search status line: today the "searching..." line is added above the result rows and removed again on every query, so the rows jump by about 28 px on each keystroke. Keep the rows still: the status line keeps its space (fixed height, text changed in place) or the busy state is shown without moving the rows. No whole-list rewrite (steady UI rules, docs/guides/common.md).
2. At 375 px wide, the tracking hint panel (#hint, open by default on a fresh profile) covers the search hit notice (#search-hit-*) after a click on a run-level hit, so the notice cannot be read or closed. Make the notice usable: it stacks above the hint, or the hint closes when a hit notice opens (do not change what is stored for the hint unless the user closed it). Check at 375, 800 and 1228 px.
3. Run cost: when only some agents of the Run have a known usage, the cost line reads as the cost of the whole Run. Count, from Run.agents, the agents whose usage is known and all agents; when they differ, the cost text says so ("~ $X for k of n agents, ...") and the method says the others have no usage in the run files. When all have usage, the text is as today.
4. agentNeedsPrices(agent) called without its Run counts the agent as not demo (fails open): make the Run argument required for the decision — without a Run, no prices are asked for and no cost is shown for that agent; update callers and tests.
Tests (test/server/): the status line node is kept and the first result row does not move (fake page: same element, no insert/remove around the rows); notice stacking or hint closing (by the rule you chose); "k of n agents" in text and method, absent when all agents have usage; agentNeedsPrices without a Run is false. Update shared tests that pin the old behaviour with the same intent and say which.
Work in short steps; run node --test test/server/ while working and npm test once at the end. Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 --since Infinity (real runs; your own background tab, fresh profile so the tracking hint is open).
1. Type a word into search that has results, then type one more letter. Expected: the first result row does not move while the new query runs (report its top before, during and after).
2. At 375x700: click a run-level search hit (run name or description). Expected: the hit notice is readable and its close button works (elementFromPoint on the close button returns it).
3. Open a run where some agents have no usage (or report that none exists and which run you checked). Expected: the cost line says "for k of n agents".`,
  },
  lensA: 'rows do not move (give a sequence of keystrokes where they do), notice usable at 375 px with the hint open, "k of n agents" counted from Run.agents and stated in text and method, agentNeedsPrices fails closed without a Run, steady UI (no whole-region rewrite), escaping, tests real (fail on the old behaviour). Run pure functions in node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
