// Node L2 in graph.md: one wording low from L1 (user, 2026-11-15: "ок правь").
export default {
  code: 'L2',
  name: 'agents plural',
  risk: 'low',
  owns: ['web/', 'test/server/'],
  spec: `Web only. In web/lib.js the run cost text reads "~ $X for k of n agents" even when n is 1 ("for 0 of 1 agents"); agentsNote next to it already handles the singular. Make the word follow n ("of 1 agent", "of 2 agents") in the cost text and its method, the same way agentsNote does (reuse its rule; do not add a second plural helper). Add tests for n = 1 and n = 2 in test/server/web-tokens.test.mjs; keep the existing "0 of 2" test. Nothing else changes.
Run node --test test/server/ while working and npm test once at the end. Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  lensA: 'the word follows n in text and method, one plural rule shared with agentsNote, tests real (fail on the old wording), nothing else changed. Run pure functions in node; do not use the browser pane. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
