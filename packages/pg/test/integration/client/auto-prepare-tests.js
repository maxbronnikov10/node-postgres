'use strict'
const assert = require('assert')
const helper = require('./test-helper')
const suite = new helper.Suite()

suite.test('automatic preparation is opt-in and validates its limit', () => {
  const client = new helper.pg.Client()
  assert.strictEqual(client._autoPreparedStatements, undefined)
  for (const maxAutoPrepare of [-1, 1.5, Infinity, '10', true]) {
    assert.throws(() => new helper.pg.Client({ maxAutoPrepare }), /maxAutoPrepare/)
  }
})

for (const pipeline of [false, true]) {
  suite.test(`bounded automatic statements preserve results and explicit names (pipeline=${pipeline})`, async () => {
    const client = new helper.pg.Client({ pipeline, maxAutoPrepare: 2 })
    await client.connect()
    try {
      const sql = 'SELECT $1::int AS n'
      const config = Object.freeze({ text: sql, values: [1] })
      await client.query(config)
      assert.strictEqual(config.name, undefined)
      await client.query('BEGIN')
      const rows = await Promise.all(Array.from({ length: 10 }, (_, i) => client.query(sql, [i])))
      assert.deepStrictEqual(
        rows.map((r) => r.rows[0].n),
        Array.from({ length: 10 }, (_, i) => i)
      )
      await client.query('COMMIT')
      const row = await client.query({ text: sql, values: [42], rowMode: 'array' })
      assert.deepStrictEqual(row.rows, [[42]])
      for (let i = 0; i < 5; i++) {
        assert.strictEqual((await client.query(`SELECT $1::int + ${i} AS n`, [10])).rows[0].n, 10 + i)
      }
      await client.query({ text: sql, values: [9], name: 'user_query' })
      await client.query({ name: 'user_query', values: [10] })
      const prepared = await client.query('SELECT name FROM pg_prepared_statements')
      assert.strictEqual(prepared.rowCount, 3)
      assert.strictEqual(prepared.rows.filter((r) => r.name.startsWith('pg_auto_')).length, 2)
      assert.strictEqual(client._autoPreparedStatements.size, 2)
    } finally {
      await client.end()
    }
  })

  suite.test(
    `automatic statements recover after parse, execution and encoding errors (pipeline=${pipeline})`,
    async () => {
      const client = new helper.pg.Client({ pipeline, maxAutoPrepare: 10 })
      await client.connect()
      try {
        const insert = 'INSERT INTO auto_prepare_test VALUES ($1) RETURNING n'
        await assert.rejects(client.query(insert, [1]), { code: '42P01' })
        await client.query('CREATE TEMP TABLE auto_prepare_test(n int PRIMARY KEY)')
        await client.query('BEGIN')
        const outcomes = await Promise.allSettled([1, 1, 2].map((n) => client.query(insert, [n])))
        assert.deepStrictEqual(
          outcomes.map((r) => r.status),
          ['fulfilled', 'rejected', 'rejected']
        )
        assert.strictEqual(outcomes[1].reason.code, '23505')
        assert.strictEqual(outcomes[2].reason.code, '25P02')
        await client.query('ROLLBACK')
        assert.strictEqual((await client.query('SELECT * FROM auto_prepare_test')).rowCount, 0)
        assert.strictEqual((await client.query(insert, [3])).rows[0].n, 3)

        // Both a first Parse and a cache hit can fail while encoding Bind values.
        for (const text of ['SELECT $1::text AS value', insert]) {
          let calls = 0
          const error = new Error('cannot encode value')
          await new Promise((resolve) => {
            client.query(
              text,
              [
                {
                  toPostgres() {
                    throw error
                  },
                },
              ],
              (err) => {
                calls++
                assert.strictEqual(err, error)
                resolve()
              }
            )
          })
          const result = await client.query(text, [4])
          assert.strictEqual(result.rowCount, 1)
          assert.strictEqual(calls, 1)
        }
        const text = 'SELECT $1::int AS pipelined'
        const pending = await Promise.allSettled([
          client.query(text, [1]),
          client.query(text, [
            {
              toPostgres() {
                throw new Error('encoding failed')
              },
            },
          ]),
          client.query(text, [2]),
        ])
        assert.deepStrictEqual(
          pending.map((r) => r.status),
          ['fulfilled', 'rejected', 'fulfilled']
        )
        assert.strictEqual((await client.query(text, [3])).rows[0].pipelined, 3)
      } finally {
        await client.end()
      }
    }
  )
}
