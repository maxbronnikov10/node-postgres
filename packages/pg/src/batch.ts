'use strict'

const { serialize } = require('pg-protocol') as typeof import('pg-protocol')
import Query = require('./query')
import utils = require('./utils')

import type Connection = require('./connection')
import type Result = require('./result')
import type { CustomTypesConfig, PgError, QueryCallback, QueryConfig, QueryResultRow } from './types'

type BatchCallback<R extends object> = (error: PgError | null, results?: Result<R>[]) => void

const execute = serialize.execute({})
const describe = serialize.describe({ type: 'P', name: '' })
const hasOwn = Object.prototype.hasOwnProperty

// A batch owns one Sync and one queue entry. Individual Query objects retain
// normal row parsing and Result semantics, but never submit their own Sync.
class Batch<R extends object = QueryResultRow> extends Query<R> {
  queries: Query<R>[]
  current: Query<R> | undefined
  connection!: Connection
  _index: number
  _writeIndex: number
  _resume: () => void
  _copyError: () => void
  _individualQueries: boolean | undefined
  _queryErrorIndex: number | undefined
  _localErrorIndex: number | undefined
  _queryError: PgError | undefined
  _synced: boolean | undefined
  _finished: boolean | undefined

  static fromQueries<R extends object = QueryResultRow>(queries: Query<R>[]) {
    const batch = new Batch<R>([], null, false, (err) => {
      for (let i = 0; i < queries.length; i++) {
        if (i < batch._index) {
          queries[i].handleReadyForQuery(batch.connection)
        } else if (i === batch._queryErrorIndex) {
          queries[i].handleError(batch._queryError!, batch.connection)
        } else if (i === batch._localErrorIndex) {
          queries[i].handleError(err!, batch.connection)
        } else {
          const skipped: PgError = new Error('Query skipped because another query in the batch failed')
          skipped.code = 'PG_BATCH_ABORTED'
          skipped.cause = err
          queries[i].handleError(skipped, batch.connection)
        }
      }
    })
    batch.queries = queries
    batch._individualQueries = true
    batch._results = queries.map((query) => query._result!)
    batch._setCurrent()
    return batch
  }

  constructor(
    configs: readonly (string | QueryConfig)[],
    types: CustomTypesConfig | null,
    binary: boolean | undefined,
    callback: BatchCallback<R>
  ) {
    super({ callback } as { callback: QueryCallback<R> })
    this.queries = Array.from(configs, (config) => {
      if (config == null || typeof (config as { submit?: unknown }).submit === 'function') {
        throw new TypeError('Batch entries must be query strings or query configs')
      }
      const query = new Query<R>(config as string | (Omit<QueryConfig, 'callback'> & { callback?: QueryCallback<R> }))
      if (query.rows || query.portal || query.callback || (config as QueryConfig).query_timeout) {
        throw new Error('Batch entries do not support rows, portals, callbacks or query_timeout')
      }
      if (typeof query.text !== 'string' && !(typeof query.name === 'string' && query.name.length)) {
        throw new Error('A batch query must have text or a name')
      }
      if (query.values && !Array.isArray(query.values)) {
        throw new TypeError('Query values must be an array')
      }
      query._result!._types = query._result!._types || types!
      query.binary = query.binary || binary
      return query
    })
    this._results = this.queries.map((query) => query._result!)
    this._index = 0
    this._writeIndex = 0
    this._resume = this._write.bind(this)
    this._copyError = () => {
      this._canceledDueToError = new Error('COPY is not supported in a batch')
      this.connection.stream.destroy(this._canceledDueToError)
    }
    this._setCurrent()
  }

  _setCurrent() {
    this.current = this.queries[this._index]
    this.name = this.current && this.current.name
    this.text = this.current && this.current.text
  }

  submit(connection: Connection): PgError | null {
    let names: Record<string, string | undefined> | undefined
    for (let i = 0; i < this.queries.length; i++) {
      const query = this.queries[i]
      if (query.name) {
        const name = query.name
        if (!names) names = Object.create(null)
        const previous = hasOwn.call(names, name)
          ? names![name]
          : connection.submittedNamedStatements && hasOwn.call(connection.submittedNamedStatements, name)
          ? connection.submittedNamedStatements[name]
          : connection.parsedStatements && hasOwn.call(connection.parsedStatements, name)
          ? connection.parsedStatements[name]
          : undefined
        if (query.text && previous && query.text !== previous) {
          this._queryErrorIndex = i
          return this._annotate(
            new Error(`Prepared statements must be unique - '${name}' was used for a different statement`),
            i
          )
        }
        names![name] = query.text || previous
      }
    }
    this.connection = connection
    connection.once('copyOutResponse', this._copyError)
    this._write()
    return null
  }

  _write() {
    const connection = this.connection
    try {
      while (this._writeIndex < this.queries.length) {
        const buffers: Buffer[] = []
        let length = 0
        // Bound each write by bytes, except when one command itself is larger.
        // A false write return yields to reads before encoding more commands.
        do {
          const query = this.queries[this._writeIndex]
          const messages: Buffer[] = []
          const parsed = query.hasBeenParsed(connection)
          if (!parsed)
            messages.push(
              serialize.parse({ text: query.text!, name: query.name, types: query.types as number[] | undefined })
            )
          messages.push(
            serialize.bind({
              statement: query.name,
              values: query.values as unknown[] | undefined,
              binary: query.binary,
              valueMapper: utils.prepareValue,
            }),
            describe,
            execute
          )
          if (!parsed && query.name) connection.submittedNamedStatements[query.name] = query.text
          for (const message of messages) {
            buffers.push(message)
            length += message.length
          }
          this._writeIndex++
        } while (length < 65536 && this._writeIndex < this.queries.length)
        let writable = true
        const stream = connection.stream
        if (length > 65536 && typeof stream.cork === 'function' && typeof stream.uncork === 'function') {
          // writev keeps oversized commands together without another copy of the payload.
          stream.cork()
          try {
            for (const buffer of buffers) {
              if (!connection._send(buffer)) writable = false
            }
          } finally {
            stream.uncork()
          }
        } else {
          writable = connection._send(Buffer.concat(buffers, length))
        }
        if (!writable) {
          connection.stream.once('drain', this._resume)
          return
        }
      }
    } catch (err) {
      this._localErrorIndex = this._writeIndex
      this._canceledDueToError = this._annotate(utils.toError(err), this._writeIndex)
      this._clearPendingNames()
    }
    this._sync()
  }

  _sync() {
    if (!this.connection) return
    this.connection.stream.removeListener('drain', this._resume)
    if (!this._synced) {
      this._synced = true
      this.connection.sync()
    }
  }

  _clearPendingNames() {
    if (!this.connection) return
    for (const query of this.queries) {
      if (query.name) delete this.connection.submittedNamedStatements[query.name]
    }
  }

  _annotate<E extends PgError>(err: E, index: number): E {
    try {
      if (err && typeof err === 'object' && Object.isExtensible(err) && err.batchIndex === undefined) {
        err.batchIndex = index
      }
    } catch {
      // Optional metadata must never replace the original error.
    }
    return err
  }

  handleRowDescription(message: Parameters<Query<R>['handleRowDescription']>[0]) {
    this.current!.handleRowDescription(message)
  }

  handleDataRow(message: Parameters<Query<R>['handleDataRow']>[0]) {
    this.current!.handleDataRow(message)
  }

  handleCommandComplete(message: Parameters<Query<R>['handleCommandComplete']>[0], connection: Connection) {
    this.current!.handleCommandComplete(message, connection)
    this.handleEmptyQuery()
  }

  handleEmptyQuery() {
    if (!this._individualQueries && this.current!._canceledDueToError && !this._canceledDueToError) {
      this._localErrorIndex = this._index
      this._canceledDueToError = this._annotate(this.current!._canceledDueToError, this._index)
    }
    this._index++
    this._setCurrent()
  }

  handleCopyInResponse() {
    this._copyError()
  }

  handleReadyForQuery(connection: Connection) {
    connection.removeListener('copyOutResponse', this._copyError)
    if (this._canceledDueToError) {
      return this._finish(this._canceledDueToError, connection)
    }
    super.handleReadyForQuery(connection)
  }

  handleError(err: PgError, connection?: Connection) {
    if (this._finished) return
    this._queryErrorIndex = this._queryErrorIndex ?? this._index
    this._queryError = this._annotate(err, this._queryErrorIndex)
    this._finish(this._queryError, connection)
  }

  _finish(err: PgError, connection?: Connection) {
    if (this._finished) return
    this._finished = true
    this._sync()
    this._clearPendingNames()
    if (this.connection) this.connection.removeListener('copyOutResponse', this._copyError)
    super.handleError(err, connection)
  }
}

export = Batch
