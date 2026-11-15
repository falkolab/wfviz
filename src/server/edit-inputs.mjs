// src/server/edit-inputs.mjs (node U1): the full inputs of edit tools for the transcript endpoint.
//
// Why this exists. Contract 2 (docs/contract.md sections 1, 2 and 4, docs/c-rev-proposal.md item 6) says the
// reader's raw `agent.activity` events carry the full input of Edit / Write / MultiEdit / NotebookEdit calls
// (`input`, `inputTruncated`), that a Run keeps only `{ ts, tool, inputSummary, text }` per activity entry, and that
// "full edit inputs live only in the transcript endpoint". The store's public interface has no accessor for the
// rest, so the launcher shows every raw event to this tracker as well as to the store, and the transcript endpoint
// asks the tracker to put the inputs back on the entries it serves.
//
// What it keeps: for every agent.activity event that carries an `input` object or `inputTruncated: true`, one entry
// `{ ts, tool?, inputSummary?, input?, inputTruncated? }`. It holds the very objects the store holds (no copy), at most
// `maxPerAgent` per agent (the oldest go first). It decides nothing about tool names: whatever the reader put an
// input on is kept. It invents nothing: a value that is not in the event is not in the entry.
//
// Matching. A Run's activity entry is matched to a tracked entry by (ts, tool, inputSummary), each tracked entry at
// most once, in arrival order. A tracked entry that matches nothing and is older than the first entry the Run still
// holds (the Run keeps the last 50) is added in front: an edit made early in a long agent stays visible.

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const DEFAULT_MAX_PER_AGENT = 200;

// "agent-<id>.jsonl" -> "<id>", as the reader names agents whose event data has no agentId.
function agentIdFromFile(file) {
  const m = /agent-([^/\\]+?)\.(?:meta\.json|jsonl|prefix\.json)$/.exec(typeof file === 'string' ? file : '');
  return m ? m[1] : null;
}

const sigOf = (e) => `${isNum(e.ts) ? e.ts : ''}|${e.tool ?? ''}|${e.inputSummary ?? ''}`;

/**
 * @param {{ maxPerAgent?: number }} [options]
 * @returns {{
 *   record(event: object): void,
 *   attach(runId: string, agentId: string, activity: object[]): object[],
 * }}
 */
export function createEditInputTracker({ maxPerAgent = DEFAULT_MAX_PER_AGENT } = {}) {
  const cap = Number.isInteger(maxPerAgent) && maxPerAgent > 0 ? maxPerAgent : DEFAULT_MAX_PER_AGENT;
  /** @type {Map<string, Map<string, Map<string, object>>>} runId -> agentId -> key -> entry (insertion order) */
  const runs = new Map();
  let anonymous = 0;

  function record(event) {
    if (!isObj(event) || event.kind !== 'agent.activity' || !isStr(event.runId) || !isObj(event.data)) return;
    const d = event.data;
    const hasInput = isObj(d.input);
    if (!hasInput && d.inputTruncated !== true) return;
    const agentId = isStr(d.agentId) ? d.agentId : agentIdFromFile(event.prov?.file);
    if (agentId === null) return;

    const entry = { ts: isNum(event.ts) ? event.ts : null };
    if (isStr(d.tool)) entry.tool = d.tool;
    if (typeof d.inputSummary === 'string') entry.inputSummary = d.inputSummary;
    if (hasInput) entry.input = d.input;
    if (d.inputTruncated === true) entry.inputTruncated = true;

    // The same transcript line read again is the same entry (the store ignores it too); a line without a line number
    // cannot be told apart, so each such event is its own entry.
    const line = event.prov?.line;
    const key = Number.isInteger(line)
      ? `${event.prov.file ?? ''}|${line}|${entry.tool ?? ''}|${entry.inputSummary ?? ''}`
      : `#${++anonymous}`;

    let agents = runs.get(event.runId);
    if (!agents) runs.set(event.runId, (agents = new Map()));
    let entries = agents.get(agentId);
    if (!entries) agents.set(agentId, (entries = new Map()));
    entries.set(key, entry);
    while (entries.size > cap) entries.delete(entries.keys().next().value);
  }

  function attach(runId, agentId, activity) {
    const list = Array.isArray(activity) ? activity : [];
    const tracked = runs.get(runId)?.get(agentId);
    if (!tracked || tracked.size === 0) return list;

    const bySig = new Map();
    for (const e of tracked.values()) {
      const s = sigOf(e);
      if (!bySig.has(s)) bySig.set(s, []);
      bySig.get(s).push(e);
    }
    const used = new Set();
    const merged = list.map((item) => {
      // an entry that already carries its input (a store that keeps it) is served as it is
      if (!isObj(item) || 'input' in item || 'inputTruncated' in item) return item;
      const hit = bySig.get(sigOf(item))?.shift();
      if (!hit) return item;
      used.add(hit);
      const out = { ...item };
      if ('input' in hit) out.input = hit.input;
      if (hit.inputTruncated === true) out.inputTruncated = true;
      return out;
    });

    const firstTs = list.find((item) => isObj(item) && isNum(item.ts))?.ts;
    const older = [...tracked.values()]
      .filter((e) => !used.has(e) && isNum(e.ts) && (firstTs === undefined || e.ts < firstTs))
      .sort((x, y) => x.ts - y.ts)
      .map((e) => ({ ...e }));
    return older.length ? [...older, ...merged] : merged;
  }

  return { record, attach };
}
