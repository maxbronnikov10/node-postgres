import pg, {
  QueryExecutor,
  QueryExecutorError,
  type IndependentQueryConfig,
  type QueryExecutorOptions,
  type QueryResult,
} from 'pg'

interface User {
  id: number
  name: string
}

type UserTuple = [id: number, name: string]

export async function esmExample() {
  const options: QueryExecutorOptions = { max: 2, maxPending: 16, targetSessionAttrs: 'read-write' }
  const executor: InstanceType<typeof pg.QueryExecutor> = new QueryExecutor(options)
  const values = [7, 'Ada'] as const
  const config: IndependentQueryConfig = {
    text: 'SELECT $1::int AS id, $2::text AS name',
    values,
  }

  const result: QueryResult<User> = await executor.query<User>(config)
  const rows: User[] = await executor.rows<User>(config)
  const user: User = await executor.one<User>('SELECT $1::int AS id, $2::text AS name', values)
  const optionalUser: User | null = await executor.maybeOne<User>('SELECT $1::int AS id, $2::text AS name', values)
  const tupleRows: UserTuple[] = await executor.rows<UserTuple>({ ...config, rowMode: 'array' })
  const tuple: UserTuple = await executor.one<UserTuple>({ ...config, rowMode: 'array' })
  const optionalTuple: UserTuple | null = await executor.maybeOne<UserTuple>({ ...config, rowMode: 'array' })

  // @ts-expect-error Typed rows do not have undeclared properties.
  user.missing
  // @ts-expect-error QueryExecutor accepts promises rather than callbacks.
  executor.one('SELECT 1', () => {})
  // @ts-expect-error QueryExecutor.query also refuses the callback form.
  executor.query('SELECT 1', () => {})
  // @ts-expect-error Endpoint ports must be numeric.
  const invalidOptions: QueryExecutorOptions = { endpoints: [{ host: 'localhost', port: '5432' }] }
  void invalidOptions

  await executor.end()
  return { result, rows, user, optionalUser, tupleRows, tuple, optionalTuple }
}

export function esmError(error: unknown) {
  if (!(error instanceof QueryExecutorError)) return null

  const code: string | undefined = error.code
  const outcome: 'not-sent' | 'unknown' | 'server-error' = error.outcome
  const safeToRetry: boolean = error.safeToRetry
  return { code, outcome, safeToRetry }
}

pg.types.setTypeParser(999999, (value) => value.toUpperCase())
const binaryParser = pg.types.getTypeParser<Buffer>(999999, 'binary')
const binaryValue: Buffer = binaryParser(Buffer.alloc(0))
void binaryValue

const customParserExecutor = new QueryExecutor({
  types: {
    getTypeParser: (oid, format) => (oid === 23 && format !== 'binary' ? Number : pg.types.getTypeParser(oid, format)),
  },
})
void customParserExecutor
