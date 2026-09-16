'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const suite = new helper.Suite('automatic transaction batches')

async function connect(options = {}) {
  const client = new helper.pg.Client({ pipeline: true, autoBatch: true, ...options })
  await client.connect()
  client.syncs = 0
  const sync = client.connection.sync
  client.connection.sync = function () {
    client.syncs++
    return sync.call(this)
  }
  return client
}

suite.test('query promises share a Sync only inside an opted-in transaction', async () => {
  for (const options of [{}, { autoBatch: false }, { pipeline: false }]) {
    const client = await connect(options)
    try {
      const queries = () => Array.from({ length: 10 }, (_, n) => client.query('SELECT $1::int AS n', [n]))
      await Promise.all(queries())
      assert.equal(client.syncs, 10)
      await client.query('BEGIN')
      client.syncs = 0
      const results = await Promise.all(queries())
      assert.deepStrictEqual(
        results.map((r) => r.rows[0].n),
        Array.from({ length: 10 }, (_, n) => n)
      )
      assert.ok(results.every((r) => r.rowCount === 1 && r.fields[0].name === 'n'))
      assert.equal(client.syncs, options.autoBatch === false || options.pipeline === false ? 10 : 1)
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  }
})

suite.test('control statements and simple SQL keep their own boundaries', async () => {
  const client = await connect()
  try {
    await client.query('BEGIN')
    const first = client.query('SELECT $1::int AS n', [1])
    const second = client.query('SELECT $1::int AS n', [2])
    const savepoint = client.query('SAVEPOINT before_more')
    const third = client.query('SELECT $1::int AS n', [3])
    const fourth = client.query('SELECT $1::int AS n', [4])
    await Promise.all([first, second, savepoint, third, fourth])
    assert.equal(client.syncs, 3)
    const multi = await client.query('SELECT 5 AS n; SELECT 6 AS n')
    assert.deepStrictEqual(
      multi.map((r) => r.rows[0].n),
      [5, 6]
    )
    await client.query('ROLLBACK TO before_more')
    await client.query('COMMIT')
    assert.equal(client.getTransactionStatus(), 'I')
  } finally {
    await client.end()
  }
})

suite.test('first, middle and last errors settle every query and allow savepoint recovery', async () => {
  const client = await connect()
  try {
    await client.query('BEGIN')
    await client.query('SAVEPOINT before_error')
    for (const failedAt of [0, 1, 2]) {
      const results = await Promise.allSettled(
        [0, 1, 2].map((n) => client.query('SELECT 1 / $1::int AS n', [n === failedAt ? 0 : 1]))
      )
      for (let n = 0; n < results.length; n++) {
        if (n < failedAt) assert.equal(results[n].status, 'fulfilled')
        else {
          assert.equal(results[n].status, 'rejected')
          assert.equal(results[n].reason.code, n === failedAt ? '22012' : 'PG_BATCH_ABORTED')
          if (n > failedAt) assert.strictEqual(results[n].reason.cause, results[failedAt].reason)
        }
      }
      await client.query('ROLLBACK TO before_error')
    }
    await client.query('COMMIT')
  } finally {
    await client.end()
  }
})

suite.test('row parsing errors stay with their query, including a later server error', async () => {
  const client = await connect()
  const parseError = new Error('custom parser failed')
  try {
    await client.query('BEGIN')
    for (const divideBy of [1, 0]) {
      const results = await Promise.allSettled([
        client.query({
          text: 'SELECT $1::int',
          values: [1],
          types: {
            getTypeParser: () => () => {
              throw parseError
            },
          },
        }),
        client.query('SELECT 1 / $1::int AS n', [divideBy]),
      ])
      assert.strictEqual(results[0].reason, parseError)
      if (divideBy) assert.equal(results[1].value.rows[0].n, 1)
      else assert.equal(results[1].reason.code, '22012')
    }
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
})

suite.test('local encoding errors settle unsent queries and partial writes', async () => {
  const client = await connect()
  const encodeError = new Error('custom encoding failed')
  try {
    await client.query('BEGIN')
    for (const text of ['short', 'x'.repeat(70000)]) {
      const results = await Promise.allSettled([
        client.query('SELECT $1::text AS text', [text]),
        client.query('SELECT $1::text', [
          {
            toPostgres() {
              throw encodeError
            },
          },
        ]),
        client.query('SELECT $1::int', [3]),
      ])
      assert.strictEqual(results[1].reason, encodeError)
      assert.equal(results[2].reason.code, 'PG_BATCH_ABORTED')
      if (text.length > 65536) assert.equal(results[0].value.rows[0].text, text)
      else assert.equal(results[0].reason.code, 'PG_BATCH_ABORTED')
      assert.equal((await client.query('SELECT 4 AS n')).rows[0].n, 4)
    }
    const mixed = await Promise.allSettled([
      client.query('SELECT 1/0, $1::text', ['x'.repeat(70000)]),
      client.query('SELECT $1::text', [
        {
          toPostgres() {
            throw encodeError
          },
        },
      ]),
    ])
    assert.equal(mixed[0].reason.code, '22012')
    assert.strictEqual(mixed[1].reason, encodeError)
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
})

suite.test('callbacks, array results, named statements and drain preserve each result', async () => {
  const client = await connect()
  try {
    await client.query('BEGIN')
    const pending = Array.from(
      { length: 6 },
      (_, n) =>
        new Promise((resolve, reject) => {
          client.query(
            { name: 'auto_large', text: 'SELECT $1::text, $2::int', values: ['x'.repeat(70000), n], rowMode: 'array' },
            (err, result) => (err ? reject(err) : resolve(result))
          )
        })
    )
    const following = client.query('SELECT 9 AS n')
    const results = await Promise.all(pending)
    assert.deepStrictEqual(
      results.map((r) => r.rows[0][1]),
      [0, 1, 2, 3, 4, 5]
    )
    assert.ok(results.every((r) => r.rows[0][0].length === 70000))
    assert.equal((await following).rows[0].n, 9)
    assert.equal(client.syncs, 1)
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }
})

suite.test('timed queries keep separate boundaries and shutdown drains a scheduled batch', async () => {
  const client = await connect()
  try {
    await client.query('BEGIN')
    await Promise.all([1, 2].map((n) => client.query({ text: 'SELECT $1::int', values: [n], query_timeout: 1000 })))
    assert.equal(client.syncs, 2)
    const pending = Promise.all([1, 2].map((n) => client.query('SELECT $1::int AS n', [n])))
    const ended = client.end()
    assert.deepStrictEqual(
      (await pending).map((r) => r.rows[0].n),
      [1, 2]
    )
    await ended
  } finally {
    if (!client._ended) await client.end()
  }
})
