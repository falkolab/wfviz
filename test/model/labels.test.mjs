import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel } from '../../src/model/labels.mjs';

const P = (label) => parseLabel(label);
// { role, unit, round, tag } with the parts that are not given null
const L = (role, unit = null, round = null, tag = null) => ({ role, unit, round, tag });

test('role:unit', () => {
  assert.deepEqual(P('reviewer:A'), L('reviewer', 'A'));
  assert.deepEqual(P('stage1:alpha'), L('stage1', 'alpha'));
});

test('#rN suffix, as used by the dev workflow labels: tag "rN" and round N', () => {
  assert.deepEqual(P('fix:sum.js#r2'), L('fix', 'sum.js', 2, 'r2'));
  assert.deepEqual(P('review-a:N4#r1'), L('review-a', 'N4', 1, 'r1'));
  assert.deepEqual(P('implement:N4#R3'), L('implement', 'N4', 3, 'R3'));
});

test('contract 2: everything after the last "#" is the tag; the unit never contains it; only #rN is a round', () => {
  assert.deepEqual(P('impl:x#carried'), L('impl', 'x', null, 'carried'));
  assert.deepEqual(P('review:A#v1'), L('review', 'A', null, 'v1'));
  assert.deepEqual(P('review:A#v2'), L('review', 'A', null, 'v2'));
  assert.deepEqual(P('judge#final'), L('judge', null, null, 'final'));
  assert.deepEqual(P('fix:a#r2 extra'), L('fix', 'a', null, 'r2 extra'), 'the tag is any text; "r2 extra" is not "r<n>", so no round');
  assert.deepEqual(P('a:b#c#d'), L('a', 'b#c', null, 'd'), 'the LAST "#" splits');
  assert.deepEqual(P('impl:x #carried'), L('impl', 'x', null, 'carried'), 'whitespace before the "#" goes');
  assert.deepEqual(P('impl:x#  carried over  '), L('impl', 'x', null, 'carried over'), 'whitespace around the tag is trimmed');
  assert.deepEqual(P('impl:src/a.js#carried'), L('impl', 'src/a.js', null, 'carried'));
  assert.deepEqual(P('impl:a:b#t:u'), L('impl', 'a:b', null, 't:u'), 'a ":" inside the tag is not a role/unit split');
});

test('"round N" suffix, with and without a space; it is a round, never a tag', () => {
  assert.deepEqual(P('review A round 2'), L('review A', null, 2));
  assert.deepEqual(P('fix:sum.js - round 2'), L('fix', 'sum.js', 2));
  assert.deepEqual(P('judge:X Round 10'), L('judge', 'X', 10));
  assert.deepEqual(P('fix:a#round2'), L('fix', 'a', 2), '"#round2" is a round marker of its own, not a tag');
  assert.deepEqual(P('fix:a round 2#v1'), L('fix', 'a', 2, 'v1'), 'a tag and a round word together');
  assert.deepEqual(P('fix:a#carried round 2'), L('fix', 'a', null, 'carried round 2'), 'everything after the last "#" is the tag, even when it ends in a round word');
});

test('"#rN" wins over a "round N" word when both are there', () => {
  assert.deepEqual(P('fix:a round 2#r3'), L('fix', 'a', 3, 'r3'));
});

test('the real probe label fixer:round1 is a round marker, not a unit', () => {
  assert.deepEqual(P('fixer:round1'), L('fixer', null, 1));
  assert.deepEqual(P('fixer:round2'), L('fixer', null, 2));
});

test('a label without ":" gives role = label and unit unknown', () => {
  assert.deepEqual(P('judge'), L('judge'));
  assert.deepEqual(P('synthesis'), L('synthesis'));
});

test('only the first ":" splits; the unit may contain ":"', () => {
  assert.deepEqual(P('check:file:12'), L('check', 'file:12'));
});

test('"round" inside a word is not a round marker', () => {
  assert.deepEqual(P('surround 2'), L('surround 2'));
  assert.deepEqual(P('fix:ground1'), L('fix', 'ground1'));
});

test('a round marker only counts at the end', () => {
  assert.deepEqual(P('round 2 fix:a'), L('round 2 fix', 'a'));
});

test('missing or odd input never throws and leaves everything null', () => {
  const none = L(null);
  for (const v of [undefined, null, '', '   ', 42, {}, []]) assert.deepEqual(P(v), none);
  assert.deepEqual(P(':unit-only'), L(null, 'unit-only'));
  assert.deepEqual(P('role:'), L('role'));
  assert.deepEqual(P('#r2'), L(null, null, 2, 'r2'), 'a label that is only a tag');
});

test('whitespace around parts is trimmed', () => {
  assert.deepEqual(P('  reviewer : A  '), L('reviewer', 'A'));
});

test('a "#" with nothing after it is no tag: the label keeps it, and so does every other trailing character', () => {
  assert.deepEqual(P('lang:C#'), L('lang', 'C#'));
  assert.deepEqual(P('review:C#'), L('review', 'C#'));
  assert.deepEqual(P('a:b_'), L('a', 'b_'));
  assert.deepEqual(P('a:b-'), L('a', 'b-'));
  assert.deepEqual(P('a:b,'), L('a', 'b,'));
  assert.deepEqual(P('a:b;'), L('a', 'b;'));
  assert.deepEqual(P('review C#'), L('review C#'));
  assert.deepEqual(P('  lang:C#  '), L('lang', 'C#'), 'only whitespace around the label is trimmed');
  assert.deepEqual(P('x#y#'), L('x#y#'), 'the last "#" has nothing after it');
});

test('with a tag or a round marker only the separator before it goes with it; a "#" that ends the unit stays', () => {
  assert.deepEqual(P('lang:C# #r2'), L('lang', 'C#', 2, 'r2'));
  assert.deepEqual(P('lang:C# round 2'), L('lang', 'C#', 2));
  assert.deepEqual(P('fix:a_round2'), L('fix', 'a', 2));
  assert.deepEqual(P('fix:a, round 2'), L('fix', 'a', 2));
  assert.deepEqual(P('fix:a ; round 2'), L('fix', 'a', 2));
  assert.deepEqual(P('a:b_#r3'), L('a', 'b', 3, 'r3'), 'a separator glued to the marker goes with it');
  assert.deepEqual(P('a:b-#carried'), L('a', 'b', null, 'carried'), '... and to a plain tag');
});
