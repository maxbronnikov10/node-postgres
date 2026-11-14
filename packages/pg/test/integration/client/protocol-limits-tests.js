'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const { Client, QueryExecutor, QueryExecutorError } = helper.pg
const suite = new helper.Suite('protocol message limits')

if (typeof require('events').addAbortListener === 'function') {
  suite.test('an oversized executor result is unknown and its discarded connection is replaced', async () => {
    const executor = new QueryExecutor({ max: 1, maxMessageSize: 128, query_timeout: 2000 })
    try {
      await assert.rejects(executor.query("SELECT repeat('x', 1024) AS value"), (error) => {
        assert.ok(error instanceof QueryExecutorError)
        assert.strictEqual(error.outcome, 'unknown')
        assert.strictEqual(error.safeToRetry, false)
        assert.strictEqual(error.cause.code, 'PG_PROTOCOL_ERROR')
        return true
      })

      const deadline = Date.now() + 1500
      while (executor.totalCount !== 0) {
        assert.ok(Date.now() < deadline, 'Discarded executor connection did not close')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.strictEqual(executor.waitingCount, 0)
      assert.strictEqual(executor.inFlightCount, 0)
      await new Promise((resolve) => setTimeout(resolve, 125))

      const result = await executor.query('SELECT 17 AS value')

      assert.deepStrictEqual(result.rows, [{ value: 17 }])
      assert.strictEqual(executor.totalCount, 1)
      assert.strictEqual(executor.waitingCount, 0)
      assert.strictEqual(executor.inFlightCount, 0)
    } finally {
      await executor.destroy()
    }
  })

  suite.test('an explicit larger executor limit preserves every byte of a large field', async () => {
    const executor = new QueryExecutor({ max: 1, maxMessageSize: 4096, query_timeout: 2000 })
    try {
      const result = await executor.query("SELECT repeat('x', 1024) AS value")

      assert.strictEqual(result.rows.length, 1)
      assert.strictEqual(result.rows[0].value.length, 1024)
      assert.deepStrictEqual(Buffer.from(result.rows[0].value), Buffer.alloc(1024, 120))
    } finally {
      await executor.end()
    }
  })
}

suite.test('an ordinary Client rejects an oversized result and closes its transport', async () => {
  const client = new Client({ maxMessageSize: 128 })
  const errors = []
  client.on('error', (error) => errors.push(error))
  const ended = new Promise((resolve) => client.once('end', resolve))
  try {
    await client.connect()

    await assert.rejects(client.query("SELECT repeat('x', 1024) AS value"), {
      name: 'ProtocolError',
      code: 'PG_PROTOCOL_ERROR',
    })
    await ended
    await client.end()

    assert.strictEqual(client.connection.stream.destroyed, true)
    assert.ok(errors.some((error) => error.code === 'PG_PROTOCOL_ERROR'))
  } finally {
    await client.end()
  }
})

const invalidLimits = [
  { maxMessageSize: 3, why: 'a length below the header size' },
  { maxMessageSize: 4.5, why: 'a fractional length' },
  { maxMessageSize: 2147483648, why: 'signed int32 overflow' },
  { maxMessageSize: NaN, why: 'a nonnumeric length' },
  { maxMessageSize: Infinity, why: 'an infinite length' },
]
for (const { maxMessageSize, why } of invalidLimits) {
  suite.test(`Client rejects ${why} before opening a connection`, () => {
    assert.throws(() => new Client({ maxMessageSize }), TypeError)
  })

  if (typeof require('events').addAbortListener === 'function') {
    suite.test(`QueryExecutor rejects ${why} before opening a connection`, () => {
      assert.throws(
        () => new QueryExecutor({ maxMessageSize }),
        (error) => {
          assert.ok(error instanceof QueryExecutorError)
          assert.strictEqual(error.code, 'PG_EXECUTOR_INVALID')
          assert.strictEqual(error.outcome, 'not-sent')
          assert.strictEqual(error.safeToRetry, true)
          return true
        }
      )
    })
  }
}
