'use strict'

const assert = require('assert')
const { Writable } = require('stream')
const { setImmediate } = require('timers/promises')
const Connection = require('../../../lib/connection')
const helper = require('./test-helper')
const suite = new helper.Suite('pipeline backpressure')

suite.test('a flowing TLS stream sends a full buffer without waiting for the batching tick', async () => {
  const stream = new StalledStream('tls')
  stream.flowing = true
  const { client, connection } = connectedClient({ stream, config: { pipeline: true } })

  const query = client.query(`SELECT 1 /*${'x'.repeat(16384)}*/`)

  assert.strictEqual(stream.writableLength, 0)
  await setImmediate()
  connection.emit('commandComplete', { text: 'SELECT 1' })
  connection.emit('readyForQuery', { status: 'I' })
  assert.strictEqual((await query).rowCount, 1)
  assert.strictEqual(stream.writableCorked, 0)
  stream.destroy()
})

class StalledStream extends Writable {
  constructor(transport) {
    super({ highWaterMark: 1024 })
    this.encrypted = transport === 'tls'
    this.pending = []
    this.packets = []
    this.flowing = false
  }

  _write(chunk, encoding, callback) {
    this.packets.push(Buffer.from(chunk))
    if (this.flowing) callback()
    else this.pending.push(callback)
  }

  resumeWrites() {
    this.flowing = true
    this.pending.splice(0).forEach((callback) => callback())
  }
}

function connectedClient(options) {
  const connection = new Connection({ stream: options.stream })
  connection.connect = () => {}
  const client = new helper.Client({ connection, ...options.config })
  client.on('error', () => {})
  client.connect(() => {})
  connection.emit('readyForQuery', { status: 'I' })
  return { client, connection }
}

for (const transport of ['tcp', 'tls']) {
  suite.test(`${transport} pipeline pauses later payloads until drain and preserves query boundaries`, async () => {
    const stream = new StalledStream(transport)
    const { client, connection } = connectedClient({ stream, config: { pipeline: true } })
    const padding = 'x'.repeat(16384)
    const first = client.query(`SELECT 1 /*${padding}*/`)
    const second = client.query(`SELECT 2 /*${padding}*/`)

    // One 16 KiB query fits below 20,000 bytes, including protocol framing.
    assert.strictEqual(stream.writableNeedDrain, true)
    assert.ok(stream.writableLength < 20000)
    stream.resumeWrites()
    await setImmediate()

    assert.strictEqual(stream.writableLength, 0)
    assert.deepStrictEqual(
      stream.packets.map((packet) => packet.toString('utf8', 5, 13)),
      ['SELECT 1', 'SELECT 2']
    )
    connection.emit('commandComplete', { text: 'SELECT 1' })
    connection.emit('readyForQuery', { status: 'I' })
    connection.emit('commandComplete', { text: 'SELECT 1' })
    connection.emit('readyForQuery', { status: 'I' })
    const results = await Promise.all([first, second])

    assert.deepStrictEqual(
      results.map((result) => result.rowCount),
      [1, 1]
    )
    assert.strictEqual(stream.listenerCount('drain'), 0)
    assert.strictEqual(stream.writableCorked, 0)
    stream.destroy()
  })

  suite.test(
    `${transport} responses already in flight complete while later pipeline writes wait for drain`,
    async () => {
      const stream = new StalledStream(transport)
      stream.flowing = true
      const { client, connection } = connectedClient({ stream, config: { pipeline: true } })
      const first = client.query('SELECT 1')
      const second = client.query('SELECT 2')
      await setImmediate()
      stream.flowing = false
      const third = client.query(`SELECT 3 /*${'x'.repeat(16384)}*/`)
      const fourth = client.query('SELECT 4')

      connection.emit('commandComplete', { text: 'SELECT 1' })
      connection.emit('readyForQuery', { status: 'I' })
      connection.emit('commandComplete', { text: 'SELECT 1' })
      connection.emit('readyForQuery', { status: 'I' })
      const early = await Promise.all([first, second])

      assert.deepStrictEqual(
        early.map((result) => result.rowCount),
        [1, 1]
      )
      assert.strictEqual(stream.writableNeedDrain, true)
      stream.resumeWrites()
      await setImmediate()
      connection.emit('commandComplete', { text: 'SELECT 1' })
      connection.emit('readyForQuery', { status: 'I' })
      connection.emit('commandComplete', { text: 'SELECT 1' })
      connection.emit('readyForQuery', { status: 'I' })
      const remaining = await Promise.all([third, fourth])

      assert.deepStrictEqual(
        remaining.map((result) => result.rowCount),
        [1, 1]
      )
      assert.deepStrictEqual(
        stream.packets.map((packet) => packet.toString('utf8', 5, 13)),
        ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 4']
      )
      assert.strictEqual(stream.writableLength, 0)
      assert.strictEqual(stream.listenerCount('drain'), 0)
      assert.strictEqual(stream.writableCorked, 0)
      stream.destroy()
    }
  )

  suite.test(
    `${transport} transport errors reject both sent and paused queries and release the drain listener`,
    async () => {
      const stream = new StalledStream(transport)
      const { client, connection } = connectedClient({ stream, config: { pipeline: true } })
      const failure = new Error('transport failed while writes were paused')
      const first = client.query(`SELECT 1 /*${'x'.repeat(16384)}*/`)
      const second = client.query('SELECT 2')
      const settled = Promise.allSettled([first, second])

      connection.emit('error', failure)
      stream.resumeWrites()
      await setImmediate()
      const results = await settled

      assert.deepStrictEqual(
        results.map((result) => result.status),
        ['rejected', 'rejected']
      )
      assert.strictEqual(results[0].reason, failure)
      assert.strictEqual(results[1].reason, failure)
      assert.strictEqual(stream.listenerCount('drain'), 0)
      assert.deepStrictEqual(
        stream.packets.map((packet) => packet.toString('utf8', 5, 13)),
        ['SELECT 1']
      )
      assert.strictEqual(stream.writableLength, 0)
      assert.strictEqual(stream.writableCorked, 0)
      stream.destroy()
    }
  )

  suite.test(`${transport} unsent timed-out queries do not close a healthy stalled pipeline`, async () => {
    const stream = new StalledStream(transport)
    const { client, connection } = connectedClient({ stream, config: { pipeline: true } })
    const first = client.query(`SELECT 1 /*${'x'.repeat(16384)}*/`)
    const second = client.query({ text: 'SELECT 2', query_timeout: 5 })

    await assert.rejects(second, /Query read timeout/)

    assert.strictEqual(stream.destroyed, false)
    stream.resumeWrites()
    await setImmediate()
    connection.emit('commandComplete', { text: 'SELECT 1' })
    connection.emit('readyForQuery', { status: 'I' })
    const result = await first

    assert.strictEqual(result.rowCount, 1)
    assert.deepStrictEqual(
      stream.packets.map((packet) => packet.toString('utf8', 5, 13)),
      ['SELECT 1']
    )
    assert.strictEqual(stream.listenerCount('drain'), 0)
    assert.strictEqual(stream.writableLength, 0)
    assert.strictEqual(stream.writableCorked, 0)
    stream.destroy()
  })

  suite.test(
    `${transport} frozen encoding errors preserve their identity and allow the next query to complete`,
    async () => {
      const stream = new StalledStream(transport)
      stream.flowing = true
      const { client, connection } = connectedClient({ stream, config: { pipeline: true } })
      const failure = Object.freeze(new Error('cannot encode parameter'))
      const first = client.query('SELECT $1', [
        {
          toPostgres() {
            throw failure
          },
        },
      ])
      const second = client.query('SELECT 7')
      const settled = Promise.allSettled([first, second])

      await setImmediate()
      connection.emit('readyForQuery', { status: 'I' })
      connection.emit('commandComplete', { text: 'SELECT 1' })
      connection.emit('readyForQuery', { status: 'I' })
      const results = await settled

      assert.strictEqual(results[0].status, 'rejected')
      assert.strictEqual(results[0].reason, failure)
      assert.strictEqual(results[1].status, 'fulfilled')
      assert.strictEqual(results[1].value.rowCount, 1)
      assert.deepStrictEqual(
        stream.packets.map((packet) => packet.toString('utf8', 0, 1)),
        ['P', 'C', 'S', 'Q']
      )
      assert.strictEqual(stream.writableLength, 0)
      assert.strictEqual(stream.writableCorked, 0)
      assert.strictEqual(stream.listenerCount('drain'), 0)
      stream.destroy()
    }
  )
}
