import type { EventEmitter } from 'events'
import type TypeOverrides = require('../type-overrides')
import type { ClientConfig, PgError, QueryConfig, QueryResultRow } from '../types'

export type PreparedValue = string | Buffer | null | undefined

export interface NativeResult<R extends object = QueryResultRow> {
  command: string | undefined
  rowCount: number | undefined
  rows: R[]
  fields: { name: string; dataTypeID: number }[]
}

export type NativeResults<R extends object = QueryResultRow> = NativeResult<R> | NativeResult<R>[]
export type NativeRows<R extends object = QueryResultRow> = R[] | R[][]
export type NativeQueryCallback<R extends object = QueryResultRow> = (
  error: PgError | null | undefined,
  result?: NativeResults<R> | null
) => void
export type NativeAfter = (error?: PgError | null, rows?: NativeRows, results?: NativeResults) => void
export type NativeEndCallback = (error?: Error | null) => void

export interface NativeQueryConfig<R extends object = QueryResultRow> extends Omit<QueryConfig, 'callback'> {
  callback?: NativeQueryCallback<R>
}

export interface NativeClientConfig extends ClientConfig {
  nativeConnectionString?: string
}

export interface NativePipelineEntry {
  text?: string
  name?: string
  arrayMode?: boolean
  values?: PreparedValue[]
  _alreadyPrepared?: boolean
}

export interface NativePipelineResult {
  err?: PgError | null
  rows: object[] | null
  result: NativeResult | null
}

export interface NativeBinding extends EventEmitter {
  arrayMode: boolean
  pq: { resultErrorFields(): Record<string, string> | undefined }
  connect(connectionString: string, callback: (this: unknown, error?: Error | null) => void): void
  end(callback?: NativeEndCallback): void
  query(text: string | undefined, callback: NativeAfter): void
  query(text: string | undefined, values: readonly PreparedValue[] | undefined, callback: NativeAfter): void
  execute(name: string, values: readonly PreparedValue[] | undefined, callback: NativeAfter): unknown
  prepare(name: string, text: string | undefined, count: number, callback: NativeEndCallback): unknown
  pipeline(
    queries: NativePipelineEntry[],
    callback: (error: PgError | null, results: NativePipelineResult[]) => void
  ): void
  cancel(callback: NativeEndCallback): void
  getTransactionStatus(): 'I' | 'T' | 'E' | null
}

export interface NativeBindingConstructor {
  new (options: { types: TypeOverrides }): NativeBinding
}

export type NativeNormalize = (
  config?: string | NativeQueryConfig,
  values?: readonly unknown[] | NativeQueryCallback,
  callback?: NativeQueryCallback
) => NativeQueryConfig
