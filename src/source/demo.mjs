// Demo source (contract section 5, node N7).
//
// Replays one scripted, synthetic run on a timer and emits it as RawEvents (contract section 1).
// Nothing here is read from disk or from a real run: every event carries src "demo",
// a runId that starts with "demo-" and data.demo = true. This module never imports the
// real-run source; bin/wfviz.mjs loads it with a dynamic import() only under --demo.
//
// The run: three units go through implement -> two reviewers in parallel -> judge -> fixer ->
// tests, up to 3 rounds each. slugify.js passes after round 1, sum.js after round 2, chunk.js
// still fails after round 3 and is blocked.
//
// prov.file is a pseudo path "demo://<runId>/...", not a file on disk. prov.line counts the
// records the matching real file would hold (journal lines, transcript lines).
//
// Beyond the contract signature, createDemoSource accepts three optional injections for tests:
// `now` (wall clock: it stamps the events), `monotonic` (clock that paces the replay) and
// `timers` ({ setTimeout, clearTimeout }). Defaults are the real ones: Date.now, performance.now
// and the global timers. Pacing never reads the wall clock, so a suspended host or a stepped
// clock (NTP, manual change) cannot make the replay burst or stall. performance.now is on the
// same clock as the timers themselves. When a test injects `now` and not `monotonic`, `now`
// paces the replay too, so one fake clock can drive both.
// Exceptions thrown by onEvent are not caught: the source stops and rethrows.

import { createHash, randomBytes } from 'node:crypto';

const MAX_ROUNDS = 3;
const GAP_MS = 400; // pause between one agent ending and the next starting
const FINAL_GAP_MS = 600; // last agent ending -> run.final
const LOOP_GAP_MS = 6000; // run.final -> next run (loop)
const MAX_TIMER_MS = 2 ** 31 - 1; // longest delay a timer accepts; larger values fire after 1 ms

const MODEL_IDS = {
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  haiku: 'claude-haiku-5-5',
};

const META = {
  name: 'demo-adversarial-review-loop',
  description:
    'Synthetic demo run: three units each go through implement, two parallel reviewers, a judge, a fixer and tests, up to 3 rounds. A unit that still fails after round 3 is blocked.',
  phases: [
    { title: 'Implement', detail: 'one implementer per unit' },
    { title: 'Review', detail: 'two independent reviewers in parallel' },
    { title: 'Judge', detail: 'settles disagreements, drops weak findings' },
    { title: 'Fix', detail: 'applies the findings the judge confirmed' },
    { title: 'Test', detail: 'runs the unit tests; a failure starts the next round' },
  ],
};

// ---------------------------------------------------------------------------------------
// Script text shown in the run.script event. Meta literal is generated from META so the two
// cannot drift; the body mirrors the timeline built below.

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const META_LITERAL = [
  'export const meta = {',
  `  name: ${q(META.name)},`,
  `  description: ${q(META.description)},`,
  `  phases: [${META.phases.map((p) => `{ title: ${q(p.title)}, detail: ${q(p.detail)} }`).join(', ')}],`,
  '}',
].join('\n');

// The prompt templates and log() calls below must stay in step with the prompts and logs the
// plan emits (implementPrompt ... testsPrompt, buildPlan): a test runs this text against the
// emitted results and compares every prompt, label, log line and the returned value.
const SCRIPT_BODY = [
  '// Demo script, shown for illustration. The demo source replays this flow on a timer; it does not run it.',
  'const MAX_ROUNDS = 3',
  "const UNITS = ['slugify.js', 'sum.js', 'chunk.js']",
  "const REVIEW = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, findings: { type: 'array' }, note: { type: 'string' } }, required: ['verdict', 'findings'] }",
  "const JUDGE = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, reason: { type: 'string' }, findings: { type: 'array' } }, required: ['verdict', 'reason', 'findings'] }",
  "const FIX = { type: 'object', properties: { summary: { type: 'string' }, filesChanged: { type: 'array' } }, required: ['summary'] }",
  "const TESTS = { type: 'object', properties: { passed: { type: 'number' }, failed: { type: 'number' }, skipped: { type: 'number' }, total: { type: 'number' } }, required: ['passed', 'failed', 'total'] }",
  '',
  'async function runUnit(unit) {',
  "  const base = unit.replace(/\\.js$/, '')",
  '  const built = await agent(`Implement the unit ${unit} of the demo library.\\n\\nRead GUIDE.md and the stub src/${unit}. Write the code and its tests in test/${base}.test.js. Do not touch any other unit.\\nWhen done, reply with one line that says what you built.`, { label: `implement:${unit}`, phase: \'Implement\', model: \'sonnet\' })',
  '  let context = `Implementer report: ${built}`',
  '  for (let round = 1; round <= MAX_ROUNDS; round++) {',
  "    const [a, b] = await parallel(['A', 'B'].map((who) => () =>",
  '      agent(`You are reviewer ${who} for ${unit}, round ${round}. Assume the code in src/${unit} is wrong and prove it. You see only the diff and GUIDE.md.\\n\\n${context}\\n\\nList every defect with file, line and a failing input. Reply with a verdict ("pass" or "fail") and the findings.`, { label: `reviewer-${who.toLowerCase()}:${unit}#r${round}`, phase: \'Review\', schema: REVIEW, model: \'sonnet\' })))',
  '    const judged = await agent(`You are the judge for ${unit}, round ${round}. Two independent reviews:\\n${JSON.stringify([a, b])}\\n\\nDrop findings that have no file:line or no failing input. Decide which findings go to the fixer. You never write code.\\nReply with a verdict, a reason and the confirmed findings.`, { label: `judge:${unit}#r${round}`, phase: \'Judge\', schema: JUDGE, model: \'opus\' })',
  "    const fixed = await agent(`Apply these judge-confirmed findings to src/${unit}:\\n${JSON.stringify(judged.findings)}\\nJudge's reason: ${judged.reason}\\nDo not weaken, skip or delete tests. Reply with a summary and the files you changed.`, { label: `fix:${unit}#r${round}`, phase: 'Fix', schema: FIX, model: 'sonnet' })",
  '    const tests = await agent(`Run the tests of ${unit} with "node --test test/${base}.test.js" and report the counts. Do not edit any file.`, { label: `test:${unit}#r${round}`, phase: \'Test\', schema: TESTS, model: \'haiku\' })',
  '    if (tests.failed === 0) {',
  '      log(`${unit}: tests pass after round ${round}`)',
  "      return { unit, status: 'done', rounds: round }",
  '    }',
  '    context = `Fixer report: ${JSON.stringify(fixed)}\\nTest result: ${JSON.stringify(tests)}`',
  '  }',
  '  log(`${unit}: blocked after ${MAX_ROUNDS} rounds`)',
  "  return { unit, status: 'blocked', rounds: MAX_ROUNDS }",
  '}',
  '',
  "phase('Implement')",
  'log(`demo: starting ${UNITS.length} units`)',
  'const units = await parallel(UNITS.map((unit) => () => runUnit(unit)))',
  "return { units, blocked: units.filter((u) => u.status === 'blocked').map((u) => u.unit) }",
].join('\n');

const SCRIPT_TEXT = `${META_LITERAL}\n${SCRIPT_BODY}\n`;

// ---------------------------------------------------------------------------------------
// Scenario: the invented content of the run. Results are objects shaped for the recognisers
// (verdict, findings[], tests counts).

const finding = (file, line, severity, title, description, input) => ({ file, line, severity, title, description, input });
// A pass carries a note that says what the reviewer checked. The note is also what makes the result
// distinctive: src/model/infer.mjs draws a data-flow edge only from text that one agent alone
// produced, so a bare {"verdict":"pass","findings":[]} shared by several reviewers would leave
// its reviewer without an edge into the judge. Every note below is different.
const review = (verdict, findings = [], note) => (note === undefined ? { verdict, findings } : { verdict, findings, note });
const judged = (reason, findings) => ({ verdict: 'fail', reason, findings });
const fixed = (summary, file) => ({ summary, filesChanged: [file] });
const counts = (passed, failed, failures) => {
  const r = { passed, failed, skipped: 0, total: passed + failed };
  if (failures) r.failures = failures;
  return r;
};

const SLUG_ACCENT = finding(
  'slugify.js', 14, 'medium', 'Accented letters are dropped',
  'Words are split on [^a-z0-9] before accents are normalised, so "Crème brûlée" gives "cr-me-br-l-e" instead of "creme-brulee".',
  'slugify("Crème brûlée")',
);
const SUM_EMPTY = finding(
  'sum.js', 6, 'high', 'Empty list throws TypeError',
  'reduce() has no start value, so an empty list throws TypeError ("Reduce of empty array with no initial value") instead of returning 0.',
  'sum([])',
);
const SUM_NAN = finding(
  'sum.js', 9, 'medium', 'NaN is added silently',
  'A NaN item makes the whole result NaN without an error.',
  'sum([1, NaN])',
);
const SUM_LAST = finding(
  'sum.js', 9, 'high', 'NaN check skips the last item',
  'sum.js stops its NaN check at length - 1, so a NaN in the last position passes it.',
  'sum([1, 2, NaN])',
);
const CHUNK_TAIL = finding(
  'chunk.js', 8, 'high', 'Last partial chunk is dropped',
  'chunk.js only cuts a chunk while i + size <= length, so the remainder never gets one.',
  'chunk([1, 2, 3], 2)',
);
const CHUNK_ZERO_LOOP = finding(
  'chunk.js', 4, 'medium', 'size 0 never terminates',
  'With size 0, i += size does not advance the index and the while loop never ends.',
  'chunk([1], 0)',
);
const CHUNK_ZERO_TYPE = finding(
  'chunk.js', 5, 'high', 'size 0 throws TypeError',
  'The size guard in chunk.js throws TypeError, but its tests expect RangeError.',
  'chunk([1], 0)',
);
const CHUNK_EMPTY_A = finding(
  'chunk.js', 3, 'medium', 'Empty list returns [[]]',
  'slice(0, size) on an empty list pushes one empty chunk.',
  'chunk([], 3)',
);
const CHUNK_EMPTY_B = finding(
  'chunk.js', 3, 'medium', 'Empty input is not special-cased',
  'There is no early return for length 0.',
  'chunk([], 1)',
);

// Key order. src/model/infer.mjs draws a data-flow edge from any 24 shared non-space chars, and the
// fixed JSON syntax of two results (`{"verdict":"fail","findings":[{"file":"`, `,"severity":"medium",
// "title":"`, `,"failed":1,"skipped":0,"total":`) is long enough for that. The three units are
// independent, so their agents must not be linked by it. Agents that never saw each other do not write
// their keys in the same order, and each unit gets its own: the fixed runs between two values then end
// before 24 chars. The order of the keys is the only thing that differs; every value is unit text.
// test/demo checks the outcome: no data-flow edge, and no 24-char run, joins two units.
const KEYS_NATURAL = [
  'verdict', 'reason', 'findings', 'note', // reviewer, judge
  'summary', 'filesChanged', // fixer
  'passed', 'failed', 'skipped', 'total', 'failures', // tests
  'file', 'line', 'severity', 'title', 'description', 'input', // one finding
];
const KEY_ORDERS = [
  KEYS_NATURAL,
  [...KEYS_NATURAL].reverse(),
  [
    'findings', 'note', 'verdict', 'reason',
    'summary', 'filesChanged',
    'skipped', 'passed', 'total', 'failed', 'failures',
    'title', 'file', 'description', 'severity', 'input', 'line',
  ],
];

function inKeyOrder(order, value) {
  if (Array.isArray(value)) return value.map((v) => inKeyOrder(order, v));
  if (value === null || typeof value !== 'object') return value;
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([x], [y]) => rank(x) - rank(y)) // stable: a key the order does not list keeps its place
      .map(([k, v]) => [k, inKeyOrder(order, v)]),
  );
}

// pace scales every agent duration of the unit so the three units drift apart. keyOrder indexes KEY_ORDERS.
const SCENARIO = [
  {
    name: 'slugify.js',
    pace: 0.9,
    keyOrder: 0,
    implement: 'Implemented slugify.js: slugify(text) lowercases the text and joins its words with "-". 24 lines, 9 test cases.',
    rounds: [
      {
        a: review('fail', [SLUG_ACCENT]),
        b: review('pass', [], 'No defect found: slugify("") and slugify("  a  b  ") give clean slugs.'),
        judge: judged('slugify("Crème brûlée") reproduces in reviewer A\'s run. Reviewer B only tried ASCII text.', [SLUG_ACCENT]),
        fix: fixed('Normalise to NFD and strip combining marks before splitting words.', 'slugify.js'),
        tests: counts(9, 0),
      },
    ],
  },
  {
    name: 'sum.js',
    pace: 1,
    keyOrder: 1,
    implement: 'Implemented sum.js: sum(numbers) adds a list of numbers. 18 lines, 6 test cases.',
    rounds: [
      {
        a: review('fail', [SUM_EMPTY]),
        b: review('fail', [SUM_NAN]),
        judge: judged('sum([]) throws and sum([1, NaN]) returns NaN; both sum.js findings reproduce.', [SUM_EMPTY, SUM_NAN]),
        fix: fixed('Added 0 as the start value and a NaN check in the loop.', 'sum.js'),
        tests: counts(5, 1, ['sum throws on NaN anywhere in the list']),
      },
      {
        a: review('fail', [SUM_LAST]),
        b: review('pass', [], 'sum([]) and sum([NaN, 1]) both behave as specified.'),
        judge: judged('sum([1, 2, NaN]) is not caught. Reviewer B put its NaN in the first position.', [SUM_LAST]),
        fix: fixed('Loop bound now covers the last item.', 'sum.js'),
        tests: counts(6, 0),
      },
    ],
  },
  {
    name: 'chunk.js',
    pace: 1.15,
    keyOrder: 2,
    implement: 'Implemented chunk.js: chunk(list, size) splits a list into arrays of at most size items. 22 lines, 7 test cases.',
    rounds: [
      {
        a: review('fail', [CHUNK_TAIL]),
        b: review('fail', [CHUNK_ZERO_LOOP]),
        judge: judged('chunk([1, 2, 3], 2) loses the 3 and chunk([1], 0) never returns; both chunk.js findings reproduce.', [CHUNK_TAIL, CHUNK_ZERO_LOOP]),
        fix: fixed('The loop now includes the remainder; size is checked up front.', 'chunk.js'),
        tests: counts(5, 2, ['chunk throws RangeError for size 0', 'chunk returns [] for an empty list']),
      },
      {
        a: review('fail', [CHUNK_ZERO_TYPE]),
        b: review('pass', [], 'Every item lands in a chunk for chunk([1, 2, 3], 2) and chunk([1, 2], 5).'),
        judge: judged('The chunk.js test for size 0 expects RangeError, so the guard is wrong. Reviewer B never ran it.', [CHUNK_ZERO_TYPE]),
        fix: fixed('The size guard now throws RangeError.', 'chunk.js'),
        tests: counts(6, 1, ['chunk returns [] for an empty list']),
      },
      {
        a: review('fail', [CHUNK_EMPTY_A]),
        b: review('fail', [CHUNK_EMPTY_B]),
        judge: judged('chunk([]) and chunk([], 1) are one defect in chunk.js: no early return for an empty list.', [CHUNK_EMPTY_A, CHUNK_EMPTY_B]),
        fix: fixed('Early return for an empty list.', 'chunk.js'),
        tests: counts(6, 1, ['chunk does not mutate its input']),
      },
    ],
  },
].map(({ keyOrder, rounds, ...unit }) => ({
  ...unit,
  rounds: rounds.map((rd) => Object.fromEntries(Object.entries(rd).map(([k, v]) => [k, inKeyOrder(KEY_ORDERS[keyOrder], v)]))),
}));

// ---------------------------------------------------------------------------------------
// Plan: the scripted timeline in virtual milliseconds (speed 1). Pure and deterministic.

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const jsonOf = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const sha = (s) => createHash('sha256').update(s).digest('hex');

const T = (frac, text) => ({ frac, text: clip(text, 500) });
const U = (frac, tool, arg) => ({
  frac,
  tool,
  inputSummary: clip(JSON.stringify(tool === 'Bash' ? { command: arg } : { file_path: arg }), 200),
});
const S = (frac, result) => ({ frac, tool: 'StructuredOutput', inputSummary: clip(JSON.stringify(result), 200) });

function implementPrompt(u, base) {
  return [
    `Implement the unit ${u.name} of the demo library.`,
    '',
    `Read GUIDE.md and the stub src/${u.name}. Write the code and its tests in test/${base}.test.js. Do not touch any other unit.`,
    'When done, reply with one line that says what you built.',
  ].join('\n');
}

function reviewerPrompt(u, who, round, before) {
  const lines = [
    `You are reviewer ${who.toUpperCase()} for ${u.name}, round ${round}. Assume the code in src/${u.name} is wrong and prove it. You see only the diff and GUIDE.md.`,
    '',
  ];
  if (round === 1) {
    lines.push(`Implementer report: ${before.implement}`);
  } else {
    lines.push(`Fixer report: ${jsonOf(before.fix)}`, `Test result: ${jsonOf(before.tests)}`);
  }
  lines.push('', 'List every defect with file, line and a failing input. Reply with a verdict ("pass" or "fail") and the findings.');
  return lines.join('\n');
}

function judgePrompt(u, round, rd) {
  return [
    `You are the judge for ${u.name}, round ${round}. Two independent reviews:`,
    jsonOf([rd.a, rd.b]),
    '',
    'Drop findings that have no file:line or no failing input. Decide which findings go to the fixer. You never write code.',
    'Reply with a verdict, a reason and the confirmed findings.',
  ].join('\n');
}

function fixPrompt(u, rd) {
  return [
    `Apply these judge-confirmed findings to src/${u.name}:`,
    jsonOf(rd.judge.findings),
    `Judge's reason: ${rd.judge.reason}`,
    'Do not weaken, skip or delete tests. Reply with a summary and the files you changed.',
  ].join('\n');
}

function testsPrompt(u, base) {
  return `Run the tests of ${u.name} with "node --test test/${base}.test.js" and report the counts. Do not edit any file.`;
}

function buildPlan() {
  const agents = [];
  const logs = [{ atMs: 0, text: `demo: starting ${SCENARIO.length} units` }];
  const outcomes = [];

  for (const u of SCENARIO) {
    const base = u.name.replace(/\.js$/, '');
    const scale = (ms) => Math.round(ms * u.pace);
    let t = 0;

    const add = ({ role, round, phase, model, prompt, result, acts, durMs }) => {
      const label = round ? `${role}:${u.name}#r${round}` : `${role}:${u.name}`;
      const agent = {
        label, role, unit: u.name, round: round ?? null, phase, model, prompt, result,
        startMs: t,
        endMs: t + durMs,
        acts: acts.map(({ frac, ...rest }) => ({ atMs: Math.round(t + frac * durMs), ...rest })),
      };
      agents.push(agent);
      return agent;
    };

    const impl = add({
      role: 'implement', round: null, phase: 'Implement', model: 'sonnet',
      prompt: implementPrompt(u, base), result: u.implement, durMs: scale(7000),
      acts: [
        T(0.08, `Reading GUIDE.md and the stub for ${u.name}.`),
        U(0.15, 'Read', 'GUIDE.md'),
        U(0.25, 'Read', `src/${u.name}`),
        U(0.5, 'Write', `src/${u.name}`),
        U(0.65, 'Write', `test/${base}.test.js`),
        U(0.85, 'Bash', `node --test test/${base}.test.js`),
        T(0.97, u.implement),
      ],
    });
    t = impl.endMs + GAP_MS;

    const before = { implement: u.implement, fix: null, tests: null };
    let outcome = null;
    for (let round = 1; round <= u.rounds.length && round <= MAX_ROUNDS; round++) {
      const rd = u.rounds[round - 1];
      const reviewerActs = (res) => [
        U(0.1, 'Bash', `git diff -- src/${u.name}`),
        U(0.3, 'Read', 'GUIDE.md'),
        T(0.5, res.findings.length
          ? `Found a failing input: ${res.findings[0].input}.`
          : `Tried edge cases in ${u.name}; no failing input found.`),
        S(0.95, res),
      ];
      const revA = add({
        role: 'reviewer-a', round, phase: 'Review', model: 'sonnet',
        prompt: reviewerPrompt(u, 'a', round, before), result: rd.a, durMs: scale(5000), acts: reviewerActs(rd.a),
      });
      const revB = add({
        role: 'reviewer-b', round, phase: 'Review', model: 'sonnet',
        prompt: reviewerPrompt(u, 'b', round, before), result: rd.b, durMs: scale(6200), acts: reviewerActs(rd.b),
      });
      t = Math.max(revA.endMs, revB.endMs) + GAP_MS;

      const judge = add({
        role: 'judge', round, phase: 'Judge', model: 'opus',
        prompt: judgePrompt(u, round, rd), result: rd.judge, durMs: scale(3500),
        acts: [
          T(0.2, 'Checking each finding for file:line and a failing input.'),
          U(0.5, 'Read', `src/${u.name}`),
          S(0.95, rd.judge),
        ],
      });
      t = judge.endMs + GAP_MS;

      const fix = add({
        role: 'fix', round, phase: 'Fix', model: 'sonnet',
        prompt: fixPrompt(u, rd), result: rd.fix, durMs: scale(5000),
        acts: [
          U(0.1, 'Read', `src/${u.name}`),
          U(0.35, 'Edit', `src/${u.name}`),
          U(0.6, rd.judge.findings.length > 1 ? 'Edit' : 'Read', rd.judge.findings.length > 1 ? `src/${u.name}` : `test/${base}.test.js`),
          T(0.85, rd.fix.summary),
          S(0.95, rd.fix),
        ],
      });
      t = fix.endMs + GAP_MS;

      // The tests prompt embeds no earlier result: its link to the fixer is order only.
      const tests = add({
        role: 'test', round, phase: 'Test', model: 'haiku',
        prompt: testsPrompt(u, base), result: rd.tests, durMs: scale(2500),
        acts: [
          U(0.2, 'Bash', `node --test test/${base}.test.js`),
          S(0.9, rd.tests),
        ],
      });
      t = tests.endMs + GAP_MS;

      before.fix = rd.fix;
      before.tests = rd.tests;
      if (rd.tests.failed === 0) {
        outcome = { unit: u.name, status: 'done', rounds: round };
        logs.push({ atMs: tests.endMs, text: `${u.name}: tests pass after round ${round}` });
        break;
      }
    }
    if (!outcome) {
      const last = agents[agents.length - 1];
      outcome = { unit: u.name, status: 'blocked', rounds: MAX_ROUNDS };
      logs.push({ atMs: last.endMs, text: `${u.name}: blocked after ${MAX_ROUNDS} rounds` });
    }
    outcomes.push(outcome);
  }

  const endMs = Math.max(...agents.map((a) => a.endMs));
  const blocked = outcomes.filter((o) => o.status === 'blocked').map((o) => o.unit);
  logs.sort((x, y) => x.atMs - y.atMs);
  return {
    agents,
    logs: logs.map((l) => l.text),
    result: { units: outcomes, blocked },
    finalAtMs: endMs + FINAL_GAP_MS,
  };
}

const PLAN = buildPlan();

// ---------------------------------------------------------------------------------------
// Instantiate the plan for one run: ids, records, and a time-sorted list of steps.

function usageFor(seed) {
  const b = createHash('sha256').update(seed).digest();
  return {
    input_tokens: 2 + (b[0] % 5),
    cache_creation_input_tokens: b[1] % 4 === 0 ? 1000 + b[2] * 60 : 0,
    cache_read_input_tokens: 18000 + b[3] * 100 + b[4],
    output_tokens: 80 + b[5] * 3,
  };
}

const sumUsage = (u) => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;

function buildSteps(runId, emit) {
  const dir = `demo://${runId}/subagents/workflows/${runId}`;
  const journalFile = `${dir}/journal.jsonl`;
  const scriptPath = `demo://${runId}/workflows/scripts/${META.name}-${runId}.js`;
  const finalFile = `demo://${runId}/workflows/${runId}.json`;
  const lines = new Map();
  const nextLine = (file) => {
    const n = (lines.get(file) ?? 0) + 1;
    lines.set(file, n);
    return n;
  };
  const journal = (kind, data) => emit(kind, runId, data, { file: journalFile, line: nextLine(journalFile) });

  const steps = [];
  const at = (atMs, fire) => steps.push({ at: atMs, fire });
  const records = []; // in start order, filled as agents start
  let launchedAt = null;

  at(0, () => emit('run.script', runId, { scriptPath, text: SCRIPT_TEXT, meta: META }, { file: scriptPath, line: null }));
  at(0, () => {
    launchedAt = journal('run.launched', {}).ts;
  });

  for (const a of PLAN.agents) {
    const agentId = `ademo${sha(`${runId}|${a.label}|id`).slice(0, 12)}`;
    const key = `v2:${sha(`${runId}|${a.label}|key`)}`;
    const transcript = `${dir}/agent-${agentId}.jsonl`;
    const metaFile = `${dir}/agent-${agentId}.meta.json`;
    const modelId = MODEL_IDS[a.model];
    const rec = { agent: a, agentId, startedAt: null, endedAt: null, lastProgressAt: null, tokens: 0, toolCalls: 0, lastTool: null };

    at(a.startMs, () => {
      rec.startedAt = journal('agent.started', { agentId, key, label: a.label, phase: a.phase }).ts;
      rec.lastProgressAt = rec.startedAt;
      records.push(rec);
    });
    at(a.startMs, () =>
      emit('agent.meta', runId, {
        agentType: 'workflow-subagent', isBuiltIn: true, description: a.label,
        workflowPhase: a.phase, spawnDepth: 1, model: a.model,
      }, { file: metaFile, line: null }));
    at(a.startMs, () => emit('agent.prompt', runId, { agentId, text: a.prompt }, { file: transcript, line: nextLine(transcript) }));

    a.acts.forEach((act, i) => {
      at(act.atMs, () => {
        const usage = usageFor(`${runId}|${a.label}|${i}`);
        const data = { agentId, model: modelId, usage };
        if (act.tool) data.tool = act.tool;
        if (act.inputSummary !== undefined) data.inputSummary = act.inputSummary;
        if (act.text !== undefined) data.text = act.text;
        const ev = emit('agent.activity', runId, data, { file: transcript, line: nextLine(transcript) });
        rec.lastProgressAt = ev.ts;
        rec.tokens += sumUsage(usage);
        if (act.tool) {
          rec.toolCalls += 1;
          rec.lastTool = act.tool;
        }
      });
    });

    const toolsUsed = [...new Set(a.acts.filter((x) => x.tool).map((x) => x.tool))];
    at(a.endMs, () => {
      const data = { agentId, key, result: a.result };
      if (toolsUsed.length) data.toolsUsed = toolsUsed;
      rec.endedAt = journal('agent.result', data).ts;
    });
  }

  at(PLAN.finalAtMs, () => {
    emit('run.final', runId, (ts) => {
      const startTime = launchedAt;
      const phaseIndex = (title) => META.phases.findIndex((p) => p.title === title) + 1;
      return {
        runId,
        timestamp: new Date(ts).toISOString(),
        taskId: `wdemo${sha(runId).slice(0, 4)}`,
        script: SCRIPT_TEXT,
        scriptPath,
        result: PLAN.result,
        agentCount: records.length,
        logs: PLAN.logs,
        durationMs: ts - startTime,
        summary: META.description,
        workflowName: META.name,
        status: 'completed',
        startTime,
        phases: META.phases,
        defaultModel: MODEL_IDS.sonnet,
        workflowProgress: [
          ...META.phases.map((p, i) => ({ type: 'workflow_phase', index: i + 1, title: p.title })),
          ...records.map((r, i) => {
            const e = {
              type: 'workflow_agent', index: i + 1, label: r.agent.label,
              phaseIndex: phaseIndex(r.agent.phase), phaseTitle: r.agent.phase,
              agentId: r.agentId, model: MODEL_IDS[r.agent.model], state: 'done',
              startedAt: r.startedAt, queuedAt: r.startedAt, attempt: 1,
            };
            if (r.lastTool) e.lastToolName = r.lastTool;
            e.promptPreview = clip(r.agent.prompt, 300);
            e.lastProgressAt = r.lastProgressAt;
            e.tokens = r.tokens;
            e.toolCalls = r.toolCalls;
            e.durationMs = r.endedAt - r.startedAt;
            e.resultPreview = clip(jsonOf(r.agent.result), 300);
            return e;
          }),
        ],
        totalTokens: records.reduce((n, r) => n + r.tokens, 0),
        totalToolCalls: records.reduce((n, r) => n + r.toolCalls, 0),
      };
    }, { file: finalFile, line: null });
  });

  // Array.prototype.sort is stable: events that share a time keep their creation order,
  // so an agent's started, meta and prompt stay in that order.
  steps.sort((x, y) => x.at - y.at);
  return steps;
}

// ---------------------------------------------------------------------------------------

const wallNow = () => Date.now();
const monotonicNow = () => performance.now();

export function createDemoSource({
  onEvent,
  speed = 1,
  loop = true,
  now = wallNow,
  monotonic = now === wallNow ? monotonicNow : now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('createDemoSource: onEvent must be a function');
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    throw new RangeError(`createDemoSource: speed must be a finite number > 0, got ${String(speed)}`);
  }

  const tag = randomBytes(3).toString('hex');
  let runNumber = 0;
  let running = false;
  let cur = null; // { t0, steps, i }
  let timer = null;
  let epoch = 0; // bumped by stop(): a pump that sees a newer epoch has been superseded

  // `data` is a plain object, or a function of the event timestamp that returns one.
  function emit(kind, runId, data, prov) {
    const ts = now();
    const body = structuredClone(typeof data === 'function' ? data(ts) : data);
    const ev = {
      src: 'demo', kind, runId, sessionId: null, project: 'demo', ts, prov,
      data: { ...body, demo: true },
    };
    onEvent(ev);
    return ev;
  }

  function beginRun() {
    runNumber += 1;
    const runId = `demo-${tag}-${runNumber}`;
    const steps = buildSteps(runId, emit);
    // yieldAfter: the next run starts on a fresh timer turn, whatever the speed (see pump).
    if (loop) steps.push({ at: PLAN.finalAtMs + LOOP_GAP_MS, fire: beginRun, yieldAfter: true });
    cur = { t0: monotonic(), steps, i: 0 };
  }

  function pump() {
    timer = null;
    const mine = epoch;
    try {
      while (running && cur) {
        const step = cur.steps[cur.i];
        if (!step) {
          cur = null;
          running = false;
          return;
        }
        // Elapsed time comes from the monotonic clock, never from `now`. It is subtracted from the
        // scaled step time instead of adding the step time to t0, so a very small step time is
        // not lost in a large t0.
        const wait = step.at / speed - (monotonic() - cur.t0);
        if (wait > 0) {
          // Delays above the 32-bit limit would fire after 1 ms; pump re-checks the time when it wakes.
          timer = timers.setTimeout(pump, Math.min(Math.ceil(wait), MAX_TIMER_MS));
          return;
        }
        cur.i += 1;
        step.fire();
        // onEvent called stop() and perhaps start(): a newer pump owns the run and its timer.
        if (epoch !== mine) return;
        // A looping run at a very high speed has every step due at once, so without this turn
        // through the timers it would emit runs forever and never let the event loop run.
        if (step.yieldAfter) {
          timer = timers.setTimeout(pump, 1);
          return;
        }
      }
    } catch (err) {
      stop();
      throw err;
    }
  }

  async function start() {
    if (running) return;
    running = true;
    try {
      beginRun();
      pump(); // events due at t = 0 are emitted before start() resolves
    } catch (err) {
      stop();
      throw err;
    }
  }

  function stop() {
    running = false;
    epoch += 1;
    cur = null;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  return { start, stop };
}
