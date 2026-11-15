// Node H1 in graph.md: an optional hint in the page on how to make a workflow easier to track, with a
// button that copies a ready prompt for the agent (user, 2026-11-10). The ordinary run is shown as today;
// the hint is advice and never a requirement (graph.md §9 "Two modes of tracking").
export default {
  code: 'H1',
  name: 'tracking hint',
  risk: 'low',
  owns: ['web/', 'test/server/web-hint.test.mjs'],
  spec: `Web only (web/app.js, web/lib.js, web/index.html, web/style.css). Server, model and source are not yours. Nothing that is shown today changes; nothing is fetched from the network; nothing is written to disk.
What to build:
1. A service notice in the bottom-right corner, shown when the page opens: title "Better tracking (optional)", one line "wfviz shows any run as it is. If you write the workflow, these conventions let it show more.", a read-only box with the prompt text below, a "Copy prompt" button and a close button (x). It does not cover the log pane's header or the drawer: place it above the log pane, max-width 420px, scroll inside if taller than 50% of the viewport.
2. Copy: navigator.clipboard.writeText when available; otherwise select the text in the box and document.execCommand('copy'). The button then says "Copied" for 2 s, or "Copy failed — select the text" on failure. The exact prompt text is copied (no HTML, no trailing changes).
3. Closing hides the notice and remembers it in localStorage key "wfviz.hint.closed" (reads and writes wrapped in try/catch, like localGet/localSet in app.js; without storage the notice shows on each load). A small header button "Tracking hint" always reopens it; Esc closes it when focus is inside it. Keyboard reachable; role="dialog" not modal (no focus trap), aria-label set.
4. The notice is independent of the run data: shown in REAL, DEMO and REPLAY modes, with or without runs, and it never changes because of events (no re-render on SSE; steady UI rules in docs/guides/common.md).
5. The prompt text lives as one exported constant in web/lib.js (TRACKING_PROMPT) and is exactly:
---
Optional conventions so wfviz (a local viewer of Dynamic Workflow runs) can show this workflow in more detail. Use what fits; skip what does not. None of this is required: the workflow must work the same without it.
- Agent labels: "<role>:<unit>", with "#r<n>" for a repeat round, e.g. "writer:intro", "writer:intro#r2". wfviz then draws a role x unit matrix.
- Phases: pass a phase to each agent, so agents group by stage.
- Results as JSON objects:
  - problems found: an array "findings", each item { "file", "line", "severity", "description", "input" } (any subset; "file" helps most);
  - a decision: a string field "verdict", with an optional "reason";
  - test counts: an object "tests" with numeric "passed", "failed", "skipped".
- The workflow's own return value: put the run totals there, e.g. one "tests" object, so wfviz shows them as the run total.
- log() a short line when a phase starts or ends.
---
Keep the text in sync with docs/contract.md §2 (label pattern) and §3 (recognised fields): a test in test/server/web-hint.test.mjs checks that every field name the prompt mentions ("findings", "file", "line", "severity", "description", "input", "verdict", "reason", "tests", "passed", "failed", "skipped") appears in docs/contract.md §3, and that parseLabel from src/model/labels.mjs gives role "writer", unit "intro", round 2 for "writer:intro#r2" (import read-only; do not change src/).
6. Tests in test/server/web-hint.test.mjs (pure functions in web/lib.js where logic exists, e.g. hintInitiallyOpen(storedValue)): text constant exact; the sync check above; opening state with stored "1", null, and a throwing storage; index.html has the notice and the header button; the copy fallback path is chosen when navigator.clipboard is absent (pure decision function).
7. Universality: test/integration/universal.test.mjs and the universal scans in test/server/web-u4.test.mjs stay green (the prompt names no role, verdict or file of this project's method).
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs). Use your own background tab; clear localStorage key "wfviz.hint.closed" first.
1. Open the page. Expected: the notice "Better tracking (optional)" in the bottom-right corner, above the log pane, not covering the log header; the prompt box shows the text starting "Optional conventions so wfviz".
2. Click "Copy prompt". Expected: the button says "Copied" (or the failure text if the tab has no clipboard permission — report which), then returns to "Copy prompt" after about 2 s.
3. Select a run and wait 15 s while it updates (if one is live). Expected: the notice stays, its text node is not replaced (MutationObserver on the notice: 0 mutations except the button label).
4. Click x. Expected: notice hidden. Reload. Expected: still hidden. Click the header button "Tracking hint". Expected: notice shown again. Press Esc with focus inside: hidden.
5. Narrow the window to 800 px wide. Expected: the notice fits inside the viewport, no horizontal page scroll.`,
  },
  lensA: 'contract fit: the prompt text exact and in sync with contract §2/§3 (every field it names is recognised; the label example parses as stated); the hint is advice only (no change to what is shown, no requirement); localStorage reads/writes wrapped; nothing fetched or written; no role, verdict or file name of this project in web/ (universal scans); escaping of anything inserted as HTML.',
  lensB: 'behaviour: start wfviz read-only with --no-open on port 0 over real runs, fetch the page and scripts, run the web/lib.js functions in node (text, open state with throwing storage, copy fallback decision); check the notice markup does not overlap the log pane header by CSS reading; no re-render on events; new tests are real (fail on a wrong text). Do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
};
