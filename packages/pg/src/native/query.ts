import { EventEmitter } from 'events'
import util = require('util')
import utils = require('../utils')
import type Client = require('./client')
import type { PgError, QueryResultRow } from '../types'
import type {
  NativeAfter,
  NativeNormalize,
  NativeBinding,
  NativeQueryCallback,
  NativeQueryConfig,
  NativeResult,
  NativeResults,
  PreparedValue,
} from './binding'

type ProcessWithDomain = NodeJS.Process & { domain?: import('domain').Domain }

interface NativeQuery<R extends object = QueryResultRow> extends EventEmitter {
  text?: string
  values?: readonly unknown[]
  name?: string
  queryMode?: 'simple' | 'extended'
  query_timeout?: number | false
  callback?: NativeQueryCallback<R>
  state: 'new' | 'running' | 'error' | 'end'
  _arrayMode: boolean
  _emitRowEvents: boolean
  native?: NativeBinding
  _promise?: Promise<NativeResults<R>>
  _once: EventEmitter['once']
  handleError(error: PgError, connection?: unknown): void
  then<TResult1 = NativeResults<R>, TResult2 = never>(
    onSuccess?: ((value: NativeResults<R>) => TResult1 | PromiseLike<TResult1>) | null,
    onFailure?: ((error: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>
  catch<TResult = never>(
    callback?: ((error: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<NativeResults<R> | TResult>
  _getPromise(): Promise<NativeResults<R>>
  submit(client: Client): unknown
}

interface NativeQueryConstructor {
  new <R extends object = QueryResultRow>(
    config?: string | NativeQueryConfig<R>,
    values?: readonly unknown[] | NativeQueryCallback<R>,
    callback?: NativeQueryCallback<R>
  ): NativeQuery<R>
  (
    this: NativeQuery,
    config?: string | NativeQueryConfig,
    values?: readonly unknown[] | NativeQueryCallback,
    callback?: NativeQueryCallback
  ): void
  prototype: NativeQuery
}

// eslint-disable-next-line @typescript-eslint/no-redeclare -- The callable constructor shares its instance type name.
const NativeQuery = (module.exports = function (
  this: NativeQuery,
  config?: string | NativeQueryConfig,
  values?: readonly unknown[] | NativeQueryCallback,
  callback?: NativeQueryCallback
) {
  EventEmitter.call(this)
  config = (utils.normalizeQueryConfig as unknown as NativeNormalize)(config, values, callback)
  this.text = config.text
  this.values = config.values
  this.name = config.name
  this.queryMode = config.queryMode
  this.callback = config.callback
  this.state = 'new'
  this._arrayMode = config.rowMode === 'array'

  // if the 'row' event is listened for
  // then emit them as they come in
  // without setting singleRowMode to true
  // this has almost no meaning because libpq
  // reads all rows into memory before returning any
  this._emitRowEvents = false
  this.on(
    'newListener',
    function (this: NativeQuery, event: string | symbol) {
      if (event === 'row') this._emitRowEvents = true
    }.bind(this)
  )
}) as NativeQueryConstructor

util.inherits(NativeQuery, EventEmitter)

const errorFieldMap: Record<string, string> = {
  sqlState: 'code',
  statementPosition: 'position',
  messagePrimary: 'message',
  messageDetail: 'detail',
  messageHint: 'hint',
  context: 'where',
  schemaName: 'schema',
  tableName: 'table',
  columnName: 'column',
  dataTypeName: 'dataType',
  constraintName: 'constraint',
  sourceFile: 'file',
  sourceLine: 'line',
  sourceFunction: 'routine',
}

NativeQuery.prototype.handleError = function (this: NativeQuery, err) {
  // copy pq error fields into the error object
  const fields = this.native && this.native.pq.resultErrorFields()
  if (fields) {
    for (const key in fields) {
      const normalizedFieldName = errorFieldMap[key] || key
      ;(err as Error & Record<string, unknown>)[normalizedFieldName] = fields[key]
    }
  }
  if (this.callback) {
    this.callback(err)
  } else {
    this.emit('error', err)
  }
  this.state = 'error'
}

NativeQuery.prototype.then = function (this: NativeQuery, onSuccess, onFailure) {
  return this._getPromise().then(onSuccess, onFailure)
}

NativeQuery.prototype.catch = function (this: NativeQuery, callback) {
  return this._getPromise().catch(callback)
}

NativeQuery.prototype._getPromise = function (this: NativeQuery) {
  if (this._promise) return this._promise
  this._promise = new Promise<NativeResults>(
    function (this: NativeQuery, resolve: (value: NativeResults) => void, reject: (error: unknown) => void) {
      this._once('end', resolve)
      this._once('error', reject)
    }.bind(this)
  )
  return this._promise
}

NativeQuery.prototype.submit = function (this: NativeQuery, client) {
  this.state = 'running'
  const self = this
  this.native = undefined

  let after: NativeAfter = function (err, rows, results) {
    client.native.arrayMode = false
    setImmediate(function () {
      self.emit('_done')
    })

    // handle possible query error
    if (err) {
      return self.handleError(err)
    }

    // emit row events for each row in the result
    if (self._emitRowEvents) {
      if ((results as NativeResult[]).length > 1) {
        ;(rows as object[][]).forEach((rowOfRows, i) => {
          rowOfRows.forEach((row) => {
            self.emit('row', row, (results as NativeResult[])[i])
          })
        })
      } else {
        rows!.forEach(function (row) {
          self.emit('row', row, results)
        })
      }
    }

    // handle successful result
    self.state = 'end'
    self.emit('end', results)
    if (self.callback) {
      self.callback(null, results)
    }
  }

  if ((process as ProcessWithDomain).domain) {
    after = (process as ProcessWithDomain).domain!.bind(after)
  }

  let values: PreparedValue[] | undefined
  if (this.name || this.values) {
    if (this.values && !Array.isArray(this.values)) {
      return after(new Error('Query values must be an array'))
    }
    try {
      values = (this.values || []).map(utils.prepareValue)
    } catch (err) {
      return after(utils.toError(err))
    }
  }

  const previous = this.name ? client.namedQueries[this.name] : undefined
  if (previous !== undefined && this.text && previous !== this.text) {
    return after(new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`))
  }

  // Local failures must not inherit error fields from libpq's previous result.
  this.native = client.native
  client.native.arrayMode = this._arrayMode

  // named query
  if (this.name) {
    if (this.name.length > 63) {
      console.error('Warning! Postgres only supports 63 characters for query names.')
      console.error('You supplied %s (%s)', this.name, this.name.length)
      console.error('This can cause conflicts and silent errors executing queries')
    }
    // check if the client has already executed this named query
    // if so...just execute it again - skip the planning phase
    if (previous !== undefined) {
      return client.native.execute(this.name, values, after)
    }
    // plan the named query the first time, then execute it
    return client.native.prepare(this.name, this.text, values!.length, function (err) {
      if (err) return after(err)
      client.namedQueries[self.name!] = self.text
      return self.native!.execute(self.name!, values, after)
    })
  } else if (this.values) {
    client.native.query(this.text, values, after)
  } else if (this.queryMode === 'extended') {
    client.native.query(this.text, [], after)
  } else {
    client.native.query(this.text, after)
  }
}

export = NativeQuery
