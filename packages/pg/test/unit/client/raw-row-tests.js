'use strict'

const assert = require('assert')
const { test } = require('node:test')
const Result = require('../../../lib/result')

function toRawRow(hex) {
  const buffer = Buffer.from('aabb' + hex + 'ccdd', 'hex')
  return { buffer, offset: 2, fieldCount: buffer.readUInt16BE(2) }
}

const countCases = [
  {
    rowMode: undefined,
    raw: '0000',
    legacy: [],
    why: 'object rows reject fewer fields than metadata instead of inventing NULLs',
  },
  {
    rowMode: 'array',
    raw: '0000',
    legacy: [],
    why: 'array rows reject fewer fields than metadata instead of losing columns',
  },
  {
    rowMode: undefined,
    raw: '0002ffffffffffffffff',
    legacy: [null, null],
    why: 'object rows reject more fields than metadata as a protocol error',
  },
  {
    rowMode: 'array',
    raw: '0002ffffffffffffffff',
    legacy: [null, null],
    why: 'array rows reject more fields than metadata as a protocol error',
  },
]
for (const { rowMode, raw, legacy, why } of countCases) {
  test(why, () => {
    const result = new Result(rowMode)
    result.addFields([{ name: 'value', dataTypeID: 25, format: 'text' }])

    assert.throws(() => result.parseRow(legacy), {
      name: 'ProtocolError',
      code: 'PG_PROTOCOL_ERROR',
    })
    assert.throws(() => result.parseRawRow(toRawRow(raw)), {
      name: 'ProtocolError',
      code: 'PG_PROTOCOL_ERROR',
    })
  })
}

const binaryCases = [
  {
    rowMode: undefined,
    expected: { value: Buffer.from([0, 255, 128, 195]) },
    why: 'object rows preserve non-UTF8 bytes',
  },
  { rowMode: 'array', expected: [Buffer.from([0, 255, 128, 195])], why: 'array rows preserve non-UTF8 bytes' },
]
for (const { rowMode, expected, why } of binaryCases) {
  test(why, () => {
    const result = new Result(rowMode, { getTypeParser: () => (value) => value })
    result.addFields([{ name: 'value', dataTypeID: 17, format: 'binary' }])
    const raw = toRawRow('00010000000400ff80c3')

    const row = result.parseRawRow(raw)

    assert.deepStrictEqual(row, expected)
  })
}

const numberCases = [
  { rowMode: undefined, expected: { integer: -12345, float: -12.5 }, why: 'object rows decode signed binary numbers' },
  { rowMode: 'array', expected: [-12345, -12.5], why: 'array rows decode signed binary numbers' },
]
for (const { rowMode, expected, why } of numberCases) {
  test(why, () => {
    const result = new Result(rowMode)
    result.addFields([
      { name: 'integer', dataTypeID: 23, format: 'binary' },
      { name: 'float', dataTypeID: 700, format: 'binary' },
    ])

    const row = result.parseRawRow(toRawRow('000200000004ffffcfc700000004c1480000'))

    assert.deepStrictEqual(row, expected)
  })
}

const textCases = [
  {
    rowMode: undefined,
    expected: { text: 'Привет', absent: null, empty: '' },
    why: 'object rows preserve UTF-8, NULL and empty text',
  },
  { rowMode: 'array', expected: ['Привет', null, ''], why: 'array rows preserve UTF-8, NULL and empty text' },
]
for (const { rowMode, expected, why } of textCases) {
  test(why, () => {
    const result = new Result(rowMode)
    result.addFields([
      { name: 'text', dataTypeID: 25, format: 'text' },
      { name: 'absent', dataTypeID: 25, format: 'text' },
      { name: 'empty', dataTypeID: 25, format: 'text' },
    ])

    const row = result.parseRawRow(toRawRow('00030000000cd09fd180d0b8d0b2d0b5d182ffffffff00000000'))

    assert.deepStrictEqual(row, expected)
  })
}

test('custom parsers receive strings for text and untouched buffers for binary', () => {
  const parsers = {
    text(value) {
      assert.strictEqual(typeof value, 'string')
      return value.toUpperCase()
    },
    binary(value) {
      assert.strictEqual(Buffer.isBuffer(value), true)
      return value.toString('hex')
    },
  }
  const result = new Result(undefined, { getTypeParser: (oid, format) => parsers[format] })
  result.addFields([
    { name: 'text', dataTypeID: 25, format: 'text' },
    { name: 'binary', dataTypeID: 17, format: 'binary' },
  ])

  const row = result.parseRawRow(toRawRow('00020000000268690000000400ff80c3'))

  assert.deepStrictEqual(row, { text: 'HI', binary: '00ff80c3' })
})

const columnCases = [
  {
    rowMode: undefined,
    expected: { ['__proto__']: 'safe', duplicate: 'last', constructor: 'own' },
    why: 'object rows keep own prototype-named columns and last duplicate value',
  },
  {
    rowMode: 'array',
    expected: ['safe', 'first', 'last', 'own'],
    why: 'array rows retain every duplicate and prototype-named column',
  },
]
for (const { rowMode, expected, why } of columnCases) {
  test(why, () => {
    const result = new Result(rowMode)
    result.addFields([
      { name: '__proto__', dataTypeID: 25, format: 'text' },
      { name: 'duplicate', dataTypeID: 25, format: 'text' },
      { name: 'duplicate', dataTypeID: 25, format: 'text' },
      { name: 'constructor', dataTypeID: 25, format: 'text' },
    ])

    const row = result.parseRawRow(toRawRow('00040000000473616665000000056669727374000000046c617374000000036f776e'))

    assert.deepStrictEqual(row, expected)
    assert.deepStrictEqual(row, result.parseRow(['safe', 'first', 'last', 'own']))
    assert.strictEqual(Object.getPrototypeOf(row), Object.getPrototypeOf(expected))
  })
}
