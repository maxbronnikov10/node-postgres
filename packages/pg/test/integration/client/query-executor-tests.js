'use strict'

const assert = require('assert')
const { once } = require('events')
const helper = require('./test-helper')
if (helper.args.native) return
const QueryExecutorFaultProxy = require('./query-executor-fault-proxy')
const { QueryExecutor, QueryExecutorError } = helper.pg
const suite = new helper.Suite('bounded independent-query executor')
let fixtureId = 0

class ExecutorFixture {
  constructor(options) {
    this.table = `query_executor_${process.pid}_${++fixtureId}`
    this.control = new helper.pg.Client()
    this.executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 1, query_timeout: 2000, ...options })
  }

  async connect() {
    await this.control.connect()
    await this.control.query(`CREATE TABLE ${this.table} (marker text NOT NULL)`)
  }

  insert(marker) {
    return { text: `INSERT INTO ${this.table} (marker) VALUES ($1)`, values: [marker] }
  }

  async markers() {
    return (await this.control.query(`SELECT marker FROM ${this.table} ORDER BY marker`)).rows
  }

  async waitForCounts(expected) {
    const deadline = Date.now() + 1500
    while (!Object.entries(expected).every(([name, count]) => this.executor[name] === count)) {
      assert.ok(Date.now() < deadline, `Executor counts did not reach ${JSON.stringify(expected)}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async close() {
    try {
      await this.executor.destroy()
      await this.executor.end()
    } finally {
      try {
        await this.control.query(`DROP TABLE IF EXISTS ${this.table}`)
      } finally {
        await this.control.end()
      }
    }
  }
}

function assertNotSent(error) {
  assert.ok(error instanceof QueryExecutorError)
  assert.strictEqual(error.outcome, 'not-sent')
  assert.strictEqual(error.safeToRetry, true)
  return true
}

function assertUnknown(error) {
  assert.ok(error instanceof QueryExecutorError)
  assert.strictEqual(error.outcome, 'unknown')
  assert.strictEqual(error.safeToRetry, false)
  return true
}

const types = {
  getTypeParser(oid, format) {
    if (oid === 17 && format === 'binary') return (value) => value
    return helper.pg.types.getTypeParser(oid, format)
  },
}

const invalidLimits = [
  { options: { max: 0 }, why: 'zero connections' },
  { options: { max: 1.5 }, why: 'fractional connections' },
  { options: { max: 9007199254740992 }, why: 'an unsafe connection count' },
  { options: { maxInFlightPerConnection: -1 }, why: 'a negative in-flight limit' },
  { options: { maxPending: 0 }, why: 'a zero pending limit' },
]
for (const { options, why } of invalidLimits) {
  suite.test(`rejects ${why} before opening a connection`, () => {
    assert.throws(() => new QueryExecutor(options), assertNotSent)
  })
}

const invalidTimers = [
  { options: { query_timeout: 0.5 }, why: 'a fractional query timeout' },
  { options: { query_timeout: 2147483648 }, why: 'a query timeout above the timer range' },
  { options: { connectionTimeoutMillis: -1 }, why: 'a negative connection timeout' },
  { options: { connectionTimeoutMillis: Infinity }, why: 'an infinite connection timeout' },
]
for (const { options, why } of invalidTimers) {
  suite.test(`rejects ${why} before opening a connection`, () => {
    assert.throws(() => new QueryExecutor(options), assertNotSent)
  })
}

const invalidQueryTimers = [
  { query_timeout: 0.5, why: 'a fractional deadline' },
  { query_timeout: 2147483648, why: 'a deadline above the timer range' },
  { query_timeout: NaN, why: 'a nonnumeric deadline' },
]
for (const { query_timeout, why } of invalidQueryTimers) {
  suite.test(`an INSERT with ${why} is rejected without dispatch`, async () => {
    const fixture = new ExecutorFixture()
    await fixture.connect()
    try {
      await assert.rejects(
        fixture.executor.query({ ...fixture.insert('invalid-deadline'), query_timeout }),
        assertNotSent
      )
      await fixture.executor.query('SELECT 1')

      assert.deepStrictEqual(await fixture.markers(), [])
    } finally {
      await fixture.close()
    }
  })
}

suite.test('concurrent text and binary results retain order across an isolated server error', async () => {
  const executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 4, types })
  try {
    const results = await Promise.allSettled([
      executor.query({ text: 'SELECT $1::bytea AS value', values: [Buffer.from([0, 255, 128, 127])], binary: true }),
      executor.query('SELECT 1 / 0'),
      executor.query("SELECT 'Привет🙂'::text AS value"),
      executor.query({ text: 'SELECT $1::int4 AS n', values: [-16909061], binary: true, rowMode: 'array' }),
    ])

    assert.strictEqual(results[0].status, 'fulfilled')
    assert.deepStrictEqual(results[0].value.rows, [{ value: Buffer.from([0, 255, 128, 127]) }])
    assert.strictEqual(results[1].status, 'rejected')
    assert.ok(results[1].reason instanceof QueryExecutorError)
    assert.strictEqual(results[1].reason.code, '22012')
    assert.strictEqual(results[1].reason.outcome, 'server-error')
    assert.strictEqual(results[1].reason.safeToRetry, false)
    assert.strictEqual(results[2].status, 'fulfilled')
    assert.deepStrictEqual(results[2].value.rows, [{ value: 'Привет🙂' }])
    assert.strictEqual(results[3].status, 'fulfilled')
    assert.deepStrictEqual(results[3].value.rows, [[-16909061]])
    assert.deepStrictEqual((await executor.query('SELECT 17 AS n')).rows, [{ n: 17 }])
  } finally {
    await executor.end()
  }
})

suite.test('bounded admission rejects an INSERT without sending it and accepts later work', async () => {
  const fixture = new ExecutorFixture({ maxPending: 1 })
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const blocker = fixture.executor.query('SELECT pg_sleep(0.3)')
    await fixture.waitForCounts({ inFlightCount: 1, waitingCount: 0 })
    const accepted = fixture.executor.query(fixture.insert('accepted'))
    await fixture.waitForCounts({ totalCount: 1, inFlightCount: 1, waitingCount: 1 })

    await assert.rejects(fixture.executor.query(fixture.insert('rejected')), assertNotSent)
    await Promise.all([blocker, accepted])
    await fixture.executor.query(fixture.insert('later'))

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'accepted' }, { marker: 'later' }])
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('an already aborted signal prevents its INSERT from reaching PostgreSQL', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    const controller = new AbortController()
    controller.abort(Object.freeze(new Error('already cancelled')))

    await assert.rejects(
      fixture.executor.query({ ...fixture.insert('already-aborted'), signal: controller.signal }),
      assertNotSent
    )
    await fixture.executor.query('SELECT 1')

    assert.deepStrictEqual(await fixture.markers(), [])
  } finally {
    await fixture.close()
  }
})

suite.test('a queued abort prevents its INSERT even when another listener stops propagation', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const blocker = fixture.executor.query('SELECT pg_sleep(0.3)')
    const controller = new AbortController()
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation())
    const cancelled = fixture.executor.query({ ...fixture.insert('queued-abort'), signal: controller.signal })
    const rejection = assert.rejects(cancelled, assertNotSent)
    await fixture.waitForCounts({ inFlightCount: 1, waitingCount: 1 })

    controller.abort(Object.freeze(new Error('cancel queued write')))
    await rejection
    await blocker
    await fixture.executor.query('SELECT 1')

    assert.deepStrictEqual(await fixture.markers(), [])
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('a queued deadline expires before assignment and its INSERT never reaches PostgreSQL', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const blocker = fixture.executor.query('SELECT pg_sleep(0.3)')
    const timedOut = fixture.executor.query({ ...fixture.insert('queued-timeout'), query_timeout: 30 })
    const rejection = assert.rejects(timedOut, assertNotSent)

    await rejection
    await blocker
    await fixture.executor.query('SELECT 1')

    assert.deepStrictEqual(await fixture.markers(), [])
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('an in-flight abort discards assigned work once and a replacement connection recovers', async () => {
  const fixture = new ExecutorFixture({ maxInFlightPerConnection: 2 })
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const controller = new AbortController()
    const cancelled = fixture.executor.query({ text: 'SELECT pg_sleep(0.5)', signal: controller.signal })
    const collateral = fixture.executor.query('SELECT 23 AS n')
    const settled = Promise.allSettled([cancelled, collateral])
    await fixture.waitForCounts({ inFlightCount: 2 })
    const reason = Object.freeze(new Error('cancel assigned query'))

    controller.abort(reason)
    const results = await settled

    assert.strictEqual(results[0].status, 'rejected')
    assertUnknown(results[0].reason)
    assert.strictEqual(results[0].reason.cause, reason)
    assert.strictEqual(results[1].status, 'rejected')
    assertUnknown(results[1].reason)
    assert.notStrictEqual(results[1].reason.cause, reason)
    await new Promise((resolve) => setTimeout(resolve, 125))
    assert.deepStrictEqual((await fixture.executor.query('SELECT 29 AS n')).rows, [{ n: 29 }])
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('an in-flight deadline has unknown outcome and a replacement connection recovers', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const timedOut = fixture.executor.query({ text: 'SELECT pg_sleep(0.4)', query_timeout: 100 })
    const rejection = assert.rejects(timedOut, (error) => {
      assert.strictEqual(error.code, 'PG_EXECUTOR_TIMEOUT')
      return assertUnknown(error)
    })
    await fixture.waitForCounts({ inFlightCount: 1 })

    await rejection
    await new Promise((resolve) => setTimeout(resolve, 125))

    assert.deepStrictEqual((await fixture.executor.query('SELECT 41 AS n')).rows, [{ n: 41 }])
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('backend termination fails assigned work and sends a queued INSERT once on a replacement', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    const backend = await fixture.executor.query('SELECT pg_backend_pid() AS pid')
    const settled = Promise.allSettled([
      fixture.executor.query('SELECT pg_sleep(1)'),
      fixture.executor.query(fixture.insert('queued-after-termination')),
    ])
    await fixture.waitForCounts({ inFlightCount: 1, waitingCount: 1 })

    const termination = await fixture.control.query('SELECT pg_terminate_backend($1) AS terminated', [
      backend.rows[0].pid,
    ])
    const results = await settled

    assert.deepStrictEqual(termination.rows, [{ terminated: true }])
    assert.strictEqual(results[0].status, 'rejected')
    assertUnknown(results[0].reason)
    assert.strictEqual(results[1].status, 'fulfilled')
    assert.strictEqual(results[1].value.rowCount, 1)
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'queued-after-termination' }])
    assert.strictEqual(fixture.executor.waitingCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.deepStrictEqual((await fixture.executor.query('SELECT 53 AS n')).rows, [{ n: 53 }])
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'queued-after-termination' }])
    assert.strictEqual(fixture.executor.waitingCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('end drains accepted writes and refuses later admission without sending SQL', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const accepted = Promise.all([
      fixture.executor.query('SELECT pg_sleep(0.05)'),
      fixture.executor.query(fixture.insert('drain-first')),
      fixture.executor.query(fixture.insert('drain-second')),
    ])

    const ending = fixture.executor.end()
    assert.strictEqual(fixture.executor.end(), ending)
    await assert.rejects(fixture.executor.query(fixture.insert('after-end')), assertNotSent)
    await accepted
    await ending

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'drain-first' }, { marker: 'drain-second' }])
    assert.strictEqual(fixture.executor.totalCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('destroy force closes a transport already waiting for graceful shutdown', async () => {
  const proxy = await new QueryExecutorFaultProxy({
    host: helper.config.host,
    port: Number(helper.config.port),
    mode: 'hold-close',
  }).start()
  const executor = new QueryExecutor({
    ...helper.config,
    host: '127.0.0.1',
    port: proxy.port,
    ssl: false,
    max: 1,
  })
  let deadline
  try {
    await executor.query('SELECT 1')
    const withheldClose = once(proxy.server, 'withheldClose')
    const ending = executor.end()
    await Promise.race([
      withheldClose,
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Fixture did not withhold graceful close')), 1000)
      }),
    ])
    clearTimeout(deadline)

    assert.strictEqual(executor.destroy(), ending)
    await Promise.race([
      ending,
      new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('destroy did not close the graceful transport')), 250)
      }),
    ])

    assert.strictEqual(executor.totalCount, 0)
    assert.strictEqual(executor.inFlightCount, 0)
    assert.strictEqual(executor.waitingCount, 0)
  } finally {
    clearTimeout(deadline)
    await proxy.close()
    await executor.destroy()
    await executor.end()
  }
})

suite.test('destroy settles assigned and queued work and the queued INSERT is absent', async () => {
  const fixture = new ExecutorFixture({ maxInFlightPerConnection: 2 })
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')
    const resultsPromise = Promise.allSettled([
      fixture.executor.query('SELECT pg_sleep(0.5)'),
      fixture.executor.query('SELECT 31 AS n'),
      fixture.executor.query(fixture.insert('destroyed-queue')),
    ])
    await fixture.waitForCounts({ inFlightCount: 2, waitingCount: 1 })

    await fixture.executor.destroy(Object.freeze(new Error('explicit shutdown')))
    await fixture.executor.destroy()
    const results = await resultsPromise

    assert.strictEqual(results[0].status, 'rejected')
    assertUnknown(results[0].reason)
    assert.strictEqual(results[1].status, 'rejected')
    assertUnknown(results[1].reason)
    assert.strictEqual(results[2].status, 'rejected')
    assertNotSent(results[2].reason)
    await assert.rejects(fixture.executor.query(fixture.insert('after-destroy')), assertNotSent)
    assert.deepStrictEqual(await fixture.markers(), [])
    assert.strictEqual(fixture.executor.totalCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test(
  'opening timeouts bound connection attempts, reject unsent work and recover on the same endpoint',
  async () => {
    const blackhole = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
    const executor = new QueryExecutor({
      ...helper.config,
      host: '127.0.0.1',
      port: blackhole.port,
      ssl: false,
      max: 2,
      maxInFlightPerConnection: 1,
      maxPending: 3,
      connectionTimeoutMillis: 50,
      query_timeout: 1000,
    })
    let healthy
    try {
      const results = await Promise.allSettled([
        executor.query('SELECT 1'),
        executor.query('SELECT 2'),
        executor.query('SELECT 3'),
      ])

      assert.strictEqual(results[0].status, 'rejected')
      assertNotSent(results[0].reason)
      assert.strictEqual(results[1].status, 'rejected')
      assertNotSent(results[1].reason)
      assert.strictEqual(results[2].status, 'rejected')
      assertNotSent(results[2].reason)
      assert.ok(blackhole.acceptedCount > 0)
      assert.ok(blackhole.acceptedCount <= 2)
      const attempts = blackhole.acceptedCount

      await assert.rejects(executor.query('SELECT 5'), assertNotSent)
      assert.strictEqual(blackhole.acceptedCount, attempts)
      assert.strictEqual(executor.waitingCount, 0)
      assert.strictEqual(executor.inFlightCount, 0)
      await blackhole.close()
      healthy = await new QueryExecutorFaultProxy({
        mode: 'relay',
        listenPort: blackhole.port,
        host: helper.config.host,
        port: Number(helper.config.port),
      }).start()
      await new Promise((resolve) => setTimeout(resolve, 150))

      assert.deepStrictEqual((await executor.query('SELECT 17 AS n')).rows, [{ n: 17 }])
      assert.strictEqual(healthy.acceptedCount, 1)
      assert.strictEqual(executor.waitingCount, 0)
      assert.strictEqual(executor.inFlightCount, 0)
    } finally {
      await executor.destroy()
      await executor.end()
      await blackhole.close()
      await healthy?.close()
    }
  }
)

suite.test('BEGIN misuse discards its assigned transport and a later independent query reconnects', async () => {
  const fixture = new ExecutorFixture({ maxInFlightPerConnection: 2 })
  await fixture.connect()
  try {
    await fixture.executor.query('SELECT 1')

    const results = await Promise.allSettled([
      fixture.executor.query('BEGIN'),
      fixture.executor.query('SELECT pg_sleep(0.2)'),
    ])

    assert.strictEqual(results[0].status, 'rejected')
    assertUnknown(results[0].reason)
    assert.strictEqual(results[1].status, 'rejected')
    assertUnknown(results[1].reason)
    await new Promise((resolve) => setTimeout(resolve, 125))
    assert.deepStrictEqual((await fixture.executor.query('SELECT 43 AS n')).rows, [{ n: 43 }])
    assert.strictEqual(fixture.executor.waitingCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
  } finally {
    await fixture.close()
  }
})

suite.test('a frozen toPostgres error remains the cause, its INSERT is absent and a replacement recovers', async () => {
  const fixture = new ExecutorFixture()
  await fixture.connect()
  try {
    const failure = Object.freeze(new Error('frozen value conversion failed'))
    const marker = {
      toPostgres() {
        throw failure
      },
    }

    await assert.rejects(fixture.executor.query(fixture.insert(marker)), (error) => {
      assertUnknown(error)
      assert.strictEqual(error.cause, failure)
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 125))

    assert.deepStrictEqual((await fixture.executor.query('SELECT 47 AS n')).rows, [{ n: 47 }])
    assert.deepStrictEqual(await fixture.markers(), [])
  } finally {
    await fixture.close()
  }
})

suite.test('plain TCP loss after committed INSERT is unknown and never replays the non-unique marker', async () => {
  const proxy = await new QueryExecutorFaultProxy({
    host: helper.config.host,
    port: Number(helper.config.port),
  }).start()
  const fixture = new ExecutorFixture({
    ...helper.config,
    host: '127.0.0.1',
    port: proxy.port,
    ssl: false,
  })
  await fixture.connect()
  try {
    await assert.rejects(fixture.executor.query(fixture.insert('non-unique-operation')), assertUnknown)

    assert.strictEqual(proxy.dropped, true)
    assert.strictEqual(proxy.failure, null)
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'non-unique-operation' }])
    await new Promise((resolve) => setTimeout(resolve, 125))
    assert.deepStrictEqual((await fixture.executor.query('SELECT 37 AS n')).rows, [{ n: 37 }])
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'non-unique-operation' }])
  } finally {
    await fixture.close()
    await proxy.close()
  }
})
