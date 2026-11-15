# Initial prompt (verbatim)

The session started on 2026-11-08 with one user message that consisted of two pasted blocks,
reproduced below without changes. Block 1 is the task; block 2 is the graph template it refers to.

## Block 1 — task

Примени следующий XML-шаблон к задаче ниже. Подставь значения во все соответствующие {{PLACEHOLDERS}}.

TASK:
Разработать универсальный локальный визуализатор реального выполнения Claude Code Dynamic Workflows.

Сначала просмотри видео целиком:
https://x.com/HoodieFade_/status/2119097898180735028

Прочитай связанный промпт автора:
https://docs.google.com/document/d/1nIYFTztEzo3sdPjGMtFaF7VMQI4LqlYe/edit

Видео — визуальный референс. Если просмотр недоступен, сообщи об этом и попроси видеофайл. Не выдавай чтение поста или просмотр превью за просмотр ролика.

Первый проверочный сценарий:
исполнитель → два независимых ревьюера → судья по заданным условиям → исправитель → тесты → повтор или завершение.

OUTPUT:
Работающее приложение в текущей папке проекта: команда запуска, временный локальный HTTP-сервер на свободном порту, автоматическое открытие браузера и корректное завершение сервера.

Пока без упаковки в плагин. Архитектура должна позволять добавить её следующим этапом.

CHECKS:
1. Подключение к настоящему запуску Dynamic Workflow.
2. Этапы, агенты, состояния и повторные проходы обновляются во время выполнения.
3. Видны параллельная работа и доступные зависимости.
4. Можно открыть подробности агента и его результаты.
5. Для проверочного сценария доступны замечания, вердикты и результаты тестов, если источник их предоставляет.
6. Интерфейс работает со вторым workflow другой структуры.
7. Неизвестные данные явно обозначены. Восстановленные зависимости отличаются от непосредственно зарегистрированных.
8. Demo-режим отделён от реальных запусков.

SOURCES:
Видео, промпт автора, актуальная официальная документация Claude Code, установленная версия Claude Code и реальные журналы проверочных запусков.

SCOPE:
Текущая папка проекта. Изменения глобальной конфигурации, установка плагинов и публикация не входят в этот этап.

LIMIT:
Не более трёх попыток исправления каждого узла. Если реальные данные недоступны, останови зависимую работу и зафиксируй блокировку; не заменяй её демонстрацией.

Дополнительные требования:
- До проектирования интерфейса проверь доступные события, hooks и форматы журналов. Не придумывай API.
- Граф разработки в graph.md и наблюдаемый workflow — разные сущности.
- После согласования graph.md выполняй подходящие этапы разработки через настоящий Claude Code Dynamic Workflow.
- Названия ролей и этапов получай из данных запуска.
- Отдели источник событий, нормализацию данных и интерфейс.
- Сам визуализатор на первом этапе только наблюдает выполнение.

## Block 2 — graph template

```xml
<prompt>
<objective>
Solve {{TASK}} as a graph of bounded nodes, not as a single long session. Leave a usable deliverable, a verification report, and graph.md so another session can reproduce or extend the work. Define what “done” means before starting. Stop when all nodes pass their checks or the agreed limit is reached.
</objective>

<role>
You design, execute, and maintain the graph. Read the project's instructions and review existing work before changing anything. Plan and integrate yourself; delegate bounded tasks to subagents. Record every decision that changes the graph.
</role>

<principles>
Ideas drawn from Karpathy's autoresearch:
- Measure a baseline before changing the system.
- Give each node a clear scope and a fixed evaluator.
- Change one thing, measure it, and keep what improves. Record failed attempts too.
- Prefer fewer nodes when their results can still be compared.
</principles>

<inputs>
Task: {{TASK}}
Deliverable and path: {{OUTPUT}}
Acceptance criteria: {{CHECKS}}
Starting materials: {{SOURCES}}
Permitted changes: {{SCOPE}}
Execution limit: {{LIMIT}}

Fill in these fields before starting. If a missing detail would materially affect the result, ask one specific question.
</inputs>

<layer_1_decomposition>
Split {{TASK}} into nodes before working. One node = one bounded task: one input, one output, one check.
- Divide work according to what each node needs to read, not according to folders.
- An edge exists only when one node uses another node's output.
- Nodes without dependencies run in parallel.

Write the nodes, edges, and checks to graph.md and await approval.
</layer_1_decomposition>

<layer_2_nodes>
Each node runs in its own subagent, with only the context it needs:
1. Receive its specification, inputs, and check.
2. Build only its own artifact.
3. Run the check against the saved file.
4. Return the path, verdict, and evidence.

Specifications should remain reusable with other input data.
</layer_2_nodes>

<layer_3_code_nodes>
When a step has one correct answer (merge, sort, deduplicate, compare, count), implement it in code, not with the model. Use the model only for judgment.
- List every code node in graph.md.
- Do not assign deterministic operations to subagents.

If a required tool is missing, identify the blocker and preserve the nodes that can still be completed.
</layer_3_code_nodes>

<layer_4_permissions>
Check active permissions before running the graph. All edits must stay within {{SCOPE}}. Enforce limits with tool rules or a sandbox when necessary; running in a separate session is not, by itself, a restriction.
- Ask before publishing, sending, or spending.
- Never allow two sessions to edit the same file at once.
- Save a recoverable version before risky merges.
</layer_4_permissions>

<layer_5_gates>
Put a gate on every edge involving risky work. Open it only with evidence: deterministic checks first, then the node report, and the model's confidence last.

Record results in checks.md, one row per requirement:
node | requirement | verdict | evidence

Use the statuses: pass, fail, or unresolved. Include paths to files or actual check output. Make missing evidence visible.
</layer_5_gates>

<layer_6_feedback_loops>
Use two feedback loops.

Correction: a failed gate sends the work back to the node that produced it, with the reason, evidence, and a constraint to “fix only this node.” Maximum three attempts.

Learning: after a result is accepted, record in graph.md the rule that confirms it so the next execution can build on it.
</layer_6_feedback_loops>

<layer_7_closure>
Before execution, create a closure checklist from {{CHECKS}}, with observable evidence for every item:
- Every node's output exists and can be opened.
- Every gate passed against the saved version.
- Every failure was corrected or explicitly documented.
- AGENTS.md contains the rules learned during this run.

If a limit or blocker interrupts execution, return a partial status with the exact remaining steps.
</layer_7_closure>

<execution_loop>
1. Read graph.md and select nodes ready to run.
2. Run independent nodes in parallel.
3. Route each node's output through its gate.
4. Return only failed nodes for correction, never the entire batch.
5. Integrate accepted outputs and run the complete checks.
6. Continue until completion, a blocker, or {{LIMIT}} is reached.

Never weaken a gate to get a passing result.
</execution_loop>

<handoff>
After every phase, update progress.md:

Graph: completed, in-progress, and blocked nodes.
Outputs: exact paths of saved files.
Decisions: what changed in graph.md and why.
Outstanding: failures, questions, and blockers.
Next action: the next ready node.

On resumption, read graph.md and progress.md and continue from the saved state.
</handoff>

<deliverables>
Return {{OUTPUT}}, graph.md, checks.md, and progress.md. State what was checked, what passed, and what remains open. Save the graph as a reusable template. Report measured resource consumption only when actual data exists; do not infer savings from the prompt alone.
</deliverables>
</prompt>
```
