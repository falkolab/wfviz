// Node P4 in graph.md: an optional tracking hint given to the agent by a plugin hook (user approved the text, 2026-11-11).
// The hint is advice only: it must not block or change the agent's work. The plugin is packaged in the repo only;
// installing it is the user's step (no plugin installs in this stage).
export default {
  code: 'P4',
  name: 'tracking hints',
  risk: 'low',
  owns: ['plugin/', 'test/plugin/'],
  spec: `Write only under plugin/ and test/plugin/. src/, web/, bin/ are not yours.
Read first, verbatim, and quote the lines you rely on in the guide: https://code.claude.com/docs/en/plugins and the plugins reference it links (plugin.json, hooks location, any per-plugin user setting), and https://code.claude.com/docs/en/hooks (SessionStart: input fields, the "source" matcher values, hookSpecificOutput.additionalContext). Use only what those pages document; if something below is not documented, do not build it and say so in your note.
1. A plugin directory plugin/ with the manifest and a hooks config that runs one Node script on SessionStart for a new session only (the documented matcher for startup; not on resume, clear or compact) - zero npm dependencies, Node >= 20.
2. The script prints exactly one JSON object: { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": HINT } } and exits 0. No other field (no decision, no permission, no updatedInput, no systemMessage unless the docs require it), never exit code 2, never reads or writes files, no network. It is robust to empty or invalid stdin (still prints the hint, exit 0).
3. Off switch: if the plugin docs define a per-plugin user option, use it ("trackingHint", default on); otherwise an environment variable WFVIZ_TRACKING_HINT=off (also "0", "false"): then the script prints nothing and exits 0. Say which in plugin/README.md.
4. HINT is exactly this text (approved by the user):
---
wfviz (a local viewer of Dynamic Workflow runs) is installed. If you write a Workflow script, these optional conventions let it show the run in more detail. Use what fits, skip the rest; the workflow must work the same without them.
- Label agents "<role>:<unit>", with "#r2" for a repeat round.
- Pass a phase to each agent.
- Return results as JSON: problems as an array "findings" of { file, line, severity, description }; a decision as "verdict" with "reason"; test counts as "tests" { passed, failed, skipped }.
- Put run totals in the workflow's return value.
- log() a line when a phase starts or ends.
---
5. plugin/README.md: what it does, the install command as the docs give it (for the user to run; do not run it), the off switch, and that the hint never blocks.
6. Tests in test/plugin/ (add an index.js shim if the directory needs one for node --test, as other test dirs do): the script's output parses, has only the allowed fields, text exact; off switch values; empty and invalid stdin; exit code 0 always; the hooks config is valid JSON and names the script by a path that exists; the text names no role, label, phase or file of this project (grep for guide, judge, fixer, reviewer, dev-graph, node codes); every field name it mentions appears in docs/contract.md §3.
Keep every other test green (npm test: exit 0, fail 0, skipped 0, todo 0).`,
  lensA: 'documentation fit (every manifest key, hook event, matcher and output field quoted from the docs; show one that is not), advice only (no blocking or changing field, exit 0 always), text exact, off switch, no file or network access, zero dependencies, tests real. Do not install the plugin or change any Claude Code config. Write nothing to disk except under evidence/tmp/ and OS temp dirs.',
  lensB: 'same as lensA',
};
