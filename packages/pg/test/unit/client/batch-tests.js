'use strict'

const assert = require('assert')
const Batch = require('../../../lib/batch')
const Connection = require('../../../lib/connection')
const Query = require('../../../lib/query')
const helper = require('./test-helper')

const suite = new helper.Suite()
const test = suite.test.bind(suite)

function createBatch(configs) {
  const stream = new helper.MemoryStream()
  stream.acceptWrites = true
  stream.write = (packet) => {
    stream.packets.push(Buffer.from(packet))
    return stream.acceptWrites
  }
  const connection = new Connection({ stream })
  const queries = configs.map((config) => new Query(config))
  const results = Promise.allSettled(
    queries.map(
      (query) =>
        new Promise((resolve, reject) => {
          query.callback = (err, result) => (err ? reject(err) : resolve(result))
        })
    )
  )
  return { batch: Batch.fromQueries(queries), connection, stream, results }
}

function failingValue(error) {
  return {
    toPostgres() {
      throw error
    },
  }
}

function assertSingleSync(stream) {
  const sync = Buffer.from([83, 0, 0, 0, 4])
  assert.equal(stream.packets.filter((packet) => packet.equals(sync)).length, 1)
}

const encodingErrors = [
  { why: 'frozen', error: Object.freeze(new Error('cannot encode parameter')) },
  {
    why: 'read-only batchIndex',
    error: Object.defineProperty(new Error('cannot encode parameter'), 'batchIndex', { value: undefined }),
  },
]
for (const { why, error } of encodingErrors) {
  test(`an encoding error with ${why} metadata rejects its own query with the original error`, async function () {
    const { batch, connection, stream, results } = createBatch([
      { text: 'select $1', values: [failingValue(error)] },
      'select 2',
    ])

    batch.submit(connection)
    batch.handleReadyForQuery(connection)

    const outcomes = await results
    assert.strictEqual(outcomes[0].reason, error)
    assert.equal(outcomes[1].reason.code, 'PG_BATCH_ABORTED')
    assert.strictEqual(outcomes[1].reason.cause, error)
    assertSingleSync(stream)
  })
}

test('a batched converter throwing null rejects its query and skips later queries', async function () {
  const { batch, connection, stream, results } = createBatch([
    { text: 'select $1', values: [failingValue(null)] },
    'select 2',
  ])

  batch.submit(connection)
  batch.handleReadyForQuery(connection)

  const outcomes = await results
  assert.ok(outcomes[0].reason instanceof Error)
  assert.strictEqual(outcomes[0].reason.cause, null)
  assert.equal(outcomes[1].reason.code, 'PG_BATCH_ABORTED')
  assert.strictEqual(outcomes[1].reason.cause, outcomes[0].reason)
  assertSingleSync(stream)
})

test('a reused encoding error follows the failing query when its position changes', async function () {
  const error = new Error('cannot encode parameter')
  const first = createBatch(['select 1', { text: 'select $1', values: [failingValue(error)] }])

  first.batch.submit(first.connection)
  first.batch.handleReadyForQuery(first.connection)

  const firstOutcomes = await first.results
  assert.equal(firstOutcomes[0].reason.code, 'PG_BATCH_ABORTED')
  assert.strictEqual(firstOutcomes[1].reason, error)
  assertSingleSync(first.stream)

  const second = createBatch([{ text: 'select $1', values: [failingValue(error)] }, 'select 2'])

  second.batch.submit(second.connection)
  second.batch.handleReadyForQuery(second.connection)

  const secondOutcomes = await second.results
  assert.strictEqual(secondOutcomes[0].reason, error)
  assert.equal(secondOutcomes[1].reason.code, 'PG_BATCH_ABORTED')
  assertSingleSync(second.stream)
})

test('named statement validation rejects the conflicting query at its actual position', async function () {
  const { batch, connection, results } = createBatch(['select 1', { name: 'target', text: 'select 2' }, 'select 3'])
  connection.parsedStatements.target = 'select previous'

  const error = batch.submit(connection)
  batch.handleError(error, connection)

  const outcomes = await results
  assert.equal(outcomes[0].reason.code, 'PG_BATCH_ABORTED')
  assert.strictEqual(outcomes[1].reason, error)
  assert.equal(error.message, "Prepared statements must be unique - 'target' was used for a different statement")
  assert.equal(outcomes[2].reason.code, 'PG_BATCH_ABORTED')
})

test('server and encoding failures retain both errors and completed results across backpressure', async function () {
  const encodingError = Object.freeze(new Error('cannot encode parameter'))
  const serverError = new Error('server rejected query')
  const { batch, connection, stream, results } = createBatch([
    { text: 'select $1', values: ['x'.repeat(65536)] },
    { text: 'select $1', values: ['y'.repeat(65536)] },
    'select 3',
    { text: 'select $1', values: [failingValue(encodingError)] },
    'select 5',
  ])
  stream.acceptWrites = false

  batch.submit(connection)
  assert.equal(stream.packets.length, 1)
  batch.handleCommandComplete({ text: 'SELECT 1' }, connection)
  stream.emit('drain')
  assert.equal(stream.packets.length, 2)
  stream.emit('drain')
  batch.handleError(serverError, connection)

  const outcomes = await results
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[0].value.rowCount, 1)
  assert.strictEqual(outcomes[1].reason, serverError)
  assert.equal(outcomes[2].reason.code, 'PG_BATCH_ABORTED')
  assert.strictEqual(outcomes[3].reason, encodingError)
  assert.equal(outcomes[4].reason.code, 'PG_BATCH_ABORTED')
  assert.equal(stream.listenerCount('drain'), 0)
  assertSingleSync(stream)
})

test('batch named statement validation resolves names lazily and preserves precedence', function () {
  const parsed = Object.create(null)
  parsed.target = 'select parsed'
  const submitted = Object.create(null)
  submitted.target = 'select submitted'
  const noEnumeration = {
    ownKeys() {
      throw new Error('named statement registries must not be copied')
    },
  }
  const connection = {
    parsedStatements: new Proxy(parsed, noEnumeration),
    submittedNamedStatements: new Proxy(submitted, noEnumeration),
  }

  const externalConflict = new Batch([{ name: 'target', text: 'select parsed' }])
  const error = externalConflict.submit(connection)
  assert.equal(error.message, "Prepared statements must be unique - 'target' was used for a different statement")
  assert.equal(parsed.target, 'select parsed')
  assert.equal(submitted.target, 'select submitted')

  const withinBatchConflict = new Batch([
    { name: '__proto__', text: 'select 1' },
    { name: '__proto__', text: 'select 2' },
  ])
  const batchError = withinBatchConflict.submit({ parsedStatements: {}, submittedNamedStatements: {} })
  assert.equal(
    batchError.message,
    "Prepared statements must be unique - '__proto__' was used for a different statement"
  )

  const namedOnly = new Batch([{ name: 'target' }])
  namedOnly._write = () => {}
  assert.equal(
    namedOnly.submit({
      parsedStatements: connection.parsedStatements,
      submittedNamedStatements: connection.submittedNamedStatements,
      once() {},
    }),
    null
  )
})
