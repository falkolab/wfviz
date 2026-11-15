# Post-mortem: how development was managed (runs 1 and 2)

Date: 2026-11-08. Facts from `wf_9eae66f4-69f` (run 1, stopped) and `wf_e2c4ea40-b0b` (run 2).

## Numbers

| run | agents | duration | subagent tokens | outcome |
|---|---|---|---|---|
| probes 1–2 | 11 | 27 s | 0.62 M | formats observed |
| run 1 | 73 (stopped at 66 done) | 72 min | 10.5 M (final file) | all nodes would end `blocked` by a gate bug; code good, 496 tests |
| run 2 | 26 | 93 min | 3.1 M | N7 pass, N3/N9 blocked on 1–2 medium, I1 pass; 554 tests |

## Errors, consequence, fix

| # | error (mine unless noted) | consequence | fix for next time |
|---|---|---|---|
| 1 | Gate parsed `# pass N`; Node 26 prints `ℹ pass N`. Gate never tested on real output | run 1 could not accept any node; verdicts worthless | run every gate once on one real node before fan-out (the author's "trial run on 3 files" step, which I skipped) |
| 2 | Judge schema lacked `additionalProperties:false`; smoke test had it, script did not | codex judge failed, Opus fallback, extra cost | same trial; reuse the exact smoke-tested schema |
| 3 | Stop rule "zero findings" with reviewers told to find faults; full re-review each round | non-convergence; N9 ran 3 full rounds on edge cases | severity gate + diff-only verification (applied in run 2: worked) |
| 4 | Judge called on disagreement while the two reviewers had different lenses by design | judge fired in 13 of 13 rounds; "agreement" never happens | choose consciously: same lens for both (agreement means something) or always judge (budget it) |
| 5 | Contract rule for data-flow (24 shared chars) frozen after tiny probes | 533 of 810 edges false on a real run; judge correctly upheld the contract | validate inference on the largest real run before freezing; let judges flag "contract defect" to the orchestrator instead of dropping |
| 6 | Formats surveyed on 2 tiny probes while 16 real journals existed locally | missed `failed` records, relayed-user-request prompt, `error`/`killed` values | before the contract: a code node that counts record types, fields and values across all local runs |
| 7 | No baseline snapshot of round-1 code | cannot measure whether the adversarial loop improved quality | commit (or tag) after every implement and fix step |
| 8 | My own labels (`#carried`, `#v1`) do not follow my own label convention | my UI splits units in my own run | label convention in the contract, checked by the dry run |
| 9 | Nodes reviewed in isolation | cross-layer defects found only at integration | contract tests shared by nodes; integration earlier |
| 10 | Specs did not bound test volume | 554 tests; every round reads them all | spec: "tests for the contract and the listed cases", not every hypothesis |
| 11 | Interface (N6) written by me, not through the gate | unreviewed component | next workflow puts the UI through the same loop |
| 12 | AGENTS.md created only at the checkpoint; graph.md not updated after graph changes | rules pasted into every prompt (`COMMON`); a new session could not resume from files alone | create AGENTS.md (+ CLAUDE.md `@AGENTS.md`) right after graph approval; update graph.md and AGENTS.md after every accepted result |
| 13 | Key evidence (video frames, UI screenshots) lived only in the session context | next session would have to re-watch | save frames/screens into the project with an index as soon as they are captured |

## What worked

- Independent reviewers found real defects first implementers missed (false demo edges, `todo` tests accepted, stream leak, unprotected agents, `failed` records, wrong prompt record).
- Judges dropped 2–13 weak findings per round and usually added one both reviewers missed.
- Severity gate (run 2): 16 of 23 carried findings were `low` and did not cost a round.
- Diff-only verification converged in one round for N7 and I1.
- Stopping run 1 early saved ~20 agents whose verdicts were predetermined.
