'use strict'

import { QueryExecutor, QueryExecutorError } from './query-executor'
import { escapeIdentifier } from './utils'
import type { Field } from 'pg-protocol/dist/messages'
import type { IndependentQueryConfig, QueryExecutorOptions, QueryResult, QueryResultRow } from './types'

export interface SqlOptions extends QueryExecutorOptions {
  username?: string
  prepare?: boolean
  max_pipeline?: number
}

export type SqlRows<R extends object = QueryResultRow> = R[] & {
  readonly count: number | null
  readonly command: string | null
  readonly columns: Field[]
}

export interface TransactionSql {
  <R extends object = QueryResultRow>(strings: TemplateStringsArray, ...values: unknown[]): PendingQuery<R>
  (identifier: string): SqlIdentifier
  identifier(...parts: string[]): SqlIdentifier
  unsafe<R extends object = QueryResultRow>(text: string, values?: readonly unknown[]): PendingQuery<R>
}

export interface Sql extends TransactionSql {
  begin<T>(callback: (sql: TransactionSql) => T | PromiseLike<T>): Promise<T>
  end(): Promise<void>
}

type FragmentPart = string | { value: unknown } | SqlIdentifier
type Part = FragmentPart | PendingQuery<object>
type RunQuery = (config: IndependentQueryConfig) => Promise<QueryResult>

export class SqlIdentifier {
  private readonly text: string

  constructor(parts: readonly string[]) {
    if (!parts.length || parts.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) {
      throw new TypeError('Expected nonempty identifier parts without NUL bytes')
    }
    this.text = parts.map(escapeIdentifier).join('.')
  }

  toString(): string {
    return this.text
  }
}

export class PendingQuery<R extends object = QueryResultRow> implements PromiseLike<SqlRows<R>> {
  private promise?: Promise<SqlRows<R>>
  private rowMode: 'object' | 'array' = 'object'

  constructor(
    private readonly scope: SqlScope,
    private readonly fragment: { parts: readonly Part[]; unsafeValues?: readonly unknown[] }
  ) {}

  private flatten(): readonly FragmentPart[] {
    this.scope.assertOpen()
    if (this.fragment.unsafeValues?.length) throw new TypeError('Parameterized unsafe queries cannot be nested')
    return this.fragment.parts.flatMap((part) => (part instanceof PendingQuery ? part.flatten() : [part]))
  }

  private compile(): { text: string; values: unknown[] } {
    this.scope.assertOpen()
    if (this.fragment.unsafeValues !== undefined) {
      return { text: this.fragment.parts[0] as string, values: this.fragment.unsafeValues.slice() }
    }
    const values: unknown[] = []
    const text = this.flatten()
      .map((part) => {
        if (typeof part === 'string') return part
        if (part instanceof SqlIdentifier) return part.toString()
        values.push(part.value)
        return '$' + values.length
      })
      .join('')
    return { text, values }
  }

  execute(): Promise<SqlRows<R>> {
    if (!this.promise) {
      this.promise = (async () => {
        const { text, values } = this.compile()
        const result = await this.scope.run({ text, values, rowMode: this.rowMode, queryMode: 'extended' })
        return Object.defineProperties(result.rows, {
          count: { value: result.rowCount },
          command: { value: result.command },
          columns: { value: result.fields },
        }) as SqlRows<R>
      })()
    }
    return this.promise
  }

  then<T = SqlRows<R>, U = never>(
    fulfilled?: ((rows: SqlRows<R>) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null
  ): Promise<T | U> {
    return this.execute().then(fulfilled, rejected)
  }

  catch<T = never>(rejected?: ((reason: unknown) => T | PromiseLike<T>) | null): Promise<SqlRows<R> | T> {
    return this.execute().catch(rejected)
  }

  finally(onFinally?: (() => void) | null): Promise<SqlRows<R>> {
    return this.execute().finally(onFinally)
  }

  values<T extends unknown[] = unknown[]>(): PendingQuery<T> {
    if (this.promise) throw new Error('Cannot change row mode after execution has started')
    this.rowMode = 'array'
    return this as unknown as PendingQuery<T>
  }

  async one(): Promise<R> {
    const rows = await this.execute()
    if (rows.length !== 1)
      throw new QueryExecutorError({
        message: `Expected exactly one row, received ${rows.length}`,
        code: 'PG_EXECUTOR_ROW_COUNT',
        outcome: 'unknown',
      })
    return rows[0]
  }

  async maybeOne(): Promise<R | null> {
    const rows = await this.execute()
    if (rows.length > 1)
      throw new QueryExecutorError({
        message: `Expected at most one row, received ${rows.length}`,
        code: 'PG_EXECUTOR_ROW_COUNT',
        outcome: 'unknown',
      })
    return rows[0] ?? null
  }
}

class SqlScope {
  private active = true
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly runner: RunQuery,
    private readonly mode: 'independent' | 'transaction' = 'independent'
  ) {}

  assertOpen(): void {
    if (!this.active) throw new Error('SQL scope is closed')
  }

  close(): void {
    this.active = false
  }

  drain(): Promise<void> {
    return this.tail
  }

  run(config: IndependentQueryConfig): Promise<QueryResult> {
    this.assertOpen()
    if (this.mode === 'independent') return this.runner(config)
    const result = this.tail.then(() => this.runner(config))
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  sql(): TransactionSql {
    const tag = <R extends object = QueryResultRow>(
      strings: TemplateStringsArray | string,
      ...values: unknown[]
    ): PendingQuery<R> | SqlIdentifier => {
      this.assertOpen()
      if (typeof strings === 'string') {
        if (values.length) throw new TypeError('Use a template literal or sql.unsafe for queries')
        return new SqlIdentifier(strings.split('.'))
      }
      if (!Array.isArray(strings) || !Array.isArray(strings.raw) || strings.length !== values.length + 1) {
        throw new TypeError('Expected a SQL template literal')
      }
      const parts: Part[] = [strings[0]]
      values.forEach((value, index) => {
        parts.push(
          value instanceof PendingQuery || value instanceof SqlIdentifier ? value : { value },
          strings[index + 1]
        )
      })
      return new PendingQuery<R>(this, { parts })
    }
    return Object.assign(tag, {
      identifier: (...parts: string[]) => new SqlIdentifier(parts),
      unsafe: <R extends object = QueryResultRow>(text: string, values?: readonly unknown[]) => {
        this.assertOpen()
        if (typeof text !== 'string' || !text.trim() || (values !== undefined && !Array.isArray(values))) {
          throw new TypeError('Expected SQL text and an optional values array')
        }
        return new PendingQuery<R>(this, { parts: [text], unsafeValues: values?.slice() })
      },
    }) as TransactionSql
  }
}

export default function postgres(url?: string | SqlOptions, options?: SqlOptions): Sql {
  if (url !== undefined && typeof url !== 'string' && (!url || typeof url !== 'object' || Array.isArray(url))) {
    throw new TypeError('Expected a connection URL or SQL options')
  }
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError('Expected SQL options')
  }
  const config = {
    ...(typeof url === 'object' ? url : options),
    ...(typeof url === 'string' ? { connectionString: url } : {}),
  }
  if (config.prepare !== undefined && typeof config.prepare !== 'boolean')
    throw new TypeError('prepare must be a boolean')
  if (config.username !== undefined && typeof config.username !== 'string')
    throw new TypeError('username must be a string')
  const { username, prepare, max_pipeline, ...executorOptions } = config
  const executor = new QueryExecutor({
    ...executorOptions,
    user: executorOptions.user ?? username,
    maxAutoPrepare: prepare === false ? 0 : executorOptions.maxAutoPrepare ?? 256,
    maxInFlightPerConnection: max_pipeline ?? executorOptions.maxInFlightPerConnection,
  })
  const scope = new SqlScope((query) => executor.query(query))
  const sql = scope.sql()
  return Object.assign(sql, {
    end: () => {
      scope.close()
      return executor.end()
    },
    begin: async <T>(callback: (sql: TransactionSql) => T | PromiseLike<T>): Promise<T> => {
      scope.assertOpen()
      if (typeof callback !== 'function') throw new TypeError('Expected a transaction callback')
      const lease = await executor.reserve()
      const query = (queryConfig: IndependentQueryConfig) =>
        lease.query({ ...queryConfig, query_timeout: config.query_timeout ?? 30000, queryMode: 'extended' })
      const transaction = new SqlScope(query, 'transaction')
      try {
        await query({ text: 'BEGIN' })
        const value = await callback(transaction.sql())
        transaction.close()
        await transaction.drain()
        let committed: QueryResult
        try {
          committed = await query({ text: 'COMMIT' })
        } catch (cause) {
          throw new QueryExecutorError({
            message: 'Transaction commit failed',
            code: undefined,
            outcome: 'unknown',
            cause,
          })
        }
        if (committed.command !== 'COMMIT') throw new Error('Transaction was rolled back instead of committed')
        return value
      } catch (cause) {
        transaction.close()
        await transaction.drain()
        try {
          await query({ text: 'ROLLBACK' })
        } catch {
          throw new QueryExecutorError({
            message: 'Transaction rollback failed',
            code: undefined,
            outcome: 'unknown',
            cause,
          })
        }
        throw cause
      } finally {
        lease.release()
      }
    },
  })
}
