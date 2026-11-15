// Node U4 in graph.md. Spec for the gate template (workflows/gate/gate-template.js).
// Runs after "steady UI" (U3) is committed: both own web/.
export default {
  code: 'U4',
  name: 'web polish',
  risk: 'low',
  owns: ['web/', 'test/server/web-u4.test.mjs'],
  spec: `Web only (web/app.js, web/lib.js, web/index.html, web/style.css), on top of the current UI. Server, model and source are not yours. Every value shown comes from the Run, a UiEvent or hello; every data string is escaped; nothing about this project's development method is assumed.
Required items (logic in pure functions in web/lib.js, tested in test/server/web-u4.test.mjs):
1. Scrollbars in the theme: every scrolling area (columns, log, drawer, panels) uses scrollbars coloured from the existing CSS colour tokens (scrollbar-color + scrollbar-width: thin, and ::-webkit-scrollbar rules for WebKit), in light and dark themes alike. No system-white scrollbar on the dark theme.
2. REPLAY banner: when hello.mode is "replay" (docs/contract.md §1 "Replay"), the header mode badge says REPLAY, a banner says the run is a replay of a saved run at its own times, and the document title is "wfviz — REPLAY". REAL and DEMO stay as they are.
3. Log header count: "showing the last N of M events" counts only event lines, not the "... k events not available" marker lines; the cap is reached on 2000 event lines.
4. Failed backlog: the "backlog not loaded: <error>" notice is a line inside the log (the empty-log placeholder is not shown while it is there), stays visible when the log pane is collapsed (in its header), and the backlog is retried on the next live event or when the run is selected again.
5. Backlog after a gap: events fetched to close a gap are merged into the log in displayed-time order like the first backlog, not appended out of order.
6. Round history heading: a group with neither round nor tag is titled "round unknown" once (today "round unknown round unknown").
7. No flicker. On a live or replayed stream, an event changes only the elements of its agent, the log line it adds and the counters it changes; nothing else is rewritten (no innerHTML of a whole region, no re-created matrix, timeline or side column). Check what the previous node left in web/app.js and remove every remaining whole-region rewrite on events; test the patch plan in web-u4.test.mjs.
8. Run picker instead of the native select at the top: a dropdown in the page's own style (colours, fonts, borders from the theme tokens; keyboard: arrows, Enter, Esc; closes on outside click). Each row: run name (or the id with "(no name)"), status badge, start time, agent count, source (real/demo/replay) — all from the run list the server gives.
9. Search in the picker: a text field filters rows by name and id (case-insensitive substring), the match highlighted; empty result says "no run matches".
10. Live list: a run that appears or changes status while the page is open shows up in the picker and its row updates without a reload (from the existing SSE run snapshots / run list; no polling timer). The selected run never changes by itself.
11. Universality (AGENTS.md Hard rules): web/ still carries this project's method. Rename the colour variables named after our gate roles (--impl, --rev, --judge, --fix, --test and their uses, e.g. PALETTE in app.js, '--c:var(--judge)') to neutral slots (--c1..--c9) assigned to roles in order of appearance; verdict styling must not depend on the values 'accept' or 'fix' (style a verdict tag neutrally, or by a slot assigned per distinct value); drop node-code and spec-item comments ("Node U2", "(item N)") from web/. Add a test in web-u4.test.mjs that scans web/ for CSS custom properties or classes named after these role or verdict words and fails on any.
12. Wide matrix: the centre column scrolls horizontally (overflow-x: auto) when the matrix is wider than it, instead of clipping role columns; long role names in the left column wrap (min-width: 0, overflow-wrap: anywhere), never cut.
13. Keyboard focus: the unit history toggle in a matrix row keeps keyboard focus across toggles and live updates (its own keyed element; only the label text is rewritten).
14. Hidden rows: the tests card says "showing N of M" when it shows fewer rows than the run has, and offers the rest (expand), so rows like "label · summary k of n" are reachable.
15. Elapsed time of a replay or finished run: "now minus start" is wrong for source "replay" (the run happened earlier); show the run's own duration from its times (end, else the last event ts) for replay and final runs; the 1 s clock ticks only for a live running run of source real.
Keep every existing test in test/ green.`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 --replay wf_295edfee-cb2 --speed 20 (a saved real run with 42 agents, replayed from ~/.claude/projects).
1. Open the page as soon as the server is up. Expected: header badge REPLAY, a banner saying it is a replay of a saved run, document.title "wfviz — REPLAY".
2. Select run wf_295edfee-cb2 if not selected. Install a MutationObserver on document.body (childList, subtree, characterData, attributes) and record for 20 s while events stream: count mutations per top-level region (header, left column, centre view, right column, log) and list every element that was removed and re-added with the same content. Expected: removals/re-additions only for elements whose data changed; no region re-created as a whole; the log only appends. Report the counts.
3. Expected: the log pane is in the viewport without page scroll; the right column scrolls inside itself when its content is taller than the viewport.
4. Expected: getComputedStyle of the columns and the log gives a scrollbar-color from the theme (not "auto"), in both light and dark themes (toggle the theme if the page has a toggle, else check prefers-color-scheme rules in style.css).
5. Expected: no CSS custom property or class on the page named after gate roles or verdict values (inspect document.styleSheets for --judge, --fix, --impl, --rev, .accept). The elapsed time in the header equals the run's own duration and does not tick.
6. Open the run picker: expected a themed dropdown (not the native select), a search field; type part of a run id: rows filter. Press Esc: it closes.
7. When the replay has ended: expected the log header says "showing the last N of M events" with N equal to the number of event lines in the log (marker lines not counted).`,
  },
  lensA: 'contract fit and UI rules: scrollbars use theme tokens in both themes; REPLAY shown only for hello.mode "replay"; log count and cap exclude marker lines; failed-backlog notice is a log line, visible when collapsed, retried; gap backlog merged in displayed-time order; every value from Run/UiEvent/hello; every data string escaped; no interval timers added.',
  lensB: 'behaviour: start wfviz read-only with --no-open on port 0 over the real project runs, fetch the page and the scripts, run the web/lib.js functions in node for items 3-6 on real data (wf_295edfee-cb2) and synthetic cases (2500 events with a gap marker, failing backlog fetch); check the new tests are real. Do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
};
