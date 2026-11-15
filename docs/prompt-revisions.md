# Proposed revisions to the starting prompt

This is a living registry (user, 2026-11-09): the orchestrator adds an entry whenever work shows
that the starting prompt could have prevented a problem or said something more clearly. Each entry:
what to add, where, and the evidence (date, run, commit). The user decides what goes into the prompt.

Source prompt: `docs/initial-prompt.md` — it has two blocks:
- **Block 1 — task**: the wfviz-specific text (TASK, OUTPUT, CHECKS, SOURCES, SCOPE, LIMIT, extra
  requirements) that fills the template's `{{PLACEHOLDERS}}`. One-off for this project.
- **Block 2 — graph template**: the reusable XML `<prompt>` (layers 1–7, execution loop, handoff).

Each revision closes an error from `docs/postmortem-dev-management.md` (number in brackets).
Revisions 2, 3, 4 and 10 address most of the ~$60–75 avoidable spend (`docs/cost-report.md`).

## Block 2 — graph template (reusable)

**1. Budget as an input** (overspend; "ask before spending" had no number). In `<inputs>`:
```xml
Budget: {{BUDGET}}
```
In `<execution_loop>`:
```xml
7. Measure tokens per node from transcripts after every phase. At 50 % of {{BUDGET}} stop and report; continue only with approval.
```

**2. Trial run before fan-out** (1, 2). New layer between `layer_4` and `layer_5`:
```xml
<layer_4b_trial>
Before running nodes in parallel, run the full chain once on one real node: tools, gate parsers, judge, schemas, labels.
Fix every failure of the harness first. A gate that was never run on real output is not a gate.
</layer_4b_trial>
```

**3. Materiality in gates** (3). In `<layer_5_gates>` after the first paragraph:
```xml
Findings carry severity: high (wrong result or crash in normal use), medium (wrong in a realistic edge case), low (style, wording, unlikely case).
Only high and medium fail a gate. Low findings go to the report and never trigger a correction.
Findings without a location and a failing input are dropped by code before any judgment.
```

**4. What an attempt is; what a re-check looks at** (3). In `<layer_6_feedback_loops>`, Correction:
```xml
One attempt = one return of high/medium findings to the producing node.
After the first full review, re-checks look only at the diff of the fix and at the findings it addressed; they do not search the node again.
```

**5. Specification defects go up, not back** (5). Same section:
```xml
If a reviewer or judge finds that the specification or contract itself is wrong, route it to the orchestrator as a change to the contract node, not back to the producer.
```

**6. Reviewers and judge: a conscious choice** (4). In `<layer_2_nodes>`:
```xml
When two reviewers check one artefact, state whether they share one lens (agreement is meaningful, a judge resolves disagreement) or use different lenses (always judge, budget it). Each reviewer reports at most 5 findings, most important first.
```

**7. Baseline** (7). In `<layer_4_permissions>`:
```xml
- Commit or tag after every node output and every correction, so each round can be compared with the previous one.
```

**8. Survey real data before freezing a contract** (6). In `<layer_1_decomposition>`:
```xml
Before freezing any format or interface contract, survey all available real data, not a sample, and record the version that produced each source. The survey is a code node.
```

**9. AGENTS.md at the start, not at the end** (12). In `<layer_1_decomposition>`, after "await approval":
```xml
After approval, create AGENTS.md with the method, the hard rules and the file map (for Claude Code also CLAUDE.md containing `@AGENTS.md`). Update it and graph.md after every accepted result and every change to the graph.
```
In `<layer_7_closure>` replace the AGENTS.md item with "AGENTS.md is current".

**10. Context hygiene** (13; ~$10–15 on video frames). In `<role>`:
```xml
Keep the orchestrator's context to text. Images, video, browser screenshots and broad reads go to subagents that return text. Save captured evidence as files with an index as soon as it is captured.
```

**11. Cheap wrappers** (Opus agent used only to run codex). In `<layer_3_code_nodes>`:
```xml
An agent that only runs an external tool or command uses the cheapest model; a stronger model is a fallback, not the default.
```

**12. Bounded tests** (10). In `<layer_2_nodes>`:
```xml
Specifications bound the tests: the contract and the listed cases, not every hypothesis.
```

**13. The product is independent of the development method** (2026-11-09; user). In `<objective>`:
```xml
The deliverable must not depend on how it is developed: the graph, gates, roles and labels of this development are one user of the deliverable, never its assumption. Name a check that guards this.
```
Evidence: wfviz matrix needed our `role:unit#tag` labels; fallback matrix and `test/integration/universal.test.mjs` added after the user asked.

**14. The gate as code, not prose** (2026-11-09; user). In `<layer_5_gates>`:
```xml
Write the gate once as a code template with tests; generate each run's script from it and a node file. Never hand-copy the gate between runs.
```
Evidence: the gate was copied dev-graph-3 → 4 → 5 → 6; text in AGENTS.md and code could drift unseen. Now `workflows/gate/gate-template.js` + `tools/make-dev-graph.mjs` + `test/workflows/gate-template.test.mjs`.

**15. Readable names everywhere the user looks** (2026-11-09; user). In `<layer_2_nodes>`:
```xml
Every node has a readable slug; agent labels and reports use it. Codes (N3, U2) stay in graph.md only; in chat say what the node does.
```
Evidence: "U2" meant nothing in chat or in the wfviz matrix.

**16. Keep the whole review method** (2026-11-09; user). In `<layer_6_feedback_loops>`:
```xml
Each node gets a guide written before implementation and checked in the review. A finding category approved twice (in one run or across runs) adds a rule to the shared guide.
```
Evidence: the dev gate dropped the author method's `<prep>` GUIDE.md and `<fix_the_process>`; restored in workflow 6.

**17. Parallel by default** (2026-11-08; user). In `<execution_loop>`:
```xml
Group every ready node whose owned files do not overlap into one workflow run; separate runs only for dependent nodes.
```
Evidence: workflow 4 ran one node per run, matrix showed one row.

**18. Test discovery must not depend on a list** (2026-11-09; orchestrator). In `<layer_3_code_nodes>`:
```xml
Test entry points discover test files; a new test file must run without registration. The gate checks the test count grew when a node adds tests.
```
Evidence: `test/*/index.js` listed files explicitly; `universal.test.mjs` did not run until the shims were changed (765 → 766).

**19. Nesting hides structure** (2026-11-09; orchestrator). In `<layer_3_code_nodes>`:
```xml
Run an observed test workflow as its own run, not nested inside a development run: nesting folds its phases into one.
```
Evidence: workflow 5 nested workflow A; its phases became one `▸ adversarial-review-loop`.

**20. Demo scenarios for showing and recording** (2026-11-09; user). In `{{OUTPUT}}`:
```xml
Include runnable demo scenarios (offline replay and live runs of differently shaped workflows) with a one-command start, for showing the deliverable and recording video.
```

**21. A UI node is checked by looking at it** (2026-11-09; orchestrator). In `<layer_5_gates>`:
```xml
For a node that changes what the user sees, one gate step opens the running page and checks it against the spec (a subagent takes and reads screenshots); code review alone does not pass a UI node.
```
Evidence: U1 passed two code reviewers and the judge; a browser check afterwards found wrong log times (medium), the log 3000 px below the fold, a flicker every second and misordered round tags.

**22. Review depth by risk, measured** (2026-11-09; orchestrator). In `<layer_2_nodes>`:
```xml
Each node states its risk. Low-risk nodes get one reviewer and the judge; two reviewers only where a wrong result is costly. Report per node: tokens by role and findings approved per reviewer.
```
Evidence: M1, S1, U1: review (two reviewers + verification) took 40–46 % of node tokens; 30 findings, 20 of them low (never sent back), 7 approved in the end (5 from reviewers, 2 added by the judge).

## Block 1 — task (wfviz-specific)

- **Video**:
  > Сначала просмотри видео целиком **в подагенте**. Сохрани ключевые кадры файлами с указателем «вопрос → кадр» и текстовую раскадровку; основная сессия работает только с текстом.
- **Judge "по заданным условиям"** — state the conditions:
  > Судья вызывается, когда ревьюеры расходятся по замечаниям high/medium или оба ничего не нашли. Судья — внешний инструмент; команду дам при запуске, в файлы её не записывать.
- **SOURCES** ("установленная версия" is ambiguous: CLI and desktop app differ):
  > …версия Claude Code, которая реально пишет журналы (поле `version`), и все локальные журналы workflow, по версиям.
- **LIMIT**:
  > Не более трёх попыток исправления каждого узла; попытка — возврат только по замечаниям high/medium, повторная проверка смотрит только diff. Бюджет: не более N % недельного лимита; на половине — остановка и доклад.
- **"Выполняй этапы через Dynamic Workflow"**:
  > …сначала пробный прогон всех шлюзов на одном узле. Цикл с двумя ревьюерами и судьёй — для узлов с риском; простые узлы — исполнитель и тесты.
- **Evidence for UI checks**:
  > Проверки интерфейса подтверждай скриншотами, снятыми подагентом и сохранёнными в `evidence/` с указателем.
