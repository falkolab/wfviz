// Node P3a in graph.md: three leftovers of P2 (workflow 17), split out of P3 after two implementers of workflow 18 lost the
// connection mid-response (user, 2026-11-12: "two small tasks"). Runs before P3 search; both own web/ and server.mjs.
export default {
  code: 'P3a',
  name: 'cost leftovers',
  risk: 'low',
  owns: ['src/server/server.mjs', 'web/', 'test/server/'],
  spec: `Read docs/contract.md §2 (Agent.byModel) and §4 GET /api/prices (the demo sentence is new), and docs/guides/agent-tokens.md.
The working tree already holds partial work from workflow 18 (uncommitted): code for these three items AND code for full-text search (GET /api/search, createSearch, searchItems, highlightParts, notSearchedLine in web/lib.js and web/app.js, the search box in index.html). Search is a later node: leave its code as it is (do not remove, finish or review it), unless it breaks a test; then make the smallest change that keeps it inert and say so in your note.
Your items:
(a) GET /api/prices answers 404 { error: "not found" } in mode demo before anything else; the page shows no cost line for a Run with source "demo" and never asks for prices on its account.
(b) Agent.byModel / totals.byModel: tokens of a message with no model id are in usage but not in byModel. A cost shown as a total says what it leaves out ("~ $X, without N tokens of messages with no model") in its text and method.
(c) web/style.css: the rule ".report .cost .v" matches nothing (the cost cell's classes are "cell-r wide"): make the intended style apply.
Check what the tree already does for each item, keep what is right, finish the rest, and test: prices 404 in demo (and no fetch); no cost line and no prices request for a demo Run; the "without N tokens" note in text and method; the cost cell style applies (selector matches the cell).
Work in short steps and run node --test test/server/ while working; run npm test once at the end. Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  lensA: 'only items (a), (b), (c): demo answers 404 before any fetch, no cost line and no price request for a demo Run, the left-out tokens stated in the cost text and method (give a usage/byModel pair where they are not), the style applies, tests real (fail on the old behaviour). Ignore the search code in the diff (a later node), except where it breaks a test. Run pure functions in node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
