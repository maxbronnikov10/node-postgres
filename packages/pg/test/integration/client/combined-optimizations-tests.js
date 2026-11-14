'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const suite = new helper.Suite('combined client optimizations')
const options = { pipeline: true, autoBatch: true, maxAutoPrepare: 16 }

const transactionCases = [
  { command: 'COMMIT', rows: [{ id: 1 }, { id: 2 }, { id: 3 }], why: 'concurrent writes persist in order' },
  { command: 'ROLLBACK', rows: [], why: 'concurrent writes leave no rows' },
]

for (const { command, rows, why } of transactionCases) {
  suite.test(`${command}: ${why} with all optimizations enabled`, async () => {
    const client = new helper.pg.Client(options)
    await client.connect()
    try {
      await client.query('CREATE TEMP TABLE combined_writes (id int PRIMARY KEY)')
      await client.query('BEGIN')
      const sql = 'INSERT INTO combined_writes VALUES ($1) RETURNING id'

      const results = await Promise.all([client.query(sql, [3]), client.query(sql, [1]), client.query(sql, [2])])
      await client.query(command)

      assert.deepStrictEqual(
        results.map((result) => result.rows),
        [[{ id: 3 }], [{ id: 1 }], [{ id: 2 }]]
      )
      assert.deepStrictEqual(
        results.map((result) => result.rowCount),
        [1, 1, 1]
      )
      assert.deepStrictEqual((await client.query('SELECT id FROM combined_writes ORDER BY id')).rows, rows)
    } finally {
      await client.end()
    }
  })
}

const encodingError = new Error('combined parameter encoding failed')
const errorCases = [
  { value: 1, error: { code: '23505' }, why: 'an execution error aborts the remaining cached writes' },
  {
    value: {
      toPostgres() {
        throw encodingError
      },
    },
    error: encodingError,
    why: 'a local encoding error settles the remaining cached writes',
  },
]

for (const { value, error, why } of errorCases) {
  suite.test(`${why} and the same SQL works after rollback`, async () => {
    const client = new helper.pg.Client(options)
    await client.connect()
    try {
      await client.query('CREATE TEMP TABLE combined_errors (id int PRIMARY KEY, payload text)')
      const sql = 'INSERT INTO combined_errors VALUES ($1, $2) RETURNING id'
      await client.query(sql, [0, 'cached'])
      await client.query('BEGIN')

      // Force a partial write before local encoding fails, exercising recovery of sent statements.
      const results = await Promise.allSettled([
        client.query(sql, [1, 'x'.repeat(70000)]),
        client.query(sql, [value, 'failed']),
        client.query(sql, [2, 'skipped']),
      ])
      await client.query('ROLLBACK')
      const recovered = await client.query(sql, [2, 'recovered'])

      assert.deepStrictEqual(
        results.map((result) => result.status),
        ['fulfilled', 'rejected', 'rejected']
      )
      assert.deepStrictEqual(results[0].value.rows, [{ id: 1 }])
      assert.strictEqual(results[0].value.rowCount, 1)
      await assert.rejects(Promise.reject(results[1].reason), error)
      assert.strictEqual(results[2].reason.code, 'PG_BATCH_ABORTED')
      assert.deepStrictEqual(recovered.rows, [{ id: 2 }])
      assert.strictEqual(recovered.rowCount, 1)
      assert.deepStrictEqual((await client.query('SELECT id, payload FROM combined_errors ORDER BY id')).rows, [
        { id: 0, payload: 'cached' },
        { id: 2, payload: 'recovered' },
      ])
    } finally {
      await client.end()
    }
  })
}

suite.test('explicit batches preserve queued query boundaries and cached statements survive rollback', async () => {
  const client = new helper.pg.Client(options)
  await client.connect()
  try {
    await client.query('CREATE TEMP TABLE combined_boundaries (id int PRIMARY KEY)')
    const sql = 'INSERT INTO combined_boundaries VALUES ($1) RETURNING id'
    await client.query(sql, [0])
    await client.query('BEGIN')

    const before = await client.query(sql, [1])
    const batch = client.batch([
      { text: sql, values: [2] },
      { text: sql, values: [3] },
    ])
    const after = client.query(sql, [4])
    const snapshot = client.query('SELECT id FROM combined_boundaries ORDER BY id')
    const results = await Promise.all([before, batch, after, snapshot])

    assert.deepStrictEqual(results[0].rows, [{ id: 1 }])
    assert.deepStrictEqual(
      results[1].map((result) => result.rows),
      [[{ id: 2 }], [{ id: 3 }]]
    )
    assert.deepStrictEqual(
      results[1].map((result) => result.rowCount),
      [1, 1]
    )
    assert.deepStrictEqual(results[2].rows, [{ id: 4 }])
    assert.deepStrictEqual(results[3].rows, [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
    await client.query('ROLLBACK')
    assert.deepStrictEqual((await client.query(sql, [5])).rows, [{ id: 5 }])
    assert.deepStrictEqual((await client.query('SELECT id FROM combined_boundaries ORDER BY id')).rows, [
      { id: 0 },
      { id: 5 },
    ])
  } finally {
    await client.end()
  }
})
