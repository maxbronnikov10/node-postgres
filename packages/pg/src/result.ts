'use strict'

const types = require('pg-types') as unknown as CustomTypesConfig
const { ProtocolError } = require('pg-protocol') as typeof import('pg-protocol')
import type { Field, RawDataRowMessage } from 'pg-protocol/dist/messages'
import type { CustomTypesConfig, QueryResultRow, RowMode, ValueParser } from './types'

const matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/

// result object returned from query
// in the 'end' event and also
// passed as second argument to provided callback
class Result<R extends object = QueryResultRow> {
  command: string | null
  rowCount: number | null
  oid: number | null
  rows: R[]
  fields: Field[]
  _parsers: ValueParser[] | undefined
  _types: CustomTypesConfig | undefined
  RowCtor: unknown
  rowAsArray: boolean
  _prebuiltEmptyResultObject: Record<string, unknown> | null

  constructor(rowMode?: RowMode, types?: CustomTypesConfig) {
    this.command = null
    this.rowCount = null
    this.oid = null
    this.rows = []
    this.fields = []
    this._parsers = undefined
    this._types = types
    this.RowCtor = null
    this.rowAsArray = rowMode === 'array'
    if (this.rowAsArray) {
      this.parseRow = this._parseRowAsArray
      this.parseRawRow = this._parseRawRowAsArray
    }
    this._prebuiltEmptyResultObject = null
  }

  // adds a command complete message
  addCommandComplete(msg: { text?: string; command?: string }) {
    let match
    if (msg.text) {
      // pure javascript
      match = matchRegexp.exec(msg.text)
    } else {
      // native bindings
      match = matchRegexp.exec(msg.command!)
    }
    if (match) {
      this.command = match[1]
      if (match[3]) {
        // COMMAND OID ROWS
        this.oid = parseInt(match[2], 10)
        this.rowCount = parseInt(match[3], 10)
      } else if (match[2]) {
        // COMMAND ROWS
        this.rowCount = parseInt(match[2], 10)
      }
    }
  }

  _parseRowAsArray(rowData: readonly (string | Buffer | null)[]): R {
    this._assertFieldCount(rowData.length)
    const row = new Array<unknown>(rowData.length)
    for (let i = 0, len = rowData.length; i < len; i++) {
      const rawValue = rowData[i]
      if (rawValue !== null) {
        row[i] = this._parsers![i](rawValue)
      } else {
        row[i] = null
      }
    }
    return row as unknown as R
  }

  parseRow(rowData: readonly (string | Buffer | null)[]): R {
    this._assertFieldCount(rowData.length)
    const row = { ...this._prebuiltEmptyResultObject }
    for (let i = 0, len = rowData.length; i < len; i++) {
      const rawValue = rowData[i]
      const field = this.fields[i].name
      if (rawValue !== null) {
        const v = this.fields[i].format === 'binary' ? Buffer.from(rawValue as string) : rawValue
        row[field] = this._parsers![i](v)
      } else {
        row[field] = null
      }
    }
    return row as unknown as R
  }

  _parseRawRowAsArray({ buffer, offset, fieldCount }: Pick<RawDataRowMessage, 'buffer' | 'offset' | 'fieldCount'>): R {
    this._assertFieldCount(fieldCount)
    const row = new Array<unknown>(fieldCount)
    offset += 2
    for (let i = 0; i < fieldCount; i++) {
      const length = buffer.readInt32BE(offset)
      offset += 4
      let value: unknown = null
      if (length !== -1) {
        const rawValue =
          this.fields[i].format === 'binary'
            ? buffer.subarray(offset, offset + length)
            : buffer.toString('utf8', offset, offset + length)
        value = this._parsers![i](rawValue)
        offset += length
      }
      row[i] = value
    }
    return row as unknown as R
  }

  parseRawRow({ buffer, offset, fieldCount }: Pick<RawDataRowMessage, 'buffer' | 'offset' | 'fieldCount'>): R {
    this._assertFieldCount(fieldCount)
    const row = { ...this._prebuiltEmptyResultObject }
    offset += 2
    for (let i = 0; i < fieldCount; i++) {
      const length = buffer.readInt32BE(offset)
      offset += 4
      let value: unknown = null
      if (length !== -1) {
        const rawValue =
          this.fields[i].format === 'binary'
            ? buffer.subarray(offset, offset + length)
            : buffer.toString('utf8', offset, offset + length)
        value = this._parsers![i](rawValue)
        offset += length
      }
      row[this.fields[i].name] = value
    }
    return row as unknown as R
  }

  _assertFieldCount(fieldCount: number) {
    if (fieldCount !== this.fields.length) {
      throw new ProtocolError('DataRow field count does not match RowDescription')
    }
  }

  addRow(row: R) {
    this.rows.push(row)
  }

  addFields(fieldDescriptions: Field[]) {
    // clears field definitions
    // multiple query statements in 1 action can result in multiple sets
    // of rowDescriptions...eg: 'select NOW(); select 1::int;'
    // you need to reset the fields
    this.fields = fieldDescriptions
    if (this.fields.length) {
      this._parsers = new Array(fieldDescriptions.length)
    }

    const row = Object.create(null)

    for (let i = 0; i < fieldDescriptions.length; i++) {
      const desc = fieldDescriptions[i]
      row[desc.name] = null

      if (this._types) {
        this._parsers![i] = this._types.getTypeParser(desc.dataTypeID, desc.format || 'text') as ValueParser
      } else {
        this._parsers![i] = types.getTypeParser(desc.dataTypeID, desc.format || 'text') as ValueParser
      }
    }

    this._prebuiltEmptyResultObject = { ...row }
  }
}

export = Result
