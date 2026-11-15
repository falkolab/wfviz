import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.mjs'

test('lowercases words and joins them with a hyphen', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('keeps digits', () => {
  assert.equal(slugify('Release 2024'), 'release-2024')
})

test('collapses a run of separators into one hyphen', () => {
  assert.equal(slugify('a  --  b'), 'a-b')
  assert.equal(slugify('one___two...three'), 'one-two-three')
})

test('has no leading or trailing hyphen', () => {
  assert.equal(slugify('  --Hello, World!--  '), 'hello-world')
})

test('removes diacritics', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
  assert.equal(slugify('São Paulo'), 'sao-paulo')
})

test('treats punctuation inside a number as a separator', () => {
  assert.equal(slugify('Version 2.0 (final)'), 'version-2-0-final')
})

test('gives the empty string for empty input', () => {
  assert.equal(slugify(''), '')
})

test('gives the empty string when only symbols are given', () => {
  assert.equal(slugify('***'), '')
  assert.equal(slugify(' - '), '')
})

test('throws TypeError for non-string input', () => {
  for (const bad of [undefined, null, 42, {}, ['a'], true]) {
    assert.throws(() => slugify(bad), TypeError, `input: ${String(bad)}`)
  }
})
