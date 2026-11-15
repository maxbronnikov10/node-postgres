import postgres from 'pg'
import type { PendingQuery, Sql, SqlOptions, SqlRows, TransactionSql } from 'pg'

interface User {
  id: number
  name: string
}

export async function commonJsSql() {
  const options: SqlOptions = { max: 2, username: 'postgres', max_pipeline: 4, prepare: false }
  const sql: Sql = postgres(options)
  const pending: PendingQuery<User> = sql<User>`SELECT ${1} AS id, ${'Ada'} AS name`
  const rows: SqlRows<User> = await pending
  const user: User = await pending.one()
  const optional: User | null = await pending.maybeOne()
  const tuples: SqlRows<[number, string]> = await sql`SELECT 1, 'Ada'`.values<[number, string]>()
  const unsafe: SqlRows<User> = await sql.unsafe<User>('SELECT $1 AS id, $2 AS name', [1, 'Ada'] as const)
  const count: number | null = rows.count
  const column: string = rows.columns[0].name
  const inferred: number = await sql.begin(async (tx: TransactionSql) => {
    await tx`SELECT ${sql.identifier('public', 'users')} FROM ${sql('public.users')}`
    // @ts-expect-error Transactions cannot nest through the scoped API.
    tx.begin(() => 1)
    // @ts-expect-error A transaction cannot close the executor.
    tx.end()
    return 7
  })
  // @ts-expect-error Typed rows have no undeclared property.
  user.missing
  // @ts-expect-error Identifiers require strings.
  sql.identifier(1)
  // @ts-expect-error Pipeline limits require a number.
  postgres({ max_pipeline: '4' })
  // @ts-expect-error Query strings with parameters require unsafe or a template literal.
  sql('SELECT $1', [1])
  await sql.end()
  return { rows, user, optional, tuples, unsafe, count, column, inferred }
}
