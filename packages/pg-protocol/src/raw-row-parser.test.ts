import assert from 'assert'
import { PassThrough } from 'stream'
import { parseRaw, ProtocolError } from '.'
import { Parser } from './parser'

const bytesRow = Buffer.from([68, 0, 0, 0, 14, 0, 1, 0, 0, 0, 4, 0, 255, 128, 65])
const followingMessage = Buffer.from([90, 0, 0, 0, 5, 73])
const textRow = Buffer.from([68, 0, 0, 0, 20, 0, 3, 0, 0, 0, 2, 195, 169, 255, 255, 255, 255, 0, 0, 0, 0])

function readRaw(chunks: Buffer[]) {
  const messages: any[] = []
  const parser = new Parser({ mode: 'raw' } as any)
  for (const chunk of chunks) parser.parse(chunk, (message) => messages.push(message))
  return messages
}

describe('raw DataRow decoding', () => {
  it('preserves arbitrary binary bytes without copying whole payloads', () => {
    const [row] = readRaw([bytesRow])

    assert.strictEqual(row.buffer, bytesRow)
    assert.strictEqual(row.offset, 5)
    assert.deepStrictEqual(row.raw, Buffer.from([0, 1, 0, 0, 0, 4, 0, 255, 128, 65]))
    assert.strictEqual(row.raw, row.raw)
    assert.strictEqual(row.raw.buffer, bytesRow.buffer)
    assert.strictEqual(row.fieldCount, 1)
    assert.strictEqual(row.length, 14)
  })

  it('keeps legacy UTF-8, NULL and empty fields available', () => {
    const [row] = readRaw([textRow])

    assert.deepStrictEqual(row.fields, ['é', null, ''])
    assert.strictEqual(row.fields, row.fields)
  })

  it('keeps each row offset after the shared reader advances to another row', () => {
    const input = Buffer.concat([bytesRow, textRow])

    const [binary, text] = readRaw([input])

    assert.strictEqual(binary.buffer, input)
    assert.strictEqual(binary.offset, 5)
    assert.strictEqual(text.buffer, input)
    assert.strictEqual(text.offset, 20)
    assert.deepStrictEqual(binary.raw, Buffer.from([0, 1, 0, 0, 0, 4, 0, 255, 128, 65]))
    assert.deepStrictEqual(text.fields, ['é', null, ''])
  })

  it('decodes every split point identically to one whole message', () => {
    for (let split = 1; split < bytesRow.length; split++) {
      const [row] = readRaw([bytesRow.subarray(0, split), bytesRow.subarray(split)])
      assert.deepStrictEqual(row.raw, Buffer.from([0, 1, 0, 0, 0, 4, 0, 255, 128, 65]))
    }
  })

  for (const mode of ['text', 'raw']) {
    it(`retains COPY bytes across forced fragment compaction in ${mode} mode`, () => {
      const parser = new Parser({ mode } as any)
      const messages: any[] = []
      const copy = Buffer.from([100, 0, 0, 0, 8, 255, 128, 0, 65])
      const input = Buffer.concat([copy, followingMessage.subarray(0, 4)])

      parser.parse(input, (message) => messages.push(message))
      parser.parse(followingMessage.subarray(4), (message) => messages.push(message))

      assert.deepStrictEqual(messages[0].chunk, Buffer.from([255, 128, 0, 65]))
    })
  }

  it('retains raw rows when following fragments would compact their backing buffer', () => {
    const parser = new Parser({ mode: 'raw' } as any)
    const messages: any[] = []

    parser.parse(Buffer.concat([bytesRow, followingMessage.subarray(0, 4)]), (message) => messages.push(message))
    parser.parse(followingMessage.subarray(4), (message) => messages.push(message))

    assert.deepStrictEqual(messages[0].raw, Buffer.from([0, 1, 0, 0, 0, 4, 0, 255, 128, 65]))
  })

  const malformed = [
    { why: 'missing count', bytes: [68, 0, 0, 0, 5, 0] },
    { why: 'missing field length', bytes: [68, 0, 0, 0, 6, 0, 1] },
    { why: 'negative non-NULL length', bytes: [68, 0, 0, 0, 10, 0, 1, 255, 255, 255, 254] },
    { why: 'field exceeds payload', bytes: [68, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1] },
    { why: 'trailing bytes', bytes: [68, 0, 0, 0, 7, 0, 0, 42] },
    { why: 'header length below four', bytes: [68, 0, 0, 0, 3] },
  ]
  for (const mode of ['text', 'raw'] as const) {
    for (const { why, bytes } of malformed) {
      it(`${mode} rejects ${why} with a typed protocol error before dispatch`, () => {
        const parser = new Parser({ mode })
        const messages: unknown[] = []

        assert.throws(() => parser.parse(Buffer.from(bytes), (message) => messages.push(message)), {
          name: 'ProtocolError',
          code: 'PG_PROTOCOL_ERROR',
        })
        assert.deepStrictEqual(messages, [])
      })
    }

    it(`${mode} rejects a field extending into the next message even when backing bytes exist`, () => {
      const parser = new Parser({ mode })
      const messages: unknown[] = []
      const input = Buffer.concat([Buffer.from([68, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1]), followingMessage])

      assert.throws(() => parser.parse(input, (message) => messages.push(message)), {
        name: 'ProtocolError',
        code: 'PG_PROTOCOL_ERROR',
      })
      assert.deepStrictEqual(messages, [])
    })
  }

  it('destroys malformed streams and reports protocol errors without dispatch', (done) => {
    const stream = new PassThrough()
    const messages: unknown[] = []
    stream.once('error', (error: any) => {
      assert.strictEqual(error.name, 'ProtocolError')
      assert.strictEqual(error.code, 'PG_PROTOCOL_ERROR')
      assert.strictEqual(stream.destroyed, true)
      assert.deepStrictEqual(messages, [])
      done()
    })
    parseRaw({ stream, callback: (message) => messages.push(message) })

    stream.write(Buffer.from([68, 0, 0, 0, 6, 0, 1]))
  })

  for (const error of [new Error('application callback failed'), new ProtocolError('application protocol error')]) {
    it(`propagates callback ${error.name} without destroying transport`, () => {
      const stream = new PassThrough()
      parseRaw({
        stream,
        callback: () => {
          throw error
        },
      })

      assert.throws(
        () => stream.emit('data', bytesRow),
        (actual) => actual === error
      )
      assert.strictEqual(stream.destroyed, false)
      stream.destroy()
    })
  }
})

describe('text DataRow decoding', () => {
  it('decodes fragmented UTF-8, NULL and empty values without raw spans', () => {
    const parser = new Parser()
    const messages: any[] = []

    parser.parse(textRow.subarray(0, 12), (message) => messages.push(message))
    parser.parse(textRow.subarray(12), (message) => messages.push(message))

    assert.deepStrictEqual(messages[0].fields, ['é', null, ''])
    assert.strictEqual(messages[0].raw, undefined)
  })

  it('switches modes between packets delivered in one stream chunk', () => {
    const stream = new PassThrough()
    const messages: any[] = []
    const parser = parseRaw({
      stream,
      callback: (message) => {
        messages.push(message)
        parser.setDataRowMode('text')
      },
    })

    stream.write(Buffer.concat([bytesRow, textRow]))

    assert.deepStrictEqual(messages[0].raw, Buffer.from([0, 1, 0, 0, 0, 4, 0, 255, 128, 65]))
    assert.deepStrictEqual(messages[1].fields, ['é', null, ''])
    assert.strictEqual(messages[1].raw, undefined)
    stream.destroy()
  })
})
