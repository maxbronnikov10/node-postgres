'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const resultBudget = require('../../../lib/query-result-budget')
const suite = new helper.Suite('internal owned DataRow delivery')

for (const event of ['dataRow', 'message']) {
  suite.test(`adding a ${event} observer during a row restores normal delivery before the next row`, async () => {
    const client = new helper.pg.Client({ pipeline: true })
    await client.connect()
    const observed = []
    const emitted = []
    let borrowed = 0
    try {
      const result = await client.query({
        text: 'SELECT n::int4 AS n FROM generate_series(1, 3) n',
        queryMode: 'extended',
        [resultBudget]: (query) => {
          const handleDataRow = query.handleDataRow
          query.handleDataRow = function (message) {
            if (!('fields' in message)) {
              borrowed++
              client.connection.on(event, (message) => {
                if (message.name === 'dataRow') observed.push(Number(message.fields[0]))
              })
              query.on('row', (row) => emitted.push(row.n))
            }
            handleDataRow.call(this, message)
          }
          return () => true
        },
      })

      assert.deepStrictEqual(result.rows, [{ n: 1 }, { n: 2 }, { n: 3 }])
      assert.strictEqual(borrowed, 1)
      assert.deepStrictEqual(observed, [2, 3])
      assert.deepStrictEqual(emitted, [1, 2, 3])
      assert.strictEqual(client.connection._parser.dataRowConsumer, undefined)
    } finally {
      await client.end()
    }
  })
}

suite.test('removing the original DataRow handler stops borrowed row delivery immediately', async () => {
  const client = new helper.pg.Client()
  await client.connect()
  try {
    const result = await client.query({
      text: 'SELECT n::int4 AS n FROM generate_series(1, 3) n',
      queryMode: 'extended',
      [resultBudget]: (query) => {
        query.on('row', () => {
          client.connection.removeListener('dataRow', client.connection.listeners('dataRow')[0])
        })
        return () => true
      },
    })

    assert.deepStrictEqual(result.rows, [{ n: 1 }])
    assert.strictEqual(result.rowCount, 3)
    assert.strictEqual(client.connection._parser.dataRowConsumer, undefined)
  } finally {
    await client.end()
  }
})

const fallbackCases = [
  { why: 'ordinary Client query', owned: false },
  { why: 'binary int4 query', owned: true, binary: true },
  {
    why: 'custom text parser query',
    owned: true,
    types: { getTypeParser: () => (value) => Number(value) },
  },
]
for (const { why, owned, binary, types } of fallbackCases) {
  suite.test(`${why} keeps normal DataRow messages`, async () => {
    const client = new helper.pg.Client()
    await client.connect()
    let borrowed = 0
    const query = new helper.pg.Query({ text: 'SELECT 7::int4 AS n', queryMode: 'extended', binary, types })
    const handleDataRow = query.handleDataRow
    query.handleDataRow = function (message) {
      if (!('fields' in message)) borrowed++
      handleDataRow.call(this, message)
    }
    if (owned) query._resultBudget = () => true
    try {
      const result = await new Promise((resolve, reject) => {
        query.callback = (error, result) => (error ? reject(error) : resolve(result))
        client.query(query)
      })

      assert.deepStrictEqual(result.rows, [{ n: 7 }])
      assert.strictEqual(borrowed, 0)
    } finally {
      await client.end()
    }
  })
}

suite.test('pipelined executor int4 rows retain results and release all row budgets', async () => {
  const executor = new helper.pg.QueryExecutor({ max: 1, maxInFlightPerConnection: 2 })
  try {
    const results = await Promise.all([
      executor.query("SELECT '-2147483648'::int4 AS n, NULL::int4 AS missing"),
      executor.query({ text: 'SELECT 2147483647::int4 AS n', rowMode: 'array' }),
    ])

    assert.deepStrictEqual(results[0].rows, [{ n: -2147483648, missing: null }])
    assert.deepStrictEqual(results[1].rows, [[2147483647]])
    assert.strictEqual(executor._resultRows, 0)
    assert.strictEqual(executor._resultBytes, 0)
    for (const record of executor._records) {
      assert.strictEqual(record.client.connection._parser.dataRowConsumer, undefined)
    }
  } finally {
    await executor.end()
  }
})
