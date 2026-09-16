'use strict'

const { Writable } = require('stream')
const assert = require('assert')
const helper = require('./test-helper')
const Connection = require('../../../lib/connection')
const suite = new helper.Suite('pipeline write coalescing')

const nextTick = () => new Promise((resolve) => process.nextTick(resolve))

class CountingStream extends Writable {
  constructor() {
    const metrics = {
      writeCalls: 0,
      writevCalls: 0,
      packets: [],
    }

    super({
      write(chunk, encoding, callback) {
        metrics.writeCalls++
        metrics.packets.push(Buffer.from(chunk))
        callback()
      },
      writev(chunks, callback) {
        metrics.writevCalls++
        metrics.packets.push(...chunks.map(({ chunk }) => Buffer.from(chunk)))
        callback()
      },
    })

    this.metrics = metrics
  }
}

function connectedClient(stream, config) {
  const connection = new Connection({ stream })
  connection.connect = () => {}
  const client = new helper.Client({ connection, ...config })
  client.connect(() => {})
  connection.emit('readyForQuery')
  return { client, connection }
}

suite.test('coalesces same-turn pipeline writes into one stream flush', async function () {
  const stream = new CountingStream()
  const { client } = connectedClient(stream, { pipeline: true, pipelineBatchWrites: true })

  client.query('SELECT 1')
  client.query('SELECT 2')

  assert.equal(stream.metrics.writeCalls, 0)
  assert.equal(stream.metrics.writevCalls, 0)

  await nextTick()

  assert.equal(stream.metrics.writeCalls, 0)
  assert.equal(stream.metrics.writevCalls, 1)
  assert.lengthIs(stream.metrics.packets, 2)
  stream.end()
})

suite.test('keeps one Sync boundary per pipelined extended query', async function () {
  const stream = new CountingStream()
  const { client } = connectedClient(stream, { pipeline: true, pipelineBatchWrites: true })

  client.query({ text: 'SELECT $1::int', values: [1] })
  client.query({ text: 'SELECT $1::int', values: [2] })

  await nextTick()

  assert.equal(stream.metrics.writevCalls, 1)
  assert.deepStrictEqual(
    stream.metrics.packets.map((packet) => String.fromCharCode(packet[0])),
    ['P', 'B', 'D', 'E', 'S', 'P', 'B', 'D', 'E', 'S']
  )
  stream.end()
})

suite.test('does not batch writes by default', function () {
  const stream = new CountingStream()
  const { client } = connectedClient(stream, { pipeline: true })

  client.query('SELECT 1')
  client.query('SELECT 2')

  assert.equal(client.pipelineBatchWrites, false)
  assert.equal(stream.metrics.writeCalls, 2)
  assert.equal(stream.metrics.writevCalls, 0)
  stream.end()
})

suite.test('option has no effect without pipeline mode', function () {
  const stream = new CountingStream()
  const { client } = connectedClient(stream, { pipelineBatchWrites: true })

  client.query('SELECT 1')

  assert.equal(client.pipelineBatchWrites, false)
  assert.equal(stream.metrics.writeCalls, 1)
  assert.equal(stream.metrics.writevCalls, 0)
  stream.end()
})

suite.test('works with streams that do not expose cork', async function () {
  const stream = new CountingStream()
  stream.cork = undefined
  stream.uncork = undefined
  const { client } = connectedClient(stream, { pipeline: true, pipelineBatchWrites: true })

  client.query('SELECT 1')
  client.query('SELECT 2')
  await nextTick()

  assert.equal(client.pipelineBatchWrites, true)
  assert.lengthIs(stream.metrics.packets, 2)
  stream.destroy()
})

suite.test('balances outer cork after submit throws', async function () {
  const stream = new CountingStream()
  stream.write = function () {
    throw new Error('write failed')
  }
  const { client } = connectedClient(stream, { pipeline: true, pipelineBatchWrites: true })

  assert.throws(() => client.query('SELECT 1'), { message: 'write failed' })
  await nextTick()

  assert.equal(stream.writableCorked, 0)
})

suite.test('does not consume a cork held by caller', async function () {
  const stream = new CountingStream()
  const { client } = connectedClient(stream, { pipeline: true, pipelineBatchWrites: true })
  stream.cork()

  client.query('SELECT 1')
  await nextTick()

  assert.equal(stream.writableCorked, 1)
  stream.uncork()
  assert.equal(stream.writableCorked, 0)
  stream.end()
})
