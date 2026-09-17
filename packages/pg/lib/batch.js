'use strict'

const { serialize } = require('pg-protocol')
const Query = require('./query')
const utils = require('./utils')

const execute = serialize.execute({})
const describe = serialize.describe({ type: 'P', name: '' })
const hasOwn = Object.prototype.hasOwnProperty

// A batch owns one Sync and one queue entry. Individual Query objects retain
// normal row parsing and Result semantics, but never submit their own Sync.
class Batch extends Query {
  static fromQueries(queries) {
    const batch = new Batch([], null, false, (err) => {
      for (let i = 0; i < queries.length; i++) {
        if (i < batch._index) {
          queries[i].handleReadyForQuery(batch.connection)
        } else if (i === batch._queryError?.batchIndex) {
          queries[i].handleError(batch._queryError, batch.connection)
        } else if (i === err.batchIndex) {
          queries[i].handleError(err, batch.connection)
        } else {
          const skipped = new Error('Query skipped because another query in the batch failed')
          skipped.code = 'PG_BATCH_ABORTED'
          skipped.cause = err
          queries[i].handleError(skipped, batch.connection)
        }
      }
    })
    batch.queries = queries
    batch._individualQueries = true
    batch._results = queries.map((query) => query._result)
    batch._setCurrent()
    return batch
  }

  constructor(configs, types, binary, callback) {
    super({ callback })
    this.queries = Array.from(configs, (config) => {
      if (config == null || typeof config.submit === 'function') {
        throw new TypeError('Batch entries must be query strings or query configs')
      }
      const query = new Query(config)
      if (query.rows || query.portal || query.callback || config.query_timeout) {
        throw new Error('Batch entries do not support rows, portals, callbacks or query_timeout')
      }
      if (typeof query.text !== 'string' && !(typeof query.name === 'string' && query.name.length)) {
        throw new Error('A batch query must have text or a name')
      }
      if (query.values && !Array.isArray(query.values)) {
        throw new TypeError('Query values must be an array')
      }
      query._result._types = query._result._types || types
      query.binary = query.binary || binary
      return query
    })
    this._results = this.queries.map((query) => query._result)
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

  submit(connection) {
    let names
    for (let i = 0; i < this.queries.length; i++) {
      const query = this.queries[i]
      if (query.name) {
        const name = query.name
        if (!names) names = Object.create(null)
        const previous = hasOwn.call(names, name)
          ? names[name]
          : connection.submittedNamedStatements && hasOwn.call(connection.submittedNamedStatements, name)
          ? connection.submittedNamedStatements[name]
          : connection.parsedStatements && hasOwn.call(connection.parsedStatements, name)
          ? connection.parsedStatements[name]
          : undefined
        if (query.text && previous && query.text !== previous) {
          return this._annotate(
            new Error(`Prepared statements must be unique - '${name}' was used for a different statement`),
            i
          )
        }
        names[name] = query.text || previous
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
        const buffers = []
        let length = 0
        // Bound each write by bytes, except when one command itself is larger.
        // A false write return yields to reads before encoding more commands.
        do {
          const query = this.queries[this._writeIndex]
          const messages = []
          const parsed = query.hasBeenParsed(connection)
          if (!parsed) messages.push(serialize.parse({ text: query.text, name: query.name, types: query.types }))
          messages.push(
            serialize.bind({
              statement: query.name,
              values: query.values,
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
        if (!connection._send(Buffer.concat(buffers, length))) {
          connection.stream.once('drain', this._resume)
          return
        }
      }
    } catch (err) {
      this._canceledDueToError = this._annotate(err, this._writeIndex)
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

  _annotate(err, index) {
    if (err && typeof err === 'object' && Object.isExtensible(err) && err.batchIndex === undefined) {
      err.batchIndex = index
    }
    return err
  }

  handleRowDescription(message) {
    this.current.handleRowDescription(message)
  }

  handleDataRow(message) {
    this.current.handleDataRow(message)
  }

  handleCommandComplete(message, connection) {
    this.current.handleCommandComplete(message, connection)
    this.handleEmptyQuery()
  }

  handleEmptyQuery() {
    if (!this._individualQueries && this.current._canceledDueToError && !this._canceledDueToError) {
      this._canceledDueToError = this._annotate(this.current._canceledDueToError, this._index)
    }
    this._index++
    this._setCurrent()
  }

  handleCopyInResponse() {
    this._copyError()
  }

  handleReadyForQuery(connection) {
    connection.removeListener('copyOutResponse', this._copyError)
    super.handleReadyForQuery(connection)
  }

  handleError(err, connection) {
    if (this._finished) return
    this._finished = true
    this._sync()
    this._clearPendingNames()
    if (this.connection) this.connection.removeListener('copyOutResponse', this._copyError)
    this._queryError = this._annotate(err, this._index)
    super.handleError(this._queryError, connection)
  }
}

module.exports = Batch
