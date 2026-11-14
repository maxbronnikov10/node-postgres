'use strict'

const assert = require('assert/strict')
const fs = require('fs')
const net = require('net')
const path = require('path')
const { setImmediate } = require('timers/promises')
const { createTlsConfig } = require('./tls')

class TlsRecords {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.records = 0
    this.bytes = 0
  }

  accept(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 5) {
      assert.ok([20, 21, 22, 23].includes(this.buffer[0]), 'expected a TLS record')
      assert.equal(this.buffer[1], 3)
      const length = this.buffer.readUInt16BE(3)
      assert.ok(length <= 18432, 'TLS record exceeds the ciphertext limit')
      if (this.buffer.length < length + 5) return
      if (this.buffer[0] === 23) {
        this.records++
        this.bytes += length + 5
      }
      this.buffer = this.buffer.subarray(length + 5)
    }
  }

  reset() {
    assert.equal(this.buffer.length, 0, 'a complete request must end on a TLS record boundary')
    this.records = 0
    this.bytes = 0
  }
}

async function probeRecords({ pg, tls, port }) {
  const counter = new TlsRecords()
  const sockets = new Set()
  const proxy = net.createServer((frontend) => {
    const backend = net.connect({ host: process.env.PGHOST || '127.0.0.1', port })
    sockets.add(frontend).add(backend)
    frontend.on('data', (chunk) => counter.accept(chunk))
    frontend.on('error', () => backend.destroy())
    backend.on('error', () => frontend.destroy())
    frontend.on('close', () => sockets.delete(frontend))
    backend.on('close', () => sockets.delete(backend))
    frontend.pipe(backend)
    backend.pipe(frontend)
  })
  proxy.maxConnections = 1
  await new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const client = new pg.Client({
    host: '127.0.0.1',
    port: proxy.address().port,
    connectionTimeoutMillis: 5000,
    pipeline: true,
    maxAutoPrepare: 16,
    ...tls.options({ context: 'shared', negotiation: 'direct' }),
  })
  try {
    await client.connect()
    tls.assertConnection({ client, negotiation: 'direct' })
    await client.query('SELECT $1::int AS n', [-1])
    await setImmediate()
    counter.reset()

    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((value) =>
        client.query('SELECT $1::int AS n', [value])
      )
    )
    assert.deepEqual(
      results.map((result) => result.rows[0].n),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    )
    assert.equal(counter.buffer.length, 0)
    assert.ok(counter.records > 0)
    return { applicationRecords: counter.records, encryptedBytes: counter.bytes }
  } finally {
    await client.end()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => proxy.close(resolve))
  }
}

async function checkEndpoint({ pg, tls }) {
  const client = new pg.Client({
    pipeline: true,
    maxAutoPrepare: 16,
    ...tls.options({ context: 'shared', negotiation: 'direct' }),
  })
  try {
    await client.connect()
    tls.assertConnection({ client, negotiation: 'direct' })
    const results = await Promise.allSettled([
      client.query('SELECT $1::int AS n', [1]),
      client.query('SELECT 1 / 0'),
      client.query('SELECT $1::int AS n', [3]),
    ])
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected', 'fulfilled']
    )
    assert.deepEqual(results[0].value.rows, [{ n: 1 }])
    assert.equal(results[1].reason.code, '22012')
    assert.deepEqual(results[2].value.rows, [{ n: 3 }])
    assert.equal(client.getTransactionStatus(), 'I')
    const payload = Buffer.alloc(1048576, 0xa5)
    const echoed = await client.query('SELECT $1::bytea AS value', [payload])
    assert.equal(echoed.rowCount, 1)
    assert.deepEqual(echoed.rows[0].value, payload)
  } finally {
    await client.end()
  }

  const badCa = fs.readFileSync(path.join(path.dirname(process.env.PG_BENCH_TLS_CA), 'untrusted.crt'))
  for (const { ssl, code } of [
    { ssl: { ...tls.ssl, ca: badCa }, code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    { ssl: { ...tls.ssl, servername: 'wrong.invalid' }, code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  ]) {
    const rejected = new pg.Client({ ssl, sslnegotiation: 'direct', connectionTimeoutMillis: 5000 })
    try {
      await assert.rejects(rejected.connect(), (error) => error.code === code)
    } finally {
      await rejected.end()
    }
  }
}

async function checkPooler({ pg, tls }) {
  const options = tls.options({ context: 'shared', negotiation: 'direct' })
  const admin = new pg.Client({ ...options, database: 'pgbouncer' })
  const client = new pg.Client({ ...options, maxAutoPrepare: 16 })
  const executor =
    typeof pg.QueryExecutor === 'function'
      ? new pg.QueryExecutor({ ...options, max: 1, maxInFlightPerConnection: 4, maxAutoPrepare: 16 })
      : undefined
  assert.ok(
    ['nodepg_tls', 'nodepg_survey'].includes(client.database),
    'the reconnect check is restricted to the disposable nodepg_tls/nodepg_survey fixture'
  )
  try {
    await admin.connect()
    await client.connect()
    const config = Object.fromEntries((await admin.query('SHOW CONFIG')).rows.map((row) => [row.key, row.value]))
    assert.equal(config.pool_mode, 'transaction')
    assert.ok(Number(config.max_prepared_statements) > 0)
    assert.equal(config.server_tls_sslmode, 'verify-full')
    const sql = 'SELECT $1::int AS n, pg_backend_pid() AS pid'
    const before = await client.query(sql, [41])
    assert.equal(before.rows[0].n, 41)
    const executorBefore = await executor?.query({ text: sql, name: 'executor_tls_named', values: [41] })

    await admin.query(`RECONNECT ${pg.escapeIdentifier(client.database)}`)
    const after = await client.query(sql, [42])

    assert.equal(after.rows[0].n, 42)
    assert.notEqual(after.rows[0].pid, before.rows[0].pid)
    if (executor) {
      const executorAfter = await executor.query({ text: sql, name: 'executor_tls_named', values: [42] })
      assert.equal(executorAfter.rows[0].n, 42)
      assert.notEqual(executorAfter.rows[0].pid, executorBefore.rows[0].pid)
      for (const { client: frontend } of executor._records)
        tls.assertConnection({ client: frontend, negotiation: 'direct' })
    }
    const servers = (await admin.query('SHOW SERVERS')).rows.filter((row) => row.database === client.database)
    assert.ok(servers.length > 0)
    assert.ok(servers.every((row) => row.tls.startsWith('TLSv1.3/')))
    const stats = (await admin.query('SHOW STATS')).rows.find((row) => row.database === client.database)
    assert.ok(Number(stats.total_server_parse_count) > 0)
  } finally {
    await Promise.all([admin.end(), client.end(), executor?.end()])
  }
}

async function checkExecutor({ pg, tls }) {
  if (typeof pg.QueryExecutor !== 'function') return
  const executor = new pg.QueryExecutor({
    ...tls.options({ context: 'shared', negotiation: 'direct' }),
    max: 2,
    maxInFlightPerConnection: 4,
    maxAutoPrepare: 16,
  })
  try {
    const results = await Promise.allSettled([
      executor.query('SELECT $1::int AS n', [17]),
      executor.query('SELECT 1 / 0'),
      executor.query('SELECT $1::int AS n', [23]),
    ])
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected', 'fulfilled']
    )
    assert.deepEqual(results[0].value.rows, [{ n: 17 }])
    assert.equal(results[1].reason.code, '22012')
    assert.equal(results[1].reason.outcome, 'server-error')
    assert.equal(results[1].reason.safeToRetry, false)
    assert.deepEqual(results[2].value.rows, [{ n: 23 }])
    assert.equal(executor.waitingCount, 0)
    assert.equal(executor.inFlightCount, 0)
    for (const { client } of executor._records) tls.assertConnection({ client, negotiation: 'direct' })
  } finally {
    await executor.end()
  }
  const rejected = new pg.QueryExecutor({
    ssl: { ...tls.ssl, servername: 'wrong.invalid' },
    sslnegotiation: 'direct',
    connectionTimeoutMillis: 5000,
  })
  try {
    await assert.rejects(rejected.query('SELECT 1'), (error) => {
      assert.equal(error.outcome, 'not-sent')
      assert.equal(error.safeToRetry, true)
      assert.equal(error.cause.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
      return true
    })
  } finally {
    await rejected.end()
  }
}

;(async () => {
  const framing = new TlsRecords()
  framing.accept(Buffer.from([23, 3, 3, 0]))
  framing.accept(Buffer.from([2, 1, 2, 23, 3, 3, 0, 1, 3]))
  assert.equal(framing.records, 2)
  assert.equal(framing.bytes, 13)
  framing.reset()

  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const pg = require(path.join(root, 'packages/pg'))
  const tls = createTlsConfig()
  await checkEndpoint({ pg, tls })
  await checkExecutor({ pg, tls })
  if (process.env.PG_BENCH_ENDPOINT === 'pgbouncer-transaction') await checkPooler({ pg, tls })
  const records = await probeRecords({ pg, tls, port: Number(process.env.PGPORT) })
  process.stdout.write(JSON.stringify({ root, endpoint: process.env.PG_BENCH_ENDPOINT, ...records }) + '\n')
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
