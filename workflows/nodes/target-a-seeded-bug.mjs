// Node N10a in graph.md: seeded bug in the demo target of workflow A. The last standalone run of A
// (wf_b37354dd-6c9) passed every unit in round 1 with bugsCaught 0: the visible tests of
// demo/targets/target-a catch every bug of the starting code, so the implementer fixes all of them
// and the reviewers find nothing. Acceptance (N10, CHECKS 5) needs a run that shows the whole cycle:
// finding -> judge -> fix -> second round.
export default {
  code: 'N10a',
  name: 'target-a seeded bug',
  risk: 'low',
  owns: ['demo/targets/target-a/', 'test/workflows/adversarial.test.mjs'],
  spec: `Demo data only: demo/targets/target-a is the input of workflow A (workflows/adversarial-review-loop.js), not wfviz code. Do not touch src/, web/, bin/, workflows/ or fixtures/.
How A works (read its header and the implement, review and runTests prompts): the implementer of a unit edits src/<unit>.mjs until "node --test test/<unit>.test.mjs" passes; reviewers see only GUIDE.md (written from TASK.md) and the diff of src/<unit>.mjs against the starting file; the test agent runs only the same visible test file. So a bug the visible tests do not catch survives the implementer only if nothing pushes the implementer to it, and reviewers find it only if TASK.md states the rule with an example and the bug sits in the diff.
Required:
1. Pick exactly one unit (slugify, chunk or duration) and one TASK.md rule of that unit. The visible test file of that unit does not check that rule (remove or change only the assertions that check it; every other assertion stays). Say which unit and rule in a comment at the top of the new tests in test/workflows/adversarial.test.mjs, not in the target.
2. The starting src/<unit>.mjs violates that rule, and the violating code sits in the lines the implementer must change anyway to make the failing visible tests pass, so it appears in the reviewers' diff. A minimal honest fix of the failing tests (the shortest change a reader of the test failures would make) keeps the violation. The starting code still fails some visible tests of that unit, as now.
3. TASK.md states the rule plainly with one concrete example input and its expected result or error, so a reviewer can produce a failing input from GUIDE.md alone. TASK.md, the tests and the starting code contain no hint that the rule is untested or seeded (no "hidden", "seeded", "not tested", no comment pointing at the bug).
4. The other two units and their tests keep their behaviour; the existing fixture tests in test/workflows/adversarial.test.mjs for them stay as they are.
5. Tests in test/workflows/adversarial.test.mjs (the only test file you own; it already has REFERENCE implementations and a mutant harness):
   a. the reference implementation of the chosen unit passes all its visible tests and gives the correct result on the TASK.md example of the rule;
   b. a "minimal fix" mutant (the reference with the violation put back, written as the minimal fix of point 2) passes ALL visible tests of the unit, and gives the wrong result on the TASK.md example;
   c. the starting src of the chosen unit gives the wrong result on that example and fails at least one visible test;
   d. the existing mutant test ("the tests catch implementations that break the spec rules they used to miss") no longer lists a mutant for the chosen rule if that mutant now passes; every other mutant stays and must still fail;
   e. "starting code has work to do" and "the tests are satisfiable" stay green for all three units.
6. Keep every other existing test in test/ green (npm test: exit 0, fail 0, skipped 0, todo 0).
Not required and out of scope: changing workflow A, proving that a live run of A shows the cycle (the orchestrator checks that with a live run after this node).`,
  lensA: 'demo target and its tests: is the chosen rule really unchecked by the visible tests and still checked for the other units; does the starting code violate it inside the lines a test-driven fix must touch (show the minimal fix and that it keeps the bug); is the TASK.md example concrete and correct (run it against the reference with node -e); no hint of the seeded bug in TASK.md, tests or src; do the new tests in test/workflows/adversarial.test.mjs fail on the old fixture (git show HEAD:demo/targets/target-a/...) and pass on the new one; nothing outside the owned paths changed; npm test counts.',
  lensB: 'reviewer path: reading only a GUIDE.md written from the new TASK.md and the diff of a minimal fix, can a reviewer name the failing input; would a careful implementer reading TASK.md fix it anyway in the same pass (if yes, say how likely and propose a placement that survives); do other units still catch all their spec rules; robustness of the new tests (temp dirs cleaned, no network, under 2 minutes).',
};
