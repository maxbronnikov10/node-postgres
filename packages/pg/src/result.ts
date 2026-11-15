'use strict'

const types = require('pg-types') as unknown as CustomTypesConfig
const { ProtocolError } = require('pg-protocol') as typeof import('pg-protocol')
import type { Field, RawDataRowMessage } from 'pg-protocol/dist/messages'
import type { CustomTypesConfig, QueryResultRow, RowMode, ValueParser } from './types'

// pg-types 2.x keeps the original parser here even when its public registry was overridden before loading pg.
const textParsers = require('pg-types/lib/textParsers') as {
  init(register: (oid: number, parser: ValueParser) => void): void
}
let int4TextParser: ValueParser | undefined
textParsers.init((oid, parser) => {
  if (oid === 23) int4TextParser = parser
})

const matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/

type RawInt4Reader = (this: Result<object>, buffer: Buffer, offset: number) => object

class Int4ReaderCache {
  private readonly readers = new Map<string, { reader: RawInt4Reader; expiresAt: number }>()
  private disabled = false

  get({ names, rowAsArray }: { names: readonly string[]; rowAsArray: boolean }): RawInt4Reader | undefined {
    if (this.disabled || !names.length || names.length > 32) return undefined
    const key = JSON.stringify([rowAsArray, names])
    const now = Date.now()
    const cached = this.readers.get(key)
    if (cached && cached.expiresAt > now) return cached.reader
    if (cached) this.readers.delete(key)
    const source = ['"use strict"; offset += 2;']
    const values: string[] = []
    names.forEach((name, index) => {
      source.push(
        `const length${index} = buffer.readInt32BE(offset); offset += 4;`,
        `const value${index} = length${index} === -1 ? null : this._parseTextInt4({ buffer, offset, length: length${index}, parser: this._parsers[${index}] });`,
        `if (length${index} !== -1) offset += length${index};`
      )
      values.push(rowAsArray ? `value${index}` : `[${JSON.stringify(name)}]: value${index}`)
    })
    source.push(rowAsArray ? `return [${values.join(',')}];` : `return {${values.join(',')}};`)
    let reader: RawInt4Reader
    try {
      // Names appear only as JSON-escaped computed keys; all executable source is fixed scaffold.
      reader = new Function('buffer', 'offset', source.join('\n')) as RawInt4Reader
    } catch (cause) {
      if (!(cause instanceof EvalError)) throw cause
      this.disabled = true
      this.readers.clear()
      return undefined
    }
    if (this.readers.size >= 128) this.readers.delete(this.readers.keys().next().value!)
    this.readers.set(key, { reader, expiresAt: now + 300000 })
    return reader
  }
}

const int4Readers = new Int4ReaderCache()

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
  private _textInt4: boolean[]
  private _prefersRawInt4 = false
  private _int4Reader: RawInt4Reader | undefined
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
    this._textInt4 = []
    this.RowCtor = null
    this.rowAsArray = rowMode === 'array'
    if (this.rowAsArray) {
      this.parseRow = this._parseRowAsArray
      this.parseRawRow = this._parseRawRowAsArray
    }
    this._prebuiltEmptyResultObject = null
  }

  get prefersRawInt4(): boolean {
    return this._prefersRawInt4
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
    if (this._int4Reader) return this._int4Reader(buffer, offset) as R
    const row = new Array<unknown>(fieldCount)
    offset += 2
    for (let i = 0; i < fieldCount; i++) {
      const length = buffer.readInt32BE(offset)
      offset += 4
      let value: unknown = null
      if (length !== -1) {
        if (this._textInt4[i]) {
          value = this._parseTextInt4({ buffer, offset, length, parser: this._parsers![i] })
        } else {
          const rawValue =
            this.fields[i].format === 'binary'
              ? buffer.subarray(offset, offset + length)
              : buffer.toString('utf8', offset, offset + length)
          value = this._parsers![i](rawValue)
        }
        offset += length
      }
      row[i] = value
    }
    return row as unknown as R
  }

  parseRawRow({ buffer, offset, fieldCount }: Pick<RawDataRowMessage, 'buffer' | 'offset' | 'fieldCount'>): R {
    this._assertFieldCount(fieldCount)
    if (this._int4Reader) return this._int4Reader(buffer, offset) as R
    const row = { ...this._prebuiltEmptyResultObject }
    offset += 2
    for (let i = 0; i < fieldCount; i++) {
      const length = buffer.readInt32BE(offset)
      offset += 4
      let value: unknown = null
      if (length !== -1) {
        if (this._textInt4[i]) {
          value = this._parseTextInt4({ buffer, offset, length, parser: this._parsers![i] })
        } else {
          const rawValue =
            this.fields[i].format === 'binary'
              ? buffer.subarray(offset, offset + length)
              : buffer.toString('utf8', offset, offset + length)
          value = this._parsers![i](rawValue)
        }
        offset += length
      }
      row[this.fields[i].name] = value
    }
    return row as unknown as R
  }

  private _parseTextInt4({
    buffer,
    offset,
    length,
    parser,
  }: {
    buffer: Buffer
    offset: number
    length: number
    parser: ValueParser
  }): unknown {
    if (length < 1 || length > 11) return parser(buffer.toString('utf8', offset, offset + length))
    const end = offset + length
    const negative = buffer[offset] === 45
    let position = offset + (negative ? 1 : 0)
    if (position === end) return parser(buffer.toString('utf8', offset, end))
    let value = 0
    for (; position < end; position++) {
      const digit = buffer[position] - 48
      if (digit < 0 || digit > 9) return parser(buffer.toString('utf8', offset, end))
      value = value * 10 + digit
    }
    if (value > (negative ? 2147483648 : 2147483647)) return parser(buffer.toString('utf8', offset, end))
    return negative ? -value : value
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
    this._textInt4 = new Array(fieldDescriptions.length)
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
      this._textInt4[i] = desc.dataTypeID === 23 && desc.format !== 'binary' && this._parsers![i] === int4TextParser
    }

    this._prefersRawInt4 = fieldDescriptions.length > 0 && this._textInt4.every(Boolean)
    this._int4Reader = this._prefersRawInt4
      ? int4Readers.get({ names: fieldDescriptions.map((field) => field.name), rowAsArray: this.rowAsArray })
      : undefined
    this._prebuiltEmptyResultObject = { ...row }
  }
}

export = Result
