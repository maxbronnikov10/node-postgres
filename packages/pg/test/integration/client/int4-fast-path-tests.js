'use strict'

const assert = require('node:assert/strict')
const helper = require('./test-helper')
const suite = new helper.Suite('raw text int4 parsing')

suite.test('PostgreSQL int4 boundaries, aliases and null retain their object and array values', async () => {
  const client = new helper.pg.Client()
  try {
    await client.connect()
    const text =
      'SELECT (\'-2147483648\')::int4 AS minimum, 2147483647::int4 AS maximum, -1::int4 AS negative, 0::int4 AS zero, NULL::int4 AS nullable, 42::int4 AS "__proto__"'

    const object = await client.query(text)
    const array = await client.query({ text, rowMode: 'array' })

    assert.equal(object.rows[0].minimum, -2147483648)
    assert.equal(object.rows[0].maximum, 2147483647)
    assert.equal(object.rows[0].negative, -1)
    assert.equal(object.rows[0].zero, 0)
    assert.equal(object.rows[0].nullable, null)
    assert.equal(object.rows[0].__proto__, 42)
    assert.equal(Object.getPrototypeOf(object.rows[0]), Object.prototype)
    assert.deepEqual(array.rows, [[-2147483648, 2147483647, -1, 0, null, 42]])
  } finally {
    await client.end()
  }
})

suite.test('per-query text parsers and binary int4 retain their selected parser behavior', async () => {
  const client = new helper.pg.Client()
  try {
    await client.connect()
    const types = { getTypeParser: () => (value) => `custom:${typeof value}:${value}` }

    const object = await client.query({ text: 'SELECT 42::int4 AS n', types })
    const array = await client.query({ text: 'SELECT 42::int4 AS n', types, rowMode: 'array' })
    const binary = await client.query({ text: 'SELECT $1::int4 AS n', values: [-16909061], binary: true })
    const subsequent = await client.query(
      'SELECT 42::int4 AS n, 9007199254740993::int8 AS wide, 12.34::numeric AS decimal'
    )

    assert.deepEqual(object.rows, [{ n: 'custom:string:42' }])
    assert.deepEqual(array.rows, [['custom:string:42']])
    assert.deepEqual(binary.rows, [{ n: -16909061 }])
    assert.deepEqual(subsequent.rows, [{ n: 42, wide: '9007199254740993', decimal: '12.34' }])
  } finally {
    await client.end()
  }
})
