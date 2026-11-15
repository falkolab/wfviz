// Node P3 in graph.md: full-text search over the loaded runs (contract §4 GET /api/search, new). After P1, P2 and P3a (the P2 leftovers, split out on 2026-11-12).
export default {
  code: 'P3',
  name: 'run search',
  risk: 'low',
  owns: ['src/server/server.mjs', 'web/', 'test/server/'],
  spec: `Read docs/contract.md §4 GET /api/search (new) and docs/plugin-stage-draft.md "P3". Source and model are not yours (read the store as it is).
The working tree may hold partial search code from workflow 18 (two implementers lost the connection): the server handler and pure functions in src/server/server.mjs, createSearch / searchItems / highlightParts / notSearchedLine in web/lib.js, parts of web/app.js and the search box in web/index.html. Read it, keep what is right, finish the rest. Work in short steps; run node --test test/server/ while working and npm test once at the end.
1. Server: GET /api/search?q=&limit= exactly as §4: over the loaded runs' Run models (agent prompts, results, activity summaries and texts, log lines, run name and description); case-insensitive with Unicode case folding (final sigma, German sharp s, Turkish dotted i: correct, or listed as a known limit); excerpt of about 120 chars around the match with start/end offsets into the excerpt; limit default 50, max 200; time budget 500 ms; over either -> more: true. Empty q -> 400. Read-only.
2. Web: a search box in the header; results list (run, agent label, field, excerpt with the match highlighted - escaped text, highlight by DOM ranges, never by inserting HTML); clicking opens the run and the agent drawer at that field (or the log line). Esc clears. Debounce 250 ms; a newer query cancels an older one (AbortController).
3. Tests: matching and folding, limit and more, time budget with a fake clock, escaping of excerpts with markup, abort of an older query (pure web functions).
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  ui: {
    scenario: `Command: node bin/wfviz.mjs --no-open --port 0 --idle 0 (real runs; your own background tab).
1. Type a word that appears in an agent prompt of a loaded run. Expected: results within 1 s with the match highlighted.
2. Click a result: the run opens and the agent drawer shows that field.
3. Type a string with <b> in it: no markup is rendered in the results.`,
  },
  lensA: 'server: fields searched, folding, limit, time budget, more flag, empty q, read-only; web: escaping and highlight without HTML insertion, abort of older queries, steady UI. Run the server read-only with --no-open on port 0 and query it with curl/node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs; stop only processes you started, by PID.',
  lensB: 'same as lensA',
};
