import pg = require('pg')

interface User {
  id: number
  name: string
}

type UserTuple = [id: number, name: string]

export async function commonJsExample() {
  const options: pg.QueryExecutorOptions = { max: 2, maxPending: 16, maxInFlightPerConnection: 4 }
  const executor = new pg.QueryExecutor(options)
  const values = [7, 'Ada'] as const
  const config: pg.IndependentQueryConfig = {
    text: 'SELECT $1::int AS id, $2::text AS name',
    values,
  }

  const result: pg.QueryResult<User> = await executor.query<User>(config)
  const rows: User[] = await executor.rows<User>('SELECT $1::int AS id, $2::text AS name', values)
  const user: User = await executor.one<User>(config)
  const optionalUser: User | null = await executor.maybeOne<User>(config)
  const tupleRows: UserTuple[] = await executor.rows<UserTuple>({ ...config, rowMode: 'array' })
  const tuple: UserTuple = await executor.one<UserTuple>({ ...config, rowMode: 'array' })
  const optionalTuple: UserTuple | null = await executor.maybeOne<UserTuple>({ ...config, rowMode: 'array' })

  // @ts-expect-error Typed rows do not have undeclared properties.
  rows[0].missing
  // @ts-expect-error QueryExecutor accepts promises rather than callbacks.
  executor.rows('SELECT 1', () => {})
  // @ts-expect-error QueryExecutor.query also refuses the callback form.
  executor.query('SELECT 1', [], () => {})
  // @ts-expect-error Connection limits must be numeric.
  const invalidOptions: pg.QueryExecutorOptions = { max: '2' }
  void invalidOptions

  await executor.end()
  return { result, rows, user, optionalUser, tupleRows, tuple, optionalTuple }
}

export function commonJsError(error: unknown) {
  if (!(error instanceof pg.QueryExecutorError)) return null

  const code: string | undefined = error.code
  const outcome: 'not-sent' | 'unknown' | 'server-error' = error.outcome
  const safeToRetry: boolean = error.safeToRetry
  return { code, outcome, safeToRetry }
}

pg.types.setTypeParser(999999, (value) => value.toUpperCase())
const binaryParser = pg.types.getTypeParser<Buffer>(999999, 'binary')
const binaryValue: Buffer = binaryParser(Buffer.alloc(0))
void binaryValue

const customParserExecutor = new pg.QueryExecutor({
  types: {
    getTypeParser: (oid, format) => (oid === 23 && format !== 'binary' ? Number : pg.types.getTypeParser(oid, format)),
  },
})
void customParserExecutor
