import { EventEmitter } from 'events'
import type { ConnectionOptions } from 'tls'
import type { Duplex } from 'stream'

const NOOP = function () {}

const removeWhere = <T>(list: T[], predicate: (item: T) => boolean): T | undefined => {
  const i = list.findIndex(predicate)

  return i === -1 ? undefined : list.splice(i, 1)[0]
}

type Callback<T> = (err?: Error | null, value?: T, release?: Pool.Release) => void

type IdleListener<C extends Pool.Client> = (err: Error & { client?: C }) => void

type NormalizedPoolConfig<C extends Pool.Client> = Pool.PoolConfig<C> &
  Required<Pick<Pool.PoolConfig<C>, 'max' | 'min' | 'maxUses' | 'allowExitOnIdle' | 'maxLifetimeSeconds'>>

class IdleItem<C extends Pool.Client> {
  client: Pool.PoolClient<C>
  idleListener: IdleListener<C>
  timeoutId: NodeJS.Timeout | undefined

  constructor(client: Pool.PoolClient<C>, idleListener: IdleListener<C>, timeoutId: NodeJS.Timeout | undefined) {
    this.client = client
    this.idleListener = idleListener
    this.timeoutId = timeoutId
  }
}

class PendingItem<C extends Pool.Client> {
  callback: Callback<Pool.PoolClient<C>>
  _prev: PendingItem<C> | undefined
  _next: PendingItem<C> | undefined
  _queued: boolean
  timedOut?: boolean

  constructor(callback: Callback<Pool.PoolClient<C>>) {
    this.callback = callback
    this._prev = undefined
    this._next = undefined
    this._queued = false
  }
}

function throwOnDoubleRelease() {
  throw new Error('Release called on client which has already been released to the pool.')
}

function promisify<T>(Promise: Pool.PromiseConstructor, callback?: Callback<T>) {
  if (callback) {
    return { callback: callback, result: undefined }
  }
  let rej!: (err: Error) => void
  let res!: (value: T | PromiseLike<T>) => void
  const cb: Callback<T> = function (err, client) {
    err ? rej(err) : res(client as T)
  }
  const result = new Promise<T>(function (resolve, reject) {
    res = resolve
    rej = reject
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
  return { callback: cb, result: result }
}

function makeIdleListener<C extends Pool.Client>(pool: Pool<C>, client: Pool.PoolClient<C>): IdleListener<C> {
  return function idleListener(err) {
    err.client = client

    client.removeListener('error', idleListener)
    client.on('error', () => {
      pool.log('additional client error after disconnection due to error', err)
    })
    pool._remove(client)
    // TODO - document that once the pool emits an error
    // the client has already been closed & purged and is unusable
    pool.emit('error', err, client)
  }
}

class Pool<C extends Pool.Client = Pool.Client> extends EventEmitter {
  options: NormalizedPoolConfig<C>
  log: (...messages: unknown[]) => void
  Client: Pool.ClientConstructor<C>
  Promise: Pool.PromiseConstructor
  _clients: Pool.PoolClient<C>[]
  _idle: IdleItem<C>[]
  _expired: WeakSet<C>
  _pendingQueueHead: PendingItem<C> | undefined
  _pendingQueueTail: PendingItem<C> | undefined
  _pendingQueueCount: number
  _endCallback: Pool.EndCallback | undefined
  ending: boolean
  ended: boolean

  constructor(options?: Pool.PoolConfig<C>, Client?: Pool.ClientConstructor<C>) {
    super()
    this.options = Object.assign({}, options) as NormalizedPoolConfig<C>

    if (options != null && 'password' in options) {
      // "hiding" the password so it doesn't show up in stack traces
      // or if the client is console.logged
      Object.defineProperty(this.options, 'password', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: options.password,
      })
    }
    if (options != null && options.ssl && (options.ssl as ConnectionOptions).key) {
      // "hiding" the ssl->key so it doesn't show up in stack traces
      // or if the client is console.logged
      Object.defineProperty(this.options.ssl, 'key', {
        enumerable: false,
      })
    }

    this.options.max = this.options.max || this.options.poolSize || 10
    this.options.min = this.options.min || 0
    this.options.maxUses = this.options.maxUses || Infinity
    this.options.allowExitOnIdle = this.options.allowExitOnIdle || false
    this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0
    this.log = this.options.log || function () {}
    this.Client = this.options.Client || Client || (require('pg') as { Client: Pool.ClientConstructor<C> }).Client
    this.Promise = this.options.Promise || global.Promise

    if (typeof this.options.idleTimeoutMillis === 'undefined') {
      this.options.idleTimeoutMillis = 10000
    }

    this._clients = []
    this._idle = []
    this._expired = new WeakSet()
    this._pendingQueueHead = undefined
    this._pendingQueueTail = undefined
    this._pendingQueueCount = 0
    this._endCallback = undefined
    this.ending = false
    this.ended = false
  }

  _promiseTry<T>(f: () => T | PromiseLike<T>): Promise<T> {
    const Promise = this.Promise
    if (typeof Promise.try === 'function') {
      return Promise.try(f)
    }
    return new Promise<T>((resolve) => resolve(f()))
  }

  _isFull() {
    return this._clients.length >= this.options.max
  }

  _isAboveMin() {
    return this._clients.length > this.options.min
  }

  _enqueuePending(pendingItem: PendingItem<C>) {
    pendingItem._prev = this._pendingQueueTail
    pendingItem._next = undefined
    pendingItem._queued = true

    if (this._pendingQueueTail) {
      this._pendingQueueTail._next = pendingItem
    } else {
      this._pendingQueueHead = pendingItem
    }

    this._pendingQueueTail = pendingItem
    this._pendingQueueCount++
  }

  _removePending(pendingItem: PendingItem<C>) {
    if (!pendingItem._queued) {
      return
    }

    if (pendingItem._prev) {
      pendingItem._prev._next = pendingItem._next
    } else {
      this._pendingQueueHead = pendingItem._next
    }

    if (pendingItem._next) {
      pendingItem._next._prev = pendingItem._prev
    } else {
      this._pendingQueueTail = pendingItem._prev
    }

    pendingItem._prev = undefined
    pendingItem._next = undefined
    pendingItem._queued = false
    this._pendingQueueCount--
  }

  _pulseQueue() {
    this.log('pulse queue')
    if (this.ended) {
      this.log('pulse queue ended')
      return
    }
    if (this.ending) {
      this.log('pulse queue on ending')
      if (this._idle.length) {
        this._idle.slice().map((item) => {
          this._remove(item.client)
        })
      }
      if (!this._clients.length) {
        this.ended = true
        this._endCallback!()
      }
      return
    }

    // if we don't have any waiting, do nothing
    if (!this._pendingQueueCount) {
      this.log('no queued requests')
      return
    }
    // if we don't have any idle clients and we have no more room do nothing
    if (!this._idle.length && this._isFull()) {
      return
    }
    const pendingItem = this._pendingQueueHead!
    this._removePending(pendingItem)
    if (this._idle.length) {
      const idleItem = this._idle.pop()!
      clearTimeout(idleItem.timeoutId)
      const client = idleItem.client
      client.ref && client.ref()
      const idleListener = idleItem.idleListener

      return this._acquireClient(client, pendingItem, idleListener, false)
    }
    if (!this._isFull()) {
      return this.newClient(pendingItem)
    }
    throw new Error('unexpected condition')
  }

  _remove(client: Pool.PoolClient<C>, callback?: () => void) {
    const removed = removeWhere(this._idle, (item) => item.client === client)

    if (removed !== undefined) {
      clearTimeout(removed.timeoutId)
    }

    this._clients = this._clients.filter((c) => c !== client)
    const context = this
    client.end(() => {
      context.emit('remove', client)

      if (typeof callback === 'function') {
        callback()
      }
    })
  }

  connect(): Promise<Pool.PoolClient<C>>
  connect(cb: Pool.ConnectCallback<C>): void
  connect(cb?: Pool.ConnectCallback<C>): Promise<Pool.PoolClient<C>> | void {
    if (this.ending) {
      const err = new Error('Cannot use a pool after calling end on the pool')
      return cb ? (cb as Callback<Pool.PoolClient<C>>)(err) : this.Promise.reject(err)
    }

    const response = promisify<Pool.PoolClient<C>>(this.Promise, cb as Callback<Pool.PoolClient<C>> | undefined)
    const result = response.result

    // if we don't have to connect a new client, don't do so
    if (this._isFull() || this._idle.length) {
      // if we have idle clients schedule a pulse immediately
      if (this._idle.length) {
        process.nextTick(() => this._pulseQueue())
      }

      if (!this.options.connectionTimeoutMillis) {
        this._enqueuePending(new PendingItem(response.callback))
        return result
      }

      const queueCallback: Callback<Pool.PoolClient<C>> = (err, res, done) => {
        clearTimeout(tid)
        response.callback(err, res, done)
      }

      const pendingItem = new PendingItem(queueCallback)

      // set connection timeout on checking out an existing client
      const tid = setTimeout(() => {
        // remove the callback from pending waiters because
        // we're going to call it with a timeout error
        this._removePending(pendingItem)
        pendingItem.timedOut = true
        response.callback(new Error('timeout exceeded when trying to connect'))
      }, this.options.connectionTimeoutMillis)

      if (tid.unref) {
        tid.unref()
      }

      this._enqueuePending(pendingItem)
      return result
    }

    this.newClient(new PendingItem(response.callback))

    return result
  }

  newClient(pendingItem: PendingItem<C>) {
    const client = new this.Client(this.options) as Pool.PoolClient<C>
    this._clients.push(client)
    const idleListener = makeIdleListener(this, client)

    this.log('checking client timeout')

    // connection timeout logic
    let tid: NodeJS.Timeout | undefined
    let timeoutHit = false
    if (this.options.connectionTimeoutMillis) {
      tid = setTimeout(() => {
        if (client.connection) {
          this.log('ending client due to timeout')
          timeoutHit = true
          client.connection.stream.destroy()
        } else if (!client.isConnected!()) {
          this.log('ending client due to timeout')
          timeoutHit = true
          // force kill the node driver, and let libpq do its teardown
          client.end()
        }
      }, this.options.connectionTimeoutMillis)
    }

    this.log('connecting new client')
    client.connect((err) => {
      if (tid) {
        clearTimeout(tid)
      }
      client.on('error', idleListener)
      if (err) {
        this.log('client failed to connect', err)
        // remove the dead client from our list of clients
        this._clients = this._clients.filter((c) => c !== client)
        if (timeoutHit) {
          err = new Error('Connection terminated due to connection timeout', { cause: err })
        }

        // this client won’t be released, so move on immediately
        this._pulseQueue()

        if (!pendingItem.timedOut) {
          pendingItem.callback(err, undefined, NOOP)
        }
      } else {
        this.log('new client connected')

        if (this.options.onConnect) {
          this._promiseTry(() => this.options.onConnect!(client)).then(
            () => {
              this._afterConnect(client, pendingItem, idleListener)
            },
            (hookErr: unknown) => {
              this._clients = this._clients.filter((c) => c !== client)
              client.end(() => {
                this._pulseQueue()
                if (!pendingItem.timedOut) {
                  pendingItem.callback(hookErr as Error, undefined, NOOP)
                }
              })
            }
          )
          return
        }

        return this._afterConnect(client, pendingItem, idleListener)
      }
    })
  }

  _afterConnect(client: Pool.PoolClient<C>, pendingItem: PendingItem<C>, idleListener: IdleListener<C>) {
    if (this.options.maxLifetimeSeconds !== 0) {
      const maxLifetimeTimeout = setTimeout(() => {
        this.log('ending client due to expired lifetime')
        this._expired.add(client)
        const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client)
        if (idleIndex !== -1) {
          this._acquireClient(
            client,
            new PendingItem((err, client, clientRelease) => clientRelease!()),
            idleListener,
            false
          )
        }
      }, this.options.maxLifetimeSeconds * 1000)

      maxLifetimeTimeout.unref()
      client.once('end', () => clearTimeout(maxLifetimeTimeout))
    }

    return this._acquireClient(client, pendingItem, idleListener, true)
  }

  // acquire a client for a pending work item
  _acquireClient(
    client: Pool.PoolClient<C>,
    pendingItem: PendingItem<C>,
    idleListener: IdleListener<C>,
    isNew: boolean
  ) {
    if (isNew) {
      this.emit('connect', client)
    }

    this.emit('acquire', client)

    client.release = this._releaseOnce(client, idleListener)

    client.removeListener('error', idleListener)

    if (!pendingItem.timedOut) {
      if (isNew && this.options.verify) {
        this.options.verify(client, (err) => {
          if (err) {
            client.release(err)
            return pendingItem.callback(err, undefined, NOOP)
          }

          pendingItem.callback(undefined, client, client.release)
        })
      } else {
        pendingItem.callback(undefined, client, client.release)
      }
    } else {
      if (isNew && this.options.verify) {
        this.options.verify(client, client.release)
      } else {
        client.release()
      }
    }
  }

  // returns a function that wraps _release and throws if called more than once
  _releaseOnce(client: Pool.PoolClient<C>, idleListener: IdleListener<C>): Pool.Release {
    let released = false

    return (err) => {
      if (released) {
        throwOnDoubleRelease()
      }

      released = true
      this._release(client, idleListener, err)
    }
  }

  // release a client back to the poll, include an error
  // to remove it from the pool
  _release(client: Pool.PoolClient<C>, idleListener: IdleListener<C>, err?: Error | boolean | null) {
    client.on('error', idleListener)

    client._poolUseCount = (client._poolUseCount || 0) + 1

    this.emit('release', err, client)

    // TODO(bmc): expose a proper, public interface _queryable and _ending
    if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
      if (client._poolUseCount >= this.options.maxUses) {
        this.log('remove expended client')
      }

      return this._remove(client, this._pulseQueue.bind(this))
    }

    const isExpired = this._expired.has(client)
    if (isExpired) {
      this.log('remove expired client')
      this._expired.delete(client)
      return this._remove(client, this._pulseQueue.bind(this))
    }

    if (this._pendingQueueCount) {
      const pendingItem = this._pendingQueueHead!
      this._removePending(pendingItem)
      client.ref && client.ref()
      return this._acquireClient(client, pendingItem, idleListener, false)
    }

    // idle timeout
    let tid: NodeJS.Timeout | undefined
    if (this.options.idleTimeoutMillis && this._isAboveMin()) {
      tid = setTimeout(() => {
        if (this._isAboveMin()) {
          this.log('remove idle client')
          this._remove(client, this._pulseQueue.bind(this))
        }
      }, this.options.idleTimeoutMillis)

      if (this.options.allowExitOnIdle) {
        // allow Node to exit if this is all that's left
        tid.unref()
      }
    }

    if (this.options.allowExitOnIdle) {
      client.unref()
    }

    this._idle.push(new IdleItem(client, idleListener, tid))
    this._pulseQueue()
  }

  query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
    config: Pool.QueryArrayConfig<I>,
    values?: I
  ): Promise<Pool.QueryArrayResult<R>>
  query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
    text: string | Pool.QueryConfig<I> | Pool.Submittable,
    values?: I
  ): Promise<Pool.QueryResult<R>>
  query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
    config: Pool.QueryArrayConfig<I>,
    cb: Pool.QueryCallback<R>
  ): void
  query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
    config: Pool.QueryArrayConfig<I>,
    values: I | undefined,
    cb: Pool.QueryCallback<R>
  ): void
  query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
    text: string | Pool.QueryConfig<I> | Pool.Submittable,
    cb: Pool.QueryCallback<R>
  ): void
  query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
    text: string | Pool.QueryConfig<I> | Pool.Submittable,
    values: I | undefined,
    cb: Pool.QueryCallback<R>
  ): void
  query<R extends object = Record<string, unknown>>(
    text: string | Pool.QueryConfig | Pool.Submittable | Pool.QueryCallback<R>,
    values?: readonly unknown[] | Pool.QueryCallback<R>,
    cb?: Pool.QueryCallback<R>
  ): Promise<Pool.QueryResult<R>> | void {
    // guard clause against passing a function as the first parameter
    if (typeof text === 'function') {
      const response = promisify<Pool.QueryResult<R>>(this.Promise, text as Callback<Pool.QueryResult<R>>)
      setImmediate(function () {
        return response.callback(new Error('Passing a function as the first parameter to pool.query is not supported'))
      })
      return response.result
    }

    // allow plain text query without values, but callback
    if (typeof values === 'function') {
      cb = values
      values = undefined
    }
    const response = promisify<Pool.QueryResult<R>>(this.Promise, cb as Callback<Pool.QueryResult<R>> | undefined)
    const callback = response.callback

    this.connect((err, client) => {
      if (err) {
        return callback(err)
      }

      let clientReleased = false
      const onError = (err: Error) => {
        if (clientReleased) {
          return
        }
        clientReleased = true
        client.release(err)
        callback(err)
      }

      client.once('error', onError)
      this.log('dispatching query')
      try {
        client.query<R>(text, values, (err, res) => {
          this.log('query dispatched')
          client.removeListener('error', onError)
          if (clientReleased) {
            return
          }
          clientReleased = true
          client.release(err)
          if (err) {
            return callback(err)
          }
          return callback(undefined, res)
        })
      } catch (err) {
        client.release(err as Error)
        return callback(err as Error)
      }
    })
    return response.result
  }

  end(): Promise<void>
  end(cb: Pool.EndCallback): void
  end(cb?: Pool.EndCallback): Promise<void> | void {
    this.log('ending')
    if (this.ending) {
      const err = new Error('Called end on pool more than once')
      return cb ? cb(err) : this.Promise.reject(err)
    }
    this.ending = true
    const promised = promisify<void>(this.Promise, cb)
    this._endCallback = promised.callback
    this._pulseQueue()
    return promised.result
  }

  get waitingCount() {
    return this._pendingQueueCount
  }

  get idleCount() {
    return this._idle.length
  }

  get expiredCount() {
    return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0)
  }

  get totalCount() {
    return this._clients.length
  }
}
namespace Pool {
  export type Release = (err?: Error | boolean | null) => void
  export type EndCallback = (err?: Error | null) => void
  export type ResultCallback<T> = (err: Error | null | undefined, result: T) => void
  export type ConnectCallback<C extends Client = Client> = (
    err: Error | null | undefined,
    client: PoolClient<C>,
    release: Release
  ) => void
  export type QueryCallback<R extends object = Record<string, unknown>> = ResultCallback<QueryResult<R>>

  export interface FieldDef {
    name: string
    tableID: number
    columnID: number
    dataTypeID: number
    dataTypeSize: number
    dataTypeModifier: number
    format: string
  }

  export interface QueryResult<R extends object = Record<string, unknown>> {
    command: string | null
    rowCount: number | null
    oid: number | null
    rows: R[]
    fields: FieldDef[]
  }

  export interface QueryArrayResult<R extends readonly unknown[] = unknown[]> extends QueryResult<R> {}

  export interface TypeOverrides {
    getTypeParser(oid: number, format?: 'text' | 'binary'): (value: never) => unknown
  }

  export interface QueryConfig<I extends readonly unknown[] = readonly unknown[]> {
    text: string
    values?: I
    name?: string
    rowMode?: 'array'
    types?: TypeOverrides
    binary?: boolean
    query_timeout?: number
    queryMode?: 'simple' | 'extended'
    rows?: number
    portal?: string
  }

  export interface QueryArrayConfig<I extends readonly unknown[] = readonly unknown[]> extends QueryConfig<I> {
    rowMode: 'array'
  }

  export interface Submittable {
    submit(connection: unknown): unknown
  }

  export interface Queryable {
    query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
      config: QueryArrayConfig<I>,
      values?: I
    ): Promise<QueryArrayResult<R>>
    query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
      text: string | QueryConfig<I> | Submittable,
      values?: I
    ): Promise<QueryResult<R>>
    query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
      config: QueryArrayConfig<I>,
      cb: QueryCallback<R>
    ): void
    query<R extends readonly unknown[] = unknown[], I extends readonly unknown[] = readonly unknown[]>(
      config: QueryArrayConfig<I>,
      values: I | undefined,
      cb: QueryCallback<R>
    ): void
    query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
      text: string | QueryConfig<I> | Submittable,
      cb: QueryCallback<R>
    ): void
    query<R extends object = Record<string, unknown>, I extends readonly unknown[] = readonly unknown[]>(
      text: string | QueryConfig<I> | Submittable,
      values: I | undefined,
      cb: QueryCallback<R>
    ): void
  }

  export interface Client extends EventEmitter, Queryable {
    connect(callback: EndCallback): void
    end(callback?: EndCallback): unknown
    ref?(): void
    unref(): void
    isConnected?(): boolean
    connection?: { stream: { destroy(): unknown } }
    _queryable?: boolean
    _ending?: boolean
    _poolUseCount?: number
  }

  export type PoolClient<C extends Client = Client> = C & { release: Release }

  export interface ClientConstructor<C extends Client = Client> {
    new (config?: ClientConfig): C
  }

  export interface PromiseConstructor extends globalThis.PromiseConstructor {
    try?<T>(callback: () => T | PromiseLike<T>): Promise<T>
  }

  export interface ClientConfig {
    user?: string
    database?: string
    password?: string | (() => string | Promise<string>)
    port?: number
    host?: string
    connectionString?: string
    ssl?: boolean | ConnectionOptions
    sslnegotiation?: 'postgres' | 'direct'
    sslNegotiation?: 'postgres' | 'direct'
    stream?: Duplex | (() => Duplex)
    connection?: { stream: { destroy(): unknown } }
    Promise?: PromiseConstructor
    types?: TypeOverrides
    application_name?: string
    fallback_application_name?: string
    options?: string
    replication?: string
    client_encoding?: string
    statement_timeout?: number | false
    lock_timeout?: number | false
    idle_in_transaction_session_timeout?: number | false
    transaction_timeout?: number | false
    query_timeout?: number
    connectionTimeoutMillis?: number
    keepAlive?: boolean
    keepAliveInitialDelayMillis?: number
    binary?: boolean
    enableChannelBinding?: boolean
    scramMaxIterations?: number
    maxMessageSize?: number
    pipeline?: boolean
    autoBatch?: boolean
    maxAutoPrepare?: number
  }

  export interface PoolConfig<C extends Client = Client> extends ClientConfig {
    Client?: ClientConstructor<C>
    max?: number
    min?: number
    poolSize?: number
    maxUses?: number
    allowExitOnIdle?: boolean
    maxLifetimeSeconds?: number
    idleTimeoutMillis?: number
    log?: (...messages: unknown[]) => void
    verify?: (client: C, callback: EndCallback) => void
    onConnect?: (client: C) => void | PromiseLike<void>
  }
}

export = Pool
