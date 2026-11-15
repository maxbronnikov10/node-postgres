'use strict'

const assert = require('node:assert/strict')
const helper = require('./test-helper')
const suite = new helper.Suite('cached automatic int4 descriptions')

suite.test('repeated object and array queries preserve metadata despite caller mutation', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    const first = await client.query(text, [1])
    first.fields[0].name = 'corrupted'
    first.fields[0].dataTypeID = 25

    const second = await client.query(text, [2])
    const array = await client.query({ text, values: [3], rowMode: 'array' })
    second.fields[0].name = 'changed again'
    const third = await client.query(text, [4])

    assert.deepEqual(first.rows, [{ n: 1 }])
    assert.deepEqual(second.rows, [{ n: 2 }])
    assert.deepEqual(array.rows, [[3]])
    assert.deepEqual(third.rows, [{ n: 4 }])
    assert.equal(third.fields[0].name, 'n')
    assert.equal(third.fields[0].dataTypeID, 23)
    assert.equal(array.fields[0].name, 'n')
    assert.equal(array.fields[0].dataTypeID, 23)
    assert.equal(third.rowCount, 1)
    assert.equal(third.command, 'SELECT')
  } finally {
    await client.end()
  }
})

suite.test('pipelined reuses retain independent rows and field descriptions', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n, $2::int4 AS "__proto__"'
    await client.query(text, [0, 0])

    const results = await Promise.all([
      client.query(text, [1, 11]),
      client.query({ text, values: [2, 22], rowMode: 'array' }),
      client.query(text, [3, 33]),
    ])

    assert.deepEqual(results[0].rows, [{ n: 1, ['__proto__']: 11 }])
    assert.deepEqual(results[1].rows, [[2, 22]])
    assert.deepEqual(results[2].rows, [{ n: 3, ['__proto__']: 33 }])
    assert.equal(Object.getPrototypeOf(results[2].rows[0]), Object.prototype)
    assert.deepEqual(results[0].fields, results[1].fields)
    assert.deepEqual(results[1].fields, results[2].fields)
    assert.notEqual(results[0].fields, results[1].fields)
  } finally {
    await client.end()
  }
})

suite.test('an isolated server error does not shift later cached pipeline results', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 / $2::int4 AS n'
    await client.query(text, [4, 2])

    const results = await Promise.allSettled([
      client.query(text, [10, 2]),
      client.query(text, [1, 0]),
      client.query(text, [12, 3]),
    ])

    assert.equal(results[0].status, 'fulfilled')
    assert.deepEqual(results[0].value.rows, [{ n: 5 }])
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[1].reason.code, '22012')
    assert.equal(results[2].status, 'fulfilled')
    assert.deepEqual(results[2].value.rows, [{ n: 4 }])
    assert.equal(results[2].value.fields[0].dataTypeID, 23)
    assert.deepEqual((await client.query(text, [18, 3])).rows, [{ n: 6 }])
  } finally {
    await client.end()
  }
})

suite.test('text, query binary and client binary reuse the same SQL without changing its values', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    const first = await client.query(text, [-16909061])
    const binary = await client.query({ text, values: [-16909061], binary: true })
    const again = await client.query(text, [-16909061])
    client.binary = true
    const defaultBinary = await client.query(text, [-16909061])
    client.binary = false
    const final = await client.query(text, [-16909061])

    assert.deepEqual(first.rows, [{ n: -16909061 }])
    assert.deepEqual(binary.rows, [{ n: -16909061 }])
    assert.deepEqual(again.rows, [{ n: -16909061 }])
    assert.deepEqual(defaultBinary.rows, [{ n: -16909061 }])
    assert.deepEqual(final.rows, [{ n: -16909061 }])
    assert.equal(first.fields[0].format, 'text')
    assert.equal(binary.fields[0].format, 'binary')
    assert.equal(again.fields[0].format, 'text')
    assert.equal(defaultBinary.fields[0].format, 'binary')
    assert.equal(final.fields[0].format, 'text')
  } finally {
    await client.end()
  }
})

suite.test('per-query and client parser overrides survive a previously cached builtin description', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    await client.query(text, [1])
    const types = { getTypeParser: () => (value) => `query:${value}` }

    const customQuery = await client.query({ text, values: [2], types })
    client.setTypeParser(23, (value) => `client:${value}`)
    const customClient = await client.query(text, [3])

    assert.deepEqual(customQuery.rows, [{ n: 'query:2' }])
    assert.deepEqual(customClient.rows, [{ n: 'client:3' }])
  } finally {
    await client.end()
  }
})

suite.test('a global parser override remains visible after warming the description cache', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  const original = helper.pg.types.getTypeParser(23, 'text')
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    await client.query(text, [1])
    helper.pg.types.setTypeParser(23, (value) => `global:${value}`)

    const custom = await client.query(text, [2])
    helper.pg.types.setTypeParser(23, original)
    const restored = await client.query(text, [3])

    assert.deepEqual(custom.rows, [{ n: 'global:2' }])
    assert.deepEqual(restored.rows, [{ n: 3 }])
  } finally {
    helper.pg.types.setTypeParser(23, original)
    await client.end()
  }
})

suite.test('a DDL result-type change reports its server error without replaying a write', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    await client.query('CREATE TEMP TABLE cached_int4_ddl (n int4, touches int4 DEFAULT 0)')
    await client.query('INSERT INTO cached_int4_ddl (n) VALUES (7)')
    const text = 'UPDATE cached_int4_ddl SET touches = touches + 1 WHERE $1::int4 = 1 RETURNING n'
    assert.deepEqual((await client.query(text, [1])).rows, [{ n: 7 }])
    await client.query('ALTER TABLE cached_int4_ddl ALTER COLUMN n TYPE text USING n::text')

    await assert.rejects(client.query(text, [1]), { code: '0A000' })

    assert.deepEqual((await client.query('SELECT n, touches FROM cached_int4_ddl')).rows, [{ n: '7', touches: 1 }])
  } finally {
    await client.end()
  }
})
