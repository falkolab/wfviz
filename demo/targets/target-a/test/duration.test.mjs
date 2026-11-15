import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.mjs'

test('parses seconds', () => {
  assert.equal(parseDuration('90s'), 90)
  assert.equal(parseDuration('0s'), 0)
})

test('parses minutes', () => {
  assert.equal(parseDuration('5m'), 300)
  assert.equal(parseDuration('1m1s'), 61)
})

test('parses hours and minutes', () => {
  assert.equal(parseDuration('1h30m'), 5400)
})

test('parses days with a single space between parts', () => {
  assert.equal(parseDuration('2d 4h'), 187200)
})

test('parses all four units', () => {
  assert.equal(parseDuration('1d1h1m1s'), 90061)
})

test('parses large values', () => {
  assert.equal(parseDuration('100d'), 8640000)
})

test('throws RangeError for malformed strings', () => {
  const bad = ['', ' ', '5x', '90', '30m1h', '1h1h', '1H', '1.5h', '-1h', ' 1h', '1h ', '1h  30m', '1 h', '1h30', 'h', 'abc',
    // TASK.md rule 4: between parts one single space or nothing, no other whitespace
    '1h\t30m', '1h\n30m', '1h\r30m', '1h\u00a030m', '\t1h', '1h\n', '1h \t30m']
  for (const input of bad) {
    assert.throws(() => parseDuration(input), RangeError, `input: ${JSON.stringify(input)}`)
  }
})

// TASK.md rule 2 (ASCII digits only) and rule 5 (a sign is malformed) cut both ways: leading zeros are
// digits and stay valid, a plus sign and digits of other scripts are not.
test('accepts leading zeros', () => {
  assert.equal(parseDuration('01h'), 3600)
  assert.equal(parseDuration('007s'), 7)
  assert.equal(parseDuration('00d 02h'), 7200)
})

test('throws RangeError for a plus sign and for digits that are not ASCII', () => {
  const bad = ['+1h', '1h+30m', '+0s', '\u0661h', '\u0661\u0662m', '\uff11h', '1h\u0663m']
  for (const input of bad) {
    assert.throws(() => parseDuration(input), RangeError, `input: ${JSON.stringify(input)}`)
  }
})

test('throws TypeError for non-string input', () => {
  for (const bad of [undefined, null, 90, {}, ['1h']]) {
    assert.throws(() => parseDuration(bad), TypeError, `input: ${String(bad)}`)
  }
})
