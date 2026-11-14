'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const { Client } = require(path.join(root, 'packages/pg'))

;(async () => {
  const client = new Client()
  await client.connect()
  const concat = Buffer.concat
  let concatBytes = 0
  let concatCalls = 0
  try {
    await client.query('BEGIN')
    const value = Buffer.alloc(8388608, 0x61)
    Buffer.concat = function (buffers, length) {
      concatCalls++
      concatBytes += length === undefined ? buffers.reduce((sum, buffer) => sum + buffer.length, 0) : length
      return concat(buffers, length)
    }
    const results = await client.batch([
      { text: 'SELECT octet_length($1::bytea) AS n', values: [value] },
      { text: 'SELECT octet_length($1::bytea) AS n', values: [value] },
    ])
    Buffer.concat = concat
    assert.deepEqual(
      results.map((result) => result.rows),
      [[{ n: 8388608 }], [{ n: 8388608 }]]
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({ root, concatBytes, concatCalls }))
  } finally {
    Buffer.concat = concat
    await client.end()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
