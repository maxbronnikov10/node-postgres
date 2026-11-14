'use strict'

const assert = require('assert')
const { describe, it } = require('mocha')
const Pool = require('../')

describe('combined pool optimizations', () => {
  it('an expired checkout preserves FIFO handoffs and reuses one client without leaks', async function () {
    this.timeout(5000)
    const pool = new Pool({
      max: 1,
      connectionTimeoutMillis: 1000,
      pipeline: true,
      autoBatch: true,
      maxAutoPrepare: 16,
    })
    const order = []
    let connections = 0
    pool.on('connect', () => connections++)
    let held
    try {
      held = await pool.connect()
      const original = held
      const initial = await held.query('SELECT pg_backend_pid() AS pid')
      await assert.rejects(pool.connect(), /timeout/)

      const first = pool.connect().then((client) => {
        order.push('first')
        return client
      })
      const second = pool.connect().then((client) => {
        order.push('second')
        return client
      })
      const third = pool.connect().then((client) => {
        order.push('third')
        return client
      })
      held.release()
      held = undefined
      held = await first

      assert.deepStrictEqual(order, ['first'])
      assert.strictEqual(held, original)
      held.release()
      held = undefined
      held = await second
      assert.deepStrictEqual(order, ['first', 'second'])
      assert.strictEqual(held, original)
      held.release()
      held = undefined
      held = await third
      assert.deepStrictEqual(order, ['first', 'second', 'third'])
      assert.strictEqual(held, original)
      assert.deepStrictEqual((await held.query('SELECT pg_backend_pid() AS pid')).rows, initial.rows)
      held.release()
      held = undefined

      assert.strictEqual(connections, 1)
      assert.strictEqual(pool.totalCount, 1)
      assert.strictEqual(pool.idleCount, 1)
      assert.strictEqual(pool.waitingCount, 0)
    } finally {
      if (held) held.release()
      await pool.end()
    }
    assert.strictEqual(pool.totalCount, 0)
  })
})
