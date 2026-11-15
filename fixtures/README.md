# Fixtures

`claude-projects/` mirrors `~/.claude/projects/<slug>/<session>/` and holds **real** runs,
copied with `node tools/make-fixture.mjs <session-dir> <runId>` (transcripts trimmed to
user/assistant/structured_output records; thinking blocks dropped; secrets scrubbed).

| runId | Claude Code | shape | notes |
|---|---|---|---|
| wf_6509ce25-20a | 2.1.306 | 2 parallel → judge → 2-round loop | completed; probe 1 |
| wf_26eb8d70-5c4 | 2.1.306 | pipeline 3×2 (overlap) + parallel; a stage throws, a thunk throws, script throws | failed; probe 2 |

`synthetic/legacy-2.1.206/` is **synthetic**: values are invented, the record shapes copy what
was observed in a real 2.1.206 run in another project (journal `started` without label/phase,
meta with only agentType/spawnDepth). That real run is not copied here (other project's data);
`test/source` may read it in place, read-only, and skips if it is absent.

Only data that wfviz's own tests read lives here. The inputs of the demo workflows A and B
(`target-a`, `target-b`) are demo data, not wfviz fixtures: they live in `demo/targets/`.
