import type { BufferReader } from './buffer-reader'

export type Mode = 'text' | 'binary'

export type MessageName =
  | 'parseComplete'
  | 'bindComplete'
  | 'closeComplete'
  | 'noData'
  | 'portalSuspended'
  | 'replicationStart'
  | 'emptyQuery'
  | 'copyDone'
  | 'copyData'
  | 'rowDescription'
  | 'parameterDescription'
  | 'parameterStatus'
  | 'backendKeyData'
  | 'notification'
  | 'readyForQuery'
  | 'commandComplete'
  | 'dataRow'
  | 'copyInResponse'
  | 'copyOutResponse'
  | 'authenticationOk'
  | 'authenticationMD5Password'
  | 'authenticationCleartextPassword'
  | 'authenticationSASL'
  | 'authenticationSASLContinue'
  | 'authenticationSASLFinal'
  | 'error'
  | 'notice'

export interface BackendMessage {
  name: MessageName
  length: number
}

export const parseComplete: BackendMessage = {
  name: 'parseComplete',
  length: 5,
}

export const bindComplete: BackendMessage = {
  name: 'bindComplete',
  length: 5,
}

export const closeComplete: BackendMessage = {
  name: 'closeComplete',
  length: 5,
}

export const noData: BackendMessage = {
  name: 'noData',
  length: 5,
}

export const portalSuspended: BackendMessage = {
  name: 'portalSuspended',
  length: 5,
}

export const replicationStart: BackendMessage = {
  name: 'replicationStart',
  length: 4,
}

export const emptyQuery: BackendMessage = {
  name: 'emptyQuery',
  length: 4,
}

export const copyDone: BackendMessage = {
  name: 'copyDone',
  length: 4,
}

interface NoticeOrError {
  message: string | undefined
  severity: string | undefined
  code: string | undefined
  detail: string | undefined
  hint: string | undefined
  position: string | undefined
  internalPosition: string | undefined
  internalQuery: string | undefined
  where: string | undefined
  schema: string | undefined
  table: string | undefined
  column: string | undefined
  dataType: string | undefined
  constraint: string | undefined
  file: string | undefined
  line: string | undefined
  routine: string | undefined
}

export class DatabaseError extends Error implements NoticeOrError {
  public severity: string | undefined
  public code: string | undefined
  public detail: string | undefined
  public hint: string | undefined
  public position: string | undefined
  public internalPosition: string | undefined
  public internalQuery: string | undefined
  public where: string | undefined
  public schema: string | undefined
  public table: string | undefined
  public column: string | undefined
  public dataType: string | undefined
  public constraint: string | undefined
  public file: string | undefined
  public line: string | undefined
  public routine: string | undefined
  constructor(
    message: string,
    public readonly length: number,
    public readonly name: MessageName
  ) {
    super(message)
  }
}

export class CopyDataMessage {
  public readonly name = 'copyData'
  constructor(
    public readonly length: number,
    public readonly chunk: Buffer
  ) {}
}

export class CopyResponse {
  public readonly columnTypes: number[]
  constructor(
    public readonly length: number,
    public readonly name: MessageName,
    public readonly binary: boolean,
    columnCount: number
  ) {
    this.columnTypes = new Array(columnCount)
  }
}

export class Field {
  constructor(
    public readonly name: string,
    public readonly tableID: number,
    public readonly columnID: number,
    public readonly dataTypeID: number,
    public readonly dataTypeSize: number,
    public readonly dataTypeModifier: number,
    public readonly format: Mode
  ) {}
}

export class RowDescriptionMessage {
  public readonly name: MessageName = 'rowDescription'
  public readonly fields: Field[]
  constructor(
    public readonly length: number,
    public readonly fieldCount: number
  ) {
    this.fields = new Array(this.fieldCount)
  }
}

export class ParameterDescriptionMessage {
  public readonly name: MessageName = 'parameterDescription'
  public readonly dataTypeIDs: number[]
  constructor(
    public readonly length: number,
    public readonly parameterCount: number
  ) {
    this.dataTypeIDs = new Array(this.parameterCount)
  }
}

export class ParameterStatusMessage {
  public readonly name: MessageName = 'parameterStatus'
  constructor(
    public readonly length: number,
    public readonly parameterName: string,
    public readonly parameterValue: string
  ) {}
}

export class AuthenticationMD5Password implements BackendMessage {
  public readonly name: MessageName = 'authenticationMD5Password'
  constructor(
    public readonly length: number,
    public readonly salt: Buffer
  ) {}
}

export class BackendKeyDataMessage {
  public readonly name: MessageName = 'backendKeyData'
  constructor(
    public readonly length: number,
    public readonly processID: number,
    public readonly secretKey: number
  ) {}
}

export class NotificationResponseMessage {
  public readonly name: MessageName = 'notification'
  constructor(
    public readonly length: number,
    public readonly processId: number,
    public readonly channel: string,
    public readonly payload: string
  ) {}
}

export class ReadyForQueryMessage {
  public readonly name: MessageName = 'readyForQuery'
  constructor(
    public readonly length: number,
    public readonly status: string
  ) {}
}

export class CommandCompleteMessage {
  public readonly name: MessageName = 'commandComplete'
  constructor(
    public readonly length: number,
    public readonly text: string
  ) {}
}

export class ProtocolError extends Error {
  public readonly name = 'ProtocolError'
  public readonly code = 'PG_PROTOCOL_ERROR'
}

/** @internal Borrowed only for the duration of DataRowConsumer.handleDataRow; never retain this frame or its buffer. */
export interface BorrowedDataRow {
  readonly name: 'dataRow'
  length: number
  buffer: Buffer
  offset: number
  fieldCount: number
}

export class RawDataRowMessage {
  public readonly name = 'dataRow'
  public readonly fieldCount: number
  public readonly buffer: Buffer
  public readonly offset: number

  constructor(
    public length: number,
    reader: BufferReader
  ) {
    this.buffer = reader.getBuffer()
    this.offset = reader.getOffset()
    this.fieldCount = RawDataRowMessage.validate(reader, length)
  }

  /** @internal Validate before exposing either owned messages or borrowed frames. */
  static validate(reader: BufferReader, length: number): number {
    const buffer = reader.getBuffer()
    let offset = reader.getOffset()
    const end = offset + length - 4
    if (offset + 2 > end) throw new ProtocolError('DataRow is missing its field count')
    const fieldCount = buffer.readUInt16BE(offset)
    offset += 2
    for (let i = 0; i < fieldCount; i++) {
      if (offset + 4 > end) throw new ProtocolError('DataRow is missing a field length')
      const length = buffer.readInt32BE(offset)
      offset += 4
      if (length < -1 || (length >= 0 && length > end - offset)) {
        throw new ProtocolError('DataRow field length is outside its payload')
      }
      if (length !== -1) offset += length
    }
    if (offset !== end) throw new ProtocolError('DataRow contains trailing bytes')
    return fieldCount
  }

  get raw(): Buffer {
    const raw = this.buffer.subarray(this.offset, this.offset + this.length - 4)
    Object.defineProperty(this, 'raw', { value: raw, enumerable: true })
    return raw
  }

  get fields(): (string | null)[] {
    const fields = new Array<string | null>(this.fieldCount)
    let offset = this.offset + 2
    for (let i = 0; i < this.fieldCount; i++) {
      const length = this.buffer.readInt32BE(offset)
      offset += 4
      fields[i] = length === -1 ? null : this.buffer.toString('utf8', offset, offset + length)
      if (length !== -1) offset += length
    }
    Object.defineProperty(this, 'fields', { value: fields, enumerable: true, writable: true })
    return fields
  }
}

export class DataRowMessage {
  public readonly fieldCount: number
  public readonly name: MessageName = 'dataRow'
  constructor(
    public length: number,
    public fields: any[]
  ) {
    this.fieldCount = fields.length
  }
}

export class NoticeMessage implements BackendMessage, NoticeOrError {
  constructor(
    public readonly length: number,
    public readonly message: string | undefined
  ) {}
  public readonly name = 'notice'
  public severity: string | undefined
  public code: string | undefined
  public detail: string | undefined
  public hint: string | undefined
  public position: string | undefined
  public internalPosition: string | undefined
  public internalQuery: string | undefined
  public where: string | undefined
  public schema: string | undefined
  public table: string | undefined
  public column: string | undefined
  public dataType: string | undefined
  public constraint: string | undefined
  public file: string | undefined
  public line: string | undefined
  public routine: string | undefined
}
