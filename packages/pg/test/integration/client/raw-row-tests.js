'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const suite = new helper.Suite('raw row transport')

const types = {
  getTypeParser(oid, format) {
    if (oid === 17 && format === 'binary') return (value) => value
    return helper.pg.types.getTypeParser(oid, format)
  },
}
const rowCases = [
  {
    rowMode: undefined,
    expected: [{ value: Buffer.from([0, 255, 128, 127]), n: -16909061, f: 1.5, missing: null, empty: '' }],
    why: 'object rows preserve binary bytes and signed numbers from PostgreSQL',
  },
  {
    rowMode: 'array',
    expected: [[Buffer.from([0, 255, 128, 127]), -16909061, 1.5, null, '']],
    why: 'array rows preserve binary bytes and signed numbers from PostgreSQL',
  },
]
for (const { rowMode, expected, why } of rowCases) {
  suite.test(why, async () => {
    const client = new helper.pg.Client({ types })
    await client.connect()
    try {
      const result = await client.query({
        text: "SELECT $1::bytea AS value, -16909061::int4 AS n, 1.5::float8 AS f, NULL::text AS missing, ''::text AS empty",
        values: [Buffer.from([0, 255, 128, 127])],
        binary: true,
        rowMode,
      })

      assert.deepStrictEqual(result.rows, expected)
    } finally {
      await client.end()
    }
  })
}

suite.test('pipelined text and binary results keep their own parsers after a server error', async () => {
  const client = new helper.pg.Client({ types, pipeline: true })
  await client.connect()
  try {
    const results = await Promise.allSettled([
      client.query({ text: 'SELECT $1::bytea AS value', values: [Buffer.from([0, 255, 128, 127])], binary: true }),
      client.query('SELECT 1 / 0'),
      client.query("SELECT 'Привет🙂'::text AS value"),
      client.query({ text: 'SELECT $1::int4 AS n', values: [-16909061], binary: true, rowMode: 'array' }),
    ])

    assert.strictEqual(results[0].status, 'fulfilled')
    assert.deepStrictEqual(results[0].value.rows, [{ value: Buffer.from([0, 255, 128, 127]) }])
    assert.strictEqual(results[1].status, 'rejected')
    assert.strictEqual(results[1].reason.code, '22012')
    assert.strictEqual(results[2].status, 'fulfilled')
    assert.deepStrictEqual(results[2].value.rows, [{ value: 'Привет🙂' }])
    assert.strictEqual(results[3].status, 'fulfilled')
    assert.deepStrictEqual(results[3].value.rows, [[-16909061]])
    assert.strictEqual(client.getTransactionStatus(), 'I')
  } finally {
    await client.end()
  }
})

suite.test('retained binary results survive later fragmented rows on the same connection', async () => {
  const client = new helper.pg.Client({ types })
  await client.connect()
  try {
    const result = await client.query({
      text: "SELECT decode('00ff807f', 'hex') AS value, repeat('x', 70000) AS text FROM generate_series(1, 8)",
      queryMode: 'extended',
      binary: true,
    })
    await client.query("SELECT repeat('y', 200000)")

    assert.strictEqual(result.rows.length, 8)
    assert.deepStrictEqual(result.rows[0].value, Buffer.from([0, 255, 128, 127]))
    assert.deepStrictEqual(result.rows[7].value, Buffer.from([0, 255, 128, 127]))
    assert.strictEqual(result.rows[0].text.length, 70000)
    assert.strictEqual(result.rows[7].text.length, 70000)
  } finally {
    await client.end()
  }
})

suite.test('custom consumers keep raw spans when both portals are described before either executes', async () => {
  const Result = require('../../../lib/result')
  const client = new helper.pg.Client()
  await client.connect()
  try {
    const results = [new Result(), new Result()]
    let described = 0
    let completed = 0
    let resolveQuery
    let rejectQuery
    const finished = new Promise((resolve, reject) => {
      resolveQuery = resolve
      rejectQuery = reject
    })
    const query = {
      submit(connection) {
        connection.parse({ name: 'raw-order-a', text: 'SELECT -16909061::int4 AS value' })
        connection.parse({ name: 'raw-order-b', text: "SELECT 'Привет🙂'::text AS value" })
        connection.bind({ portal: 'a', statement: 'raw-order-a', values: [], binary: true })
        connection.bind({ portal: 'b', statement: 'raw-order-b', values: [] })
        connection.describe({ type: 'P', name: 'a' })
        connection.describe({ type: 'P', name: 'b' })
        connection.execute({ portal: 'a', rows: 0 })
        connection.execute({ portal: 'b', rows: 0 })
        connection.sync()
      },
      handleRowDescription(message) {
        results[described++].addFields(message.fields)
      },
      handleDataRow(message) {
        assert.strictEqual(Buffer.isBuffer(message.buffer), true)
        assert.strictEqual(typeof message.offset, 'number')
        results[completed].addRow(results[completed].parseRawRow(message))
      },
      handleCommandComplete(message) {
        results[completed++].addCommandComplete(message)
      },
      handleReadyForQuery() {
        resolveQuery()
      },
      handleError(error) {
        rejectQuery(error)
      },
    }

    client.query(query)
    await finished

    assert.deepStrictEqual(results[0].rows, [{ value: -16909061 }])
    assert.deepStrictEqual(results[1].rows, [{ value: 'Привет🙂' }])
    assert.strictEqual(client.getTransactionStatus(), 'I')
  } finally {
    await client.end()
  }
})
