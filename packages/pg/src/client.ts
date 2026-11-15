import { EventEmitter } from 'events'
import utils = require('./utils')
import nodeUtils = require('util')
import sasl = require('./crypto/sasl')
import TypeOverrides = require('./type-overrides')

import ConnectionParameters = require('./connection-parameters')
import Query = require('./query')
import Batch = require('./batch')
import defaults = require('./defaults')
import Connection = require('./connection')
import crypto = require('./crypto/utils')

import type {
  ClientConfig,
  ExecutableQuery,
  Password,
  PgError,
  QueryCallback,
  QueryArrayConfig,
  QueryArrayResult,
  QueryConfig,
  QueryInput,
  QueryResultRow,
  QueryResult,
  QueryResults,
  SslOptions,
  Submittable,
  TextParser,
  BinaryParser,
  TypeFormat,
  Notification,
} from './types'
import { Field } from 'pg-protocol/dist/messages'
import type {
  AuthenticationMD5Password,
  BackendKeyDataMessage,
  ReadyForQueryMessage,
  RowDescriptionMessage,
  DataRowMessage,
  RawDataRowMessage,
  CommandCompleteMessage,
  CopyDataMessage,
  NoticeMessage,
} from 'pg-protocol/dist/messages'
import type Result = require('./result')

type ConnectCallback = (error?: Error | null, client?: Client) => void
type EndCallback = (error?: Error | null) => void
type ClientQueryCallback<R extends object = QueryResultRow> = (error: PgError | null, result: QueryResult<R>) => void
type BatchCallback<R extends object = QueryResultRow> = (error: PgError | null, results?: Result<R>[]) => void
type CachedDescription = {
  message: RowDescriptionMessage
  expiresAt: number
  layouts: NonNullable<Query['_cachedRowLayouts']>
}

const activeQueryDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'Client.activeQuery is deprecated and will be removed in pg@9.0'
)

const queryQueueDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'Client.queryQueue is deprecated and will be removed in pg@9.0.'
)

const pgPassDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'pgpass support is deprecated and will be removed in pg@9.0. ' +
    'You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code.'
)

const byoPromiseDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0.'
)

const queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.'
)

function coerceNumberOrDefault(value: unknown, defaultValue: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : defaultValue
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : defaultValue
  }
  return defaultValue
}

class Client extends EventEmitter {
  declare static Query: typeof Query
  connectionParameters: ConnectionParameters
  user: string
  database: string
  port: number
  host: string
  declare password: Password
  replication: ClientConfig['replication']
  _Promise: PromiseConstructor
  _types: TypeOverrides
  _ending: boolean
  _ended: boolean
  _connecting: boolean
  _connected: boolean
  _connectionError: boolean
  _queryable: boolean
  _activeQuery: ExecutableQuery | null | undefined
  private _dataRowHandler: ((message: DataRowMessage | RawDataRowMessage) => void) | undefined
  _txStatus: 'I' | 'T' | 'E' | null
  enableChannelBinding: boolean
  scramMaxIterations: number
  connection: Connection
  _queryQueue: ExecutableQuery[]
  _sentQueryQueue: ExecutableQuery[]
  pipeline: boolean
  autoBatch: boolean
  _maxAutoPrepare: number
  _autoPreparedStatements: Map<string, string> | undefined
  _autoPreparePrefix: string | undefined
  private _autoPreparedDescriptions: Map<string, CachedDescription> | undefined
  binary: boolean | undefined
  processID: number | null
  secretKey: number | null
  ssl: boolean | SslOptions
  sslNegotiation: 'postgres' | 'direct'
  _connectionTimeoutMillis: number
  connectionTimeoutHandle: NodeJS.Timeout | undefined
  _connectionCallback: ConnectCallback | null | undefined
  _pipelineDrainListener: (() => void) | null | undefined
  _pipelineWritePending: (() => void) | null | undefined
  _batchScheduled: boolean | undefined
  readyForQuery: boolean | undefined
  hasExecuted: boolean | undefined
  saslSession: sasl.SaslSession | null | undefined

  constructor(config?: string | ClientConfig) {
    super()

    this.connectionParameters = new ConnectionParameters(config)
    this.user = this.connectionParameters.user
    this.database = this.connectionParameters.database
    this.port = this.connectionParameters.port
    this.host = this.connectionParameters.host

    // "hiding" the password so it doesn't show up in stack traces
    // or if the client is console.logged
    Object.defineProperty(this, 'password', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: this.connectionParameters.password,
    })

    this.replication = this.connectionParameters.replication

    const c = (config || {}) as ClientConfig
    if (
      c.maxMessageSize !== undefined &&
      (!Number.isInteger(c.maxMessageSize) || c.maxMessageSize < 4 || c.maxMessageSize > 2147483647)
    ) {
      throw new TypeError('maxMessageSize must be an integer from 4 to 2147483647')
    }

    if (c.Promise) {
      byoPromiseDeprecationNotice()
    }
    this._Promise = c.Promise || global.Promise
    this._types = new TypeOverrides(c.types)
    this._ending = false
    this._ended = false
    this._connecting = false
    this._connected = false
    this._connectionError = false
    this._queryable = true
    this._activeQuery = null
    this._txStatus = null

    this.enableChannelBinding = Boolean(c.enableChannelBinding) // set true to use SCRAM-SHA-256-PLUS when offered
    this.scramMaxIterations = coerceNumberOrDefault(c.scramMaxIterations, sasl.DEFAULT_MAX_SCRAM_ITERATIONS)
    this.connection =
      c.connection ||
      new Connection({
        stream: c.stream,
        ssl: this.connectionParameters.ssl,
        sslNegotiation: this.connectionParameters.sslnegotiation,
        keepAlive: c.keepAlive || false,
        keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
        encoding: (this.connectionParameters.client_encoding || 'utf8') as BufferEncoding,
        maxMessageSize: c.maxMessageSize,
      })
    this._queryQueue = []
    this._sentQueryQueue = []
    this.pipeline = Boolean(c.pipeline)
    this.autoBatch = this.pipeline && Boolean(c.autoBatch)
    this._maxAutoPrepare = c.maxAutoPrepare ?? 0
    if (!Number.isSafeInteger(this._maxAutoPrepare) || this._maxAutoPrepare < 0) {
      throw new TypeError('maxAutoPrepare must be a non-negative safe integer')
    }
    if (this._maxAutoPrepare) {
      this._autoPreparedStatements = new Map()
      this._autoPreparedDescriptions = new Map()
      this._autoPreparePrefix = 'pg_auto_' + crypto.randomBytes(12).toString('hex') + '_'
    }
    this.binary = c.binary || defaults.binary
    this.processID = null
    this.secretKey = null
    this.ssl = this.connectionParameters.ssl || false
    this.sslNegotiation = this.connectionParameters.sslnegotiation || 'postgres'
    // As with Password, make SSL->Key (the private key) non-enumerable.
    // It won't show up in stack traces
    // or if the client is console.logged
    if (this.ssl && (this.ssl as SslOptions).key) {
      Object.defineProperty(this.ssl, 'key', {
        enumerable: false,
      })
    }

    this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0
  }

  get activeQuery() {
    activeQueryDeprecationNotice()
    return this._activeQuery
  }

  set activeQuery(val: ExecutableQuery | null | undefined) {
    activeQueryDeprecationNotice()
    this._activeQuery = val
  }

  _getActiveQuery() {
    return this._activeQuery
  }

  _errorAllQueries(err: PgError) {
    this.connection.setDataRowConsumer?.(undefined)
    if (this._pipelineDrainListener) {
      this.connection.stream.removeListener('drain', this._pipelineDrainListener)
      this._pipelineDrainListener = null
    }
    const enqueueError = (query: ExecutableQuery) => {
      process.nextTick(() => {
        query.handleError(err, this.connection)
      })
    }

    const activeQuery = this._getActiveQuery()
    if (activeQuery) {
      enqueueError(activeQuery)
      this._activeQuery = null
    }

    this._sentQueryQueue.forEach(enqueueError)
    this._sentQueryQueue.length = 0

    this._queryQueue.forEach(enqueueError)
    this._queryQueue.length = 0
  }

  _connect(callback: ConnectCallback) {
    const self = this
    const con = this.connection
    this._connectionCallback = callback

    if (this._connecting || this._connected) {
      const err = new Error('Client has already been connected. You cannot reuse a client.')
      process.nextTick(() => {
        callback(err)
      })
      return
    }
    this._connecting = true

    if (this._connectionTimeoutMillis > 0) {
      this.connectionTimeoutHandle = setTimeout(() => {
        con._ending = true
        con.stream.destroy(new Error('timeout expired'))
      }, this._connectionTimeoutMillis)

      if (this.connectionTimeoutHandle.unref) {
        this.connectionTimeoutHandle.unref()
      }
    }

    if (this.host && this.host.indexOf('/') === 0) {
      con.connect(this.host + '/.s.PGSQL.' + this.port)
    } else {
      con.connect(this.port, this.host)
    }

    // once connection is established send startup message
    con.on('connect', function () {
      if (self.ssl) {
        // With direct SSL negotiation the connection upgrades to TLS without an
        // SSLRequest packet, so the startup message is sent after 'sslconnect'.
        if (self.sslNegotiation !== 'direct') {
          con.requestSsl()
        }
      } else {
        con.startup(self.getStartupConf())
      }
    })

    con.on('sslconnect', function () {
      con.startup(self.getStartupConf())
    })

    this._attachListeners(con)

    con.once('end', () => {
      const error = this._ending ? new Error('Connection terminated') : new Error('Connection terminated unexpectedly')

      clearTimeout(this.connectionTimeoutHandle)
      this._errorAllQueries(error)
      this._ended = true

      if (!this._ending) {
        // if the connection is ended without us calling .end()
        // on this client then we have an unexpected disconnection
        // treat this as an error unless we've already emitted an error
        // during connection.
        if (this._connecting && !this._connectionError) {
          if (this._connectionCallback) {
            this._connectionCallback(error)
          } else {
            this._handleErrorEvent(error)
          }
        } else if (!this._connectionError) {
          this._handleErrorEvent(error)
        }
      }

      process.nextTick(() => {
        this.emit('end')
      })
    })
  }

  connect(): Promise<this>
  connect(callback: ConnectCallback): void
  connect(callback?: ConnectCallback): Promise<this> | void {
    if (callback) {
      this._connect(callback)
      return
    }

    return new this._Promise<this>((resolve, reject) => {
      this._connect((error) => {
        if (error) {
          reject(error)
        } else {
          resolve(this)
        }
      })
    })
  }

  _attachListeners(con: Connection) {
    // password request handling
    con.on('authenticationCleartextPassword', this._handleAuthCleartextPassword.bind(this))
    // password request handling
    con.on('authenticationMD5Password', this._handleAuthMD5Password.bind(this))
    // password request handling (SASL)
    con.on('authenticationSASL', this._handleAuthSASL.bind(this))
    con.on('authenticationSASLContinue', this._handleAuthSASLContinue.bind(this))
    con.on('authenticationSASLFinal', this._handleAuthSASLFinal.bind(this))
    con.on('backendKeyData', this._handleBackendKeyData.bind(this))
    con.on('error', this._handleErrorEvent.bind(this))
    con.on('errorMessage', this._handleErrorMessage.bind(this))
    con.on('readyForQuery', this._handleReadyForQuery.bind(this))
    con.on('notice', this._handleNotice.bind(this))
    con.on('rowDescription', this._handleRowDescription.bind(this))
    this._dataRowHandler = this._handleDataRow.bind(this)
    con.on('dataRow', this._dataRowHandler)
    con.on('portalSuspended', this._handlePortalSuspended.bind(this))
    con.on('emptyQuery', this._handleEmptyQuery.bind(this))
    con.on('commandComplete', this._handleCommandComplete.bind(this))
    con.on('parseComplete', this._handleParseComplete.bind(this))
    con.on('copyInResponse', this._handleCopyInResponse.bind(this))
    con.on('copyData', this._handleCopyData.bind(this))
    con.on('notification', this._handleNotification.bind(this))
  }

  _getPassword(cb: () => void) {
    const con = this.connection
    if (typeof this.password === 'function') {
      this._Promise
        .resolve()
        .then(() => (this.password as Exclude<Password, string | null>)(this.connectionParameters))
        .then((pass) => {
          if (pass !== undefined) {
            if (typeof pass !== 'string') {
              con.emit('error', new TypeError('Password must be a string'))
              return
            }
            this.connectionParameters.password = this.password = pass
          } else {
            this.connectionParameters.password = this.password = null
          }
          cb()
        })
        .catch((err) => {
          con.emit('error', err)
        })
    } else if (this.password !== null) {
      cb()
    } else {
      try {
        const pgPass = require('pgpass') as (
          config: ConnectionParameters,
          callback: (password?: string) => void
        ) => void
        pgPass(this.connectionParameters, (pass) => {
          if (undefined !== pass) {
            pgPassDeprecationNotice()
            this.connectionParameters.password = this.password = pass
          }
          cb()
        })
      } catch (e) {
        this.emit('error', e)
      }
    }
  }

  _handleAuthCleartextPassword(_msg: unknown) {
    this._getPassword(() => {
      this.connection.password(this.password as string)
    })
  }

  _handleAuthMD5Password(msg: AuthenticationMD5Password) {
    this._getPassword(async () => {
      try {
        const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password as string, msg.salt)
        this.connection.password(hashedPassword)
      } catch (e) {
        this.emit('error', e)
      }
    })
  }

  _handleAuthSASL(msg: { readonly mechanisms: readonly string[] }) {
    this._getPassword(() => {
      try {
        this.saslSession = sasl.startSession(
          msg.mechanisms,
          (this.enableChannelBinding && this.connection.stream) as sasl.SaslStream | undefined,
          this.scramMaxIterations
        )
        this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession!.response)
      } catch (err) {
        this.connection.emit('error', err)
      }
    })
  }

  async _handleAuthSASLContinue(msg: { readonly data: string }) {
    try {
      await sasl.continueSession(
        this.saslSession!,
        this.password,
        msg.data,
        (this.enableChannelBinding && this.connection.stream) as sasl.SaslStream | undefined
      )
      this.connection.sendSCRAMClientFinalMessage(this.saslSession!.response)
    } catch (err) {
      this.connection.emit('error', err)
    }
  }

  _handleAuthSASLFinal(msg: { readonly data: string }) {
    try {
      sasl.finalizeSession(this.saslSession!, msg.data)
      this.saslSession = null
    } catch (err) {
      this.connection.emit('error', err)
    }
  }

  _handleBackendKeyData(msg: BackendKeyDataMessage) {
    this.processID = msg.processID
    this.secretKey = msg.secretKey
  }

  _handleReadyForQuery(msg: ReadyForQueryMessage) {
    this.connection.setDataRowConsumer?.(undefined)
    this.connection.setDataRowMode?.('raw')
    if (this._connecting) {
      this._connecting = false
      this._connected = true
      clearTimeout(this.connectionTimeoutHandle)

      // process possible callback argument to Client#connect
      if (this._connectionCallback) {
        this._connectionCallback(null, this)
        // remove callback for proper error handling
        // after the connect event
        this._connectionCallback = null
      }
      this.emit('connect')
    }
    const activeQuery = this._getActiveQuery()
    this._activeQuery = null
    this._txStatus = (msg?.status ?? null) as 'I' | 'T' | 'E' | null
    this.readyForQuery = true
    if (activeQuery) {
      activeQuery.handleReadyForQuery(this.connection)
    }
    this._pulseQueryQueue()
  }

  // if we receive an error event or error message
  // during the connection process we handle it here
  _handleErrorWhileConnecting(err: PgError) {
    if (this._connectionError) {
      // TODO(bmc): this is swallowing errors - we shouldn't do this
      return
    }
    this._connectionError = true
    clearTimeout(this.connectionTimeoutHandle)
    if (this._connectionCallback) {
      return this._connectionCallback(err)
    }
    this.emit('error', err)
  }

  // if we're connected and we receive an error event from the connection
  // this means the socket is dead - do a hard abort of all queries and emit
  // the socket error on the client as well
  _handleErrorEvent(err: PgError) {
    this.connection.setDataRowConsumer?.(undefined)
    if (this._connecting) {
      return this._handleErrorWhileConnecting(err)
    }
    this._queryable = false
    this._errorAllQueries(err)
    this.emit('error', err)
  }

  // handle error messages from the postgres backend
  _handleErrorMessage(msg: PgError) {
    this.connection.setDataRowConsumer?.(undefined)
    if (this._connecting) {
      return this._handleErrorWhileConnecting(msg)
    }
    const activeQuery = this._getActiveQuery()

    if (!activeQuery) {
      this._handleErrorEvent(msg)
      return
    }

    this._activeQuery = null
    if (activeQuery.name) {
      delete this.connection.submittedNamedStatements[activeQuery.name]
    }
    activeQuery.handleError(msg, this.connection)
  }

  _handleRowDescription(msg: RowDescriptionMessage) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected rowDescription message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // delegate rowDescription to active query
    activeQuery.handleRowDescription(msg)
    const query = activeQuery as Query
    if (
      (query.constructor as Function) === Query &&
      query._result &&
      msg.fields.length > 0 &&
      msg.fields.length <= 32 &&
      msg.fields.every((field) => field.format === 'text') &&
      query.text &&
      query.name &&
      !query.types &&
      !query.portal &&
      this._autoPreparedStatements?.get(query.text) === query.name
    ) {
      const descriptions = this._autoPreparedDescriptions!
      if (!descriptions.has(query.name) && descriptions.size >= this._maxAutoPrepare) {
        descriptions.delete(descriptions.keys().next().value!)
      }
      const layouts: CachedDescription['layouts'] = {}
      layouts[query._result.rowAsArray ? 'array' : 'object'] = query._result._getRowLayout()
      descriptions.set(query.name, {
        message: this._copyRowDescription(msg),
        expiresAt: Date.now() + 300000,
        layouts,
      })
    }
    this._setResultMode(activeQuery)
  }

  private _setResultMode(query: ExecutableQuery) {
    const result = query.constructor === Query ? (query as Query)._result : null
    const connection = this.connection
    connection.setDataRowConsumer?.(
      connection.constructor === Connection &&
        this._handleDataRow === Client.prototype._handleDataRow &&
        result &&
        (query as Query)._canConsumeDataRows &&
        connection.listenerCount('message') === 0 &&
        connection.listenerCount('dataRow') === 1 &&
        connection.listeners('dataRow')[0] === this._dataRowHandler
        ? (query as Query)
        : undefined
    )
    this.connection.setDataRowMode?.(
      result &&
        result.fields.length > 0 &&
        !result.prefersRawInt4 &&
        !(query as Query)._canConsumeDataRows &&
        result.fields.every((field) => field.format === 'text')
        ? 'text'
        : 'raw'
    )
  }

  private _copyRowDescription(message: RowDescriptionMessage): RowDescriptionMessage {
    return {
      ...message,
      fields: message.fields.map(
        (field) =>
          new Field(
            field.name,
            field.tableID,
            field.columnID,
            field.dataTypeID,
            field.dataTypeSize,
            field.dataTypeModifier,
            field.format
          )
      ),
    }
  }

  _handleDataRow(msg: DataRowMessage | RawDataRowMessage) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected dataRow message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // delegate dataRow to active query
    activeQuery.handleDataRow(msg)
  }

  _handlePortalSuspended(_msg: unknown) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected portalSuspended message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // delegate portalSuspended to active query
    activeQuery.handlePortalSuspended(this.connection)
  }

  _handleEmptyQuery(_msg: unknown) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected emptyQuery message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // delegate emptyQuery to active query
    activeQuery.handleEmptyQuery(this.connection)
  }

  _handleCommandComplete(msg: CommandCompleteMessage) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected commandComplete message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // delegate commandComplete to active query
    activeQuery.handleCommandComplete(msg, this.connection)
  }

  _handleParseComplete() {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected parseComplete message from backend.')
      this._handleErrorEvent(error)
      return
    }
    // if a prepared statement has a name and properly parses
    // we track that its already been executed so we don't parse
    // it again on the same client
    if (activeQuery.name) {
      this.connection.parsedStatements[activeQuery.name] = activeQuery.text
      delete this.connection.submittedNamedStatements[activeQuery.name]
    }
  }

  _handleCopyInResponse(_msg: unknown) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected copyInResponse message from backend.')
      this._handleErrorEvent(error)
      return
    }
    activeQuery.handleCopyInResponse(this.connection)
  }

  _handleCopyData(msg: CopyDataMessage) {
    const activeQuery = this._getActiveQuery()
    if (activeQuery == null) {
      const error = new Error('Received unexpected copyData message from backend.')
      this._handleErrorEvent(error)
      return
    }
    activeQuery.handleCopyData(msg, this.connection)
  }

  _handleNotification(msg: Notification) {
    this.emit('notification', msg)
  }

  _handleNotice(msg: NoticeMessage) {
    this.emit('notice', msg)
  }

  getStartupConf() {
    const params = this.connectionParameters

    const data: Record<string, string> = {
      user: params.user,
      database: params.database,
    }

    const appName = params.application_name || params.fallback_application_name
    if (appName) {
      data.application_name = appName
    }
    if (params.replication) {
      data.replication = '' + params.replication
    }
    if (params.statement_timeout) {
      data.statement_timeout = String(parseInt(params.statement_timeout as unknown as string, 10))
    }
    if (params.lock_timeout) {
      data.lock_timeout = String(parseInt(params.lock_timeout as unknown as string, 10))
    }
    if (params.idle_in_transaction_session_timeout) {
      data.idle_in_transaction_session_timeout = String(
        parseInt(params.idle_in_transaction_session_timeout as unknown as string, 10)
      )
    }
    if (params.options) {
      data.options = params.options
    }

    return data
  }

  cancel(client: Client, query: ExecutableQuery) {
    if (client.activeQuery === query) {
      const con = this.connection

      if (this.host && this.host.indexOf('/') === 0) {
        con.connect(this.host + '/.s.PGSQL.' + this.port)
      } else {
        con.connect(this.port, this.host)
      }

      // once connection is established send cancel message
      con.on('connect', function () {
        con.cancel(client.processID!, client.secretKey!)
      })
    } else if (client._queryQueue.indexOf(query) !== -1) {
      client._queryQueue.splice(client._queryQueue.indexOf(query), 1)
    } else if (client._sentQueryQueue.indexOf(query) !== -1) {
      // Query already sent on wire — can't remove it without corrupting the
      // pipeline. No-op the callback so the result is silently discarded.
      query.callback = () => {}
    }
  }

  setTypeParser(oid: number, parseFn: TextParser): void
  setTypeParser(oid: number, format: 'text', parseFn: TextParser): void
  setTypeParser(oid: number, format: 'binary', parseFn: BinaryParser): void
  setTypeParser(oid: number, format: TypeFormat | TextParser, parseFn?: TextParser | BinaryParser): void {
    return this._types.setTypeParser(oid, format, parseFn)
  }

  getTypeParser(oid: number, format?: 'text'): TextParser
  getTypeParser(oid: number, format: 'binary'): BinaryParser
  getTypeParser(oid: number, format?: TypeFormat): TextParser | BinaryParser {
    return this._types.getTypeParser(oid, format)
  }

  // escapeIdentifier and escapeLiteral moved to utility functions & exported
  // on PG
  // re-exported here for backwards compatibility
  escapeIdentifier(str: string) {
    return utils.escapeIdentifier(str)
  }

  escapeLiteral(str: string) {
    return utils.escapeLiteral(str)
  }

  _pulseQueryQueue() {
    if (
      this.autoBatch &&
      this.readyForQuery &&
      this._txStatus === 'T' &&
      this._sentQueryQueue.length === 0 &&
      this._queryQueue[0]?._autoBatch
    ) {
      if (!this._batchScheduled) {
        this._batchScheduled = true
        process.nextTick(() => {
          this._batchScheduled = false
          let count = 0
          while (this._queryQueue[count]?._autoBatch) count++
          if (count > 1) {
            const queries = this._queryQueue.splice(0, count)
            this._queryQueue.unshift(Batch.fromQueries(queries as Query[]))
          }
          this._pulsePipelinedQueryQueue()
        })
      }
      return
    }
    if (this.pipeline) {
      this._pulsePipelinedQueryQueue()
      return
    }
    if (this.readyForQuery === true) {
      this._activeQuery = this._queryQueue.shift()
      const activeQuery = this._getActiveQuery()
      if (activeQuery) {
        this.readyForQuery = false
        this.hasExecuted = true

        const queryError = activeQuery.submit(this.connection)
        if (queryError) {
          process.nextTick(() => {
            activeQuery.handleError(queryError, this.connection)
            this.readyForQuery = true
            this._pulseQueryQueue()
          })
        } else {
          this._setResultMode(activeQuery)
        }
      } else if (this.hasExecuted) {
        this._activeQuery = null
        this.emit('drain')
      }
    }
  }

  _pulsePipelinedQueryQueue() {
    if (!this._connected || !this._queryable) {
      return
    }
    // A batch may be waiting for socket drain before writing its final Sync.
    // Keep later queries behind that boundary.
    if (this._activeQuery instanceof Batch) return
    const stream = this.connection.stream
    if (
      this._queryQueue.length &&
      !this._pipelineDrainListener &&
      !this._pipelineWritePending &&
      typeof stream.cork === 'function' &&
      typeof stream.uncork === 'function'
    ) {
      // One socket write can carry several queries while each keeps its own Sync boundary.
      stream.cork()
      const flush = () => {
        if (this._pipelineWritePending !== flush) return
        this._pipelineWritePending = null
        stream.uncork()
      }
      this._pipelineWritePending = flush
      process.nextTick(flush)
    }
    while (!this._pipelineDrainListener && this._queryQueue.length > 0) {
      const query = this._queryQueue.shift()!
      this.hasExecuted = true
      const queryError = query.submit(this.connection)
      if (queryError) {
        process.nextTick(() => {
          query.handleError(queryError, this.connection)
        })
        continue
      }
      this._sentQueryQueue.push(query)
      // A full buffer should start draining immediately rather than wait for the batching tick.
      if (stream.writableNeedDrain && this._pipelineWritePending) this._pipelineWritePending()
      if (query instanceof Batch) break
      if (this.connection.stream.writableNeedDrain) {
        this._pipelineDrainListener = () => {
          this._pipelineDrainListener = null
          this._pulseQueryQueue()
        }
        this.connection.stream.once('drain', this._pipelineDrainListener)
      }
    }
    if (this.readyForQuery && !this._activeQuery && this._sentQueryQueue.length > 0) {
      this._activeQuery = this._sentQueryQueue.shift()
      this.readyForQuery = false
      this._setResultMode(this._activeQuery!)
    }
    if (!this._activeQuery && this._sentQueryQueue.length === 0 && this._queryQueue.length === 0 && this.hasExecuted) {
      this.emit('drain')
    }
  }

  batch<R extends object = QueryResultRow>(configs: readonly (string | QueryConfig)[]): Promise<Result<R>[]>
  batch<R extends object = QueryResultRow>(configs: readonly (string | QueryConfig)[], callback: BatchCallback<R>): void
  batch(configs: readonly (string | QueryConfig)[], callback?: unknown): Promise<unknown> | void {
    let result: Promise<Result[]> | undefined
    if (callback === undefined) {
      result = new this._Promise<Result[]>((resolve, reject) => {
        callback = (err: PgError | null, results?: Result[]) => (err ? reject(err) : resolve(results!))
      })
    } else if (typeof callback !== 'function') {
      throw new TypeError('callback is not a function')
    }
    let batch
    try {
      if (!Array.isArray(configs) || configs.length === 0) {
        throw new TypeError('A batch must be a non-empty array of queries')
      }
      if (!this.readyForQuery || this._txStatus !== 'T' || this._queryQueue.length || this._sentQueryQueue.length) {
        throw new Error('A batch requires an idle client inside an explicit transaction')
      }
      batch = new Batch(configs, this._types, this.binary, callback as BatchCallback)
    } catch (err) {
      process.nextTick(() => (callback as BatchCallback)(err as PgError))
      return result
    }
    this.query(batch)
    return result
  }

  query<T extends Submittable>(config: T): T
  query<T extends Submittable>(config: T, callback: QueryCallback): T
  query<T extends Submittable>(config: T, values: readonly unknown[] | undefined, callback?: QueryCallback): T
  query<R extends unknown[] = unknown[]>(
    config: QueryArrayConfig,
    values?: readonly unknown[]
  ): Promise<QueryArrayResult<R>>
  query<R extends unknown[] = unknown[]>(config: QueryArrayConfig, callback: ClientQueryCallback<R>): void
  query<R extends unknown[] = unknown[]>(
    config: QueryArrayConfig,
    values: readonly unknown[] | undefined,
    callback: ClientQueryCallback<R>
  ): void
  query<R extends object = QueryResultRow>(
    config: string | QueryConfig,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>>
  query<R extends object = QueryResultRow>(config: string | QueryConfig, callback: ClientQueryCallback<R>): void
  query<R extends object = QueryResultRow>(
    config: string | QueryConfig,
    values: readonly unknown[] | undefined,
    callback: ClientQueryCallback<R>
  ): void
  query(config: QueryInput, values?: unknown, callback?: unknown): Promise<unknown> | Submittable | undefined {
    // can take in strings, config object or query object
    let query: ExecutableQuery
    let result: Promise<QueryResults> | Submittable | undefined

    if (config == null) {
      throw new TypeError('Client was passed a null or undefined query')
    }

    if (typeof (config as Partial<Submittable>).submit === 'function') {
      result = query = config as ExecutableQuery
      if (!query.callback) {
        if (typeof values === 'function') {
          query.callback = values as QueryCallback
        } else if (callback) {
          query.callback = callback as QueryCallback
        }
      }
    } else {
      query = new Query(
        config as string | QueryConfig,
        values as readonly unknown[] | QueryCallback,
        callback as QueryCallback
      )
      if (
        this._maxAutoPrepare &&
        !query.name &&
        !query.rows &&
        !query.portal &&
        !query.types &&
        Array.isArray(query.values) &&
        (query.values.length > 0 || query.queryMode === 'extended') &&
        typeof query.text === 'string' &&
        /^\s*(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)\b/i.test(query.text)
      ) {
        let name = this._autoPreparedStatements!.get(query.text)
        if (!name && this._autoPreparedStatements!.size < this._maxAutoPrepare) {
          name = this._autoPreparePrefix! + this._autoPreparedStatements!.size
          // ponytail: retain the first N SQL texts; eviction needs ordered Close handling in pipelines.
          this._autoPreparedStatements!.set(query.text, name)
        }
        query.name = name
        if (name && !query.binary && !this.binary) {
          const cached = this._autoPreparedDescriptions!.get(name)
          if (cached && cached.expiresAt > Date.now()) {
            ;(query as Query)._cachedRowDescription = this._copyRowDescription(cached.message)
            ;(query as Query)._cachedRowLayouts = cached.layouts
          } else if (cached) {
            this._autoPreparedDescriptions!.delete(name)
          }
        }
      }
      if (!query.callback) {
        result = new this._Promise<QueryResults>((resolve, reject) => {
          query.callback = (err, res) => (err ? reject(err) : resolve(res!))
        }).catch((err) => {
          // replace the stack trace that leads to `TCP.onStreamRead` with one that leads back to the
          // application that created the query
          try {
            Error.captureStackTrace(err)
          } catch {
            // Optional stack rewriting must preserve the original error.
          }
          throw err
        })
      } else if (typeof query.callback !== 'function') {
        throw new TypeError('callback is not a function')
      }
    }

    const readTimeout = (config as QueryConfig).query_timeout || this.connectionParameters.query_timeout
    if (readTimeout) {
      const queryCallback = query.callback || (() => {})

      const readTimeoutTimer = setTimeout(() => {
        const error = new Error('Query read timeout')

        process.nextTick(() => {
          query.handleError(error, this.connection)
        })

        queryCallback(error)

        // we already returned an error,
        // just do nothing if query completes
        query.callback = () => {}

        // Remove from queue (only safe if not yet sent)
        const index = this._queryQueue.indexOf(query)
        if (index > -1) {
          this._queryQueue.splice(index, 1)
        } else if (this.pipeline) {
          // Query already sent — the pipeline is blocked until it completes.
          // Destroy the connection to unblock all remaining pipelined queries.
          this.connection.stream.destroy()
          return
        }

        this._pulseQueryQueue()
      }, readTimeout)

      query.callback = (err, res) => {
        clearTimeout(readTimeoutTimer)
        queryCallback(err, res)
      }
    }

    if (this.binary && !query.binary) {
      query.binary = true
    }

    if (query._result && !query._result._types) {
      query._result._types = this._types
    }

    // Keep transaction control, simple multi-statement SQL and custom query
    // classes on their existing paths. Timed queries retain their own boundary.
    if (
      this.autoBatch &&
      !readTimeout &&
      typeof (config as Partial<Submittable>).submit !== 'function' &&
      !query.rows &&
      !query.portal &&
      typeof query.text === 'string' &&
      (!query.values || Array.isArray(query.values)) &&
      query.requiresPreparation() &&
      /^\s*(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)\b/i.test(query.text)
    ) {
      query._autoBatch = true
    }

    // A query that keeps a portal open across round trips cannot share a pipelined connection: the
    // queries written behind it are answered out of its portal, so rows land on the wrong query and
    // the reads that follow fail with 'portal does not exist'. Refuse it instead of corrupting.
    if (this.pipeline) {
      const portalQuery =
        typeof (config as Partial<Submittable>).submit === 'function' && !(query instanceof Query)
          ? 'Custom query classes such as pg-cursor and pg-query-stream are'
          : query.rows
          ? 'The `rows` option is'
          : null
      if (portalQuery) {
        process.nextTick(() => {
          query.handleError(new Error(`${portalQuery} not supported in pipeline mode`), this.connection)
        })
        return result
      }
    }

    if (!this._queryable) {
      process.nextTick(() => {
        query.handleError(new Error('Client has encountered a connection error and is not queryable'), this.connection)
      })
      return result
    }

    if (this._ending) {
      process.nextTick(() => {
        query.handleError(new Error('Client was closed and is not queryable'), this.connection)
      })
      return result
    }

    if (this._queryQueue.length > 0 && !this.pipeline) {
      queryQueueLengthDeprecationNotice()
    }
    this._queryQueue.push(query)
    this._pulseQueryQueue()
    return result
  }

  ref() {
    this.connection.ref()
  }

  unref() {
    this.connection.unref()
  }

  getTransactionStatus() {
    return this._txStatus
  }

  end(): Promise<void>
  end(cb: EndCallback): void
  end(cb?: EndCallback): Promise<void> | void {
    this._ending = true

    // if we have never connected, then end is a noop, callback immediately
    if (!this.connection._connecting || this._ended) {
      if (cb) {
        cb()
        return
      } else {
        return this._Promise.resolve()
      }
    }

    if (!this._queryable) {
      // socket is dead — force close
      this.connection.stream.destroy()
    } else if (
      this.pipeline &&
      (this._getActiveQuery() || this._sentQueryQueue.length > 0 || this._queryQueue.length > 0)
    ) {
      // pipelined queries are already on the wire (or queued to send) and will
      // complete normally; wait for drain then do a graceful goodbye
      this.once('drain', () => this.connection.end())
    } else if (this._getActiveQuery()) {
      // non-pipeline: a hung query could block end forever — force disconnect
      this.connection.stream.destroy()
    } else {
      this.connection.end()
    }

    if (cb) {
      this.connection.once('end', cb)
    } else {
      return new this._Promise<void>((resolve) => {
        this.connection.once('end', resolve)
      })
    }
  }
  get queryQueue() {
    queryQueueDeprecationNotice()
    return this._queryQueue
  }
}

// expose a Query constructor
Client.Query = Query

export = Client
