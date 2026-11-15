'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const QueryExecutorFaultProxy = require('./query-executor-fault-proxy')
const { QueryExecutorError } = helper.pg
const suite = new helper.Suite('tagged SQL commit acknowledgement')

async function selectAfterCooldown(sql) {
  try {
    return await sql`SELECT 42 AS n`
  } catch (error) {
    assert.strictEqual(error.code, 'PG_EXECUTOR_UNAVAILABLE')
    assert.strictEqual(error.outcome, 'not-sent')
    assert.strictEqual(error.safeToRetry, true)
    assert.ok(Number.isFinite(error.retryAfterMillis))
    await new Promise((resolve) => setTimeout(resolve, error.retryAfterMillis + 10))
  }
  return await sql`SELECT 42 AS n`
}

suite.test('a lost COMMIT acknowledgement never replays a committed write or its callback', async () => {
  const config = { ...helper.config, ssl: false }
  const control = new helper.pg.Client(config)
  const table = `sql_commit_ack_${process.pid}`
  const proxy = new QueryExecutorFaultProxy({ host: config.host, port: Number(config.port), mode: 'drop-commit-ack' })
  let sql
  let callbackCount = 0
  try {
    await control.connect()
    await control.query(`CREATE TABLE "${table}" (marker text)`)
    await proxy.start()
    sql = helper.pg({ ...config, host: '127.0.0.1', port: proxy.port, max: 1, query_timeout: 2000 })

    await assert.rejects(
      sql.begin(async (tx) => {
        callbackCount++
        await tx`INSERT INTO ${tx.identifier(table)} (marker) VALUES (${'once'})`
      }),
      (error) => {
        assert.ok(error instanceof QueryExecutorError)
        assert.strictEqual(error.outcome, 'unknown')
        assert.strictEqual(error.safeToRetry, false)
        return true
      }
    )

    assert.deepStrictEqual((await control.query(`SELECT marker FROM "${table}"`)).rows, [{ marker: 'once' }])
    assert.strictEqual(callbackCount, 1)
    assert.strictEqual(proxy.dropped, true)
    assert.strictEqual(proxy.failure, null)
    assert.deepStrictEqual(await selectAfterCooldown(sql), [{ n: 42 }])
    assert.strictEqual(proxy.acceptedCount, 2)
  } finally {
    try {
      if (sql) await sql.end()
    } finally {
      try {
        await control.query(`DROP TABLE IF EXISTS "${table}"`)
      } finally {
        try {
          await control.end()
        } finally {
          await proxy.close()
        }
      }
    }
  }
})
