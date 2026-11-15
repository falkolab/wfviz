// Node U5 in graph.md: even matrix cells. Reported by the user on 2026-11-09 from a screenshot of
// workflow 8 (row "web-polish": cells of one row have different heights, "done" tags touch each other).
export default {
  code: 'U5',
  name: 'matrix cells',
  risk: 'low',
  owns: ['web/style.css', 'web/app.js', 'web/lib.js', 'test/server/web-u5.test.mjs'],
  spec: `Web only, on top of the current UI. Server, model and source are not yours. Every value shown comes from the Run; nothing about this project's development method is assumed.
Defects seen on a real run (a matrix row whose unit has 15 agents with tags #prep #impl #full #rule-full #after-fix #v1 #rule-v1 #v2 #rule-v2):
1. Cells of one matrix row have different heights: .matrix sets align-items: center, so each cell is as tall as its content (one agent: short; four agents with tags: tall), and the row label is taller again. Required: every cell of a row and its row label share the row's height (the tallest of them); content stays centred inside the cell. Header cells keep their own alignment.
2. In a cell with several agents, each line "#tag state" is cramped: the state tag (e.g. "done") touches the tag of the next line above and below (gap 1px, line-height 1.15, tag padding 0). Required: lines separated vertically so tag borders never touch (at least 2px between bordered tags), a space between the agent tag and its state tag, the state tag with its own inner padding like .tag elsewhere.
3. Row label: the unit name breaks inside a word at a hyphen ("web-" / "polish") because overflow-wrap: anywhere applies to it and the agent tags follow it inline. Required: the unit name breaks only where it does not fit in the column at all; the agent tags of the label go on their own line(s) below the name, wrapping between tags, never inside one tag ("#rule-" / "full" is wrong).
4. A test in test/server/web-u5.test.mjs checks the CSS rules that give 1-3 (row alignment stretch for cells and labels, spacing of the agent lines, no anywhere-break inside a tag) and that the matrix markup still keys each cell by unit and role.
Keep every existing test in test/ green; no change in what is shown, only in layout.`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 --replay wf_5eb8ed36-03f --speed 50 (the saved real run where the defect was seen; its row "web-polish" has 15 agents).
1. Open the page in a 1440x900 viewport, select the run if not selected, wait until the replay ends. Expected: in every matrix row, all cells (class cell) and the row label have the same getBoundingClientRect().height (±1 px). Report the heights per row.
2. Expected: in the cell with several agents, no two bordered tags overlap or touch vertically (bottom of one < top of the next - 1 px); report the gaps.
3. Expected: the row label shows "web-polish" on one line when the left column is 240 px or wider; no agent tag is split across lines.
4. Also report, on a replay of wf_295edfee-cb2 at speed 20 for 20 s: the header badge says REPLAY; the log pane bottom is inside the viewport with no page scroll; no matrix row, side column or log is re-created as a whole (MutationObserver: count removed-and-re-added elements with the same content).`,
  },
  lensA: 'CSS and markup: the row height rule covers cells, row labels and fallback rows but not header cells; spacing works for one-agent and many-agent cells; no data string newly unescaped; no interval timer added; universality (no role, label or tag of this project assumed).',
  lensB: 'behaviour: start wfviz read-only with --no-open on port 0 with --replay wf_5eb8ed36-03f, fetch the page, styles and scripts, and check by reading the computed rules that 1-3 hold; check the new test fails on the old style.css. Do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
};
