'use strict'

const assert = require('assert')
const { once } = require('events')
const helper = require('./test-helper')
if (helper.args.native) return
if (typeof require('events').addAbortListener !== 'function') return
const FaultProxy = require('./query-executor-fault-proxy')
const { QueryExecutor, QueryExecutorError } = helper.pg
const suite = new helper.Suite('executor buffered result budgets')
let fixtureId = 0

class BudgetFixture {
  constructor(options = {}) {
    this.executor = new QueryExecutor({ max: 1, maxInFlightPerConnection: 1, query_timeout: 2000, ...options })
  }

  async waitFor(predicate, message) {
    const deadline = Date.now() + 1500
    while (!predicate()) {
      assert.ok(Date.now() < deadline, message)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async recover() {
    await this.waitFor(() => this.executor.totalCount === 0, 'Discarded connection did not close')
    await new Promise((resolve) => setTimeout(resolve, 125))
    return this.executor.query('SELECT 7 AS value')
  }

  async close() {
    await this.executor.destroy()
  }
}

function assertUnknown(error) {
  assert.ok(error instanceof QueryExecutorError)
  assert.strictEqual(error.outcome, 'unknown')
  assert.strictEqual(error.safeToRetry, false)
  return true
}

function assertLimit(error) {
  assertUnknown(error)
  assert.strictEqual(error.code, 'PG_EXECUTOR_RESULT_LIMIT')
  return true
}

suite.test('the first excess row discards partial results and later work gets a fresh budget', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 2 })
  try {
    await assert.rejects(fixture.executor.query('SELECT generate_series(1, 3) AS value'), assertLimit)

    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
    assert.deepStrictEqual((await fixture.executor.query('SELECT generate_series(1, 2) AS value')).rows, [
      { value: 1 },
      { value: 2 },
    ])
  } finally {
    await fixture.close()
  }
})

const invalidLimits = [
  { value: 0, why: 'zero' },
  { value: -1, why: 'negative' },
  { value: 1.5, why: 'fractional' },
  { value: 9007199254740992, why: 'unsafe integer' },
  { value: NaN, why: 'NaN' },
  { value: Infinity, why: 'infinite' },
  { value: '1', why: 'string' },
]
for (const option of ['maxResultRows', 'maxResultBytes']) {
  for (const { value, why } of invalidLimits) {
    suite.test(`${option} rejects a ${why} limit before dispatch`, () => {
      assert.throws(
        () => new QueryExecutor({ [option]: value }),
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

// A single field named value: RowDescription 31 + DataRow 11 + SELECT 1 completion 14, plus payload.
const byteCases = [
  {
    why: 'NULL still has a DataRow frame',
    query: 'SELECT NULL::text AS value',
    bytes: 56,
    tooSmall: 55,
    rows: [{ value: null }],
  },
  {
    why: 'empty fields still have a DataRow frame',
    query: "SELECT ''::text AS value",
    bytes: 56,
    tooSmall: 55,
    rows: [{ value: '' }],
  },
  {
    why: 'ASCII payload counts one byte',
    query: "SELECT 'x'::text AS value",
    bytes: 57,
    tooSmall: 56,
    rows: [{ value: 'x' }],
  },
  {
    why: 'UTF-8 uses four bytes',
    query: "SELECT '🙂'::text AS value",
    bytes: 60,
    tooSmall: 59,
    rows: [{ value: '🙂' }],
  },
  {
    why: 'array rows retain their wire size',
    query: { text: 'SELECT NULL::text AS value', rowMode: 'array' },
    bytes: 56,
    tooSmall: 55,
    rows: [[null]],
  },
  {
    why: 'binary int4 uses four bytes',
    query: { text: 'SELECT 7::int4 AS value', binary: true, rowMode: 'array' },
    bytes: 60,
    tooSmall: 59,
    rows: [[7]],
  },
]
for (const { why, query, bytes, tooSmall, rows } of byteCases) {
  suite.test(`an exact byte budget succeeds: ${why}`, async () => {
    const fixture = new BudgetFixture({ maxResultBytes: bytes })
    try {
      assert.deepStrictEqual((await fixture.executor.query(query)).rows, rows)
      assert.deepStrictEqual((await fixture.executor.query(query)).rows, rows)
    } finally {
      await fixture.close()
    }
  })

  suite.test(`one byte below the result size rejects: ${why}`, async () => {
    const fixture = new BudgetFixture({ maxResultBytes: tooSmall })
    try {
      await assert.rejects(fixture.executor.query(query), assertLimit)
    } finally {
      await fixture.close()
    }
  })
}

suite.test('a row exceeding the budget is rejected before its custom type parser runs', async () => {
  let parsed = 0
  const fixture = new BudgetFixture({ maxResultRows: 1 })
  const types = {
    getTypeParser() {
      return (value) => {
        parsed++
        return Number(value)
      }
    },
  }
  try {
    await assert.rejects(fixture.executor.query({ text: 'SELECT generate_series(1, 2) AS value', types }), assertLimit)

    assert.strictEqual(parsed, 1)
    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
  } finally {
    await fixture.close()
  }
})

suite.test('cancellation inside a type parser releases its reservation before replacement work', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 1, maxResultBytes: 57 })
  const controller = new AbortController()
  const types = {
    getTypeParser() {
      return () => {
        controller.abort(new Error('cancel during decoding'))
        return 1
      }
    },
  }
  try {
    await assert.rejects(
      fixture.executor.query({ text: 'SELECT 1 AS value', types, signal: controller.signal }),
      (error) => {
        assertUnknown(error)
        assert.strictEqual(error.code, 'PG_EXECUTOR_ABORTED')
        return true
      }
    )

    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
    assert.deepStrictEqual((await fixture.executor.query('SELECT 7 AS value')).rows, [{ value: 7 }])
  } finally {
    await fixture.close()
  }
})

suite.test('an overflowing query makes its already assigned sibling unknown without replay', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 1, maxInFlightPerConnection: 2 })
  try {
    await fixture.executor.query('SELECT 1 AS value')
    const overflowing = fixture.executor.query('SELECT generate_series(1, 2) AS value')
    const sibling = fixture.executor.query('SELECT pg_sleep(0.2) AS value')
    const outcomes = await Promise.allSettled([overflowing, sibling])

    assert.strictEqual(outcomes[0].status, 'rejected')
    assertLimit(outcomes[0].reason)
    assert.strictEqual(outcomes[1].status, 'rejected')
    assertUnknown(outcomes[1].reason)
    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
  } finally {
    await fixture.close()
  }
})

const sharedBudgets = [
  { options: { maxResultRows: 1 }, why: 'rows' },
  { options: { maxResultBytes: 100 }, why: 'wire bytes' },
]
for (const { options, why } of sharedBudgets) {
  suite.test(`unfinished ${why} share one budget across two physical connections`, async () => {
    const proxy = await new FaultProxy({
      host: helper.config.host,
      port: Number(helper.config.port),
      mode: 'hold-completion',
    }).start()
    const fixture = new BudgetFixture({
      max: 2,
      ...options,
      endpoints: [
        { host: '127.0.0.1', port: proxy.port },
        { host: helper.config.host, port: Number(helper.config.port) },
      ],
    })
    const controller = new AbortController()
    let parsed = false
    const types = {
      getTypeParser: () => (value) => {
        parsed = true
        return Number(value)
      },
    }
    try {
      const retained = fixture.executor.query({ text: 'SELECT 1 AS value', types, signal: controller.signal })
      const retainedOutcome = assert.rejects(retained, (error) => {
        assertUnknown(error)
        assert.strictEqual(error.code, 'PG_EXECUTOR_ABORTED')
        return true
      })
      await fixture.waitFor(() => parsed && proxy.dropped, 'First connection did not retain its row')

      await assert.rejects(fixture.executor.query('SELECT 2 AS value'), assertLimit)
      controller.abort()
      await retainedOutcome
      await fixture.waitFor(() => fixture.executor.totalCount === 0, 'Connections did not close')
      assert.strictEqual(proxy.failure, null)
    } finally {
      controller.abort()
      await fixture.close()
      await proxy.close()
    }
  })
}

suite.test('a durable INSERT RETURNING rejected by the result budget is never replayed', async () => {
  const proxy = await new FaultProxy({
    host: helper.config.host,
    port: Number(helper.config.port),
    mode: 'gate-result',
  }).start()
  const fixture = new BudgetFixture({ host: '127.0.0.1', port: proxy.port, maxResultRows: 1 })
  const control = new helper.pg.Client()
  const table = `executor_budget_${process.pid}_${++fixtureId}`
  try {
    await control.connect()
    await control.query(`CREATE TABLE ${table} (marker text NOT NULL)`)
    const held = once(proxy.server, 'resultHeld', { signal: AbortSignal.timeout(1500) })
    const write = fixture.executor.query(`INSERT INTO ${table} VALUES ('durable'), ('durable') RETURNING marker`)
    const rejected = assert.rejects(write, assertLimit)
    await held

    assert.deepStrictEqual((await control.query(`SELECT marker FROM ${table}`)).rows, [
      { marker: 'durable' },
      { marker: 'durable' },
    ])
    proxy.releaseResult()
    await rejected
    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
    assert.deepStrictEqual((await control.query(`SELECT marker FROM ${table}`)).rows, [
      { marker: 'durable' },
      { marker: 'durable' },
    ])
    assert.strictEqual(proxy.failure, null)
  } finally {
    await fixture.close()
    await proxy.close()
    try {
      await control.query(`DROP TABLE IF EXISTS ${table}`)
    } finally {
      await control.end()
    }
  }
})

suite.test('an excess wire frame is rejected before its custom type parser runs', async () => {
  let parsed = false
  const fixture = new BudgetFixture({ maxResultBytes: 42 })
  const types = {
    getTypeParser: () => () => {
      parsed = true
      return 1
    },
  }
  try {
    await assert.rejects(fixture.executor.query({ text: 'SELECT 1 AS value', types }), assertLimit)

    assert.strictEqual(parsed, false)
  } finally {
    await fixture.close()
  }
})

suite.test('a parser error releases accumulated rows for later successful work', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 2 })
  const types = {
    getTypeParser() {
      return (value) => {
        if (value === '2') throw new Error('invalid application value')
        return Number(value)
      }
    },
  }
  try {
    await assert.rejects(fixture.executor.query({ text: 'SELECT generate_series(1, 2) AS value', types }))

    assert.deepStrictEqual((await fixture.executor.query('SELECT generate_series(1, 2) AS value')).rows, [
      { value: 1 },
      { value: 2 },
    ])
  } finally {
    await fixture.close()
  }
})

suite.test('completed results remain intact while later queries reuse the released budget', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 1, maxResultBytes: 57 })
  try {
    const first = await fixture.executor.query('SELECT 1 AS value')
    const second = await fixture.executor.query('SELECT 2 AS value')

    assert.deepStrictEqual(first.rows, [{ value: 1 }])
    assert.deepStrictEqual(second.rows, [{ value: 2 }])
  } finally {
    await fixture.close()
  }
})

suite.test('a server error after a row releases its budget without poisoning later work', async () => {
  const fixture = new BudgetFixture({ maxResultRows: 2 })
  try {
    await assert.rejects(
      fixture.executor.query(
        'SELECT CASE WHEN value = 2 THEN 1 / (value - value) ELSE value END AS value FROM generate_series(1, 2) AS value'
      ),
      { code: '22012', outcome: 'server-error', safeToRetry: false }
    )

    assert.deepStrictEqual((await fixture.executor.query('SELECT generate_series(1, 2) AS value')).rows, [
      { value: 1 },
      { value: 2 },
    ])
  } finally {
    await fixture.close()
  }
})

suite.test('a deadline releases the row and byte budget held before ReadyForQuery', async () => {
  const proxy = await new FaultProxy({
    host: helper.config.host,
    port: Number(helper.config.port),
    mode: 'hold-completion',
  }).start()
  const fixture = new BudgetFixture({
    host: '127.0.0.1',
    port: proxy.port,
    maxResultRows: 1,
    maxResultBytes: 57,
    query_timeout: 200,
  })
  try {
    await assert.rejects(fixture.executor.query('SELECT 1 AS value'), {
      code: 'PG_EXECUTOR_TIMEOUT',
      outcome: 'unknown',
      safeToRetry: false,
    })

    assert.strictEqual(proxy.dropped, true)
    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
    assert.strictEqual(proxy.failure, null)
  } finally {
    await fixture.close()
    await proxy.close()
  }
})

suite.test('default budgets stop a large eager result composed of individually small messages', async () => {
  const fixture = new BudgetFixture({ query_timeout: 10000 })
  try {
    await assert.rejects(fixture.executor.query('SELECT generate_series(1, 100001) AS value'), assertLimit)

    assert.deepStrictEqual((await fixture.recover()).rows, [{ value: 7 }])
  } finally {
    await fixture.close()
  }
})

suite.test('oversized result metadata is rejected before application type parsers are selected', async () => {
  const fixture = new BudgetFixture({ maxResultBytes: 10 })
  let parserSelected = false
  const types = {
    getTypeParser() {
      parserSelected = true
      return Number
    },
  }
  try {
    await assert.rejects(fixture.executor.query({ text: 'SELECT 1 AS value', types }), assertLimit)

    assert.strictEqual(parserSelected, false)
  } finally {
    await fixture.close()
  }
})
