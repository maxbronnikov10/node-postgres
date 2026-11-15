'use strict'

const EventEmitter = require('events').EventEmitter as typeof import('events').EventEmitter

const { parseRaw, serialize } = require('pg-protocol') as typeof import('pg-protocol')
import stream = require('./stream')
import type { ConnectionConfig, PgError, SocketStream, SslOptions } from './types'
import type { ConnectionOptions } from 'node:tls'
import type { Parser } from 'pg-protocol/dist/parser'
const { getStream } = stream

const flushBuffer = serialize.flush()
const syncBuffer = serialize.sync()
const endBuffer = serialize.end()

// TODO(bmc) support binary mode at some point
class Connection extends EventEmitter {
  stream: SocketStream
  parsedStatements: Record<string, string | undefined>
  submittedNamedStatements: Record<string, string | undefined>
  ssl: boolean | SslOptions
  sslNegotiation: 'postgres' | 'direct'
  _keepAlive: boolean | undefined
  _maxMessageSize: number | undefined
  _keepAliveInitialDelayMillis: number | undefined
  _ending: boolean
  _emitMessage: boolean
  _connecting: boolean | undefined
  _parser: Parser | undefined

  constructor(config?: ConnectionConfig) {
    super()
    config = config || {}

    this.stream = (config.stream || getStream(config.ssl)) as SocketStream
    if (typeof this.stream === 'function') {
      this.stream = (this.stream as (config: ConnectionConfig) => SocketStream)(config)
    }

    this._keepAlive = config.keepAlive
    this._maxMessageSize = config.maxMessageSize
    this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis
    this.parsedStatements = Object.create(null)
    this.submittedNamedStatements = Object.create(null)
    this.ssl = config.ssl || false
    this.sslNegotiation = config.sslNegotiation || 'postgres'
    this._ending = false
    this._emitMessage = false
    const self = this
    this.on('newListener', function (eventName) {
      if (eventName === 'message') {
        self._emitMessage = true
      }
    })
  }

  connect(port: number | string, host?: string) {
    const self = this

    this._connecting = true
    this.stream.setNoDelay(true)
    this.stream.connect(port, host)

    this.stream.once('connect', function () {
      if (self._keepAlive) {
        self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis)
      }
      self.emit('connect')
    })

    const reportStreamError = function (error: PgError) {
      // errors about disconnections should be ignored during disconnect
      if (self._ending && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
        return
      }
      self.emit('error', error)
    }
    this.stream.on('error', reportStreamError)

    this.stream.on('close', function () {
      self.emit('end')
    })

    if (!this.ssl) {
      return this.attachListeners(this.stream)
    }

    // With direct SSL negotiation the TLS handshake starts immediately on the
    // raw socket, skipping the SSLRequest packet and the server's 'S'/'N' reply.
    if (this.sslNegotiation === 'direct') {
      return this.stream.once('connect', function () {
        self.upgradeToSSL(host, reportStreamError)
      })
    }

    this.stream.once('data', function (buffer) {
      const responseCode = buffer.toString('utf8')
      switch (responseCode) {
        case 'S': // Server supports SSL connections, continue with a secure connection
          break
        case 'N': // Server does not support SSL connections
          self.stream.end()
          return self.emit('error', new Error('The server does not support SSL connections'))
        default:
          // Any other response byte, including 'E' (ErrorResponse) indicating a server error
          self.stream.end()
          return self.emit('error', new Error('There was an error establishing an SSL connection'))
      }
      self.upgradeToSSL(host, reportStreamError)
    })
  }

  upgradeToSSL(host: string | undefined, reportStreamError: (error: PgError) => void) {
    const self = this
    const options = {
      socket: self.stream,
      // tls.connect checks the server identity against `servername`, falling
      // back to `host` and then to 'localhost'. `servername` must stay unset
      // for IP addresses (see below), so `host` is needed to keep certificate
      // validation working when connecting to an IP address.
      host,
    } as ConnectionOptions & { socket: SocketStream; host?: string }

    if (self.ssl !== true) {
      Object.assign(options, self.ssl)

      if ('key' in (self.ssl as SslOptions)) {
        options.key = (self.ssl as SslOptions).key
      }
    }

    // Direct SSL negotiation requires ALPN so the server can confirm it is
    // speaking the PostgreSQL protocol over the TLS connection.
    if (self.sslNegotiation === 'direct') {
      options.ALPNProtocols = ['postgresql']
    }

    // SNI must not be set to an IP address (RFC 6066 section 3)
    const net = require('net') as typeof import('net')
    if (options.servername === undefined && net.isIP && net.isIP(host as string) === 0) {
      options.servername = host
    }
    try {
      self.stream = stream.getSecureStream(options)
    } catch (err) {
      return self.emit('error', err)
    }
    self.attachListeners(self.stream)
    self.stream.on('error', reportStreamError)

    self.emit('sslconnect')
  }

  attachListeners(stream: SocketStream) {
    this._parser = parseRaw({
      stream,
      maxMessageSize: this._maxMessageSize,
      callback: (msg) => {
        const eventName = msg.name === 'error' ? 'errorMessage' : msg.name
        if (this._emitMessage) {
          this.emit('message', msg)
        }
        this.emit(eventName, msg)
      },
    })
  }

  setDataRowMode(mode: Parameters<Parser['setDataRowMode']>[0]) {
    if (this._parser) this._parser.setDataRowMode(mode)
  }

  requestSsl() {
    this.stream.write(serialize.requestSsl())
  }

  startup(config: Parameters<typeof serialize.startup>[0]) {
    this.stream.write(serialize.startup(config))
  }

  cancel(processID: number, secretKey: number) {
    this._send(serialize.cancel(processID, secretKey))
  }

  password(password: string) {
    this._send(serialize.password(password))
  }

  sendSASLInitialResponseMessage(mechanism: string, initialResponse: string) {
    this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse))
  }

  sendSCRAMClientFinalMessage(additionalData: string) {
    this._send(serialize.sendSCRAMClientFinalMessage(additionalData))
  }

  _send(buffer: Buffer) {
    if (!this.stream.writable) {
      return false
    }
    return this.stream.write(buffer)
  }

  query(text: string) {
    this._send(serialize.query(text))
  }

  // send parse message
  parse(query: Parameters<typeof serialize.parse>[0]) {
    this._send(serialize.parse(query))
  }

  // send bind message
  bind(config: Parameters<typeof serialize.bind>[0]) {
    this._send(serialize.bind(config))
  }

  // send execute message
  execute(config: Parameters<typeof serialize.execute>[0]) {
    this._send(serialize.execute(config))
  }

  flush() {
    if (this.stream.writable) {
      this.stream.write(flushBuffer)
    }
  }

  sync() {
    // Sync is the extended-query protocol barrier, not a disconnect.
    // Only end()/Terminate (and connect-timeout teardown) should set _ending.
    this._send(syncBuffer)
  }

  ref() {
    this.stream.ref()
  }

  unref() {
    this.stream.unref()
  }

  end() {
    // 0x58 = 'X'
    this._ending = true
    if (!this._connecting || !this.stream.writable) {
      this.stream.end()
      return
    }
    return this.stream.write(endBuffer, () => {
      this.stream.end()
    })
  }

  close(msg: Parameters<typeof serialize.close>[0]) {
    this._send(serialize.close(msg))
  }

  describe(msg: Parameters<typeof serialize.describe>[0]) {
    this._send(serialize.describe(msg))
  }

  sendCopyFromChunk(chunk: Buffer) {
    this._send(serialize.copyData(chunk))
  }

  endCopyFrom() {
    this._send(serialize.copyDone())
  }

  sendCopyFail(msg: string) {
    this._send(serialize.copyFail(msg))
  }
}

export = Connection
