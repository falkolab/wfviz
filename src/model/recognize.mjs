// Recognised result fields (docs/contract.md section 3).
//
// Applied to every agent result that is a registered/final value of object type (deep, at most
// 3 object levels below the result; arrays are transparent), and, with the same rules and limits, to
// Run.result (the final file's top-level "result"). Recognition is by field NAMES and, for findings, by the
// SHAPE of an array: nothing is guessed from text, and anything not matched stays raw JSON in the detail.
//
//   verdict : field `verdict` (string); optional `reason` / `note` / `summary`
//   finding : array named findings / issues / problems; items (objects) with any of
//             file, line, title, description, severity, input (method "field-name:<name>"); or an array
//             under ANY OTHER key whose every item is an object with `file` and at least one of line,
//             severity, description, input (method "shape:file+<the keys of that item among the four, in this
//             order>"). An empty array, or an array with one item that does not match, is not findings; an array
//             under one of the three names is by name only and is never also read by shape.
//   tests   : object `tests`, or the top-level result, with numeric passed / failed / skipped
//             (total optional); or a string (the result itself, or a string field of an object at most
//             3 levels below the result, the same depth as the other kinds) holding a `node --test` summary:
//             lines "ℹ pass N" / "# pass N", with "fail", "skipped" and "todo" lines after it
//             (contract 2 section 3). Such an item has passed / failed / skipped / todo as far as the
//             summary has them, and method "node-test-summary".
//
// Every item keeps `scope` ("agent": found in an agent result; "run": found in Run.result), `agentId` (null for
// scope "run") and `from` (the Fact's source: a journal "file:line", or the final file for scope "run"), plus `path`
// (where inside the result it was found) and prov "inferred" with the method that matched. Items of the agents come
// first, in run.order, then the items of Run.result.

const MAX_DEPTH = 3;
const MAX_HOPS = 16; // hard stop for pathological nesting (arrays do not count towards MAX_DEPTH)
const FINDING_ARRAYS = new Set(['findings', 'issues', 'problems']);
const FINDING_KEYS = ['file', 'line', 'title', 'description', 'severity', 'input'];
const SHAPE_KEYS = ['line', 'severity', 'description', 'input']; // with `file`, one of these makes an array findings by shape
const REASON_KEYS = ['reason', 'note', 'summary'];
const COUNT_KEYS = ['passed', 'failed', 'skipped', 'total'];
const OUTCOME_KEYS = ['passed', 'failed', 'skipped']; // at least one of these makes it a test result
// One line of a node --test summary: spec reporter "ℹ pass 5", tap reporter "# pass 5".
const SUMMARY_LINE = /^[ \t]*(?:ℹ|#)[ \t]+(pass|fail|skipped|todo)[ \t]+(\d+)[ \t]*\r?$/gm;
const SUMMARY_KEY = { fail: 'failed', skipped: 'skipped', todo: 'todo' };

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isCount = (x) => typeof x === 'number' && Number.isFinite(x);
const keyPath = (path, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

function testsFrom(obj) {
  if (!OUTCOME_KEYS.some((k) => isCount(obj[k]))) return null;
  const t = {};
  for (const k of COUNT_KEYS) if (isCount(obj[k])) t[k] = obj[k];
  return t;
}

// The summaries in a text, in order. A summary starts at its "pass" line; the "fail", "skipped" and
// "todo" lines after it (the first of each) belong to it. Lines before the first "pass" line are
// not a summary.
function nodeTestSummaries(text) {
  const blocks = [];
  let cur = null;
  for (const m of text.matchAll(SUMMARY_LINE)) {
    const n = Number(m[2]);
    if (m[1] === 'pass') {
      cur = { passed: n };
      blocks.push(cur);
    } else if (cur && !(SUMMARY_KEY[m[1]] in cur)) cur[SUMMARY_KEY[m[1]]] = n;
  }
  return blocks;
}

// The method of one item of a findings-by-shape array, or null when the item is not one: an object with `file` and at least
// one of the shape keys. `key in item` as the by-name rule: a present key counts, whatever its value.
function shapeMethod(entry) {
  if (!isObject(entry) || !('file' in entry)) return null;
  const present = SHAPE_KEYS.filter((k) => k in entry);
  return present.length ? `shape:file+${present.join('+')}` : null;
}

// One result root (an agent's result Fact value or Run.result's), with `base` = { scope, agentId, from } on every item.
function scanRoot(root, base, out) {
  const scanString = (text, path) => {
    if (text.length < 8) return; // "ℹ pass 1" is the shortest summary
    for (const t of nodeTestSummaries(text)) out.tests.push({ ...base, path, ...t, prov: 'inferred', method: 'node-test-summary' });
  };

  const visit = (obj, path) => {
    if (typeof obj.verdict === 'string') {
      const item = { ...base, path, verdict: obj.verdict, prov: 'inferred', method: 'field-name:verdict' };
      const why = REASON_KEYS.map((k) => obj[k]).find((v) => typeof v === 'string' && v.trim());
      if (why !== undefined) item.reason = why;
      out.verdicts.push(item);
    }
    const addFinding = (entry, at, method) => {
      const item = { ...base, path: at, prov: 'inferred', method };
      for (const k of FINDING_KEYS) if (k in entry) item[k] = entry[k];
      out.findings.push(item);
    };
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (FINDING_ARRAYS.has(lower) && Array.isArray(value)) {
        value.forEach((entry, i) => {
          if (!isObject(entry) || !FINDING_KEYS.some((k) => k in entry)) return;
          addFinding(entry, `${keyPath(path, key)}[${i}]`, `field-name:${lower}`);
        });
      } else if (Array.isArray(value)) {
        // by shape: every item must match, so one other item (a string, null, an object without `file`) makes the whole array not findings
        const methods = value.map(shapeMethod);
        if (methods.length && methods.every((m) => m !== null)) value.forEach((entry, i) => addFinding(entry, `${keyPath(path, key)}[${i}]`, methods[i]));
      } else if (lower === 'tests' && isObject(value)) {
        const t = testsFrom(value);
        if (t) out.tests.push({ ...base, path: keyPath(path, key), ...t, prov: 'inferred', method: 'field-name:tests' });
      }
    }
  };

  const isTop = (path) => path === '$';
  const walk = (node, depth, hops, path) => {
    if (hops > MAX_HOPS) return;
    if (typeof node === 'string') {
      if (isTop(path)) scanString(node, path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, depth, hops + 1, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    visit(node, path);
    if (isTop(path)) {
      const t = testsFrom(node);
      if (t) out.tests.push({ ...base, path, ...t, prov: 'inferred', method: 'field-name:passed/failed/skipped' });
    }
    // string fields of every object the walk visits (the same depth limit as verdicts and findings)
    for (const [key, value] of Object.entries(node)) if (typeof value === 'string') scanString(value, keyPath(path, key));
    if (depth >= MAX_DEPTH) return;
    for (const [key, value] of Object.entries(node)) {
      if (value !== null && typeof value === 'object') walk(value, depth + 1, hops + 1, keyPath(path, key));
    }
  };
  walk(root, 0, 0, '$');
}

// A Fact that can be scanned: known, and an object, an array or a string (a number, a boolean or null holds nothing).
const scannable = (fact) => !!fact && fact.prov !== 'unknown' && (typeof fact.value === 'string' || (fact.value !== null && typeof fact.value === 'object'));

export function recognize(run) {
  const out = { findings: [], verdicts: [], tests: [] };
  if (!run) return out;
  const ids = run.agents ? (Array.isArray(run.order) ? run.order : Object.keys(run.agents)) : [];

  for (const agentId of ids) {
    const fact = run.agents[agentId]?.result;
    if (scannable(fact)) scanRoot(fact.value, { scope: 'agent', agentId, from: fact.from ?? null }, out);
  }
  // the run's own result (the final file's "result"): the same rules and limits, after the agents; no agent owns these items.
  // A Run with no `result`, or one whose result is unknown or null, gives nothing here.
  if (scannable(run.result)) scanRoot(run.result.value, { scope: 'run', agentId: null, from: run.result.from ?? null }, out);
  return out;
}
