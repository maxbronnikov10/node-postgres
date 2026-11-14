'use strict'

const events = require('events')
const Client = require('./client')
const { DatabaseError } = require('pg-protocol')

class QueryExecutorError extends Error {
  constructor({ message, code, outcome, cause, retryAfterMillis }) {
    super(message, { cause })
    this.name = 'QueryExecutorError'
    this.code = code
    this.outcome = outcome
    this.safeToRetry = outcome === 'not-sent'
    if (retryAfterMillis !== undefined) this.retryAfterMillis = retryAfterMillis
  }
}

class QueryExecutor {
  constructor(options = {}) {
    if (typeof events.addAbortListener !== 'function') {
      throw this._error({ code: 'PG_EXECUTOR_UNSUPPORTED', message: 'QueryExecutor requires events.addAbortListener' })
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Executor options must be an object' })
    }
    this._max = options.max ?? 4
    this._perConnection = options.maxInFlightPerConnection ?? 16
    this._maxPending = options.maxPending ?? 1024
    for (const value of [this._max, this._perConnection, this._maxPending]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Executor limits must be positive safe integers' })
      }
    }
    if (options.autoBatch || (options.pipeline !== undefined && options.pipeline !== true)) {
      throw this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Executor requires pipeline true and autoBatch false' })
    }
    this._timeout = options.query_timeout ?? 30000
    this._assertTimeout(this._timeout)
    const connectionTimeoutMillis = options.connectionTimeoutMillis ?? 5000
    this._assertTimeout(connectionTimeoutMillis)
    this._options = { ...options, connectionTimeoutMillis, query_timeout: 0, pipeline: true, autoBatch: false }
    delete this._options.max
    delete this._options.maxInFlightPerConnection
    delete this._options.maxPending
    this._records = new Set()
    this._pending = new Map()
    this._inFlight = 0
    this._state = 'open'
    this._cooldownUntil = 0
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

  _error({ code, message, outcome = 'not-sent', cause, retryAfterMillis }) {
    return new QueryExecutorError({ code, message, outcome, cause, retryAfterMillis })
  }

  _assertTimeout(value) {
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      throw this._error({
        code: 'PG_EXECUTOR_INVALID',
        message: 'Timeouts must be integers from 0 to 2147483647 milliseconds',
      })
    }
  }

  _toConfig({ input, values, argumentCount }) {
    if (argumentCount > 2 || typeof values === 'function') throw new TypeError('Callbacks are not supported')
    let config
    if (typeof input === 'string') {
      config = { text: input, values }
    } else {
      if (!input || typeof input !== 'object' || Array.isArray(input) || argumentCount > 1) {
        throw new TypeError('Expected SQL text or a query config')
      }
      if ('submit' in input) throw new TypeError('Custom queries are not supported')
      config = { ...input }
    }
    if (typeof config.text !== 'string' || !config.text.trim())
      throw new TypeError('Query text must be a nonempty string')
    if (config.values !== undefined && !Array.isArray(config.values))
      throw new TypeError('Query values must be an array')
    if ('submit' in config || 'callback' in config || 'portal' in config || 'rows' in config) {
      throw new TypeError('Custom queries, callbacks and portals are not supported')
    }
    if (config.queryMode !== undefined && config.queryMode !== 'extended')
      throw new TypeError('Query mode must be extended')
    if (config.autoBatch || config.pipeline !== undefined)
      throw new TypeError('Query transport options are managed by executor')
    if (config.name !== undefined && typeof config.name !== 'string') throw new TypeError('Query name must be a string')
    if (config.binary !== undefined && typeof config.binary !== 'boolean')
      throw new TypeError('Query binary must be a boolean')
    if (config.rowMode !== undefined && config.rowMode !== 'array' && config.rowMode !== 'object')
      throw new TypeError('Invalid rowMode')
    if (config.types !== undefined && (!config.types || typeof config.types.getTypeParser !== 'function'))
      throw new TypeError('Invalid type parsers')
    const timeout = config.query_timeout ?? this._timeout
    this._assertTimeout(timeout)
    const signal = config.signal
    delete config.signal
    config.queryMode = 'extended'
    // Snapshot the array without encoding values before an execution slot exists.
    if (config.values) config.values = config.values.slice()
    return { config, timeout, signal }
  }

  query(input, values) {
    if (this._state !== 'open')
      return Promise.reject(this._error({ code: 'PG_EXECUTOR_CLOSED', message: 'Executor is closing' }))
    let prepared
    try {
      prepared = this._toConfig({ input, values, argumentCount: arguments.length })
    } catch (cause) {
      return Promise.reject(this._error({ code: 'PG_EXECUTOR_INVALID', message: 'Invalid independent query', cause }))
    }
    return new Promise((resolve, reject) => {
      const task = {
        ...prepared,
        resolve,
        reject,
        state: 'queued',
        deadline: prepared.timeout ? performance.now() + prepared.timeout : 0,
      }
      try {
        if (task.signal !== undefined) {
          task.abortListener = events.addAbortListener(task.signal, () => this._abort(task))
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
      if (this._pending.size >= this._maxPending) {
        this._settle({
          task,
          error: this._error({ code: 'PG_EXECUTOR_OVERLOADED', message: 'Executor waiting queue is full' }),
        })
        return
      }
      this._pending.set(task, task)
      if (task.deadline) task.timer = setTimeout(() => this._expire(task), task.timeout)
      this._pump()
    })
  }

  _settle({ task, error, result }) {
    if (task.state === 'done') return
    if (task.state === 'assigned') {
      task.record.tasks.delete(task)
      this._inFlight--
    } else {
      this._pending.delete(task)
    }
    task.state = 'done'
    clearTimeout(task.timer)
    task.abortListener?.[Symbol.dispose]()
    if (error) task.reject(error)
    else task.resolve(result)
  }

  _abort(task) {
    if (task.state === 'done') return
    const error = this._error({
      code: 'PG_EXECUTOR_ABORTED',
      message: 'Query aborted',
      outcome: task.state === 'assigned' ? 'unknown' : 'not-sent',
      cause: task.signal.reason,
    })
    if (task.state === 'assigned') this._discard({ record: task.record, task, error })
    else {
      this._settle({ task, error })
      this._pump()
    }
  }

  _expire(task) {
    if (task.state === 'done') return
    const error = this._error({
      code: 'PG_EXECUTOR_TIMEOUT',
      message: 'Query deadline exceeded',
      outcome: task.state === 'assigned' ? 'unknown' : 'not-sent',
    })
    if (task.state === 'assigned') this._discard({ record: task.record, task, error })
    else this._settle({ task, error })
    this._pump()
  }

  _pump() {
    if (this._pumping || this._state === 'destroyed') return
    this._pumping = true
    try {
      while (this._pending.size) {
        let record
        for (const candidate of this._records) {
          if (
            candidate.state === 'ready' &&
            candidate.tasks.size < this._perConnection &&
            (!record || candidate.tasks.size < record.tasks.size)
          )
            record = candidate
        }
        if (!record) break
        const task = this._pending.values().next().value
        if (task.deadline && task.deadline <= performance.now()) {
          this._expire(task)
          continue
        }
        this._pending.delete(task)
        task.state = 'assigned'
        task.record = record
        record.tasks.add(task)
        this._inFlight++
        try {
          record.client.query({
            ...task.config,
            query_timeout: 0,
            callback: (error, result) => this._complete({ record, task, error, result }),
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
      let projected = 0
      for (const record of this._records) {
        if (record.state === 'connecting') projected += this._perConnection
      }
      while (
        this._pending.size > projected &&
        this._records.size < this._max &&
        performance.now() >= this._cooldownUntil
      ) {
        this._open()
        projected += this._perConnection
      }
      let healthy = false
      for (const record of this._records) {
        if (record.state === 'connecting' || record.state === 'ready') healthy = true
      }
      if (this._pending.size && !healthy && performance.now() < this._cooldownUntil) {
        for (const task of this._pending.values())
          this._settle({
            task,
            error: this._error({
              code: 'PG_EXECUTOR_UNAVAILABLE',
              message: 'No query connection available',
              cause: this._lastFailure,
              retryAfterMillis: Math.max(0, this._cooldownUntil - performance.now()),
            }),
          })
      }
      this._finish()
    } finally {
      this._pumping = false
    }
  }

  _open() {
    let client
    try {
      client = new Client(this._options)
      client.connectionParameters.query_timeout = 0
    } catch (cause) {
      this._lastFailure = cause
      this._cooldownUntil = performance.now() + 100
      return
    }
    const record = { client, state: 'connecting', tasks: new Set() }
    this._records.add(record)
    client.on('error', (cause) => this._connectionFailed({ record, cause }))
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
        record.state = 'ready'
        this._lastFailure = undefined
        this._cooldownUntil = 0
        process.nextTick(() => this._pump())
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
  }

  _complete({ record, task, error, result }) {
    if (task.state === 'done') return
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
    if (!error && record.client.getTransactionStatus() !== 'I') {
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
    this._settle({
      task,
      result,
      error: error
        ? this._error({ code: error.code, message: error.message, outcome: 'server-error', cause: error })
        : undefined,
    })
    this._pump()
  }

  _connectionFailed({ record, cause }) {
    if (record.state === 'closing') return
    this._lastFailure = cause
    this._cooldownUntil = performance.now() + 100
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

  _discard({ record, task, error }) {
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

  _removed(record) {
    if (!this._records.delete(record)) return
    this._pump()
    this._finish()
  }

  _shutdownPromise() {
    if (!this._closePromise)
      this._closePromise = new Promise((resolve) => {
        this._resolveClose = resolve
      })
    return this._closePromise
  }

  end() {
    const result = this._shutdownPromise()
    if (this._state === 'open') this._state = 'ending'
    this._pump()
    this._finish()
    return result
  }

  destroy(cause) {
    const result = this._shutdownPromise()
    this._state = 'destroyed'
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

  _finish() {
    if (this._state === 'open' || this._pending.size || this._inFlight) return
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

module.exports = { QueryExecutor, QueryExecutorError }
