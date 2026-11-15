'use strict'

const assert = require('node:assert/strict')
const helper = require('./test-helper')
if (typeof require('node:events').addAbortListener !== 'function') return
const { QueryExecutor } = helper.pg
const suite = new helper.Suite('exclusive connections share executor capacity')

suite.test('an exclusive connection holds the only slot until release', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const lease = await executor.reserve()
    const before = await lease.query({ text: 'SELECT pg_backend_pid() AS pid' })
    const queued = executor.query('SELECT pg_backend_pid() AS pid')

    assert.equal(executor.totalCount, 1)
    assert.equal(executor.waitingCount, 1)
    lease.release()
    lease.release()
    const after = await queued

    assert.equal(after.rows[0].pid, before.rows[0].pid)
    assert.equal(executor.waitingCount, 0)
  } finally {
    await executor.end()
  }
})

suite.test('releasing an open transaction discards its session before reuse', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  try {
    const lease = await executor.reserve()
    const before = await lease.query({ text: 'SELECT pg_backend_pid() AS pid' })
    await lease.query({ text: 'BEGIN' })
    const queued = executor.query('SELECT pg_backend_pid() AS pid')

    lease.release()
    const after = await queued

    assert.notEqual(after.rows[0].pid, before.rows[0].pid)
    assert.equal(executor.totalCount, 1)
  } finally {
    await executor.end()
  }
})

suite.test('a queued reservation times out without taking another connection', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 30 })
  const lease = await executor.reserve()
  try {
    await assert.rejects(executor.reserve(), { code: 'PG_EXECUTOR_TIMEOUT', outcome: 'not-sent' })

    assert.equal(executor.totalCount, 1)
    assert.equal(executor.waitingCount, 0)
    assert.deepEqual((await lease.query({ text: 'SELECT 42 AS value' })).rows, [{ value: 42 }])
  } finally {
    lease.release()
    await executor.end()
  }
})

suite.test('shutdown drains an active reservation before closing its connection', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  const lease = await executor.reserve()
  const closing = executor.end()

  assert.deepEqual((await lease.query({ text: 'SELECT 42 AS value' })).rows, [{ value: 42 }])
  await assert.rejects(executor.reserve(), { code: 'PG_EXECUTOR_CLOSED' })
  lease.release()
  await closing

  assert.equal(executor.totalCount, 0)
})

suite.test('a reserved transaction cannot bypass the result row budget', async () => {
  const executor = new QueryExecutor({ max: 1, maxResultRows: 1, query_timeout: 2000 })
  const lease = await executor.reserve()
  try {
    await lease.query({ text: 'BEGIN' })

    await assert.rejects(lease.query({ text: 'SELECT generate_series(1, 2) AS value' }), {
      code: 'PG_EXECUTOR_RESULT_LIMIT',
      outcome: 'unknown',
      safeToRetry: false,
    })
    assert.deepEqual((await executor.query('SELECT 42 AS value')).rows, [{ value: 42 }])
  } finally {
    lease.release()
    await executor.end()
  }
})

suite.test('waiting independent queries cannot prevent an active transaction from finishing', async () => {
  const executor = new QueryExecutor({ max: 1, maxPending: 1, query_timeout: 2000 })
  const lease = await executor.reserve()
  try {
    const queued = executor.query('SELECT 7 AS value')

    assert.deepEqual((await lease.query({ text: 'SELECT 42 AS value' })).rows, [{ value: 42 }])
    lease.release()
    assert.deepEqual((await queued).rows, [{ value: 7 }])
  } finally {
    lease.release()
    await executor.end()
  }
})

suite.test('early release discards unfinished reserved work before another query uses its session', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 2000 })
  const lease = await executor.reserve()
  try {
    const pending = lease.query({ text: 'BEGIN' })
    const rejected = assert.rejects(pending, { outcome: 'unknown', safeToRetry: false })

    lease.release()
    await rejected

    assert.deepEqual((await executor.query('SELECT 42 AS value')).rows, [{ value: 42 }])
  } finally {
    lease.release()
    await executor.end()
  }
})
