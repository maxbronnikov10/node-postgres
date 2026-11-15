'use strict'

const assert = require('assert')
const helper = require('./test-helper')
const suite = new helper.Suite('tagged SQL')

suite.test('a row-count error after INSERT never suggests replaying the committed write', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    await sql`CREATE TEMP TABLE sql_cardinality (marker text)`

    await assert.rejects(sql`INSERT INTO sql_cardinality VALUES ('first'), ('second') RETURNING marker`.one(), {
      code: 'PG_EXECUTOR_ROW_COUNT',
      outcome: 'unknown',
      safeToRetry: false,
    })

    assert.deepStrictEqual(await sql`SELECT marker FROM sql_cardinality ORDER BY marker`, [
      { marker: 'first' },
      { marker: 'second' },
    ])
  } finally {
    await sql.end()
  }
})

suite.test('values stay parameters and identifiers preserve quotes, dots and __proto__', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const attack = "'); DROP TABLE users; --"
    const rows = await sql`SELECT ${attack}::text AS ${sql.identifier('__proto__')}, ${7}::int AS ${sql.identifier(
      'a"b.c'
    )}`
    assert.strictEqual(Object.getPrototypeOf(rows[0]), Object.prototype)
    assert.strictEqual(Object.hasOwn(rows[0], '__proto__'), true)
    assert.strictEqual(rows[0].__proto__, attack)
    assert.strictEqual(rows[0]['a"b.c'], 7)
    assert.deepStrictEqual(
      await sql`SELECT ${sql('pg_catalog.pg_namespace.nspname')} FROM ${sql(
        'pg_catalog.pg_namespace'
      )} WHERE nspname = ${'public'}`,
      [{ nspname: 'public' }]
    )
    assert.throws(() => sql.identifier('bad\0name'), TypeError)
  } finally {
    await sql.end()
  }
})

suite.test('nested fragments renumber values without rewriting literal dollar references', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const fragment = sql`${2}::int + ${3}::int`
    const nested = sql`${fragment} + ${4}::int`
    const rows = await sql`SELECT ${1}::int + (${nested}) AS n, '$1'::text AS literal`
    assert.deepStrictEqual(rows, [{ n: 10, literal: '$1' }])
    assert.deepStrictEqual(await sql`SELECT ARRAY[${1}, ${2}]::int[] AS nums, ${[3, 4]}::int[] AS parameter`, [
      { nums: [1, 2], parameter: [3, 4] },
    ])
    await assert.rejects(sql`SELECT ${sql.unsafe('$1::int', [1])}`.execute(), /cannot be nested/)
  } finally {
    await sql.end()
  }
})

suite.test('deep sibling fragments preserve parameter order and literal dollar references', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const left = sql`${2}, ${sql`${3}, ${4}`}, ${5}`
    const right = sql`${6}, ${sql`${7}, ${8}`}, ${9}`

    assert.deepStrictEqual(await sql`SELECT ARRAY[${1}, ${left}, ${right}, ${10}]::int[] AS nums, '$1' AS literal`, [
      { nums: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], literal: '$1' },
    ])
    assert.deepStrictEqual(await sql`SELECT ${sql`${sql.unsafe('11::int', [])}`} AS n`, [{ n: 11 }])
    await assert.rejects(sql`SELECT ${sql`${sql`${sql.unsafe('$1::int', [1])}`}`}`.execute(), /cannot be nested/)
  } finally {
    await sql.end()
  }
})

suite.test('one tagged callsite keeps scalar bindings distinct from fragments and identifiers', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const project = (value) => sql`SELECT (${value})::int AS value FROM (SELECT 13::int AS n) source`

    assert.deepStrictEqual(await project(7), [{ value: 7 }])
    assert.deepStrictEqual(await project(sql`${2}::int + ${3}::int`), [{ value: 5 }])
    assert.deepStrictEqual(await project(sql.identifier('n')), [{ value: 13 }])
    assert.deepStrictEqual(await project(11), [{ value: 11 }])
  } finally {
    await sql.end()
  }
})

suite.test('mutable template strings are snapshotted per query without caching stale SQL', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const strings = ['SELECT (', ')::int AS value']
    strings.raw = ['SELECT (', ')::int AS value']
    const scalar = sql(strings, 7)
    const fragment = sql(strings, sql`${2}::int + ${3}::int`)

    strings[0] = 'SELECT (100 + '
    strings[1] = ')::int AS changed'
    strings.raw[0] = 'SELECT (100 + '
    strings.raw[1] = ')::int AS changed'
    const changed = sql(strings, 11)

    assert.deepStrictEqual(await scalar, [{ value: 7 }])
    assert.deepStrictEqual(await fragment, [{ value: 5 }])
    assert.deepStrictEqual(await changed, [{ changed: 111 }])
  } finally {
    await sql.end()
  }
})

suite.test('lazy writes execute once across execute, repeated await and promise assimilation', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    await sql`CREATE TEMP TABLE sql_lazy (marker text)`
    const insert = sql`INSERT INTO sql_lazy VALUES (${'once'}) RETURNING marker`
    assert.deepStrictEqual(await sql`SELECT marker FROM sql_lazy`, [])

    const first = insert.execute()
    assert.strictEqual(insert.execute(), first)
    const results = await Promise.all([first, insert, Promise.resolve(insert)])
    assert.strictEqual(results[0], results[1])
    assert.strictEqual(results[1], results[2])
    assert.deepStrictEqual(await insert, [{ marker: 'once' }])
    assert.deepStrictEqual(await sql`SELECT marker FROM sql_lazy`, [{ marker: 'once' }])
  } finally {
    await sql.end()
  }
})

suite.test('rows expose metadata and array mode preserves duplicate columns', async () => {
  const sql = helper.pg({ ...helper.config, max: 1, prepare: false })
  try {
    const rows = await sql`SELECT ${11}::int AS n`
    assert.deepStrictEqual(rows, [{ n: 11 }])
    assert.deepStrictEqual(Object.keys(rows), ['0'])
    assert.strictEqual(rows.count, 1)
    assert.strictEqual(rows.command, 'SELECT')
    assert.strictEqual(rows.columns[0].name, 'n')
    assert.strictEqual(rows.columns[0].dataTypeID, 23)
    const tuples = sql`SELECT ${3}::int AS n, ${4}::int AS n`.values()
    assert.deepStrictEqual(await tuples, [[3, 4]])
    assert.throws(() => tuples.values(), /after execution/)
    assert.deepStrictEqual(await sql`CREATE TEMP TABLE sql_metadata (n int)`, [])
  } finally {
    await sql.end()
  }
})

suite.test('one and maybeOne enforce cardinality and catch/finally observe one execution', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    assert.deepStrictEqual(await sql`SELECT 1 AS n`.one(), { n: 1 })
    assert.deepStrictEqual(await sql`SELECT 2 AS n`.maybeOne(), { n: 2 })
    assert.strictEqual(await sql`SELECT 1 WHERE false`.maybeOne(), null)
    await assert.rejects(sql`SELECT 1 WHERE false`.one(), /exactly one row/)
    await assert.rejects(sql`SELECT generate_series(1, 2)`.one(), /exactly one row/)
    await assert.rejects(sql`SELECT generate_series(1, 2)`.maybeOne(), /at most one row/)
    let final = false
    const failed = sql`SELECT 1 / 0`
    const caught = await failed.catch((error) => error.code)
    await assert.rejects(
      failed.finally(() => {
        final = true
      }),
      { code: '22012' }
    )
    assert.strictEqual(caught, '22012')
    assert.strictEqual(final, true)
  } finally {
    await sql.end()
  }
})

suite.test('unsafe snapshots parameter arrays and still rejects multiple statements', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    const values = [7]
    const pending = sql.unsafe('SELECT $1::int AS n', values)
    values[0] = 99
    assert.deepStrictEqual(await pending, [{ n: 7 }])
    await assert.rejects(sql.unsafe('SELECT 1; SELECT 2').execute(), { code: '42601' })
    assert.deepStrictEqual(await sql`SELECT 3 AS n`, [{ n: 3 }])
  } finally {
    await sql.end()
  }
})

suite.test('transactions commit callback results, roll back errors and invalidate escaped scopes', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    await sql`CREATE TEMP TABLE sql_transactions (marker text)`
    let escaped
    let pending
    const result = await sql.begin(async (tx) => {
      escaped = tx
      pending = tx`INSERT INTO sql_transactions VALUES ('escaped')`
      await tx`INSERT INTO sql_transactions VALUES (${'committed'})`
      return 17
    })
    assert.strictEqual(result, 17)
    assert.throws(() => escaped`SELECT 1`, /scope is closed/)
    await assert.rejects(pending.execute(), /scope is closed/)
    assert.strictEqual(escaped.begin, undefined)
    assert.strictEqual(escaped.end, undefined)
    const failure = new Error('callback failed')
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`INSERT INTO sql_transactions VALUES (${'rolled-back'})`
        throw failure
      }),
      (error) => error === failure
    )
    assert.deepStrictEqual(await sql`SELECT marker FROM sql_transactions`, [{ marker: 'committed' }])
  } finally {
    await sql.end()
  }
})

suite.test('swallowed SQL errors never report a successful commit and the connection recovers', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  try {
    await sql`CREATE TEMP TABLE sql_aborted (marker text)`
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`INSERT INTO sql_aborted VALUES (${'aborted'})`
        await tx`SELECT 1 / 0`.catch(() => undefined)
        return 'must not succeed'
      }),
      /rolled back/
    )
    assert.deepStrictEqual(await sql`SELECT marker FROM sql_aborted`, [])
    assert.deepStrictEqual(await sql`SELECT 19 AS n`, [{ n: 19 }])
  } finally {
    await sql.end()
  }
})

suite.test('end drains explicitly started work and rejects unstarted lazy queries', async () => {
  const sql = helper.pg({ ...helper.config, max: 1 })
  const lazy = sql`SELECT 7 AS n`
  const started = sql`SELECT 11 AS n`.execute()
  const ending = sql.end()
  assert.deepStrictEqual(await started, [{ n: 11 }])
  await ending
  await assert.rejects(lazy.execute(), /scope is closed/)
  assert.throws(() => sql`SELECT 13`, /scope is closed/)
})
