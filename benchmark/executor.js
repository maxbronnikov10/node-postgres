'use strict'

const assert = require('assert/strict')
const { createTlsConfig } = require('./tls')
const { DelayedProxy } = require('./delayed-proxy')

const READ = 'SELECT id, value FROM benchmark_executor_rows WHERE id = $1'
const WRITE = 'UPDATE benchmark_executor_rows SET value = $1 WHERE id = $2 RETURNING id, value'

class ExecutorWorkload {
  constructor({ pg, arm, options, setupOptions, maxPending }) {
    this.pg = pg
    this.arm = arm
    this.options = options
    this.setupOptions = setupOptions
    this.serial = 0
    this.warmed = false
    this.resource =
      arm % 2 === 0
        ? new pg.Pool(options)
        : new pg.QueryExecutor({ ...options, maxInFlightPerConnection: 16, maxPending })
    this.all = {}
    this.addCase({ name: 'independent SELECT, sequential', kind: 'read', count: 1 })
    this.addCase({ name: 'independent SELECT, 16 concurrent', kind: 'read', count: 16 })
    this.addCase({ name: '500-row SELECT, 16 concurrent', kind: 'bulk', count: 16 })
    this.addCase({ name: 'fresh SQL SELECT, 16 concurrent', kind: 'fresh', count: 16 })
    this.addCase({ name: 'logged UPDATE, 16 concurrent', kind: 'write', count: 16 })
  }

  query({ kind = 'read', index = 0 } = {}) {
    if (kind === 'bulk') {
      return this.resource
        .query({ name: 'executor_bulk', text: 'SELECT id, value FROM benchmark_executor_rows ORDER BY id LIMIT 500' })
        .then((result) => {
          assert.equal(result.rowCount, 500)
          assert.equal(result.rows.length, 500)
          assert.equal(result.fields.length, 2)
          for (let i = 0; i < result.rows.length; i++) {
            assert.equal(result.rows[i].id, i + 1)
            assert.equal(result.rows[i].value, 7)
          }
          return 1
        })
    }
    const id = kind === 'write' ? this.arm * 32 + index + 1 : 42
    const config = {
      text: kind === 'write' ? WRITE : kind === 'fresh' ? `${READ} -- executor_${this.serial++}` : READ,
      values: kind === 'write' ? [7, id] : [id],
      queryMode: 'extended',
    }
    return this.resource.query(config).then((result) => {
      assert.equal(result.rowCount, 1)
      assert.equal(result.rows.length, 1)
      assert.equal(result.rows[0].id, id)
      assert.equal(result.rows[0].value, 7)
      return 1
    })
  }

  addCase({ name, kind, count }) {
    const run = async () => {
      await Promise.all(Array.from({ length: count }, (_, index) => this.query({ kind, index })))
      return count
    }
    run.prepare = async () => {
      await this.prepare()
      await run()
      this.assertIdle()
    }
    this.all[name] = run
  }

  assertIdle() {
    assert.equal(this.resource.totalCount, 4)
    assert.equal(this.resource.waitingCount, 0)
    if (this.arm % 2) assert.equal(this.resource.inFlightCount, 0)
    if (this.proxy) assert.equal(this.proxy.failure, null)
  }

  assertPrepared(client) {
    if (this.tls) this.tls.assertConnection({ client, negotiation: this.negotiation })
    assert.equal(client._autoPreparedStatements.size, 16)
    assert.ok(client._autoPreparedStatements.has(READ), 'point query must be prepared on every frontend')
  }

  async prepare() {
    if (this.warmed) return
    if (this.arm % 2 === 0) {
      const clients = await Promise.all(Array.from({ length: 4 }, () => this.resource.connect()))
      try {
        for (const client of clients) {
          await client.query({ text: READ, values: [42] })
          // Fill the bounded first-N cache before the fresh-SQL case on both arms.
          for (let i = 0; i < 16; i++)
            await client.query({ text: `SELECT $1::int AS value -- prewarm_${i}`, values: [7], queryMode: 'extended' })
          this.assertPrepared(client)
        }
      } finally {
        for (const client of clients) client.release()
      }
    } else {
      await this.resource.query('SELECT 1')
      // One waiting task opens the next client without overflowing even maxPending 1.
      while (this.resource.totalCount < 4) {
        const results = await Promise.all(
          Array.from({ length: this.resource.totalCount * 16 + 1 }, () =>
            this.resource.query('SELECT pg_backend_pid() AS pid, pg_sleep(0.005)')
          )
        )
        for (const result of results) assert.ok(Number.isInteger(result.rows[0].pid))
      }
      const deadline = performance.now() + this.options.connectionTimeoutMillis
      while ([...this.resource._records].some((record) => record.state !== 'ready')) {
        assert.ok(performance.now() < deadline, 'executor connections failed to warm up')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      for (const { client } of this.resource._records) {
        await client.query({ text: READ, values: [42], queryMode: 'extended' })
      }
      for (let i = 0; i < 16; i++) {
        await Promise.all(
          Array.from({ length: 64 }, () =>
            this.resource.query({ text: `SELECT $1::int AS value -- prewarm_${i}`, values: [7] })
          )
        )
      }
      await Promise.all(Array.from({ length: 64 }, () => this.query()))
      for (const { client } of this.resource._records) this.assertPrepared(client)
    }
    this.warmed = true
    this.assertIdle()
  }

  async setup() {
    const client = new this.pg.Client(this.setupOptions)
    try {
      await client.connect()
      await client.query('DROP TABLE IF EXISTS benchmark_executor_rows')
      await client.query('CREATE TABLE benchmark_executor_rows (id int PRIMARY KEY, value int NOT NULL)')
      await client.query('INSERT INTO benchmark_executor_rows SELECT i, 7 FROM generate_series(1, 1024) i')
      await client.query('ANALYZE benchmark_executor_rows')
      if (process.env.PG_BENCH_CHECKPOINT === '1') await client.query('CHECKPOINT')
    } finally {
      await client.end()
    }
  }

  async end() {
    try {
      await this.resource.end()
    } finally {
      await this.proxy?.end()
    }
  }
}

const createExecutorWorkload = async ({ pg, arm, maxPending = 1024 }) => {
  assert.ok(Number.isInteger(arm) && arm >= 0 && arm < 4)
  const options = {
    max: 4,
    pipeline: true,
    maxAutoPrepare: 16,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
  }
  const tls = process.env.PG_BENCH_TLS_CA ? createTlsConfig() : undefined
  const negotiation = process.env.PG_BENCH_NEGOTIATION || 'direct'
  if (tls) Object.assign(options, tls.options({ context: 'shared', negotiation }))
  // Setup bypasses the measured relay: PgBouncer can reset TLS after a normal Terminate.
  const setupOptions = { ...options }
  let proxy
  if (process.env.PG_BENCH_DELAY_MS !== undefined) {
    proxy = await new DelayedProxy({
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      delayMillis: Number(process.env.PG_BENCH_DELAY_MS),
    }).start()
    options.host = '127.0.0.1'
    options.port = proxy.port
  }
  try {
    const workload = new ExecutorWorkload({ pg, arm, options, setupOptions, maxPending })
    Object.assign(workload, { tls, negotiation, proxy })
    return {
      all: workload.all,
      clients: [],
      pools: [workload],
      setup: () => workload.setup(),
      workload,
    }
  } catch (error) {
    await proxy?.end()
    throw error
  }
}

module.exports = { createExecutorWorkload }
