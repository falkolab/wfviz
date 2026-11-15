// Node R1 in graph.md: two gaps in what wfviz recognises, found in N10 acceptance on the live run of
// workflow A wf_3e37ce7f-482 (checks.md C5):
// (1) a judge reported a bug in an array named "missed"; recognition knows only findings/issues/problems,
//     so the one finding that caused a fix is visible only as raw JSON in the judge's drawer;
// (2) the report card shows "tests: last of 8 reports" = 10 pass, while the run's own result says 28 pass;
//     the last report is whichever agent finished last, not a run total.
// Contract §2 and §3 change with this node (user approval required before the run; see progress.md).
export default {
  code: 'R1',
  name: 'result recognition',
  risk: 'high',
  owns: [
    'src/model/recognize.mjs', 'src/model/reduce.mjs', 'web/lib.js', 'web/app.js',
    'test/model/recognize.test.mjs', 'test/server/web-lib.test.mjs', 'test/model/run-result.test.mjs',
  ],
  spec: `Model and web. Source and server are not yours. wfviz is universal (AGENTS.md hard rules): no field name, role, label or result shape of this project's workflows may be required; what is recognised must follow from generic rules over any run's data, and a run without these fields must look exactly as today.
Observed facts (sources/event-sources.md and the local runs): the final file workflows/<runId>.json has a top-level "result" (any JSON; null for a failed run; 18 of 20 local runs have an object). Agent results are in journal "result" lines.
1. Run-level result. Add Run.result: Fact — the final file's "result", prov "final" with from; unknown with a reason while running or when the final file has none ("result" null or absent: say which). Contract §2 gets this field.
2. Recognition also runs over Run.result with the same rules and limits as agent results. Items from it carry scope "run" and agentId null; items from agents carry scope "agent". Nothing else changes for agent items.
3. Findings by shape (contract §3, added rule): besides arrays named findings / issues / problems, an array under ANY other key whose every item is an object that has "file" and at least one of "line", "severity", "description", "input" is recognised as findings, method "shape:file+<keys present>" (prov inferred). An empty array or an array with one non-matching item is not. Before writing the rule, measure it on every local run (read-only, a script under evidence/tmp/ or a test helper): count arrays matched by name, matched by shape only, and list the key names matched by shape only with one example each; record the counts in the guide and in your note. Matches that are not findings (false positives) on real runs must be 0; if not, tighten the rule and say how.
4. Report card tests (web/lib.js reportCard and its render): drop "last of N reports". If Run.result yields exactly one run-scope tests item, the card shows it as the run total (passed/failed/skipped/todo, prov inferred, from the final file, method of the item). Otherwise the card shows the number of per-agent reports and "no run-level total" as unknown with the reason (none, or several run-scope items). Findings and verdicts counts on the card count agent-scope items only; run-scope items are listed separately as "in the run result: N findings, M verdicts, K tests" when present.
5. The TESTS card and the findings / verdicts panels mark run-scope items as coming from the run result (not from an agent); clicking one opens the run result JSON (raw, escaped), not an agent drawer.
6. Tests: recognize over a run result (scope, agentId null, from); shape rule positive (key "missed" as in A's judge result, key "bugs") and negative (items without file; file only; mixed array; empty); a run without final file has Run.result unknown with reason; report card with one run total, with none, with two; existing tests that asserted "last" are updated to the new rule (they are in owns). A fixture-level test on the saved real runs in fixtures/claude-projects: no change in agent-scope findings counts.
Keep every other test green (npm test exit 0, fail 0, skipped 0, todo 0); test/integration/universal.test.mjs green.`,
  lensA: 'model and contract: Run.result provenance (final, from, unknown reasons) and its absence while running; recognition over the run result keeps limits (depth, hops) and scope; the shape rule — show a real-run array it wrongly matches or a finding-shaped array it misses (run the measurement yourself on ~/.claude/projects, read-only); no field name of this project hard-coded (grep for missed, bugs, judge, review); agent-scope counts unchanged on fixtures.',
  lensB: 'web: report card and panels with run-scope items — run total shown only from exactly one run-scope tests item, the unknown reasons otherwise; nothing invented when Run.result is unknown; escaping of run result JSON; no full re-render added (steady UI rules in docs/guides/common.md); start wfviz read-only on port 0 with --no-open --replay wf_3e37ce7f-482 and check by fetching /api/runs/<id> that the card data give 28 pass and the judge missed finding is listed; do not use the browser pane.',
};
