'use strict'

const assert = require('assert')
const helper = require('./test-helper')
const suite = new helper.Suite('immutable errors')
const options = helper.args.native ? {} : { pipeline: true, autoBatch: true }
const readonlyStack = new Error('read-only stack failure')
Object.defineProperty(readonlyStack, 'stack', { value: readonlyStack.stack, writable: false, configurable: false })

const cases = [
  { failure: Object.freeze(new Error('frozen encoding failure')), why: 'a frozen Error' },
  { failure: Object.seal(new Error('sealed encoding failure')), why: 'a sealed Error' },
  { failure: readonlyStack, why: 'an Error with a read-only stack' },
]
const queryModes = [
  { config: { text: 'SELECT $1::text' }, why: 'unnamed' },
  { config: { text: 'SELECT $1::text', name: 'immutable_error' }, why: 'named' },
]

for (const { failure, why } of cases) {
  for (const { config, why: mode } of queryModes) {
    suite.test(`${why} survives the ${mode} query Promise and the connection recovers`, async () => {
      const client = new helper.pg.Client(options)
      await client.connect()
      try {
        await client.query('BEGIN')

        const results = await Promise.allSettled([
          client.query({
            ...config,
            values: [
              {
                toPostgres() {
                  throw failure
                },
              },
            ],
          }),
          client.query('SELECT $1::text', ['following']),
        ])
        await client.query('ROLLBACK')

        assert.strictEqual(results[0].reason, failure)
        assert.strictEqual((await client.query('SELECT 7 AS n')).rows[0].n, 7)
      } finally {
        await client.end()
      }
    })

    suite.test(`${why} survives the ${mode} Pool.query Promise and the pool remains usable`, async () => {
      const pool = new helper.pg.Pool({ max: 1 })
      try {
        const result = await Promise.allSettled([
          pool.query({
            ...config,
            values: [
              {
                toPostgres() {
                  throw failure
                },
              },
            ],
          }),
        ])

        assert.strictEqual(result[0].reason, failure)
        assert.strictEqual((await pool.query('SELECT 9 AS n')).rows[0].n, 9)
      } finally {
        await pool.end()
      }
    })
  }
}

for (const { config, why } of queryModes) {
  suite.test(`${why} queries reject invalid values without inheriting a previous server error`, async () => {
    const client = new helper.pg.Client()
    await client.connect()
    try {
      await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })

      await assert.rejects(client.query({ ...config, values: {} }), (error) => {
        assert.strictEqual(error.message, 'Query values must be an array')
        assert.strictEqual(error.code, undefined)
        return true
      })

      assert.strictEqual((await client.query('SELECT 11 AS n')).rows[0].n, 11)
    } finally {
      await client.end()
    }
  })
}

const afterServerErrors = [
  { failure: new Error('local conversion failed'), why: 'mutable' },
  { failure: Object.freeze(new Error('local conversion failed')), why: 'frozen' },
]

for (const { failure, why } of afterServerErrors) {
  for (const { config, why: mode } of queryModes) {
    suite.test(`a ${why} ${mode} conversion error retains its identity after a server failure`, async () => {
      const client = new helper.pg.Client()
      await client.connect()
      try {
        await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })

        await assert.rejects(
          client.query({
            ...config,
            values: [
              {
                toPostgres() {
                  throw failure
                },
              },
            ],
          }),
          (error) => error === failure
        )

        assert.strictEqual(failure.code, undefined)
        assert.strictEqual(failure.severity, undefined)
        assert.deepStrictEqual((await client.query('SELECT 29 AS n')).rows, [{ n: 29 }])
      } finally {
        await client.end()
      }
    })
  }
}

suite.test('a prepared-name conflict is a local error even after a server failure', async () => {
  const client = new helper.pg.Client()
  await client.connect()
  try {
    await client.query({ name: 'local_conflict', text: 'SELECT 1' })
    await assert.rejects(client.query('SELECT 1 / 0'), { code: '22012' })

    await assert.rejects(client.query({ name: 'local_conflict', text: 'SELECT 2' }), (error) => {
      assert.strictEqual(
        error.message,
        "Prepared statements must be unique - 'local_conflict' was used for a different statement"
      )
      assert.strictEqual(error.code, undefined)
      return true
    })

    assert.deepStrictEqual((await client.query('SELECT 31 AS n')).rows, [{ n: 31 }])
  } finally {
    await client.end()
  }
})

const thrownValues = [
  { value: null, why: 'null' },
  { value: undefined, why: 'undefined' },
  { value: false, why: 'false' },
  { value: 0, why: 'zero' },
  { value: '', why: 'an empty string' },
  { value: 'encoding failed', why: 'a string' },
]

for (const { value, why } of thrownValues) {
  suite.test(`a converter throwing ${why} rejects rather than silently succeeding`, async () => {
    const client = new helper.pg.Client()
    await client.connect()
    try {
      await assert.rejects(
        client.query('SELECT $1::text', [
          {
            toPostgres() {
              throw value
            },
          },
        ]),
        (error) => {
          assert.ok(error instanceof Error)
          assert.strictEqual(error.cause, value)
          return true
        }
      )

      assert.strictEqual((await client.query('SELECT 13 AS n')).rows[0].n, 13)
    } finally {
      await client.end()
    }
  })
}
