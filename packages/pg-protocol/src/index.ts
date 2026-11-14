import { Readable } from 'stream'
import { DatabaseError, ProtocolError } from './messages'
import { serialize } from './serializer'
import { Parser, MessageCallback } from './parser'

export function parse(stream: NodeJS.ReadableStream, callback: MessageCallback): Promise<void> {
  const parser = new Parser()
  stream.on('data', (buffer: Buffer) => parser.parse(buffer, callback))
  return new Promise((resolve, reject) =>
    stream.on('end', () => {
      try {
        parser.end()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  )
}

export function parseRaw({
  stream,
  callback,
  maxMessageSize,
}: {
  stream: Readable
  callback: MessageCallback
  maxMessageSize?: number
}): Parser {
  const parser = new Parser({ mode: 'raw', maxMessageSize })
  const fail = (error: ProtocolError) => {
    stream.removeListener('data', onData)
    stream.removeListener('end', onEnd)
    stream.destroy(error)
  }
  const onEnd = () => {
    try {
      parser.end()
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error
      fail(error)
    }
  }
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
      fail(error)
    }
  }
  stream.on('data', onData)
  stream.on('end', onEnd)
  return parser
}

export { serialize, DatabaseError, ProtocolError }
