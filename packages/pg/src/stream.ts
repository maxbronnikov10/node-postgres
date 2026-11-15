import type { ConnectionOptions } from 'node:tls'
import type { ClientConfig, SocketStream } from './types'

declare const navigator: { userAgent?: unknown } | null | undefined
declare const Response:
  | (new (body: null, options: { cf: { thing: boolean } }) => { cf?: { thing?: boolean } })
  | undefined

interface StreamFunctions {
  getStream(ssl?: ClientConfig['ssl']): SocketStream
  getSecureStream(options: ConnectionOptions & { socket: SocketStream; host?: string }): SocketStream
}

const { getStream, getSecureStream } = getStreamFuncs()

export {
  /**
   * Get a socket stream compatible with the current runtime environment.
   * @returns {Duplex}
   */
  getStream,
  /**
   * Get a TLS secured socket, compatible with the current environment,
   * using the socket and other settings given in `options`.
   * @returns {Duplex}
   */
  getSecureStream,
}

/**
 * The stream functions that work in Node.js
 */
function getNodejsStreamFuncs(): StreamFunctions {
  function getStream(ssl?: ClientConfig['ssl']) {
    const net = require('net') as typeof import('node:net')
    return new net.Socket()
  }

  function getSecureStream(options: ConnectionOptions & { socket: SocketStream; host?: string }) {
    const tls = require('tls') as typeof import('node:tls')
    return tls.connect(options)
  }
  return {
    getStream,
    getSecureStream,
  }
}

/**
 * The stream functions that work in Cloudflare Workers
 */
function getCloudflareStreamFuncs(): StreamFunctions {
  function getStream(ssl?: ClientConfig['ssl']) {
    const { CloudflareSocket } = require('pg-cloudflare') as typeof import('pg-cloudflare')
    return new CloudflareSocket(ssl as boolean) as unknown as SocketStream
  }

  function getSecureStream(options: ConnectionOptions & { socket: SocketStream; host?: string }) {
    options.socket.startTls!(options)
    return options.socket
  }
  return {
    getStream,
    getSecureStream,
  }
}

/**
 * Are we running in a Cloudflare Worker?
 *
 * @returns true if the code is currently running inside a Cloudflare Worker.
 */
function isCloudflareRuntime() {
  // Since 2022-03-21 the `global_navigator` compatibility flag is on for Cloudflare Workers
  // which means that `navigator.userAgent` will be defined.
  if (typeof navigator === 'object' && navigator !== null && typeof navigator.userAgent === 'string') {
    return navigator.userAgent === 'Cloudflare-Workers'
  }
  // In case `navigator` or `navigator.userAgent` is not defined then try a more sneaky approach
  if (typeof Response === 'function') {
    const resp = new Response(null, { cf: { thing: true } })
    if (typeof resp.cf === 'object' && resp.cf !== null && resp.cf.thing) {
      return true
    }
  }
  return false
}

function getStreamFuncs(): StreamFunctions {
  if (isCloudflareRuntime()) {
    return getCloudflareStreamFuncs()
  }
  return getNodejsStreamFuncs()
}
