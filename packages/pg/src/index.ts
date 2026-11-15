/* eslint-disable @typescript-eslint/no-redeclare -- Public constructors share value and instance type names. */
import ClientClass = require('./client')
import defaultsValue = require('./defaults')
import ConnectionClass = require('./connection')
import ResultClass = require('./result')
import utilsValue = require('./utils')
import PoolClass = require('pg-pool')
import TypeOverridesClass = require('./type-overrides')
import postgresFactory from './sql'
import type { ClientConfig, TypeParserRegistry } from './types'
import { QueryExecutor as QueryExecutorClass, QueryExecutorError as QueryExecutorErrorClass } from './query-executor'

const { DatabaseError: DatabaseErrorClass } = require('pg-protocol') as typeof import('pg-protocol')
const { escapeIdentifier: escapeIdentifierValue, escapeLiteral: escapeLiteralValue } = utilsValue
const typesValue = require('pg-types') as Omit<typeof import('pg-types'), 'getTypeParser' | 'setTypeParser'> &
  TypeParserRegistry

type PoolOptions<C extends PoolClass.Client> = Omit<PoolClass.PoolConfig<C>, keyof ClientConfig> & ClientConfig

type BoundPoolConstructor<C extends PoolClass.Client> = Omit<typeof PoolClass, 'prototype'> & {
  new (options?: PoolOptions<C>): PoolClass<C>
  readonly prototype: PoolClass<C>
}

const poolFactory = <C extends PoolClass.Client>(Client: new (config?: never) => C): BoundPoolConstructor<C> => {
  return class BoundPool extends PoolClass<C> {
    constructor(options?: PoolOptions<C>) {
      super(options as PoolClass.PoolConfig<C>, Client as PoolClass.ClientConstructor<C>)
    }
  }
}

class PG {
  defaults: typeof defaultsValue
  Client: typeof ClientClass
  Query: typeof ClientClass.Query
  Pool: ReturnType<typeof poolFactory<ClientClass>>
  QueryExecutor?: typeof QueryExecutorClass
  QueryExecutorError?: typeof QueryExecutorErrorClass
  _pools: unknown[]
  Connection: typeof ConnectionClass
  types: typeof typesValue
  DatabaseError: typeof DatabaseErrorClass
  TypeOverrides: typeof TypeOverridesClass
  escapeIdentifier: typeof escapeIdentifierValue
  escapeLiteral: typeof escapeLiteralValue
  Result: typeof ResultClass
  utils: typeof utilsValue

  constructor(clientConstructor: typeof ClientClass) {
    this.defaults = defaultsValue
    this.Client = clientConstructor
    this.Query = this.Client.Query
    this.Pool = poolFactory(this.Client)
    if (clientConstructor === ClientClass) {
      this.QueryExecutor = QueryExecutorClass
      this.QueryExecutorError = QueryExecutorErrorClass
    }
    this._pools = []
    this.Connection = ConnectionClass
    this.types = typesValue
    this.DatabaseError = DatabaseErrorClass
    this.TypeOverrides = TypeOverridesClass
    this.escapeIdentifier = escapeIdentifierValue
    this.escapeLiteral = escapeLiteralValue
    this.Result = ResultClass
    this.utils = utilsValue
  }
}

const api = new PG(ClientClass)

export const defaults: typeof defaultsValue = api.defaults
export const Client = api.Client
export type Client = ClientClass
export const Query = api.Query
export type Query<R extends object = import('./types').QueryResultRow> = import('./query')<R>
export const Pool = api.Pool
export type Pool = InstanceType<typeof Pool>
export type PoolConfig = PoolOptions<ClientClass>
export type PoolClient = PoolClass.PoolClient<ClientClass>
export const QueryExecutor = api.QueryExecutor as typeof QueryExecutorClass
export type QueryExecutor = QueryExecutorClass
export const QueryExecutorError = api.QueryExecutorError as typeof QueryExecutorErrorClass
export type QueryExecutorError = QueryExecutorErrorClass
export const Connection = api.Connection
export type Connection = ConnectionClass
export const types = api.types
export const DatabaseError = api.DatabaseError
export type DatabaseError = import('pg-protocol').DatabaseError
export const TypeOverrides = api.TypeOverrides
export type TypeOverrides = TypeOverridesClass
export const escapeIdentifier = api.escapeIdentifier
export const escapeLiteral = api.escapeLiteral
export const Result = api.Result
export type Result<R extends object = import('./types').QueryResultRow> = ResultClass<R>
export const utils = api.utils
export type * from './types'

export const postgres = postgresFactory
export type { Sql, SqlOptions, SqlRows, PendingQuery, TransactionSql } from './sql'
const sqlApi = Object.assign(postgresFactory, api, { postgres: postgresFactory })
export default sqlApi
Object.defineProperty(sqlApi, 'default', { value: sqlApi })
module.exports = sqlApi
