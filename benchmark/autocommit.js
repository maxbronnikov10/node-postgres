'use strict'

const assert = require('assert/strict')

const SELECT = 'SELECT id AS n FROM benchmark_autocommit_rows WHERE id = $1'
const UPDATE = 'UPDATE benchmark_autocommit_rows SET value = $1 WHERE id = $2 RETURNING id AS n, value'
const BURST = 16
const POOL_SIZE = 4

class AutocommitWorkload {
  constructor({ pg, profile, arm }) {
    assert.ok(['autocommit', 'autocommit-prepare', 'autocommit-pipeline'].includes(profile))
    assert.ok(Number.isInteger(arm) && arm >= 0 && arm < 4)
    this.pg = pg
    this.arm = arm
    this.options = {
      pipeline: profile === 'autocommit-pipeline' && arm % 2 === 1,
      maxAutoPrepare: profile === 'autocommit' || (profile === 'autocommit-prepare' && arm % 2 === 0) ? 0 : 16,
    }
    this.all = {}
    this.clients = []
    this.pools = []
    if (profile === 'autocommit-pipeline') {
      this.addCase({ name: 'client SELECT, sequential', resource: this.createClient(), operation: 'select', width: 1 })
      this.addCase({
        name: 'client SELECT, concurrent x16',
        resource: this.createClient(),
        operation: 'select',
        width: BURST,
      })
      this.addCase({
        name: 'client SELECT, fresh SQL, concurrent x16',
        resource: this.createClient(),
        operation: 'select',
        width: BURST,
        freshness: 'fresh',
      })
      this.addCase({
        name: 'client UPDATE, concurrent x16',
        resource: this.createClient(),
        operation: 'update',
        width: BURST,
      })
    } else {
      this.addCase({ name: 'client SELECT, sequential', resource: this.createClient(), operation: 'select', width: 1 })
      // Both SELECT cases have identical SQL/cache state; sharing this pool keeps all four arms at 56 connections.
      const selectPool = this.createPool()
      this.addCase({ name: 'pool SELECT, sequential', resource: selectPool, operation: 'select', width: 1 })
      this.addCase({ name: 'pool SELECT, concurrent x16', resource: selectPool, operation: 'select', width: BURST })
      this.addCase({
        name: 'pool SELECT, fresh SQL, concurrent x16',
        resource: this.createPool(),
        operation: 'select',
        width: BURST,
        freshness: 'fresh',
      })
      this.addCase({ name: 'client UPDATE, sequential', resource: this.createClient(), operation: 'update', width: 1 })
      this.addCase({
        name: 'pool UPDATE, concurrent x16',
        resource: this.createPool(),
        operation: 'update',
        width: BURST,
      })
    }
  }

  createClient() {
    const client = new this.pg.Client(this.options)
    this.clients.push(client)
    return client
  }

  createPool() {
    const pool = new this.pg.Pool({ ...this.options, max: POOL_SIZE, idleTimeoutMillis: 0 })
    this.pools.push(pool)
    return pool
  }

  consume({ result, id, operation }) {
    assert.equal(result.rowCount, 1)
    assert.equal(result.rows.length, 1)
    assert.equal(result.rows[0].n, id)
    if (operation === 'update') assert.equal(result.rows[0].value, 7)
  }

  addCase({ name, resource, operation, width, freshness = 'fixed' }) {
    const text = operation === 'select' ? SELECT : UPDATE
    const fixtures = Array.from({ length: width }, (_, slot) => {
      const id = this.arm * BURST + slot + 1
      return { id, config: { text, values: operation === 'select' ? [id] : [7, id] } }
    })
    let serial = 0
    const queryConfig = (fixture) =>
      freshness === 'fresh' ? { ...fixture.config, text: `${text} -- autocommit_${serial++}` } : fixture.config
    const execute = async (target, fixture) => {
      const result = await target.query(queryConfig(fixture))
      this.consume({ result, id: fixture.id, operation })
    }
    const run = async () => {
      if (width === 1) await execute(resource, fixtures[0])
      else await Promise.all(fixtures.map((fixture) => execute(resource, fixture)))
      return width
    }
    run.prepare = async () => {
      const isPool = this.pools.includes(resource)
      const connections = []
      try {
        if (isPool) {
          for (let i = 0; i < POOL_SIZE; i++) connections.push(await resource.connect())
        } else {
          connections.push(resource)
        }
        for (const connection of connections) {
          // Fill a fresh-SQL cache before measuring misses; the counter continues across all rounds.
          for (let i = 0; i < (freshness === 'fresh' ? BURST : 1); i++) {
            await execute(connection, fixtures[i % width])
          }
          assert.equal(connection.getTransactionStatus(), 'I')
          const result = await connection.query(
            "SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name LIKE 'pg_auto_%'"
          )
          assert.equal(result.rowCount, 1)
          assert.equal(result.rows.length, 1)
          const count = result.rows[0].n
          if (this.options.maxAutoPrepare === 0) assert.equal(count, 0)
          else assert.ok(count > 0 && count <= 16, `expected 1..16 automatic statements, got ${count}`)
          assert.equal(connection.getTransactionStatus(), 'I')
        }
      } finally {
        if (isPool) for (const connection of connections) connection.release()
      }
      if (isPool) {
        assert.equal(resource.totalCount, POOL_SIZE)
        assert.equal(resource.idleCount, POOL_SIZE)
        assert.equal(resource.waitingCount, 0)
      }
    }
    this.all[`autocommit, ${name}`] = run
  }

  async setup() {
    const client = this.clients[0]
    await client.query('DROP TABLE IF EXISTS benchmark_autocommit_rows')
    await client.query('CREATE TABLE benchmark_autocommit_rows (id int PRIMARY KEY, value int NOT NULL)')
    await client.query('INSERT INTO benchmark_autocommit_rows SELECT i, 0 FROM generate_series(1, 1024) i')
    await client.query('ANALYZE benchmark_autocommit_rows')
  }
}

const createAutocommitWorkload = async ({ pg, profile, arm }) => {
  const workload = new AutocommitWorkload({ pg, profile, arm })
  await Promise.all(workload.clients.map((client) => client.connect()))
  return {
    all: workload.all,
    clients: workload.clients,
    pools: workload.pools,
    setup: () => workload.setup(),
  }
}

module.exports = { createAutocommitWorkload }
