import assert from 'assert'
import { Parser } from './parser'
import { ProtocolError } from './messages'

function dataRow(values: (string | null)[]): Buffer {
  const fields = values.map((value) => {
    if (value === null) {
      const length = Buffer.alloc(4)
      length.writeInt32BE(-1)
      return length
    }
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(4)
    length.writeInt32BE(bytes.length)
    return Buffer.concat([length, bytes])
  })
  const body = Buffer.concat([Buffer.from([0, values.length]), ...fields])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length + 4)
  return Buffer.concat([Buffer.from([68]), length, body])
}

describe('text DataRow UTF-8 decoding', () => {
  it('decodes Unicode, NULL and empty values in one frame', () => {
    const parser = new Parser()
    const messages: any[] = []

    parser.parse(dataRow(['Привет 🌍', null, '']), (message) => messages.push(message))

    assert.deepStrictEqual(messages[0].fields, ['Привет 🌍', null, ''])
    assert.strictEqual(messages[0].raw, undefined)
  })

  it('decodes a multibyte character split across chunks', () => {
    const parser = new Parser()
    const messages: any[] = []
    const frame = dataRow(['é🙂'])
    const payloadStart = 5 + 2 + 4

    parser.parse(frame.subarray(0, payloadStart + 1), (message) => messages.push(message))
    parser.parse(frame.subarray(payloadStart + 1), (message) => messages.push(message))

    assert.deepStrictEqual(messages[0].fields, ['é🙂'])
  })

  it('rejects an out-of-bounds field length without dispatching the frame', () => {
    const parser = new Parser()
    const messages: unknown[] = []
    const malformed = Buffer.from([68, 0, 0, 0, 11, 0, 1, 0, 0, 0, 2, 65])

    assert.throws(() => parser.parse(malformed, (message) => messages.push(message)), ProtocolError)
    assert.deepStrictEqual(messages, [])
  })

  it('uses the UTF-8 fallback when native utf8Slice is unavailable at module load', () => {
    const prototype = Buffer.prototype as Buffer & { utf8Slice?: (start: number, end: number) => string }
    const original = prototype.utf8Slice
    let FallbackParser: typeof Parser

    delete require.cache[require.resolve('./parser')]
    prototype.utf8Slice = undefined
    try {
      FallbackParser = require('./parser').Parser
    } finally {
      prototype.utf8Slice = original
    }

    const parser = new FallbackParser()
    const messages: any[] = []
    parser.parse(dataRow(['é']), (message) => messages.push(message))

    assert.deepStrictEqual(messages[0].fields, ['é'])
  })
})
