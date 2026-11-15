// Dependency inference (docs/contract.md section 2, contract 2). No source registers dependencies, so
// every edge here is `prov: "inferred"` and carries the text that justifies it.
//
//   data-flow / strong : A -> B when ALL of
//                        1. A ended before B started (strictly: equal clocks carry no order);
//                        2. B's prompt contains a normalised substring S of A's result serialisation
//                           (JSON.stringify for objects) of >= 64 chars;
//                        3. S occurs in the result of no other agent that ended before B started
//                           (a unique source: two agents with the same result feed nobody);
//                        4. S occurs neither in the run's script text nor in the prompts of >= 2 other
//                           agents (text shared like that is boilerplate: a guide, a schema, a contract).
//                        evidence = the first 80 chars of S (whitespace collapsed) and its length.
//   time-order / weak  : B started <= 1500 ms after A ended, in a later phase, and no data-flow
//                        edge exists into B.
//
// Contract 1 used >= 24 chars and no uniqueness; it gave 533 false edges out of 810 on a real run.
//
// "Normalised" = all whitespace removed from both texts, so a pretty-printed or line-indented
// copy (the workflow harness indents every prompt line) still matches. The 64 characters are
// counted after normalisation. A result shorter than 64 normalised chars (e.g. "gamma fast done", or
// {"verdict":"pass","note":"A saw x=1"}) can never produce an edge: that is a limit of the evidence,
// not a missing feature.
//
// Which S. Every substring of a common region (a maximal run of normalised chars that B's prompt
// and A's result share) that is >= 64 chars long is a candidate, and a longer one is never easier to
// find elsewhere than a shorter one inside it. So each maximal common region is tested as a whole,
// longest first, and the first region that passes 3 and 4 is the evidence (one edge per pair).
// A skeleton shared with other results ({"verdict":"fail","findings":[{"file":"...) therefore does
// not make an edge by itself, but a region that holds the skeleton and a unique quotation does.
//
// The script text is not part of the Run (it can be large): the caller passes it as opts.scriptText.
// Without it rule 4 checks the prompts only.
//
// Time facts whose method is "journal-event-ts" (journal records carry no timestamp, the event
// ts is only the file time) are not accurate enough for the 1500 ms rule and are ignored there.
//
// Cost. Every distinct result text is indexed once: a chained hash table over a rolling hash of
// each 64-gram, kept in typed arrays (about 16 bytes per indexed char, no per-gram objects), and
// each prompt is scanned once against it; that finds the common regions. Rules 3 and 4 are then
// checked for the regions found only: the index names the results that hold the region's first and
// last 64-gram (so a handful of native substring searches replaces a scan of all results), and the
// prompts and the script are searched natively. Rule 4 against the prompts is one pass over every
// distinct prompt, and candidates with the same region text (one result quoted by many later prompts)
// are one question: the region is compared natively once per prompt that holds it, not once per
// candidate. Three limits bound the work (DEFAULT_LIMITS). When one is hit the part that was not
// examined is NOT silently dropped: inferEdges reports it through opts.warn (the reducer puts it into
// run.warnings). When the pass over the prompts is stopped, an edge whose region was already found in
// MAX_SHARING_PROMPTS other prompts is dropped (that is final), the remaining candidates cannot be
// decided and are left out, and the warning says how many edges that is. opts.memo lets a caller (the
// store) reuse the edges of the previous call while none of the inputs of the inference changed.
//
// No region is skipped for being one of many. Contract section 2 has no cap on the number of common regions
// of a pair, and a cap by length (longest first) is not a cap by distinctiveness: the region that passes
// rules 3 and 4 can be a short one among many long boilerplate ones (real run wf_89d391f0-ded: 19 regions in
// find:steelman-survival -> synthesis, the passing ones rank 15 to 18). Every region found is tested; the
// work limit alone bounds the cost: each region found costs at least its own length (>= 64 steps) in the
// scan, and the tests of the regions (hashing and native searches) have a budget of the same size of their
// own, like the pass over the prompts. When either budget runs out the stop is reported, as below.
//
// inferEdges(run, opts?) -> Edge[]
//   opts: { warn?: (message) => void, memo?: object, limits?: {...}, scriptText?: string | null }

export const MIN_SHARED_CHARS = 64;
export const MAX_GAP_MS = 1500;
export const MAX_SHARING_PROMPTS = 2; // a region found in this many OTHER prompts is boilerplate
export const DEFAULT_LIMITS = Object.freeze({
  maxTextChars: 4_000_000, // non-space chars examined per text (one result, or one prompt)
  maxIndexChars: 4_000_000, // non-space chars of all indexed results together
  maxWork: 64_000_000, // steps: grams scanned + hash-chain steps + chars compared + native searches (about a second at most)
});

const BASE = 0x9e3779b1 | 0;
const POW = (() => {
  let p = 1;
  for (let i = 0; i < MIN_SHARED_CHARS; i++) p = Math.imul(p, BASE);
  return p; // BASE ** MIN_SHARED_CHARS modulo 2 ** 32
})();

// same set as the regex class \s (checked for every UTF-16 code unit)
function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
const COARSE_TIME_METHODS = new Set(['journal-event-ts']);

const known = (f) => f && typeof f === 'object' && f.prov !== 'unknown';
const numberOf = (f) => (known(f) && typeof f.value === 'number' && Number.isFinite(f.value) ? f.value : null);
const preciseNumberOf = (f) => (COARSE_TIME_METHODS.has(f?.method) ? null : numberOf(f));

function serialise(value) {
  if (typeof value === 'string') return value;
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

// -> { str, codes, n, omitted }: the first `cap` non-space UTF-16 code units of text, as a string
// and as codes; `omitted` counts the non-space chars beyond the cap (they are not examined).
function normalise(text, cap) {
  const full = text.replace(/\s+/g, '');
  const n = Math.min(full.length, cap);
  const str = full.length > n ? full.slice(0, n) : full;
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) codes[i] = str.charCodeAt(i);
  return { str, codes, n, omitted: full.length - n };
}

// First 80 chars of the normalised chars [startN, startN + lenN) of src, whitespace collapsed to one
// space; "..." follows when more than 80 chars were cut off.
function snippetOf(src, startN, lenN) {
  const last = startN + lenN - 1;
  let n = 0;
  let out = '';
  let gap = false;
  for (let i = 0; i < src.length && n <= last; i++) {
    const c = src.charCodeAt(i);
    if (isSpace(c)) {
      if (n > startN) gap = true;
      continue;
    }
    if (n >= startN) {
      if (gap) out += ' ';
      out += src[i];
      gap = false;
      if (out.length > 80) return `${out.slice(0, 80)}...`;
    }
    n++;
  }
  return out;
}

// Everything the inference reads, flattened; two snapshots are equal when the inference would
// give the same edges. Strings compare by value, result objects by reference.
function snapshotOf(run, order, scriptText) {
  const s = [];
  for (const p of Array.isArray(run.phases) ? run.phases : []) s.push(p?.title, p?.index);
  s.push('|');
  for (const id of order) {
    const a = run.agents[id];
    s.push(
      id,
      known(a.label) && typeof a.label.value === 'string' ? a.label.value : null,
      known(a.phase) && typeof a.phase.value === 'string' ? a.phase.value : null,
      numberOf(a.startedAt), COARSE_TIME_METHODS.has(a.startedAt?.method),
      numberOf(a.endedAt), COARSE_TIME_METHODS.has(a.endedAt?.method),
      known(a.prompt) && typeof a.prompt.value === 'string' ? a.prompt.value : null,
      known(a.result) ? a.result.value : undefined,
    );
  }
  s.push('|', scriptText);
  return s;
}
const sameSnapshot = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

function listNames(names) {
  const shown = names.slice(0, 3).map((n) => `"${n}"`).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export function inferEdges(run, opts = {}) {
  const edges = [];
  if (!run || !run.agents || typeof run.agents !== 'object') return edges;
  const { warn, memo } = opts ?? {};
  const limits = { ...DEFAULT_LIMITS, ...(opts?.limits ?? {}) };
  const scriptText = typeof opts?.scriptText === 'string' ? opts.scriptText : null;
  const order = (Array.isArray(run.order) ? run.order : Object.keys(run.agents)).filter((id) => run.agents[id]);

  const limitsKey = `${limits.maxTextChars}/${limits.maxIndexChars}/${limits.maxWork}`;
  let snap = null;
  if (memo && typeof memo === 'object') {
    snap = snapshotOf(run, order, scriptText);
    if (memo.snap && memo.limitsKey === limitsKey && sameSnapshot(memo.snap, snap)) {
      if (typeof warn === 'function') for (const m of memo.notes) warn(m);
      return memo.edges.map((e) => ({ ...e }));
    }
  }

  const pos = new Map(order.map((id, i) => [id, i]));
  const agent = (id) => run.agents[id];
  const nameOf = (id) => {
    const l = agent(id).label;
    return known(l) && typeof l.value === 'string' && l.value ? l.value : id;
  };
  const notes = [];

  // A must have a known end, strictly before B's known start, to be a source of data.
  const precedes = (aId, bId) => {
    const ae = numberOf(agent(aId).endedAt);
    const bs = numberOf(agent(bId).startedAt);
    return ae !== null && bs !== null && ae < bs;
  };

  // ---- data-flow: index every distinct result text once, scan each prompt once.
  const groups = []; // one per distinct serialised result: { agents: [id], src, str, codes, n }
  const byText = new Map();
  let budget = limits.maxIndexChars;
  const cut = []; // names of agents whose result was examined only in part or not at all
  for (const id of order) {
    const f = agent(id).result;
    if (!known(f)) continue;
    const text = serialise(f.value);
    if (text === null || text.length < MIN_SHARED_CHARS) continue;
    const same = byText.get(text);
    if (same) {
      same.agents.push(id);
      continue;
    }
    if (budget < MIN_SHARED_CHARS) {
      cut.push(nameOf(id));
      continue;
    }
    const norm = normalise(text, Math.min(limits.maxTextChars, budget));
    if (norm.n < MIN_SHARED_CHARS) continue;
    budget -= norm.n;
    if (norm.omitted > 0) cut.push(nameOf(id));
    const group = { agents: [id], src: text, str: norm.str, codes: norm.codes, n: norm.n };
    groups.push(group);
    byText.set(text, group);
  }
  if (cut.length) {
    notes.push(`edge inference: the results of ${listNames(cut)} were examined only in part or not at all `
      + `(limits: ${limits.maxTextChars} non-space chars per text, ${limits.maxIndexChars} for all results together); `
      + 'shared text beyond the limits is not detected, so data-flow edges from these agents may be missing, '
      + 'and an edge from another agent may stand although that text also occurs in them');
  }

  const strongInto = new Set();
  const G = groups.length;
  if (G > 0) {
    const starts = new Int32Array(G);
    let total = 0;
    let nGrams = 0;
    groups.forEach((g, gi) => {
      starts[gi] = total;
      total += g.n;
      nGrams += g.n - MIN_SHARED_CHARS + 1;
    });
    const codes = new Uint16Array(total);
    groups.forEach((g, gi) => codes.set(g.codes.subarray(0, g.n), starts[gi]));

    const bits = Math.max(10, 32 - Math.clz32(Math.max(1, nGrams - 1)));
    const shift = 32 - bits;
    const bucket = (h) => Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> shift;
    const head = new Int32Array(1 << bits).fill(-1);
    // A bit filter over the indexed 64-grams, 8 bits per gram (at most 8 MB): a prompt window is looked up here, where
    // it stays in the CPU cache, before the far larger `head` and `hs` tables are touched; about 7 windows in 8 of a
    // prompt that shares little with the results stop here
    const fbits = Math.min(26, Math.max(10, 32 - Math.clz32(Math.max(1, nGrams) * 8)));
    const fshift = 32 - fbits;
    const fslot = (h) => Math.imul(h ^ (h >>> 13), 0x85ebca6b) >>> fshift;
    const filter = new Uint8Array(1 << (fbits - 3));
    const next = new Int32Array(total);
    const hs = new Int32Array(total);
    for (let gi = 0; gi < G; gi++) {
      const s = starts[gi];
      const lastP = groups[gi].n - MIN_SHARED_CHARS;
      let h = 0;
      for (let k = 0; k < MIN_SHARED_CHARS; k++) h = (Math.imul(h, BASE) + codes[s + k]) | 0;
      for (let p = 0; p <= lastP; p++) {
        const g = s + p;
        if (p > 0) h = (Math.imul(h, BASE) + codes[g + MIN_SHARED_CHARS - 1] - Math.imul(codes[g - 1], POW)) | 0;
        hs[g] = h;
        const b = bucket(h);
        // keep the first offset of each distinct gram per text: entries of this text sit at the chain head
        let dup = false;
        for (let q = head[b]; q >= s; q = next[q]) {
          if (hs[q] !== h) continue;
          let k = 0;
          while (k < MIN_SHARED_CHARS && codes[q + k] === codes[g + k]) k++;
          if (k === MIN_SHARED_CHARS) { dup = true; break; }
        }
        if (dup) continue;
        next[g] = head[b];
        head[b] = g;
        const f = fslot(h);
        filter[f >> 3] |= 1 << (f & 7);
      }
    }
    const groupAt = (g) => {
      let lo = 0;
      let hi = G - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= g) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    // the groups whose text holds the 64-gram pc[at .. at + 64)
    const groupsWith = (pc, at) => {
      let h = 0;
      for (let k = 0; k < MIN_SHARED_CHARS; k++) h = (Math.imul(h, BASE) + pc[at + k]) | 0;
      const found = new Set();
      for (let g = head[bucket(h)]; g !== -1; g = next[g]) {
        if (hs[g] !== h) continue;
        let k = 0;
        while (k < MIN_SHARED_CHARS && codes[g + k] === pc[at + k]) k++;
        if (k === MIN_SHARED_CHARS) found.add(groupAt(g));
      }
      return found;
    };

    // ---- phase 1: for every prompt, the regions it shares with a unique-source result (rules 1 to 3 and the
    // script part of rule 4); `work` counts steps, one per window scanned, chain entry, char compared or
    // 64 chars searched natively
    let work = 0;
    const searchCost = (len) => 1 + (len >> 6);
    const scriptStr = scriptText === null ? null : normalise(scriptText, limits.maxTextChars).str;
    const promptStr = new Map(); // agent id -> its normalised prompt (cut at maxTextChars), kept for phase 2
    const normPrompt = (id) => {
      let str = promptStr.get(id);
      if (str === undefined) {
        const pf = agent(id).prompt;
        str = known(pf) && typeof pf.value === 'string' && pf.value.length >= MIN_SHARED_CHARS ? normalise(pf.value, limits.maxTextChars).str : '';
        promptStr.set(id, str);
      }
      return str;
    };
    const cands = []; // candidate regions, grouped by (B, A) and longest first: { pair, from, to, bs, i, len, rp, gi }
    let pairNo = 0; // pairs (B, A) that have at least one common region
    let testWork = 0; // steps of the region tests, against limits.maxWork (a budget of its own)
    const spend = (n) => { work += n; testWork += n; }; // a step of a region test counts for the scan budget too

    const nextWin = new Int32Array(G); // first prompt offset not yet covered by a measured run
    const elig = new Int32Array(G); // members of the group that ended before the current B started
    const eligSrc = new Array(G); // ... and the last of them
    const cutPrompts = [];
    let stoppedAt = null;
    for (const bId of order) {
      if (numberOf(agent(bId).startedAt) === null) continue;
      const pf = agent(bId).prompt;
      if (!known(pf) || typeof pf.value !== 'string' || pf.value.length < MIN_SHARED_CHARS) continue;
      let any = false;
      for (let gi = 0; gi < G; gi++) {
        let n = 0;
        for (const aId of groups[gi].agents) if (aId !== bId && precedes(aId, bId)) { n++; eligSrc[gi] = aId; }
        elig[gi] = n;
        if (n === 1) any = true; // two or more: the text has no unique source, so none of them is an edge
      }
      if (!any) continue;
      const pn = normalise(pf.value, limits.maxTextChars);
      if (pn.n < MIN_SHARED_CHARS) continue;
      promptStr.set(bId, pn.str);
      if (pn.omitted > 0) cutPrompts.push(nameOf(bId));
      const pc = pn.codes;
      const m = pn.n;
      nextWin.fill(0);
      const runs = []; // by group: the common regions { i: prompt offset, rp: result offset, len }

      let h = 0;
      for (let k = 0; k < MIN_SHARED_CHARS; k++) h = (Math.imul(h, BASE) + pc[k]) | 0;
      for (let i = 0; i + MIN_SHARED_CHARS <= m; i++) {
        if (i > 0) h = (Math.imul(h, BASE) + pc[i + MIN_SHARED_CHARS - 1] - Math.imul(pc[i - 1], POW)) | 0;
        work++;
        if (work > limits.maxWork) { stoppedAt = bId; break; }
        const f = fslot(h);
        if ((filter[f >> 3] & (1 << (f & 7))) === 0) continue;
        for (let g = head[bucket(h)]; g !== -1; g = next[g]) {
          work++;
          if (hs[g] !== h) continue;
          const gi = groupAt(g);
          if (elig[gi] !== 1 || i < nextWin[gi]) continue;
          let k = 0;
          while (k < MIN_SHARED_CHARS && codes[g + k] === pc[i + k]) k++;
          if (k < MIN_SHARED_CHARS) continue; // hash collision
          const p = g - starts[gi];
          const end = groups[gi].n;
          let len = MIN_SHARED_CHARS;
          while (i + len < m && p + len < end && pc[i + len] === codes[g + len]) len++;
          let back = 0;
          while (i - back > 0 && p - back > 0 && pc[i - back - 1] === codes[g - back - 1]) back++;
          work += len + back;
          nextWin[gi] = i + len - MIN_SHARED_CHARS + 1;
          (runs[gi] ??= []).push({ i: i - back, rp: p - back, len: len + back });
        }
      }

      // rule 3 and the script part of rule 4 for every region found, longest first (no cap on their number; the
      // budget of the tests stops the pass: what was tested so far stays, and the stop is reported)
      testing: for (let gi = 0; gi < G; gi++) {
        const list = runs[gi];
        if (!list) continue;
        list.sort((x, y) => y.len - x.len || x.i - y.i);
        const pair = pairNo++;
        for (let t = 0; t < list.length; t++) {
          if (testWork > limits.maxWork) {
            if (stoppedAt === null) stoppedAt = bId;
            break testing;
          }
          const r = list[t];
          testWork += 2 * MIN_SHARED_CHARS; // hashing the region's first and last 64-gram
          // rule 4: not in the script
          if (scriptStr !== null) {
            spend(searchCost(scriptStr.length));
            if (scriptStr.includes(pn.str.slice(r.i, r.i + r.len))) continue;
          }
          // rule 3: not in the result of any other agent that ended before B started. Such a result holds
          // the region's first and its last 64-gram; only those are searched.
          let shared = false;
          const first = groupsWith(pc, r.i);
          const last = r.len === MIN_SHARED_CHARS ? first : groupsWith(pc, r.i + r.len - MIN_SHARED_CHARS);
          for (const gj of first) {
            if (gj === gi || elig[gj] === 0 || !last.has(gj)) continue;
            spend(searchCost(groups[gj].str.length));
            if (groups[gj].str.includes(pn.str.slice(r.i, r.i + r.len))) { shared = true; break; }
          }
          if (shared) continue;
          cands.push({ pair, from: eligSrc[gi], to: bId, bs: pn.str, i: r.i, len: r.len, rp: r.rp, gi });
        }
      }
      if (stoppedAt !== null) break;
    }

    // ---- phase 2: rule 4, prompts. How many OTHER agents have a prompt that holds the region? Candidates that carry
    // the same region text (a result that several later prompts quote) are one question, asked once: the answer is
    // the number of agents whose prompt holds the text, minus B itself, whose prompt holds it by construction. One pass
    // over every distinct prompt text: the rolling hash of each of its 64-grams is looked up among the first 64-grams
    // of the distinct regions; only a hit is compared with the region itself, natively (startsWith: a region that is in
    // a prompt starts at a window of it whose hash is the region's first one). Cost: one step per prompt char, plus one
    // step per 64 chars of a region that is compared.
    let kept = cands;
    let phase2Stopped = false;
    let undecided = 0;
    if (cands.length) {
      const texts = new Map(); // normalised prompt -> number of agents with exactly this prompt
      for (const id of order) {
        const str = normPrompt(id);
        if (str.length >= MIN_SHARED_CHARS) texts.set(str, (texts.get(str) ?? 0) + 1);
      }
      const hashAt = (str, at) => {
        let x = 0;
        for (let k = 0; k < MIN_SHARED_CHARS; k++) x = (Math.imul(x, BASE) + str.charCodeAt(at + k)) | 0;
        return x;
      };
      const regionIndex = new Map(); // region text -> index in `regions`
      const regions = []; // distinct region texts
      const regionOfCand = new Int32Array(cands.length);
      const query = new Map(); // hash of a first 64-gram -> region indexes
      cands.forEach((c, k) => {
        const text = c.bs.slice(c.i, c.i + c.len);
        let r = regionIndex.get(text);
        if (r === undefined) {
          r = regions.length;
          regionIndex.set(text, r);
          regions.push(text);
          const x = hashAt(text, 0);
          const list = query.get(x);
          if (list) list.push(r);
          else query.set(x, [r]);
        }
        regionOfCand[k] = r;
      });
      const qBits = Math.max(16, 32 - Math.clz32(query.size * 16));
      const qShift = 32 - qBits;
      const qSlot = (x) => Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> qShift;
      const seen = new Uint8Array(1 << qBits); // a cheap "is this hash worth a Map lookup" filter
      for (const x of query.keys()) seen[qSlot(x)] = 1;
      const holding = new Int32Array(regions.length); // agents whose prompt holds the region
      const lastText = new Int32Array(regions.length).fill(-1);
      const scanned = new Set(); // the prompt texts counted so far
      let work2 = 0;
      let t = 0;
      for (const [str, count] of texts) {
        work2 += str.length;
        if (work2 > limits.maxWork) { phase2Stopped = true; break; }
        scanned.add(str);
        let x = 0;
        for (let k = 0; k < MIN_SHARED_CHARS - 1; k++) x = (Math.imul(x, BASE) + str.charCodeAt(k)) | 0;
        for (let i = 0; i + MIN_SHARED_CHARS <= str.length; i++) {
          x = i === 0 ? (Math.imul(x, BASE) + str.charCodeAt(MIN_SHARED_CHARS - 1)) | 0
            : (Math.imul(x, BASE) + str.charCodeAt(i + MIN_SHARED_CHARS - 1) - Math.imul(str.charCodeAt(i - 1), POW)) | 0;
          if (seen[qSlot(x)] === 0) continue;
          const list = query.get(x);
          if (list === undefined) continue;
          for (const r of list) {
            if (lastText[r] === t) continue; // counted for this text already
            const text = regions[r];
            work2 += 1;
            if (!str.startsWith(text, i)) continue; // hash collision, or only the start is shared
            work2 += text.length >> 6;
            lastText[r] = t;
            holding[r] += count;
          }
        }
        t++;
      }
      if (phase2Stopped) {
        // what was counted so far is a lower bound: a region already held by MAX_SHARING_PROMPTS other agents is
        // boilerplate whatever the rest says and is dropped for good (the prompt of B counts only once it was scanned);
        // the others cannot be decided and are left out
        const open = new Set(); // pairs (B, A) that may still have had an edge
        cands.forEach((c, k) => {
          if (holding[regionOfCand[k]] - (scanned.has(c.bs) ? 1 : 0) < MAX_SHARING_PROMPTS) open.add(c.pair);
        });
        undecided = open.size;
        kept = [];
      } else kept = cands.filter((c, k) => holding[regionOfCand[k]] - 1 < MAX_SHARING_PROMPTS);
    }
    // one edge per (B, A): the longest region that passed everything
    const done = new Set();
    for (const c of kept) {
      if (done.has(c.pair)) continue;
      done.add(c.pair);
      edges.push({
        from: c.from,
        to: c.to,
        kind: 'data-flow',
        strength: 'strong',
        evidence: `prompt of "${nameOf(c.to)}" repeats ${c.len} non-space chars of the result of "${nameOf(c.from)}": ${snippetOf(groups[c.gi].src, c.rp, c.len)}`,
        prov: 'inferred',
      });
      strongInto.add(c.to);
    }

    if (cutPrompts.length) {
      notes.push(`edge inference: the prompts of ${listNames(cutPrompts)} were examined only in part `
        + `(limit: ${limits.maxTextChars} non-space chars per text); shared text beyond the limit is not detected, `
        + 'so data-flow edges into these agents may be missing');
    }
    if (stoppedAt !== null) {
      notes.push(`edge inference stopped after ${limits.maxWork} steps (work limit); data-flow edges into `
        + `"${nameOf(stoppedAt)}" and into agents after it may be missing`);
    }
    if (phase2Stopped) {
      notes.push(`edge inference stopped after ${limits.maxWork} steps (work limit) while checking the shared text against `
        + `all prompts; ${undecided} data-flow edge${undecided === 1 ? '' : 's'} that ${undecided === 1 ? 'was' : 'were'} found but not checked `
        + `${undecided === 1 ? 'is' : 'are'} left out, so data-flow edges may be missing`);
    }
  }

  // ---- time-order: weak hint between consecutive phases.
  const phaseNo = new Map();
  (Array.isArray(run.phases) ? run.phases : []).forEach((p, i) => {
    if (p && typeof p.title === 'string') phaseNo.set(p.title, typeof p.index === 'number' ? p.index : i + 1);
  });
  const phaseOf = (id) => {
    const f = agent(id).phase;
    return known(f) && typeof f.value === 'string' && phaseNo.has(f.value) ? phaseNo.get(f.value) : null;
  };
  for (const bId of order) {
    if (strongInto.has(bId)) continue;
    const bs = preciseNumberOf(agent(bId).startedAt);
    const pb = phaseOf(bId);
    if (bs === null || pb === null) continue;
    for (const aId of order) {
      if (aId === bId) continue;
      const ae = preciseNumberOf(agent(aId).endedAt);
      const pa = phaseOf(aId);
      if (ae === null || pa === null || pa >= pb) continue;
      const gap = bs - ae;
      if (gap < 0 || gap > MAX_GAP_MS) continue;
      edges.push({
        from: aId,
        to: bId,
        kind: 'time-order',
        strength: 'weak',
        evidence: `"${nameOf(bId)}" started ${gap} ms after "${nameOf(aId)}" ended, in a later phase (${agent(aId).phase.value} -> ${agent(bId).phase.value})`,
        prov: 'inferred',
      });
    }
  }

  edges.sort(
    (x, y) =>
      pos.get(x.to) - pos.get(y.to) ||
      (x.kind === y.kind ? 0 : x.kind === 'data-flow' ? -1 : 1) ||
      pos.get(x.from) - pos.get(y.from),
  );

  if (snap) {
    memo.snap = snap;
    memo.limitsKey = limitsKey;
    memo.edges = edges.map((e) => ({ ...e }));
    memo.notes = notes;
  }
  if (typeof warn === 'function') for (const m of notes) warn(m);
  return edges;
}
