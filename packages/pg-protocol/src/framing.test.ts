import assert from 'assert'
import { PassThrough } from 'stream'
import { parse, parseRaw, ProtocolError } from '.'
import { Parser } from './parser'

const complete = Buffer.from([90, 0, 0, 0, 5, 73])
const protocolError = { name: 'ProtocolError', code: 'PG_PROTOCOL_ERROR' }

function boundedParser(maxMessageSize: number) {
  return new Parser({ mode: 'raw', maxMessageSize })
}

describe('protocol frame boundaries', () => {
  it('accepts a frame exactly at the configured length limit', () => {
    const messages: unknown[] = []
    const parser = boundedParser(5)

    parser.parse(complete, (message) => messages.push(message))

    assert.strictEqual(messages.length, 1)
  })

  it('accepts the minimum valid frame length', () => {
    const messages: unknown[] = []
    const parser = boundedParser(4)

    parser.parse(Buffer.from([49, 0, 0, 0, 4]), (message) => messages.push(message))
    parser.end()

    assert.strictEqual(messages.length, 1)
  })

  it('rejects signed int32 overflow with the default limit', () => {
    const parser = new Parser()

    assert.throws(() => parser.parse(Buffer.from([90, 128, 0, 0, 0]), () => {}), protocolError)
  })

  const invalidHeaders = [
    { why: 'length exceeds the configured limit', bytes: [90, 0, 0, 0, 6] },
    { why: 'length exceeds signed int32', bytes: [90, 128, 0, 0, 0] },
  ]
  for (const { why, bytes } of invalidHeaders) {
    it(`rejects a header immediately when ${why}`, () => {
      const parser = boundedParser(5)
      const messages: unknown[] = []

      assert.throws(() => parser.parse(Buffer.from(bytes), (message) => messages.push(message)), protocolError)
      assert.deepStrictEqual(messages, [])
    })
  }

  it('rejects an oversized fragmented header before its body arrives', () => {
    const parser = boundedParser(5)
    parser.parse(Buffer.from([90, 0, 0]), () => assert.fail('incomplete frame dispatched'))

    assert.throws(
      () => parser.parse(Buffer.from([0, 6]), () => assert.fail('oversized frame dispatched')),
      protocolError
    )
  })

  it('accepts coalesced frames whose total size exceeds the per-frame limit', () => {
    const parser = boundedParser(5)
    const messages: unknown[] = []

    parser.parse(Buffer.concat([complete, complete]), (message) => messages.push(message))

    assert.strictEqual(messages.length, 2)
  })

  const partialFrames = [
    { why: 'partial header', bytes: [90, 0, 0] },
    { why: 'partial body', bytes: [90, 0, 0, 0, 5] },
  ]
  for (const { why, bytes } of partialFrames) {
    it(`rejects EOF after a ${why}`, () => {
      const parser = boundedParser(5)
      parser.parse(Buffer.from(bytes), () => assert.fail('incomplete frame dispatched'))

      assert.throws(() => parser.end(), protocolError)
    })

    it(`rejects legacy parse's promise after a ${why}`, async () => {
      const stream = new PassThrough()
      const result = parse(stream, () => assert.fail('incomplete frame dispatched'))

      stream.end(Buffer.from(bytes))

      await assert.rejects(result, protocolError)
    })

    it(`destroys a raw stream ending after a ${why}`, (done) => {
      const stream = new PassThrough()
      stream.once('error', (error) => {
        assert.ok(error instanceof ProtocolError)
        assert.strictEqual(stream.destroyed, true)
        done()
      })
      parseRaw({ stream, callback: () => assert.fail('incomplete frame dispatched') })

      stream.end(Buffer.from(bytes))
    })
  }

  it('accepts EOF after complete frames and on an empty parser', async () => {
    const parser = boundedParser(5)
    parser.end()
    parser.parse(complete, () => {})
    parser.end()
    const stream = new PassThrough()
    const result = parse(stream, () => {})

    stream.end(complete)

    await result
  })

  it('keeps a raw stream healthy after a complete frame and EOF', (done) => {
    const stream = new PassThrough({ autoDestroy: false })
    const messages: unknown[] = []
    parseRaw({ stream, maxMessageSize: 5, callback: (message) => messages.push(message) })
    stream.once('end', () => {
      assert.strictEqual(stream.destroyed, false)
      assert.strictEqual(messages.length, 1)
      stream.destroy()
      done()
    })

    stream.end(complete)
  })

  it('stops dispatch after a malformed raw frame, including later emitted chunks', (done) => {
    const stream = new PassThrough()
    const messages: unknown[] = []
    stream.once('error', (error) => {
      assert.ok(error instanceof ProtocolError)
      stream.emit('data', complete)
      assert.deepStrictEqual(messages, [])
      done()
    })
    parseRaw({ stream, maxMessageSize: 5, callback: (message: unknown) => messages.push(message) })

    stream.emit('data', Buffer.concat([Buffer.from([90, 0, 0, 0, 6]), complete]))
  })

  for (const limit of [0, 3, 4.5, 2147483648, NaN, Infinity]) {
    it(`rejects invalid maxMessageSize ${limit} during construction`, () => {
      assert.throws(() => boundedParser(limit), RangeError)
    })
  }
})
