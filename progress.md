# progress.md

Current state, 2026-11-15. The full history of decisions and runs up to this date is in
`docs/progress-history.md`; node results with costs are in `graph.md` §10.

## State

- wfviz works end to end on real runs: live view, run history across projects (P1), replay of a
  finished run from the main page with pause at pace (RP1–RP3), tokens per agent and run with a cost
  estimate from OpenRouter prices (P2, P3a), search (P3), tracking hint in the page (H1) and as a
  plugin (`plugin/`, P4, P4b). User-facing description: `README.md`.
- Acceptance CHECKS 1–8: done with evidence in `checks.md` (N10).
- Handoff N11: `README.md` written, `AGENTS.md` updated, this file compacted (2026-11-15). The
  "graph template" for other projects is deferred until a second project needs it (user agreed).
- `npm test`: 1429 pass, 0 fail, 0 skipped, 0 todo. Flaky watch tests fixed 2026-11-15 (see below).
- Last workflow: 22 `wf_e7b48737-b8f` (L1 ui lows, pass after a resume). Next run script number: 23.

## Repository

Published 2026-11-15 (user): https://github.com/falkolab/wfviz (public, MIT), docs page https://falkolab.github.io/wfviz/
(GitHub Pages from `main` `/docs`). `main` starts from one clean commit; the full development history before it is the
local branch `archive/local-history` (never pushed). Kept local and git-ignored, never published: `evidence/`,
`sources/video-frames/`, `sources/video-notes.md`, `sources/author-prompt.md`, `.claude/launch.json`. Before every push:
`git grep -i ipg` must be empty. SSH to GitHub is refused in agent shells; push with
`git -c credential.helper='!gh auth git-credential' push https://github.com/falkolab/wfviz.git main`.

## Decisions in force

- Judge: codex cli, command given by the user per run, only in workflow args. The Codex workspace
  has been out of credits since 2026-11-12; judges run as `fallback-claude` until it is refilled.
- Review depth by risk (low: one reviewer, judge only on high/medium; high: reviewer a opus, b sonnet,
  judge always). Gate retries a failed implementer once, then blocks.
- Two modes of tracking: any run is shown from its files by generic rules; better tracking only as an
  optional hint (page button, plugin hook), never required.
- Prices are fetched, never hard-coded (OpenRouter public list, 1 h cache, `--offline`); no cost in demo.
- `.claude/launch.json` (config `wfviz`, port 4317) is the user's file: never commit it.

## Open items

- Flaky tests fixed (2026-11-15, orchestrator, test files only): "sinceMs still applies…" checked `isLoaded` in the same tick as the event, while the source marks the run loaded at the end of that pass (reproduced 18 of 30 under CPU load): it now waits for the mark. The real-`fs.watch` waits went from 5 s to 20 s (FSEvents can lag on a loaded machine; pollMs is 600 s, so the claim "the watcher, not a poll" holds). Both files: 20 of 20 at load average ~38; `npm test` 1429/0/0/0 under the same load.

- Lows from the last nodes (details in `graph.md` §10):
  - search/cost lows fixed by L1; left: the 375 px geometry has no headless test; "0 of 1 agents" plural;
  - run list: in replay mode the picker hides its one run under the 24 h default; a loaded running run
    with no known start is hidden by the 24 h default;
  - source: thinking-only assistant records are not emitted (26 of 12,889 messages lose their usage).
- Auto-open of wfviz on a Workflow call (PreToolUse hook): proposed 2026-11-08, needs the user's
  approval of a config change; not started.

## Integration with this workstation (user, 2026-11-15: not now)

Proposed and deferred: (1) an always-on wfviz on 127.0.0.1:4317 through a launchd agent (plist in the repo, installed by the
user); (2) installing `plugin/` through a local marketplace file (owner name needed); (3) auto-open on a Workflow call — not
recommended once (1) exists. Today wfviz starts by hand or from the desktop app's browser pane (`.claude/launch.json`, this
folder only).

## Next action

Wait for the user.
