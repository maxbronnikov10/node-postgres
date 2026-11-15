import nodeUtils = require('util')
import type {
  NativeBinding,
  NativeBindingConstructor,
  NativeClientConfig,
  NativeEndCallback,
  NativePipelineEntry,
  NativeQueryCallback,
  NativeQueryConfig,
  NativeResults,
} from './binding'
import type { PgError, QueryResultRow, TextParser, BinaryParser, TypeFormat } from '../types'

let Native: NativeBindingConstructor
// eslint-disable-next-line no-useless-catch
try {
  // Wrap this `require()` in a try-catch to avoid upstream bundlers from complaining that this might not be available since it is an optional import
  Native = require('pg-native') as NativeBindingConstructor
} catch (e) {
  throw e
}

import TypeOverrides = require('../type-overrides')
import { EventEmitter } from 'events'
import util = require('util')
import ConnectionParameters = require('../connection-parameters')
import NativeQuery = require('./query')

const queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
  () => {},
  'Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.'
)

interface Client extends EventEmitter {
  _Promise: PromiseConstructor
  _types: TypeOverrides
  native: NativeBinding
  _queryQueue: NativeQuery[]
  _activeQuery?: NativeQuery | null
  _ending: boolean
  _connecting: boolean
  _connected: boolean
  _queryable: boolean
  pipeline: boolean
  _pipelineInFlight: boolean
  hasExecuted?: boolean
  connection?: unknown
  connectionParameters: ConnectionParameters & { nativeConnectionString?: string }
  user: string
  password: import('../types').Password
  database: string
  host: string
  port: number
  namedQueries: Record<string, string | undefined>
  _errorAllQueries(error: PgError): void
  _connect(callback: (error?: Error | null, client?: unknown) => void): void
  connect(): Promise<Client>
  connect(callback: NativeEndCallback): void
  query<T extends { submit(client: Client): unknown }>(query: T, callback?: NativeQueryCallback): T
  query<R extends readonly unknown[] = unknown[]>(
    config: NativeQueryConfig<R> & { rowMode: 'array' },
    values?: readonly unknown[]
  ): Promise<NativeResults<R> | null>
  query<R extends object = QueryResultRow>(
    config: string | NativeQueryConfig<R>,
    values?: readonly unknown[]
  ): Promise<NativeResults<R> | null>
  query<R extends object = QueryResultRow>(
    config: string | NativeQueryConfig<R>,
    callback: NativeQueryCallback<R>
  ): void
  query<R extends object = QueryResultRow>(
    config: string | NativeQueryConfig<R>,
    values: readonly unknown[] | undefined,
    callback: NativeQueryCallback<R>
  ): void
  end(): Promise<void>
  end(callback: NativeEndCallback): void
  _hasActiveQuery(): boolean | null | undefined
  _pulseQueryQueue(initialConnection?: boolean): void
  _pulsePipelinedQueryQueue(): void
  cancel(query: NativeQuery): void
  ref(): void
  unref(): void
  setTypeParser(oid: number, parseFn: TextParser): void
  setTypeParser(oid: number, format: 'text', parseFn: TextParser): void
  setTypeParser(oid: number, format: 'binary', parseFn: BinaryParser): void
  setTypeParser(oid: number, format: TypeFormat, parseFn: TextParser | BinaryParser): void
  getTypeParser: TypeOverrides['getTypeParser']
  isConnected(): boolean
  getTransactionStatus(): 'I' | 'T' | 'E' | null
}

interface ClientConstructor {
  new (config?: NativeClientConfig | string): Client
  (this: Client, config?: NativeClientConfig | string): void
  prototype: Client
  Query: typeof NativeQuery
}

// eslint-disable-next-line @typescript-eslint/no-redeclare -- The callable constructor shares its instance type name.
const Client = (module.exports = function (this: Client, config?: NativeClientConfig | string) {
  EventEmitter.call(this)
  config = config || {}

  this._Promise = (config as NativeClientConfig).Promise || global.Promise
  this._types = new TypeOverrides((config as NativeClientConfig).types)

  this.native = new Native({
    types: this._types,
  })

  this._queryQueue = []
  this._ending = false
  this._connecting = false
  this._connected = false
  this._queryable = true
  this.pipeline = Boolean((config as NativeClientConfig).pipeline)
  this._pipelineInFlight = false

  // keep these on the object for legacy reasons
  // for the time being. TODO: deprecate all this jazz
  const cp = (this.connectionParameters = new ConnectionParameters(config))
  if ((config as NativeClientConfig).nativeConnectionString)
    cp.nativeConnectionString = (config as NativeClientConfig).nativeConnectionString
  this.user = cp.user

  // "hiding" the password so it doesn't show up in stack traces
  // or if the client is console.logged
  Object.defineProperty(this, 'password', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: cp.password,
  })
  this.database = cp.database
  this.host = cp.host
  this.port = cp.port

  // a hash to hold named queries
  this.namedQueries = {}
}) as ClientConstructor

Client.Query = NativeQuery

util.inherits(Client, EventEmitter)

Client.prototype._errorAllQueries = function (this: Client, err: PgError) {
  const enqueueError = (query: NativeQuery) => {
    process.nextTick(() => {
      query.native = this.native
      query.handleError(err)
    })
  }

  if (this._hasActiveQuery()) {
    enqueueError(this._activeQuery!)
    this._activeQuery = null
  }

  this._queryQueue.forEach(enqueueError)
  this._queryQueue.length = 0
}

// connect to the backend
// pass an optional callback to be called once connected
// or with an error if there was a connection error
Client.prototype._connect = function (this: Client, cb) {
  const self = this

  if (this._connecting) {
    process.nextTick(() => cb(new Error('Client has already been connected. You cannot reuse a client.')))
    return
  }

  this._connecting = true

  this.connectionParameters.getLibpqConnectionString(function (err: Error | null, conString: string | null) {
    if (self.connectionParameters.nativeConnectionString) conString = self.connectionParameters.nativeConnectionString
    if (err) return cb(err)
    self.native.connect(conString!, function (this: unknown, err) {
      if (err) {
        self.native.end()
        return cb(err)
      }

      // set internal states to connected
      self._connected = true

      // handle connection errors from the native layer
      self.native.on('error', function (err: PgError) {
        self._queryable = false
        self._errorAllQueries(err)
        self.emit('error', err)
      })

      self.native.on('notification', function (msg: { relname: string; extra?: string }) {
        self.emit('notification', {
          channel: msg.relname,
          payload: msg.extra,
        })
      })

      // signal we are connected now
      self.emit('connect')
      self._pulseQueryQueue(true)

      cb(null, this)
    })
  })
}

Client.prototype.connect = function (this: Client, callback?: NativeEndCallback) {
  if (callback) {
    this._connect(callback)
    return
  }

  return new this._Promise<Client>((resolve, reject) => {
    this._connect((error) => {
      if (error) {
        reject(error)
      } else {
        resolve(this)
      }
    })
  })
} as Client['connect']

// send a query to the server
// this method is highly overloaded to take
// 1) string query, optional array of parameters, optional function callback
// 2) object query with {
//    string query
//    optional array values,
//    optional function callback instead of as a separate parameter
//    optional string name to name & cache the query plan
//    optional string rowMode = 'array' for an array of results
//  }
Client.prototype.query = function (
  this: Client,
  config: string | NativeQueryConfig | NativeQuery,
  values?: readonly unknown[] | NativeQueryCallback,
  callback?: NativeQueryCallback
) {
  let query: NativeQuery
  let result: NativeQuery | Promise<NativeResults | null | undefined> | undefined
  let readTimeout: number | false | undefined
  let readTimeoutTimer: NodeJS.Timeout | undefined
  let queryCallback: NativeQueryCallback

  if (config === null || config === undefined) {
    throw new TypeError('Client was passed a null or undefined query')
  } else if (typeof (config as NativeQuery).submit === 'function') {
    readTimeout = (config as NativeQueryConfig).query_timeout || this.connectionParameters.query_timeout
    result = query = config as NativeQuery
    // accept query(new Query(...), (err, res) => { }) style
    if (typeof values === 'function') {
      ;(config as NativeQuery).callback = values
    }
  } else {
    readTimeout = (config as NativeQueryConfig).query_timeout || this.connectionParameters.query_timeout
    query = new NativeQuery(config as string | NativeQueryConfig, values, callback)
    if (!query.callback) {
      let resolveOut!: (value: NativeResults | null | undefined) => void
      let rejectOut!: (error: unknown) => void
      result = new this._Promise<NativeResults | null | undefined>((resolve, reject) => {
        resolveOut = resolve
        rejectOut = reject
      }).catch((err) => {
        try {
          Error.captureStackTrace(err)
        } catch {
          // Optional stack rewriting must preserve the original error.
        }
        throw err
      })
      query.callback = (err, res) => (err ? rejectOut(err) : resolveOut(res))
    }
  }

  if (readTimeout) {
    queryCallback = query.callback || (() => {})

    readTimeoutTimer = setTimeout(() => {
      const error = new Error('Query read timeout')

      process.nextTick(() => {
        query.handleError(error, this.connection)
      })

      queryCallback(error)

      // we already returned an error,
      // just do nothing if query completes
      query.callback = () => {}

      // Remove from queue
      const index = this._queryQueue.indexOf(query)
      if (index > -1) {
        this._queryQueue.splice(index, 1)
      }

      this._pulseQueryQueue()
    }, readTimeout)

    query.callback = (err, res) => {
      clearTimeout(readTimeoutTimer)
      queryCallback(err, res)
    }
  }

  if (!this._queryable) {
    query.native = this.native
    process.nextTick(() => {
      query.handleError(new Error('Client has encountered a connection error and is not queryable'))
    })
    return result
  }

  if (this._ending) {
    query.native = this.native
    process.nextTick(() => {
      query.handleError(new Error('Client was closed and is not queryable'))
    })
    return result
  }

  if (this._queryQueue.length > 0 && !this.pipeline) {
    queryQueueLengthDeprecationNotice()
  }

  this._queryQueue.push(query)
  this._pulseQueryQueue()
  return result
} as Client['query']

// disconnect from the backend server
Client.prototype.end = function (this: Client, cb?: NativeEndCallback) {
  const self = this

  this._ending = true

  if (this._connecting && !this._connected) {
    this.once('connect', () => {
      this.end(() => {})
    })
  }
  let result: Promise<void> | undefined
  if (!cb) {
    result = new this._Promise<void>(function (resolve, reject) {
      cb = (err) => (err ? reject(err) : resolve())
    })
  }

  const doEnd = function () {
    self.native.end(function () {
      self._connected = false

      self._errorAllQueries(new Error('Connection terminated'))

      process.nextTick(() => {
        self.emit('end')
        if (cb) cb()
      })
    })
  }

  // If pipeline has in-flight or queued queries, wait for them to drain before closing
  if (this.pipeline && (this._pipelineInFlight || this._queryQueue.length > 0)) {
    this.once('drain', doEnd)
  } else {
    doEnd()
  }
  return result
} as Client['end']

Client.prototype._hasActiveQuery = function (this: Client) {
  return this._activeQuery && this._activeQuery.state !== 'error' && this._activeQuery.state !== 'end'
}

Client.prototype._pulseQueryQueue = function (this: Client, initialConnection) {
  if (!this._connected) {
    return
  }
  if (this.pipeline && !initialConnection) {
    return this._pulsePipelinedQueryQueue()
  }
  if (this._hasActiveQuery()) {
    return
  }
  const query = this._queryQueue.shift()
  if (!query) {
    if (!initialConnection) {
      this.emit('drain')
    }
    return
  }
  this._activeQuery = query
  query.submit(this)
  const self = this
  query.once('_done', function () {
    self._pulseQueryQueue()
  })
}

Client.prototype._pulsePipelinedQueryQueue = function (this: Client) {
  if (!this._connected || this._pipelineInFlight) {
    return
  }
  if (this._queryQueue.length === 0) {
    if (this.hasExecuted) {
      this.emit('drain')
    }
    return
  }

  this._pipelineInFlight = true
  const self = this
  const queries: NativePipelineEntry[] = []
  const nativeQueries: NativeQuery[] = []
  const utils = require('../utils') as typeof import('../utils')

  while (this._queryQueue.length > 0) {
    const query = this._queryQueue.shift()!
    this.hasExecuted = true
    nativeQueries.push(query)

    const values = query.values ? query.values.map(utils.prepareValue) : null
    const pipelineEntry: NativePipelineEntry = { text: query.text, name: query.name, arrayMode: query._arrayMode }
    if (values) {
      pipelineEntry.values = values
    }
    if (query.name && this.namedQueries[query.name]) {
      pipelineEntry._alreadyPrepared = true
    }
    queries.push(pipelineEntry)
  }

  this.native.pipeline(queries, function (err, results) {
    self._pipelineInFlight = false

    if (err) {
      // Total pipeline failure. Per-query errors arrive on results[i].err, so reaching here means
      // the connection itself is gone: mark it unusable and say so, the way the JS client and the
      // non-pipelined native path both do. Without this the client looks healthy after losing its
      // backend, a Pool never discards it, and everything routed to it fails one query at a time
      // for the life of the process.
      self._connected = false
      self._queryable = false
      for (let i = 0; i < nativeQueries.length; i++) {
        const q = nativeQueries[i]
        q.native = self.native
        q.handleError(err)
      }
      self._errorAllQueries(err)
      self.emit('error', err)
      self.emit('end')
      return
    }

    // Deliver results to each query
    for (let i = 0; i < nativeQueries.length; i++) {
      const q = nativeQueries[i]
      const r = results[i]
      q.native = self.native

      if (r.err) {
        q.handleError(r.err)
      } else {
        // Track named queries on success
        if (q.name) {
          self.namedQueries[q.name] = q.text
        }
        q.state = 'end'
        q.emit('end', r.result)
        if (q.callback) {
          q.callback(null, r.result)
        }
      }

      setImmediate(function () {
        q.emit('_done')
      })
    }

    // Process any queries that arrived while we were reading
    self._pulsePipelinedQueryQueue()
  })
}

// attempt to cancel an in-progress query
Client.prototype.cancel = function (this: Client, query) {
  if (this._activeQuery === query) {
    this.native.cancel(function () {})
  } else if (this._queryQueue.indexOf(query) !== -1) {
    this._queryQueue.splice(this._queryQueue.indexOf(query), 1)
  }
}

Client.prototype.ref = function (this: Client) {}
Client.prototype.unref = function (this: Client) {}

Client.prototype.setTypeParser = function (
  this: Client,
  oid: number,
  format: TypeFormat | TextParser,
  parseFn?: TextParser | BinaryParser
) {
  return this._types.setTypeParser(oid, format, parseFn)
} as Client['setTypeParser']

Client.prototype.getTypeParser = function (this: Client, oid: number, format?: TypeFormat) {
  return this._types.getTypeParser(oid, format)
} as Client['getTypeParser']

Client.prototype.isConnected = function (this: Client) {
  return this._connected
}

Client.prototype.getTransactionStatus = function (this: Client) {
  return this.native.getTransactionStatus()
}

export = Client
