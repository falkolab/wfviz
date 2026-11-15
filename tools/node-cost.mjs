#!/usr/bin/env node
// Cost of each node of a development run, from the run's own files (read-only).
//
//   node tools/node-cost.mjs <runId> [--root ~/.claude/projects]
//
// Claude: per-agent `tokens` and `durationMs` from the final file workflows/<runId>.json, grouped by
// the unit of the label (role:unit#tag) and by role. Codex: the `usage` string the judge wrapper
// returned (gate template from 2026-11-09), as given; when a judge returned none it is reported as
// unknown with the reason. Claude and Codex tokens are never added together.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findRun(root, runId) {
  for (const slug of fs.readdirSync(root)) {
    const proj = path.join(root, slug);
    if (!fs.statSync(proj).isDirectory()) continue;
    for (const sess of fs.readdirSync(proj)) {
      const final = path.join(proj, sess, 'workflows', `${runId}.json`);
      if (fs.existsSync(final)) return { final, journal: path.join(proj, sess, 'subagents', 'workflows', runId, 'journal.jsonl') };
    }
  }
  return null;
}

// A judge run without --json still ends its log with "tokens used\n<N>" (codex total, no input/output split).
// The gate saved that log under evidence/tmp/judge-<unit>.{log,stderr.txt}; read the total when the judge returned no usage.
export function codexTotalFromLog(text) {
  const m = /^tokens used\s*\n\s*([\d,]+)\s*$/m.exec(String(text));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function judgeLogTotal(unit, dir = path.join(process.cwd(), 'evidence/tmp')) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  // judge-<unit>.log / .stderr.txt (gate template), or judge<run>-<unit>.log (hand-written runs, e.g. workflow 5)
  const files = names.filter((n) => new RegExp(`^judge\\d*-${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(log|stderr\\.txt)$`).test(n));
  for (const name of files) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    const n = codexTotalFromLog(fs.readFileSync(f, 'utf8'));
    if (n !== null) return { total: n, from: path.relative(process.cwd(), f) };
  }
  return null;
}

export function nodeCost(finalJson, journalLines, { logDir } = {}) {
  const agents = (finalJson.workflowProgress || []).filter((a) => a.type === 'workflow_agent');
  const results = new Map();
  for (const line of journalLines) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'result' && r.agentId) results.set(r.agentId, r.result);
  }
  const units = {};
  for (const a of agents) {
    const label = String(a.label || a.agentId);
    const m = /^([^:]+):([^#]+)(?:#.*)?$/.exec(label);
    const role = m ? m[1] : label, unit = m ? m[2] : '(no unit)';
    const u = (units[unit] ??= { agents: 0, claudeTokens: 0, minutes: 0, byRole: {}, codex: [] });
    u.agents += 1;
    u.claudeTokens += a.tokens || 0;
    u.minutes += (a.durationMs || 0) / 60000;
    const r = (u.byRole[role] ??= { agents: 0, claudeTokens: 0 });
    r.agents += 1; r.claudeTokens += a.tokens || 0;
    if (role === 'judge') {
      const res = results.get(a.agentId);
      const fromLog = !(res && typeof res.usage === 'string') && res && res.engine === 'codex-cli' ? judgeLogTotal(unit, logDir) : null;
      u.codex.push(res && typeof res.usage === 'string'
        ? { engine: res.engine, usage: res.usage }
        : fromLog
          ? { engine: res.engine, usage: `${fromLog.total} tokens total as codex printed it ("tokens used"), no input/output split`, from: fromLog.from }
          : { engine: res && res.engine, usage: res && res.engine === 'codex-cli' ? 'unknown: codex ran without --json and no judge log with a total was found' : 'none reported: this judge returned no usage (not a codex judge, or a fallback)' });
    }
  }
  for (const u of Object.values(units)) u.minutes = Math.round(u.minutes * 10) / 10;
  return units;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--root');
  const root = i >= 0 ? argv.splice(i, 2)[1] : path.join(os.homedir(), '.claude', 'projects');
  const runId = argv[0];
  const found = runId && findRun(root, runId);
  if (!found) { console.error(`node-cost: run ${runId} not found under ${root} (the final file appears only at the end)`); process.exit(2); }
  const units = nodeCost(JSON.parse(fs.readFileSync(found.final, 'utf8')), fs.existsSync(found.journal) ? fs.readFileSync(found.journal, 'utf8').split('\n') : []);
  console.log(JSON.stringify({ runId, units }, null, 2));
}
