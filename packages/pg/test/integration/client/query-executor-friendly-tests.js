'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
if (typeof require('events').addAbortListener !== 'function') return
const { QueryExecutor, QueryExecutorError } = helper.pg
const suite = new helper.Suite('independent-query executor row helpers')

function assertRowCountError(error) {
  assert.ok(error instanceof QueryExecutorError)
  assert.strictEqual(error.code, 'PG_EXECUTOR_ROW_COUNT')
  assert.strictEqual(error.outcome, 'unknown')
  assert.strictEqual(error.safeToRetry, false)
  return true
}

suite.test('rows returns parameterized values without result metadata', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const rows = await executor.rows('SELECT $1::int AS id, $2::text AS name', [7, 'Ada'])

    assert.deepStrictEqual(rows, [{ id: 7, name: 'Ada' }])
  } finally {
    await executor.end()
  }
})

suite.test('rows returns an empty array when the query finds no rows', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const rows = await executor.rows({ text: 'SELECT 7 AS id WHERE false' })

    assert.deepStrictEqual(rows, [])
  } finally {
    await executor.end()
  }
})

suite.test('one returns the only object row directly', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const row = await executor.one('SELECT $1::int AS id, $2::text AS name', [7, 'Ada'])

    assert.deepStrictEqual(row, { id: 7, name: 'Ada' })
  } finally {
    await executor.end()
  }
})

suite.test('one preserves tuple rows requested with array row mode', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const row = await executor.one({
      text: 'SELECT $1::int AS id, $2::text AS name',
      values: [7, 'Ada'],
      rowMode: 'array',
    })

    assert.deepStrictEqual(row, [7, 'Ada'])
  } finally {
    await executor.end()
  }
})

const invalidCardinalities = [
  {
    method: 'one',
    text: 'SELECT 7 AS id WHERE false',
    why: 'one rejects a missing row instead of returning undefined',
  },
  {
    method: 'one',
    text: 'SELECT generate_series(1, 2) AS id',
    why: 'one rejects multiple rows instead of picking the first',
  },
  {
    method: 'maybeOne',
    text: 'SELECT generate_series(1, 2) AS id',
    why: 'maybeOne rejects multiple rows instead of hiding extra matches',
  },
]
for (const { method, text, why } of invalidCardinalities) {
  suite.test(why, async () => {
    const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
    try {
      await assert.rejects(executor[method](text), assertRowCountError)
    } finally {
      await executor.end()
    }
  })
}

suite.test('maybeOne returns null when the query finds no rows', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const row = await executor.maybeOne('SELECT $1::int AS id WHERE false', [7])

    assert.strictEqual(row, null)
  } finally {
    await executor.end()
  }
})

suite.test('maybeOne returns the only matching row directly', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const row = await executor.maybeOne({ text: 'SELECT $1::int AS id', values: [7] })

    assert.deepStrictEqual(row, { id: 7 })
  } finally {
    await executor.end()
  }
})

const singleStatementMethods = ['query', 'rows', 'one', 'maybeOne']
for (const method of singleStatementMethods) {
  suite.test(`${method} rejects multiple statements through the extended protocol`, async () => {
    const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
    try {
      await assert.rejects(executor[method]('SELECT 7 AS id; SELECT 11 AS id'), {
        code: '42601',
        outcome: 'server-error',
        safeToRetry: false,
      })
    } finally {
      await executor.end()
    }
  })
}

suite.test('one rejects a committed INSERT RETURNING two rows without replaying its non-unique markers', async () => {
  const control = new helper.pg.Client()
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  const table = `executor_friendly_${process.pid}`
  try {
    await control.connect()
    await control.query(`CREATE TABLE ${table} (marker text NOT NULL)`)

    await assert.rejects(
      executor.one({
        text: `INSERT INTO ${table} (marker) VALUES ($1), ($1) RETURNING marker`,
        values: ['committed-once'],
      }),
      assertRowCountError
    )

    assert.deepStrictEqual((await control.query(`SELECT marker FROM ${table} ORDER BY marker`)).rows, [
      { marker: 'committed-once' },
      { marker: 'committed-once' },
    ])
    assert.deepStrictEqual(await executor.rows('SELECT 29 AS value'), [{ value: 29 }])
    assert.deepStrictEqual((await control.query(`SELECT marker FROM ${table} ORDER BY marker`)).rows, [
      { marker: 'committed-once' },
      { marker: 'committed-once' },
    ])
  } finally {
    try {
      await executor.end()
    } finally {
      try {
        await control.query(`DROP TABLE IF EXISTS ${table}`)
      } finally {
        await control.end()
      }
    }
  }
})
