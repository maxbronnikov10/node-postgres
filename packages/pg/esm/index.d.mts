import type * as pg from '../dist/index.js'

export {
  Client,
  Pool,
  QueryExecutor,
  QueryExecutorError,
  Connection,
  types,
  Query,
  DatabaseError,
  escapeIdentifier,
  escapeLiteral,
  Result,
  TypeOverrides,
  defaults,
} from '../dist/index.js'
export type {
  ClientConfig,
  ConnectionConfig,
  CustomTypesConfig,
  TypeParserRegistry,
  IndependentQueryConfig,
  QueryExecutorOptions,
  QueryExecutorEndpoint,
  QueryResult,
  QueryArrayResult,
  QueryConfig,
  QueryArrayConfig,
  QueryResultRow,
  QueryResults,
  QueryCallback,
  PoolConfig,
  PoolClient,
  NativeApi,
  Notification,
  FieldDef,
  Submittable,
  RowMode,
  TypeFormat,
  TextParser,
  BinaryParser,
  Password,
  SslOptions,
} from '../dist/index.js'

declare const api: typeof pg
export default api
