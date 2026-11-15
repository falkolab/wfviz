// Node P4b in graph.md: the plugin's tracking hint reworded from commands to facts (user, 2026-11-12: "Да, заменить").
// Why: the hooks page says to write additionalContext "as factual statements rather than imperative system instructions",
// and that text framed as out-of-band commands can be surfaced to the user instead of used (judge contract issue, workflow 16).
export default {
  code: 'P4b',
  name: 'hint text',
  risk: 'low',
  owns: ['plugin/', 'test/plugin/'],
  spec: `Write only under plugin/ and test/plugin/. Read docs/guides/tracking-hints.md (it quotes the hooks page on additionalContext).
1. Replace the hint text in plugin/scripts/session-start.mjs with exactly this text (approved by the user 2026-11-12), lines joined by "\\n", no leading or trailing newline:
---
wfviz, a local viewer of Dynamic Workflow runs, is installed. It shows any workflow run as it is, and shows more detail when a workflow follows these optional conventions; a workflow that ignores them works the same.
- Agent labels of the form "<role>:<unit>", with "#r2" for a repeat round, give a role x unit matrix.
- A phase passed to each agent groups agents by stage.
- JSON results are recognised: an array "findings" of { file, line, severity, description }, a "verdict" with a "reason", and "tests" { passed, failed, skipped }.
- Run totals in the workflow's return value are shown as the run total.
- log() lines at phase starts and ends appear in the log.
---
2. Update plugin/README.md: show the new text, and replace the paragraph about the risk of imperative wording with one sentence saying the text is written as factual statements, as the hooks page advises.
3. Update the tests in test/plugin/ that pin the old text, with the same intent (exact text, ASCII only, field names in docs/contract.md section 3, label convention as in section 2, no role, label, phase or file of this project). Add one test that no line of the hint starts with an imperative verb from this list: Label, Pass, Return, Put, Use, Write, Add, Make.
Nothing else changes: output shape, matcher, off switch, exit code.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  lensA: 'text exact (byte for byte against the spec), ASCII only, under the 10,000 character cap, no imperative line, README in line with the text and the hooks page, tests real (fail on the old text), nothing else changed in output shape, matcher, off switch or exit code. Do not install the plugin or change any Claude Code config. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
