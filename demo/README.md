# wfviz demo scenarios

Three scenarios to show wfviz or record it on video (a, b, and c with three live workflows). Each has one command, or the exact line to give Claude Code.
All commands run from the root of this repository (`<repo>` below stands for its absolute path: no spaces, quotes,
backticks, `$` or backslashes in it, because workflow A refuses such a path). wfviz opens your browser; stop it with
Ctrl+C. By default it also exits 120 seconds after the last browser tab closes: add `--idle 0` to keep it up while you
record.

| | scenario | data | command |
|---|---|---|---|
| a | synthetic demo | made up, labelled DEMO | `node bin/wfviz.mjs --demo` (or `npm run demo`) |
| b | replay of a saved real run | real, labelled REPLAY | `npm run demo:replay` |
| c | live run of workflow A, B or the free-labels workflow | real, labelled REAL | start wfviz, then give Claude Code one line |

## a. Synthetic demo

```
node bin/wfviz.mjs --demo
```

One made-up run, started over and over: three units go through implement, two reviewers, judge, fixer and tests, up to
three rounds each. One unit passes after round 1, one after round 2, one still fails after round 3 and is blocked.
Nothing is read from `~/.claude`. Use it to show the interface without waiting for a real run. It is never mixed with
real data: the page is labelled DEMO.

## b. Replay of the saved real runs

```
npm run demo:replay
```

This is `node bin/wfviz.mjs --replay wf_6509ce25-20a --root fixtures/claude-projects --speed 8`. `--replay` replays
**one** run, read from files: it emits the same events a live run would, at the pace of the run's own timestamps divided
by `--speed` (default 4, range 0.25 to 100; no pause longer than 2 seconds). The run is a real one that completed: two
reviewers in parallel, a judge, then two fixer rounds, five agents. The times on the page are the run's own. The replay
does not loop: when it ends, the run stays on the page as it was read, with its final file.

**When it starts.** The replay starts when the first browser page connects to wfviz, not when wfviz starts, so the page
always sees the run from its first event. wfviz prints `wfviz: replay starts when the first page connects: open <url>`
on stderr (the listening line on stdout is unchanged) and waits. It starts once: a reload, a second tab or a reconnect
finds the run as it is and does not start it again. To watch it again, stop wfviz with Ctrl+C and start it again. Plain
requests such as `curl <url>/api/runs` do not start it; the event stream (`/api/stream`) does.

The second saved run failed (a stage threw, a thunk threw, the script threw); it has its own command:

```
node bin/wfviz.mjs --replay wf_26eb8d70-5c4 --root fixtures/claude-projects --speed 8
```

Other forms: `--replay <run directory>` (a directory shaped `<session>/subagents/workflows/wf_<id>`; `--root` is then not
used), and a run id of one of your own runs, which is looked up under `--root` (default `~/.claude/projects`). An unknown
run id prints one `wfviz: ...` line and exits with code 2.

Replay is labelled REPLAY in the stream's first message (`hello`, mode `replay`), never REAL and never DEMO (contract
section 1). See "Open" at the end for what the page shows today.

## c. Live runs

wfviz reads the files Claude Code writes while a workflow runs, so **start wfviz first**, with the page open, and only
then start the run. A run that was started earlier is still listed (wfviz shows runs changed within the last 24 hours by
default; `--since <hours>` narrows that, which makes a cleaner screen to record), but you will not see it appear.

1. In a terminal: `node bin/wfviz.mjs --idle 0` (real mode; the page is labelled REAL). Leave it running.
2. In Claude Code, with this folder as the working directory, give one of the lines below. Claude Code asks you to
   approve the workflow run first. All agents of the three workflows run on `haiku`; workflows A and B take a `model` arg to change it, the free-labels workflow does not.
3. Watch the run appear. Ctrl+C in the terminal when you are done.

### Workflow A: the review loop

Shows a loop with a judge and rounds: labels like `implement:chunk#r1` and `judge:slugify#r2` give wfviz a role by unit
matrix with a column of rounds, the phases Prep, Implement, Review, Judge, Fix and Test, and the test counts it
recognises in results.

Workflow A **edits** its target and refuses a `targetDir` that already holds a `.wf` folder, so make a **new copy for
every run** (`a2`, `a3`, ...), never `demo/targets/target-a` itself:

```
cp -R demo/targets/target-a /tmp/wfviz-demo-a1
```

Then the line for Claude Code:

```
Run the Workflow tool with scriptPath <repo>/workflows/adversarial-review-loop.js and args {"targetDir":"/tmp/wfviz-demo-a1","units":["chunk","duration","slugify"]}
```

The script's own header describes its args as `{ targetDir: string, units: string[], testCmd?: string, model?: string,
maxRounds?: number }`: `testCmd` defaults to `node --test test/{unit}.test.mjs`, `model` to `haiku`, `maxRounds` to 3.
Give all three units of the target (the reviewers report any other file in `targetDir` as an added file).

### Workflow B: the fan-out

Shows a fan-out over a folder of notes: one reader and one checker per file, then one synthesis and one critic. The
labels (`read:<file>`, `check:<file>`) parse as role and unit, so the role by unit matrix has one column per file. It only
reads its target, so `demo/targets/target-b` can be used as it is:

```
Run the Workflow tool with scriptPath <repo>/workflows/research-fanout.js and args {"targetDir":"<repo>/demo/targets/target-b","files":["01-overview.md","02-pricing.md","03-security.md","04-roadmap.md","05-support-faq.md"]}
```

Header of the script: `args: { targetDir: string (not blank), files: string[] (plain file names inside targetDir), model?: string
(non-blank, default "haiku") }`. The notes contradict each other on purpose (price, devices, encryption, version history,
first release), which gives the synthesis something to find.

### The free-labels workflow

Shows what wfviz does when labels do **not** follow `role:unit`: the labels are plain phrases (`Read 01-overview.md`,
`Summarise the notes`, `Final check`), so no label parses and wfviz falls back to a matrix of phases by agents, with each
agent captioned by its label as it is (contract section 2, "Fallback matrix"). Three phases (Read, Summarise, Check),
at most 8 agents (one reader per file, a summary, a final check), haiku, read-only:

```
Run the Workflow tool with scriptPath <repo>/workflows/demo-free-labels.js and args {"targetDir":"<repo>/demo/targets/target-b","files":["01-overview.md","02-pricing.md","03-security.md","04-roadmap.md","05-support-faq.md"]}
```

Args: `targetDir` (not blank) and `files` (plain file names, at most 6, letters, digits, dot, dash, underscore).

## Recording the screen on macOS

Not checked on this Mac while this file was written; check the toolbar before a take.

- Cmd+Shift+5 opens the screenshot toolbar, which has screen recording. As far as known it has no "record this window"
  button: to record the wfviz window, choose Record Selected Portion and drag the frame around the browser window.
- Scenario c: start wfviz and open the page first, then start the recording, then give the line to Claude Code. Stop the
  recording from the menu bar.
- Scenario b (replay): the run begins when the page connects, so start the recording **before** the page connects.
  Start wfviz without opening a browser, put an empty browser window where you will record, start the recording around
  it, then load the printed address in that window:
  `npm run demo:replay -- --no-open --idle 0`, then open the `http://127.0.0.1:<port>` it prints. With the default
  command the browser opens by itself and the replay begins at once, before a recording that you start afterwards would
  catch it (the toolbar may add a countdown).
- For a calm take use `--idle 0`. The saved runs are short, so `npm run demo:replay` (speed 8) is over in about 4
  seconds: for a recording pass a slower speed, for example `npm run demo:replay -- --speed 1` (about 15 seconds) or
  `--speed 0.25` (about 22 seconds). The durations are computed from the schedule of the saved run
  `wf_6509ce25-20a`, not timed on screen; the replay's last events, written at the files' own later times, come after
  one jump of at most 2 seconds.

## Open

- The page's REPLAY banner is a change in `web/` that was not part of this file's work: until it lands the page shows
  REAL for a replay, and the elapsed time of a replayed (past) run is computed from the clock, not from the run's own
  times.
- Scenario c was not run end to end while this file was written: the workflows are covered by dry-run tests, not by a
  live Claude Code run.
