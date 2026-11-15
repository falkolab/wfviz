# wfviz tracking hint

A small Claude Code plugin for wfviz, the local read-only viewer of Dynamic Workflow runs. When a new
Claude Code session starts, the plugin adds one short note to the session's context. The note lists a
few optional conventions for writing a Workflow script (agent labels, phases, result field names, run
totals, log lines). A script that follows them lets wfviz show the run in more detail. A script that
follows none of them still runs the same and still shows up in wfviz.

The note is advisory. It blocks nothing and changes no action, and the plugin cannot promise that
Claude follows it (see "What Claude does with the note" below).

## What it does

- Registers one `SessionStart` hook with the matcher `startup`, so it runs for a new session only,
  not on `resume`, `clear`, `compact` or `fork`.
- The hook runs `scripts/session-start.mjs` (Node 20 or newer, no npm dependencies). The script
  prints one JSON object, `{ "hookSpecificOutput": { "hookEventName": "SessionStart",
  "additionalContext": "..." } }`, and exits 0. Claude Code adds `additionalContext` to the context
  at the start of the conversation.
- The script has no other output field: no decision, no permission, no input change, no
  `systemMessage`. It reads no files and no stdin, writes no files and uses no network. Its only
  input is one environment variable, the off switch below.

## It never blocks

The exit code is always 0 (never 2) and the output has no decision field, so the hook cannot stop,
deny or change a session, a prompt or a tool call. Empty or invalid hook input changes nothing,
because the script does not read it. If something inside the script fails, it prints nothing and
still exits 0.

## What Claude does with the note

The hooks page of the Claude Code documentation says: Claude Code wraps `additionalContext` in a
system reminder and adds it at the start of the conversation, and the text does not appear as a chat
message in the interface. So a session shows no sign of the note by default.

The note's text is written as factual statements, as the hooks page advises. It reads:

```
wfviz, a local viewer of Dynamic Workflow runs, is installed. It shows any workflow run as it is, and shows more detail when a workflow follows these optional conventions; a workflow that ignores them works the same.
- Agent labels of the form "<role>:<unit>", with "#r2" for a repeat round, give a role x unit matrix.
- A phase passed to each agent groups agents by stage.
- JSON results are recognised: an array "findings" of { file, line, severity, description }, a "verdict" with a "reason", and "tests" { passed, failed, skipped }.
- Run totals in the workflow's return value are shown as the run total.
- log() lines at phase starts and ends appear in the log.
```

The hooks page says to check delivery in the debug log.

## Install

These are the commands the Claude Code plugin pages give. Run them yourself; nothing here runs them.

Try it for one session, from the folder that holds `plugin/`:

```
claude --plugin-dir ./plugin
```

Install it. A plugin installs from a marketplace, which is a directory or repository with a
`.claude-plugin/marketplace.json`. This folder has none: a marketplace needs an owner name that no
source here gives, so that file is for you to write. With a marketplace you have, in a session:

```
/plugin marketplace add ./my-marketplace
/plugin install wfviz@my-marketplace
```

or from your shell:

```
claude plugin install wfviz@my-marketplace
```

`my-marketplace` is a placeholder for the name your marketplace registered under.

## Off switch

The plugin declares a user option, `trackingHint` (boolean, default on), in the `userConfig` of
`.claude-plugin/plugin.json`. Claude Code passes it to the hook process as the environment variable
`CLAUDE_PLUGIN_OPTION_TRACKINGHINT`. When its value is `off`, `0` or `false` (any letter case), the
script prints nothing and exits 0. Unset, empty or any other value counts as on. The plugin pages do
not say which string Claude Code exports for a boolean option, so these three are the values the
script treats as off.

Set the option in any of these ways. Claude Code asks for a restart to apply a saved option.

- in a session: `/plugin configure wfviz@my-marketplace` opens the options dialog; or `/plugin`, the
  Installed tab, then Configure options for wfviz
- at install, from your shell: `claude plugin install wfviz@my-marketplace --config trackingHint=false`
- after install, from your shell (Claude Code 2.1.285 or later), by piping a JSON object of option
  keys and single-line string values to `--values-stdin`:

```
echo '{"trackingHint": "false"}' | claude plugin configure wfviz@my-marketplace --values-stdin
```

Run without `--values-stdin`, `claude plugin configure` only lists the plugin's options and whether
each is set: it saves nothing, so it does not turn the hint off. With `--values-stdin` it checks each
value against the option's declared type and, if one fails, saves nothing and exits 1. The plugin
pages show no example with a boolean option, so read the value back to be sure. With `--json` the
output includes the saved value of every option that is not sensitive; look for `trackingHint`:

```
claude plugin configure wfviz@my-marketplace --json
```

The plugin has no environment variable of its own for this switch. To turn off the whole plugin
instead, run `claude plugin disable wfviz@my-marketplace`.

## Check

`claude plugin validate ./plugin` checks the manifest. It reports no error. It warns that the manifest
has no author, no license and no icon: no source here gives those values, so they are left out.

Not checked from here: that Claude Code fires the hook on a new session, and that Claude uses the note
as context. That needs a session with the plugin loaded.
