'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return

const suite = new helper.Suite('transaction batches')

for (const sql of ['COPY (SELECT 1) TO STDOUT', 'COPY copy_test FROM STDIN']) {
  suite.test(`rejects unsupported ${sql}`, async () => {
    const client = new helper.pg.Client({ pipeline: true })
    client.on('error', () => {})
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TEMP TABLE copy_test (n int)')
      await assert.rejects(client.batch([sql]), /COPY is not supported/)
    } finally {
      await client.end()
    }
  })
}

for (const pipeline of [false, true]) {
  suite.test(`client timeout during batch (pipeline=${pipeline})`, async () => {
    const client = new helper.pg.Client({ pipeline, query_timeout: 50 })
    client.on('error', () => {})
    await client.connect()
    try {
      await client.query('BEGIN')
      await assert.rejects(client.batch(['SELECT pg_sleep(0.2)', 'SELECT 2']), /Query read timeout/)
    } finally {
      await client.end()
    }
  })

  suite.test(`results, boundaries and recovery (pipeline=${pipeline})`, async () => {
    const client = new helper.pg.Client({ pipeline })
    await client.connect()
    try {
      await assert.rejects(client.batch(['SELECT 1']), /explicit transaction/)
      await client.query('BEGIN')
      await client.query('CREATE TEMP TABLE batch_test (id int PRIMARY KEY, n int) ON COMMIT DROP')
      const results = await client.batch([
        { name: 'batch_insert', text: 'INSERT INTO batch_test VALUES ($1, $2) RETURNING n', values: [1, 3] },
        { name: 'batch_insert', values: [2, 4], rowMode: 'array' },
        { text: 'UPDATE batch_test SET n = n + 1 WHERE id = $1', values: [1] },
        'SELECT sum(n)::int AS n FROM batch_test',
        '',
      ])
      assert.deepStrictEqual(
        results.map((r) => r.rowCount),
        [1, 1, 1, 1, null]
      )
      assert.deepStrictEqual(results[0].rows, [{ n: 3 }])
      assert.deepStrictEqual(results[1].rows, [[4]])
      assert.deepStrictEqual(results[3].rows, [{ n: 8 }])
      assert.equal(client.getTransactionStatus(), 'T')
      const callbackResults = await new Promise((resolve, reject) => {
        client.batch([{ name: 'batch_insert', values: [3, 5] }], (err, rows) => (err ? reject(err) : resolve(rows)))
      })
      assert.equal(callbackResults[0].rows[0].n, 5)
      await client.query('SAVEPOINT before_error')
      for (const failedAt of [0, 1, 2]) {
        const commands = [0, 1, 2].map((i) => ({
          name: `batch_error_${failedAt}_${i}`,
          text: i === failedAt ? 'SELECT 1 / 0' : 'UPDATE batch_test SET n = 999',
        }))
        await assert.rejects(client.batch(commands), (err) => err.code === '22012' && err.batchIndex === failedAt)
        await client.query('ROLLBACK TO before_error')
        assert.equal((await client.query('SELECT sum(n)::int AS n FROM batch_test')).rows[0].n, 13)
      }
      // The statement after an error was skipped, including its Parse message.
      assert.equal((await client.query({ name: 'batch_error_0_1', text: 'SELECT 42 AS n' })).rows[0].n, 42)
      await client.query('COMMIT')
      assert.equal(client.getTransactionStatus(), 'I')
    } finally {
      await client.end()
    }
  })

  suite.test(`bounded writes and queued queries (pipeline=${pipeline})`, async () => {
    const client = new helper.pg.Client({ pipeline })
    await client.connect()
    try {
      await client.query('BEGIN')
      const text = 'x'.repeat(70000)
      const pending = client.batch(
        Array.from({ length: 6 }, (_, i) => ({
          name: 'batch_large',
          text: 'SELECT $1::text AS text, $2::int AS n',
          values: [text, i],
        }))
      )
      const following = client.query('SELECT 123::int AS n')
      const results = await pending
      assert.deepStrictEqual(
        results.map((r) => r.rows[0].n),
        [0, 1, 2, 3, 4, 5]
      )
      assert.ok(results.every((r) => r.rows[0].text === text))
      assert.equal((await following).rows[0].n, 123)
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  })

  suite.test(`local errors and prepared-name recovery (pipeline=${pipeline})`, async () => {
    const client = new helper.pg.Client({ pipeline })
    await client.connect()
    try {
      await client.query('BEGIN')
      for (const entries of [
        [],
        [null],
        new Array(1),
        [{ name: '' }],
        [{ text: 'SELECT 1', rows: 1 }],
        [{ text: 'SELECT 1', values: 1 }],
      ]) {
        await assert.rejects(client.batch(entries))
      }
      const value = {
        toPostgres() {
          throw new Error('encode failed')
        },
      }
      await assert.rejects(
        client.batch([
          { name: 'not_sent', text: 'SELECT $1::int AS n', values: [1] },
          { text: 'SELECT $1::int', values: [value] },
        ]),
        /encode failed/
      )
      assert.equal((await client.query({ name: 'not_sent', text: 'SELECT $1::int AS n', values: [7] })).rows[0].n, 7)
      await assert.rejects(
        client.batch([
          { text: 'SELECT $1::text', values: ['x'.repeat(70000)] },
          { text: 'SELECT $1::int', values: [value] },
        ]),
        (err) => err.message === 'encode failed' && err.batchIndex === 1
      )
      const named = await client.batch(
        ['constructor', 'toString', '__proto__'].map((name) => ({ name, text: 'SELECT 7 AS n' }))
      )
      assert.ok(named.every((result) => result.rows[0].n === 7))
      await assert.rejects(
        client.batch([
          { name: 'conflict', text: 'SELECT 1' },
          { name: 'conflict', text: 'SELECT 2' },
        ]),
        /unique/
      )
      const types = {
        getTypeParser() {
          return () => {
            throw new Error('decode failed')
          }
        },
      }
      await assert.rejects(client.batch([{ text: 'SELECT 1', types }, 'SELECT 2']), /decode failed/)
      assert.equal((await client.query('SELECT 3 AS n')).rows[0].n, 3)
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  })
}
