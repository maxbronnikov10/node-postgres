'use strict'

const assert = require('node:assert/strict')
const helper = require('./test-helper')
if (helper.args.native) return
const suite = new helper.Suite('cached Bind Execute Sync writes')

function messageCodes(buffers) {
  const codes = []
  for (const buffer of buffers) {
    for (let offset = 0; offset < buffer.length; offset += buffer.readUInt32BE(offset + 1) + 1) {
      codes.push(String.fromCharCode(buffer[offset]))
    }
  }
  return codes
}

const sizes = [
  { why: 'small cached bind preserves its result and Sync barrier', value: 'small' },
  { why: 'large cached bind preserves its payload and Sync barrier', value: 'x'.repeat(5000) },
]
for (const { why, value } of sizes) {
  suite.test(why, async () => {
    const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
    try {
      await client.connect()
      const text = 'SELECT $1::text AS label'
      await client.query(text, ['warm'])
      const sent = []
      const stream = client.connection.stream
      const write = stream.write
      stream.write = function (buffer, ...args) {
        sent.push(buffer)
        return write.call(this, buffer, ...args)
      }

      const result = await client.query(text, [value])

      assert.deepEqual(result.rows, [{ label: value }])
      assert.deepEqual(messageCodes(sent), ['B', 'E', 'S'])
    } finally {
      await client.end()
    }
  })
}

suite.test('a cached bind encoding error leaves its named statement reusable', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  const error = new Error('cached parameter conversion failed')
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    await client.query(text, [1])

    await assert.rejects(
      client.query(text, [
        {
          toPostgres() {
            throw error
          },
        },
      ]),
      (actual) => actual === error
    )

    assert.deepEqual((await client.query({ text, values: [2], rowMode: 'array' })).rows, [[2]])
    assert.deepEqual((await client.query(text, [3])).rows, [{ n: 3 }])
  } finally {
    await client.end()
  }
})

suite.test('each cached pipelined write commits independently around an execution error', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  const control = new helper.pg.Client()
  const table = `cached_bind_execute_${process.pid}`
  try {
    await client.connect()
    await control.connect()
    await control.query(`CREATE TABLE ${table} (n int4 NOT NULL)`)
    const text = `INSERT INTO ${table} (n) VALUES (12 / $1::int4) RETURNING n`
    await client.query(text, [12])
    await control.query(`DELETE FROM ${table}`)

    const results = await Promise.allSettled([
      client.query(text, [2]),
      client.query(text, [0]),
      client.query(text, [3]),
    ])

    assert.equal(results[0].status, 'fulfilled')
    assert.deepEqual(results[0].value.rows, [{ n: 6 }])
    assert.equal(results[1].status, 'rejected')
    assert.equal(results[1].reason.code, '22012')
    assert.equal(results[2].status, 'fulfilled')
    assert.deepEqual(results[2].value.rows, [{ n: 4 }])
    assert.deepEqual((await control.query(`SELECT n FROM ${table} ORDER BY n`)).rows, [{ n: 4 }, { n: 6 }])
  } finally {
    await control.query(`DROP TABLE IF EXISTS ${table}`)
    await Promise.all([client.end(), control.end()])
  }
})

suite.test('cached writes stay ordered around an uncached query in the same tick', async () => {
  const client = new helper.pg.Client({ maxAutoPrepare: 8, pipeline: true })
  try {
    await client.connect()
    const text = 'SELECT $1::int4 AS n'
    await client.query(text, [0])
    const sent = []
    const stream = client.connection.stream
    const write = stream.write
    stream.write = function (buffer, ...args) {
      sent.push(buffer)
      return write.call(this, buffer, ...args)
    }

    const results = await Promise.all([
      client.query(text, [1]),
      client.query(text, [2]),
      client.query('SELECT 3::int4 AS n'),
      client.query(text, [4]),
    ])

    assert.deepEqual(
      results.map((result) => result.rows),
      [[{ n: 1 }], [{ n: 2 }], [{ n: 3 }], [{ n: 4 }]]
    )
    assert.deepEqual(messageCodes(sent), ['B', 'E', 'S', 'B', 'E', 'S', 'Q', 'B', 'E', 'S'])
    assert.deepEqual(messageCodes([sent[0]]), ['B', 'E', 'S', 'B', 'E', 'S'])
  } finally {
    await client.end()
  }
})
