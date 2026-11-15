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

for (const rowMode of ['object', 'array']) {
  test(`mixed text ${rowMode} rows preserve custom parsers, nulls and parser changes`, () => {
    const fields = Object.freeze([
      Object.freeze({ name: 'id', dataTypeID: 23, format: 'text' }),
      Object.freeze({ name: 'label', dataTypeID: 25, format: 'text' }),
      Object.freeze({ name: 'nullable', dataTypeID: 25, format: 'text' }),
    ])
    const result = new Result(rowMode, {
      getTypeParser: (oid) => (value) => {
        assert.notStrictEqual(value, null)
        return oid === 23 ? Number(value) : `custom:${value}`
      },
    })
    result.addFields(fields)
    const input = Object.freeze(['42', 'hello', null])

    assert.deepStrictEqual(
      result.parseRow(input),
      rowMode === 'array' ? [42, 'custom:hello', null] : { id: 42, label: 'custom:hello', nullable: null }
    )
    result._parsers[0] = (value) => `changed:${value}`

    assert.deepStrictEqual(
      result.parseRow(input),
      rowMode === 'array'
        ? ['changed:42', 'custom:hello', null]
        : { id: 'changed:42', label: 'custom:hello', nullable: null }
    )
    const independent = new Result(rowMode)
    independent.addFields(fields)
    assert.deepStrictEqual(
      independent.parseRow(input),
      rowMode === 'array' ? [42, 'hello', null] : { id: 42, label: 'hello', nullable: null }
    )
    assert.throws(() => result.parseRow(['42']), /field count does not match/)
    assert.throws(() => result.parseRow(['42', 'hello', null, 'extra']), /field count does not match/)
  })

  test(`text ${rowMode} rows safely parse hostile and duplicate names in column order`, () => {
    const parsed = []
    const result = new Result(rowMode, {
      getTypeParser: () => (value) => {
        parsed.push(value)
        return JSON.parse(value)
      },
    })
    result.addFields(
      ['__proto__', 'x"];globalThis.textInjected=true;//', 'quote"\nline', 'duplicate', 'duplicate'].map((name) => ({
        name,
        dataTypeID: 114,
        format: 'text',
      }))
    )

    const row = result.parseRow(['{"admin":true}', '2', '3', '4', '5'])

    assert.deepStrictEqual(
      row,
      rowMode === 'array'
        ? [{ admin: true }, 2, 3, 4, 5]
        : {
            ['__proto__']: { admin: true },
            ['x"];globalThis.textInjected=true;//']: 2,
            ['quote"\nline']: 3,
            duplicate: 5,
          }
    )
    assert.deepStrictEqual(parsed, ['{"admin":true}', '2', '3', '4', '5'])
    assert.strictEqual(Object.getPrototypeOf(row), rowMode === 'array' ? Array.prototype : Object.prototype)
    assert.strictEqual(global.textInjected, undefined)
  })

  test(`a new binary or empty description clears the former text ${rowMode} reader`, () => {
    const result = new Result(rowMode)
    result.addFields([{ name: 'old', dataTypeID: 25, format: 'text' }])
    assert.deepStrictEqual(result.parseRow(['text']), rowMode === 'array' ? ['text'] : { old: 'text' })

    result.addFields([{ name: 'binary', dataTypeID: 23, format: 'binary' }])
    const value = Buffer.from([0, 0, 0, 42])

    assert.deepStrictEqual(result.parseRow([value]), rowMode === 'array' ? [42] : { binary: 42 })
    result.addFields([])
    assert.deepStrictEqual(result.parseRow([]), rowMode === 'array' ? [] : {})
  })
}

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

for (const rowMode of ['object', 'array']) {
  test(`mixed raw text ${rowMode} rows preserve UTF8, types, nulls and hostile duplicate keys`, () => {
    const result = new Result(rowMode)
    result.addFields([
      { name: 'n', dataTypeID: 23, format: 'text' },
      { name: 'label', dataTypeID: 25, format: 'text' },
      { name: 'enabled', dataTypeID: 16, format: 'text' },
      { name: '__proto__', dataTypeID: 3802, format: 'text' },
      { name: 'big', dataTypeID: 20, format: 'text' },
      { name: 'empty', dataTypeID: 25, format: 'text' },
      { name: 'x"];globalThis.rawTextInjected=true;//\n"', dataTypeID: 25, format: 'text' },
      { name: 'duplicate', dataTypeID: 25, format: 'text' },
      { name: 'duplicate', dataTypeID: 23, format: 'text' },
    ])

    const row = result.parseRawRow(
      Object.freeze(rawRow(['42', 'Привет😀', 't', '{"v":1}', '9007199254740993', null, 'safe', 'first', '7']))
    )

    assert.deepStrictEqual(
      row,
      rowMode === 'array'
        ? [42, 'Привет😀', true, { v: 1 }, '9007199254740993', null, 'safe', 'first', 7]
        : {
            n: 42,
            label: 'Привет😀',
            enabled: true,
            ['__proto__']: { v: 1 },
            big: '9007199254740993',
            empty: null,
            ['x"];globalThis.rawTextInjected=true;//\n"']: 'safe',
            duplicate: 7,
          }
    )
    assert.strictEqual(Object.getPrototypeOf(row), rowMode === 'array' ? Array.prototype : Object.prototype)
    assert.strictEqual(global.rawTextInjected, undefined)
    assert.strictEqual(result.prefersRawInt4, false)
    assert.strictEqual(result.supportsRawRows, true)
    assert.throws(() => result.parseRawRow(rawRow(['42'])), /field count does not match/)
  })

  test(`a cached raw text ${rowMode} shape never bypasses a custom int4 parser`, () => {
    const fields = [
      { name: 'n', dataTypeID: 23, format: 'text' },
      { name: 'label', dataTypeID: 25, format: 'text' },
    ]
    const builtin = new Result(rowMode)
    builtin.addFields(fields)
    const custom = new Result(rowMode, {
      getTypeParser: (oid, format) =>
        oid === 23 ? (value) => `custom:${typeof value}:${value}` : require('pg-types').getTypeParser(oid, format),
    })
    custom.addFields(fields)

    assert.deepStrictEqual(
      builtin.parseRawRow(rawRow(['42', 'original'])),
      rowMode === 'array' ? [42, 'original'] : { n: 42, label: 'original' }
    )
    assert.deepStrictEqual(
      custom.parseRawRow(rawRow(['42', 'custom'])),
      rowMode === 'array' ? ['custom:string:42', 'custom'] : { n: 'custom:string:42', label: 'custom' }
    )
    custom._parsers[0] = (value) => `changed:${value}`
    assert.deepStrictEqual(
      custom.parseRawRow(rawRow(['7', 'changed'])),
      rowMode === 'array' ? ['changed:7', 'changed'] : { n: 'changed:7', label: 'changed' }
    )
  })

  test(`raw text ${rowMode} parsers can replace a later parser through this within the same row`, () => {
    const result = new Result(rowMode, {
      getTypeParser: (oid) =>
        oid === 23
          ? function (value) {
              assert.strictEqual(this, result._parsers)
              this[1] = function (laterValue) {
                assert.strictEqual(this, result._parsers)
                return `changed:${laterValue}`
              }
              return Number(value)
            }
          : () => 'original',
    })
    result.addFields([
      { name: 'first', dataTypeID: 23, format: 'text' },
      { name: 'later', dataTypeID: 25, format: 'text' },
    ])

    const row = result.parseRawRow(rawRow(['42', 'value']))

    assert.deepStrictEqual(row, rowMode === 'array' ? [42, 'changed:value'] : { first: 42, later: 'changed:value' })
  })

  test(`raw text ${rowMode} invokes a parser without reading its own call property`, () => {
    const parser = function (value) {
      assert.strictEqual(this, result._parsers)
      return `parsed:${value}`
    }
    Object.defineProperty(parser, 'call', {
      get() {
        throw new Error('a parser call property is not part of parsing')
      },
    })
    const result = new Result(rowMode, { getTypeParser: () => parser })
    result.addFields([{ name: 'label', dataTypeID: 25, format: 'text' }])

    const row = result.parseRawRow(rawRow(['value']))

    assert.deepStrictEqual(row, rowMode === 'array' ? ['parsed:value'] : { label: 'parsed:value' })
  })

  const boolCases = [
    { value: 't', expected: true, why: 'canonical true uses the builtin meaning' },
    { value: 'f', expected: false, why: 'canonical false uses the builtin meaning' },
    { value: null, expected: null, why: 'SQL NULL stays null' },
    { value: 'TRUE', expected: true, why: 'accepted noncanonical true keeps parser behavior' },
    { value: 'no', expected: false, why: 'noncanonical false keeps parser behavior' },
  ]
  for (const { value, expected, why } of boolCases) {
    test(`raw text ${rowMode} bool ${value}: ${why}`, () => {
      const result = new Result(rowMode)
      result.addFields([{ name: 'enabled', dataTypeID: 16, format: 'text' }])

      const row = result.parseRawRow(rawRow([value]))

      assert.deepStrictEqual(row, rowMode === 'array' ? [expected] : { enabled: expected })
    })
  }

  test(`raw text ${rowMode} bool respects custom parsers before and after metadata`, () => {
    const fields = [{ name: 'enabled', dataTypeID: 16, format: 'text' }]
    const builtin = new Result(rowMode)
    builtin.addFields(fields)
    const custom = new Result(rowMode, { getTypeParser: () => (value) => `custom:${typeof value}:${value}` })
    custom.addFields(fields)

    const customRow = custom.parseRawRow(rawRow(['t']))
    builtin._parsers[0] = (value) => `changed:${typeof value}:${value}`
    const changedRow = builtin.parseRawRow(rawRow(['f']))

    assert.deepStrictEqual(customRow, rowMode === 'array' ? ['custom:string:t'] : { enabled: 'custom:string:t' })
    assert.deepStrictEqual(changedRow, rowMode === 'array' ? ['changed:string:f'] : { enabled: 'changed:string:f' })
  })

  test(`raw text ${rowMode} int8 values preserve precision, malformed strings and custom overrides`, () => {
    const fields = [
      { name: 'positive', dataTypeID: 20, format: 'text' },
      { name: 'negative', dataTypeID: 20, format: 'text' },
      { name: 'malformed', dataTypeID: 20, format: 'text' },
    ]
    const builtin = new Result(rowMode)
    builtin.addFields(fields)
    const custom = new Result(rowMode, { getTypeParser: () => (value) => `custom:${value}` })
    custom.addFields(fields)
    const values = ['9007199254740993', '-9223372036854775808', '12 junk']

    assert.deepStrictEqual(
      builtin.parseRawRow(rawRow(values)),
      rowMode === 'array'
        ? ['9007199254740993', '-9223372036854775808', '12 junk']
        : { positive: '9007199254740993', negative: '-9223372036854775808', malformed: '12 junk' }
    )
    assert.deepStrictEqual(
      custom.parseRawRow(rawRow(values)),
      rowMode === 'array'
        ? ['custom:9007199254740993', 'custom:-9223372036854775808', 'custom:12 junk']
        : {
            positive: 'custom:9007199254740993',
            negative: 'custom:-9223372036854775808',
            malformed: 'custom:12 junk',
          }
    )
  })
}

const canonicalInt4 = [
  { value: '-2147483648', expected: -2147483648, why: 'minimum signed int4' },
  { value: '2147483647', expected: 2147483647, why: 'maximum signed int4' },
  { value: '-1', expected: -1, why: 'a negative single digit' },
  { value: '0', expected: 0, why: 'zero' },
  { value: '1', expected: 1, why: 'a positive single digit' },
  { value: '42', expected: 42, why: 'a positive two-digit value' },
  { value: '999', expected: 999, why: 'a positive three-digit value' },
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

test('int4 and int8 parsers overridden before loading pg are never bypassed', () => {
  const { execFileSync } = require('node:child_process')
  const script = `
    const assert = require('node:assert/strict')
    const types = require('pg-types')
    const integerParser = types.getTypeParser(23, 'text')
    types.setTypeParser(23, value => 'before:' + value)
    types.setTypeParser(20, value => 'before-int8:' + value)
    const Result = require('./packages/pg/lib/result')
    const result = new Result()
    result.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }])
    const buffer = Buffer.from([0, 1, 0, 0, 0, 2, 52, 50])
    assert.deepEqual(result.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), { n: 'before:42' })
    const big = new Result()
    big.addFields([{ name: 'n', dataTypeID: 20, format: 'text' }])
    assert.deepEqual(big.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), { n: 'before-int8:42' })
    types.setTypeParser(23, integerParser)
    require('./packages/pg/lib').defaults.parseInt8 = true
    const numeric = new Result()
    numeric.addFields([{ name: 'n', dataTypeID: 20, format: 'text' }])
    assert.deepEqual(numeric.parseRawRow({ buffer, offset: 0, fieldCount: 1 }), { n: 42 })
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

test('mixed int4 widths preserve null offsets and validate every short ASCII digit', () => {
  const names = ['one', 'two', 'three', 'empty', 'negative', 'negativeZero', 'junk', 'next', 'invalid', 'last']
  const values = ['7', '42', '999', null, '-12', '-0', '1x', '83', '12x', '6']
  const object = int4Result({ names })
  const array = int4Result({ names, rowMode: 'array' })

  assert.deepStrictEqual(object.parseRawRow(rawRow(values)), {
    one: 7,
    two: 42,
    three: 999,
    empty: null,
    negative: -12,
    negativeZero: -0,
    junk: 1,
    next: 83,
    invalid: 12,
    last: 6,
  })
  assert.deepStrictEqual(array.parseRawRow(rawRow(values)), [7, 42, 999, null, -12, -0, 1, 83, 12, 6])
})

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
    const mixedObject = new Result()
    mixedObject.addFields([
      { name: '__proto__', dataTypeID: 25, format: 'text' },
      { name: 'n', dataTypeID: 23, format: 'text' },
      { name: 'nullable', dataTypeID: 25, format: 'text' }
    ])
    assert.deepEqual(mixedObject.parseRow(['text', '42', null]), { ['__proto__']: 'text', n: 42, nullable: null })
    const mixedBuffer = Buffer.from([0, 3, 0, 0, 0, 4, 116, 101, 120, 116, 0, 0, 0, 2, 52, 50, 255, 255, 255, 255])
    assert.deepEqual(mixedObject.parseRawRow({ buffer: mixedBuffer, offset: 0, fieldCount: 3 }), { ['__proto__']: 'text', n: 42, nullable: null })
    const mixedArray = new Result('array', { getTypeParser: () => value => 'custom:' + value })
    mixedArray.addFields([
      { name: 'value', dataTypeID: 25, format: 'text' },
      { name: 'nullable', dataTypeID: 25, format: 'text' }
    ])
    assert.deepEqual(mixedArray.parseRow(['text', null]), ['custom:text', null])
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
    assert.throws(() => result.addFields([{ name: 'n', dataTypeID: 25, format: 'text' }]), error => error === failure)
  `

  execFileSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '../../../..') })
})
