'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Writable } = require('node:stream')
const { serialize } = require('pg-protocol')
const Connection = require('../../../lib/connection')

function setup(highWaterMark = 1024 * 1024) {
  const packets = []
  const stream = new Writable({
    highWaterMark,
    write(buffer, encoding, callback) {
      packets.push(Buffer.from(buffer))
      if (highWaterMark === 1) setImmediate(callback)
      else callback()
    },
  })
  return { connection: new Connection({ stream }), stream, packets }
}

function frame(value) {
  return Buffer.concat([serialize.bind({ values: [value] }), serialize.execute(), serialize.sync()])
}

const tick = () => new Promise((resolve) => process.nextTick(resolve))

test('small cached frames coalesce within bounded packets without losing their Sync barriers', async () => {
  const { connection, packets } = setup()
  const value = 'x'.repeat(4000)
  const expected = Buffer.concat(Array.from({ length: 40 }, () => frame(value)))

  for (let i = 0; i < 40; i++) connection.bindExecute({ values: [value] })
  await tick()

  assert.deepEqual(Buffer.concat(packets), expected)
  assert.ok(packets.every((packet) => packet.length <= 65536))
  assert.ok(packets.length < 40)
})

test('a manual flush cannot let its stale callback flush a newer batch early', async () => {
  const { connection, packets } = setup()
  connection.bindExecute({ values: ['first'] })
  connection.query('SELECT 1')
  const boundary = new Promise((resolve, reject) =>
    process.nextTick(() => {
      try {
        assert.deepEqual(Buffer.concat(packets), Buffer.concat([frame('first'), serialize.query('SELECT 1')]))
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  )
  connection.bindExecute({ values: ['second'] })

  await boundary
  await tick()

  assert.deepEqual(
    Buffer.concat(packets),
    Buffer.concat([frame('first'), serialize.query('SELECT 1'), frame('second')])
  )
})

test('a failed bind keeps earlier frames ahead of the error Sync', async () => {
  const { connection, packets } = setup()
  connection.bindExecute({ values: ['first'] })

  assert.throws(
    () =>
      connection.bindExecute({
        values: [1],
        valueMapper() {
          throw new Error('bad bind')
        },
      }),
    /bad bind/
  )
  connection.sync()
  await tick()

  assert.deepEqual(Buffer.concat(packets), Buffer.concat([frame('first'), serialize.sync()]))
})

test('existing backpressure flushes cached frames immediately and preserves drain', async () => {
  const { connection, stream, packets } = setup(1)
  const drained = new Promise((resolve) => stream.once('drain', resolve))
  stream.write(serialize.sync())

  connection.bindExecute({ values: ['pressure'] })

  assert.equal(connection._pendingBindExecuteBytes, 0)
  assert.equal(stream.writableNeedDrain, true)
  assert.equal(stream.writableLength, serialize.sync().length + frame('pressure').length)
  await drained
  assert.deepEqual(Buffer.concat(packets), Buffer.concat([serialize.sync(), frame('pressure')]))
  assert.equal(stream.writableNeedDrain, false)
})

test('destroying a stream drops pending frames without another write', async () => {
  const { connection, stream, packets } = setup()
  connection.bindExecute({ values: ['discard'] })
  stream.destroy()

  await tick()

  assert.deepEqual(packets, [])
  assert.equal(connection._pendingBindExecuteBytes, 0)
})

test('large binds preserve pending frame order without copying their payload into a batch', async () => {
  const { connection, packets } = setup()
  connection.bindExecute({ values: ['first'] })
  const large = 'x'.repeat(5000)
  connection.bindExecute({ values: [large] })
  await tick()

  assert.deepEqual(Buffer.concat(packets), Buffer.concat([frame('first'), frame(large)]))
  assert.deepEqual(packets[1], serialize.bind({ values: [large] }))
})
