'use strict'

const assert = require('assert/strict')
const path = require('path')
const crypto = require('crypto')
const fs = require('fs')
const { createTlsConfig } = require('./tls')
const { DelayedProxy } = require('./delayed-proxy')

const BURST = 16
const ROWS = 500

const createPostgresJsWorkload = async ({ pg, arm }) => {
  assert.ok(Number.isInteger(arm) && arm >= 0 && arm < 4)
  const competitor = arm % 2 === 0
  let sql
  let close
  let pool
  let proxy
  const options = {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    username: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 4,
    max_pipeline: BURST,
    prepare: true,
    application_name: `pg-bench-postgresjs-${arm}`,
  }
  const tls = process.env.PG_BENCH_TLS_CA ? createTlsConfig() : null
  if (tls) options.ssl = tls.ssl
  if (process.env.PG_BENCH_DELAY_MS !== undefined) {
    proxy = await new DelayedProxy({
      host: options.host,
      port: options.port,
      delayMillis: Number(process.env.PG_BENCH_DELAY_MS),
    }).start()
    options.host = '127.0.0.1'
    options.port = proxy.port
  }

  if (competitor) {
    const modulePath = process.env.PG_BENCH_POSTGRESJS_MODULE
    assert.ok(modulePath, 'PG_BENCH_POSTGRESJS_MODULE is required for base actors')
    const entry = require.resolve(modulePath)
    const loaded = await import(pathToFileUrl(entry))
    const postgres = loaded.default
    const packageJson = require(path.join(path.dirname(path.dirname(entry)), 'package.json'))
    sql = postgres({ ...options, connection: { application_name: options.application_name } })
    close = () => sql.end({ timeout: 1 })
    pool = sql
    sql.benchmarkMetadata = {
      package: packageJson.name,
      version: packageJson.version,
      entrySha256: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
      gitCommit: packageJson.gitHead || null,
    }
  } else {
    assert.equal(typeof pg.postgres, 'function', 'head checkout must expose pg.postgres')
    pool = pg.postgres(options)
    sql = pool
    close = () => pool.end()
  }

  const select = (id) => sql`SELECT id, value FROM benchmark_sql_rows WHERE id = ${id}`
  const selectRows = (array) => {
    const query = sql`SELECT id, value FROM benchmark_sql_rows WHERE id <= ${ROWS} ORDER BY id LIMIT ${ROWS}`
    return array ? query.values() : query
  }
  const point = async (id, array = false) => {
    const query = select(id)
    const rows = array ? await query.values() : await query
    assert.equal(rows.length, 1)
    if (array) assert.equal(rows[0].length, 2)
    assert.equal(array ? rows[0][0] : rows[0].id, id)
    assert.equal(array ? rows[0][1] : rows[0].value, 7)
    return 1
  }
  const bulk = async (array = false) => {
    const rows = await selectRows(array)
    assert.equal(rows.length, ROWS)
    for (let i = 0; i < rows.length; i++) {
      if (array) assert.equal(rows[i].length, 2)
      assert.equal(array ? rows[i][0] : rows[i].id, i + 1)
      assert.equal(array ? rows[i][1] : rows[i].value, 7)
    }
    return 1
  }
  const mixedPayload = 'x'.repeat(64)
  const mixed = async () => {
    const rows =
      await sql`SELECT id, 'row-☃-' || id::text AS label, id % 2 = 0 AS active, jsonb_build_object('id', id, 'payload', repeat('x', 64)) AS metadata, 9007199254740993::int8 AS wide FROM benchmark_sql_rows WHERE id <= ${ROWS} ORDER BY id`
    assert.equal(rows.length, ROWS)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      assert.equal(row.id, i + 1)
      assert.equal(row.label, 'row-☃-' + (i + 1))
      assert.equal(row.active, (i + 1) % 2 === 0)
      assert.equal(row.metadata.id, i + 1)
      assert.equal(row.metadata.payload, mixedPayload)
      assert.equal(row.wide, '9007199254740993')
    }
    return 1
  }
  const batch = (fn) => async () => {
    const results = await Promise.all(Array.from({ length: BURST }, (_, lane) => fn(lane)))
    assert.equal(results.length, BURST)
    return BURST
  }
  const payload = Buffer.alloc(1048576, 0x61)
  const upload = async () => {
    const rows =
      await sql`SELECT octet_length(payload) AS bytes, payload = repeat('a', 1048576)::bytea AS matches FROM (SELECT ${payload}::bytea AS payload) AS input`
    assert.equal(rows.length, 1)
    assert.equal(rows[0].bytes, 1048576)
    assert.equal(rows[0].matches, true)
    return 1
  }
  const scenarios = {
    'tagged point SELECT, sequential': () => point(1),
    'tagged point SELECT, concurrent x16': batch((lane) => point(lane + 1)),
    'tagged 500-row object SELECT, concurrent x16': batch(() => bulk(false)),
    'tagged 500-row array SELECT, concurrent x16': batch(() => bulk(true)),
    'tagged 500-row mixed SELECT, concurrent x16': batch(mixed),
    'tagged 1-MiB bytea input, concurrent x2': async () => {
      await Promise.all([upload(), upload()])
      return 2
    },
    'tagged logged UPDATE, concurrent x16': batch(async (lane) => {
      const id = arm * 32 + lane + 1
      const rows = await sql`UPDATE benchmark_sql_rows SET value = 7 WHERE id = ${id} RETURNING id, value`
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, id)
      assert.equal(rows[0].value, 7)
      return 1
    }),
  }

  let warmed = []
  const warm = async () => {
    for (let batchIndex = 0; batchIndex < 5; batchIndex++) {
      const results = await Promise.all(
        Array.from(
          { length: 65 },
          () =>
            sql`SELECT pg_backend_pid() AS pid, pg_sleep(0.005) AS slept, current_setting('application_name') AS app, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS encrypted, (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_version`
        )
      )
      const distinct = new Set(results.map((rows) => rows[0].pid))
      if (distinct.size === 4) {
        warmed = [...new Map(results.map((rows) => [rows[0].pid, rows[0]])).values()]
        for (const row of warmed) {
          assert.equal(row.app, options.application_name)
          assert.equal(row.encrypted, Boolean(tls))
          if (tls) assert.equal(row.tls_version, 'TLSv1.3')
        }
        return
      }
    }
    throw new Error('could not prewarm four distinct PostgreSQL backends')
  }

  const setupClient = new pg.Client()
  const setup = async () => {
    try {
      await setupClient.connect()
      await setupClient.query('DROP TABLE IF EXISTS benchmark_sql_rows')
      await setupClient.query('CREATE TABLE benchmark_sql_rows (id int PRIMARY KEY, value int NOT NULL)')
      await setupClient.query('INSERT INTO benchmark_sql_rows SELECT i, 7 FROM generate_series(1, 1024) AS i')
      await setupClient.query('ANALYZE benchmark_sql_rows')
      await setupClient.query('CHECKPOINT')
      for (const setting of ['fsync', 'full_page_writes', 'synchronous_commit']) {
        const result = await setupClient.query(`SHOW ${setting}`)
        assert.equal(result.rows[0][setting], 'on', `${setting} must stay on`)
      }
    } finally {
      await setupClient.end()
    }
  }
  const prepare = async () => {
    await Promise.all([point(1), bulk(), ...Array.from({ length: BURST }, (_, lane) => point(lane + 1))])
    await mixed()
    await upload()
    await scenarios['tagged logged UPDATE, concurrent x16']()
  }
  try {
    await warm()
    return {
      all: scenarios,
      clients: [],
      pools: [
        {
          end: async () => {
            await close()
            await proxy?.end()
          },
        },
      ],
      setup,
      prepare,
      metadata: {
        competitor: sql.benchmarkMetadata || null,
        warmedConnections: warmed,
        ssl: Boolean(tls),
        delayMillis: Number(process.env.PG_BENCH_DELAY_MS || 0),
      },
    }
  } catch (error) {
    await close().catch(() => {})
    await proxy?.end()
    throw error
  }
}

const pathToFileUrl = (file) => require('url').pathToFileURL(file).href

module.exports = { createPostgresJsWorkload }
