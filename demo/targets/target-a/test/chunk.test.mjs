import test from 'node:test'
import assert from 'node:assert/strict'
import { chunk } from '../src/chunk.mjs'

test('splits into pieces of equal size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
})

test('keeps a shorter last piece', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('gives one piece when size is larger than the array', () => {
  assert.deepEqual(chunk([1, 2, 3], 5), [[1, 2, 3]])
})

test('works with size 1', () => {
  assert.deepEqual(chunk(['a', 'b', 'c'], 1), [['a'], ['b'], ['c']])
})

test('gives an empty array for an empty array', () => {
  assert.deepEqual(chunk([], 3), [])
})

test('does not modify the input and returns copies', () => {
  const input = [1, 2, 3, 4, 5, 6]
  const pieces = chunk(input, 2)
  pieces[0].push(99)
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6])
})

// TASK.md rule 3: new arrays of new arrays, also when everything fits into one piece
// (size equal to or larger than the length) and when the pieces have one element.
test('returns copies, never the input array itself, when one piece holds everything', () => {
  for (const size of [3, 5]) {
    const input = [1, 2, 3]
    const pieces = chunk(input, size)
    assert.deepEqual(pieces, [[1, 2, 3]], `size ${size}`)
    assert.notEqual(pieces[0], input, `size ${size}: the piece is the input array`)
    pieces[0].push(99)
    assert.deepEqual(input, [1, 2, 3], `size ${size}: the input was modified`)
  }
  const single = [7]
  const one = chunk(single, 1)
  assert.notEqual(one[0], single)
  one[0].push(8)
  assert.deepEqual(single, [7])
})

test('throws RangeError for a size that is not an integer of at least 1', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '2', undefined]) {
    assert.throws(() => chunk([1, 2, 3], bad), RangeError, `size: ${String(bad)}`)
  }
})

test('throws TypeError when the first argument is not an array', () => {
  for (const bad of ['abc', null, undefined, { length: 3 }, 7]) {
    assert.throws(() => chunk(bad, 2), TypeError, `array: ${String(bad)}`)
  }
})
