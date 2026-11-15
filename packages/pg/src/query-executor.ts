'use strict'

import events = require('events')
import Client = require('./client')
const { DatabaseError } = require('pg-protocol') as typeof import('pg-protocol')
const { parse: parseConnectionString } = require('pg-connection-string') as typeof import('pg-connection-string')
import resultBudget = require('./query-result-budget')
import { submitQuery, type QuerySubmission } from './query-submission'
import type Result = require('./result')
import type { BackendMessage } from 'pg-protocol/dist/messages'
import type {
  BufferedQuery,
  IndependentQueryConfig,
  PgError,
  QueryExecutorEndpoint,
  QueryExecutorOptions,
  QueryResultRow,
} from './types'

type Outcome = 'not-sent' | 'server-error' | 'unknown'
type TextQueryArguments = [text: string, values?: readonly unknown[]]
type QueryArguments = TextQueryArguments | [config: IndependentQueryConfig]
interface ErrorOptions {
  message: string
  code: string | undefined
  outcome: Outcome
  cause?: unknown
  retryAfterMillis?: number
}
type ExecutorClientOptions = QueryExecutorOptions & {
  connectionTimeoutMillis: number
  maxMessageSize: number
  query_timeout: number
  pipeline: true
  autoBatch: false
}
interface Endpoint {
  config: Partial<QueryExecutorEndpoint>
  retryAt: number
  failedGeneration: number
}
interface ConnectionRecord {
  client: Client
  endpoint: Endpoint
  state: 'connecting' | 'ready' | 'reserved' | 'closing'
  tasks: Set<Task>
  openedAt: number
  timer?: NodeJS.Timeout
}
interface PreparedQuery {
  config: Omit<IndependentQueryConfig, 'signal'> & { queryMode: 'extended' }
  timeout: number
  signal?: AbortSignal
}
export interface ReservedConnection {
  query<R extends object = QueryResultRow>(config: IndependentQueryConfig): Promise<Result<R>>
  [submitQuery](request: QuerySubmission): void
  release(): void
}
interface Task extends PreparedQuery {
  lease?: (task: Task) => void
  transaction?: true
  resolve: (result: Result) => void
  reject: (reason: unknown) => void
  state: 'queued' | 'assigned' | 'done'
  resultRows: number
  resultBytes: number
  deadline: number
  record?: ConnectionRecord
  resultError?: QueryExecutorError
  resultQuery?: BufferedQuery
  abortListener?: Disposable
}
interface AbortListenerCapability {
  addAbortListener(signal: AbortSignal, listener: () => void): Disposable
}

class QueryExecutorError extends Error {
  readonly code: string | undefined
  readonly outcome: Outcome
  readonly safeToRetry: boolean
  readonly retryAfterMillis?: number

  constructor({ message, code, outcome, cause, retryAfterMillis }: ErrorOptions) {
    super(message, { cause })
    this.name = 'QueryExecutorError'
    this.code = code
    this.outcome = outcome
    this.safeToRetry = outcome === 'not-sent'
    if (retryAfterMillis !== undefined) this.retryAfterMillis = retryAfterMillis
  }
}

class QueryExecutor {
  private readonly _max: number
  private readonly _perConnection: number
  private readonly _maxPending: number
  private readonly _maxResultRows: number
  private readonly _maxResultBytes: number
  private readonly _timeout: number
  private readonly _targetSessionAttrs: 'any' | 'read-write' | 'read-only'
  private readonly _options: ExecutorClientOptions
  private readonly _endpoints: Endpoint[]
  private _nextEndpoint: number
  private _generation: number
  private readonly _records: Set<ConnectionRecord>
  private readonly _pending: Map<Task, Task>
  private readonly _timed: Set<Task>
  private _deadlineTimer?: NodeJS.Timeout
  private _deadlineAt: number
  private _inFlight: number
  private _resultRows: number
  private _resultBytes: number
  private _state: 'open' | 'ending' | 'destroyed'
  private _lastFailure: unknown
  private _pumping: boolean
  private _closePromise: Promise<void> | undefined
  private _resolveClose: (() => void) | undefined

  constructor(options: QueryExecutorOptions = {}) {
    if (typeof (events as typeof events & AbortListenerCapability).addAbortListener !== 'function') {
      throw this._error({ code: 'PG_EXECUTOR_UNSUPPORTED', message: 'QueryExecutor requires events.addAbortListener' })
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Executor options must be an object' })
    }
    this._max = options.max ?? 4
    this._perConnection = options.maxInFlightPerConnection ?? 16
    this._maxPending = options.maxPending ?? 1024
    this._maxResultRows = options.maxResultRows ?? 100000
    this._maxResultBytes = options.maxResultBytes ?? 67108864
    for (const [option, value] of [
      ['max', this._max],
      ['maxInFlightPerConnection', this._perConnection],
      ['maxPending', this._maxPending],
      ['maxResultRows', this._maxResultRows],
      ['maxResultBytes', this._maxResultBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw this._error({ code: 'PG_EXECUTOR_INVALID', message: `${option} must be a positive safe integer` })
      }
    }
    if (options.autoBatch || (options.pipeline !== undefined && options.pipeline !== true)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Executor requires pipeline true and autoBatch false' })
    }
    this._timeout = options.query_timeout ?? 30000
    this._assertTimeout(this._timeout, 'query_timeout')
    const connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5000
    this._assertTimeout(connectionTimeoutMillis, 'connectionTimeoutMillis')
    this._targetSessionAttrs = options.targetSessionAttrs ?? 'any'
    if (!['any', 'read-write', 'read-only'].includes(this._targetSessionAttrs)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid targetSessionAttrs' })
    }
    const maxMessageSize = options.maxMessageSize ?? 16777216
    if (!Number.isInteger(maxMessageSize) || maxMessageSize < 4 || maxMessageSize > 2147483647) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid maxMessageSize' })
    }
    let parsed: ReturnType<typeof parseConnectionString> | Record<string, never>
    try {
      parsed = options.connectionString ? parseConnectionString(options.connectionString) : {}
    } catch (cause) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid connection string', cause })
    }
    this._options = {
      ...options,
      ...parsed,
      connectionTimeoutMillis,
      maxMessageSize,
      query_timeout: 0,
      pipeline: true,
      autoBatch: false,
    } as ExecutorClientOptions
    if (options.endpoints !== undefined && (options.stream !== undefined || options.connection !== undefined)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Endpoints require independently owned connections' })
    }
    this._endpoints = this._toEndpoints(options.endpoints)
    this._nextEndpoint = 0
    this._generation = 0
    delete this._options.max
    delete this._options.maxInFlightPerConnection
    delete this._options.maxPending
    delete this._options.maxResultRows
    delete this._options.maxResultBytes
    delete this._options.connectionString
    delete this._options.endpoints
    delete this._options.targetSessionAttrs
    this._records = new Set()
    this._pending = new Map()
    this._timed = new Set()
    this._deadlineAt = 0
    this._inFlight = 0
    this._resultRows = 0
    this._resultBytes = 0
    this._state = 'open'
    this._lastFailure = undefined
    this._pumping = false
    this._closePromise = undefined
  }

  get totalCount() {
    return this._records.size
  }
  get waitingCount() {
    return this._pending.size
  }
  get inFlightCount() {
    return this._inFlight
  }

  private _error({
    code,
    message,
    outcome = 'not-sent',
    cause,
    retryAfterMillis,
  }: Omit<ErrorOptions, 'outcome'> & { outcome?: Outcome }) {
    return new QueryExecutorError({ code, message, outcome, cause, retryAfterMillis })
  }

  private _invalid(message: string): QueryExecutorError {
    return this._error({ code: 'PG_EXECUTOR_INVALID', message, cause: new TypeError(message) })
  }

  private _assertTimeout(value: unknown, option: 'query_timeout' | 'connectionTimeoutMillis'): asserts value is number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2147483647) {
      throw this._invalid(`${option} must be an integer from 0 to 2147483647 milliseconds`)
    }
  }

  private _toEndpoints(input: readonly QueryExecutorEndpoint[] | undefined): Endpoint[] {
    if (input === undefined) return [{ config: {}, retryAt: 0, failedGeneration: -1 }]
    if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Expected 1 to 64 endpoints' })
    }
    return (input as readonly QueryExecutorEndpoint[]).map((endpoint) => {
      if (
        !endpoint ||
        typeof endpoint !== 'object' ||
        Array.isArray(endpoint) ||
        typeof endpoint.host !== 'string' ||
        !endpoint.host.trim() ||
        Object.keys(endpoint).some((key) => !['host', 'port', 'ssl', 'sslnegotiation'].includes(key)) ||
        (endpoint.port !== undefined &&
          (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)) ||
        (endpoint.ssl !== undefined &&
          typeof endpoint.ssl !== 'boolean' &&
          (!endpoint.ssl || typeof endpoint.ssl !== 'object' || Array.isArray(endpoint.ssl))) ||
        (endpoint.sslnegotiation !== undefined && !['postgres', 'direct'].includes(endpoint.sslnegotiation))
      ) {
        throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid endpoint configuration' })
      }
      const config: Partial<QueryExecutorEndpoint> = { ...endpoint }
      for (const key of Object.keys(config))
        if (config[key as keyof QueryExecutorEndpoint] === undefined) delete config[key as keyof QueryExecutorEndpoint]
      return { config, retryAt: 0, failedGeneration: -1 }
    })
  }

  private _pickEndpoint(): Endpoint | null {
    const now = performance.now()
    for (let i = 0; i < this._endpoints.length; i++) {
      const index = (this._nextEndpoint + i) % this._endpoints.length
      const endpoint = this._endpoints[index]
      if (endpoint.retryAt <= now && endpoint.failedGeneration !== this._generation) {
        this._nextEndpoint = (index + 1) % this._endpoints.length
        return endpoint
      }
    }
    return null
  }

  private _toConfig({
    input,
    values,
    argumentCount,
  }: {
    input: unknown
    values: unknown
    argumentCount: number
  }): PreparedQuery {
    if (argumentCount > 2 || typeof values === 'function') throw this._invalid('Callbacks are not supported')
    let config: Record<string, unknown>
    if (typeof input === 'string') {
      config = { text: input, values }
    } else {
      if (!input || typeof input !== 'object' || Array.isArray(input) || argumentCount > 1) {
        throw this._invalid('Expected SQL text or a query config')
      }
      if ('submit' in input) throw this._invalid('Custom queries are not supported')
      config = { ...input }
    }
    if (typeof config.text !== 'string' || !config.text.trim())
      throw this._invalid('Query text must be a nonempty string')
    if (config.values !== undefined && !Array.isArray(config.values))
      throw this._invalid('Query values must be an array')
    if ('submit' in config || 'callback' in config || 'portal' in config || 'rows' in config) {
      throw this._invalid('Custom queries, callbacks and portals are not supported')
    }
    if (config.queryMode !== undefined && config.queryMode !== 'extended')
      throw this._invalid('Query mode must be extended')
    if (config.autoBatch || config.pipeline !== undefined)
      throw this._invalid('Query transport options are managed by executor')
    if (config.name !== undefined && typeof config.name !== 'string') throw this._invalid('Query name must be a string')
    if (config.binary !== undefined && typeof config.binary !== 'boolean')
      throw this._invalid('Query binary must be a boolean')
    if (config.rowMode !== undefined && config.rowMode !== 'array' && config.rowMode !== 'object')
      throw this._invalid('Invalid rowMode')
    if (
      config.types !== undefined &&
      (!config.types || typeof (config.types as { getTypeParser?: unknown }).getTypeParser !== 'function')
    )
      throw this._invalid('Invalid type parsers')
    const timeout = config.query_timeout ?? this._timeout
    this._assertTimeout(timeout, 'query_timeout')
    const signal = config.signal as AbortSignal | undefined
    delete config.signal
    config.queryMode = 'extended'
    // Snapshot the array without encoding values before an execution slot exists.
    if (config.values) config.values = (config.values as readonly unknown[]).slice()
    return { config: config as unknown as PreparedQuery['config'], timeout, signal }
  }

  query<R extends object = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<Result<R>>
  query<R extends object = QueryResultRow>(config: IndependentQueryConfig): Promise<Result<R>>
  query<R extends object = QueryResultRow>(
    input: string | IndependentQueryConfig,
    values?: readonly unknown[]
  ): Promise<Result<R>> {
    const argumentCount = arguments.length
    return new Promise<Result<R>>((resolve, reject) => {
      this._submit({ input, values, argumentCount, resolve: resolve as unknown as Task['resolve'], reject })
    })
  }

  [submitQuery]({ config, resolve, reject }: QuerySubmission): void {
    this._submit({ input: config, argumentCount: 1, resolve, reject })
  }

  private _submit({
    input,
    values,
    argumentCount,
    resolve,
    reject,
    lease,
  }: {
    input: unknown
    values?: unknown
    argumentCount: number
    resolve: Task['resolve']
    reject: Task['reject']
    lease?: Task
  }): void {
    if (lease ? lease.state !== 'assigned' || lease.record!.state !== 'reserved' : this._state !== 'open') {
      reject(
        this._error({
          code: 'PG_EXECUTOR_CLOSED',
          message: lease ? 'Reserved connection is closed' : 'Executor is closing',
        })
      )
      return
    }
    let prepared: PreparedQuery
    try {
      prepared = this._toConfig({ input, values, argumentCount })
    } catch (cause) {
      reject(
        cause instanceof QueryExecutorError
          ? cause
          : lease
          ? this._invalid('Invalid reserved query')
          : this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid independent query', cause })
      )
      return
    }
    this._enqueue({ prepared, resolve, reject, reservedRecord: lease?.record })
  }

  reserve(): Promise<ReservedConnection> {
    if (this._state !== 'open')
      return Promise.reject(this._error({ code: 'PG_EXECUTOR_CLOSED', message: 'Executor is closing' }))
    return new Promise((resolve, reject) => {
      this._enqueue({
        prepared: { config: { text: '', queryMode: 'extended' }, timeout: this._timeout },
        resolve: () => {},
        reject,
        lease: (task) => {
          resolve({
            query: (config) => this._reservedQuery({ lease: task, config }),
            [submitQuery]: ({ config, resolve, reject }) =>
              this._submit({ input: config, argumentCount: 1, resolve, reject, lease: task }),
            release: () => this._release(task),
          })
        },
      })
    })
  }

  private _reservedQuery<R extends object>({
    lease,
    config,
  }: {
    lease: Task
    config: IndependentQueryConfig
  }): Promise<Result<R>> {
    return new Promise((resolve, reject) => {
      this._submit({ input: config, argumentCount: 1, resolve: resolve as unknown as Task['resolve'], reject, lease })
    })
  }

  private _release(task: Task) {
    if (task.state === 'done') return
    const record = task.record!
    if (record.tasks.size !== 1 || record.client.getTransactionStatus() !== 'I') {
      this._discard({
        record,
        error: this._error({
          code: 'PG_EXECUTOR_TRANSACTION',
          message: 'Reserved connection was released before its work finished',
          outcome: 'unknown',
        }),
      })
      return
    }
    record.state = 'ready'
    this._settle({ task })
    this._pump()
  }

  private _enqueue({
    prepared,
    resolve,
    reject,
    lease,
    reservedRecord,
  }: {
    prepared: PreparedQuery
    resolve: Task['resolve']
    reject: Task['reject']
    lease?: Task['lease']
    reservedRecord?: ConnectionRecord
  }) {
    const task: Task = {
      config: prepared.config,
      timeout: prepared.timeout,
      signal: prepared.signal,
      transaction: reservedRecord ? true : undefined,
      resolve,
      lease,
      reject,
      state: 'queued',
      resultRows: 0,
      resultBytes: 0,
      record: undefined,
      resultQuery: undefined,
      resultError: undefined,
      deadline: prepared.timeout ? performance.now() + prepared.timeout : 0,
    }
    try {
      if (task.signal !== undefined) {
        task.abortListener = (events as typeof events & AbortListenerCapability).addAbortListener(task.signal, () =>
          this._abort(task)
        )
        if (task.signal.aborted) {
          this._abort(task)
          return
        }
      }
    } catch (cause) {
      this._settle({
        task,
        error: this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid AbortSignal', cause }),
      })
      return
    }
    if (reservedRecord ? reservedRecord.tasks.size > this._perConnection : this._pending.size >= this._maxPending) {
      this._settle({
        task,
        error: this._error({ code: 'PG_EXECUTOR_OVERLOADED', message: 'Executor waiting queue is full' }),
      })
      return
    }
    if (task.deadline) {
      this._timed.add(task)
      this._scheduleDeadline(task.deadline)
    }
    if (reservedRecord) {
      this._dispatch({ task, record: reservedRecord })
      return
    }
    if (!this._records.size && !this._pending.size) this._generation++
    this._pending.set(task, task)
    this._pump()
  }

  async rows<R extends object = QueryResultRow>(...args: QueryArguments): Promise<R[]> {
    const result = await this.query<R>(...(args as TextQueryArguments))
    return result.rows
  }

  async one<R extends object = QueryResultRow>(...args: QueryArguments): Promise<R> {
    const rows = await this.rows<R>(...args)
    if (rows.length !== 1) {
      throw this._error({
        code: 'PG_EXECUTOR_ROW_COUNT',
        message: `Expected exactly one row, received ${rows.length}`,
        outcome: 'unknown',
      })
    }
    return rows[0]
  }

  async maybeOne<R extends object = QueryResultRow>(...args: QueryArguments): Promise<R | null> {
    const rows = await this.rows<R>(...args)
    if (rows.length > 1) {
      throw this._error({
        code: 'PG_EXECUTOR_ROW_COUNT',
        message: `Expected at most one row, received ${rows.length}`,
        outcome: 'unknown',
      })
    }
    return rows[0] ?? null
  }

  private _settle({ task, error, result }: { task: Task; error?: QueryExecutorError; result?: Result }) {
    if (task.state === 'done') return
    if (error) task.resultQuery?._discardResult(error)
    this._resultRows -= task.resultRows
    this._resultBytes -= task.resultBytes
    task.resultError = error
    task.resultQuery = undefined
    if (task.state === 'assigned') {
      task.record!.tasks.delete(task)
      this._inFlight--
    } else {
      this._pending.delete(task)
    }
    task.state = 'done'
    this._forgetDeadline(task)
    task.abortListener?.[Symbol.dispose]()
    if (error) task.reject(error)
    else task.resolve(result!)
  }

  private _scheduleDeadline(deadline: number) {
    if (this._deadlineTimer && this._deadlineAt <= deadline) {
      this._deadlineTimer.ref()
      return
    }
    clearTimeout(this._deadlineTimer)
    this._deadlineAt = deadline
    this._deadlineTimer = setTimeout(
      () => this._expireDeadlines(),
      Math.max(1, Math.ceil(deadline - performance.now()))
    )
  }

  private _forgetDeadline(task: Task) {
    this._timed.delete(task)
    if (!this._timed.size) this._deadlineTimer?.unref()
  }

  private _expireDeadlines() {
    this._deadlineTimer = undefined
    this._deadlineAt = 0
    const now = performance.now()
    for (const task of this._timed) {
      if (task.deadline <= now) this._expire(task)
    }
    let earliest = Infinity
    for (const task of this._timed) earliest = Math.min(earliest, task.deadline)
    // Expiry can dispatch work synchronously and arm an earlier timer.
    if (earliest !== Infinity) this._scheduleDeadline(earliest)
  }

  private _consumeResult(
    { task, query }: { task: Task; query: BufferedQuery },
    message: Pick<BackendMessage, 'name' | 'length'>
  ): boolean {
    if (task.state !== 'assigned' || (task.record!.state !== 'ready' && task.record!.state !== 'reserved')) {
      query._discardResult(task.resultError)
      return false
    }
    const rows = message.name === 'dataRow' ? 1 : 0
    const bytes = message.length + 1
    const exceedsRows = rows > this._maxResultRows - this._resultRows
    if (exceedsRows || bytes > this._maxResultBytes - this._resultBytes) {
      this._discard({
        record: task.record!,
        task,
        error: this._error({
          code: 'PG_EXECUTOR_RESULT_LIMIT',
          message: `Executor buffered result ${exceedsRows ? 'row' : 'byte'} limit exceeded`,
          outcome: 'unknown',
        }),
      })
      return false
    }
    this._resultRows += rows
    this._resultBytes += bytes
    task.resultRows += rows
    task.resultBytes += bytes
    return true
  }

  private _abort(task: Task) {
    if (task.state === 'done') return
    const error = this._error({
      code: 'PG_EXECUTOR_ABORTED',
      message: 'Query aborted',
      outcome: task.state === 'assigned' ? 'unknown' : 'not-sent',
      cause: task.signal!.reason,
    })
    if (task.state === 'assigned') this._discard({ record: task.record!, task, error })
    else {
      this._settle({ task, error })
      this._pump()
    }
  }

  private _expire(task: Task) {
    if (task.state === 'done') return
    const error = this._error({
      code: 'PG_EXECUTOR_TIMEOUT',
      message: 'Query deadline exceeded',
      outcome: task.state === 'assigned' ? 'unknown' : 'not-sent',
    })
    if (task.state === 'assigned') this._discard({ record: task.record!, task, error })
    else this._settle({ task, error })
    this._pump()
  }

  private _dispatch({ task, record }: { task: Task; record: ConnectionRecord }) {
    this._pending.delete(task)
    task.state = 'assigned'
    task.record = record
    record.tasks.add(task)
    this._inFlight++
    if (task.lease) {
      this._forgetDeadline(task)
      record.state = 'reserved'
      task.lease(task)
      return
    }
    try {
      record.client.query({
        text: task.config.text,
        values: task.config.values,
        name: task.config.name,
        binary: task.config.binary,
        rowMode: task.config.rowMode,
        types: task.config.types,
        queryMode: 'extended',
        query_timeout: 0,
        [resultBudget]: (query) => {
          task.resultQuery = query
          const context = { task, query }
          return (message) => this._consumeResult(context, message)
        },
        callback: (error, result) =>
          this._complete({ record: record!, task, error, result: result as Result | undefined }),
      })
    } catch (cause) {
      this._discard({
        record,
        task,
        error: this._error({
          code: 'PG_EXECUTOR_UNKNOWN',
          message: 'Assigned query failed',
          outcome: 'unknown',
          cause,
        }),
      })
    }
  }

  private _pump() {
    if (this._pumping || this._state === 'destroyed') return
    this._pumping = true
    try {
      while (this._pending.size) {
        const task = this._pending.values().next().value!
        let record: ConnectionRecord | undefined
        for (const candidate of this._records) {
          if (
            candidate.state === 'ready' &&
            (task.lease ? candidate.tasks.size === 0 : candidate.tasks.size < this._perConnection) &&
            (!record || candidate.tasks.size < record.tasks.size)
          ) {
            record = candidate
            if (!candidate.tasks.size) break
          }
        }
        if (!record) break
        if (task.deadline && task.deadline <= performance.now()) {
          this._expire(task)
          continue
        }
        this._dispatch({ task, record })
      }
      if (this._pending.size) {
        let projected = 0
        for (const record of this._records) {
          if (record.state === 'connecting') projected += this._perConnection
        }
        while (this._pending.size > projected && this._records.size < this._max) {
          const endpoint = this._pickEndpoint()
          if (!endpoint) break
          if (this._open(endpoint)) projected += this._perConnection
        }
        let healthy = false
        for (const record of this._records) {
          if (record.state !== 'closing') healthy = true
        }
        if (this._pending.size && !healthy) {
          const retryAt = Math.min(...this._endpoints.map((endpoint) => endpoint.retryAt))
          if (
            performance.now() < retryAt ||
            this._endpoints.every((endpoint) => endpoint.failedGeneration === this._generation)
          ) {
            for (const task of this._pending.values())
              this._settle({
                task,
                error: this._error({
                  code: 'PG_EXECUTOR_UNAVAILABLE',
                  message: 'No query connection available',
                  cause: this._lastFailure,
                  retryAfterMillis: Math.max(0, retryAt - performance.now()),
                }),
              })
          }
        }
      }
      this._finish()
    } finally {
      this._pumping = false
    }
  }

  private _open(endpoint: Endpoint): boolean {
    let client: Client
    try {
      client = new Client({ ...this._options, ...endpoint.config })
      client.connectionParameters.query_timeout = 0
    } catch (cause) {
      this._lastFailure = cause
      endpoint.retryAt = performance.now() + 100
      endpoint.failedGeneration = this._generation
      return false
    }
    const record: ConnectionRecord = {
      client,
      endpoint,
      state: 'connecting',
      tasks: new Set(),
      openedAt: performance.now(),
    }
    this._records.add(record)
    client.on('error', (cause: unknown) => this._connectionFailed({ record, cause }))
    client.on('end', () => {
      if (record.state !== 'closing')
        this._connectionFailed({ record, cause: new Error('Connection ended unexpectedly') })
      this._removed(record)
    })
    try {
      client.connect((cause) => {
        if (record.state !== 'connecting') return
        if (cause) {
          this._connectionFailed({ record, cause })
          return
        }
        this._checkRole(record)
      })
      client.connection.on('readyForQuery', () => {
        if (record.state === 'ready' && client.getTransactionStatus() !== 'I') {
          this._discard({
            record,
            error: this._error({
              code: 'PG_EXECUTOR_TRANSACTION',
              message: 'Independent query left a transaction open',
              outcome: 'unknown',
            }),
          })
        }
      })
    } catch (cause) {
      this._connectionFailed({ record, cause })
    }
    return true
  }

  private _ready(record: ConnectionRecord) {
    if (record.state !== 'connecting') return
    clearTimeout(record.timer)
    record.state = 'ready'
    record.endpoint.retryAt = 0
    record.endpoint.failedGeneration = -1
    this._lastFailure = undefined
    process.nextTick(() => this._pump())
  }

  private _checkRole(record: ConnectionRecord) {
    if (this._targetSessionAttrs === 'any') return this._ready(record)
    const timeout = this._options.connectionTimeoutMillis
    if (timeout) {
      record.timer = setTimeout(
        () => {
          const cause: PgError = new Error('Connection role check timed out')
          cause.code = 'PG_EXECUTOR_ROLE_TIMEOUT'
          this._connectionFailed({ record, cause })
        },
        Math.max(1, timeout - (performance.now() - record.openedAt))
      )
    }
    record.client.query({
      text: 'SHOW transaction_read_only',
      queryMode: 'extended',
      query_timeout: 0,
      rowMode: 'array',
      types: { getTypeParser: () => (value: string | Buffer) => value },
      callback: (cause, result) => {
        if (record.state !== 'connecting') return
        if (cause) return this._connectionFailed({ record, cause })
        const expected = this._targetSessionAttrs === 'read-write' ? 'off' : 'on'
        if ((result as unknown as Result<unknown[]>).rows[0]?.[0] !== expected) {
          const failure: PgError = new Error('Endpoint does not match targetSessionAttrs')
          failure.code = 'PG_EXECUTOR_ROLE_MISMATCH'
          return this._connectionFailed({ record, cause: failure })
        }
        this._ready(record)
      },
    })
  }

  private _complete({
    record,
    task,
    error,
    result,
  }: {
    record: ConnectionRecord
    task: Task
    error?: PgError | null
    result?: Result
  }) {
    if (task.state === 'done') return
    if (error?.code === '25006' && this._targetSessionAttrs === 'read-write') {
      this._settle({
        task,
        error: this._error({ code: error.code, message: error.message, outcome: 'server-error', cause: error }),
      })
      this._connectionFailed({ record, cause: error })
      return
    }
    if (
      error &&
      (!(error instanceof DatabaseError) ||
        error.severity === 'FATAL' ||
        error.severity === 'PANIC' ||
        error.code?.startsWith('08'))
    ) {
      this._discard({
        record,
        task,
        error: this._error({
          code: 'PG_EXECUTOR_UNKNOWN',
          message: 'Assigned query failed',
          outcome: 'unknown',
          cause: error,
        }),
      })
      return
    }
    if (!error && !task.transaction && record.client.getTransactionStatus() !== 'I') {
      this._discard({
        record,
        task,
        error: this._error({
          code: 'PG_EXECUTOR_TRANSACTION',
          message: 'Independent query left a transaction open',
          outcome: 'unknown',
        }),
      })
      return
    }
    if (!error) this._generation++
    this._settle({
      task,
      result,
      error: error
        ? this._error({ code: error.code, message: error.message, outcome: 'server-error', cause: error })
        : undefined,
    })
    this._pump()
  }

  private _connectionFailed({ record, cause }: { record: ConnectionRecord; cause: unknown }) {
    if (record.state === 'closing') return
    this._lastFailure = cause
    record.endpoint.retryAt = performance.now() + 100
    record.endpoint.failedGeneration = this._generation
    this._discard({
      record,
      error: this._error({
        code: 'PG_EXECUTOR_UNKNOWN',
        message: 'Query connection failed',
        outcome: 'unknown',
        cause,
      }),
    })
  }

  private _discard({ record, task, error }: { record: ConnectionRecord; task?: Task; error: QueryExecutorError }) {
    clearTimeout(record.timer)
    if (record.state === 'closing') {
      record.client.connection.stream.destroy()
      return
    }
    record.state = 'closing'
    for (const assigned of record.tasks) {
      this._settle({
        task: assigned,
        error:
          assigned === task || !task
            ? error
            : this._error({
                code: 'PG_EXECUTOR_UNKNOWN',
                message: 'Shared query transport discarded',
                outcome: 'unknown',
              }),
      })
    }
    record.client.connection.stream.destroy()
    record.client.end(() => this._removed(record))
    this._pump()
  }

  private _removed(record: ConnectionRecord) {
    if (!this._records.delete(record)) return
    this._pump()
    this._finish()
  }

  private _shutdownPromise(): Promise<void> {
    if (!this._closePromise)
      this._closePromise = new Promise<void>((resolve) => {
        this._resolveClose = resolve
      })
    return this._closePromise
  }

  end(): Promise<void> {
    const result = this._shutdownPromise()
    if (this._state === 'open') this._state = 'ending'
    this._pump()
    this._finish()
    return result
  }

  destroy(cause?: unknown): Promise<void> {
    const result = this._shutdownPromise()
    this._state = 'destroyed'
    clearTimeout(this._deadlineTimer)
    this._deadlineTimer = undefined
    this._deadlineAt = 0
    for (const task of this._pending.values())
      this._settle({
        task,
        error: this._error({ code: 'PG_EXECUTOR_DESTROYED', message: 'Executor destroyed before dispatch', cause }),
      })
    for (const record of this._records)
      this._discard({
        record,
        error: this._error({
          code: 'PG_EXECUTOR_UNKNOWN',
          message: 'Executor transport destroyed',
          outcome: 'unknown',
          cause,
        }),
      })
    this._finish()
    return result
  }

  private _finish() {
    if (this._state === 'open' || this._pending.size || this._inFlight) return
    clearTimeout(this._deadlineTimer)
    this._deadlineTimer = undefined
    this._deadlineAt = 0
    for (const record of this._records) {
      if (record.state === 'closing') continue
      if (record.state === 'connecting') {
        this._discard({
          record,
          error: this._error({ code: 'PG_EXECUTOR_CLOSED', message: 'Executor closed before dispatch' }),
        })
        continue
      }
      record.state = 'closing'
      record.client.end(() => this._removed(record))
    }
    if (!this._records.size) this._resolveClose?.()
  }
}

export { QueryExecutor, QueryExecutorError }
