// Replay of the recorded runs: fixtures/claude-projects (real, Claude Code 2.1.306/2.1.317) and
// fixtures/synthetic/legacy-2.1.206 (synthetic, record shapes of 2.1.206). Expected counts are
// computed here, from the fixture files themselves, independently of the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeFsSource, readRunDir } from '../../src/source/claude-fs.mjs';
import { ROOTS, readLines, listRuns, expectedCounts, countKinds, checkRealRun } from './fixture-helpers.mjs';

const COMPUTED_FRAME = '[Workflow harness — computed task]';

// What agent.prompt must be for the records of one agent file, worked out from the records alone:
// the computed-task user record (frame line dropped, the two-space indentation stripped,
// framed: true), else the first user record as it stands (framed: false); the version of that
// record is copied into the data when it has one.
function expectedPrompt(agentId, recs) {
  const users = recs.map((r, i) => ({ r, line: i + 1 })).filter(({ r }) => r.type === 'user' && typeof r.message?.content === 'string');
  const computed = users.find(({ r }) => r.message.content.startsWith(COMPUTED_FRAME));
  const { r, line } = computed ?? users[0];
  const text = computed
    ? r.message.content.split('\n').slice(1).map((l) => l.replace(/^ {2}/, '')).join('\n')
    : r.message.content;
  const data = { agentId, text, framed: Boolean(computed) };
  if (typeof r.version === 'string') Object.assign(data, { ccVersion: r.version, version: r.version });
  return { data, line };
}

const ALL_RUNS = Object.values(ROOTS).flatMap(listRuns);

// --- the fixtures are what the tests assume ------------------------------------------------

test('fixtures: 2 real runs and 1 synthetic legacy run', () => {
  assert.deepEqual(ALL_RUNS.map((r) => r.runId).sort(), ['wf_00000206-leg', 'wf_26eb8d70-5c4', 'wf_6509ce25-20a']);
});

// --- readRunDir ----------------------------------------------------------------------------

for (const run of ALL_RUNS) {
  test(`readRunDir ${run.runId}: count per kind matches the fixture files`, async () => {
    const events = await readRunDir(run.sessionDir, run.runId);
    const expected = expectedCounts(run);
    assert.deepEqual(countKinds(events), expected);
    assert.equal(expected['source.warning'], 0, 'fixtures are clean: no warnings expected');
    // the counts are not all zero by accident
    assert.ok(expected['agent.started'] > 0 && expected['agent.result'] > 0 && expected['agent.meta'] > 0);
    assert.equal(expected['agent.prompt'], expected['agent.meta'], 'one prompt per agent');
    assert.equal(expected['run.script'], 1);
    assert.equal(expected['run.final'], 1);
  });

  test(`readRunDir ${run.runId}: envelope fields, provenance and timestamps`, async () => {
    const events = await readRunDir(run.sessionDir, run.runId);
    const journalFile = path.join(run.runDir, 'journal.jsonl');
    const journalMtime = Math.floor(fs.statSync(journalFile).mtimeMs);
    for (const e of events) {
      assert.equal(e.src, 'claude-fs');
      assert.equal(e.runId, run.runId);
      assert.equal(e.sessionId, run.session);
      assert.equal(e.project, run.slug);
      assert.ok(Number.isFinite(e.ts) && e.ts > 1e12, `ts is epoch ms: ${e.ts}`);
      assert.ok(path.isAbsolute(e.prov.file) && fs.existsSync(e.prov.file));
      assert.ok(e.prov.line === null || (Number.isInteger(e.prov.line) && e.prov.line >= 1));
      assert.equal(typeof e.data, 'object');
    }
    for (const e of events) {
      if (e.prov.line === null) {
        // whole-file events: no line; ts = mtime unless the file's object carries a timestamp
        assert.ok(['run.script', 'agent.meta', 'run.final'].includes(e.kind), e.kind);
        continue;
      }
      // line-based events point at the line that produced them
      const rec = JSON.parse(fs.readFileSync(e.prov.file, 'utf8').split('\n')[e.prov.line - 1]);
      if (e.prov.file === journalFile) {
        assert.equal(rec.agentId, e.data.agentId);
        assert.equal({ launched: 'run.launched', started: 'agent.started', result: 'agent.result', failed: 'agent.failed' }[rec.type], e.kind);
        assert.equal(e.ts, journalMtime, 'journal lines carry no timestamp: ts is the file mtime');
      } else {
        assert.equal(e.ts, Date.parse(rec.timestamp), 'transcript records carry a timestamp: ts is that timestamp');
        assert.equal(rec.agentId, e.data.agentId);
        assert.equal(path.basename(e.prov.file), `agent-${e.data.agentId}.jsonl`);
        assert.equal({ user: 'agent.prompt', assistant: 'agent.activity', attachment: 'agent.structured' }[rec.type], e.kind);
      }
    }
  });

  test(`readRunDir ${run.runId}: order is script, journal, agents (after their start), final`, async () => {
    const events = await readRunDir(run.sessionDir, run.runId);
    assert.equal(events[0].kind, 'run.script');
    assert.match(events[1].kind, /^(run\.launched|agent\.started)$/); // old versions wrote no launched line
    assert.equal(events.at(-1).kind, 'run.final');
    const firstNonJournal = events.findIndex((e) => !e.kind.startsWith('run.') && !['agent.started', 'agent.result', 'agent.failed'].includes(e.kind));
    assert.ok(events.slice(1, firstNonJournal).every((e) => /^(run\.launched|agent\.started|agent\.result|agent\.failed)$/.test(e.kind)), 'journal events come first');
    // per file the line order is preserved
    const lastLine = new Map();
    for (const e of events) {
      if (e.prov.line === null) continue;
      assert.ok(e.prov.line > (lastLine.get(e.prov.file) ?? 0), `${path.basename(e.prov.file)} line ${e.prov.line} is in file order`);
      lastLine.set(e.prov.file, e.prov.line);
    }
    // an agent's events come after its journal start
    const started = new Set();
    for (const e of events) {
      if (e.kind === 'agent.started') started.add(e.data.agentId);
      if (['agent.prompt', 'agent.activity', 'agent.structured'].includes(e.kind)) assert.ok(started.has(e.data.agentId), `${e.kind} before agent.started`);
    }
  });

  test(`readRunDir ${run.runId}: data carries the raw values of the files`, async () => {
    const events = await readRunDir(run.sessionDir, run.runId);
    const of = (kind) => events.filter((e) => e.kind === kind);

    // journal: the record minus "type", nothing added, nothing dropped
    const journal = readLines(path.join(run.runDir, 'journal.jsonl'));
    const jevents = events.filter((e) => /^(run\.launched|agent\.started|agent\.result|agent\.failed)$/.test(e.kind));
    assert.equal(jevents.length, journal.length);
    journal.forEach((rec, i) => {
      const { type, ...rest } = rec;
      assert.deepEqual(jevents[i].data, rest);
    });

    // meta: the parsed file as-is
    for (const e of of('agent.meta')) assert.deepEqual(e.data, JSON.parse(fs.readFileSync(e.prov.file, 'utf8')));

    // prompt: the computed-task record unframed (else the first user record); structured:
    // attachment data; per agent file
    for (const name of fs.readdirSync(run.runDir).filter((n) => /^agent-.+\.jsonl$/.test(n))) {
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      const recs = readLines(path.join(run.runDir, name));
      const prompts = of('agent.prompt').filter((e) => e.data.agentId === agentId);
      assert.equal(prompts.length, 1);
      const want = expectedPrompt(agentId, recs);
      assert.deepEqual(prompts[0].data, want.data);
      assert.equal(prompts[0].prov.line, want.line, 'prov points at the record the prompt comes from');

      const structured = recs.filter((r) => r.type === 'attachment' && r.attachment.type === 'structured_output');
      const got = of('agent.structured').filter((e) => e.data.agentId === agentId);
      assert.deepEqual(got.map((e) => e.data.data), structured.map((r) => r.attachment.data));
      assert.deepEqual(got.map((e) => e.data.toolUseID), structured.map((r) => r.attachment.toolUseID), 'unknown attachment fields are kept');

      const assistants = recs.filter((r) => r.type === 'assistant' &&
        r.message.content.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim() !== '')));
      const acts = of('agent.activity').filter((e) => e.data.agentId === agentId);
      assert.equal(acts.length, assistants.length);
      acts.forEach((e, i) => {
        const msg = assistants[i].message;
        const tool = msg.content.find((b) => b.type === 'tool_use');
        const text = msg.content.find((b) => b.type === 'text');
        assert.equal(e.data.tool, tool?.name);
        assert.equal('tool' in e.data, Boolean(tool));
        assert.equal('text' in e.data, Boolean(text));
        if (text) assert.equal(e.data.text, text.text.slice(0, 500));
        assert.equal(e.data.model, msg.model);
        assert.deepEqual(e.data.usage, msg.usage);
        assert.ok((e.data.inputSummary ?? '').length <= 200 && (e.data.text ?? '').length <= 500);
      });
    }

    // final file: the parsed object as-is, ts is its own timestamp
    const finalFile = path.join(run.sessionDir, 'workflows', `${run.runId}.json`);
    const final = JSON.parse(fs.readFileSync(finalFile, 'utf8'));
    const [fe] = of('run.final');
    assert.deepEqual(fe.data, final);
    assert.equal(fe.ts, Date.parse(final.timestamp));

    // script: path, full text, parsed meta
    const [se] = of('run.script');
    assert.equal(se.data.scriptPath, se.prov.file);
    assert.equal(se.data.text, fs.readFileSync(se.prov.file, 'utf8'));
    assert.equal(se.data.meta.name, final.workflowName);
    assert.deepEqual(se.data.meta.phases.map((p) => p.title), final.phases.map((p) => p.title));
  });
}

test('probe 1 (2.1.306): journal started lines carry label and phase; known literal counts', async () => {
  const run = ALL_RUNS.find((r) => r.runId === 'wf_6509ce25-20a');
  const events = await readRunDir(run.sessionDir, run.runId);
  const started = events.filter((e) => e.kind === 'agent.started');
  assert.deepEqual(started.map((e) => [e.data.label, e.data.phase]), [
    ['reviewer:A', 'Fanout'], ['reviewer:B', 'Fanout'], ['judge', 'Judge'], ['fixer:round1', 'Loop'], ['fixer:round2', 'Loop'],
  ]);
  const results = events.filter((e) => e.kind === 'agent.result');
  assert.deepEqual(results[0].data.result, { verdict: 'pass', note: 'A saw x=1' });
  assert.deepEqual(results[0].data.toolsUsed, ['StructuredOutput']);
  assert.equal('toolsUsed' in results[3].data, false, 'toolsUsed stays absent when the journal has none');
  assert.deepEqual(countKinds(events), {
    'run.script': 1, 'run.launched': 1, 'agent.started': 5, 'agent.meta': 5, 'agent.prompt': 5,
    'agent.activity': 5, 'agent.structured': 3, 'agent.failed': 0, 'agent.result': 5, 'run.final': 1, 'source.warning': 0,
  });
  // the judge's prompt contains both reviewer results: the prompt text is passed through whole
  const judgeId = started.find((e) => e.data.label === 'judge').data.agentId;
  const judgePrompt = events.find((e) => e.kind === 'agent.prompt' && e.data.agentId === judgeId).data.text;
  assert.match(judgePrompt, /A saw x=1/);
  assert.match(judgePrompt, /B saw x=2/);
  // every transcript starts with the computed-task record: frame and indentation are gone, the
  // version of the transcript is carried
  const prompts = events.filter((e) => e.kind === 'agent.prompt');
  assert.equal(prompts.length, 5);
  for (const e of prompts) {
    assert.equal(e.data.framed, true);
    assert.equal(e.data.ccVersion, '2.1.317');
    assert.equal(e.prov.line, 1);
    assert.doesNotMatch(e.data.text, /Workflow harness/);
    assert.doesNotMatch(e.data.text, /^ /m, 'no line keeps the harness indentation');
  }
  assert.equal(prompts.find((e) => e.data.agentId === started.find((s) => s.data.label === 'reviewer:B').data.agentId).data.text,
    'Reply with verdict "fail" and note "B saw x=2". Do not use any tools.');
});

test('probe 2 (failed run): pipeline overlap is kept in journal order; no events invented for script-level failures', async () => {
  const run = ALL_RUNS.find((r) => r.runId === 'wf_26eb8d70-5c4');
  const events = await readRunDir(run.sessionDir, run.runId);
  const j = events.filter((e) => /^agent\.(started|result)$/.test(e.kind));
  const labels = new Map(j.filter((e) => e.kind === 'agent.started').map((e) => [e.data.agentId, e.data.label]));
  const at = (kind, label) => j.findIndex((e) => e.kind === kind && labels.get(e.data.agentId) === label);
  assert.ok(at('agent.started', 'stage2:gamma') >= 0 && at('agent.result', 'stage1:alpha') >= 0);
  assert.ok(at('agent.started', 'stage2:gamma') < at('agent.result', 'stage1:alpha'),
    `overlap visible: ${j.map((e) => `${e.kind.split('.')[1]} ${labels.get(e.data.agentId)}`).join(' | ')}`);
  const final = events.at(-1);
  assert.equal(final.kind, 'run.final');
  assert.equal(final.data.status, 'failed');
  assert.ok(final.data.logs.some((l) => /stage2 throws/.test(l)), 'logs only come from the final file');
  // the slow agent's Bash tool calls show up as activity with an input summary
  const bash = events.filter((e) => e.kind === 'agent.activity' && e.data.tool === 'Bash');
  assert.ok(bash.length >= 2);
  assert.match(bash[0].data.inputSummary, /^sleep 3; echo alpha-1$/);
});

test('probe 2: every transcript starts with the relayed user request; the prompt is the computed task that follows it', async () => {
  const run = ALL_RUNS.find((r) => r.runId === 'wf_26eb8d70-5c4');
  const events = await readRunDir(run.sessionDir, run.runId);
  const prompts = events.filter((e) => e.kind === 'agent.prompt');
  assert.equal(prompts.length, 6, 'one prompt per agent, not one per leading user record');
  assert.equal(new Set(prompts.map((e) => e.data.agentId)).size, 6);
  for (const e of prompts) {
    assert.equal(e.prov.line, 2, 'the computed task is the second record; the relayed request is line 1');
    assert.equal(e.data.framed, true);
    assert.equal(e.data.ccVersion, '2.1.317');
    assert.doesNotMatch(e.data.text, /Workflow harness|Approve both/, 'nothing of the relayed user request or of the frame');
  }
  const texts = prompts.map((e) => e.data.text).sort();
  assert.ok(texts.includes('Reply with plain text "gamma fast done". No tools.'));
  assert.ok(new Set(texts).size > 1, 'agents show their own task, not one shared text');
});

test('legacy 2.1.206 (synthetic): started lines have no label or phase and the source does not make them up', async () => {
  const run = ALL_RUNS.find((r) => r.runId === 'wf_00000206-leg');
  const events = await readRunDir(run.sessionDir, run.runId);
  for (const e of events.filter((x) => x.kind === 'agent.started')) {
    assert.deepEqual(Object.keys(e.data).sort(), ['agentId', 'key']);
  }
  assert.equal(events.filter((e) => e.kind === 'run.launched').length, 0, 'old versions wrote no launched line');
  for (const e of events.filter((x) => x.kind === 'agent.meta')) assert.deepEqual(e.data, { agentType: 'general-purpose', spawnDepth: 1 });
  assert.deepEqual(events.filter((e) => e.kind === 'agent.result').map((e) => e.data.result), [
    { angle: 'alpha', summary: 'Alpha costs 12 credits per unit in 2026 according to the vendor price page.' },
    { angle: 'beta', summary: 'Beta was discontinued in March 2026 and replaced by gamma.' },
    'Alpha is live; beta is gone.',
  ]);
  assert.deepEqual(countKinds(events), {
    'run.script': 1, 'run.launched': 0, 'agent.started': 3, 'agent.meta': 3, 'agent.prompt': 3,
    'agent.activity': 3, 'agent.structured': 0, 'agent.failed': 0, 'agent.result': 3, 'run.final': 1, 'source.warning': 0,
  });
  // no harness frame in old transcripts: the first user record is the prompt, as it stands
  for (const e of events.filter((x) => x.kind === 'agent.prompt')) {
    assert.equal(e.data.framed, false);
    assert.equal(e.data.ccVersion, '2.1.206');
    assert.equal(e.prov.line, 1);
  }
});

test('readRunDir: a run directory that does not exist gives no events', async () => {
  assert.deepEqual(await readRunDir(path.join(os.tmpdir(), 'wfviz-does-not-exist'), 'wf_nope'), []);
  const run = ALL_RUNS[0];
  assert.deepEqual(await readRunDir(run.sessionDir, 'wf_not-in-this-session'), []);
});

// --- live source over a root ----------------------------------------------------------------

for (const [name, root] of Object.entries(ROOTS)) {
  test(`createClaudeFsSource over fixtures (${name}): discovers every run and emits what readRunDir returns`, async () => {
    const events = [];
    const source = createClaudeFsSource({ root, pollMs: 60_000, sinceMs: Infinity, onEvent: (e) => events.push(e) });
    await source.start();
    source.stop();

    const runs = listRuns(root);
    assert.deepEqual([...new Set(events.map((e) => e.runId))].sort(), runs.map((r) => r.runId).sort());
    for (const run of runs) {
      const mine = events.filter((e) => e.runId === run.runId);
      assert.deepEqual(mine, await readRunDir(run.sessionDir, run.runId), 'live replay and one-shot replay agree');
      assert.deepEqual(countKinds(mine), expectedCounts(run));
    }
    const total = runs.map(expectedCounts).reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0);
    assert.equal(events.length, total);
  });
}

test('createClaudeFsSource: a second rescan over unchanged files emits nothing new', async () => {
  const events = [];
  const source = createClaudeFsSource({ root: ROOTS.real, pollMs: 60_000, sinceMs: Infinity, onEvent: (e) => events.push(e) });
  await source.start();
  const n = events.length;
  assert.ok(n > 0);
  await source.rescan();
  await source.rescan();
  source.stop();
  assert.equal(events.length, n);
});

test('createClaudeFsSource: a root that does not exist is not an error', async () => {
  const events = [];
  const source = createClaudeFsSource({ root: path.join(os.tmpdir(), 'wfviz-no-such-root'), pollMs: 60_000, onEvent: (e) => events.push(e) });
  await source.start();
  await source.rescan();
  source.stop();
  assert.deepEqual(events, []);
});

// --- a legacy (2.1.206) run directory, read in place, read-only ------------------------------

// The synthetic legacy fixture stands in for a real 2.1.206 run, so this always runs (a real one
// is checked by optional-legacy.mjs, which `node --test test/source/` does not load).
test('a legacy 2.1.206 run directory is read in place and left unmodified (synthetic fixture)', async () => {
  const legacy = ALL_RUNS.find((r) => r.runId === 'wf_00000206-leg');
  const { events, unknownTypes } = await checkRealRun(legacy.runDir);
  assert.equal(unknownTypes.size, 0);
  assert.equal(events.filter((e) => e.kind === 'source.warning').length, 0);
  assert.equal(events.filter((e) => e.kind === 'agent.started').length, 3);
});

// A copy of the legacy fixture in a temp dir whose journal got extra lines appended.
function legacyCopyWithJournalLines(t, objs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfviz-n3-real-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const legacy = ALL_RUNS.find((r) => r.runId === 'wf_00000206-leg');
  const sessionDir = path.join(tmp, legacy.slug, legacy.session);
  fs.cpSync(legacy.sessionDir, sessionDir, { recursive: true });
  const runDir = path.join(sessionDir, 'subagents', 'workflows', legacy.runId);
  fs.appendFileSync(path.join(runDir, 'journal.jsonl'), objs.map((o) => `${JSON.stringify(o)}\n`).join(''));
  return { sessionDir, runDir, runId: legacy.runId };
}

test('a run with journal record types outside launched/started/result/failed is compared on the rest, with a warning per unknown type', async (t) => {
  // the same checks as the real-run check above, on a copy of the legacy fixture whose journal got `checkpoint` lines
  const { sessionDir, runDir, runId } = legacyCopyWithJournalLines(t, [{ type: 'checkpoint', n: 1 }, { type: 'checkpoint', n: 2 }]);
  assert.throws(() => expectedCounts({ sessionDir, runId, runDir }), /unexpected record type checkpoint/, 'fixtures stay strict');
  const { events, unknownTypes } = await checkRealRun(runDir);
  assert.deepEqual([...unknownTypes], ['checkpoint']);
  assert.equal(events.filter((e) => e.kind === 'source.warning').length, 1, 'one warning for the type, not one per line');
});

test('journal `failed` lines of a run replay as agent.failed events, one per line, and are not unknown record types', async (t) => {
  const { sessionDir, runDir, runId } = legacyCopyWithJournalLines(t, [
    { type: 'failed', key: 'k1', agentId: 'ax', error: 'boom' },
    { type: 'failed', key: 'k2', agentId: 'ay' },
    { type: 'failed', key: 'k2', agentId: 'ay' },
  ]);
  assert.equal(expectedCounts({ sessionDir, runId, runDir })['agent.failed'], 3, 'fixtures accept failed lines');
  const { events, unknownTypes } = await checkRealRun(runDir);
  assert.equal(unknownTypes.size, 0);
  assert.equal(events.filter((e) => e.kind === 'source.warning').length, 0, 'no unknown-type warning for failed');
  const failed = events.filter((e) => e.kind === 'agent.failed');
  assert.deepEqual(failed.map((e) => e.data), [
    { key: 'k1', agentId: 'ax', error: 'boom' },
    { key: 'k2', agentId: 'ay' },
    { key: 'k2', agentId: 'ay' },
  ]);
  const total = readLines(path.join(runDir, 'journal.jsonl')).length;
  assert.deepEqual(failed.map((e) => e.prov.line), [total - 2, total - 1, total], 'provenance points at the journal lines');
});
