# wfviz tracking hint

A small Claude Code plugin for wfviz, the local read-only viewer of Dynamic Workflow runs. When a new
Claude Code session starts, the plugin adds one short note to the session's context. The note lists a
few optional conventions for writing a Workflow script (agent labels, phases, result field names, run
totals, log lines). A script that follows them lets wfviz show the run in more detail. A script that
follows none of them still runs the same and still shows up in wfviz.

The note is advisory: it never blocks or changes anything, and the plugin cannot promise that Claude
follows it (see "What Claude does with the note" below).

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

From GitHub, in a Claude Code session:

```
/plugin marketplace add falkolab/wfviz
/plugin install wfviz@falkolab
```

or from your shell:

```
claude plugin marketplace add falkolab/wfviz
claude plugin install wfviz@falkolab
```

From a local clone, add the clone's folder instead: `claude plugin marketplace add ./wfviz`. To try the
plugin for one session without installing it, run from the clone's folder:

```
claude --plugin-dir ./plugin
```

The note takes effect in the next new session.

## Off switch

The plugin has one option, `trackingHint` (boolean, default on). Claude Code passes it to the hook as the
environment variable `CLAUDE_PLUGIN_OPTION_TRACKINGHINT`. When its value is `off`, `0` or `false` (any
letter case), the script prints nothing and exits 0; anything else counts as on.

Set it in any of these ways; Claude Code asks for a restart to apply a saved option.

- in a session: `/plugin configure wfviz@falkolab`, or `/plugin`, the Installed tab, then Configure
  options for wfviz;
- at install: `claude plugin install wfviz@falkolab --config trackingHint=false`;
- after install (Claude Code 2.1.285 or later):

```
echo '{"trackingHint": "false"}' | claude plugin configure wfviz@falkolab --values-stdin
```

Without `--values-stdin`, `claude plugin configure` only lists the options and saves nothing. To read
the saved value back:

```
claude plugin configure wfviz@falkolab --json
```

To turn off the whole plugin: `claude plugin disable wfviz@falkolab`.
