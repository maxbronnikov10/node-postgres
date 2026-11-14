'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const suite = new helper.Suite('optimization compatibility')

const modes = [
  {
    options: {},
    rows: [{ id: 2 }],
    secondStatus: 'fulfilled',
    skippedCode: undefined,
    why: 'serial queries preserve later writes',
  },
  {
    options: { pipeline: true },
    rows: [{ id: 2 }],
    secondStatus: 'fulfilled',
    skippedCode: undefined,
    why: 'pipeline preserves later writes',
  },
  {
    options: { pipeline: true, autoBatch: true },
    rows: [],
    secondStatus: 'rejected',
    skippedCode: 'PG_BATCH_ABORTED',
    why: 'shared Sync intentionally skips later writes after a local encoding error',
  },
]

for (const { options, rows, secondStatus, skippedCode, why } of modes) {
  suite.test(why, async () => {
    const client = new helper.pg.Client(options)
    const failure = new Error('cannot encode the first write')
    await client.connect()
    try {
      await client.query('CREATE TEMP TABLE optimization_writes (id int)')
      await client.query('BEGIN')
      const sql = 'INSERT INTO optimization_writes VALUES ($1) RETURNING id'

      const results = await Promise.allSettled([
        client.query(sql, [
          {
            toPostgres() {
              throw failure
            },
          },
        ]),
        client.query(sql, [2]),
      ])
      await client.query('COMMIT')

      assert.strictEqual(results[0].status, 'rejected')
      assert.strictEqual(results[0].reason, failure)
      assert.strictEqual(results[1].status, secondStatus)
      assert.strictEqual(results[1].reason?.code, skippedCode)
      assert.deepStrictEqual((await client.query('SELECT id FROM optimization_writes')).rows, rows)
    } finally {
      await client.end()
    }
  })
}

const prepareModes = [
  {
    options: {},
    why: 'ordinary queries accept a changed result shape',
    status: 'fulfilled',
    rows: [{ id: 1, label: null }],
    errorCode: undefined,
  },
  {
    options: { maxAutoPrepare: 8 },
    why: 'automatic prepared statements retain PostgreSQL plan semantics',
    status: 'rejected',
    rows: undefined,
    errorCode: '0A000',
  },
]

for (const { options, why, status, rows, errorCode } of prepareModes) {
  suite.test(why, async () => {
    const client = new helper.pg.Client(options)
    await client.connect()
    try {
      await client.query('CREATE TEMP TABLE optimization_shape (id int)')
      await client.query('INSERT INTO optimization_shape VALUES (1)')
      const sql = 'SELECT * FROM optimization_shape WHERE id = $1'
      await client.query(sql, [1])
      await client.query('ALTER TABLE optimization_shape ADD COLUMN label text')

      const outcome = await Promise.allSettled([client.query(sql, [1])])

      assert.strictEqual(outcome[0].status, status)
      assert.strictEqual(outcome[0].reason?.code, errorCode)
      assert.deepStrictEqual(outcome[0].value?.rows, rows)
      assert.strictEqual((await client.query('SELECT 7 AS n')).rows[0].n, 7)
    } finally {
      await client.end()
    }
  })
}

suite.test('large pipelined writes remain bounded and graceful shutdown drains every queued query', async () => {
  const client = new helper.pg.Client({ pipeline: true })
  await client.connect()
  try {
    const payload = Buffer.alloc(4194304)
    const sql = 'SELECT octet_length($1::bytea) AS bytes, $2::int AS n, pg_sleep(0.02)'

    const pending = Promise.all([
      client.query(sql, [payload, 1]),
      client.query(sql, [payload, 2]),
      client.query(sql, [payload, 3]),
      client.query(sql, [payload, 4]),
    ])
    assert.ok(client.connection.stream.writableLength < 5242880)
    const ended = client.end()
    const results = await pending
    await ended

    assert.deepStrictEqual(
      results.map((result) => result.rows[0].n),
      [1, 2, 3, 4]
    )
    assert.deepStrictEqual(
      results.map((result) => result.rows[0].bytes),
      [4194304, 4194304, 4194304, 4194304]
    )
    assert.strictEqual(client.connection.stream.listenerCount('drain'), 0)
  } finally {
    await client.end()
  }
})

suite.test('a result parser throwing null rejects instead of returning incomplete rows', async () => {
  const client = new helper.pg.Client()
  await client.connect()
  try {
    await assert.rejects(
      client.query({
        text: 'SELECT n FROM generate_series(1, 3) n',
        types: {
          getTypeParser() {
            return () => {
              throw null
            }
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof Error)
        assert.strictEqual(error.cause, null)
        return true
      }
    )

    assert.strictEqual((await client.query('SELECT 17 AS n')).rows[0].n, 17)
  } finally {
    await client.end()
  }
})
