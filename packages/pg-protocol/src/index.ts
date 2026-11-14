import { Readable } from 'stream'
import { DatabaseError, ProtocolError } from './messages'
import { serialize } from './serializer'
import { Parser, MessageCallback } from './parser'

export function parse(stream: NodeJS.ReadableStream, callback: MessageCallback): Promise<void> {
  const parser = new Parser()
  stream.on('data', (buffer: Buffer) => parser.parse(buffer, callback))
  return new Promise((resolve) => stream.on('end', () => resolve()))
}

export function parseRaw(stream: Readable, callback: MessageCallback): Parser {
  const parser = new Parser({ mode: 'raw' })
  const onData = (buffer: Buffer) => {
    let inCallback = false
    try {
      parser.parse(buffer, (message) => {
        inCallback = true
        callback(message)
        inCallback = false
      })
    } catch (error) {
      if (inCallback || !(error instanceof ProtocolError)) throw error
      stream.removeListener('data', onData)
      stream.destroy(error)
    }
  }
  stream.on('data', onData)
  return parser
}

export { serialize, DatabaseError, ProtocolError }
