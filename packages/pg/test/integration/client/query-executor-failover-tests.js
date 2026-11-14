'use strict'

const assert = require('assert')
const helper = require('./test-helper')
if (helper.args.native) return
const QueryExecutorFaultProxy = require('./query-executor-fault-proxy')
const { QueryExecutor, QueryExecutorError } = helper.pg
const suite = new helper.Suite('independent-query executor endpoint failover')
const rw = { host: '127.0.0.1', port: 32774 }
// This fixture uses default_transaction_read_only=on, not a physical replica.
const ro = { host: '127.0.0.1', port: 32775 }
const common = { user: 'postgres', database: 'nodepg_ha', ssl: false }
let fixtureId = 0

class FailoverFixture {
  constructor(options) {
    this.table = `executor_failover_${process.pid}_${++fixtureId}`
    this.control = new helper.pg.Client({ ...common, ...rw })
    this.executor = new QueryExecutor({
      ...common,
      max: 1,
      maxInFlightPerConnection: 1,
      connectionTimeoutMillis: 50,
      query_timeout: 1000,
      ...options,
    })
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

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Executor shutdown exceeded 1000ms')), 1000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

suite.test('a refused first endpoint falls back and commits its non-unique INSERT exactly once', async () => {
  const closed = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  await closed.close()
  const fixture = new FailoverFixture({ endpoints: [{ host: '127.0.0.1', port: closed.port }, rw] })
  await fixture.connect()
  try {
    await fixture.executor.query(fixture.insert('refused-fallback'))

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'refused-fallback' }])
  } finally {
    await fixture.close()
  }
})

suite.test('a synchronous TLS configuration failure falls back without orphaning the queued INSERT', async () => {
  const fixture = new FailoverFixture({
    endpoints: [{ ...rw, ssl: false, sslnegotiation: 'direct' }, rw],
  })
  await fixture.connect()
  try {
    await fixture.executor.query(fixture.insert('constructor-fallback'))

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'constructor-fallback' }])
  } finally {
    await fixture.close()
  }
})

suite.test('an opening timeout falls back before the application query deadline and inserts exactly once', async () => {
  const blackhole = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  const fixture = new FailoverFixture({ endpoints: [{ host: '127.0.0.1', port: blackhole.port }, rw] })
  await fixture.connect()
  try {
    const started = Date.now()
    await fixture.executor.query(fixture.insert('timeout-fallback'))

    assert.ok(Date.now() - started < 1000, 'Fallback must complete before the 1000ms query deadline')
    assert.ok(blackhole.acceptedCount > 0, 'The first endpoint must actually blackhole an opening')
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'timeout-fallback' }])
  } finally {
    await fixture.close()
    await blackhole.close()
  }
})

suite.test('read-write selection skips a default-read-only server before sending the INSERT', async () => {
  const fixture = new FailoverFixture({ endpoints: [ro, rw], targetSessionAttrs: 'read-write' })
  await fixture.connect()
  try {
    await fixture.executor.query(fixture.insert('read-write-selection'))

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'read-write-selection' }])
  } finally {
    await fixture.close()
  }
})

suite.test(
  'a stalled role probe times out before application dispatch and fallback commits the INSERT once',
  async () => {
    const proxy = await new QueryExecutorFaultProxy({ ...rw, mode: 'hold-completion' }).start()
    const fixture = new FailoverFixture({
      endpoints: [{ host: '127.0.0.1', port: proxy.port }, rw],
      targetSessionAttrs: 'read-write',
    })
    await fixture.connect()
    try {
      const result = await fixture.executor.query(fixture.insert('stalled-role-fallback'))

      assert.strictEqual(result.command, 'INSERT')
      assert.strictEqual(result.rowCount, 1)
      assert.strictEqual(proxy.dropped, true, 'The first endpoint must withhold role probe completion')
      assert.strictEqual(proxy.failure, null)
      assert.deepStrictEqual(await fixture.markers(), [{ marker: 'stalled-role-fallback' }])
    } finally {
      try {
        await within(fixture.close())
      } finally {
        await within(proxy.close())
      }
    }
  }
)

suite.test('read-only selection skips the writable server and reports transaction_read_only on', async () => {
  const executor = new QueryExecutor({
    ...common,
    max: 1,
    endpoints: [rw, ro],
    targetSessionAttrs: 'read-only',
    connectionTimeoutMillis: 50,
    query_timeout: 1000,
  })
  try {
    const result = await executor.query('SHOW transaction_read_only')

    assert.deepStrictEqual(result.rows, [{ transaction_read_only: 'on' }])
  } finally {
    await executor.destroy()
    await executor.end()
  }
})

suite.test('two blackholes leave accepted INSERTs unsent, drain every count and allow shutdown', async () => {
  const first = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  const second = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  const fixture = new FailoverFixture({
    endpoints: [first, second].map(({ port }) => ({ host: '127.0.0.1', port })),
    query_timeout: 250,
  })
  await fixture.connect()
  try {
    const results = await Promise.allSettled([
      fixture.executor.query(fixture.insert('unavailable-first')),
      fixture.executor.query(fixture.insert('unavailable-second')),
    ])

    for (const result of results) {
      assert.strictEqual(result.status, 'rejected')
      assertNotSent(result.reason)
    }
    assert.ok(first.acceptedCount > 0)
    assert.ok(second.acceptedCount > 0)
    assert.deepStrictEqual(await fixture.markers(), [])
    await within(fixture.executor.end())
    assert.strictEqual(fixture.executor.totalCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
  } finally {
    await fixture.close()
    await first.close()
    await second.close()
  }
})

suite.test('an outage tries each slow blackhole once even when the accepted INSERT has no deadline', async () => {
  const first = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  const second = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  const fixture = new FailoverFixture({
    endpoints: [first, second].map(({ port }) => ({ host: '127.0.0.1', port })),
    connectionTimeoutMillis: 150,
    query_timeout: 0,
  })
  await fixture.connect()
  try {
    await within(
      assert.rejects(fixture.executor.query(fixture.insert('unavailable-without-deadline')), (error) => {
        assertNotSent(error)
        assert.strictEqual(error.code, 'PG_EXECUTOR_UNAVAILABLE')
        assert.ok(error.retryAfterMillis >= 0 && error.retryAfterMillis <= 100)
        return true
      })
    )

    assert.strictEqual(first.acceptedCount, 1)
    assert.strictEqual(second.acceptedCount, 1)
    assert.deepStrictEqual(await fixture.markers(), [])
    await within(fixture.executor.end())
    assert.strictEqual(fixture.executor.totalCount, 0)
    assert.strictEqual(fixture.executor.waitingCount, 0)
    assert.strictEqual(fixture.executor.inFlightCount, 0)
  } finally {
    await fixture.close()
    await first.close()
    await second.close()
  }
})

suite.test('lost ReadyForQuery after commit is unknown and failover never replays the non-unique INSERT', async () => {
  const proxy = await new QueryExecutorFaultProxy({ ...rw, mode: 'drop-ready' }).start()
  const fixture = new FailoverFixture({ endpoints: [{ host: '127.0.0.1', port: proxy.port }, rw] })
  await fixture.connect()
  try {
    await assert.rejects(fixture.executor.query(fixture.insert('committed-once')), (error) => {
      assert.ok(error instanceof QueryExecutorError)
      assert.strictEqual(error.outcome, 'unknown')
      assert.strictEqual(error.safeToRetry, false)
      return true
    })

    assert.strictEqual(proxy.dropped, true)
    assert.strictEqual(proxy.failure, null)
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'committed-once' }])

    assert.deepStrictEqual((await fixture.executor.query('SELECT 17 AS n')).rows, [{ n: 17 }])
    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'committed-once' }])
  } finally {
    await fixture.close()
    await proxy.close()
  }
})

suite.test('explicit endpoint overrides the refused host and port in connectionString', async () => {
  const closed = await new QueryExecutorFaultProxy({ mode: 'blackhole' }).start()
  await closed.close()
  const fixture = new FailoverFixture({
    connectionString: `postgres://postgres@127.0.0.2:${closed.port}/nodepg_ha`,
    endpoints: [rw],
  })
  await fixture.connect()
  try {
    await fixture.executor.query(fixture.insert('connection-string-override'))

    assert.deepStrictEqual(await fixture.markers(), [{ marker: 'connection-string-override' }])
  } finally {
    await fixture.close()
  }
})

const invalidOptions = [
  { options: { endpoints: [] }, why: 'an empty endpoint list' },
  { options: { endpoints: Array(65).fill(rw) }, why: 'more than 64 endpoints' },
  { options: { endpoints: [{}] }, why: 'an endpoint without a host' },
  { options: { endpoints: [{ host: '127.0.0.1', port: 1.5 }] }, why: 'a fractional endpoint port' },
  { options: { endpoints: [rw], targetSessionAttrs: 'primary' }, why: 'an unsupported session target' },
]
for (const { options, why } of invalidOptions) {
  suite.test(`rejects ${why} before connecting`, () => {
    assert.throws(() => new QueryExecutor({ ...common, ...options }), assertNotSent)
  })
}
