// SessionStart hook of the wfviz plugin. Prints one JSON object with an advisory note and exits 0.
//
// - Matcher "startup" in hooks/hooks.json is the only filter: the script does not read `source`.
// - It does not read stdin (the hook input is not needed), so empty or invalid input cannot matter.
// - It imports nothing: no file access, no network, no child process. It reads one environment
//   variable, CLAUDE_PLUGIN_OPTION_TRACKINGHINT, which Claude Code exports for the plugin option
//   "trackingHint" (plugin.json, userConfig). Unset or any other value counts as on.
// - Output is only hookSpecificOutput.additionalContext. No decision, no permission, no message
//   field, and the exit code is always 0, so the hook can never block or change the session.

const HINT = [
  'wfviz, a local viewer of Dynamic Workflow runs, is installed. It shows any workflow run as it is, and shows more detail when a workflow follows these optional conventions; a workflow that ignores them works the same.',
  '- Agent labels of the form "<role>:<unit>", with "#r2" for a repeat round, give a role x unit matrix.',
  '- A phase passed to each agent groups agents by stage.',
  '- JSON results are recognised: an array "findings" of { file, line, severity, description }, a "verdict" with a "reason", and "tests" { passed, failed, skipped }.',
  "- Run totals in the workflow's return value are shown as the run total.",
  '- log() lines at phase starts and ends appear in the log.',
].join('\n');

const OFF_VALUES = ['off', '0', 'false'];

function main() {
  const option = String(process.env.CLAUDE_PLUGIN_OPTION_TRACKINGHINT ?? '').trim().toLowerCase();
  if (OFF_VALUES.includes(option)) return;
  const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: HINT } };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// A closed stdout must not turn into a crash or a non-zero exit.
process.stdout.on('error', () => {});
process.exitCode = 0;
try {
  main();
} catch {
  // Nothing to report: the hint is advisory, and the exit code stays 0.
}
