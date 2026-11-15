'use strict'
const helper = require('./test-helper')
const assert = require('assert')
const suite = new helper.Suite()
const test = suite.test.bind(suite)

const Result = require('../../lib/result')

test('__proto__ column name does not pollute prototype', function () {
  const result = new Result()
  result.addFields([
    { name: '__proto__', dataTypeID: 25, format: 'text' },
    { name: 'id', dataTypeID: 23, format: 'text' },
  ])
  const row = result.parseRow(['malicious', '1'])

  // __proto__ should be a regular property, not affect prototype chain
  assert.strictEqual(row['__proto__'], 'malicious')
  assert.strictEqual(row.id, 1)

  // global Object.prototype should not be affected
  assert.strictEqual({}.malicious, undefined)
  assert.strictEqual(Object.prototype.malicious, undefined)
})

test('__proto__ column with object value does not inject prototype', function () {
  // custom type parser that returns objects (like JSON)
  const customTypes = {
    getTypeParser: () => (val) => JSON.parse(val),
  }
  const result = new Result('object', customTypes)
  result.addFields([
    { name: '__proto__', dataTypeID: 114, format: 'text' },
    { name: 'id', dataTypeID: 23, format: 'text' },
  ])

  const maliciousPayload = JSON.stringify({ isAdmin: true, role: 'admin' })
  const row = result.parseRow([maliciousPayload, '1'])

  // __proto__ should be stored as a regular property
  assert.deepStrictEqual(row['__proto__'], { isAdmin: true, role: 'admin' })

  // the row should NOT inherit from the malicious payload
  assert.strictEqual('isAdmin' in row, false)
  assert.strictEqual('role' in row, false)
})

test('constructor column name is safely stored as property', function () {
  const result = new Result()
  result.addFields([
    { name: 'constructor', dataTypeID: 25, format: 'text' },
    { name: 'id', dataTypeID: 23, format: 'text' },
  ])
  const row = result.parseRow(['malicious', '1'])

  assert.strictEqual(row.constructor, 'malicious')
  assert.strictEqual(row.id, 1)
})

test('hasOwnProperty column name is safely stored as property', function () {
  const result = new Result()
  result.addFields([
    { name: 'hasOwnProperty', dataTypeID: 25, format: 'text' },
    { name: 'data', dataTypeID: 25, format: 'text' },
  ])
  const row = result.parseRow(['not_a_function', 'value'])

  assert.strictEqual(row.hasOwnProperty, 'not_a_function')
  assert.strictEqual(row.data, 'value')

  // can still check properties using Object.prototype.hasOwnProperty.call
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'data'), true)
})

test('toString column name is safely stored as property', function () {
  const result = new Result()
  result.addFields([{ name: 'toString', dataTypeID: 25, format: 'text' }])
  const row = result.parseRow(['not_a_function'])

  assert.strictEqual(row.toString, 'not_a_function')
})

test('prototype column name is safely stored as property', function () {
  const result = new Result()
  result.addFields([
    { name: 'prototype', dataTypeID: 25, format: 'text' },
    { name: 'id', dataTypeID: 23, format: 'text' },
  ])
  const row = result.parseRow(['value', '1'])

  assert.strictEqual(row.prototype, 'value')
  assert.strictEqual(row.id, 1)
})

test('multiple dangerous column names handled safely', function () {
  const result = new Result()
  result.addFields([
    { name: '__proto__', dataTypeID: 25, format: 'text' },
    { name: 'constructor', dataTypeID: 25, format: 'text' },
    { name: 'prototype', dataTypeID: 25, format: 'text' },
    { name: '__defineGetter__', dataTypeID: 25, format: 'text' },
    { name: 'id', dataTypeID: 23, format: 'text' },
  ])
  const row = result.parseRow(['a', 'b', 'c', 'd', '1'])

  assert.strictEqual(row['__proto__'], 'a')
  assert.strictEqual(row.constructor, 'b')
  assert.strictEqual(row.prototype, 'c')
  assert.strictEqual(row['__defineGetter__'], 'd')
  assert.strictEqual(row.id, 1)
})

function rawInt4({ value, rowMode = 'object', types }) {
  const result = new Result(rowMode, types)
  result.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }])
  return result.parseRawRow(rawRow([value]))
}

function rawRow(values) {
  const count = Buffer.alloc(2)
  count.writeInt16BE(values.length)
  const fields = values.flatMap((value) => {
    const size = Buffer.alloc(4)
    if (value === null) {
      size.writeInt32BE(-1)
      return [size]
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size.writeInt32BE(bytes.length)
    return [size, bytes]
  })
  return { buffer: Buffer.concat([count, ...fields]), offset: 0, fieldCount: values.length }
}

const canonicalInt4 = [
  { value: '-2147483648', expected: -2147483648, why: 'minimum signed int4' },
  { value: '2147483647', expected: 2147483647, why: 'maximum signed int4' },
  { value: '-1', expected: -1, why: 'a negative single digit' },
  { value: '0', expected: 0, why: 'zero' },
  { value: '1', expected: 1, why: 'a positive single digit' },
  { value: '-123456789', expected: -123456789, why: 'a negative multi-digit value' },
  { value: '123456789', expected: 123456789, why: 'a positive multi-digit value' },
]
for (const { value, expected, why } of canonicalInt4) {
  test(`raw object and array rows preserve ${why}`, () => {
    assert.deepStrictEqual(rawInt4({ value }), { n: expected })
    assert.deepStrictEqual(rawInt4({ value, rowMode: 'array' }), [expected])
  })
}

const fallbackInt4 = [
  { value: '', expected: NaN, why: 'empty input keeps parseInt semantics' },
  { value: '-', expected: NaN, why: 'a bare sign stays NaN' },
  { value: '--1', expected: NaN, why: 'two signs stay NaN' },
  { value: 'a1', expected: NaN, why: 'an invalid first digit stays NaN' },
  { value: '+12', expected: 12, why: 'a plus sign remains accepted' },
  { value: ' 12', expected: 12, why: 'leading whitespace remains accepted' },
  { value: '12x', expected: 12, why: 'trailing junk still returns its decimal prefix' },
  { value: '12\u00e9', expected: 12, why: 'UTF8 trailing junk keeps the decimal prefix' },
  { value: '2147483648', expected: 2147483648, why: 'positive overflow uses the original parser' },
  { value: '-2147483649', expected: -2147483649, why: 'negative overflow uses the original parser' },
  { value: '123456789012', expected: 123456789012, why: 'an overlong decimal uses the original parser' },
  { value: '-0', expected: -0, why: 'negative zero keeps its sign' },
]
for (const { value, expected, why } of fallbackInt4) {
  test(`raw object and array rows preserve ${why}`, () => {
    assert.deepStrictEqual(rawInt4({ value }), { n: expected })
    assert.deepStrictEqual(rawInt4({ value, rowMode: 'array' }), [expected])
  })
}

test('custom text int4 parsers receive their original string in both raw row modes', () => {
  const types = { getTypeParser: () => (value) => `custom:${typeof value}:${value}` }

  assert.deepStrictEqual(rawInt4({ value: '42', types }), { n: 'custom:string:42' })
  assert.deepStrictEqual(rawInt4({ value: '42', rowMode: 'array', types }), ['custom:string:42'])
})

test('text int4 eligibility refreshes when a result receives new field descriptions', () => {
  const types = require('pg-types')
  const original = types.getTypeParser(23, 'text')
  const result = new Result()
  const fields = [{ name: 'n', dataTypeID: 23, format: 'text' }]
  result.addFields(fields)
  assert.deepStrictEqual(result.parseRawRow(rawRow(['42'])), { n: 42 })

  try {
    types.setTypeParser(23, 'text', (value) => `changed:${value}`)
    result.addFields(fields)

    assert.deepStrictEqual(result.parseRawRow(rawRow(['42'])), { n: 'changed:42' })
  } finally {
    types.setTypeParser(23, 'text', original)
  }
})

test('binary int4, text int8, numeric, null and __proto__ retain their raw row behavior', () => {
  const result = new Result()
  result.addFields([
    { name: '__proto__', dataTypeID: 23, format: 'text' },
    { name: 'binary', dataTypeID: 23, format: 'binary' },
    { name: 'int8', dataTypeID: 20, format: 'text' },
    { name: 'numeric', dataTypeID: 1700, format: 'text' },
    { name: 'nullable', dataTypeID: 23, format: 'text' },
  ])
  const binary = Buffer.alloc(4)
  binary.writeInt32BE(-16909061)

  const row = result.parseRawRow(rawRow(['42', binary, '9007199254740993', '12.34', null]))

  assert.strictEqual(row.__proto__, 42)
  assert.strictEqual(Object.getPrototypeOf(row), Object.prototype)
  assert.strictEqual(row.binary, -16909061)
  assert.strictEqual(row.int8, '9007199254740993')
  assert.strictEqual(row.numeric, '12.34')
  assert.strictEqual(row.nullable, null)
})

test('an int4 parser overridden before loading pg is never bypassed', () => {
  const { execFileSync } = require('node:child_process')
  const script = `
    const assert = require('node:assert/strict')
    const types = require('pg-types')
    types.setTypeParser(23, value => 'before:' + value)
    const Result = require('./packages/pg/lib/result')
    const result = new Result()
    result.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }])
    const buffer = Buffer.from([0, 1, 0, 0, 0, 2, 52, 50])
    assert.deepEqual(result.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), { n: 'before:42' })
  `

  execFileSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../../../..') })
})

test('only a nonempty result of builtin text int4 fields prefers raw parsing', () => {
  const result = new Result()
  assert.strictEqual(result.prefersRawInt4, false)

  result.addFields([
    { name: 'first', dataTypeID: 23, format: 'text' },
    { name: 'second', dataTypeID: 23, format: 'text' },
  ])

  assert.strictEqual(result.prefersRawInt4, true)
  result.addFields([])
  assert.strictEqual(result.prefersRawInt4, false)
})

test('mixed fields and custom int4 parsers keep their existing row parsing mode', () => {
  const mixed = new Result()
  const custom = new Result('object', { getTypeParser: () => (value) => value })

  mixed.addFields([
    { name: 'integer', dataTypeID: 23, format: 'text' },
    { name: 'text', dataTypeID: 25, format: 'text' },
  ])
  custom.addFields([{ name: 'integer', dataTypeID: 23, format: 'text' }])

  assert.strictEqual(mixed.prefersRawInt4, false)
  assert.strictEqual(custom.prefersRawInt4, false)
})

function int4Result({ names, rowMode = 'object' }) {
  const result = new Result(rowMode)
  result.addFields(names.map((name) => ({ name, dataTypeID: 23, format: 'text' })))
  return result
}

test('specialized object rows treat executable-looking column names as ordinary keys', () => {
  const result = int4Result({
    names: [
      '__proto__',
      'x"];globalThis.int4Injected=true;//',
      'quote"\nline',
      'constructor',
      '2',
      'duplicate',
      'duplicate',
    ],
  })

  const row = result.parseRawRow(Object.freeze(rawRow(['1', '2', '3', '4', '5', '6', '7'])))

  assert.deepStrictEqual(row, {
    ['__proto__']: 1,
    ['x"];globalThis.int4Injected=true;//']: 2,
    ['quote"\nline']: 3,
    constructor: 4,
    2: 5,
    duplicate: 7,
  })
  assert.deepStrictEqual(Object.keys(row), [
    '2',
    '__proto__',
    'x"];globalThis.int4Injected=true;//',
    'quote"\nline',
    'constructor',
    'duplicate',
  ])
  assert.strictEqual(Object.getPrototypeOf(row), Object.prototype)
  assert.strictEqual(global.int4Injected, undefined)
})

test('specialized object and array rows preserve null offsets and duplicate column values', () => {
  const object = int4Result({ names: ['first', '__proto__', 'last'] })
  const array = int4Result({ names: ['n', 'n', 'n'], rowMode: 'array' })

  const objectRow = object.parseRawRow(rawRow(['-2147483648', null, '2147483647']))
  const arrayRow = array.parseRawRow(rawRow(['-2147483648', null, '2147483647']))

  assert.deepStrictEqual(objectRow, { first: -2147483648, ['__proto__']: null, last: 2147483647 })
  assert.deepStrictEqual(arrayRow, [-2147483648, null, 2147483647])
  assert.throws(() => object.parseRawRow(rawRow(['1'])), /field count does not match/)
})

test('a changed row description never reuses its former specialized column keys', () => {
  const result = int4Result({ names: ['old'] })
  assert.deepStrictEqual(result.parseRawRow(rawRow(['1'])), { old: 1 })

  result.addFields([{ name: 'new', dataTypeID: 25, format: 'text' }])

  assert.deepStrictEqual(result.parseRawRow(rawRow(['42'])), { new: '42' })
})

test('disabling string code generation keeps object and array row parsing available', () => {
  const { execFileSync } = require('node:child_process')
  const script = `
    const assert = require('node:assert/strict')
    const Result = require('./packages/pg/lib/result')
    const object = new Result()
    object.addFields([{ name: '__proto__', dataTypeID: 23, format: 'text' }])
    const array = new Result('array')
    array.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }])
    const buffer = Buffer.from([0, 1, 0, 0, 0, 2, 52, 50])
    assert.deepEqual(object.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), { ['__proto__']: 42 })
    assert.deepEqual(array.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), [42])
  `

  execFileSync(process.execPath, ['--disallow-code-generation-from-strings', '-e', script], {
    cwd: require('node:path').resolve(__dirname, '../../../..'),
  })
})

test('unexpected compiler failures are reported instead of silently selecting another parser', () => {
  const { execFileSync } = require('node:child_process')
  const script = `
    const assert = require('node:assert/strict')
    const Result = require('./packages/pg/lib/result')
    const failure = new TypeError('unexpected compiler failure')
    globalThis.Function = function () { throw failure }
    const result = new Result()
    assert.throws(() => result.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }]), error => error === failure)
  `

  execFileSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../../../..') })
})
