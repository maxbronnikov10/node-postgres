import type { ConnectionOptions, PeerCertificate } from 'node:tls'
import type { Duplex } from 'node:stream'
import type { EventEmitter } from 'node:events'
import type { BackendMessage, Field, RawDataRowMessage } from 'pg-protocol/dist/messages'
import type Connection = require('./connection')
import type Query = require('./query')
import type Result = require('./result')
import type ConnectionParameters = require('./connection-parameters')
import resultBudget = require('./query-result-budget')

export type QueryResultRow = Record<string, unknown>
export type RowMode = 'array' | 'object'
export type TypeFormat = 'text' | 'binary'
export type TextParser = (value: string) => unknown
export type BinaryParser = (value: Buffer) => unknown
export type ValueParser = (value: string | Buffer) => unknown

export interface CustomTypesConfig {
  getTypeParser(oid: number, format?: TypeFormat): TextParser | BinaryParser
}

export interface TypeParserRegistry extends CustomTypesConfig {
  getTypeParser<T = unknown>(oid: number, format?: 'text'): (value: string) => T
  getTypeParser<T = unknown>(oid: number, format: 'binary'): (value: Buffer) => T
  getTypeParser<T = unknown>(oid: number, format?: TypeFormat): ((value: string) => T) | ((value: Buffer) => T)
  setTypeParser(oid: number, parser: TextParser): void
  setTypeParser(oid: number, format: 'text', parser: TextParser): void
  setTypeParser(oid: number, format: 'binary', parser: BinaryParser): void
}

export type Password =
  | string
  | null
  | ((parameters: ConnectionParameters) => string | undefined | Promise<string | undefined>)
export type SslOptions = ConnectionOptions & {
  sslmode?: string | boolean
  sslca?: string
  sslkey?: string
  sslcert?: string
  sslrootcert?: string
}

export interface SocketStream extends Duplex {
  readonly writableNeedDrain?: boolean
  connect(port: number | string, host?: string): this | void
  setNoDelay(noDelay?: boolean): this | void
  setKeepAlive(enable?: boolean, initialDelay?: number): this | void
  ref(): this | void
  unref(): this | void
  startTls?(options: ConnectionOptions): void
  getPeerCertificate?(): PeerCertificate
  readonly authorized?: boolean
  readonly alpnProtocol?: string | false | null
}

export interface ClientConfig {
  connectionString?: string
  user?: string
  database?: string
  password?: Password
  port?: number
  host?: string
  ssl?: boolean | SslOptions
  sslnegotiation?: 'postgres' | 'direct'
  application_name?: string
  fallback_application_name?: string
  options?: string
  client_encoding?: string
  replication?: string | boolean
  statement_timeout?: number | false
  lock_timeout?: number | false
  idle_in_transaction_session_timeout?: number | false
  query_timeout?: number | false
  connectionTimeoutMillis?: number
  keepAlive?: boolean
  keepAliveInitialDelayMillis?: number
  binary?: boolean
  types?: CustomTypesConfig
  stream?: SocketStream | ((config: ConnectionConfig) => SocketStream)
  connection?: Connection
  pipeline?: boolean
  autoBatch?: boolean
  maxAutoPrepare?: number
  maxMessageSize?: number
  enableChannelBinding?: boolean
  scramMaxIterations?: number | string
  parseInputDatesAsUTC?: boolean
  nativeConnectionString?: string
  Promise?: PromiseConstructor
}

export interface ConnectionConfig {
  stream?: ClientConfig['stream']
  ssl?: ClientConfig['ssl']
  sslNegotiation?: ClientConfig['sslnegotiation']
  keepAlive?: boolean
  keepAliveInitialDelayMillis?: number
  encoding?: BufferEncoding
  maxMessageSize?: number
}

export interface QueryResult<R extends object = QueryResultRow> {
  command: string | null
  rowCount: number | null
  oid: number | null
  rows: R[]
  fields: Field[]
}

export type QueryArrayResult<R extends unknown[] = unknown[]> = QueryResult<R>
export interface ResultBuilder<R extends object = QueryResultRow> extends QueryResult<R> {
  addRow(row: R): void
}
export type QueryResults<R extends object = QueryResultRow> = Result<R> | Result<R>[]
export type QueryCallback<R extends object = QueryResultRow> = (error: PgError | null, result?: QueryResults<R>) => void

export interface BufferedQuery {
  _discardResult(error?: Error): void
}

export interface QueryConfig {
  text?: string
  values?: readonly unknown[]
  name?: string
  binary?: boolean
  rowMode?: RowMode
  queryMode?: 'simple' | 'extended'
  types?: CustomTypesConfig | readonly number[]
  query_timeout?: number | false
  rows?: number
  portal?: string
  callback?: QueryCallback
  pipeline?: boolean
  autoBatch?: boolean
  [resultBudget]?: (query: BufferedQuery) => (message: BackendMessage) => boolean
}

export interface QueryArrayConfig extends QueryConfig {
  rowMode: 'array'
}

export interface IndependentQueryConfig
  extends Omit<
    QueryConfig,
    'callback' | 'portal' | 'rows' | 'pipeline' | 'autoBatch' | 'queryMode' | 'types' | 'query_timeout'
  > {
  text: string
  queryMode?: 'extended'
  types?: CustomTypesConfig
  query_timeout?: number
  signal?: AbortSignal
}

export interface QueryExecutorEndpoint {
  host: string
  port?: number
  ssl?: ClientConfig['ssl']
  sslnegotiation?: ClientConfig['sslnegotiation']
}

export interface QueryExecutorOptions extends Omit<ClientConfig, 'query_timeout' | 'pipeline' | 'autoBatch'> {
  max?: number
  maxInFlightPerConnection?: number
  maxPending?: number
  maxResultRows?: number
  maxResultBytes?: number
  query_timeout?: number
  pipeline?: true
  autoBatch?: false
  endpoints?: readonly QueryExecutorEndpoint[]
  targetSessionAttrs?: 'any' | 'read-write' | 'read-only'
}

export interface PgError extends Error {
  code?: string
  severity?: string
  batchIndex?: number
}

export interface Notification {
  processId: number
  channel: string
  payload?: string
}

export interface Submittable {
  submit(connection: Connection): Error | null | void
}

export interface ExecutableQuery extends EventEmitter, Submittable {
  text?: string
  name?: string
  values?: readonly unknown[]
  rows?: number
  portal?: string
  types?: QueryConfig['types']
  binary?: boolean
  _autoBatch?: boolean
  queryMode?: string
  callback?: QueryCallback
  _result?: Result | null
  _results?: QueryResults | null
  _canceledDueToError?: Error | false
  _autoPreparedEntry?: { name: string; users: number; ready: boolean }
  requiresPreparation(): boolean | undefined
  handleError(error: PgError, connection?: Connection): void
  handleReadyForQuery(connection: Connection): void
  handleRowDescription(message: { fields: Field[]; length: number; name: BackendMessage['name'] }): void
  handleDataRow(
    message: RawDataRowMessage | { fields: (string | Buffer | null)[]; length: number; name: BackendMessage['name'] }
  ): void
  handleCommandComplete(
    message: { text: string; length: number; name: BackendMessage['name'] },
    connection: Connection
  ): void
  handleEmptyQuery(connection: Connection): void
  handlePortalSuspended(connection: Connection): void
  handleCopyInResponse(connection: Connection): void
  handleCopyData(message: { chunk: Buffer }, connection: Connection): void
}

export type QueryInput = string | QueryConfig | Submittable | Query
export type FieldDef = Field
