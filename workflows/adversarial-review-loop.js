export const meta = {
  name: 'adversarial-review-loop',
  description: 'Adversarial review loop on a small target: guide, implement, two blind reviewers, judge when they disagree or both find nothing, fixer, tests counted in code; max 3 rounds per unit, then blocked',
  whenToUse: 'Test workflow A for wfviz: run the author loop (implementer, reviewers A and B, judge, fixer, test agent) on a copy of demo/targets/target-a',
  phases: [
    { title: 'Prep', detail: 'guide writer writes GUIDE.md and snapshots the starting files; two guide reviewers check it in parallel' },
    { title: 'Implement', detail: 'one implementer per unit; units run as a pipeline without a barrier' },
    { title: 'Review', detail: 'reviewers A and B per unit and round; each sees only GUIDE.md and the diff' },
    { title: 'Judge', detail: 'only when reviewers disagree or both found nothing' },
    { title: 'Fix', detail: 'fixer applies approved findings; a guide agent adds a rule when a category repeats' },
    { title: 'Test', detail: 'test agent runs the test command; pass, fail and skipped counts are parsed in code' },
  ],
}

// Implements the loop of sources/author-prompt.md on a tiny target.
//
// args: {
//   targetDir: string,            // directory with TASK.md, src/<unit>.mjs, test/<unit>.test.mjs
//   units: string[],              // unit names, [A-Za-z0-9_-]+
//   testCmd?: string,             // default "node --test test/{unit}.test.mjs"; {unit} is replaced
//   model?: string,               // default "haiku", used for every agent
//   maxRounds?: number,           // default 3, integer >= 1
// }
// Run it on a COPY of demo/targets/target-a: implementers edit src/<unit>.mjs in place, and the
// guide writer creates GUIDE.md and .wf/ (read-only snapshot of TASK.md, GUIDE.md and every
// unit's src and test file) in targetDir. targetDir must not contain quotes, backticks, $ or
// backslashes, must not start with ~ or -, and must not start or end with whitespace: it is
// placed inside double quotes in shell commands (cd "<dir>"). A targetDir that already has
// a .wf directory is refused: its baseline could be stale. Reviewers also check the file list: every
// file in targetDir other than TASK.md, GUIDE.md and the src and test file of each unit in args.units
// is reported as an added file, so give all units of the target (or a target that holds only these).
//
// Labels are "role:unit#rN". Roles: guide, review-a, review-b, implement, judge, fix, test.
// Prep agents use the unit name "prep", so no unit may be called "prep" (guide:prep#r1 writes,
// review-a:prep#r1 and review-b:prep#r1 check, guide:prep#r2 applies their issues). A rule-adding
// guide agent is guide:<unit>#rN for the unit whose approved findings made categories repeat: one
// agent per unit and round adds the rules of every category that became due there, so no two
// agents share a label.
//
// One round = reviewers A and B (parallel) -> code drops findings without file:line or input ->
// judge only if the reviewers disagree or both found nothing (or one returned no result) ->
// fixer if there are approved findings, the last test run failed, or its test count fell below the
// starting count (the fixer is told which, and how to restore the tests) -> test agent.
// A unit passes in the first round where nothing is approved, nobody had to fix anything
// after the review, and the test counts are clean. After maxRounds it is blocked.
// The same finding category in two approved findings (two bugs of one class, or one bug that came
// back after a failed fix) -> one guide agent adds a rule.

const cfg = args && typeof args === 'object' && !Array.isArray(args) ? args : null
if (!cfg) throw new Error('args required: { targetDir, units, testCmd?, model?, maxRounds? }')
const targetDir = cfg.targetDir
if (typeof targetDir !== 'string' || targetDir.trim() === '') throw new Error('args.targetDir must be a non-empty string')
// targetDir goes inside cd "..." in shell commands and inside quotes in prompts: a double quote would
// silently change the path, $ and ` would be expanded by the shell.
if (/["`$\\\u0000-\u001f\u007f]/.test(targetDir)) throw new Error('args.targetDir must not contain double quotes, backticks, $, backslashes or control characters')
// A leading ~ is not expanded inside double quotes, a leading - is read by cd as an option, and
// leading or trailing whitespace is part of the name, so cd "<dir>" would fail later and the
// agents would only show odd behaviour.
if (targetDir !== targetDir.trim()) throw new Error('args.targetDir must not start or end with whitespace')
if (/^[~-]/.test(targetDir)) throw new Error('args.targetDir must not start with ~ or -: pass an absolute path')
const units = cfg.units
if (!Array.isArray(units) || units.length === 0) throw new Error('args.units must be a non-empty array of unit names')
for (const u of units) {
  if (typeof u !== 'string' || !/^[A-Za-z0-9_-]+$/.test(u)) throw new Error(`invalid unit name ${JSON.stringify(u)}: use letters, digits, - and _ only`)
  // "prep" is the unit name of the Prep agents in labels (guide:prep#r1, review-a:prep#r1, ...)
  if (u.toLowerCase() === 'prep') throw new Error(`invalid unit name ${JSON.stringify(u)}: "prep" is reserved for the Prep agents`)
}
// Compared without case: on a case-insensitive filesystem (macOS default) "chunk" and "Chunk" are the
// same src/chunk.mjs and test/chunk.test.mjs, so two loops would edit the same files.
if (new Set(units.map((u) => u.toLowerCase())).size !== units.length) throw new Error('args.units has duplicates (names that differ only by case are duplicates: they name the same files on a case-insensitive filesystem)')
const testCmdTemplate = cfg.testCmd === undefined ? 'node --test test/{unit}.test.mjs' : cfg.testCmd
if (typeof testCmdTemplate !== 'string' || testCmdTemplate.trim() === '') throw new Error('args.testCmd must be a non-empty string')
const model = cfg.model === undefined ? 'haiku' : cfg.model
if (typeof model !== 'string' || model === '') throw new Error('args.model must be a non-empty string')
const maxRounds = cfg.maxRounds === undefined ? 3 : cfg.maxRounds
if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('args.maxRounds must be an integer >= 1')

const testCmd = (u) => testCmdTemplate.split('{unit}').join(u)

// Files the guide writer copies to .wf/orig (paths relative to targetDir and to .wf/orig).
// GUIDE.md is copied last, after it is written, and again when the prep revision edits it.
const baselineFiles = ['TASK.md', 'GUIDE.md', ...units.flatMap((u) => [`src/${u}.mjs`, `test/${u}.test.mjs`])]
const WRITABLE = 'find .wf -type f -perm -200'   // prints every baseline file that is not read-only
const expectedFiles = ['./TASK.md', './GUIDE.md', ...units.flatMap((u) => [`./src/${u}.mjs`, `./test/${u}.test.mjs`])]

// What a reviewer or judge gets to see for unit u. The first diff is the code under review. On an
// untouched tree every other command prints nothing, with one exception: the GUIDE.md diff shows the
// rules added during the run. Anything else is an edit outside the unit (a changed test, TASK.md,
// another unit's test, an added or deleted file) or a changed baseline (the baseline files are
// read-only, so a rewritten one is writable and shows up in the last command). The two file checks
// print only the exceptions: files that do not belong (grep -v of the expected list) and files that
// are gone ("missing:"). Another unit's src file is not diffed: it changes legitimately while that
// unit is implemented, and it is reviewed in that unit's own rounds.
const EXTRA_FILES = `find . -path ./.wf -prune -o -type f -print | grep -v -x -F ${expectedFiles.map((p) => `-e ${p}`).join(' ')}`
const MISSING_FILES = `for f in ${expectedFiles.join(' ')}; do [ -f "$f" ] || echo "missing: $f"; done`
const diffCmd = (u) => `cd "${targetDir}" && ${[
  `diff -u .wf/orig/src/${u}.mjs src/${u}.mjs`,
  `diff -u .wf/orig/test/${u}.test.mjs test/${u}.test.mjs`,
  'diff -u .wf/orig/TASK.md TASK.md',
  'diff -u .wf/orig/GUIDE.md GUIDE.md',
  ...units.filter((v) => v !== u).map((v) => `diff -u .wf/orig/test/${v}.test.mjs test/${v}.test.mjs`),
  EXTRA_FILES,
  MISSING_FILES,
  WRITABLE,
].join('; ')}`
const diffNote = (u) => `Reading the output: the first diff is the code of unit "${u}" under review. After it, every command prints nothing when nothing outside the unit was touched, except the GUIDE.md diff, which may show added lines under "Rules added during the run" (any other change in GUIDE.md is an edit outside the unit). Any other output is an edit outside the unit: the test diff (a weakened, skipped, deleted or changed test), the TASK.md diff, the diffs of the other units' tests, a path printed by the find command (a file was added; the files that belong here are ${expectedFiles.join(' ')}), a "missing:" line (a file was deleted), and a path printed by the last command (a baseline file that was rewritten). Report such an edit as a finding: file is the file concerned, line a line in it, input the command whose output shows it, category weakened-test or out-of-unit-edit.`

const COMMON = `You work on a tiny JS library in "${targetDir}" (ES modules, Node >= 20, zero npm dependencies, no network). Stay inside that directory. Never run git commit, git stash, git reset or any destructive command. No command that runs longer than 2 minutes.`

// ---- schemas ----
const FINDING = {
  type: 'object',
  properties: {
    file: { type: 'string' }, line: { type: 'number' }, input: { type: 'string' }, description: { type: 'string' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] }, category: { type: 'string' },
  },
  required: ['file', 'line', 'input', 'description', 'severity', 'category'],
}
const REVIEW = { type: 'object', properties: { findings: { type: 'array', items: FINDING } }, required: ['findings'] }
const JUDGE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['fix', 'accept'] },
    approved: { type: 'array', items: { type: 'number' } },
    dropped: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, reason: { type: 'string' } }, required: ['index', 'reason'] } },
    missed: { type: 'array', items: FINDING },
  },
  required: ['verdict', 'approved', 'dropped', 'missed'],
}
const TEST = { type: 'object', properties: { exitCode: { type: 'number' }, outputTail: { type: 'string' } }, required: ['exitCode', 'outputTail'] }
const DONE = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, required: ['files', 'note'] }
// The guide keeper reports one rule per category, so a round that makes two categories due still
// needs only one agent (and one label).
const RULES = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
    rules: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, rule: { type: 'string' } }, required: ['category', 'rule'] } },
  },
  required: ['files', 'note', 'rules'],
}
const GUIDE_REVIEW = {
  type: 'object',
  properties: {
    issues: { type: 'array', items: { type: 'object', properties: { section: { type: 'string' }, description: { type: 'string' }, suggestion: { type: 'string' } }, required: ['section', 'description', 'suggestion'] } },
    snapshotProblems: { type: 'array', items: { type: 'string' } },
  },
  required: ['issues', 'snapshotProblems'],
}
// The guide writer also reports what it did to the baseline: the files now under .wf/orig, whether
// .wf already existed, and the test run of every unit on the starting code (parsed in code).
const GUIDE_WRITE = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
    snapshot: { type: 'array', items: { type: 'string' } },
    alreadyExisted: { type: 'boolean' },
    baseline: { type: 'array', items: { type: 'object', properties: { unit: { type: 'string' }, exitCode: { type: 'number' }, outputTail: { type: 'string' } }, required: ['unit', 'exitCode', 'outputTail'] } },
  },
  required: ['files', 'note', 'snapshot', 'alreadyExisted', 'baseline'],
}
const GUIDE_REVISE = {
  type: 'object',
  properties: { files: { type: 'array', items: { type: 'string' } }, note: { type: 'string' }, snapshot: { type: 'array', items: { type: 'string' } } },
  required: ['files', 'note', 'snapshot'],
}

// ---- pure helpers ----
const norm = (s) => String(s === undefined || s === null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim()
const valid = (f) => !!f && typeof f.file === 'string' && f.file.trim() !== '' && Number.isInteger(f.line) && f.line > 0 && typeof f.input === 'string' && f.input.trim() !== ''
const keyOf = (f) => `${f.file.trim().replace(/^\.\//, '')}:${f.line}`

// Two findings on one file:line are one bug only if they name the same category or the same input.
// Within one reviewer's list (strict) both must match: two findings on one line with different
// inputs or categories are two bugs, even in a single-line function.
const sameBug = (f, g, strict) => {
  if (keyOf(f) !== keyOf(g)) return false
  const sameCat = norm(f.category) === norm(g.category)
  const sameInput = norm(f.input) === norm(g.input)
  return strict ? sameCat && sameInput : (sameCat && norm(f.category) !== '') || sameInput
}

// Union of two reviewers' valid findings, remembering who reported each. Reviewer b's finding joins
// an entry of reviewer a (one to one) when sameBug says so; otherwise it is an entry of its own.
const mergeFindings = (fa, fb) => {
  const entries = []
  for (const f of fa) if (!entries.some((e) => sameBug(e.finding, f, true))) entries.push({ finding: f, by: ['a'] })
  const seenB = []
  for (const f of fb) {
    if (seenB.some((g) => sameBug(g, f, true))) continue
    seenB.push(f)
    const e = entries.find((x) => !x.by.includes('b') && sameBug(x.finding, f, false))
    if (e) e.by.push('b')
    else entries.push({ finding: f, by: ['b'] })
  }
  return entries
}

// Test summary parsing. node --test prints "# pass N" (tap reporter); node 26 piped output was
// observed to print "ℹ pass N" (spec reporter), so both prefixes are read. The last match wins.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')
const lastCount = (text, name) => {
  const re = new RegExp(`^[ \\t]*(?:#|\\u2139)[ \\t]+${name}[ \\t]+(\\d+)[ \\t]*$`, 'gm')
  let last = null
  for (const m of text.matchAll(re)) last = Number(m[1])
  return last
}
const parseTests = (t) => {
  const tail = t && typeof t.outputTail === 'string' ? t.outputTail : ''
  const text = stripAnsi(tail)
  return {
    exitCode: t && Number.isFinite(t.exitCode) ? t.exitCode : null,
    total: lastCount(text, 'tests'), passed: lastCount(text, 'pass'), failed: lastCount(text, 'fail'),
    skipped: lastCount(text, 'skipped'), cancelled: lastCount(text, 'cancelled'), todo: lastCount(text, 'todo'),
    tail: tail.slice(-1500),
  }
}
// A missing pass count is never read as zero: unparsed output is not a pass. A todo test is a
// skipped test in effect (node --test exits 0 and counts it as neither pass nor fail), so it is
// not clean either. Older Node versions print no "# todo" line: a missing todo count is accepted.
const countsClean = (r) => r.exitCode === 0 && r.passed !== null && r.passed > 0 && r.failed === 0 && r.skipped === 0
  && (r.cancelled === null || r.cancelled === 0) && (r.todo === null || r.todo === 0)

// ---- run-wide state (units run concurrently, JS is single-threaded) ----
const stats = {
  bugs: new Set(), droppedByJudge: 0, droppedByCode: 0, rules: [],
  categories: new Map(),   // normalised category -> every approved finding of that category, in order
  ruled: new Set(),        // categories that already have a rule (or one in flight)
  tests: new Map(),        // unit -> last parsed test run
}
let guideQueue = Promise.resolve()
const inGuideQueue = (fn) => { const run = guideQueue.then(fn, fn); guideQueue = run.catch(() => null); return run }

// ---- agents ----
// The test summary lines are parsed in code, so they must survive in outputTail.
const SUMMARY_RULE = `The summary block (the lines "# tests", "# suites", "# pass", "# fail", "# cancelled", "# skipped", "# todo", which some Node versions print as "ℹ tests", "ℹ pass" and so on) must be part of outputTail. The default reporter prints failure details after that block, so if the block is not inside the last 3000 characters, start outputTail with the summary lines, then a line "...", then the last 2500 characters.`

const LOCK = 'find .wf -type f -exec chmod a-w {} +'

const guideWrite = () => agent(`${COMMON}
You are the guide writer. Units: ${units.join(', ')}.
0. Run ls -a in "${targetDir}". If a .wf directory already exists, an earlier run used this directory and its baseline may be stale: change nothing, write nothing, and return alreadyExisted true with empty lists.
1. Read TASK.md and, for each unit, the starting src/<unit>.mjs and test/<unit>.test.mjs.
2. Snapshot the starting state so reviewers can diff against it. Create the directories and copy exactly these files (plain cp), then never change the copies:
   TASK.md -> .wf/orig/TASK.md
${units.map((u) => `   src/${u}.mjs -> .wf/orig/src/${u}.mjs\n   test/${u}.test.mjs -> .wf/orig/test/${u}.test.mjs`).join('\n')}
3. Count the tests on the starting code. Run each of these commands in "${targetDir}", change nothing (the starting code is expected to fail some tests), and return for each unit the exit code and outputTail (the last 3000 characters of the combined stdout and stderr):
${units.map((u) => `   ${u}: ${testCmd(u)}`).join('\n')}
${SUMMARY_RULE}
4. Write GUIDE.md in "${targetDir}". Reviewers get only this file and a diff, so it must stand alone:
   - per unit: exported function name, inputs, outputs, errors and edge cases, restated from TASK.md;
   - code conventions: ES modules, no dependencies, named exports, small pure functions;
   - reviewer rules: reject stubs and code that only returns what the tests expect, paragraph-long workaround comments instead of fixes, weakened, skipped or deleted tests, edits outside the unit under review;
   - an empty section titled "Rules added during the run".
5. Copy the finished GUIDE.md to .wf/orig/GUIDE.md, then lock the baseline so a rewritten file shows up as writable: ${LOCK}
Do not write any implementation. Return: files (the files you wrote), snapshot (every file under .wf/orig when you finish, as a path relative to .wf/orig), alreadyExisted, baseline (the test runs of step 3).`,
  { label: 'guide:prep#r1', phase: 'Prep', schema: GUIDE_WRITE, model })

const guideCheck = (who) => agent(`${COMMON}
You are guide reviewer ${who.toUpperCase()}. Read TASK.md and GUIDE.md. Report where GUIDE.md contradicts TASK.md, leaves out an edge case that TASK.md states, or is ambiguous enough that two readers would implement different behaviour. Put these in issues.
Also check the baseline in "${targetDir}/.wf/orig". No implementer has run yet, so every baseline file must be identical to the file at the same path in "${targetDir}" (use diff) and read-only. It must hold exactly: ${baselineFiles.join(', ')}. Run "${WRITABLE}" in "${targetDir}": it must print nothing. Put every violation (file missing, file different, file writable) in snapshotProblems, one string each, and do not repair anything yourself.
Do not edit any file. Return empty lists if the guide and the baseline are sound.`,
  { label: `review-${who}:prep#r1`, phase: 'Prep', schema: GUIDE_REVIEW, model })

const guideRevise = (issues, problems) => agent(`${COMMON}
You are the guide writer. Two reviewers checked GUIDE.md and the baseline in .wf/orig and reported:
Issues with GUIDE.md: ${JSON.stringify(issues)}
Problems with the baseline: ${JSON.stringify(problems)}
1. Fix GUIDE.md accordingly.
2. If there are baseline problems: no implementer has run yet, so the current TASK.md, src and test files are still the starting state. Make every missing or different file listed in .wf/orig identical to the file at the same path (cp; create directories as needed; run chmod u+w on a baseline file before replacing it). The baseline must hold exactly: ${baselineFiles.join(', ')}.
3. Copy GUIDE.md to .wf/orig/GUIDE.md (chmod u+w first), then lock the baseline again: ${LOCK}
Touch nothing except GUIDE.md and .wf/orig. Return: files (the files you changed) and snapshot (every file under .wf/orig when you finish, as a path relative to .wf/orig).`,
  { label: 'guide:prep#r2', phase: 'Prep', schema: GUIDE_REVISE, model })

const implement = (u) => agent(`${COMMON}
You are the implementer for unit "${u}".
Read GUIDE.md, the "${u}" section of TASK.md, the starting src/${u}.mjs (incomplete or buggy) and test/${u}.test.mjs.
Edit only src/${u}.mjs. Do not edit tests, TASK.md, GUIDE.md, .wf/ or other units. No stubs, no special-casing of test inputs.
Run: ${testCmd(u)}   (in "${targetDir}") and make the tests pass honestly. Return the files you changed.`,
  { label: `implement:${u}#r1`, phase: 'Implement', schema: DONE, model })

const LENS = {
  a: 'Start with correctness against the contract in GUIDE.md: wrong outputs, missing or wrong errors, edge cases.',
  b: 'Start with robustness and honesty: odd inputs, stubs, code that only satisfies visible examples, weakened, skipped or deleted tests, edits outside the unit, workaround comments.',
}
const review = (u, round, who) => agent(`${COMMON}
You are reviewer ${who.toUpperCase()} for unit "${u}", round ${round}. You did not write this code. Assume it is wrong and prove it.
Your only inputs are GUIDE.md and the diff of this unit against its starting state:
  ${diffCmd(u)}
(diff exits with 1 when files differ; that is normal). ${diffNote(u)}
Open the changed source file only to read line numbers. Do not read TASK.md, other units or anything else, and do not edit any file. You may run a small "node -e" snippet to confirm that an input really fails; do not run the whole test file.
${LENS[who]}
Report concrete breaks only. Each finding needs: file (relative to the project directory), line (in the current file), input (a concrete failing input or call), description, severity, category (a short kebab-case class of bug such as off-by-one, missing-validation, stub, weakened-test, out-of-unit-edit).
Reject: stubs, workaround comments instead of fixes, weakened, skipped or deleted tests (the test-file diff must be empty), edits outside the unit (see the output of the commands after the first diff).
Return an empty findings list if you cannot break it.`,
  { label: `review-${who}:${u}#r${round}`, phase: 'Review', schema: REVIEW, model })

const judge = (u, round, list, why) => agent(`${COMMON}
You are the judge for unit "${u}", round ${round}. You check the checkers; you never write or edit code.
Your only inputs are GUIDE.md, the diff of this unit against its starting state, and the reviewer findings below:
  ${diffCmd(u)}
${diffNote(u)}
Why you were called: ${why}.
Findings (index and who reported them): ${JSON.stringify(list.map((e, i) => ({ index: i, reportedBy: e.by, ...e.finding })))}
Do this:
- Drop every finding that is not real or has no concrete failing input; say why in dropped.
- Look for what both reviewers missed: stubs, weakened, skipped or deleted tests, edits outside the unit, violations of GUIDE.md. Put each in missed with file, line and a concrete failing input.
- approved = the indexes of findings the fixer must apply. verdict is "accept" only if nothing must be fixed, otherwise "fix".`,
  { label: `judge:${u}#r${round}`, phase: 'Judge', schema: JUDGE, model })

// What the fixer is told about the previous test run. A clean run is no reason to touch anything but
// the approved findings. A run with fewer tests than the reference is a repair job of its own, even
// though every test in it passed: without this text the fixer would see a green run and change nothing.
const shown = (n) => (n === null || n === undefined ? 'unknown' : n)
const lastRunNote = (u, last, shrink) => {
  if (!last) return 'No test run yet.'
  const head = `The last test run (${testCmd(u)}) had exit code ${shown(last.exitCode)}, total ${shown(last.total)}, pass ${shown(last.passed)}, fail ${shown(last.failed)}, skipped ${shown(last.skipped)}.`
  if (shrink) {
    return `${head} The test count dropped from ${shrink.ref} to ${shrink.now}: tests were removed or no longer run, even if the ones that ran passed. Repair that first. Run: diff -u .wf/orig/test/${u}.test.mjs test/${u}.test.mjs. If it prints anything, restore the file with cp .wf/orig/test/${u}.test.mjs test/${u}.test.mjs and make src/${u}.mjs pass every test in it. If it prints nothing, the test file is intact: change no test, and say so in note. Output of that run:\n${last.tail}`
  }
  if (countsClean(last)) return `${head} That run was clean, so there is nothing to repair in it: apply the approved findings and nothing else.`
  return `${head} Fix what it shows:\n${last.tail}`
}

const fix = (u, round, items, last, shrink) => agent(`${COMMON}
You are the fixer for unit "${u}", round ${round}. Edit only src/${u}.mjs. Do not weaken, skip or delete tests, and do not edit tests, TASK.md or GUIDE.md by hand.
One exception: an approved finding, or a drop in the test count reported below, may point to a weakened, skipped, deleted or changed test, or to an edit outside src/${u}.mjs. Undo that edit, never repeat it. Restore a changed test file or TASK.md from the baseline (cp .wf/orig/test/<name>.test.mjs test/<name>.test.mjs; cp .wf/orig/TASK.md TASK.md), delete a file that was added, and for GUIDE.md or another unit's src file undo only the change the finding names, by hand (keep rules under "Rules added during the run"). Never write into .wf/.
Apply exactly these approved findings: ${JSON.stringify(items)}
${lastRunNote(u, last, shrink)}
Run ${testCmd(u)} before you finish. Return the files you changed.`,
  { label: `fix:${u}#r${round}`, phase: 'Fix', schema: DONE, model })

const runTests = (u, round) => agent(`${COMMON}
You are the test runner for unit "${u}". Run exactly this command in "${targetDir}" and change nothing: ${testCmd(u)}
Return its exit code, and as outputTail the last 3000 characters of its combined stdout and stderr. ${SUMMARY_RULE} Do not fix anything, do not edit files, do not re-run it with other flags.`,
  { label: `test:${u}#r${round}`, phase: 'Test', schema: TEST, model })

// One agent per unit and round for every category that became due there: the label is
// guide:<unit>#r<round>, and two agents with one label could not be told apart in the UI.
const addRules = (u, round, categories) => {
  const due = categories.map((category) => ({ category, approved: [...stats.categories.get(category)] }))   // snapshot now, the agent waits in the queue
  return inGuideQueue(() => agent(`${COMMON}
You are the guide keeper. The review loop approved findings of ${due.length === 1 ? 'this category' : 'each of these categories'} at least twice (two bugs of one class, or one bug that came back after a failed fix):
${JSON.stringify(due)}
Add one short rule (one or two sentences) per category to the section "Rules added during the run" of GUIDE.md, so implementers avoid this class of bug and reviewers check for it. Edit GUIDE.md only. Return the files you changed, in note the exact text you added, and in rules one entry per category: the category as given above and the exact rule text.`,
    { label: `guide:${u}#r${round}`, phase: 'Fix', schema: RULES, model }))
}

// ---- Prep ----
phase('Prep')
log(`units: ${units.join(', ')}; max rounds ${maxRounds}; model ${model}`)
const guide = await guideWrite()
if (!guide) throw new Error('guide writer returned no result; cannot continue without GUIDE.md')
if (guide.alreadyExisted === true) throw new Error(`${targetDir} already has a .wf directory: an earlier run left a baseline that may be stale; run on a fresh copy of the target`)

// Baseline snapshot: reviewers diff against .wf/orig, so a missing or stale baseline makes every
// review vacuous. The writer's own report is checked here, the prep reviewers check the files.
const normPath = (p) => String(p).trim().replace(/^\.\//, '').replace(/^\.wf\/orig\//, '')
const missingFrom = (reported) => (Array.isArray(reported) ? baselineFiles.filter((p) => !reported.map(normPath).includes(p)) : null)
const baselineProblems = []
const writerMissing = missingFrom(guide.snapshot)
if (writerMissing === null) log('guide writer did not report the baseline snapshot; only the prep reviewers can confirm it')
else if (writerMissing.length > 0) baselineProblems.push(`the guide writer reported a baseline without: ${writerMissing.join(', ')}`)

// Test counts on the starting code seed the shrink guard: tests an implementer removes before the
// first test run are caught too.
const baselineTotals = new Map()
for (const b of Array.isArray(guide.baseline) ? guide.baseline : []) {
  if (!b || typeof b.unit !== 'string' || !units.includes(b.unit)) continue
  const total = parseTests(b).total
  if (Number.isInteger(total) && total > 0) baselineTotals.set(b.unit, total)
}

const [gA, gB] = await parallel([() => guideCheck('a'), () => guideCheck('b')])
if (!gA || !gB) log(`guide check incomplete: reviewer ${!gA && !gB ? 'a and b' : !gA ? 'a' : 'b'} returned no result`)
const guideIssues = [...((gA && gA.issues) || []), ...((gB && gB.issues) || [])]
for (const g of [gA, gB]) {
  for (const p of g && Array.isArray(g.snapshotProblems) ? g.snapshotProblems : []) if (typeof p === 'string' && p.trim() !== '') baselineProblems.push(p)
}
// A reviewer may also report a baseline problem as a plain guide issue ("..., .wf/orig is missing").
for (const i of guideIssues) {
  const text = [i && i.section, i && i.description, i && i.suggestion].filter((x) => typeof x === 'string').join(' ')
  if (/\.wf\b|baseline|snapshot/i.test(text)) baselineProblems.push(text.trim())
}
if (guideIssues.length > 0 || baselineProblems.length > 0) {
  log(`guide reviewers reported ${guideIssues.length} issue(s) and ${baselineProblems.length} baseline problem(s); revising once`)
  const revised = await guideRevise(guideIssues, baselineProblems)
  if (baselineProblems.length > 0) {
    const stillMissing = revised ? missingFrom(revised.snapshot) : null
    if (stillMissing === null || stillMissing.length > 0) {
      throw new Error(`the baseline snapshot in ${targetDir}/.wf/orig is not confirmed after the revision (${baselineProblems.join('; ')}${stillMissing ? `; still missing: ${stillMissing.join(', ')}` : ''}); reviews against a missing baseline show no diff, so the run stops`)
    }
  } else if (!revised) log('guide revision returned no result; continuing with the original GUIDE.md')
}

// ---- units: implement -> loop ----
const runLoop = async (u) => {
  let last = null          // last parsed test run
  // The test count a later run must not fall below: the starting code's count, else the first run's.
  // It is never raised by a later run. The tests are read-only, so a higher count later is a misreport
  // (or a changed test file, which the reviewers see in the diff), and one wrong high number would
  // make every later honest run look shrunk: the unit could never pass.
  let refTotal = baselineTotals.get(u) || null
  let lastShrink = null    // { ref, now } when the last run had fewer tests than refTotal
  let lastOk = false
  for (let round = 1; round <= maxRounds; round++) {
    const [ra, rb] = await parallel([() => review(u, round, 'a'), () => review(u, round, 'b')])
    const rawA = Array.isArray(ra && ra.findings) ? ra.findings : []
    const rawB = Array.isArray(rb && rb.findings) ? rb.findings : []
    const fa = rawA.filter(valid), fb = rawB.filter(valid)
    const dropped = rawA.length + rawB.length - fa.length - fb.length
    stats.droppedByCode += dropped
    const list = mergeFindings(fa, fb)
    const sameFindings = list.every((e) => e.by.length === 2)   // every finding reported by both reviewers

    let why = null   // null = agreement, judge skipped
    if (!ra || !rb) why = `${!ra && !rb ? 'both reviewers' : `reviewer ${!ra ? 'a' : 'b'}`} returned no result`
    else if (list.length === 0) why = 'both reviewers found nothing'
    else if (!sameFindings) why = 'reviewers disagree'

    let approved = list.map((e) => e.finding)
    let degraded = false
    if (why !== null) {
      const verdict = await judge(u, round, list, why)
      if (!verdict) {
        degraded = true
        log(`${u} r${round}: judge returned no result (${why}); sending all ${approved.length} valid finding(s) to the fixer, round cannot be accepted`)
      } else {
        const picked = new Set((Array.isArray(verdict.approved) ? verdict.approved : []).filter((i) => Number.isInteger(i) && i >= 0 && i < list.length))
        const explicit = new Set((Array.isArray(verdict.dropped) ? verdict.dropped : []).map((d) => d && d.index).filter((i) => Number.isInteger(i) && i >= 0 && i < list.length))
        const rawMissed = Array.isArray(verdict.missed) ? verdict.missed : []
        const missed = rawMissed.filter(valid)
        stats.droppedByCode += rawMissed.length - missed.length
        approved = [...picked].sort((x, y) => x - y).map((i) => list[i].finding)
        // A missed finding is a duplicate only of an identical one (same file:line, category and input,
        // the strict rule): the same category with another input on that line is another bug.
        for (const f of missed) { if (!approved.some((a) => sameBug(a, f, true))) approved.push(f) }
        // A finding the judge neither approved nor re-reported (identically) as missed is thrown away:
        // it counts as dropped whether or not the judge listed it in dropped, and an omission is logged.
        // Another approved finding of the same category on that line does not rescue it.
        let rejected = 0, undecided = 0
        list.forEach((e, i) => {
          if (picked.has(i) || approved.some((a) => sameBug(a, e.finding, true))) return
          rejected++
          if (!explicit.has(i)) undecided++
        })
        stats.droppedByJudge += rejected
        if (undecided > 0) log(`${u} r${round}: judge left ${undecided} finding(s) without a decision (not approved, not in dropped); counted as dropped`)
        if (verdict.verdict === 'fix' && approved.length === 0) {
          degraded = true
          log(`${u} r${round}: judge said fix but approved nothing; round cannot be accepted`)
        } else if (verdict.verdict === 'accept' && approved.length > 0) {
          log(`${u} r${round}: judge said accept but approved ${approved.length} finding(s); sending them to the fixer`)
        }
      }
    }

    // bugsCaught counts distinct bugs: file:line, category and input (the same bug approved again after
    // a failed fix is one bug; two inputs that fail on one line are two).
    // A rule counts occurrences: a category in two approved findings, whether two bugs of one class
    // or one bug that came back, earns one rule ("same bug twice -> rule in GUIDE.md").
    const due = []
    for (const f of approved) {
      stats.bugs.add(`${u}|${keyOf(f)}|${norm(f.category)}|${norm(f.input)}`)
      const cat = norm(f.category)
      if (cat === '') continue
      if (!stats.categories.has(cat)) stats.categories.set(cat, [])
      const seen = stats.categories.get(cat)
      seen.push({ unit: u, round, file: f.file, line: f.line, input: f.input, description: f.description })
      if (seen.length >= 2 && !stats.ruled.has(cat)) { stats.ruled.add(cat); due.push(cat) }
    }
    log(`${u} r${round}: A ${fa.length}, B ${fb.length}, dropped by code ${dropped}, ${why === null ? 'judge skipped (agreement)' : `judge called (${why})`}, approved ${approved.length}`)

    const needFix = approved.length > 0 || (last !== null && !lastOk)
    if (needFix) {
      const fixed = await fix(u, round, approved, last, lastShrink)
      if (!fixed) log(`${u} r${round}: fixer returned no result`)
    }
    if (due.length > 0) {
      const res = await addRules(u, round, due)
      if (res) {
        const reported = Array.isArray(res.rules) ? res.rules.filter((x) => x && typeof x.rule === 'string') : []
        for (const cat of due) {
          // the rule text of this category; the note is only that text when this was the one category due
          const own = reported.find((x) => norm(x.category) === cat)
          const rule = own ? own.rule : due.length === 1 && typeof res.note === 'string' ? res.note : null
          stats.rules.push({ category: cat, unit: u, round, rule })
          log(`rule added for category "${cat}"`)
        }
      } else {
        for (const cat of due) { stats.ruled.delete(cat); log(`guide agent returned no result for category "${cat}"; no rule added`) }
      }
    }

    last = parseTests(await runTests(u, round))
    stats.tests.set(u, last)
    if (refTotal === null && Number.isInteger(last.total) && last.total > 0) refTotal = last.total
    const shrunk = refTotal !== null && last.total !== null && last.total < refTotal
    lastShrink = shrunk ? { ref: refTotal, now: last.total } : null
    if (shrunk) log(`${u} r${round}: test count dropped from ${refTotal} to ${last.total}; tests were removed`)
    lastOk = countsClean(last) && !shrunk

    if (approved.length === 0 && !degraded && !needFix && lastOk) {
      log(`${u}: pass in round ${round}`)
      return { unit: u, status: 'pass', rounds: round }
    }
  }
  log(`${u}: blocked after ${maxRounds} round(s): ${lastOk ? 'tests are clean, but no round was accepted (findings kept coming, the judge was unavailable, or the last fix was never re-reviewed)' : 'the last test run was not clean'}`)
  return { unit: u, status: 'blocked', rounds: maxRounds }
}

phase('Implement')
const outcomes = await pipeline(units,
  async (u) => {
    const impl = await implement(u)
    if (!impl) throw new Error(`implementer for ${u} returned no result`)
    return impl
  },
  (impl, u) => runLoop(u))

const unitReports = units.map((u, i) => outcomes[i] || { unit: u, status: 'error', rounds: null })
const sumOf = (k) => {
  let s = 0
  for (const u of units) { const t = stats.tests.get(u); if (!t || t[k] === null) return null; s += t[k] }
  return s
}
const blocked = unitReports.filter((r) => r.status !== 'pass').map((r) => r.unit)
log(`done: ${unitReports.length - blocked.length}/${unitReports.length} units pass${blocked.length ? `; not passing: ${blocked.join(', ')}` : ''}; bugs caught ${stats.bugs.size}; rules added ${stats.rules.length}`)

return {
  units: unitReports,
  bugsCaught: stats.bugs.size,
  droppedByJudge: stats.droppedByJudge,
  droppedByCode: stats.droppedByCode,
  rulesAdded: stats.rules,
  tests: {
    passed: sumOf('passed'), failed: sumOf('failed'), skipped: sumOf('skipped'), total: sumOf('total'),
    byUnit: units.map((u) => {
      const t = stats.tests.get(u)
      return { unit: u, exitCode: t ? t.exitCode : null, passed: t ? t.passed : null, failed: t ? t.failed : null, skipped: t ? t.skipped : null, total: t ? t.total : null }
    }),
  },
}
