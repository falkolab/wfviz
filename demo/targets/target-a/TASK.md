# Target A: three small helpers

A tiny JS library with three independent units. Each unit is one ES module `src/<unit>.mjs`
with one named export, and has a pre-written test file `test/<unit>.test.mjs`, run with
`node --test test/<unit>.test.mjs`. The tests are the contract: do not edit, skip or delete them.

Rules for every unit: ES modules, Node >= 20, no dependencies, no network, no package.json.
The starting code in `src/` is incomplete or contains a bug; make the tests pass with a real
implementation of the spec below, not by special-casing test inputs.

## slugify

File `src/slugify.mjs`, export `slugify(input)`. Turns text into a URL slug.

1. `input` must be a string; anything else throws `TypeError`.
2. Lowercase the text.
3. Remove diacritics: decompose with Unicode NFKD and drop the combining marks
   (U+0300 to U+036F). `"Crème Brûlée"` becomes `"creme-brulee"`; `"x\u00b2"` (x and
   U+00B2, superscript two) becomes `"x2"`.
4. Every run of one or more characters that are not `a-z` or `0-9` becomes exactly one `-`.
5. The result has no leading or trailing `-`.
6. If nothing is left, the result is the empty string.

Examples: `"Hello World"` gives `"hello-world"`; `"  --Hello, World!--  "` gives `"hello-world"`;
`"Version 2.0 (final)"` gives `"version-2-0-final"`; `"***"` gives `""`.

## chunk

File `src/chunk.mjs`, export `chunk(array, size)`. Splits an array into consecutive pieces.

1. `array` must be an `Array`; anything else throws `TypeError`.
2. `size` must be a number that is an integer and at least 1; anything else (0, negative, 1.5,
   `NaN`, `Infinity`, the string `"2"`, `undefined`) throws `RangeError`.
3. The result is a new array of new arrays. Every piece has `size` elements except the last,
   which may be shorter. Element order is preserved.
4. An empty array gives `[]`.
5. The input array is not modified.

Examples: `chunk([1, 2, 3, 4, 5], 2)` gives `[[1, 2], [3, 4], [5]]`; `chunk([1, 2, 3], 5)` gives
`[[1, 2, 3]]`.

## duration

File `src/duration.mjs`, export `parseDuration(input)`. Parses a short duration string and
returns the total number of seconds as an integer.

1. `input` must be a string; anything else throws `TypeError`.
2. Format: one to four parts, each one or more ASCII digits followed by a lowercase unit letter:
   `d` (86400 s), `h` (3600 s), `m` (60 s), `s` (1 s).
3. Units appear in the order `d`, `h`, `m`, `s`, and each at most once.
4. Between two parts there may be one single space or nothing. No other whitespace, and no
   leading or trailing space.
5. Any other string throws `RangeError`: empty, spaces only, unknown unit (`"5x"`), a bare number
   (`"90"`), wrong order (`"30m1h"`), repeated unit (`"1h1h"`), uppercase unit (`"1H"`), decimals
   (`"1.5h"`), a sign (`"-1h"`), two spaces (`"1h  30m"`), a space inside a part (`"1 h"`),
   trailing digits without a unit (`"1h30"`).

Examples: `"90s"` gives `90`; `"1h30m"` gives `5400`; `"2d 4h"` gives `187200`;
`"1d1h1m1s"` gives `90061`.
