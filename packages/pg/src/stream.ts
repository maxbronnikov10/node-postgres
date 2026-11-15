import net = require('node:net')
import tls = require('node:tls')
import type { ClientConfig, SocketStream } from './types'

export function getStream(_ssl?: ClientConfig['ssl']): SocketStream {
  return new net.Socket()
}

export function getSecureStream(
  options: tls.ConnectionOptions & { socket: SocketStream; host?: string }
): SocketStream {
  return tls.connect(options)
}
