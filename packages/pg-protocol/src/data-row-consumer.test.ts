import assert from 'assert'
import { PassThrough } from 'stream'
import { parseRaw, ProtocolError } from '.'
import { BorrowedDataRow, RawDataRowMessage } from './messages'
import { Parser } from './parser'
import buffers from './testing/test-buffers'

describe('internal borrowed DataRow delivery', () => {
  it('reuses one frame and keeps coalesced ReadyForQuery boundaries aligned', () => {
    const parser = new Parser({ mode: 'raw' })
    const frames: BorrowedDataRow[] = []
    const rows: (string | null)[][] = []
    const messages: string[] = []
    const first = buffers.dataRow(['-12', null])
    const second = buffers.dataRow(['34', ''])
    const normal: RawDataRowMessage[] = []
    new Parser({ mode: 'raw' }).parse(Buffer.concat([first, second]), (row) => normal.push(row as RawDataRowMessage))
    parser.setDataRowConsumer({
      handleDataRow(frame) {
        frames.push(frame)
        const fields: (string | null)[] = []
        let offset = frame.offset + 2
        for (let i = 0; i < frame.fieldCount; i++) {
          const length = frame.buffer.readInt32BE(offset)
          offset += 4
          fields.push(length === -1 ? null : frame.buffer.toString('utf8', offset, offset + length))
          if (length !== -1) offset += length
        }
        rows.push(fields)
      },
    })

    parser.parse(Buffer.concat([first, buffers.readyForQuery(), second, buffers.readyForQuery()]), (message) => {
      messages.push(message.name)
    })

    assert.deepStrictEqual(
      rows,
      normal.map((row) => row.fields)
    )
    assert.deepStrictEqual(messages, ['readyForQuery', 'readyForQuery'])
    assert.strictEqual(frames[0], frames[1])
    assert.strictEqual(frames[0].buffer.length, 0)
  })

  const malformed = [
    { why: 'missing count', bytes: [68, 0, 0, 0, 5, 0] },
    { why: 'missing field length', bytes: [68, 0, 0, 0, 6, 0, 1] },
    { why: 'negative non-NULL length', bytes: [68, 0, 0, 0, 10, 0, 1, 255, 255, 255, 254] },
    { why: 'field exceeds payload', bytes: [68, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1] },
    { why: 'trailing bytes', bytes: [68, 0, 0, 0, 7, 0, 0, 42] },
    { why: 'header below four', bytes: [68, 0, 0, 0, 3] },
  ]
  for (const { why, bytes } of malformed) {
    it(`rejects ${why} before delivering a borrowed row`, () => {
      const parser = new Parser()
      let delivered = false
      parser.setDataRowConsumer({
        handleDataRow: () => {
          delivered = true
        },
      })

      assert.throws(
        () =>
          parser.parse(Buffer.from(bytes), () => {
            delivered = true
          }),
        ProtocolError
      )
      assert.strictEqual(delivered, false)
    })
  }

  it('still enforces the configured frame limit before borrowed delivery', () => {
    const parser = new Parser({ maxMessageSize: 6 })
    parser.setDataRowConsumer({ handleDataRow: () => assert.fail('oversized row delivered') })

    assert.throws(() => parser.parse(buffers.dataRow(['1']), () => assert.fail('message delivered')), ProtocolError)
  })

  it('destroys malformed streams before a borrowed consumer sees their rows', (done) => {
    const stream = new PassThrough()
    const parser = parseRaw({ stream, callback: () => assert.fail('message delivered') })
    parser.setDataRowConsumer({ handleDataRow: () => assert.fail('malformed row delivered') })
    stream.once('error', (error) => {
      assert.ok(error instanceof ProtocolError)
      assert.strictEqual(stream.destroyed, true)
      done()
    })

    stream.write(Buffer.from([68, 0, 0, 0, 6, 0, 1]))
  })

  it('propagates a consumer ProtocolError without destroying the transport', () => {
    const stream = new PassThrough()
    const error = new ProtocolError('row observer failed')
    const parser = parseRaw({ stream, callback: () => assert.fail('DataRow dispatched twice') })
    parser.setDataRowConsumer({
      handleDataRow: () => {
        throw error
      },
    })

    assert.throws(
      () => stream.emit('data', buffers.dataRow(['1'])),
      (actual) => actual === error
    )
    assert.strictEqual(stream.destroyed, false)
    stream.destroy()
  })
})
