'use strict'

const assert = require('node:assert/strict')
const { Field } = require('pg-protocol/dist/messages')
const helper = require('./test-helper')
const suite = new helper.Suite('cached automatic text descriptions')

suite.test(
  'zero-parameter extended queries reuse one prepared statement while simple queries keep multiple results',
  async () => {
    const client = new helper.pg.Client({ maxAutoPrepare: 1 })
    try {
      await client.connect()
      const text = 'SELECT 17::int AS n'

      const first = await client.query({ text, values: [], queryMode: 'extended' })
      const second = await client.query({ text, values: [], queryMode: 'extended' })
      const prepared = await client.query("SELECT statement FROM pg_prepared_statements WHERE name <> ''")
      const simple = await client.query({ text: 'SELECT 23::int AS n; SELECT 29::int AS n', values: [] })

      assert.deepEqual(first.rows, [{ n: 17 }])
      assert.deepEqual(second.rows, [{ n: 17 }])
      assert.deepEqual(prepared.rows, [{ statement: 'SELECT 17::int AS n' }])
      assert.deepEqual(simple[0].rows, [{ n: 23 }])
      assert.deepEqual(simple[1].rows, [{ n: 29 }])
      assert.equal(simple.length, 2)
    } finally {
      await client.end()
    }
  }
)

suite.test('mixed object and array rows preserve values and metadata despite caller mutation', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text =
      'SELECT $1::int4 AS n, $2::text AS label, $3::bool AS enabled, $4::jsonb AS payload, $5::int8 AS big, NULL::text AS empty'
    const first = await client.query(text, [1, 'first', true, '{"v":1}', '9007199254740993'])
    first.fields[1].name = 'corrupted'
    first.fields[1].dataTypeID = 23
    first._parsers[0] = () => 'corrupted'
    first._prebuiltEmptyResultObject.label = 'corrupted'

    const array = await client.query({
      text,
      values: [2, 'second', false, '{"v":2}', '9007199254740994'],
      rowMode: 'array',
    })
    const third = await client.query(text, [3, 'third', true, '{"v":3}', '9007199254740995'])

    assert.deepEqual(first.rows, [
      { n: 1, label: 'first', enabled: true, payload: { v: 1 }, big: '9007199254740993', empty: null },
    ])
    assert.deepEqual(array.rows, [[2, 'second', false, { v: 2 }, '9007199254740994', null]])
    assert.deepEqual(third.rows, [
      { n: 3, label: 'third', enabled: true, payload: { v: 3 }, big: '9007199254740995', empty: null },
    ])
    assert.ok(first.fields[1] instanceof Field)
    assert.ok(array.fields[1] instanceof Field)
    assert.ok(third.fields[1] instanceof Field)
    assert.deepEqual(array.fields[1], new Field('label', 0, 0, 25, -1, -1, 'text'))
    assert.equal(array.fields[1].name, 'label')
    assert.equal(array.fields[1].dataTypeID, 25)
    assert.equal(third.fields[0].dataTypeID, 23)
    assert.equal(third.fields[2].dataTypeID, 16)
    assert.equal(third.fields[3].dataTypeID, 3802)
    assert.equal(third.fields[4].dataTypeID, 20)
    assert.equal(third.fields[5].dataTypeID, 25)
    assert.deepEqual(third.fields, array.fields)
    assert.notEqual(third.fields, array.fields)
    array.fields[1].name = 'changed again'
    assert.equal(third.fields[1].name, 'label')
    assert.equal(third.rowCount, 1)
    assert.equal(third.command, 'SELECT')
  } finally {
    await client.end()
  }
})

const transports = [
  { pipeline: false, why: 'serial execution' },
  { pipeline: true, why: 'pipelined execution' },
]
for (const { pipeline, why } of transports) {
  suite.test(`cached mixed and int4 rows retain their formats around binary queries during ${why}`, async () => {
    const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline })
    try {
      await client.connect()
      const mixed = 'SELECT $1::int4 AS n, $2::text AS label, $3::bool AS enabled'
      const integers = 'SELECT $1::int4 AS n'
      await client.query(mixed, [0, 'warm', false])
      await client.query(integers, [0])

      const results = await Promise.all([
        client.query(mixed, [1, 'before', true]),
        client.query(integers, [2]),
        client.query({ text: integers, values: [-16909061], binary: true }),
        client.query(mixed, [3, 'after', false]),
        client.query(integers, [4]),
      ])

      assert.deepEqual(results[0].rows, [{ n: 1, label: 'before', enabled: true }])
      assert.deepEqual(results[1].rows, [{ n: 2 }])
      assert.deepEqual(results[2].rows, [{ n: -16909061 }])
      assert.deepEqual(results[3].rows, [{ n: 3, label: 'after', enabled: false }])
      assert.deepEqual(results[4].rows, [{ n: 4 }])
      assert.equal(results[0].fields[0].format, 'text')
      assert.equal(results[1].fields[0].format, 'text')
      assert.equal(results[2].fields[0].format, 'binary')
      assert.equal(results[3].fields[0].format, 'text')
      assert.equal(results[3].fields[1].format, 'text')
      assert.equal(results[3].fields[2].format, 'text')
      assert.equal(results[4].fields[0].format, 'text')
    } finally {
      await client.end()
    }
  })
}

suite.test('a global text parser replacement and restoration remain visible after cache warmup', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  const original = helper.pg.types.getTypeParser(25, 'text')
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n, $2::text AS label'
    await client.query(text, [1, 'warm'])
    helper.pg.types.setTypeParser(25, 'text', (value) => `global:${value}`)

    const custom = await client.query(text, [2, 'changed'])
    helper.pg.types.setTypeParser(25, 'text', original)
    const restored = await client.query(text, [3, 'restored'])

    assert.deepEqual(custom.rows, [{ n: 2, label: 'global:changed' }])
    assert.deepEqual(restored.rows, [{ n: 3, label: 'restored' }])
  } finally {
    helper.pg.types.setTypeParser(25, 'text', original)
    await client.end()
  }
})

suite.test('queued cached object and array rows use parser overrides installed before execution', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: false })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n, $2::text AS label'
    await client.query(text, [1, 'warm object'])
    await client.query({ text, values: [2, 'warm array'], rowMode: 'array' })

    const blocker = client.query('SELECT pg_sleep(0.05)')
    const object = client.query(text, [3, 'object'])
    const array = client.query({ text, values: [4, 'array'], rowMode: 'array' })
    client.setTypeParser(25, (value) => `client:${value}`)
    await blocker

    assert.deepEqual((await object).rows, [{ n: 3, label: 'client:object' }])
    assert.deepEqual((await array).rows, [[4, 'client:array']])
    assert.deepEqual((await client.query(text, [5, 'refreshed'])).rows, [{ n: 5, label: 'client:refreshed' }])
  } finally {
    await client.end()
  }
})

suite.test('a text to varchar DDL change reports 0A000 without replaying an update', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    await client.query('CREATE TEMP TABLE cached_text_ddl (label text, touches int4 DEFAULT 0)')
    await client.query("INSERT INTO cached_text_ddl (label) VALUES ('kept')")
    const text = 'UPDATE cached_text_ddl SET touches = touches + 1 WHERE $1::int4 = 1 RETURNING label'
    assert.deepEqual((await client.query(text, [1])).rows, [{ label: 'kept' }])
    await client.query('ALTER TABLE cached_text_ddl ALTER COLUMN label TYPE varchar')

    await assert.rejects(client.query(text, [1]), { code: '0A000' })

    assert.deepEqual((await client.query('SELECT label, touches FROM cached_text_ddl')).rows, [
      { label: 'kept', touches: 1 },
    ])
  } finally {
    await client.end()
  }
})
