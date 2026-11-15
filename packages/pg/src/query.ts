'use strict'

import { EventEmitter } from 'events'

import Result = require('./result')
import utils = require('./utils')
import resultBudget = require('./query-result-budget')

import type { Domain } from 'domain'
import type { BackendMessage, Field, RawDataRowMessage } from 'pg-protocol/dist/messages'
import type Connection = require('./connection')
import type {
  CustomTypesConfig,
  PgError,
  QueryCallback,
  QueryConfig,
  QueryResultRow,
  QueryResults,
  RowMode,
} from './types'

type ConstructorConfig<R extends object> = Omit<QueryConfig, 'callback'> & { callback?: QueryCallback<R> }
type QueryProcess = NodeJS.Process & { readonly domain?: Domain | null }
type RowDescription = BackendMessage & { readonly fields: Field[] }
type DataRow =
  | RawDataRowMessage
  | (BackendMessage & { readonly buffer?: undefined; readonly fields: (string | Buffer | null)[] })
type CommandComplete = BackendMessage & { readonly text: string }

class Query<R extends object = QueryResultRow> extends EventEmitter {
  text: string | undefined
  values: readonly unknown[] | undefined
  rows: number | undefined
  types: QueryConfig['types']
  name: string | undefined
  queryMode: QueryConfig['queryMode']
  binary: boolean | undefined
  portal: string
  callback: QueryCallback<R> | undefined
  _rowMode: RowMode | undefined
  _result: Result<R> | null
  _results: QueryResults<R> | null
  _canceledDueToError: PgError | false | undefined
  _accumulateRows: QueryCallback<R> | boolean | undefined
  _autoBatch?: boolean
  private _resultBudget: ((message: BackendMessage) => boolean) | undefined

  constructor(
    config?: string | ConstructorConfig<R>,
    values?: readonly unknown[] | QueryCallback<R>,
    callback?: QueryCallback<R>
  ) {
    super()

    config = utils.normalizeQueryConfig(
      config as string | QueryConfig,
      values as readonly unknown[] | QueryCallback,
      callback as QueryCallback
    ) as ConstructorConfig<R>

    this.text = config.text
    this.values = config.values
    this.rows = config.rows
    this.types = config.types
    this.name = config.name
    this.queryMode = config.queryMode
    this.binary = config.binary
    // use unique portal name each time
    this.portal = config.portal || ''
    this.callback = config.callback
    this._rowMode = config.rowMode
    if ((process as QueryProcess).domain && config.callback) {
      this.callback = (process as QueryProcess).domain!.bind(config.callback)
    }
    this._result = new Result<R>(this._rowMode, this.types as CustomTypesConfig | undefined)

    // potential for multiple results
    this._results = this._result
    this._canceledDueToError = false
    this._resultBudget = config[resultBudget]?.(this)
  }

  requiresPreparation() {
    if (this.queryMode === 'extended') {
      return true
    }

    // named queries must always be prepared
    if (this.name) {
      return true
    }
    // always prepare if there are max number of rows expected per
    // portal execution
    if (this.rows) {
      return true
    }
    // don't prepare empty text queries
    if (!this.text) {
      return false
    }
    // prepare if there are values
    if (!this.values) {
      return false
    }
    return this.values.length > 0
  }

  _checkForMultirow() {
    // if we already have a result with a command property
    // then we've already executed one query in a multi-statement simple query
    // turn our results into an array of results
    if (this._result!.command) {
      if (!Array.isArray(this._results)) {
        this._results = [this._result!]
      }
      this._result = new Result<R>(this._rowMode, this._result!._types)
      this._results.push(this._result)
    }
  }

  // associates row metadata from the supplied
  // message with this query object
  // metadata used when parsing row results
  handleRowDescription(msg: RowDescription) {
    if (this._resultBudget && !this._resultBudget(msg)) return
    this._checkForMultirow()
    this._result!.addFields(msg.fields)
    this._accumulateRows = this.callback || !this.listeners('row').length
  }

  handleDataRow(msg: DataRow) {
    let row: R

    if (this._canceledDueToError) {
      return
    }
    if (this._resultBudget && !this._resultBudget(msg)) return

    try {
      row = msg.buffer ? this._result!.parseRawRow(msg) : this._result!.parseRow(msg.fields)
    } catch (err) {
      this._canceledDueToError = utils.toError(err)
      return
    }

    if (this._canceledDueToError) return
    this.emit('row', row, this._result)
    if (this._accumulateRows) {
      this._result!.addRow(row)
    }
  }

  _discardResult(error?: PgError) {
    this._canceledDueToError = error
    this._result = null
    this._results = null
  }

  handleCommandComplete(msg: CommandComplete, connection: Connection) {
    if (this._resultBudget && !this._resultBudget(msg)) return
    this._checkForMultirow()
    this._result!.addCommandComplete(msg)
    // need to sync after each command complete of a prepared statement
    // if we were using a row count which results in multiple calls to _getRows
    if (this.rows) {
      connection.sync()
    }
  }

  // if a named prepared statement is created with empty query text
  // the backend will send an emptyQuery message but *not* a command complete message
  // since we pipeline sync immediately after execute we don't need to do anything here
  // unless we have rows specified, in which case we did not pipeline the initial sync call
  handleEmptyQuery(connection: Connection) {
    if (this.rows) {
      connection.sync()
    }
  }

  handleError(err: PgError, _connection?: Connection) {
    // need to sync after error during a prepared statement
    if (this._canceledDueToError) {
      err = this._canceledDueToError
      this._canceledDueToError = false
    }
    // if callback supplied do not emit error event as uncaught error
    // events will bubble up to node process
    if (this.callback) {
      return this.callback(err)
    }
    this.emit('error', err)
  }

  handleReadyForQuery(con: Connection) {
    if (this._canceledDueToError) {
      return this.handleError(this._canceledDueToError, con)
    }
    if (this.callback) {
      try {
        this.callback(null, this._results!)
      } catch (err) {
        process.nextTick(() => {
          throw err
        })
      }
    }
    this.emit('end', this._results)
  }

  submit(connection: Connection): Error | null {
    if (typeof this.text !== 'string' && typeof this.name !== 'string') {
      return new Error('A query must have either text or a name. Supplying neither is unsupported.')
    }
    const previous =
      this.name && (connection.parsedStatements[this.name] || connection.submittedNamedStatements[this.name])
    if (this.text && previous && this.text !== previous) {
      return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`)
    }
    if (this.values && !Array.isArray(this.values)) {
      return new Error('Query values must be an array')
    }
    if (this.requiresPreparation()) {
      // If we're using the extended query protocol we fire off several separate commands
      // to the backend. On some versions of node & some operating system versions
      // the network stack writes each message separately instead of buffering them together
      // causing the client & network to send more slowly. Corking & uncorking the stream
      // allows node to buffer up the messages internally before sending them all off at once.
      // note: we're checking for existence of cork/uncork because some versions of streams
      // might not have this (cloudflare?)
      connection.stream.cork && connection.stream.cork()
      try {
        this.prepare(connection)
      } finally {
        // while unlikely for this.prepare to throw, if it does & we don't uncork this stream
        // this client becomes unresponsive, so put in finally block "just in case"
        connection.stream.uncork && connection.stream.uncork()
      }
    } else {
      connection.query(this.text!)
    }
    return null
  }

  hasBeenParsed(connection: Connection): boolean | string | undefined {
    return (
      this.name &&
      (connection.parsedStatements[this.name] !== undefined ||
        connection.submittedNamedStatements[this.name] !== undefined)
    )
  }

  handlePortalSuspended(connection: Connection) {
    this._getRows(connection, this.rows)
  }

  _getRows(connection: Connection, rows: number | undefined) {
    connection.execute({
      portal: this.portal,
      rows: rows,
    })
    // if we're not reading pages of rows send the sync command
    // to indicate the pipeline is finished
    if (!rows) {
      connection.sync()
    } else {
      // otherwise flush the call out to read more rows
      connection.flush()
    }
  }

  // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
  prepare(connection: Connection) {
    // TODO refactor this poor encapsulation
    if (!this.hasBeenParsed(connection)) {
      connection.parse({
        text: this.text!,
        name: this.name,
        types: this.types as number[] | undefined,
      })
      if (this.name) {
        connection.submittedNamedStatements[this.name] = this.text
      }
    }

    // because we're mapping user supplied values to
    // postgres wire protocol compatible values it could
    // throw an exception, so try/catch this section
    try {
      connection.bind({
        portal: this.portal,
        statement: this.name,
        values: this.values as unknown[] | undefined,
        binary: this.binary,
        valueMapper: utils.prepareValue,
      })
    } catch (err) {
      // Keep named statements reusable, including earlier queries still in the pipeline.
      if (!this.name) {
        connection.close({ type: 'S', name: this.name })
      }
      connection.sync()

      this._canceledDueToError = utils.toError(err)
      return
    }

    connection.describe({
      type: 'P',
      name: this.portal || '',
    })

    this._getRows(connection, this.rows)
  }

  handleCopyInResponse(connection: Connection) {
    connection.sendCopyFail('No source stream defined')
  }

  handleCopyData(_msg: { readonly chunk: Buffer }, _connection: Connection) {
    // noop
  }
}

export = Query
