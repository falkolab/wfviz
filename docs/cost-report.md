# Cost report — up to the checkpoint (2026-11-08)

## How measured

- Tokens: summed from the `usage` of every assistant message in this session's transcript
  (`~/.claude/projects/<slug>/<session>.jsonl`) and in every agent transcript under
  `subagents/`, deduplicated by message id. Measured, not estimated.
- Dollar figures are an **API-equivalent estimate**, not what the subscription charged:
  prices from the global model table ($/M in/out: Opus 5.5 4/20, Sonnet 5.5 2/10, Haiku 5.5
  0.10/0.50); cache write ×1.25 and cache read ×0.1 of the input price are **assumed** standard
  ratios, not checked for these models.
- Subscription (Team plan), read from the app: **weekly all-models 12 %** (user saw 8 % mid-run),
  weekly Fable 0 %, 5-hour window 72 % at the time of writing.
- Not included: codex cli judge (separate account; one smoke call used 22,208 tokens; per-run
  usage not recorded).
- The final run file's `totalTokens` (run 1: 10,509,421) is a different metric from the sum
  below (it does not match any column); its definition is not documented.

## Totals

| part | in + cache write | cache read | output | ~$ |
|---|---|---|---|---|
| main session (orchestrator, Opus 5.5) | 368 k | 46.96 M | 183 k | 24.27 |
| docs research subagent (Haiku) | 105 k | 0.77 M | 16 k | 0.03 |
| probe 1 + probe 2 (Haiku) | 309 k | 0.37 M | 1.5 k | 0.04 |
| dev run 1 `wf_9eae66f4-69f` (stopped) | 8.30 M | 194.09 M | 3.24 M | 94.06 |
| dev run 2 `wf_e2c4ea40-b0b` | 2.67 M | 58.10 M | 0.69 M | 24.26 |
| **total** | **11.75 M** | **300.3 M** | **4.13 M** | **~142.7** |

Run 1 by model: Sonnet $86.37, Opus (judge wrappers) $7.61, Haiku (test runners) $0.09.

## Where run 1 went (role × round, ~$)

| role | r1 | r2 | r3 | total |
|---|---|---|---|---|
| implement | 18.02 | — | — | 18.02 |
| reviewers A+B | 20.51 | 20.10 | 10.37 | **50.98** |
| fix | 11.81 | 5.56 | — | 17.37 |
| judge (Opus wrapper + fallback judging) | 3.69 | 2.45 | 1.47 | 7.61 |
| test (Haiku) | 0.04 | 0.03 | 0.02 | 0.09 |

Rounds 2–3 cost ~$40 of $94 (42 %). Reviews alone are 54 % of run 1.
Run 2 (revised gate): verification rounds $5.85, full review $5.28, fixes $8.22, implement $4.19, judge $0.66.

## What drove the cost

1. **Agent turns × context, not the fixed overhead.** Cache reads are 96 % of all tokens: every
   tool call of an agent re-reads its whole context. Run 1 Sonnet agents made 1,381 API calls.
   The ~56 k-token fixed context per agent (CLAUDE.md, skills, tool schemas) is real but secondary.
2. **Reviewers re-reading whole nodes every round** (run 1: $51). Diff-only verification in run 2
   cut a verification round to ~$1–2 per node.
3. **Main context bloat:** ~85 video frames and verbose browser output stayed in the orchestrator's
   context and were re-read on every turn (47 M cache-read tokens, $24).

## Errors that caused overspend (~$, estimates from the tables above)

| error | effect | ~$ |
|---|---|---|
| Stop rule "zero findings" + full re-review each round | rounds 2–3 of run 1 | ~40 |
| Video frames viewed in the main session instead of a subagent, frames not saved to files | every later turn re-read them | ~10–15 of the 24 |
| Opus agent used only to run the codex command (Haiku would do; Opus only as fallback) | judge wrappers | ~5–7 |
| Codex schema without `additionalProperties:false` | fallback judging on Opus in several rounds | part of the 7.6 |
| Contract frozen on tiny probes (missed formats, weak edge rule) | carried fixes in run 2 and rework still ahead | ~4–8 so far |
| Unbounded test volume in specs (554 tests) | longer reviews in every round | not separable |
| Test-count parser bug | no direct cost (flow unchanged), but run 1 verdicts unusable → run 2 re-verification | ~6 |

Rough avoidable share: **~$60–75 of ~$143 (40–50 %)**.

## Role of the prompts given at the start

What in the prompts pushed cost up (none of it is wrong in itself; the combination is):
- **Task**: "run suitable development stages through a real Dynamic Workflow" — required many agents.
  The adversarial loop from the post (4 roles per unit) was my choice for every node, not a
  requirement; it multiplied agent count roughly ×4.
- **Task**: "watch the whole video first" — correct requirement, but done in the main context it
  stayed there for the whole session. The prompt did not ask for that placement; I chose it.
- **Template, gates**: binary pass/fail with "never weaken a gate" and "maximum three attempts",
  with no notion of materiality. With reviewers told to find faults, any finding is a fail, so
  every node used its three attempts. A severity threshold is not in the template.
- **Template, layer 2**: "each node in its own subagent with only the context it needs" — sound,
  but Claude Code injects the same large base context into every agent; the template cannot limit it.
- **Template, principles**: "measure a baseline first" — not followed by me for the review loop
  (no round-1 snapshot), so the value of the expensive loop cannot be measured.
- **Template, closure**: AGENTS.md only at the end — encouraged pasting rules into every prompt.

What in the prompts saved cost: "prefer fewer nodes", "deterministic steps in code", the hard
limit of three attempts (stopped run 1 from going further), "ask before spending" (the user
stopped run 1 early, saving ~20 agents).
