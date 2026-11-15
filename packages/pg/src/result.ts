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
let int8TextParser: ValueParser | undefined
let boolTextParser: ValueParser | undefined
textParsers.init((oid, parser) => {
  if (oid === 23) int4TextParser = parser
  if (oid === 20) int8TextParser = parser
  if (oid === 16) boolTextParser = parser
})

const matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/
const supportsUtf8Slice = typeof (Buffer.prototype as Buffer & { utf8Slice?: unknown }).utf8Slice === 'function'

type RawInt4Reader = (this: Result<object>, buffer: Buffer, offset: number) => object
type TextRowReader = (this: Result<object>, rowData: readonly (string | Buffer | null)[]) => object
type ReaderOptions = { names: readonly string[]; rowAsArray: boolean }
type CachedRawTextReader = {
  factory: (originalBool: ValueParser | undefined, ...parsers: ValueParser[]) => RawInt4Reader
  variants: { parsers: ValueParser[]; reader: RawInt4Reader }[]
  expiresAt: number
}

class RowReaderCache {
  private readonly readers = new Map<
    string,
    { reader: RawInt4Reader | TextRowReader; expiresAt: number } | CachedRawTextReader
  >()
  private disabled = false

  get(options: ReaderOptions & { mode: 'int4' }): RawInt4Reader | undefined
  get(options: ReaderOptions & { mode: 'text' }): TextRowReader | undefined
  get(
    options: ReaderOptions & {
      mode: 'raw-text'
      int4: readonly boolean[]
      int8: readonly boolean[]
      bool: readonly boolean[]
      parsers: readonly ValueParser[]
    }
  ): RawInt4Reader | undefined
  get({
    names,
    rowAsArray,
    mode,
    int4,
    int8,
    bool,
    parsers,
  }: ReaderOptions & {
    mode: 'int4' | 'text' | 'raw-text'
    int4?: readonly boolean[]
    int8?: readonly boolean[]
    bool?: readonly boolean[]
    parsers?: readonly ValueParser[]
  }): RawInt4Reader | TextRowReader | undefined {
    if (this.disabled || !names.length || names.length > 32) return undefined
    const key = JSON.stringify([mode, rowAsArray, names, int4, int8, bool])
    const now = Date.now()
    const cached = this.readers.get(key)
    if (cached && cached.expiresAt > now) {
      return 'reader' in cached ? cached.reader : this._getRawTextReader({ entry: cached, parsers: parsers! })
    }
    if (cached) this.readers.delete(key)
    const source = [mode === 'text' ? '"use strict";' : '"use strict"; offset += 2;']
    const values: string[] = []
    names.forEach((name, index) => {
      let value: string
      if (mode !== 'text') {
        source.push(
          `const length${index} = buffer.readInt32BE(offset); offset += 4;`,
          `let value${index} = null;`,
          `if (length${index} !== -1) {`
        )
        if (mode === 'int4' || int4![index]) {
          source.push(
            `let first${index}, second${index}, third${index};`,
            `value${index} = length${index} >= 1 && length${index} <= 3`,
            `&& (first${index} = buffer[offset] - 48) >= 0 && first${index} <= 9`,
            `&& (length${index} === 1 || ((second${index} = buffer[offset + 1] - 48) >= 0 && second${index} <= 9))`,
            `&& (length${index} < 3 || ((third${index} = buffer[offset + 2] - 48) >= 0 && third${index} <= 9))`,
            `? (length${index} === 1 ? first${index} : length${index} === 2 ? first${index} * 10 + second${index} : (first${index} * 10 + second${index}) * 10 + third${index})`,
            `: this._parseTextInt4({ buffer, offset, length: length${index}, parser: this._parsers[${index}] });`
          )
        } else {
          const rawValue = supportsUtf8Slice
            ? `buffer.utf8Slice(offset, offset + length${index})`
            : `buffer.toString('utf8', offset, offset + length${index})`
          const parsedValue = int8![index]
            ? rawValue
            : `(this._parsers[${index}] === p${index} ? Reflect.apply(p${index}, this._parsers, [${rawValue}]) : this._parsers[${index}](${rawValue}))`
          source.push(
            `value${index} = ${
              bool![index]
                ? `length${index} === 1 && this._parsers[${index}] === originalBool && (buffer[offset] === 116 || buffer[offset] === 102) ? buffer[offset] === 116 : ${parsedValue}`
                : parsedValue
            };`
          )
        }
        source.push(`offset += length${index}; }`)
        value = `value${index}`
      } else {
        value = `rowData[${index}] === null ? null : this._parsers[${index}](rowData[${index}])`
      }
      const key = name === '__proto__' ? `[${JSON.stringify(name)}]` : JSON.stringify(name)
      values.push(rowAsArray ? value : `${key}: ${value}`)
    })
    source.push(rowAsArray ? `return [${values.join(',')}];` : `return {${values.join(',')}};`)
    let entry: { reader: RawInt4Reader | TextRowReader; expiresAt: number } | CachedRawTextReader
    try {
      // Names are JSON-escaped keys; __proto__ stays computed to define an own property.
      entry =
        mode === 'raw-text'
          ? {
              factory: new Function(
                'originalBool',
                ...names.map((_, index) => `p${index}`),
                `return function(buffer, offset) {${source.join('\n')}}`
              ) as CachedRawTextReader['factory'],
              variants: [],
              expiresAt: now + 300000,
            }
          : {
              reader: new Function(mode === 'text' ? 'rowData' : 'buffer', 'offset', source.join('\n')) as
                | RawInt4Reader
                | TextRowReader,
              expiresAt: now + 300000,
            }
    } catch (cause) {
      if (!(cause instanceof EvalError)) throw cause
      this.disabled = true
      this.readers.clear()
      return undefined
    }
    if (this.readers.size >= 128) this.readers.delete(this.readers.keys().next().value!)
    this.readers.set(key, entry)
    return 'reader' in entry ? entry.reader : this._getRawTextReader({ entry, parsers: parsers! })
  }

  private _getRawTextReader({ entry, parsers }: { entry: CachedRawTextReader; parsers: readonly ValueParser[] }) {
    const cached = entry.variants.find((variant) => variant.parsers.every((parser, index) => parser === parsers[index]))
    if (cached) return cached.reader
    const parserRefs = [...parsers]
    const reader = entry.factory(boolTextParser, ...parserRefs)
    if (entry.variants.length >= 4) entry.variants.shift()
    entry.variants.push({ parsers: parserRefs, reader })
    return reader
  }
}

const rowReaders = new RowReaderCache()

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
  private _rawTextReader: RawInt4Reader | undefined
  private _textReader: TextRowReader | undefined
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

  get supportsRawRows(): boolean {
    return this._prefersRawInt4 || this._rawTextReader !== undefined
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
    if (this._textReader) return this._textReader(rowData) as R
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
    if (this._textReader) return this._textReader(rowData) as R
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
    if (this._rawTextReader) return this._rawTextReader(buffer, offset) as R
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
    if (this._rawTextReader) return this._rawTextReader(buffer, offset) as R
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

  _getRowLayout() {
    const parsers = this._parsers?.slice() ?? []
    const parserChecks: { oid: number; format: Field['format']; parser: ValueParser }[] = []
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i]
      const format = field.format || 'text'
      const parser = parsers[i]
      if (
        !parserChecks.some(
          (check) => check.oid === field.dataTypeID && check.format === format && check.parser === parser
        )
      ) {
        parserChecks.push(Object.freeze({ oid: field.dataTypeID, format, parser }))
      }
    }
    return Object.freeze({
      parsers: Object.freeze(parsers),
      parserChecks: Object.freeze(parserChecks),
      textInt4: Object.freeze(this._textInt4.slice()),
      emptyResultObject: Object.freeze({ ...this._prebuiltEmptyResultObject }),
      prefersRawInt4: this._prefersRawInt4,
      int4Reader: this._int4Reader,
      rawTextReader: this._rawTextReader,
      textReader: this._textReader,
      rowAsArray: this.rowAsArray,
    })
  }

  _useRowLayout({ fields, layout }: { fields: Field[]; layout: ReturnType<Result['_getRowLayout']> }): boolean {
    if (layout.rowAsArray !== this.rowAsArray) return false
    const parserTypes = this._types || types
    for (const { oid, format, parser } of layout.parserChecks) {
      if (parserTypes.getTypeParser(oid, format) !== parser) return false
    }
    this.fields = fields
    this._parsers = [...layout.parsers]
    this._textInt4 = [...layout.textInt4]
    this._prebuiltEmptyResultObject = { ...layout.emptyResultObject }
    this._prefersRawInt4 = layout.prefersRawInt4
    this._int4Reader = layout.int4Reader
    this._rawTextReader = layout.rawTextReader
    this._textReader = layout.textReader
    return true
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
    const names = fieldDescriptions.map((field) => field.name)
    this._int4Reader = this._prefersRawInt4
      ? rowReaders.get({ names, rowAsArray: this.rowAsArray, mode: 'int4' })
      : undefined
    this._textReader =
      !this._prefersRawInt4 && fieldDescriptions.every((field) => field.format !== 'binary')
        ? rowReaders.get({ names, rowAsArray: this.rowAsArray, mode: 'text' })
        : undefined
    this._rawTextReader =
      !this._prefersRawInt4 && fieldDescriptions.every((field) => field.format !== 'binary')
        ? rowReaders.get({
            names,
            rowAsArray: this.rowAsArray,
            mode: 'raw-text',
            parsers: this._parsers!,
            int4: this._textInt4,
            bool: fieldDescriptions.map(
              (field, index) => field.dataTypeID === 16 && this._parsers![index] === boolTextParser
            ),
            // pg-types' original int8 parser is identity for decoded string input.
            int8: fieldDescriptions.map(
              (field, index) => field.dataTypeID === 20 && this._parsers![index] === int8TextParser
            ),
          })
        : undefined
    this._prebuiltEmptyResultObject = { ...row }
  }
}

export = Result
