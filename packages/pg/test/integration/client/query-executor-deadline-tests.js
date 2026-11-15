'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const helper = require('./test-helper')
if (helper.args.native || typeof require('node:events').addAbortListener !== 'function') return
const { QueryExecutor } = helper.pg
const suite = new helper.Suite('shared executor deadlines')

suite.test('a shorter queued deadline prevents its write while earlier work completes', async () => {
  const control = new helper.pg.Client()
  const executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 1, query_timeout: 2000 })
  const table = `executor_deadline_${process.pid}`
  try {
    await control.connect()
    await control.query(`CREATE TABLE ${table} (marker text)`)
    await executor.query('SELECT 1')

    const blocker = executor.query('SELECT pg_sleep(0.2)')
    const rejected = assert.rejects(
      executor.query({ text: `INSERT INTO ${table} VALUES ('expired')`, query_timeout: 30 }),
      { code: 'PG_EXECUTOR_TIMEOUT', outcome: 'not-sent', safeToRetry: true }
    )
    await rejected
    await blocker

    assert.deepEqual((await control.query(`SELECT marker FROM ${table}`)).rows, [])
    assert.equal(executor.waitingCount, 0)
    assert.deepEqual((await executor.query('SELECT 7 AS n')).rows, [{ n: 7 }])
  } finally {
    await executor.destroy()
    await control.query(`DROP TABLE IF EXISTS ${table}`)
    await control.end()
  }
})

suite.test('a later shorter assigned deadline discards its pipeline and collateral work', async () => {
  const executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 3, query_timeout: 2000 })
  try {
    await executor.query('SELECT 1')

    const results = await Promise.allSettled([
      executor.query('SELECT pg_sleep(0.3)'),
      executor.query({ text: 'SELECT 2 AS n', query_timeout: 40 }),
      executor.query('SELECT 3 AS n'),
    ])

    assert.equal(results[0].status, 'rejected')
    assert.equal(results[0].reason.code, 'PG_EXECUTOR_UNKNOWN')
    assert.equal(results[0].reason.outcome, 'unknown')
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[1].reason.code, 'PG_EXECUTOR_TIMEOUT')
    assert.equal(results[1].reason.outcome, 'unknown')
    assert.equal(results[1].reason.safeToRetry, false)
    assert.equal(results[2].status, 'rejected')
    assert.equal(results[2].reason.code, 'PG_EXECUTOR_UNKNOWN')
    assert.equal(results[2].reason.outcome, 'unknown')
    assert.equal(executor.inFlightCount, 0)
    assert.equal(executor.waitingCount, 0)
  } finally {
    await executor.destroy()
  }
})

suite.test('an acquired lease outlives its acquisition deadline during a longer reserved query', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 80 })
  try {
    await executor.query({ text: 'SELECT 1', query_timeout: 2000 })
    const lease = await executor.reserve()

    const result = await lease.query({ text: 'SELECT pg_sleep(0.2), 17 AS n', query_timeout: 2000 })
    lease.release()

    assert.equal(result.rows[0].n, 17)
    assert.equal(executor.inFlightCount, 0)
    assert.deepEqual((await executor.query('SELECT 19 AS n')).rows, [{ n: 19 }])
  } finally {
    await executor.destroy()
  }
})

suite.test('timeout zero remains disabled after a completed timed query leaves an idle scheduler', async () => {
  const executor = new QueryExecutor({ max: 1, query_timeout: 80 })
  try {
    await executor.query('SELECT 1')

    const result = await executor.query({ text: 'SELECT pg_sleep(0.2), 23 AS n', query_timeout: 0 })

    assert.equal(result.rows[0].n, 23)
    assert.equal(executor.inFlightCount, 0)
  } finally {
    await executor.end()
  }
})

const shutdowns = [{ shutdown: 'end' }, { shutdown: 'destroy' }]
for (const { shutdown } of shutdowns) {
  suite.test(`${shutdown} drains work and lets a process exit despite distant deadlines`, async () => {
    const script = `
      const assert = require('node:assert/strict')
      const { QueryExecutor } = require(${JSON.stringify(require.resolve('../../../lib'))})
      ;(async () => {
        const executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 1, query_timeout: 60000 })
        await executor.query('SELECT 1')
        const work = Promise.allSettled([
          executor.query('SELECT pg_sleep(0.1)'),
          executor.query('SELECT 2'),
        ])
        await executor.${shutdown}()
        await work
        assert.equal(executor.waitingCount, 0)
        assert.equal(executor.inFlightCount, 0)
        assert.equal(executor.totalCount, 0)
      })().catch((error) => { console.error(error); process.exitCode = 1 })
    `

    await promisify(execFile)(process.execPath, ['-e', script], { timeout: 3000 })
  })
}
