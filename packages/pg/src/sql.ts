'use strict'

import { QueryExecutor, QueryExecutorError } from './query-executor'
import { submitQuery, type SqlQueryConfig } from './query-submission'
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

type SqlFragment =
  | { kind: 'tag'; strings: readonly string[]; values: readonly unknown[]; scalarText?: string }
  | { kind: 'unsafe'; text: string; values: readonly unknown[] }
type SqlSubmission = {
  config: SqlQueryConfig
  resolve: (result: QueryResult) => void
  reject: (reason: unknown) => void
}
type RunQuery = (submission: SqlSubmission) => void

class SqlTextCache {
  private readonly entries = new Map<readonly string[], { text: string; expiresAt: number }>()

  get(strings: readonly string[]): string {
    const now = Date.now()
    const cached = this.entries.get(strings)
    if (cached && cached.expiresAt > now) return cached.text
    if (cached) this.entries.delete(strings)
    let text = strings[0]
    for (let i = 1; i < strings.length; i++) text += '$' + i + strings[i]
    if (Object.isFrozen(strings) && text.length <= 16384) {
      if (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!)
      this.entries.set(strings, { text, expiresAt: now + 300000 })
    }
    return text
  }
}

const sqlTexts = new SqlTextCache()

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
    private readonly fragment: SqlFragment
  ) {}

  private compile(offset = 0): { text: string; values: readonly unknown[] } {
    this.scope.assertOpen()
    const fragment = this.fragment
    if (fragment.kind === 'unsafe') return { text: fragment.text, values: fragment.values }
    if (offset === 0 && fragment.scalarText !== undefined) {
      return { text: fragment.scalarText, values: fragment.values }
    }
    const values: unknown[] = []
    let text = fragment.strings[0]
    for (let i = 0; i < fragment.values.length; i++) {
      const part = fragment.values[i]
      if (part instanceof SqlIdentifier) {
        text += part.toString()
      } else if (part instanceof PendingQuery) {
        part.scope.assertOpen()
        if (part.fragment.kind === 'unsafe' && part.fragment.values.length) {
          throw new TypeError('Parameterized unsafe queries cannot be nested')
        }
        const nested = part.compile(offset + values.length)
        text += nested.text
        for (const value of nested.values) values.push(value)
      } else {
        values.push(part)
        text += '$' + (offset + values.length)
      }
      text += fragment.strings[i + 1]
    }
    return { text, values }
  }

  execute(): Promise<SqlRows<R>> {
    if (!this.promise) {
      this.promise = new Promise<SqlRows<R>>((resolve, reject) => {
        const { text, values } = this.compile()
        this.scope.run({
          config: { text, values, rowMode: this.rowMode, queryMode: 'extended' },
          resolve: (result) => {
            try {
              const rows = result.rows as SqlRows<R>
              Object.defineProperty(rows, 'count', { value: result.rowCount })
              Object.defineProperty(rows, 'command', { value: result.command })
              Object.defineProperty(rows, 'columns', { value: result.fields })
              resolve(rows)
            } catch (cause) {
              reject(cause)
            }
          },
          reject,
        })
      })
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

  run(submission: SqlSubmission): void {
    this.assertOpen()
    if (this.mode === 'independent') return this.runner(submission)
    const result = this.tail.then(
      () =>
        new Promise<QueryResult>((resolve, reject) => {
          this.runner({ config: submission.config, resolve, reject })
        })
    )
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    result.then(submission.resolve, submission.reject)
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
      if (
        !Array.isArray(strings) ||
        !Array.isArray(strings.raw) ||
        strings.length !== values.length + 1 ||
        !strings.every((part) => typeof part === 'string')
      ) {
        throw new TypeError('Expected a SQL template literal')
      }
      const scalarText = values.some((value) => value instanceof PendingQuery || value instanceof SqlIdentifier)
        ? undefined
        : sqlTexts.get(strings)
      return new PendingQuery<R>(this, {
        kind: 'tag',
        strings: Object.isFrozen(strings) ? strings : strings.slice(),
        values,
        scalarText,
      })
    }
    return Object.assign(tag, {
      identifier: (...parts: string[]) => new SqlIdentifier(parts),
      unsafe: <R extends object = QueryResultRow>(text: string, values?: readonly unknown[]) => {
        this.assertOpen()
        if (typeof text !== 'string' || !text.trim() || (values !== undefined && !Array.isArray(values))) {
          throw new TypeError('Expected SQL text and an optional values array')
        }
        return new PendingQuery<R>(this, { kind: 'unsafe', text, values: values?.slice() ?? [] })
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
  const scope = new SqlScope(({ config, resolve, reject }) => executor[submitQuery]({ config, resolve, reject }))
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
      const transaction = new SqlScope(({ config, resolve, reject }) => {
        query(config).then(resolve, reject)
      }, 'transaction')
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
