// Label pattern (docs/contract.md section 2, contract 2): `role:unit#tag`.
//
//   reviewer:A         -> role "reviewer", unit "A"
//   fix:sum.js#r2      -> role "fix", unit "sum.js", tag "r2", round 2
//   impl:x#carried     -> role "impl", unit "x", tag "carried", round null
//   fixer:round1       -> role "fixer", unit null, round 1   (the whole tail is a round marker)
//   review A round 2   -> role "review A", unit null, round 2
//   judge              -> role "judge", unit null
//
// Everything after the LAST "#" is the tag (any text: r2, v1, carried); the unit never contains it.
// A round comes only from "#r<n>" (the tag is exactly r<n>) or from "round <n>" at the end.
// A "#" with nothing after it ("lang:C#") is not a tag: it stays in the unit. A tail that is itself a
// round marker ("lang:C# round 2") is a round, not a tag.
//
// The pattern is an inference from naming habits, never a requirement: anything that does not
// fit leaves the part null, and the reducer reports it as an unknown Fact.

// "round 2" / "round2" at the very end of the label. "round" must start a word, so
// "surround 2" is not a round marker.
const ROUND_WORD = /(?:^|[^a-z0-9])round\s*(\d+)\s*$/i;
const ROUND_TAIL = /^round\s*\d+$/i; // a "#" tail that is a "round <n>" marker, not a tag
const ROUND_TAG = /^r(\d+)$/i; // the tag "r<n>"
// separators that may stand between the label and its tag or round marker; "#" is not one of them
// (it can end a unit, as in "lang:C#")
const SEPARATORS = /[\s,;_-]+$/;

export function parseLabel(label) {
  const out = { role: null, unit: null, round: null, tag: null };
  if (typeof label !== 'string') return out;
  let s = label.trim();
  if (!s) return out;

  // 1. tag: the text after the last "#"
  let marked = false; // a tag or round marker was cut off: the separator before it goes with it
  const hash = s.lastIndexOf('#');
  if (hash >= 0) {
    const tail = s.slice(hash + 1).trim();
    if (tail !== '' && !ROUND_TAIL.test(tail)) {
      out.tag = tail;
      const r = ROUND_TAG.exec(tail);
      if (r) out.round = Number(r[1]);
      s = s.slice(0, hash);
      marked = true;
    }
  }

  // 2. "round <n>" at the end of what is left (it counts as a round only when "#r<n>" gave none)
  const m = ROUND_WORD.exec(s);
  if (m) {
    if (out.round === null) out.round = Number(m[1]);
    // m[0] starts with the character before "round" (if any); cut at the word itself so a
    // ":" before it stays part of the label ("fixer:round1" -> "fixer:"). A "#" before it is the
    // marker's own ("fix:a#round2") and goes too.
    s = s.slice(0, m.index + (m[0][0] === '#' ? 0 : m[0].search(/round/i)));
    marked = true;
  }
  // Only the separator that stood between the label and its marker goes with the marker
  // ("fix:sum.js - round 2" -> "fix:sum.js"). A label without a marker keeps every character
  // ("lang:C#" has the unit "C#", "a:b_" the unit "b_").
  if (marked) s = s.replace(SEPARATORS, '');
  s = s.trim();

  const colon = s.indexOf(':');
  if (colon < 0) {
    out.role = s || null;
    return out;
  }
  const role = s.slice(0, colon).trim();
  const unit = s.slice(colon + 1).trim();
  out.role = role || null;
  out.unit = unit || null;
  return out;
}
