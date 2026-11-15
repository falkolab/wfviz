// The model tests use hand-built RawEvents (helpers.mjs). This file checks that those events
// really mirror the real fixture files: same journal lines, ids, labels, results, transcript
// prompts/timestamps, final-file values. It reads fixtures/ only; it never runs the source layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe1, probe2, legacy } from './helpers.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

function sessionDirs() {
  const out = {};
  const real = path.join(FIX, 'claude-projects');
  if (fs.existsSync(real)) {
    for (const slug of fs.readdirSync(real)) for (const sess of fs.readdirSync(path.join(real, slug))) out.real = path.join(real, slug, sess);
  }
  const syn = path.join(FIX, 'synthetic', 'legacy-2.1.206');
  if (fs.existsSync(syn)) {
    for (const slug of fs.readdirSync(syn)) for (const sess of fs.readdirSync(path.join(syn, slug))) out.legacy = path.join(syn, slug, sess);
  }
  return out;
}
const dirs = sessionDirs();
const jsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function parity(name, sessionDir, runId, scenario) {
  const wf = sessionDir && path.join(sessionDir, 'subagents', 'workflows', runId);
  const skip = !wf || !fs.existsSync(wf) ? `fixture ${runId} not present` : false;

  test(`${name}: hand-built journal events match the real journal line by line`, { skip }, () => {
    const lines = jsonl(path.join(wf, 'journal.jsonl'));
    const built = scenario.live.filter((e) => e.prov.file.endsWith('journal.jsonl'));
    assert.equal(built.length, lines.length, 'same number of journal lines');
    for (const ev of built) {
      const real = lines[ev.prov.line - 1];
      assert.ok(real, `journal line ${ev.prov.line} exists`);
      const kind = { launched: 'run.launched', started: 'agent.started', result: 'agent.result' }[real.type];
      assert.equal(ev.kind, kind, `line ${ev.prov.line} type`);
      if (real.type === 'launched') continue;
      assert.equal(ev.data.agentId, real.agentId, `line ${ev.prov.line} agentId`);
      if (real.type === 'started') {
        assert.equal(ev.data.label, real.label, `line ${ev.prov.line} label`);
        assert.equal(ev.data.phase, real.phase, `line ${ev.prov.line} phase`);
      } else {
        assert.deepEqual(ev.data.result, real.result, `line ${ev.prov.line} result`);
      }
    }
  });

  test(`${name}: hand-built transcript events match the real transcripts (prompt, timestamps, tool/text records)`, { skip }, () => {
    const prompts = scenario.live.filter((e) => e.kind === 'agent.prompt');
    assert.ok(prompts.length >= 3);
    for (const id of [...new Set(prompts.map((e) => e.data.agentId))]) {
      const recs = jsonl(path.join(wf, `agent-${id}.jsonl`));
      // every user record before the first assistant record is a leading prompt record
      const firstAssistant = recs.findIndex((r) => r.type === 'assistant');
      const leading = recs.slice(0, firstAssistant).filter((r) => r.type === 'user' && typeof r.message.content === 'string');
      const builtPrompts = prompts.filter((e) => e.data.agentId === id).sort((x, y) => x.prov.line - y.prov.line);
      assert.deepEqual(builtPrompts.map((e) => e.data.text), leading.map((r) => r.message.content), `prompt texts of ${id}`);
      assert.deepEqual(builtPrompts.map((e) => e.prov.line), leading.map((r) => recs.indexOf(r) + 1), `prompt lines of ${id}`);
      assert.deepEqual(builtPrompts.map((e) => e.ts), leading.map((r) => Date.parse(r.timestamp)), `prompt ts of ${id}`);
      const real = recs.filter((r) => r.type === 'assistant' && Array.isArray(r.message.content)
        && r.message.content.some((b) => b.type === 'tool_use' || b.type === 'text'));
      const built = scenario.live.filter((e) => e.kind === 'agent.activity' && e.data.agentId === id);
      assert.deepEqual(built.map((e) => e.ts), real.map((r) => Date.parse(r.timestamp)), `activity timestamps of ${id}`);
      const realTools = real.flatMap((r) => r.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
      assert.deepEqual(built.filter((e) => e.data.tool).map((e) => e.data.tool), realTools, `tool names of ${id}`);
      const att = recs.filter((r) => r.type === 'attachment' && r.attachment?.type === 'structured_output');
      const builtStruct = scenario.live.filter((e) => e.kind === 'agent.structured' && e.data.agentId === id);
      assert.deepEqual(builtStruct.map((e) => [e.ts, e.data.data]), att.map((r) => [Date.parse(r.timestamp), r.attachment.data]), `structured output of ${id}`);
    }
  });

  test(`${name}: hand-built agent meta and final file match the real files`, { skip }, () => {
    for (const e of scenario.live.filter((x) => x.kind === 'agent.meta')) {
      const id = path.basename(e.prov.file).replace(/^agent-|\.meta\.json$/g, '');
      const real = json(path.join(wf, `agent-${id}.meta.json`));
      for (const [k, v] of Object.entries(e.data)) assert.deepEqual(v, real[k], `meta ${id}.${k}`);
    }
    const real = json(path.join(sessionDir, 'workflows', `${runId}.json`));
    const mine = scenario.e.final.data;
    for (const [k, v] of Object.entries(mine)) {
      if (k === 'workflowProgress' || k === 'scriptPath') continue;
      assert.deepEqual(v, real[k], `final.${k}`);
    }
    assert.equal(mine.workflowProgress.length, real.workflowProgress.length);
    mine.workflowProgress.forEach((entry, i) => {
      for (const [k, v] of Object.entries(entry)) assert.deepEqual(v, real.workflowProgress[i][k], `workflowProgress[${i}].${k}`);
    });
    assert.equal(scenario.e.final.ts, Date.parse(real.timestamp), 'final event ts = file write time = final timestamp');
    const script = scenario.e.script.data.meta;
    assert.equal(script.name, real.workflowName);
    if (real.summary) assert.equal(script.description, real.summary);
    assert.deepEqual(script.phases.map((p) => p.title), real.phases.map((p) => p.title));
  });
}

parity('probe 1', dirs.real, 'wf_6509ce25-20a', probe1());
parity('probe 2', dirs.real, 'wf_26eb8d70-5c4', probe2());
parity('legacy', dirs.legacy, 'wf_00000206-leg', legacy());
